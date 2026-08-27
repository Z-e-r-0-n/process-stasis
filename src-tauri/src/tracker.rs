use crate::procfs::{
    boot_id, clock_ticks, enrich_process, passwd_map, scan_processes, uptime_seconds, BasicProcess,
};
use crate::types::{
    GraphEdge, GraphSnapshot, LifecycleEvent, ProcessNode, RecordedCapture, RecordingInfo,
    TrackingMessage,
};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::ipc::Channel;
use tokio::time::{self, Duration, MissedTickBehavior};
use uuid::Uuid;

const SAMPLE_INTERVAL: Duration = Duration::from_millis(500);
const RECORD_SNAPSHOT_EVERY: u64 = 4;
const RECORD_SYNC_INTERVAL: Duration = Duration::from_secs(10);
const MAX_RECORDING_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct TrackerState {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionControl>>>>,
    history: Arc<Mutex<HashMap<String, Arc<SessionControl>>>>,
    recording_root: PathBuf,
}

struct SessionControl {
    cancelled: AtomicBool,
    recording: Mutex<RecordingSlot>,
}

#[derive(Default)]
struct RecordingSlot {
    journal: Option<RecordingJournal>,
    info: Option<RecordingInfo>,
    path: Option<PathBuf>,
}

struct RecordingJournal {
    file: File,
    last_sync: Instant,
}

struct KnownProcess {
    node: ProcessNode,
    pidfd: Option<OwnedFd>,
    last_cpu_ticks: u64,
    sampled_at: Instant,
}

