use crate::types::{
    FileDescriptor, NamespaceEntry, ProcessDetails, ProcessKey, ProcessListItem, SocketEntry,
    SystemOverview,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FDS: usize = 8192;

#[derive(Debug, Clone)]
pub struct BasicProcess {
    pub pid: i32,
    pub ppid: i32,
    pub comm: String,
    pub state: String,
    pub utime_ticks: u64,
    pub stime_ticks: u64,
    pub threads: u64,
    pub start_time_ticks: u64,
    pub virtual_bytes: u64,
    pub rss_pages: i64,
}

impl BasicProcess {
    pub fn key(&self, boot_id: &str) -> ProcessKey {
        ProcessKey {
            id: format!("{boot_id}:{}:{}", self.pid, self.start_time_ticks),
            pid: self.pid,
            start_time_ticks: self.start_time_ticks,
        }
    }

    pub fn total_cpu_ticks(&self) -> u64 {
        self.utime_ticks.saturating_add(self.stime_ticks)
    }
}

#[derive(Debug, Clone)]
pub struct ProcessEnrichment {
    pub command: String,
    pub executable: Option<String>,
    pub uid: Option<u32>,
    pub user: Option<String>,
    pub rss_bytes: u64,
    pub read_bytes: u64,
    pub write_bytes: u64,
    pub fd_count: u64,
}

pub fn boot_id() -> String {
    read_text_bounded(Path::new("/proc/sys/kernel/random/boot_id"), 256)
        .unwrap_or_else(|_| "unknown-boot".to_string())
        .trim()
        .to_string()
}

pub fn clock_ticks() -> f64 {
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks > 0 {
        ticks as f64
    } else {
        100.0
    }
}

pub fn page_size() -> u64 {
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if size > 0 {
        size as u64
    } else {
        4096
    }
}

pub fn uptime_seconds() -> f64 {
    fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|value| value.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0)
}

pub fn parse_stat(text: &str) -> Result<BasicProcess, String> {
    let left = text.find('(').ok_or("stat is missing comm start")?;
    let right = text.rfind(')').ok_or("stat is missing comm end")?;
    if right <= left {
        return Err("stat comm is malformed".into());
    }
    let pid = text[..left]
        .trim()
        .parse::<i32>()
        .map_err(|_| "stat PID is invalid")?;
    let comm = text[left + 1..right].to_string();
    let fields: Vec<&str> = text[right + 1..].split_whitespace().collect();
    if fields.len() <= 21 {
        return Err("stat has too few fields".into());
    }
    let parse_u64 = |index: usize, name: &str| {
        fields[index]
            .parse::<u64>()
            .map_err(|_| format!("stat {name} is invalid"))
    };
    Ok(BasicProcess {
        pid,
        state: fields[0].to_string(),
        ppid: fields[1]
            .parse::<i32>()
            .map_err(|_| "stat PPID is invalid")?,
        comm,
        utime_ticks: parse_u64(11, "utime")?,
        stime_ticks: parse_u64(12, "stime")?,
        threads: parse_u64(17, "threads")?,
        start_time_ticks: parse_u64(19, "start time")?,
        virtual_bytes: parse_u64(20, "virtual size")?,
        rss_pages: fields[21]
            .parse::<i64>()
            .map_err(|_| "stat RSS is invalid")?,
    })
}

pub fn read_basic(pid: i32) -> Result<BasicProcess, String> {
    let path = PathBuf::from(format!("/proc/{pid}/stat"));
    let text = read_text_bounded(&path, 128 * 1024).map_err(|error| error.to_string())?;
    parse_stat(&text)
}

pub fn scan_processes() -> HashMap<i32, BasicProcess> {
    let mut processes = HashMap::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return processes;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        if let Ok(process) = read_basic(pid) {
            processes.insert(pid, process);
        }
    }
    processes
}

pub fn list_processes(query: Option<&str>, limit: usize) -> Vec<ProcessListItem> {
    let boot = boot_id();
    let uptime = uptime_seconds();
    let ticks = clock_ticks();
    let page = page_size();
    let users = passwd_map();
    let needle = query.unwrap_or_default().trim().to_lowercase();
    let mut items = Vec::new();
    for process in scan_processes().into_values() {
        let command_line = read_cmdline(process.pid).unwrap_or_default();
        let command = display_command(&command_line, &process.comm);
        let executable = fs::read_link(format!("/proc/{}/exe", process.pid))
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        if !needle.is_empty()
            && !process.comm.to_lowercase().contains(&needle)
            && !command.to_lowercase().contains(&needle)
            && !process.pid.to_string().contains(&needle)
        {
            continue;
        }
        let status = read_status(process.pid).unwrap_or_default();
        let uid = first_number(status.get("Uid"));
        items.push(ProcessListItem {
            key: process.key(&boot),
            ppid: process.ppid,
            comm: process.comm,
            command,
            executable,
            uid,
            user: uid.and_then(|value| users.get(&value).cloned()),
            state: process.state,
            rss_bytes: process.rss_pages.max(0) as u64 * page,
            threads: process.threads,
            age_seconds: (uptime - process.start_time_ticks as f64 / ticks).max(0.0),
        });
    }
    items.sort_by(|a, b| {
        b.rss_bytes
            .cmp(&a.rss_bytes)
            .then_with(|| a.comm.cmp(&b.comm))
            .then_with(|| a.key.pid.cmp(&b.key.pid))
    });
    items.truncate(limit.clamp(1, 1000));
    items
}

