use crate::procfs::{
    boot_id, clock_ticks, enrich_process, passwd_map, scan_processes, uptime_seconds, BasicProcess,
};
use crate::types::{GraphEdge, GraphSnapshot, LifecycleEvent, ProcessNode, TrackingMessage};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::ipc::Channel;
use tokio::time::{self, Duration, MissedTickBehavior};
use uuid::Uuid;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Default)]
pub struct TrackerState {
    sessions: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

struct KnownProcess {
    node: ProcessNode,
    last_cpu_ticks: u64,
    sampled_at: Instant,
}

impl TrackerState {
    pub fn begin(&self, pid: i32, output: Channel<TrackingMessage>) -> Result<String, String> {
        let initial_scan = scan_processes();
        let root = initial_scan
            .get(&pid)
            .cloned()
            .ok_or_else(|| format!("PID {pid} is not currently visible"))?;
        let boot = boot_id();
        let root_key = root.key(&boot).id;
        let session_id = Uuid::new_v4().to_string();
        let cancellation = Arc::new(AtomicBool::new(false));

        self.sessions
            .lock()
            .map_err(|_| "tracker state is unavailable".to_string())?
            .insert(session_id.clone(), cancellation.clone());

        let state = self.clone();
        let task_session = session_id.clone();
        tauri::async_runtime::spawn(async move {
            run_session(
                task_session.clone(),
                root,
                root_key,
                boot,
                initial_scan,
                cancellation,
                output,
            )
            .await;
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&task_session);
            }
        });