impl TrackerState {
    pub fn new(recording_root: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(HashMap::new())),
            recording_root,
        }
    }

    pub fn begin(
        &self,
        pid: i32,
        expected_start_time_ticks: Option<u64>,
        output: Channel<TrackingMessage>,
    ) -> Result<String, String> {
        let initial_scan = scan_processes();
        let root = initial_scan
            .get(&pid)
            .cloned()
            .ok_or_else(|| format!("PID {pid} is not currently visible"))?;
        validate_expected_identity(&root, expected_start_time_ticks)?;
        let boot = boot_id();
        let root_key = root.key(&boot).id;
        let session_id = Uuid::new_v4().to_string();
        let control = Arc::new(SessionControl {
            cancelled: AtomicBool::new(false),
            recording: Mutex::new(RecordingSlot::default()),
        });

        self.sessions
            .lock()
            .map_err(|_| "tracker state is unavailable".to_string())?
            .insert(session_id.clone(), control.clone());

        let state = self.clone();
        let task_session = session_id.clone();
        tauri::async_runtime::spawn(async move {
            run_session(
                task_session.clone(),
                root,
                root_key,
                boot,
                initial_scan,
                control.clone(),
                output,
            )
            .await;
            control.finish_recording();
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&task_session);
            }
        });

        Ok(session_id)
    }

    pub fn stop(&self, session_id: &str) -> bool {
        let control = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if let Some(control) = control {
            control.cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    pub fn start_recording(&self, session_id: &str) -> Result<RecordingInfo, String> {
        let control = self
            .sessions
            .lock()
            .map_err(|_| "tracker state is unavailable".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "tracking session is not active".to_string())?;
        self.history
            .lock()
            .map_err(|_| "tracker history is unavailable".to_string())?
            .insert(session_id.into(), control.clone());
        control.start_recording(session_id, &self.recording_root)
    }

    pub fn stop_recording(&self, session_id: &str) -> Result<RecordingInfo, String> {
        self.control_from_history(session_id)?.stop_recording()
    }

    pub fn read_recording(&self, session_id: &str) -> Result<RecordedCapture, String> {
        self.control_from_history(session_id)?.read_recording()
    }

    fn control_from_history(&self, session_id: &str) -> Result<Arc<SessionControl>, String> {
        self.history
            .lock()
            .map_err(|_| "tracker history is unavailable".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "recording session is unknown".to_string())
    }
}

impl SessionControl {
    fn start_recording(
        &self,
        session_id: &str,
        recording_root: &Path,
    ) -> Result<RecordingInfo, String> {
        match fs::symlink_metadata(recording_root) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("recording location is not a real directory".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(recording_root).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        fs::set_permissions(recording_root, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;

        let mut slot = self
            .recording
            .lock()
            .map_err(|_| "recording state is unavailable".to_string())?;
        if slot.journal.is_some() {
            return Err("recording is already active".into());
        }
        if let Some(error) = slot.info.as_ref().and_then(|info| info.error.as_ref()) {
            return Err(format!("the previous recording failed: {error}"));
        }

        let (path, started_at, mut info, resumed) = if let Some(info) = slot.info.clone() {
            (
                recording_root.join(&info.file_name),
                info.started_at.clone(),
                info,
                true,
            )
        } else {
            let file_name = format!("{session_id}.jsonl");
            let started_at = Utc::now().to_rfc3339();
            (
                recording_root.join(&file_name),
                started_at.clone(),
                RecordingInfo {
                    session_id: session_id.into(),
                    file_name,
                    started_at,
                    active: false,
                    snapshot_count: 0,
                    event_count: 0,
                    byte_count: 0,
                    error: None,
                },
                false,
            )
        };

        let mut file = OpenOptions::new()
            .write(true)
            .append(resumed)
            .create_new(!resumed)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|error| error.to_string())?;
        if resumed {
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        let marker = if resumed {
            serde_json::json!({
                "type": "recordingResumed",
                "payload": { "timestamp": Utc::now().to_rfc3339() }
            })
        } else {
            serde_json::json!({
                "type": "journalHeader",
                "payload": {
                    "schema": "process-stasis/session-journal-v1",
                    "sessionId": session_id,
                    "recordingStartedAt": started_at
                }
            })
        };
        let bytes = match append_json_line(&mut file, &marker) {
            Ok(bytes) => bytes,
            Err(error) => {
                if !resumed {
                    let _ = fs::remove_file(&path);
                }
                return Err(error);
            }
        };
        info.byte_count = info.byte_count.saturating_add(bytes);
        info.active = true;
        info.error = None;
        slot.journal = Some(RecordingJournal {
            file,
            last_sync: Instant::now(),
        });
        slot.path = Some(path);
        slot.info = Some(info.clone());
        Ok(info)
    }

    fn stop_recording(&self) -> Result<RecordingInfo, String> {
        let mut slot = self
            .recording
            .lock()
            .map_err(|_| "recording state is unavailable".to_string())?;
        let mut journal = match slot.journal.take() {
            Some(journal) => journal,
            None => {
                if let Some(error) = slot.info.as_ref().and_then(|info| info.error.as_ref()) {
                    return Err(format!("recording stopped after an error: {error}"));
                }
                return Err("recording is not active".into());
            }
        };
        let marker = serde_json::json!({
            "type": "recordingPaused",
            "payload": { "timestamp": Utc::now().to_rfc3339() }
        });
        let result = append_json_line(&mut journal.file, &marker).and_then(|bytes| {
            journal.file.sync_all().map_err(|error| error.to_string())?;
            Ok(bytes)
        });
        let marker_bytes = match result {
            Ok(bytes) => bytes,
            Err(error) => {
                if let Some(info) = slot.info.as_mut() {
                    info.active = false;
                    info.error = Some(error.clone());
                }
                return Err(error);
            }
        };
        let info = slot
            .info
            .as_mut()
            .ok_or_else(|| "recording metadata is unavailable".to_string())?;
        info.active = false;
        info.byte_count = info.byte_count.saturating_add(marker_bytes);
        Ok(info.clone())
    }

    fn finish_recording(&self) {
        let Ok(mut slot) = self.recording.lock() else {
            return;
        };
        let Some(mut journal) = slot.journal.take() else {
            return;
        };
        let marker = serde_json::json!({
            "type": "recordingEnded",
            "payload": { "timestamp": Utc::now().to_rfc3339() }
        });
        let result = append_json_line(&mut journal.file, &marker).and_then(|bytes| {
            journal.file.sync_all().map_err(|error| error.to_string())?;
            Ok(bytes)
        });
        if let Some(info) = slot.info.as_mut() {
            info.active = false;
            match result {
                Ok(bytes) => info.byte_count = info.byte_count.saturating_add(bytes),
                Err(error) => info.error = Some(error),
            }
        }
    }

    fn record(&self, message: &TrackingMessage) {
        if matches!(message, TrackingMessage::Snapshot(snapshot) if snapshot.sequence % RECORD_SNAPSHOT_EVERY != 0)
        {
            return;
        }
        let Ok(mut slot) = self.recording.lock() else {
            return;
        };
        let Some(mut journal) = slot.journal.take() else {
            return;
        };
        let bytes = match json_line(message) {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = journal.file.sync_all();
                if let Some(info) = slot.info.as_mut() {
                    info.active = false;
                    info.error = Some(error);
                }
                return;
            }
        };
        if slot.info.as_ref().is_some_and(|info| {
            info.byte_count.saturating_add(bytes.len() as u64) > MAX_RECORDING_BYTES
        }) {
            let _ = journal.file.sync_all();
            if let Some(info) = slot.info.as_mut() {
                info.active = false;
                info.error = Some("recording reached the 32 MiB safety limit".into());
            }
            return;
        }
        let result = (|| -> Result<u64, String> {
            journal
                .file
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            if journal.last_sync.elapsed() >= RECORD_SYNC_INTERVAL {
                journal
                    .file
                    .sync_data()
                    .map_err(|error| error.to_string())?;
                journal.last_sync = Instant::now();
            }
            Ok(bytes.len() as u64)
        })();

        if let Some(info) = slot.info.as_mut() {
            match result {
                Ok(bytes) => {
                    info.byte_count = info.byte_count.saturating_add(bytes);
                    match message {
                        TrackingMessage::Snapshot(_) => {
                            info.snapshot_count = info.snapshot_count.saturating_add(1)
                        }
                        TrackingMessage::Event(_) => {
                            info.event_count = info.event_count.saturating_add(1)
                        }
                    }
                }
                Err(error) => {
                    info.active = false;
                    info.error = Some(error);
                    return;
                }
            }
        }
        slot.journal = Some(journal);
    }

    fn read_recording(&self) -> Result<RecordedCapture, String> {
        let mut slot = self
            .recording
            .lock()
            .map_err(|_| "recording state is unavailable".to_string())?;
        if let Some(journal) = slot.journal.as_mut() {
            journal.file.flush().map_err(|error| error.to_string())?;
        }
        let info = slot
            .info
            .clone()
            .ok_or_else(|| "this session has not been recorded".to_string())?;
        let path = slot
            .path
            .clone()
            .ok_or_else(|| "recording path is unavailable".to_string())?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if metadata.len() > MAX_RECORDING_BYTES {
            return Err("recording exceeds the 32 MiB read limit".into());
        }
        let mut content = String::with_capacity(metadata.len() as usize);
        file.read_to_string(&mut content)
            .map_err(|error| error.to_string())?;
        parse_recording(info, &content)
    }
}

fn append_json_line<T: serde::Serialize>(file: &mut File, value: &T) -> Result<u64, String> {
    let bytes = json_line(value)?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    Ok(bytes.len() as u64)
}

fn json_line<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn parse_recording(info: RecordingInfo, content: &str) -> Result<RecordedCapture, String> {
    let mut snapshots = Vec::new();
    let mut lifecycle_events = Vec::new();
    let lines = content.lines().collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) if index + 1 == lines.len() && !content.ends_with('\n') => break,
            Err(error) => {
                return Err(format!("invalid journal line {}: {error}", index + 1));
            }
        };
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("snapshot") => {
                let message: TrackingMessage =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                if let TrackingMessage::Snapshot(snapshot) = message {
                    snapshots.push(snapshot);
                }
            }
            Some("event") => {
                let message: TrackingMessage =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                if let TrackingMessage::Event(event) = message {
                    lifecycle_events.push(event);
                }
            }
            _ => {}
        }
    }
    Ok(RecordedCapture {
        info,
        snapshots,
        lifecycle_events,
    })
}

