export interface ProcessKey {
  id: string;
  pid: number;
  startTimeTicks: number;
}

export interface ProcessListItem {
  key: ProcessKey;
  ppid: number;
  comm: string;
  command: string;
  executable?: string;
  uid?: number;
  user?: string;
  state: string;
  rssBytes: number;
  threads: number;
  ageSeconds: number;
}

export interface SessionTarget {
  key: ProcessKey;
  comm: string;
  command: string;
}

export interface ProcessNode extends ProcessListItem {
  parentKey?: string;
  alive: boolean;
  isFocus: boolean;
  isAncestor: boolean;
  identityGuard: string;
  discoveredAt: string;
  exitedAt?: string;
  cpuPercent: number;
  virtualBytes: number;
  readBytes: number;
  writeBytes: number;
  fdCount: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  observedAt: string;
  current: boolean;
}

export interface GraphSnapshot {
  sessionId: string;
  sequence: number;
  timestamp: string;
  rootKey: string;
  rootAlive: boolean;
  aliveCount: number;
  exitedCount: number;
  nodes: ProcessNode[];
  edges: GraphEdge[];
  missedEventWarning: boolean;
}

export interface LifecycleEvent {
  id: string;
  timestamp: string;
  kind: "attached" | "spawn" | "exec" | "exit" | "detached" | string;
  severity: "info" | "change" | "warning" | "error" | string;
  processKey: string;
  pid: number;
  comm: string;
  message: string;
  source?: string;
  confidence?: string;
}

export type TrackingMessage =
  | { type: "snapshot"; payload: GraphSnapshot }
  | { type: "event"; payload: LifecycleEvent };

export interface RecordingInfo {
  sessionId: string;
  fileName: string;
  startedAt: string;
  active: boolean;
  snapshotCount: number;
  eventCount: number;
  byteCount: number;
  error?: string;
}

export interface RecordedCapture {
  info: RecordingInfo;
  snapshots: GraphSnapshot[];
  lifecycleEvents: LifecycleEvent[];
  inspections: InspectionCapture[];
  controlActions: ControlAction[];
}

export interface FileDescriptor {
  fd: number;
  target: string;
  flags?: string;
  position?: number;
}

export interface SocketEntry {
  inode: string;
  protocol: string;
  localAddress: string;
  remoteAddress: string;
  state: string;
  path?: string;
}

export interface ProcessDetails {
  key: ProcessKey;
  capturedAt: string;
  ppid: number;
  comm: string;
  state: string;
  commandLine: string[];
  executable?: string;
  executableSha256?: string;
  executableMetadata?: {
    sizeBytes: number;
    modifiedAt?: string;
    device: number;
    inode: number;
    mode: number;
    uid: number;
    gid: number;
    deleted: boolean;
  };
  cwd?: string;
  root?: string;
  environment: string[];
  status: Record<string, string>;
  cgroup: string;
  limits: string;
  maps: string;
  io: Record<string, number>;
  namespaces: { name: string; identifier: string; differsFromObserver: boolean }[];
  fileDescriptors: FileDescriptor[];
  sockets: SocketEntry[];
  collectionErrors: string[];
}

export interface InspectionCapture {
  id: string;
  timestamp: string;
  process: ProcessDetails;
}

export interface ControlAction {
  id: string;
  timestamp: string;
  action: string;
  outcome: string;
  reason: string;
  cgroupPath?: string;
  affectedProcesses: ProcessKey[];
  verification: string;
}

export interface CaseAnnotation {
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: "note" | "bookmark";
  body: string;
  eventId?: string;
  processKey?: string;
  snapshotSequence?: number;
}

export interface CaseMetadata {
  schema: string;
  sessionId: string;
  title: string;
  summary: string;
  tags: string[];
  annotations: CaseAnnotation[];
  updatedAt: string;
}

export interface SessionSummary {
  sessionId: string;
  fileName: string;
  startedAt: string;
  updatedAt: string;
  byteCount: number;
  snapshotCount: number;
  eventCount: number;
  inspectionCount: number;
  controlActionCount: number;
  target?: SessionTarget;
  title?: string;
  tags: string[];
  integritySha256: string;
  partialTailIgnored: boolean;
}

export interface CollectorCapability {
  id: string;
  label: string;
  state: string;
  detail: string;
}

export interface CollectorProfile {
  activeSource: string;
  lifecyclePrecision: string;
  sampleIntervalMs: number;
  capabilities: CollectorCapability[];
}

export interface CapabilityGate {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ContainmentStatus {
  supported: boolean;
  available: boolean;
  frozen: boolean;
  cgroupPath?: string;
  reason: string;
  gates: CapabilityGate[];
  members: ProcessKey[];
  networkRestrictionAvailable: boolean;
  networkReason: string;
}

export interface ContainmentOutcome {
  status: ContainmentStatus;
  action: ControlAction;
}

export interface SystemOverview {
  processCount: number;
  loadOne: number;
  loadFive: number;
  loadFifteen: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  bootId: string;
}

export interface MetricPoint {
  timestamp: number;
  cpu: number;
  rss: number;
  read: number;
  write: number;
}
