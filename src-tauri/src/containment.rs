use crate::procfs::read_basic;
use crate::types::{
    CapabilityGate, ContainmentOutcome, ContainmentStatus, ControlAction, GraphSnapshot, ProcessKey,
};
use chrono::Utc;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const MAX_CGROUP_MEMBERS: usize = 4096;
const MAX_CGROUP_DEPTH: usize = 32;

pub fn status(snapshot: Option<&GraphSnapshot>) -> ContainmentStatus {
    let mut gates = Vec::new();
    let v2 = Path::new(CGROUP_ROOT).join("cgroup.controllers").is_file();
    gates.push(gate(
        "cgroup-v2",
        "Unified cgroup v2",
        v2,
        if v2 {
            "The unified cgroup v2 control surface is mounted."
        } else {
            "The unified cgroup v2 control surface is unavailable."
        },
    ));

    let Some(snapshot) = snapshot else {
        gates.push(gate(
            "live-scope",
            "Live tracked scope",
            false,
            "No active tracking snapshot is available.",
        ));
        return finish(gates, None, false, Vec::new());
    };
    let members = snapshot
        .nodes
        .iter()
        .filter(|node| node.alive && !node.is_ancestor)
        .map(|node| node.key.clone())
        .collect::<Vec<_>>();
    gates.push(gate(
        "live-scope",
        "Live tracked scope",
        !members.is_empty(),
        if members.is_empty() {
            "The tracked scope has no living members."
        } else {
            "At least one living focus or descendant is identity-pinned."
        },
    ));

    let mut paths = BTreeSet::new();
    let mut readable = true;
    for member in &members {
        match unified_cgroup(member.pid) {
            Ok(path) => {
                paths.insert(path);
            }
            Err(_) => readable = false,
        }
    }
    let one_group = readable && paths.len() == 1;
    gates.push(gate(
        "single-cgroup",
        "Single controlled group",
        one_group,
        if one_group {
            "Every live tracked member reports the same unified cgroup."
        } else {
            "Live members are split across cgroups or their membership is unreadable."
        },
    ));
    let relative = paths.into_iter().next();
    let non_root = relative.as_deref().is_some_and(|path| path != "/");
    gates.push(gate(
        "non-root-cgroup",
        "Dedicated non-root group",
        non_root,
        if non_root {
            "The group is below the cgroup root."
        } else {
            "The cgroup root can never be used as a containment target."
        },
    ));

    let group_path = relative.as_deref().and_then(resolve_cgroup_path);
    let tracked_pids = members.iter().map(|key| key.pid).collect::<BTreeSet<_>>();
    let actual_pids = group_path
        .as_deref()
        .and_then(|path| recursive_members(path, 0).ok());
    let exclusive = actual_pids
        .as_ref()
        .is_some_and(|pids| pids == &tracked_pids);
    gates.push(gate(
        "exclusive-membership",
        "Exclusive tracked membership",
        exclusive,
        if exclusive {
            "The cgroup subtree contains exactly the living tracked processes."
        } else {
            "The cgroup subtree contains untracked processes, misses tracked members, or cannot be bounded safely."
        },
    ));

    let freeze_path = group_path.as_ref().map(|path| path.join("cgroup.freeze"));
    let writable = freeze_path
        .as_ref()
        .is_some_and(|path| OpenOptions::new().write(true).open(path).is_ok());
    gates.push(gate(
        "writable-freezer",
        "Writable freezer",
        writable,
        if writable {
            "The current user can request and verify cgroup freeze state."
        } else {
            "cgroup.freeze is missing or is not writable by the current user."
        },
    ));

    let frozen = group_path.as_deref().is_some_and(read_frozen);
    finish(gates, relative, frozen, members)
}

