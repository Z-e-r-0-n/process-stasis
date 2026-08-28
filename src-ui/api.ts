import { Channel, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type {
  CaseMetadata,
  CollectorProfile,
  ContainmentOutcome,
  ContainmentStatus,
  GraphSnapshot,
  InspectionCapture,
  LifecycleEvent,
  ProcessDetails,
  ProcessListItem,
  ProcessNode,
  RecordedCapture,
  RecordingInfo,
  SessionSummary,
  SystemOverview,
  TrackingMessage,
} from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;
const MOCK_START = Date.now();
const mockRecordings = new Map<string, RecordingInfo>();
const mockCaptures = new Map<string, RecordedCapture>();
const mockCases = new Map<string, CaseMetadata>();
const mockContainment = new Map<string, ContainmentStatus>();
const mockTrackingSessions = new Map<string, {
  focusKey: string;
  latest?: GraphSnapshot;
  deliver: (message: TrackingMessage) => void;
}>();

export async function listProcesses(query = "", limit = 250): Promise<ProcessListItem[]> {
  if (isTauri()) return invoke("list_processes", { query, limit });
  return mockProcesses().filter((item) => `${item.key.pid} ${item.comm} ${item.command}`.toLowerCase().includes(query.toLowerCase()));
}

export async function systemOverview(): Promise<SystemOverview> {
  if (isTauri()) return invoke("get_system_overview");
  return {
    processCount: 284,
    loadOne: 0.84,
    loadFive: 0.69,
    loadFifteen: 0.55,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryAvailableBytes: 19.4 * 1024 ** 3,
    bootId: "browser-preview",
  };
}

export async function launchUnderStasis(command: string): Promise<ProcessListItem> {
  if (isTauri()) return invoke("launch_under_stasis", { command });
  const template = mockProcesses()[0];
  return { ...template, key: { ...template.key, id: `preview-launch:${crypto.randomUUID()}` }, command, comm: command.split(/\s+/).at(-1) || "managed-command" };
}

export async function getProcessDetails(pid: number, startTimeTicks?: number): Promise<ProcessDetails> {
  if (isTauri()) return invoke("get_process_details", { pid, startTimeTicks });
  const item = mockProcesses().find((entry) => entry.key.pid === pid) ?? mockProcesses()[0];
  return mockDetails(item);
}

export async function startTracking(
  pid: number,
  startTimeTicks: number,
  onMessage: (message: TrackingMessage) => void,
): Promise<{ sessionId: string; stop: () => Promise<void> }> {
  if (isTauri()) {
    const channel = new Channel<TrackingMessage>();
    channel.onmessage = onMessage;
    const sessionId = await invoke<string>("start_tracking", { pid, startTimeTicks, onEvent: channel });
    return {
      sessionId,
      stop: async () => {
        await invoke("stop_tracking", { sessionId });
      },
    };
  }
  return startMockTracking(pid, onMessage);
}

export async function promoteTrackingFocus(sessionId: string, processKey: string): Promise<GraphSnapshot> {
  if (isTauri()) return invoke("promote_tracking_focus", { sessionId, processKey });
  const session = mockTrackingSessions.get(sessionId);
  const snapshot = session?.latest;
  if (!session || !snapshot) throw new Error("tracking has not produced a snapshot yet");
  if (snapshot.rootAlive) throw new Error("focus can be transferred after the current focus exits");
  const candidate = snapshot.nodes.find((node) => node.key.id === processKey);
  if (!candidate?.alive) throw new Error("the selected survivor is no longer running");
  if (!isSnapshotDescendant(snapshot, processKey, snapshot.rootKey)) {
    throw new Error("the selected process is not a descendant of the current focus");
  }
  const previous = snapshot.nodes.find((node) => node.key.id === snapshot.rootKey)!;
  session.focusKey = processKey;
  const promoted = applyMockSnapshotFocus(snapshot, processKey);
  session.latest = promoted;
  session.deliver({
    type: "event",
    payload: {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(), kind: "focus-changed", severity: "info",
      processKey: candidate.key.id, pid: candidate.key.pid, comm: candidate.comm,
      message: `Focus moved from ${previous.comm} (PID ${previous.key.pid}) to ${candidate.comm} (PID ${candidate.key.pid})`,
      source: "observer", confidence: "exact",
    },
  });
  return promoted;
}

export async function chooseExportPath(defaultName: string, extension = "json"): Promise<string | null> {
  if (!isTauri()) return defaultName;
  return save({
    defaultPath: defaultName,
    filters: [{ name: "Process Stasis evidence", extensions: [extension] }],
  });
}

export async function writeExport(path: string, content: string): Promise<void> {
  if (isTauri()) {
    await invoke("write_export", { path, content });
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  anchor.download = path;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export async function startSessionRecording(sessionId: string): Promise<RecordingInfo> {
  if (isTauri()) return invoke("start_recording", { sessionId });
  const info = mockRecordings.get(sessionId) ?? {
    sessionId, fileName: `${sessionId}.jsonl`, startedAt: new Date().toISOString(),
    active: false, snapshotCount: 0, eventCount: 0, byteCount: 0,
  };
  const active = { ...info, active: true };
  mockRecordings.set(sessionId, active);
  if (!mockCaptures.has(sessionId)) {
    mockCaptures.set(sessionId, { info: active, snapshots: [], lifecycleEvents: [], inspections: [], controlActions: [] });
  } else {
    mockCaptures.get(sessionId)!.info = active;
  }
  return active;
}

export async function stopSessionRecording(sessionId: string): Promise<RecordingInfo> {
  if (isTauri()) return invoke("stop_recording", { sessionId });
  const info = mockRecordings.get(sessionId);
  if (!info) throw new Error("recording is not active");
  const stopped = { ...info, active: false };
  mockRecordings.set(sessionId, stopped);
  if (mockCaptures.has(sessionId)) mockCaptures.get(sessionId)!.info = stopped;
  return stopped;
}

export async function readSessionRecording(sessionId: string): Promise<RecordedCapture> {
  if (isTauri()) return invoke("read_recording", { sessionId });
  const info = mockRecordings.get(sessionId);
  if (!info) throw new Error("this session has not been recorded");
  return mockCaptures.get(sessionId) ?? { info, snapshots: [], lifecycleEvents: [], inspections: [], controlActions: [] };
}

export async function listSessionRecordings(): Promise<SessionSummary[]> {
  if (isTauri()) return invoke("list_recordings");
  return [...mockRecordings.values()].map((info) => {
    const capture = mockCaptures.get(info.sessionId);
    const first = capture?.snapshots[0];
    const target = first?.nodes.find((node) => node.key.id === first.rootKey);
    const metadata = mockCases.get(info.sessionId);
    return {
      sessionId: info.sessionId, fileName: info.fileName, startedAt: info.startedAt, updatedAt: new Date().toISOString(),
      byteCount: info.byteCount, snapshotCount: capture?.snapshots.length ?? 0, eventCount: capture?.lifecycleEvents.length ?? 0,
      inspectionCount: capture?.inspections.length ?? 0, controlActionCount: capture?.controlActions.length ?? 0,
      target: target ? { key: target.key, comm: target.comm, command: target.command } : undefined,
      title: metadata?.title || undefined, tags: metadata?.tags ?? [], integritySha256: "preview-journal-not-on-disk", partialTailIgnored: false,
    };
  });
}

export async function readCaseMetadata(sessionId: string): Promise<CaseMetadata> {
  if (isTauri()) return invoke("read_case_metadata", { sessionId });
  return mockCases.get(sessionId) ?? {
    schema: "process-stasis/case-metadata-v1", sessionId, title: "", summary: "", tags: [], annotations: [], updatedAt: new Date().toISOString(),
  };
}

export async function writeCaseMetadata(sessionId: string, metadata: CaseMetadata): Promise<CaseMetadata> {
  if (isTauri()) return invoke("write_case_metadata", { sessionId, metadata });
  const saved = { ...metadata, schema: "process-stasis/case-metadata-v1", sessionId, updatedAt: new Date().toISOString() };
  mockCases.set(sessionId, saved);
  return saved;
}

export async function captureInspection(sessionId: string, pid: number, startTimeTicks: number): Promise<InspectionCapture> {
  if (isTauri()) return invoke("capture_inspection", { sessionId, pid, startTimeTicks });
  const process = await getProcessDetails(pid, startTimeTicks);
  const capture = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), process };
  const recorded = mockCaptures.get(sessionId);
  if (!recorded?.info.active) throw new Error("start recording before preserving this evidence");
  recorded.inspections.push(capture);
  return capture;
}

export async function getCollectorProfile(): Promise<CollectorProfile> {
  if (isTauri()) return invoke("get_collector_profile");
  return {
    activeSource: "procfs-polling+pidfd", lifecyclePrecision: "inferred-except-pidfd-exit", sampleIntervalMs: 500,
    capabilities: [
      { id: "procfs", label: "Procfs sampling", state: "active", detail: "Browser preview simulates the 500 ms native sample stream." },
      { id: "pidfd", label: "Pidfd exit detection", state: "active-when-permitted", detail: "Native builds retain pidfds when permitted." },
      { id: "kernel-lifecycle", label: "Kernel lifecycle stream", state: "unavailable", detail: "No privileged kernel helper is installed." },
    ],
  };
}

export async function getContainmentStatus(sessionId: string): Promise<ContainmentStatus> {
  if (isTauri()) return invoke("get_containment_status", { sessionId });
  return mockContainment.get(sessionId) ?? {
    supported: true, available: true, managed: false, frozen: false,
    summary: "Ready to acquire the selected tree.", members: [],
  };
}

export async function setContainmentFrozen(sessionId: string, freeze: boolean): Promise<ContainmentOutcome> {
  if (isTauri()) return invoke("set_containment_frozen", { sessionId, freeze });
  const recording = mockRecordings.get(sessionId)?.active
    ? mockRecordings.get(sessionId)!
    : await startSessionRecording(sessionId);
  const members = mockProcesses().slice(0, 3).map((item) => item.key);
  const status: ContainmentStatus = {
    supported: true, available: true, managed: true, frozen: freeze,
    cgroupPath: `/process-stasis/${sessionId}`, members,
    summary: `${members.length} processes ${freeze ? "frozen" : "acquired and running"}`,
  };
  mockContainment.set(sessionId, status);
  const action = {
    id: crypto.randomUUID(), timestamp: new Date().toISOString(), action: freeze ? "freeze" : "thaw",
    outcome: "verified", reason: "desktop-control", cgroupPath: status.cgroupPath,
    affectedProcesses: members, verification: `kernel confirmed frozen=${freeze ? 1 : 0} for ${members.length} processes`,
  };
  mockCaptures.get(sessionId)?.controlActions.push(action);
  return { status, action, recording };
}

function mockProcesses(): ProcessListItem[] {
  const base = MOCK_START;
  return [
    [18442, 1028, "python3", "python3 targets/process_tree_target.py --workers 3", 94 * 1024 ** 2, "zer0"],
    [1028, 1, "code", "/usr/share/code/code --unity-launch", 1.8 * 1024 ** 3, "zer0"],
    [19731, 18442, "worker-io", "python3 targets/process_tree_target.py --role io", 38 * 1024 ** 2, "zer0"],
    [19748, 18442, "worker-net", "python3 targets/process_tree_target.py --role net", 31 * 1024 ** 2, "zer0"],
    [1, 0, "systemd", "/sbin/init splash", 14 * 1024 ** 2, "root"],
  ].map(([pid, ppid, comm, command, rss, user], index) => ({
    key: { id: `preview:${pid}:${base - index * 99}`, pid: pid as number, startTimeTicks: base - index * 99 },
    ppid: ppid as number,
    comm: comm as string,
    command: command as string,
    executable: index === 4 ? "/usr/lib/systemd/systemd" : "/usr/bin/python3.13",
    uid: user === "root" ? 0 : 1000,
    user: user as string,
    state: index % 2 ? "S" : "R",
    rssBytes: rss as number,
    threads: index === 1 ? 42 : index + 1,
    ageSeconds: index === 4 ? 9822 : 440 + index * 91,
  }));
}

function startMockTracking(
  pid: number,
  onMessage: (message: TrackingMessage) => void,
): { sessionId: string; stop: () => Promise<void> } {
  const items = mockProcesses();
  const root = items.find((entry) => entry.key.pid === pid) ?? items[0];
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  const started = Date.now();
  const event = (kind: string, message: string, process = root): LifecycleEvent => ({
    id: crypto.randomUUID(), timestamp: new Date().toISOString(), kind, severity: kind === "exit" ? "warning" : "change",
    processKey: process.key.id, pid: process.key.pid, comm: process.comm, message,
    source: kind === "exit" ? "procfs+pidfd" : kind === "attached" ? "observer" : "procfs-diff",
    confidence: kind === "attached" ? "exact" : kind === "exit" ? "observed" : "inferred",
  });
  const deliver = (message: TrackingMessage) => {
    onMessage(message);
    const capture = mockCaptures.get(sessionId);
    if (!capture?.info.active) return;
    if (message.type === "event") capture.lifecycleEvents.push(message.payload);
    else if (message.payload.sequence % 4 === 0) capture.snapshots.push(message.payload);
    capture.info = {
      ...capture.info,
      snapshotCount: capture.snapshots.length,
      eventCount: capture.lifecycleEvents.length,
      byteCount: JSON.stringify(capture).length,
    };
    mockRecordings.set(sessionId, capture.info);
  };
  const tracking = { focusKey: root.key.id, latest: undefined as GraphSnapshot | undefined, deliver };
  mockTrackingSessions.set(sessionId, tracking);
  deliver({ type: "event", payload: event("attached", `Attached to ${root.comm} (${root.key.pid})`) });
  const timer = window.setInterval(() => {
    sequence += 1;
    const elapsed = (Date.now() - started) / 1000;
    const visible = sequence < 8 ? items.slice(0, 3) : items.slice(0, 4);
    const nodes: ProcessNode[] = visible.map((item, index) => ({
      ...item,
      parentKey: index === 0 ? items[1].key.id : index === 1 ? items[4].key.id : root.key.id,
      alive: !(sequence > 12 && index === 0) && !(sequence > 18 && index === 2),
      isFocus: item.key.id === tracking.focusKey,
      isAncestor: index === 1,
      identityGuard: "pidfd+start-time",
      discoveredAt: new Date(started + index * 3500).toISOString(),
      exitedAt: (sequence > 12 && index === 0) || (sequence > 18 && index === 2) ? new Date().toISOString() : undefined,
      cpuPercent: Math.max(0, 13 + Math.sin(elapsed * 1.6 + index) * 11 - index * 2),
      virtualBytes: item.rssBytes * 3.8,
      readBytes: elapsed * (index + 1) * 480_000,
      writeBytes: elapsed * (index + 1) * 130_000,
      fdCount: 9 + index * 7,
    }));
    if (sequence === 8) deliver({ type: "event", payload: event("spawn", "worker-net spawned PID 19748", items[3]) });
    if (sequence === 13) deliver({ type: "event", payload: event("exit", `${root.comm} (PID ${root.key.pid}) exited`, root) });
    if (sequence === 19) deliver({ type: "event", payload: event("exit", "worker-io (PID 19731) exited", items[2]) });
    let snapshot: GraphSnapshot = {
      sessionId, sequence, timestamp: new Date().toISOString(), rootKey: tracking.focusKey, rootAlive: true,
      aliveCount: nodes.filter((node) => node.alive).length, exitedCount: nodes.filter((node) => !node.alive).length,
      nodes,
      edges: nodes.filter((node) => node.parentKey).map((node) => ({
        id: `${node.parentKey}->${node.key.id}`, source: node.parentKey!, target: node.key.id,
        relation: "observed-parent", observedAt: node.discoveredAt, current: node.alive,
      })),
      missedEventWarning: true,
    };
    snapshot = applyMockSnapshotFocus(snapshot, tracking.focusKey);
    tracking.latest = snapshot;
    deliver({ type: "snapshot", payload: snapshot });
  }, 500);
  return { sessionId, stop: async () => { window.clearInterval(timer); mockTrackingSessions.delete(sessionId); } };
}

function isSnapshotDescendant(snapshot: GraphSnapshot, candidateKey: string, rootKey: string): boolean {
  const parents = new Map(snapshot.edges.map((edge) => [edge.target, edge.source]));
  const seen = new Set<string>();
  let cursor: string | undefined = candidateKey;
  while ((cursor = parents.get(cursor))) {
    if (cursor === rootKey) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
  }
  return false;
}

function applyMockSnapshotFocus(snapshot: GraphSnapshot, focusKey: string): GraphSnapshot {
  const parents = new Map(snapshot.edges.map((edge) => [edge.target, edge.source]));
  const ancestors = new Set<string>();
  let cursor = parents.get(focusKey);
  while (cursor && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = parents.get(cursor);
  }
  const nodes = snapshot.nodes.map((node) => ({
    ...node,
    isFocus: node.key.id === focusKey,
    isAncestor: ancestors.has(node.key.id),
  }));
  return {
    ...snapshot,
    rootKey: focusKey,
    rootAlive: nodes.find((node) => node.key.id === focusKey)?.alive ?? false,
    nodes,
  };
}

function mockDetails(item: ProcessListItem): ProcessDetails {
  return {
    key: item.key, capturedAt: new Date().toISOString(), ppid: item.ppid, comm: item.comm, state: item.state,
    commandLine: item.command.split(" "), executable: item.executable,
    executableSha256: "d786ac2b58ed7a99f40b45a9d40fc7df45d447f7b0983481c8e4ceea65b98b36",
    executableMetadata: { sizeBytes: 6839896, modifiedAt: "2026-05-12T08:30:00Z", device: 259, inode: 918273, mode: 33261, uid: 0, gid: 0, deleted: false },
    cwd: "/home/zer0/Codex/projects/process-stasis", root: "/",
    environment: ["PATH=/usr/local/bin:/usr/bin", "HOME=/home/zer0", "API_TOKEN=redacted-in-preview"],
    status: { Name: item.comm, State: "S (sleeping)", Uid: "1000 1000 1000 1000", Threads: String(item.threads), Seccomp: "2" },
    cgroup: "0::/user.slice/user-1000.slice/session-3.scope", limits: "Max open files  1024  524288  files",
    maps: "55d214ec0000-55d214ec1000 r--p /usr/bin/python3.13\n7fd8b1e00000-7fd8b1f00000 r-xp /usr/lib/libc.so.6",
    io: { rchar: 238414, wchar: 48111, read_bytes: 1835008, write_bytes: 524288 },
    namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "time", "user", "uts"].map((name, index) => ({ name, identifier: `${name}:[40265318${index}]`, differsFromObserver: name === "net" || name === "pid" })),
    fileDescriptors: [
      { fd: 0, target: "/dev/pts/4", flags: "0100002", position: 0 },
      { fd: 3, target: "/tmp/stasis-target/events.log", flags: "0102001", position: 4481 },
      { fd: 7, target: "socket:[294491]", flags: "02004002", position: 0 },
    ],
    sockets: [{ inode: "294491", protocol: "TCP", localAddress: "127.0.0.1:41228", remoteAddress: "127.0.0.1:8080", state: "ESTABLISHED" }],
    collectionErrors: [],
  };
}
