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

export interface ProcessNode extends ProcessListItem {
  parentKey?: string;
  alive: boolean;
  isFocus: boolean;
  isAncestor: boolean;
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
}

export type TrackingMessage =
  | { type: "snapshot"; payload: GraphSnapshot }
  | { type: "event"; payload: LifecycleEvent };

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
  cwd?: string;
  root?: string;
  environment: string[];
  status: Record<string, string>;
  cgroup: string;
  limits: string;
  maps: string;
  io: Record<string, number>;
  namespaces: { name: string; identifier: string }[];
  fileDescriptors: FileDescriptor[];
  sockets: SocketEntry[];
  collectionErrors: string[];
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