        Ok(session_id)
    }

    pub fn stop(&self, session_id: &str) -> bool {
        let cancellation = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if let Some(cancellation) = cancellation {
            cancellation.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

async fn run_session(
    session_id: String,
    root: BasicProcess,
    root_key: String,
    boot: String,
    initial_scan: HashMap<i32, BasicProcess>,
    cancellation: Arc<AtomicBool>,
    output: Channel<TrackingMessage>,
) {
    let users = passwd_map();
    let ticks_per_second = clock_ticks();
    let mut known = HashMap::<String, KnownProcess>::new();
    let mut edges = HashMap::<String, GraphEdge>::new();
    let mut sequence = 0u64;

    let initial_ids = initial_family(&root, &initial_scan, &boot);
    for (process, is_ancestor) in initial_ids {
        let key = process.key(&boot).id;
        let parent_key = initial_scan
            .get(&process.ppid)
            .map(|parent| parent.key(&boot).id)
            .filter(|candidate| candidate == &root_key || known.contains_key(candidate));
        let node = make_node(
            &process,
            parent_key.clone(),
            key == root_key,
            is_ancestor,
            &users,
        );
        if let Some(parent) = parent_key {
            insert_edge(&mut edges, &parent, &key, "observed-parent");
        }
        known.insert(
            key,
            KnownProcess {
                node,
                last_cpu_ticks: process.total_cpu_ticks(),
                sampled_at: Instant::now(),
            },
        );
    }

    let _ = output.send(TrackingMessage::Event(event_for(
        "attached",
        "info",
        &root_key,
        root.pid,
        &root.comm,
        format!("Attached to {} ({})", root.comm, root.pid),
    )));

    let mut interval = time::interval(SAMPLE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        if cancellation.load(Ordering::Relaxed) {
            let _ = output.send(TrackingMessage::Event(event_for(
                "detached",
                "info",
                &root_key,
                root.pid,
                &root.comm,
                "Observation stopped".into(),
            )));
            break;
        }

        let scan = scan_processes();
        let now = Instant::now();
        let current_by_pid = known
            .iter()
            .filter(|(_, entry)| entry.node.alive)
            .map(|(key, entry)| (entry.node.key.pid, key.clone()))
            .collect::<HashMap<_, _>>();

        let mut additions = Vec::new();
        for process in scan.values() {
            let key = process.key(&boot).id;
            if known.contains_key(&key) {
                continue;
            }
            if let Some(parent_key) = current_by_pid.get(&process.ppid) {
                additions.push((process.clone(), parent_key.clone()));
            }
        }

        // Repeat because a parent and grandchild can both appear between samples.
        let mut pending = additions;
        while !pending.is_empty() {
            let batch = std::mem::take(&mut pending);
            for (process, parent_key) in batch {
                let key = process.key(&boot).id;
                if known.contains_key(&key) {
                    continue;
                }
                let node = make_node(&process, Some(parent_key.clone()), false, false, &users);
                insert_edge(&mut edges, &parent_key, &key, "spawned");
                let _ = output.send(TrackingMessage::Event(event_for(
                    "spawn",
                    "change",
                    &key,
                    process.pid,
                    &process.comm,
                    format!("{} spawned PID {}", process.comm, process.pid),
                )));
                known.insert(
                    key.clone(),
                    KnownProcess {
                        node,
                        last_cpu_ticks: process.total_cpu_ticks(),
                        sampled_at: now,
                    },
                );

                for candidate in scan.values() {
                    let candidate_key = candidate.key(&boot).id;
                    if candidate.ppid == process.pid && !known.contains_key(&candidate_key) {
                        pending.push((candidate.clone(), key.clone()));
                    }
                }
            }
        }

        let known_keys = known.keys().cloned().collect::<Vec<_>>();
        for key in known_keys {
            let Some(entry) = known.get_mut(&key) else {
                continue;
            };
            let current = scan
                .get(&entry.node.key.pid)
                .filter(|process| process.start_time_ticks == entry.node.key.start_time_ticks);

            let Some(process) = current else {
                if entry.node.alive {
                    entry.node.alive = false;
                    entry.node.state = "exited".into();
                    entry.node.cpu_percent = 0.0;
                    entry.node.exited_at = Some(Utc::now().to_rfc3339());
                    let _ = output.send(TrackingMessage::Event(event_for(
                        "exit",
                        if key == root_key { "warning" } else { "change" },
                        &key,
                        entry.node.key.pid,
                        &entry.node.comm,
                        format!("{} (PID {}) exited", entry.node.comm, entry.node.key.pid),
                    )));
                }
                continue;
            };

            let enrichment = enrich_process(process, &users);
            let elapsed = now
                .duration_since(entry.sampled_at)
                .as_secs_f64()
                .max(0.001);
            let tick_delta = process
                .total_cpu_ticks()
                .saturating_sub(entry.last_cpu_ticks);
            let cpu_percent = tick_delta as f64 / ticks_per_second / elapsed * 100.0;

            let executable_changed = matches!(
                (&entry.node.executable, &enrichment.executable),
                (Some(before), Some(after)) if before != after
            );
            if entry.node.comm != process.comm || executable_changed {
                let before = entry.node.comm.clone();
                let _ = output.send(TrackingMessage::Event(event_for(
                    "exec",
                    "change",
                    &key,
                    process.pid,
                    &process.comm,
                    format!(
                        "PID {} changed image: {} → {}",
                        process.pid, before, process.comm
                    ),
                )));
            }

            entry.node.ppid = process.ppid;
            entry.node.comm = process.comm.clone();
            entry.node.command = enrichment.command;
            entry.node.executable = enrichment.executable;
            entry.node.uid = enrichment.uid;
            entry.node.user = enrichment.user;
            entry.node.state = process.state.clone();
            entry.node.alive = true;
            entry.node.age_seconds =
                (uptime_seconds() - process.start_time_ticks as f64 / ticks_per_second).max(0.0);
            entry.node.cpu_percent = cpu_percent;
            entry.node.rss_bytes = enrichment.rss_bytes;
            entry.node.virtual_bytes = process.virtual_bytes;
            entry.node.read_bytes = enrichment.read_bytes;
            entry.node.write_bytes = enrichment.write_bytes;
            entry.node.threads = process.threads;
            entry.node.fd_count = enrichment.fd_count;
            entry.last_cpu_ticks = process.total_cpu_ticks();
            entry.sampled_at = now;
        }

        for edge in edges.values_mut() {
            edge.current = known.get(&edge.source).is_some_and(|node| node.node.alive)
                && known.get(&edge.target).is_some_and(|node| node.node.alive);
        }

        sequence = sequence.saturating_add(1);
        let mut nodes = known
            .values()
            .map(|entry| entry.node.clone())
            .collect::<Vec<_>>();
        nodes.sort_by(|a, b| {
            b.is_ancestor
                .cmp(&a.is_ancestor)
                .then_with(|| b.is_focus.cmp(&a.is_focus))
                .then_with(|| a.key.pid.cmp(&b.key.pid))
        });
        let mut graph_edges = edges.values().cloned().collect::<Vec<_>>();
        graph_edges.sort_by(|a, b| a.id.cmp(&b.id));
        let root_alive = known.get(&root_key).is_some_and(|entry| entry.node.alive);
        let alive_count = nodes.iter().filter(|node| node.alive).count();
        let exited_count = nodes.len().saturating_sub(alive_count);
        let snapshot = GraphSnapshot {
            session_id: session_id.clone(),
            sequence,
            timestamp: Utc::now().to_rfc3339(),
            root_key: root_key.clone(),
            root_alive,
            alive_count,
            exited_count,
            nodes,
            edges: graph_edges,
            missed_event_warning: true,
        };
        if output.send(TrackingMessage::Snapshot(snapshot)).is_err() {
            break;
        }
    }
}

fn initial_family(
    root: &BasicProcess,
    scan: &HashMap<i32, BasicProcess>,
    boot: &str,
) -> Vec<(BasicProcess, bool)> {
    let mut ancestors = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = root.ppid;
    while cursor > 0 && seen.insert(cursor) {
        let Some(parent) = scan.get(&cursor) else {
            break;
        };
        ancestors.push(parent.clone());
        cursor = parent.ppid;
    }
    ancestors.reverse();

    let mut output = ancestors
        .into_iter()
        .map(|process| (process, true))
        .collect::<Vec<_>>();
    output.push((root.clone(), false));

    let mut family_ids = HashSet::from([root.key(boot).id]);
    loop {
        let mut changed = false;
        for process in scan.values() {
            let key = process.key(boot).id;
            if family_ids.contains(&key) {
                continue;
            }
            let parent_is_family = scan
                .get(&process.ppid)
                .map(|parent| family_ids.contains(&parent.key(boot).id))
                .unwrap_or(false);
            if parent_is_family {
                family_ids.insert(key);
                output.push((process.clone(), false));
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    output
}

fn make_node(
    process: &BasicProcess,
    parent_key: Option<String>,
    is_focus: bool,
    is_ancestor: bool,
    users: &HashMap<u32, String>,
) -> ProcessNode {
    let enrichment = enrich_process(process, users);
    let ticks = clock_ticks();
    ProcessNode {
        key: process.key(&boot_id()),
        ppid: process.ppid,
        parent_key,
        comm: process.comm.clone(),
        command: enrichment.command,
        executable: enrichment.executable,
        uid: enrichment.uid,
        user: enrichment.user,
        state: process.state.clone(),
        alive: true,
        is_focus,
        is_ancestor,
        discovered_at: Utc::now().to_rfc3339(),
        exited_at: None,
        age_seconds: (uptime_seconds() - process.start_time_ticks as f64 / ticks).max(0.0),
        cpu_percent: 0.0,
        rss_bytes: enrichment.rss_bytes,
        virtual_bytes: process.virtual_bytes,
        read_bytes: enrichment.read_bytes,
        write_bytes: enrichment.write_bytes,
        threads: process.threads,
        fd_count: enrichment.fd_count,
    }
}

fn insert_edge(edges: &mut HashMap<String, GraphEdge>, source: &str, target: &str, relation: &str) {
    let id = format!("{source}->{target}");
    edges.entry(id.clone()).or_insert_with(|| GraphEdge {
        id,
        source: source.into(),
        target: target.into(),
        relation: relation.into(),
        observed_at: Utc::now().to_rfc3339(),
        current: true,
    });
}

fn event_for(
    kind: &str,
    severity: &str,
    process_key: &str,
    pid: i32,
    comm: &str,
    message: String,
) -> LifecycleEvent {
    LifecycleEvent {
        id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        kind: kind.into(),
        severity: severity.into(),
        process_key: process_key.into(),
        pid,
        comm: comm.into(),
        message,
    }
}