pub fn enrich_process(process: &BasicProcess, users: &HashMap<u32, String>) -> ProcessEnrichment {
    let status = read_status(process.pid).unwrap_or_default();
    let uid = first_number(status.get("Uid"));
    let io = read_io(process.pid).unwrap_or_default();
    ProcessEnrichment {
        command: display_command(
            &read_cmdline(process.pid).unwrap_or_default(),
            &process.comm,
        ),
        executable: fs::read_link(format!("/proc/{}/exe", process.pid))
            .ok()
            .map(|path| path.to_string_lossy().into_owned()),
        uid,
        user: uid.and_then(|value| users.get(&value).cloned()),
        rss_bytes: process.rss_pages.max(0) as u64 * page_size(),
        read_bytes: io.get("read_bytes").copied().unwrap_or(0),
        write_bytes: io.get("write_bytes").copied().unwrap_or(0),
        fd_count: fs::read_dir(format!("/proc/{}/fd", process.pid))
            .map(|entries| entries.take(MAX_FDS).count() as u64)
            .unwrap_or(0),
    }
}

pub fn inspect_process(pid: i32, expected_start: Option<u64>) -> Result<ProcessDetails, String> {
    let initial = read_basic(pid)?;
    if let Some(expected) = expected_start {
        if initial.start_time_ticks != expected {
            return Err("PID identity changed before detail capture".into());
        }
    }
    let proc_dir = PathBuf::from(format!("/proc/{pid}"));
    let mut errors = Vec::new();
    let command_line = capture_or(&mut errors, "cmdline", || read_cmdline(pid), Vec::new());
    let status = capture_or(&mut errors, "status", || read_status(pid), BTreeMap::new());
    let io = capture_or(&mut errors, "io", || read_io(pid), BTreeMap::new());
    let file_descriptors = capture_or(
        &mut errors,
        "file descriptors",
        || read_file_descriptors(pid),
        Vec::new(),
    );
    let socket_inodes = file_descriptors
        .iter()
        .filter_map(|fd| socket_inode(&fd.target))
        .collect::<HashSet<_>>();
    let sockets = capture_or(
        &mut errors,
        "sockets",
        || read_sockets(pid, &socket_inodes),
        Vec::new(),
    );
    let final_identity = read_basic(pid)?;
    if initial.start_time_ticks != final_identity.start_time_ticks {
        return Err("PID identity changed during detail capture".into());
    }

    Ok(ProcessDetails {
        key: initial.key(&boot_id()),
        captured_at: Utc::now().to_rfc3339(),
        ppid: initial.ppid,
        comm: initial.comm,
        state: initial.state,
        command_line,
        executable: read_link_string(proc_dir.join("exe")),
        executable_sha256: capture_optional(&mut errors, "executable hash", || {
            hash_file(&proc_dir.join("exe"))
        }),
        cwd: read_link_string(proc_dir.join("cwd")),
        root: read_link_string(proc_dir.join("root")),
        environment: capture_or(
            &mut errors,
            "environment",
            || read_nul_list(&proc_dir.join("environ"), 2 * 1024 * 1024),
            Vec::new(),
        ),
        status,
        cgroup: capture_or(
            &mut errors,
            "cgroup",
            || read_text_bounded(&proc_dir.join("cgroup"), MAX_TEXT_BYTES),
            String::new(),
        ),
        limits: capture_or(
            &mut errors,
            "limits",
            || read_text_bounded(&proc_dir.join("limits"), MAX_TEXT_BYTES),
            String::new(),
        ),
        maps: capture_or(
            &mut errors,
            "maps",
            || read_text_bounded(&proc_dir.join("maps"), MAX_TEXT_BYTES),
            String::new(),
        ),
        io,
        namespaces: capture_or(
            &mut errors,
            "namespaces",
            || read_namespaces(pid),
            Vec::new(),
        ),
        file_descriptors,
        sockets,
        collection_errors: errors,
    })
}

