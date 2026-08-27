use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKey {
    pub id: String,
    pub pid: i32,
    pub start_time_ticks: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListItem {
    pub key: ProcessKey,
    pub ppid: i32,
    pub comm: String,
    pub command: String,
    pub executable: Option<String>,
    pub uid: Option<u32>,
    pub user: Option<String>,
    pub state: String,
    pub rss_bytes: u64,
    pub threads: u64,
    pub age_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNode {
    pub key: ProcessKey,
    pub ppid: i32,
    pub parent_key: Option<String>,
    pub comm: String,
    pub command: String,
    pub executable: Option<String>,
    pub uid: Option<u32>,
    pub user: Option<String>,
    pub state: String,
    pub alive: bool,
    pub is_focus: bool,
    pub is_ancestor: bool,
    pub discovered_at: String,
    pub exited_at: Option<String>,
    pub age_seconds: f64,
    pub cpu_percent: f64,
    pub rss_bytes: u64,
    pub virtual_bytes: u64,
    pub read_bytes: u64,
    pub write_bytes: u64,
    pub threads: u64,
    pub fd_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub relation: String,
    pub observed_at: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub timestamp: String,
    pub root_key: String,
    pub root_alive: bool,
    pub alive_count: usize,
    pub exited_count: usize,
    pub nodes: Vec<ProcessNode>,
    pub edges: Vec<GraphEdge>,
    pub missed_event_warning: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEvent {
    pub id: String,
    pub timestamp: String,
    pub kind: String,
    pub severity: String,
    pub process_key: String,
    pub pid: i32,
    pub comm: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TrackingMessage {
    Snapshot(GraphSnapshot),
    Event(LifecycleEvent),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    pub fd: i32,
    pub target: String,
    pub flags: Option<String>,
    pub position: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceEntry {
    pub name: String,
    pub identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketEntry {
    pub inode: String,
    pub protocol: String,
    pub local_address: String,
    pub remote_address: String,
    pub state: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetails {
    pub key: ProcessKey,
    pub captured_at: String,
    pub ppid: i32,
    pub comm: String,
    pub state: String,
    pub command_line: Vec<String>,
    pub executable: Option<String>,
    pub executable_sha256: Option<String>,
    pub cwd: Option<String>,
    pub root: Option<String>,
    pub environment: Vec<String>,
    pub status: BTreeMap<String, String>,
    pub cgroup: String,
    pub limits: String,
    pub maps: String,
    pub io: BTreeMap<String, u64>,
    pub namespaces: Vec<NamespaceEntry>,
    pub file_descriptors: Vec<FileDescriptor>,
    pub sockets: Vec<SocketEntry>,
    pub collection_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub process_count: usize,
    pub load_one: f64,
    pub load_five: f64,
    pub load_fifteen: f64,
    pub memory_total_bytes: u64,
    pub memory_available_bytes: u64,
    pub boot_id: String,
}