pub fn set_frozen(
    snapshot: &GraphSnapshot,
    freeze: bool,
    reason: &str,
    acknowledged: bool,
) -> Result<ContainmentOutcome, String> {
    if !acknowledged {
        return Err("containment requires an explicit authorization acknowledgement".into());
    }
    let reason = reason.trim();
    if reason.len() < 8 || reason.len() > 500 || reason.chars().any(char::is_control) {
        return Err("containment reason must be 8–500 printable characters".into());
    }
    let before = status(Some(snapshot));
    if !before.available {
        return Err(before.reason);
    }
    for member in &before.members {
        let current = read_basic(member.pid)
            .map_err(|_| format!("PID {} exited before containment", member.pid))?;
        if current.start_time_ticks != member.start_time_ticks {
            return Err(format!(
                "PID {} identity changed before containment",
                member.pid
            ));
        }
    }
    let relative = before
        .cgroup_path
        .clone()
        .ok_or_else(|| "verified cgroup path is unavailable".to_string())?;
    let path = resolve_cgroup_path(&relative)
        .ok_or_else(|| "verified cgroup path is unsafe".to_string())?;
    let expected = if freeze { "1" } else { "0" };
    let mut file = OpenOptions::new()
        .write(true)
        .open(path.join("cgroup.freeze"))
        .map_err(|error| error.to_string())?;
    file.write_all(expected.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;

    let mut verified = false;
    for _ in 0..40 {
        if read_frozen(&path) == freeze {
            verified = true;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let after = status(Some(snapshot));
    let scope_still_exact = after
        .gates
        .iter()
        .find(|gate| gate.id == "exclusive-membership")
        .is_some_and(|gate| gate.passed);
    let outcome = if verified && scope_still_exact {
        "verified"
    } else if freeze && read_frozen(&path) {
        "frozen-scope-changed"
    } else {
        "verification-failed"
    };
    let action = ControlAction {
        id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        action: if freeze { "freeze" } else { "thaw" }.into(),
        outcome: outcome.into(),
        reason: reason.into(),
        cgroup_path: Some(relative),
        affected_processes: before.members,
        verification: if verified && scope_still_exact {
            format!("cgroup.events confirmed frozen={expected}; membership remained exact")
        } else if freeze && read_frozen(&path) {
            "The group is frozen, but membership changed during verification; it remains frozen for operator review.".into()
        } else {
            format!("cgroup.events did not confirm frozen={expected}")
        },
    };
    if outcome == "verification-failed" {
        return Err(action.verification);
    }
    Ok(ContainmentOutcome {
        status: after,
        action,
    })
}

fn gate(id: &str, label: &str, passed: bool, detail: &str) -> CapabilityGate {
    CapabilityGate {
        id: id.into(),
        label: label.into(),
        passed,
        detail: detail.into(),
    }
}

fn finish(
    gates: Vec<CapabilityGate>,
    cgroup_path: Option<String>,
    frozen: bool,
    members: Vec<ProcessKey>,
) -> ContainmentStatus {
    let available = !gates.is_empty() && gates.iter().all(|gate| gate.passed);
    let reason = gates
        .iter()
        .find(|gate| !gate.passed)
        .map(|gate| gate.detail.clone())
        .unwrap_or_else(|| "Verified cgroup freeze is available for this tracked scope.".into());
    ContainmentStatus {
        supported: gates
            .iter()
            .find(|gate| gate.id == "cgroup-v2")
            .is_some_and(|gate| gate.passed),
        available,
        frozen,
        cgroup_path,
        reason,
        gates,
        members,
        network_restriction_available: false,
        network_reason: "Network isolation requires a separately audited privileged helper and is not enabled in this build.".into(),
    }
}

fn unified_cgroup(pid: i32) -> Result<String, String> {
    let content =
        fs::read_to_string(format!("/proc/{pid}/cgroup")).map_err(|error| error.to_string())?;
    content
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_string)
        .ok_or_else(|| "unified cgroup membership is unavailable".into())
}

fn resolve_cgroup_path(relative: &str) -> Option<PathBuf> {
    if !relative.starts_with('/') || relative == "/" || relative.contains("..") {
        return None;
    }
    let root = Path::new(CGROUP_ROOT);
    let joined = root.join(relative.trim_start_matches('/'));
    let metadata = fs::symlink_metadata(&joined).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    Some(joined)
}

fn recursive_members(path: &Path, depth: usize) -> Result<BTreeSet<i32>, String> {
    if depth > MAX_CGROUP_DEPTH {
        return Err("cgroup subtree exceeds the depth limit".into());
    }
    let mut members = BTreeSet::new();
    let content =
        fs::read_to_string(path.join("cgroup.procs")).map_err(|error| error.to_string())?;
    for line in content.lines() {
        if let Ok(pid) = line.parse::<i32>() {
            members.insert(pid);
            if members.len() > MAX_CGROUP_MEMBERS {
                return Err("cgroup subtree exceeds the member limit".into());
            }
        }
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.file_type().map_err(|error| error.to_string())?;
        if metadata.is_dir() && !metadata.is_symlink() {
            members.extend(recursive_members(&entry.path(), depth + 1)?);
            if members.len() > MAX_CGROUP_MEMBERS {
                return Err("cgroup subtree exceeds the member limit".into());
            }
        }
    }
    Ok(members)
}

fn read_frozen(path: &Path) -> bool {
    fs::read_to_string(path.join("cgroup.events"))
        .ok()
        .and_then(|content| {
            content.lines().find_map(|line| {
                let (name, value) = line.split_once(' ')?;
                (name == "frozen").then_some(value == "1")
            })
        })
        .unwrap_or(false)
}