pub fn system_overview() -> SystemOverview {
    let (load_one, load_five, load_fifteen) = fs::read_to_string("/proc/loadavg")
        .ok()
        .map(|value| {
            let mut fields = value.split_whitespace();
            (
                fields.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
                fields.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
                fields.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0, 0.0));
    let meminfo = read_key_values("/proc/meminfo", ':');
    SystemOverview {
        process_count: scan_processes().len(),
        load_one,
        load_five,
        load_fifteen,
        memory_total_bytes: meminfo_kib(&meminfo, "MemTotal"),
        memory_available_bytes: meminfo_kib(&meminfo, "MemAvailable"),
        boot_id: boot_id(),
    }
}

pub fn passwd_map() -> HashMap<u32, String> {
    let mut users = HashMap::new();
    if let Ok(content) = fs::read_to_string("/etc/passwd") {
        for line in content.lines() {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() > 2 {
                if let Ok(uid) = fields[2].parse::<u32>() {
                    users.entry(uid).or_insert_with(|| fields[0].to_string());
                }
            }
        }
    }
    users
}

fn read_cmdline(pid: i32) -> io::Result<Vec<String>> {
    read_nul_list(Path::new(&format!("/proc/{pid}/cmdline")), MAX_TEXT_BYTES)
}

fn read_nul_list(path: &Path, limit: usize) -> io::Result<Vec<String>> {
    let bytes = read_bytes_bounded(path, limit)?;
    Ok(bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect())
}

fn display_command(arguments: &[String], fallback: &str) -> String {
    if arguments.is_empty() {
        fallback.to_string()
    } else {
        arguments.join(" ")
    }
}

fn read_status(pid: i32) -> io::Result<BTreeMap<String, String>> {
    let text = read_text_bounded(Path::new(&format!("/proc/{pid}/status")), MAX_TEXT_BYTES)?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect())
}

fn read_io(pid: i32) -> io::Result<BTreeMap<String, u64>> {
    let text = read_text_bounded(Path::new(&format!("/proc/{pid}/io")), MAX_TEXT_BYTES)?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.to_string(), value.trim().parse::<u64>().ok()?))
        })
        .collect())
}

fn read_file_descriptors(pid: i32) -> io::Result<Vec<FileDescriptor>> {
    let fd_dir = PathBuf::from(format!("/proc/{pid}/fd"));
    let mut descriptors = Vec::new();
    for entry in fs::read_dir(&fd_dir)?.take(MAX_FDS).flatten() {
        let Ok(fd) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let target = fs::read_link(entry.path())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|error| format!("<unavailable: {error}>"));
        let fdinfo = fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}")).unwrap_or_default();
        let values = parse_colon_map(&fdinfo);
        descriptors.push(FileDescriptor {
            fd,
            target,
            flags: values.get("flags").cloned(),
            position: values.get("pos").and_then(|value| value.parse().ok()),
        });
    }
    descriptors.sort_by_key(|entry| entry.fd);
    Ok(descriptors)
}

fn read_namespaces(pid: i32) -> io::Result<Vec<NamespaceEntry>> {
    let directory = PathBuf::from(format!("/proc/{pid}/ns"));
    let mut namespaces = Vec::new();
    for entry in fs::read_dir(directory)?.flatten() {
        if let Ok(identifier) = fs::read_link(entry.path()) {
            namespaces.push(NamespaceEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                identifier: identifier.to_string_lossy().into_owned(),
            });
        }
    }
    namespaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(namespaces)
}

fn read_sockets(pid: i32, wanted: &HashSet<String>) -> io::Result<Vec<SocketEntry>> {
    let mut sockets = Vec::new();
    for (name, protocol, ipv6) in [
        ("tcp", "TCP", false),
        ("tcp6", "TCP6", true),
        ("udp", "UDP", false),
        ("udp6", "UDP6", true),
    ] {
        let path = PathBuf::from(format!("/proc/{pid}/net/{name}"));
        if let Ok(text) = fs::read_to_string(path) {
            parse_inet_sockets(&text, protocol, ipv6, wanted, &mut sockets);
        }
    }
    let unix_path = PathBuf::from(format!("/proc/{pid}/net/unix"));
    if let Ok(text) = fs::read_to_string(unix_path) {
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 7 {
                continue;
            }
            let inode = fields[6].to_string();
            if wanted.contains(&inode) {
                sockets.push(SocketEntry {
                    inode,
                    protocol: "UNIX".into(),
                    local_address: fields.get(7).copied().unwrap_or("unnamed").into(),
                    remote_address: "—".into(),
                    state: fields[5].into(),
                    path: fields.get(7).map(|value| (*value).to_string()),
                });
            }
        }
    }
    sockets.sort_by(|a, b| a.protocol.cmp(&b.protocol).then(a.inode.cmp(&b.inode)));
    Ok(sockets)
}

