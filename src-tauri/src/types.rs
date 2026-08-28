use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKey {
    pub id: String,
    pub pid: i32,
    pub start_time_ticks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    pub key: ProcessKey,
    pub comm: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub identity_guard: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub relation: String,
    pub observed_at: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    #[serde(default = "default_event_source")]
    pub source: String,
    #[serde(default = "default_event_confidence")]
    pub confidence: String,
}

fn default_event_source() -> String {
    "procfs-diff".into()
}

fn default_event_confidence() -> String {
    "inferred".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TrackingMessage {
    Snapshot(GraphSnapshot),
    Event(LifecycleEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub session_id: String,
    pub file_name: String,
    pub started_at: String,
    pub active: bool,
    pub snapshot_count: u64,
    pub event_count: u64,
    pub byte_count: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedCapture {
    pub info: RecordingInfo,
    pub snapshots: Vec<GraphSnapshot>,
    pub lifecycle_events: Vec<LifecycleEvent>,
    pub inspections: Vec<InspectionCapture>,
    pub control_actions: Vec<ControlAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    pub fd: i32,
    pub target: String,
    pub flags: Option<String>,
    pub position: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceEntry {
    pub name: String,
    pub identifier: String,
    pub differs_from_observer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketEntry {
    pub inode: String,
    pub protocol: String,
    pub local_address: String,
    pub remote_address: String,
    pub state: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableMetadata {
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub executable_metadata: Option<ExecutableMetadata>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionCapture {
    pub id: String,
    pub timestamp: String,
    pub process: ProcessDetails,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlAction {
    pub id: String,
    pub timestamp: String,
    pub action: String,
    pub outcome: String,
    pub reason: String,
    pub cgroup_path: Option<String>,
    pub affected_processes: Vec<ProcessKey>,
    pub verification: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseAnnotation {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub kind: String,
    pub body: String,
    pub event_id: Option<String>,
    pub process_key: Option<String>,
    pub snapshot_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseMetadata {
    pub schema: String,
    pub session_id: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub annotations: Vec<CaseAnnotation>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub file_name: String,
    pub started_at: String,
    pub updated_at: String,
    pub byte_count: u64,
    pub snapshot_count: u64,
    pub event_count: u64,
    pub inspection_count: usize,
    pub control_action_count: usize,
    pub target: Option<SessionTarget>,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub integrity_sha256: String,
    pub partial_tail_ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorCapability {
    pub id: String,
    pub label: String,
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorProfile {
    pub active_source: String,
    pub lifecycle_precision: String,
    pub sample_interval_ms: u64,
    pub capabilities: Vec<CollectorCapability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGate {
    pub id: String,
    pub label: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainmentStatus {
    pub supported: bool,
    pub available: bool,
    pub frozen: bool,
    pub cgroup_path: Option<String>,
    pub reason: String,
    pub gates: Vec<CapabilityGate>,
    pub members: Vec<ProcessKey>,
    pub network_restriction_available: bool,
    pub network_reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainmentOutcome {
    pub status: ContainmentStatus,
    pub action: ControlAction,
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
