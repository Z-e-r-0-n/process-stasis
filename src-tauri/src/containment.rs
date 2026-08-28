use crate::procfs::{boot_id, read_basic, scan_processes, BasicProcess};
use crate::types::{ContainmentStatus, ControlAction, GraphSnapshot, ProcessKey, ProcessListItem};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::ffi::{CStr, CString};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const MANAGED_ROOT: &str = "process-stasis";
const MAX_CGROUP_MEMBERS: usize = 4096;
const MAX_CGROUP_DEPTH: usize = 32;
const MAX_HELPER_REQUEST_BYTES: u64 = 64 * 1024;
const ACQUIRE_ROUNDS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest {
    action: String,
    session_id: String,
    root: Option<ProcessKey>,
    observer_pid: i32,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    run_uid: Option<u32>,
    #[serde(default)]
    run_gid: Option<u32>,
    #[serde(default)]
    working_directory: Option<String>,
    #[serde(default)]
    environment: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperResponse {
    action: String,
    frozen: bool,
    cgroup_path: String,
    members: Vec<ProcessKey>,
    verification: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    launched_pid: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    launched_start_time_ticks: Option<u64>,
}

pub fn status(session_id: &str, snapshot: Option<&GraphSnapshot>) -> ContainmentStatus {
    let supported = Path::new(CGROUP_ROOT).join("cgroup.controllers").is_file();
    let root = snapshot.and_then(|item| {
        item.nodes
            .iter()
            .find(|node| node.key.id == item.root_key && node.alive)
    });
    let managed_path = root.and_then(|node| locate_managed_group(session_id, node.key.pid));
    let frozen = managed_path
        .as_deref()
        .and_then(|path| frozen_state(path).ok())
        .unwrap_or(false);
    let members = managed_path.as_deref().map(member_keys).unwrap_or_default();
    let available = supported
        && root.is_some_and(|node| node.key.pid > 1 && node.key.pid != std::process::id() as i32);
    let managed = managed_path.is_some();
    let summary = if !supported {
        "This kernel does not expose cgroup v2.".into()
    } else if root.is_none() {
        "The selected process is no longer running.".into()
    } else if root.is_some_and(|node| node.key.pid == std::process::id() as i32) {
        "Process Stasis cannot acquire its own desktop process.".into()
    } else if frozen {
        format!(
            "{} process{} frozen",
            members.len(),
            if members.len() == 1 { "" } else { "es" }
        )
    } else if managed {
        format!(
            "{} process{} acquired and running",
            members.len(),
            if members.len() == 1 { "" } else { "es" }
        )
    } else {
        "Ready to acquire the selected tree.".into()
    };
    ContainmentStatus {
        supported,
        available,
        managed,
        frozen,
        cgroup_path: managed_path.and_then(|path| relative_cgroup(&path)),
        summary,
        members,
    }
}

pub fn set_frozen(
    session_id: &str,
    snapshot: &GraphSnapshot,
    freeze: bool,
) -> Result<(ContainmentStatus, ControlAction), String> {
    let root = snapshot
        .nodes
        .iter()
        .find(|node| node.key.id == snapshot.root_key && node.alive)
        .ok_or_else(|| "the selected process is no longer running".to_string())?;
    if root.key.pid <= 1 {
        return Err("PID 1 cannot be acquired".into());
    }
    if root.key.pid == std::process::id() as i32 {
        return Err("Process Stasis cannot acquire its own desktop process".into());
    }
    let request = HelperRequest {
        action: if freeze { "freeze" } else { "thaw" }.into(),
        session_id: session_id.into(),
        root: Some(root.key.clone()),
        observer_pid: std::process::id() as i32,
        command: None,
        run_uid: None,
        run_gid: None,
        working_directory: None,
        environment: Vec::new(),
    };
    let response = invoke_helper(&request)?;
    let next_status = status(session_id, Some(snapshot));
    let action = ControlAction {
        id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        action: response.action,
        outcome: "verified".into(),
        reason: "desktop-control".into(),
        cgroup_path: Some(response.cgroup_path),
        affected_processes: response.members,
        verification: response.verification,
    };
    Ok((next_status, action))
}

pub fn launch_managed(command: &str) -> Result<ProcessListItem, String> {
    let command = command.trim();
    if command.is_empty() || command.len() > 4096 || command.as_bytes().contains(&0) {
        return Err("launch command must be 1–4096 characters".into());
    }
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let working_directory = env::var("HOME")
        .ok()
        .filter(|path| Path::new(path).is_dir());
    let allowed_environment = [
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "LANG",
        "LC_ALL",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "XAUTHORITY",
    ];
    let environment = allowed_environment
        .into_iter()
        .filter_map(|name| env::var(name).ok().map(|value| format!("{name}={value}")))
        .collect();
    let request = HelperRequest {
        action: "launch".into(),
        session_id: Uuid::new_v4().to_string(),
        root: None,
        observer_pid: std::process::id() as i32,
        command: Some(command.into()),
        run_uid: Some(uid),
        run_gid: Some(gid),
        working_directory,
        environment,
    };
    let response = invoke_helper(&request)?;
    let pid = response
        .launched_pid
        .ok_or_else(|| "the helper did not return the launched PID".to_string())?;
    let start_time = response
        .launched_start_time_ticks
        .ok_or_else(|| "the helper did not return the launched process identity".to_string())?;
    for _ in 0..40 {
        if let Some(item) = crate::procfs::list_processes(Some(&pid.to_string()), 64)
            .into_iter()
            .find(|item| item.key.pid == pid && item.key.start_time_ticks == start_time)
        {
            return Ok(item);
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("the launched process exited before observation began".into())
}

pub fn helper_exit_code_from_args() -> Option<i32> {
    if env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("--process-stasis-helper")) {
        return None;
    }
    let result = helper_entry();
    match result {
        Ok(response) => match serde_json::to_string(&response) {
            Ok(json) => {
                println!("{json}");
                Some(0)
            }
            Err(error) => {
                eprintln!("could not encode helper response: {error}");
                Some(1)
            }
        },
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

fn helper_entry() -> Result<HelperResponse, String> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("the containment helper requires root privileges".into());
    }
    let mut body = String::new();
    std::io::stdin()
        .take(MAX_HELPER_REQUEST_BYTES)
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    let request: HelperRequest =
        serde_json::from_str(&body).map_err(|error| format!("invalid helper request: {error}"))?;
    apply_helper(&request)
}

fn invoke_helper(request: &HelperRequest) -> Result<HelperResponse, String> {
    if unsafe { libc::geteuid() } == 0 {
        return apply_helper(request);
    }
    let executable = env::current_exe()
        .ok()
        .ok_or_else(|| "could not resolve the Process Stasis executable".to_string())?;
    let mut child = Command::new("pkexec")
        .arg(executable)
        .arg("--process-stasis-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start the privileged helper: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        serde_json::to_writer(&mut stdin, request).map_err(|error| error.to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "privileged containment was cancelled or unavailable".into()
        } else {
            detail
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid helper response: {error}"))
}

fn apply_helper(request: &HelperRequest) -> Result<HelperResponse, String> {
    validate_request(request)?;
    match request.action.as_str() {
        "freeze" => helper_freeze(request),
        "thaw" => helper_thaw(request),
        "launch" => helper_launch(request),
        _ => Err("unsupported containment helper action".into()),
    }
}

fn validate_request(request: &HelperRequest) -> Result<(), String> {
    let canonical = Uuid::parse_str(&request.session_id)
        .map_err(|_| "session ID is not a UUID".to_string())?
        .to_string();
    if canonical != request.session_id {
        return Err("session ID is not canonical".into());
    }
    if request.observer_pid <= 1 {
        return Err("invalid containment process identity".into());
    }
    if request.action == "launch" {
        let command = request.command.as_deref().unwrap_or_default();
        if command.trim().is_empty() || command.len() > 4096 || command.as_bytes().contains(&0) {
            return Err("launch command must be 1–4096 characters".into());
        }
        let uid = request
            .run_uid
            .ok_or_else(|| "launch UID is missing".to_string())?;
        request
            .run_gid
            .ok_or_else(|| "launch GID is missing".to_string())?;
        if let Ok(pkexec_uid) = env::var("PKEXEC_UID") {
            if pkexec_uid.parse::<u32>().ok() != Some(uid) {
                return Err("launch UID does not match the requesting desktop user".into());
            }
        }
    } else {
        let root = request
            .root
            .as_ref()
            .ok_or_else(|| "containment root identity is missing".to_string())?;
        if root.pid <= 1 {
            return Err("invalid containment process identity".into());
        }
        let current =
            read_basic(root.pid).map_err(|_| format!("PID {} is no longer running", root.pid))?;
        if current.start_time_ticks != root.start_time_ticks {
            return Err(format!("PID {} identity changed", root.pid));
        }
    }
    if !Path::new(CGROUP_ROOT).join("cgroup.controllers").is_file() {
        return Err("cgroup v2 is unavailable".into());
    }
    Ok(())
}

fn helper_freeze(request: &HelperRequest) -> Result<HelperResponse, String> {
    let root = request
        .root
        .as_ref()
        .ok_or_else(|| "containment root identity is missing".to_string())?;
    if let Some(existing) = locate_managed_group(&request.session_id, root.pid) {
        write_frozen(&existing, true)?;
        let members = member_keys(&existing);
        return Ok(HelperResponse {
            action: "freeze".into(),
            frozen: true,
            cgroup_path: relative_cgroup(&existing).unwrap_or_default(),
            verification: format!(
                "kernel confirmed frozen=1 for {} process{}",
                members.len(),
                if members.len() == 1 { "" } else { "es" }
            ),
            members,
            launched_pid: None,
            launched_start_time_ticks: None,
        });
    }
    acquire_and_freeze(request)
}

fn helper_thaw(request: &HelperRequest) -> Result<HelperResponse, String> {
    let root = request
        .root
        .as_ref()
        .ok_or_else(|| "containment root identity is missing".to_string())?;
    let path = locate_managed_group(&request.session_id, root.pid)
        .ok_or_else(|| "the selected process has not been acquired".to_string())?;
    write_frozen(&path, false)?;
    let members = member_keys(&path);
    Ok(HelperResponse {
        action: "thaw".into(),
        frozen: false,
        cgroup_path: relative_cgroup(&path).unwrap_or_default(),
        verification: format!(
            "kernel confirmed frozen=0 for {} process{}",
            members.len(),
            if members.len() == 1 { "" } else { "es" }
        ),
        members,
        launched_pid: None,
        launched_start_time_ticks: None,
    })
}

fn helper_launch(request: &HelperRequest) -> Result<HelperResponse, String> {
    let uid = request
        .run_uid
        .ok_or_else(|| "launch UID is missing".to_string())?;
    let gid = request
        .run_gid
        .ok_or_else(|| "launch GID is missing".to_string())?;
    let command_text = request.command.as_deref().unwrap_or_default().trim();
    let passwd = unsafe { libc::getpwuid(uid) };
    if passwd.is_null() {
        return Err(format!("UID {uid} has no passwd entry"));
    }
    let username = unsafe { CStr::from_ptr((*passwd).pw_name) }.to_owned();
    let passwd_home = unsafe { CStr::from_ptr((*passwd).pw_dir) }.to_owned();
    let primary_gid = unsafe { (*passwd).pw_gid };
    if primary_gid != gid {
        return Err("launch GID does not match the user's primary group".into());
    }

    let parent = Path::new(CGROUP_ROOT).join(MANAGED_ROOT);
    fs::create_dir_all(&parent)
        .map_err(|error| format!("could not create managed cgroup root: {error}"))?;
    let path = parent.join(&request.session_id);
    fs::create_dir(&path)
        .map_err(|error| format!("could not create the launch cgroup: {error}"))?;
    let procs = OpenOptions::new()
        .write(true)
        .open(path.join("cgroup.procs"))
        .map_err(|error| format!("could not open the launch cgroup: {error}"))?;

    let shell = CString::new("/bin/sh").unwrap();
    let shell_name = CString::new("sh").unwrap();
    let login_arg = CString::new("-lc").unwrap();
    let shell_command = CString::new(format!("exec {command_text}"))
        .map_err(|_| "launch command contains a null byte".to_string())?;
    let working_directory = request
        .working_directory
        .as_deref()
        .filter(|value| Path::new(value).is_dir())
        .map(CString::new)
        .transpose()
        .map_err(|_| "working directory contains a null byte".to_string())?
        .unwrap_or(passwd_home);
    let mut environment = request
        .environment
        .iter()
        .map(|value| {
            CString::new(value.as_str())
                .map_err(|_| "launch environment contains a null byte".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !request
        .environment
        .iter()
        .any(|value| value.starts_with("PATH="))
    {
        environment.push(
            CString::new("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
                .unwrap(),
        );
    }
    let argv = [
        shell_name.as_ptr(),
        login_arg.as_ptr(),
        shell_command.as_ptr(),
        std::ptr::null(),
    ];
    let mut envp = environment
        .iter()
        .map(|value| value.as_ptr())
        .collect::<Vec<_>>();
    envp.push(std::ptr::null());
    let cgroup_fd = procs.as_raw_fd();

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        let _ = fs::remove_dir(&path);
        return Err(format!(
            "could not fork the managed process: {}",
            std::io::Error::last_os_error()
        ));
    }
    if pid == 0 {
        unsafe {
            libc::setsid();
            if libc::write(cgroup_fd, b"0".as_ptr().cast(), 1) != 1 {
                libc::_exit(125);
            }
            libc::close(cgroup_fd);
            let dev_null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
            if dev_null >= 0 {
                libc::dup2(dev_null, libc::STDIN_FILENO);
                libc::dup2(dev_null, libc::STDOUT_FILENO);
                libc::dup2(dev_null, libc::STDERR_FILENO);
                if dev_null > libc::STDERR_FILENO {
                    libc::close(dev_null);
                }
            }
            if libc::initgroups(username.as_ptr(), gid) != 0
                || libc::setgid(gid) != 0
                || libc::setuid(uid) != 0
                || libc::chdir(working_directory.as_ptr()) != 0
            {
                libc::_exit(126);
            }
            libc::execve(shell.as_ptr(), argv.as_ptr(), envp.as_ptr());
            libc::_exit(127);
        }
    }
    drop(procs);

    let mut launched = None;
    for _ in 0..80 {
        if let Ok(process) = read_basic(pid) {
            if unified_cgroup(pid).ok().is_some_and(|relative| {
                relative_cgroup(&path).as_deref() == Some(relative.as_str())
            }) {
                launched = Some(process);
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    let mut process = launched
        .ok_or_else(|| "the managed command exited before it could be observed".to_string())?;
    // The child enters the cgroup before exec. Give the shell wrapper a short window
    // to replace itself so the desktop attaches to the requested image, not `sh`.
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(10));
        let Ok(current) = read_basic(pid) else { break };
        process = current;
        if process.comm != "sh" && process.comm != "bash" {
            break;
        }
    }
    let members = member_keys(&path);
    Ok(HelperResponse {
        action: "launch".into(),
        frozen: false,
        cgroup_path: relative_cgroup(&path).unwrap_or_default(),
        verification: format!("launched PID {} inside a dedicated cgroup", process.pid),
        launched_pid: Some(process.pid),
        launched_start_time_ticks: Some(process.start_time_ticks),
        members,
    })
}

fn acquire_and_freeze(request: &HelperRequest) -> Result<HelperResponse, String> {
    let parent = Path::new(CGROUP_ROOT).join(MANAGED_ROOT);
    fs::create_dir_all(&parent)
        .map_err(|error| format!("could not create managed cgroup root: {error}"))?;
    let path = parent.join(&request.session_id);
    if path.exists() && !recursive_members(&path, 0)?.is_empty() {
        return Err("the session cgroup already contains another process tree".into());
    }
    fs::create_dir(&path)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|error| format!("could not create the session cgroup: {error}"))?;

    let mut stopped_by_us = BTreeSet::new();
    let mut original_groups = HashMap::new();
    let acquisition = (|| -> Result<Vec<ProcessKey>, String> {
        let mut previous = BTreeSet::new();
        let mut stable_rounds = 0;
        let mut acquired = Vec::new();
        for _ in 0..ACQUIRE_ROUNDS {
            let scan = scan_processes();
            let requested_root = request
                .root
                .as_ref()
                .ok_or_else(|| "containment root identity is missing".to_string())?;
            let root = scan
                .get(&requested_root.pid)
                .ok_or_else(|| "the selected process exited during acquisition".to_string())?;
            if root.start_time_ticks != requested_root.start_time_ticks {
                return Err("the selected PID changed identity during acquisition".into());
            }
            let tree = descendant_tree(requested_root.pid, &scan)?;
            let ids = tree.iter().map(|item| item.pid).collect::<BTreeSet<_>>();
            if ids.contains(&request.observer_pid) {
                return Err("the selected tree contains the Process Stasis desktop process".into());
            }
            for process in &tree {
                original_groups
                    .entry(process.pid)
                    .or_insert_with(|| unified_cgroup(process.pid).unwrap_or_else(|_| "/".into()));
                if process.state != "T" && process.state != "t" && stopped_by_us.insert(process.pid)
                {
                    send_signal(process.pid, libc::SIGSTOP)?;
                }
            }
            if ids == previous {
                stable_rounds += 1;
            } else {
                stable_rounds = 0;
                previous = ids;
            }
            acquired = tree;
            if stable_rounds >= 1 {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if stable_rounds < 1 {
            return Err("the process tree did not stabilize during acquisition".into());
        }
        for process in &acquired {
            let current = read_basic(process.pid)
                .map_err(|_| format!("PID {} exited during acquisition", process.pid))?;
            if current.start_time_ticks != process.start_time_ticks {
                return Err(format!(
                    "PID {} changed identity during acquisition",
                    process.pid
                ));
            }
            write_pid(&path, process.pid)?;
        }
        let expected = acquired
            .iter()
            .map(|item| item.pid)
            .collect::<BTreeSet<_>>();
        let actual = recursive_members(&path, 0)?;
        if actual != expected {
            return Err("the acquired cgroup membership did not match the stopped tree".into());
        }
        write_frozen(&path, true)?;
        Ok(acquired.iter().map(process_key).collect())
    })();

    match acquisition {
        Ok(members) => {
            for pid in &stopped_by_us {
                let _ = send_signal(*pid, libc::SIGCONT);
            }
            let actual = member_keys(&path);
            let expected = members.iter().map(|item| item.pid).collect::<BTreeSet<_>>();
            let actual_ids = actual.iter().map(|item| item.pid).collect::<BTreeSet<_>>();
            if actual_ids != expected || !frozen_state(&path)? {
                return Err("the kernel did not retain the acquired frozen tree".into());
            }
            Ok(HelperResponse {
                action: "freeze".into(),
                frozen: true,
                cgroup_path: relative_cgroup(&path).unwrap_or_default(),
                verification: format!(
                    "acquired {} process{}; kernel confirmed frozen=1",
                    actual.len(),
                    if actual.len() == 1 { "" } else { "es" }
                ),
                members: actual,
                launched_pid: None,
                launched_start_time_ticks: None,
            })
        }
        Err(error) => {
            let _ = write_frozen(&path, false);
            for (pid, relative) in original_groups {
                if let Some(original) = resolve_any_cgroup_path(&relative) {
                    let _ = write_pid(&original, pid);
                }
            }
            for pid in stopped_by_us {
                let _ = send_signal(pid, libc::SIGCONT);
            }
            let _ = fs::remove_dir(&path);
            Err(error)
        }
    }
}

fn descendant_tree(
    root_pid: i32,
    scan: &HashMap<i32, BasicProcess>,
) -> Result<Vec<BasicProcess>, String> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for process in scan.values() {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    let mut queue = VecDeque::from([root_pid]);
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        let Some(process) = scan.get(&pid) else {
            continue;
        };
        result.push(process.clone());
        if result.len() > MAX_CGROUP_MEMBERS {
            return Err("the process tree exceeds the acquisition limit".into());
        }
        if let Some(items) = children.get(&pid) {
            queue.extend(items.iter().copied());
        }
    }
    if result.is_empty() {
        return Err("the selected process is no longer visible".into());
    }
    Ok(result)
}

fn process_key(process: &BasicProcess) -> ProcessKey {
    process.key(&boot_id())
}

fn send_signal(pid: i32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "could not signal PID {pid}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn write_pid(path: &Path, pid: i32) -> Result<(), String> {
    fs::write(path.join("cgroup.procs"), pid.to_string())
        .map_err(|error| format!("could not move PID {pid}: {error}"))
}

fn write_frozen(path: &Path, frozen: bool) -> Result<(), String> {
    let expected = if frozen { "1" } else { "0" };
    let mut file = OpenOptions::new()
        .write(true)
        .open(path.join("cgroup.freeze"))
        .map_err(|error| format!("could not open cgroup.freeze: {error}"))?;
    file.write_all(expected.as_bytes())
        .map_err(|error| format!("could not write cgroup.freeze: {error}"))?;
    for _ in 0..80 {
        if frozen_state(path)? == frozen {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(format!("the kernel did not confirm frozen={expected}"))
}

fn locate_managed_group(session_id: &str, pid: i32) -> Option<PathBuf> {
    let requested = Path::new(CGROUP_ROOT).join(MANAGED_ROOT).join(session_id);
    if requested.is_dir() {
        return Some(requested);
    }
    let relative = unified_cgroup(pid).ok()?;
    if !relative.starts_with(&format!("/{MANAGED_ROOT}/")) {
        return None;
    }
    resolve_any_cgroup_path(&relative)
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

fn resolve_any_cgroup_path(relative: &str) -> Option<PathBuf> {
    if !relative.starts_with('/') || relative.contains("..") {
        return None;
    }
    let joined = Path::new(CGROUP_ROOT).join(relative.trim_start_matches('/'));
    let metadata = fs::symlink_metadata(&joined).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    Some(joined)
}

fn relative_cgroup(path: &Path) -> Option<String> {
    let relative = path.strip_prefix(CGROUP_ROOT).ok()?;
    Some(format!("/{}", relative.to_string_lossy()))
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

fn member_keys(path: &Path) -> Vec<ProcessKey> {
    let boot = boot_id();
    recursive_members(path, 0)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|pid| read_basic(pid).ok())
        .map(|process| process.key(&boot))
        .collect()
}

fn frozen_state(path: &Path) -> Result<bool, String> {
    let content =
        fs::read_to_string(path.join("cgroup.events")).map_err(|error| error.to_string())?;
    content
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(' ')?;
            (name == "frozen").then_some(value == "1")
        })
        .ok_or_else(|| "cgroup.events does not report frozen state".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendant_tree_is_bounded_and_stable() {
        let make = |pid, ppid| BasicProcess {
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
        };
        let scan = HashMap::from([
            (10, make(10, 1)),
            (11, make(11, 10)),
            (12, make(12, 11)),
            (20, make(20, 1)),
        ]);
        let tree = descendant_tree(10, &scan).unwrap();
        assert_eq!(
            tree.iter().map(|item| item.pid).collect::<Vec<_>>(),
            vec![10, 11, 12]
        );
    }

    #[test]
    fn rejects_noncanonical_session_ids() {
        let request = HelperRequest {
            action: "freeze".into(),
            session_id: "NOT-A-UUID".into(),
            root: Some(ProcessKey {
                id: "x".into(),
                pid: 22,
                start_time_ticks: 1,
            }),
            observer_pid: 23,
            command: None,
            run_uid: None,
            run_gid: None,
            working_directory: None,
            environment: Vec::new(),
        };
        assert!(validate_request(&request).is_err());
    }
}