fn parse_inet_sockets(
    text: &str,
    protocol: &str,
    ipv6: bool,
    wanted: &HashSet<String>,
    output: &mut Vec<SocketEntry>,
) {
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        let inode = fields[9].to_string();
        if !wanted.contains(&inode) {
            continue;
        }
        output.push(SocketEntry {
            inode,
            protocol: protocol.into(),
            local_address: decode_socket_address(fields[1], ipv6),
            remote_address: decode_socket_address(fields[2], ipv6),
            state: socket_state(fields[3]).into(),
            path: None,
        });
    }
}

fn decode_socket_address(value: &str, ipv6: bool) -> String {
    let Some((address, port)) = value.split_once(':') else {
        return value.into();
    };
    let port = u16::from_str_radix(port, 16).unwrap_or(0);
    if !ipv6 {
        let parsed = u32::from_str_radix(address, 16).unwrap_or(0);
        return format!("{}:{port}", Ipv4Addr::from(parsed.to_le_bytes()));
    }
    if address.len() != 32 {
        return value.into();
    }
    let mut bytes = [0u8; 16];
    for index in 0..4 {
        let chunk = &address[index * 8..index * 8 + 8];
        let parsed = u32::from_str_radix(chunk, 16).unwrap_or(0);
        bytes[index * 4..index * 4 + 4].copy_from_slice(&parsed.to_le_bytes());
    }
    format!("[{}]:{port}", Ipv6Addr::from(bytes))
}

fn socket_state(value: &str) -> &'static str {
    match value {
        "01" => "ESTABLISHED",
        "02" => "SYN_SENT",
        "03" => "SYN_RECV",
        "04" => "FIN_WAIT1",
        "05" => "FIN_WAIT2",
        "06" => "TIME_WAIT",
        "07" => "CLOSE",
        "08" => "CLOSE_WAIT",
        "09" => "LAST_ACK",
        "0A" => "LISTEN",
        "0B" => "CLOSING",
        _ => "UNKNOWN",
    }
}

fn socket_inode(target: &str) -> Option<String> {
    target
        .strip_prefix("socket:[")
        .and_then(|value| value.strip_suffix(']'))
        .map(str::to_string)
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() > MAX_EXECUTABLE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "executable exceeds hash limit",
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_EXECUTABLE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "executable exceeds hash limit",
            ));
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn read_text_bounded(path: &Path, limit: usize) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&read_bytes_bounded(path, limit)?).into_owned())
}

fn read_bytes_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut output = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut output)?;
    if output.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "read limit exceeded",
        ));
    }
    Ok(output)
}

fn read_link_string(path: PathBuf) -> Option<String> {
    fs::read_link(path)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

fn first_number(value: Option<&String>) -> Option<u32> {
    value?.split_whitespace().next()?.parse().ok()
}

fn parse_colon_map(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().into(), value.trim().into()))
        })
        .collect()
}

fn read_key_values(path: &str, separator: char) -> BTreeMap<String, String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(separator)?;
            Some((key.trim().into(), value.trim().into()))
        })
        .collect()
}

fn meminfo_kib(values: &BTreeMap<String, String>, key: &str) -> u64 {
    values
        .get(key)
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        * 1024
}

fn capture_or<T, F>(errors: &mut Vec<String>, name: &str, operation: F, fallback: T) -> T
where
    F: FnOnce() -> io::Result<T>,
{
    match operation() {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("{name}: {error}"));
            fallback
        }
    }
}

fn capture_optional<T, F>(errors: &mut Vec<String>, name: &str, operation: F) -> Option<T>
where
    F: FnOnce() -> io::Result<T>,
{
    match operation() {
        Ok(value) => Some(value),
        Err(error) => {
            errors.push(format!("{name}: {error}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stat_with_parenthesis_in_comm() {
        let fields = ["S", "7"]
            .into_iter()
            .chain(std::iter::repeat("0").take(17))
            .chain(["1234", "4096", "2"])
            .collect::<Vec<_>>()
            .join(" ");
        let parsed = parse_stat(&format!("42 (odd ) process) {fields}")).unwrap();
        assert_eq!(parsed.pid, 42);
        assert_eq!(parsed.ppid, 7);
        assert_eq!(parsed.comm, "odd ) process");
        assert_eq!(parsed.start_time_ticks, 1234);
        assert_eq!(parsed.virtual_bytes, 4096);
        assert_eq!(parsed.rss_pages, 2);
    }

    #[test]
    fn decodes_ipv4_socket_address() {
        assert_eq!(
            decode_socket_address("0100007F:1F90", false),
            "127.0.0.1:8080"
        );
    }
}