async fn run_session(
    session_id: String,
    root: BasicProcess,
    root_key: String,
    boot: String,
    initial_scan: HashMap<i32, BasicProcess>,
    control: Arc<SessionControl>,
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
        let pidfd = open_pidfd(process.pid).ok();
        let node = make_node(
            &process,
            parent_key.clone(),
            key == root_key,
            is_ancestor,
            &boot,
            pidfd.is_some(),
            &users,
        );
        if let Some(parent) = parent_key {
            insert_edge(&mut edges, &parent, &key, "observed-parent");
        }
        known.insert(
            key,
            KnownProcess {
                node,
                pidfd,
                last_cpu_ticks: process.total_cpu_ticks(),
                sampled_at: Instant::now(),
            },
        );
    }

    emit(
        &output,
        &control,
        TrackingMessage::Event(event_for(
            "attached",
            "info",
            &root_key,
            root.pid,
            &root.comm,
            format!("Attached to {} ({})", root.comm, root.pid),
        )),
    );

    let mut interval = time::interval(SAMPLE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        if control.cancelled.load(Ordering::Relaxed) {
            emit(
                &output,
                &control,
                TrackingMessage::Event(event_for(
                    "detached",
                    "info",
                    &root_key,
                    root.pid,
                    &root.comm,
                    "Observation stopped".into(),
                )),
            );
            break;
        }

        let scan = scan_processes();
        let now = Instant::now();
        let current_by_pid = tracked_parent_index(&known);

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
                let pidfd = open_pidfd(process.pid).ok();
                let node = make_node(
                    &process,
                    Some(parent_key.clone()),
                    false,
                    false,
                    &boot,
                    pidfd.is_some(),
                    &users,
                );
                insert_edge(&mut edges, &parent_key, &key, "spawned");
                emit(
                    &output,
                    &control,
                    TrackingMessage::Event(event_for(
                        "spawn",
                        "change",
                        &key,
                        process.pid,
                        &process.comm,
                        format!("{} spawned PID {}", process.comm, process.pid),
                    )),
                );
                known.insert(
                    key.clone(),
                    KnownProcess {
                        node,
                        pidfd,
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
            let pidfd_reports_exit = entry
                .pidfd
                .as_ref()
                .and_then(|pidfd| pidfd_has_exited(pidfd).ok())
                .unwrap_or(false);
            let current = if pidfd_reports_exit {
                None
            } else {
                scan.get(&entry.node.key.pid)
                    .filter(|process| process.start_time_ticks == entry.node.key.start_time_ticks)
            };

            let Some(process) = current else {
                if entry.node.alive {
                    entry.node.alive = false;
                    entry.node.state = "exited".into();
                    entry.node.cpu_percent = 0.0;
                    entry.node.exited_at = Some(Utc::now().to_rfc3339());
                    emit(
                        &output,
                        &control,
                        TrackingMessage::Event(event_for(
                            "exit",
                            if key == root_key { "warning" } else { "change" },
                            &key,
                            entry.node.key.pid,
                            &entry.node.comm,
                            format!("{} (PID {}) exited", entry.node.comm, entry.node.key.pid),
                        )),
                    );
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
                emit(
                    &output,
                    &control,
                    TrackingMessage::Event(event_for(
                        "exec",
                        "change",
                        &key,
                        process.pid,
                        &process.comm,
                        format!(
                            "PID {} changed image: {} → {}",
                            process.pid, before, process.comm
                        ),
                    )),
                );
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
        if !emit(&output, &control, TrackingMessage::Snapshot(snapshot)) {
            break;
        }
    }
}

fn emit(
    output: &Channel<TrackingMessage>,
    control: &SessionControl,
    message: TrackingMessage,
) -> bool {
    control.record(&message);
    output.send(message).is_ok()
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
    boot: &str,
    pidfd_opened: bool,
    users: &HashMap<u32, String>,
) -> ProcessNode {
    let enrichment = enrich_process(process, users);
    let ticks = clock_ticks();
    ProcessNode {
        key: process.key(boot),
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
        identity_guard: if pidfd_opened {
            "pidfd+start-time".into()
        } else {
            "start-time".into()
        },
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

fn tracked_parent_index(known: &HashMap<String, KnownProcess>) -> HashMap<i32, String> {
    known
        .iter()
        // Ancestors are context only. Following their other children would silently
        // expand collection to unrelated sibling processes.
        .filter(|(_, entry)| entry.node.alive && !entry.node.is_ancestor)
        .map(|(key, entry)| (entry.node.key.pid, key.clone()))
        .collect()
}

fn validate_expected_identity(
    process: &BasicProcess,
    expected_start_time_ticks: Option<u64>,
) -> Result<(), String> {
    if expected_start_time_ticks.is_some_and(|expected| expected != process.start_time_ticks) {
        return Err(format!(
            "PID {} was reused before attach; choose the process again",
            process.pid
        ));
    }
    Ok(())
}

fn open_pidfd(pid: i32) -> io::Result<OwnedFd> {
    let raw_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: pidfd_open returned a new owned descriptor on success.
    Ok(unsafe { OwnedFd::from_raw_fd(raw_fd as i32) })
}

fn pidfd_has_exited(pidfd: &OwnedFd) -> io::Result<bool> {
    let mut descriptor = libc::pollfd {
        fd: pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
        if result >= 0 {
            return Ok(result > 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ProcessKey;
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::PermissionsExt;

    fn process(pid: i32, ppid: i32) -> BasicProcess {
        BasicProcess {
            pid,
            ppid,
            comm: format!("p{pid}"),
            state: "S".into(),
            utime_ticks: 0,
            stime_ticks: 0,
            threads: 1,
            start_time_ticks: pid as u64 * 10,
            virtual_bytes: 0,
            rss_pages: 0,
        }
    }

    fn known(pid: i32, is_ancestor: bool, alive: bool) -> KnownProcess {
        KnownProcess {
            node: ProcessNode {
                key: ProcessKey {
                    id: format!("boot:{pid}:10"),
                    pid,
                    start_time_ticks: 10,
                },
                ppid: 1,
                parent_key: None,
                comm: format!("p{pid}"),
                command: format!("p{pid}"),
                executable: None,
                uid: None,
                user: None,
                state: "S".into(),
                alive,
                is_focus: !is_ancestor,
                is_ancestor,
                identity_guard: "start-time".into(),
                discovered_at: "2026-01-01T00:00:00Z".into(),
                exited_at: None,
                age_seconds: 1.0,
                cpu_percent: 0.0,
                rss_bytes: 0,
                virtual_bytes: 0,
                read_bytes: 0,
                write_bytes: 0,
                threads: 1,
                fd_count: 0,
            },
            pidfd: None,
            last_cpu_ticks: 0,
            sampled_at: Instant::now(),
        }
    }

    #[test]
    fn only_live_focus_or_descendants_can_expand_scope() {
        let entries = HashMap::from([
            ("ancestor".into(), known(10, true, true)),
            ("focus".into(), known(20, false, true)),
            ("exited-descendant".into(), known(30, false, false)),
            ("descendant".into(), known(40, false, true)),
        ]);

        let parents = tracked_parent_index(&entries);

        assert_eq!(parents.len(), 2);
        assert_eq!(parents.get(&20).map(String::as_str), Some("focus"));
        assert_eq!(parents.get(&40).map(String::as_str), Some("descendant"));
        assert!(!parents.contains_key(&10));
        assert!(!parents.contains_key(&30));
    }

    #[test]
    fn pidfd_for_current_process_is_not_ready() {
        let pid = i32::try_from(std::process::id()).expect("test PID fits i32");
        let Ok(pidfd) = open_pidfd(pid) else {
            // Older kernels and restrictive CI seccomp profiles may not expose pidfds.
            return;
        };
        assert!(!pidfd_has_exited(&pidfd).expect("polling pidfd succeeds"));
    }

    #[test]
    fn initial_family_includes_lineage_but_not_siblings() {
        let parent = process(10, 1);
        let root = process(20, 10);
        let sibling = process(30, 10);
        let child = process(40, 20);
        let grandchild = process(50, 40);
        let scan = HashMap::from([
            (10, parent),
            (20, root.clone()),
            (30, sibling),
            (40, child),
            (50, grandchild),
        ]);

        let family = initial_family(&root, &scan, "boot");
        let ids = family
            .iter()
            .map(|(process, _)| process.pid)
            .collect::<HashSet<_>>();

        assert_eq!(ids, HashSet::from([10, 20, 40, 50]));
        assert!(family
            .iter()
            .any(|(process, ancestor)| process.pid == 10 && *ancestor));
        assert!(!family.iter().any(|(process, _)| process.pid == 30));
    }

    #[test]
    fn attach_rejects_a_reused_pid_identity() {
        let current = process(20, 10);

        assert!(validate_expected_identity(&current, Some(current.start_time_ticks)).is_ok());
        assert_eq!(
            validate_expected_identity(&current, Some(current.start_time_ticks - 1)),
            Err("PID 20 was reused before attach; choose the process again".into())
        );
    }

    #[test]
    fn recording_is_owner_only_and_round_trips_messages() {
        let root = std::env::temp_dir().join(format!("process-stasis-test-{}", Uuid::new_v4()));
        let control = SessionControl {
            cancelled: AtomicBool::new(false),
            recording: Mutex::new(RecordingSlot::default()),
        };
        let session_id = Uuid::new_v4().to_string();
        control
            .start_recording(&session_id, &root)
            .expect("recording starts");
        let event = TrackingMessage::Event(event_for(
            "spawn",
            "change",
            "boot:20:200",
            20,
            "p20",
            "p20 spawned".into(),
        ));
        control.record(&event);
        control.record(&TrackingMessage::Snapshot(GraphSnapshot {
            session_id: session_id.clone(),
            sequence: 4,
            timestamp: "2026-01-01T00:00:00Z".into(),
            root_key: "boot:20:200".into(),
            root_alive: true,
            alive_count: 1,
            exited_count: 0,
            nodes: vec![known(20, false, true).node],
            edges: Vec::new(),
            missed_event_warning: true,
        }));
        control.stop_recording().expect("recording pauses");
        control
            .start_recording(&session_id, &root)
            .expect("recording resumes");
        control.record(&TrackingMessage::Event(event_for(
            "exec",
            "change",
            "boot:20:200",
            20,
            "p20",
            "p20 changed image".into(),
        )));
        let stopped = control.stop_recording().expect("recording stops");
        let capture = control.read_recording().expect("recording reads");
        let file_path = root.join(&stopped.file_name);

        assert_eq!(stopped.snapshot_count, 1);
        assert_eq!(stopped.event_count, 2);
        assert_eq!(capture.snapshots.len(), 1);
        assert_eq!(capture.lifecycle_events.len(), 2);
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file_path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_file(file_path).expect("test journal removed");
        fs::remove_dir(root).expect("test directory removed");
    }

    #[test]
    fn recording_rejects_a_symlink_destination() {
        let base = std::env::temp_dir().join(format!("process-stasis-test-{}", Uuid::new_v4()));
        let actual = base.join("actual");
        let linked = base.join("linked");
        fs::create_dir_all(&actual).expect("test directory created");
        symlink(&actual, &linked).expect("test symlink created");
        let control = SessionControl {
            cancelled: AtomicBool::new(false),
            recording: Mutex::new(RecordingSlot::default()),
        };

        let error = control
            .start_recording(&Uuid::new_v4().to_string(), &linked)
            .expect_err("symlink recording root is rejected");

        assert_eq!(error, "recording location is not a real directory");
        fs::remove_file(linked).expect("test symlink removed");
        fs::remove_dir(actual).expect("test directory removed");
        fs::remove_dir(base).expect("test base removed");
    }
}
