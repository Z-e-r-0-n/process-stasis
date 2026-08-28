import {
  Archive, CircleNotch, DownloadSimple, FloppyDisk, MagnifyingGlass, Pause, Pulse,
  Record, ShieldChevron, Snowflake, TreeStructure,
} from "@phosphor-icons/react";
import { animate } from "animejs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  captureInspection, chooseExportPath, getCollectorProfile, getContainmentStatus, getProcessDetails,
  launchUnderStasis, listSessionRecordings, promoteTrackingFocus, readCaseMetadata, readSessionRecording, setContainmentFrozen,
  startSessionRecording, startTracking, stopSessionRecording, writeCaseMetadata, writeExport,
} from "./api";
import { CaseWorkspace } from "./components/CaseWorkspace";
import { ContainmentPanel } from "./components/ContainmentPanel";
import { Inspector } from "./components/Inspector";
import { InvestigationTimeline } from "./components/InvestigationTimeline";
import { MetricChart } from "./components/MetricChart";
import { ProcessGraph, type GraphDepth, type GraphScope } from "./components/ProcessGraph";
import { ProcessPicker } from "./components/ProcessPicker";
import { formatBytes, formatTime } from "./format";
import type {
  CaseMetadata, CollectorProfile, ContainmentOutcome, ContainmentStatus, GraphSnapshot, LifecycleEvent,
  MetricPoint, ProcessDetails, ProcessListItem, ProcessNode, RecordedCapture, RecordingInfo,
  SessionSummary, TrackingMessage,
} from "./types";

type WorkspaceView = "lineage" | "telemetry" | "timeline" | "inspect" | "case" | "control";
interface HistoricalSession { summary: SessionSummary; capture: RecordedCapture; metadata: CaseMetadata }
const views: { id: WorkspaceView; label: string; icon: typeof TreeStructure }[] = [
  { id: "lineage", label: "Lineage", icon: TreeStructure }, { id: "telemetry", label: "Telemetry", icon: Pulse },
  { id: "timeline", label: "Timeline", icon: Archive }, { id: "inspect", label: "Inspect", icon: MagnifyingGlass },
  { id: "case", label: "Evidence", icon: FloppyDisk }, { id: "control", label: "Control", icon: Snowflake },
];

export default function App() {
  const [target, setTarget] = useState<ProcessListItem>();
  const [historical, setHistorical] = useState<HistoricalSession>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [opening, setOpening] = useState("");
  const refreshSessions = useCallback(() => listSessionRecordings().then(setSessions).catch(() => setSessions([])), []);
  useEffect(() => { refreshSessions(); }, [refreshSessions]);
  const openSession = async (summary: SessionSummary) => {
    setOpening(summary.sessionId);
    try {
      const [capture, metadata] = await Promise.all([readSessionRecording(summary.sessionId), readCaseMetadata(summary.sessionId)]);
      setHistorical({ summary, capture, metadata });
    } finally { setOpening(""); }
  };
  if (historical?.summary.target) {
    const stored = historical.summary.target;
    const historicalTarget: ProcessListItem = { key: stored.key, ppid: 0, comm: stored.comm, command: stored.command, state: "recorded", rssBytes: 0, threads: 0, ageSeconds: 0 };
    return <Workspace target={historicalTarget} historical={historical} onDetach={() => { setHistorical(undefined); refreshSessions(); }} />;
  }
  if (target) return <Workspace target={target} onDetach={() => { setTarget(undefined); refreshSessions(); }} />;
  return <ProcessPicker onSelect={setTarget} onLaunch={async (command) => setTarget(await launchUnderStasis(command))} sessions={sessions} openingSession={opening} onOpenSession={openSession} />;
}

function Workspace({ target, historical, onDetach }: { target: ProcessListItem; historical?: HistoricalSession; onDetach: () => void }) {
  const shell = useRef<HTMLDivElement>(null);
  const viewHost = useRef<HTMLElement>(null);
  const initialSnapshot = restoreRecordedFocus(historical?.capture.snapshots.at(-1), historical?.capture.lifecycleEvents);
  const selectedRef = useRef(initialSnapshot?.rootKey ?? target.key.id);
  const detailCache = useRef<Record<string, ProcessDetails>>(Object.fromEntries((historical?.capture.inspections ?? []).map((capture) => [capture.process.key.id, capture.process])));
  const [view, setView] = useState<WorkspaceView>(historical ? "timeline" : "lineage");
  const [sessionId, setSessionId] = useState(historical?.summary.sessionId ?? "");
  const [snapshot, setSnapshot] = useState<GraphSnapshot | undefined>(initialSnapshot);
  const [visibleSnapshot, setVisibleSnapshot] = useState<GraphSnapshot | undefined>(initialSnapshot);
  const [snapshots, setSnapshots] = useState<GraphSnapshot[]>(historical?.capture.snapshots ?? []);
  const [events, setEvents] = useState<LifecycleEvent[]>(historical ? [...historical.capture.lifecycleEvents].reverse() : []);
  const [selectedKey, setSelectedKey] = useState(initialSnapshot?.rootKey ?? target.key.id);
  const [details, setDetails] = useState<ProcessDetails | undefined>(detailCache.current[selectedRef.current]);
  const [detailError, setDetailError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [paused, setPaused] = useState(Boolean(historical));
  const [recording, setRecording] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingInfo, setRecordingInfo] = useState<RecordingInfo | undefined>(historical?.capture.info);
  const [recordedCapture, setRecordedCapture] = useState<RecordedCapture | undefined>(historical?.capture);
  const [recordedAt, setRecordedAt] = useState<string | undefined>(historical?.capture.info.startedAt);
  const [metricMode, setMetricMode] = useState<"cpu" | "memory" | "io">("cpu");
  const [metrics, setMetrics] = useState<Record<string, MetricPoint[]>>({});
  const [trackingError, setTrackingError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState("");
  const [graphScope, setGraphScope] = useState<GraphScope>("descendants");
  const [graphDepth, setGraphDepth] = useState<GraphDepth>(2);
  const [showExited, setShowExited] = useState(true);
  const [caseMetadata, setCaseMetadata] = useState<CaseMetadata>(historical?.metadata ?? emptyMetadata(""));
  const [profile, setProfile] = useState<CollectorProfile>();
  const [containment, setContainment] = useState<ContainmentStatus>();
  const [containmentBusy, setContainmentBusy] = useState(false);
  const [promotingFocus, setPromotingFocus] = useState(false);

  useEffect(() => {
    if (shell.current) animate(shell.current.querySelectorAll(".workspace-reveal"), { opacity: [0, 1], y: [8, 0], duration: 460, delay: (_el, index) => (index ?? 0) * 35, ease: "outExpo" });
  }, []);
  useEffect(() => { if (viewHost.current) animate(viewHost.current, { opacity: [0.35, 1], x: [9, 0], duration: 280, ease: "outCubic" }); }, [view]);
  useEffect(() => { getCollectorProfile().then(setProfile).catch(() => undefined); }, []);

  useEffect(() => {
    if (historical) return;
    let cancelled = false;
    let stop: (() => Promise<void>) | undefined;
    const receive = (message: TrackingMessage) => {
      if (message.type === "event") { setEvents((previous) => [message.payload, ...previous].slice(0, 10000)); return; }
      const next = message.payload;
      setSnapshot(next);
      if (next.sequence % 4 === 0) setSnapshots((previous) => [...previous, next].slice(-1800));
      const selected = next.nodes.find((node) => node.key.id === selectedRef.current) ?? next.nodes.find((node) => node.key.id === next.rootKey);
      if (selected) {
        const point: MetricPoint = { timestamp: new Date(next.timestamp).getTime() / 1000, cpu: selected.cpuPercent, rss: selected.rssBytes, read: selected.readBytes, write: selected.writeBytes };
        setMetrics((previous) => ({ ...previous, [selected.key.id]: [...(previous[selected.key.id] ?? []), point].slice(-1800) }));
      }
    };
    startTracking(target.key.pid, target.key.startTimeTicks, receive).then(async (session) => {
      if (cancelled) return session.stop();
      setSessionId(session.sessionId); stop = session.stop;
      try { setCaseMetadata(await readCaseMetadata(session.sessionId)); } catch { setCaseMetadata(emptyMetadata(session.sessionId)); }
    }).catch((reason) => setTrackingError(String(reason)));
    return () => { cancelled = true; stop?.(); };
  }, [target.key.id, historical]);

  useEffect(() => { if (!paused && snapshot) setVisibleSnapshot(snapshot); }, [snapshot, paused]);
  useEffect(() => { selectedRef.current = selectedKey; }, [selectedKey]);
  useEffect(() => { if (view === "control" && sessionId && !historical) refreshContainment(); }, [view, sessionId, snapshot?.sequence, historical]);
  const selectedProcess = useMemo(() => snapshot?.nodes.find((node) => node.key.id === selectedKey), [snapshot, selectedKey]);

  const loadDetails = useCallback(async () => {
    if (!selectedProcess) return;
    if (historical) {
      const retained = detailCache.current[selectedProcess.key.id]; setDetails(retained); setDetailError(retained ? "" : "No deep inspection was preserved for this process."); return;
    }
    if (!selectedProcess.alive) return;
    setDetailsLoading(true); setDetailError("");
    try {
      const captured = recording && sessionId ? (await captureInspection(sessionId, selectedProcess.key.pid, selectedProcess.key.startTimeTicks)).process : await getProcessDetails(selectedProcess.key.pid, selectedProcess.key.startTimeTicks);
      detailCache.current[selectedProcess.key.id] = captured; setDetails(captured);
    } catch (reason) { setDetailError(String(reason)); } finally { setDetailsLoading(false); }
  }, [selectedProcess?.key.id, selectedProcess?.alive, historical, recording, sessionId]);
  useEffect(() => { if (selectedProcess && !detailCache.current[selectedProcess.key.id]) loadDetails(); }, [selectedProcess?.key.id, loadDetails]);

  const chooseNode = (key: string, nextView?: WorkspaceView) => { setSelectedKey(key); selectedRef.current = key; setDetails(detailCache.current[key]); setDetailError(""); if (nextView) setView(nextView); };
  const toggleRecording = async () => {
    if (!sessionId || recordingBusy || historical) return;
    setRecordingBusy(true);
    try {
      const info = recording ? await stopSessionRecording(sessionId) : await startSessionRecording(sessionId);
      setRecordingInfo(info); setRecordedAt(info.startedAt); setRecording(info.active);
      if (!info.active) setRecordedCapture(await readSessionRecording(sessionId));
    } catch (reason) { setToast(`Recording failed: ${String(reason)}`); } finally { setRecordingBusy(false); }
  };
  const refreshContainment = async () => {
    if (!sessionId || historical) return;
    setContainmentBusy(true); try { setContainment(await getContainmentStatus(sessionId)); } catch (reason) { setToast(`Containment check failed: ${String(reason)}`); } finally { setContainmentBusy(false); }
  };
  const applyContainment = async (freeze: boolean): Promise<ContainmentOutcome | undefined> => {
    setContainmentBusy(true);
    try {
      const result = await setContainmentFrozen(sessionId, freeze);
      setContainment(result.status);
      setRecording(true);
      setRecordingInfo(result.recording);
      setRecordedAt(result.recording.startedAt);
      setToast(result.action.verification);
      return result;
    }
    finally { setContainmentBusy(false); }
  };
  const saveMetadata = async (metadata: CaseMetadata) => { if (sessionId) setCaseMetadata(await writeCaseMetadata(sessionId, metadata)); };
  const bookmark = async (event: LifecycleEvent) => {
    const exists = caseMetadata.annotations.some((item) => item.kind === "bookmark" && item.eventId === event.id);
    const timestamp = new Date().toISOString();
    const annotations = exists ? caseMetadata.annotations.filter((item) => item.eventId !== event.id) : [...caseMetadata.annotations, { id: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp, kind: "bookmark" as const, body: event.message, eventId: event.id, processKey: event.processKey }];
    try { await saveMetadata({ ...caseMetadata, annotations }); } catch (reason) { setToast(`Bookmark failed: ${String(reason)}`); }
  };
  const exportEvidence = async (format: "json" | "html" = "json", includeSensitive = false) => {
    setExporting(true);
    try {
      const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
      const extension = format === "html" ? "html" : "json";
      const activeTarget = snapshot?.nodes.find((node) => node.key.id === snapshot.rootKey) ?? target;
      const path = await chooseExportPath(`process-stasis-${activeTarget.key.pid}-${timestamp}.${extension}`, extension);
      if (!path) return;
      let capture = recordedCapture;
      if (!capture && recordedAt) capture = await readSessionRecording(sessionId);
      const payload = buildExport({ target: activeTarget, initialTarget: target, sessionId, snapshot, snapshots, events, details, capture, metadata: caseMetadata, profile, includeSensitive });
      await writeExport(path, format === "html" ? renderHtmlReport(payload) : JSON.stringify(payload, null, 2));
      setToast(`Evidence saved to ${path}`); window.setTimeout(() => setToast(""), 4800);
    } catch (reason) { setToast(`Export failed: ${String(reason)}`); } finally { setExporting(false); }
  };

  const root = snapshot?.nodes.find((node) => node.key.id === snapshot.rootKey);
  const historicalPoints = useMemo(() => snapshots.flatMap((item) => { const node = item.nodes.find((candidate) => candidate.key.id === selectedKey); return node ? [{ timestamp: new Date(item.timestamp).getTime() / 1000, cpu: node.cpuPercent, rss: node.rssBytes, read: node.readBytes, write: node.writeBytes }] : []; }), [snapshots, selectedKey]);
  const points = historical ? historicalPoints : metrics[selectedKey] ?? [];
  const latest = points.at(-1);
  const survivorKeys = useMemo(() => snapshotDescendantKeys(snapshot), [snapshot]);
  const survivors = snapshot?.nodes.filter((node) => node.alive && survivorKeys.has(node.key.id)) ?? [];
  const selectedSurvivor = selectedProcess && survivorKeys.has(selectedProcess.key.id) && selectedProcess.alive ? selectedProcess : undefined;
  const reviewSurvivor = () => survivors[0] && chooseNode(survivors[0].key.id, "lineage");
  const promoteFocus = async (key: string) => {
    if (!sessionId || historical || promotingFocus) return;
    setPromotingFocus(true);
    try {
      const promoted = await promoteTrackingFocus(sessionId, key);
      setSnapshot(promoted);
      setVisibleSnapshot(promoted);
      setPaused(false);
      setContainment(undefined);
      chooseNode(key, "lineage");
      const focus = promoted.nodes.find((node) => node.key.id === key);
      setToast(`${focus?.comm ?? "Survivor"} is now the focus process.`);
      window.setTimeout(() => setToast(""), 3600);
    } catch (reason) {
      setToast(`Focus transfer failed: ${String(reason)}`);
    } finally {
      setPromotingFocus(false);
    }
  };

  return <div className={`workspace ${historical ? "historical-workspace" : ""}`} ref={shell}>
    <header className="app-header workspace-reveal">
      <button className="brand-button" onClick={onDetach} title="Return to session launcher"><span className="brand-mark"><ShieldChevron weight="fill" /></span><span><strong>Process Stasis</strong><small>{historical ? "Recorded investigation" : "Live investigation"}</small></span></button>
      <nav className="workspace-nav" aria-label="Workspace views">{views.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-${id} ${view === id ? "active" : ""}`} onClick={() => setView(id)} disabled={historical && id === "control"}><Icon weight={view === id ? "fill" : "regular"} /><span>{label}</span></button>)}</nav>
      <div className="header-actions">{historical ? <span className="recorded-badge"><Archive /> Recorded</span> : <button className={`record-button ${recording ? "recording" : ""}`} onClick={toggleRecording} disabled={recordingBusy || !sessionId}>{recording ? <Pause weight="fill" /> : <Record weight="fill" />}{recordingBusy ? "Working…" : recording ? "Stop" : "Record"}</button>}<button className="export-button" onClick={() => exportEvidence("json", false)} disabled={exporting || !snapshot}>{exporting ? <CircleNotch className="spinning" /> : <DownloadSimple />} Export</button></div>
    </header>
    <section className="target-bar workspace-reveal"><div className="target-identity"><span className={`status-orb ${snapshot?.rootAlive === false ? "dead" : ""}`} /><strong>{root?.comm ?? target.comm}</strong><code>PID {root?.key.pid ?? target.key.pid}</code><span className="target-command" title={root?.command ?? target.command}>{root?.command ?? target.command}</span></div><div className="target-stats"><Stat label="CPU" value={`${(root?.cpuPercent ?? 0).toFixed(1)}%`} /><Stat label="Memory" value={formatBytes(root?.rssBytes ?? target.rssBytes)} /><Stat label="Observed" value={String(snapshot?.nodes.length ?? "—")} /></div></section>
    {trackingError && <div className="global-alert"><strong>Observer error</strong><span>{trackingError}</span><button onClick={onDetach}>Return to launcher</button></div>}
    {snapshot && !snapshot.rootAlive && <div className="root-exit-banner workspace-reveal"><span className="exit-dot" /><span><strong>Focus process exited.</strong> {historical ? "This recorded session is read-only." : survivors.length ? `${survivors.length} living descendant${survivors.length === 1 ? " is" : "s are"} available for focus transfer.` : "No known descendant is still running."}</span>{!historical && selectedSurvivor && <button disabled={promotingFocus} onClick={() => promoteFocus(selectedSurvivor.key.id)}>{promotingFocus ? "Moving focus…" : `Make ${selectedSurvivor.comm} focus`}</button>}{!historical && !selectedSurvivor && survivors.length > 0 && <button onClick={reviewSurvivor}>Select a survivor</button>}</div>}
    <main className={`workspace-main view-${view} workspace-reveal`} ref={viewHost}>
      {view === "lineage" && <ProcessGraph snapshot={visibleSnapshot} selectedKey={selectedKey} paused={paused} scope={graphScope} depth={graphDepth} showExited={showExited} promotingFocus={promotingFocus} canPromote={Boolean(snapshot && !snapshot.rootAlive && selectedSurvivor)} onPausedChange={setPaused} onScopeChange={setGraphScope} onDepthChange={setGraphDepth} onShowExitedChange={setShowExited} onSelect={chooseNode} onInspect={(key) => chooseNode(key, "inspect")} onPromote={promoteFocus} />}
      {view === "telemetry" && <div className="telemetry-view"><MetricChart points={points} mode={metricMode} onModeChange={setMetricMode} /><TelemetrySummary snapshot={snapshot} selected={selectedProcess} points={points} /></div>}
      {view === "timeline" && <InvestigationTimeline events={events} snapshots={snapshots} annotations={caseMetadata.annotations} currentSnapshot={visibleSnapshot} onSelectProcess={(key) => chooseNode(key, "inspect")} onSelectSnapshot={(next) => { setVisibleSnapshot(next); setPaused(true); }} onBookmark={bookmark} />}
      {view === "inspect" && <div className="inspect-view"><ProcessIndex nodes={snapshot?.nodes ?? []} selectedKey={selectedKey} onSelect={chooseNode} /><Inspector process={selectedProcess} details={details} loading={detailsLoading} error={detailError} onRefresh={loadDetails} /></div>}
      {view === "case" && <CaseWorkspace sessionId={sessionId} summary={historical?.summary} capture={recordedCapture} metadata={caseMetadata} recordingInfo={recordingInfo} profile={profile} liveSnapshotCount={snapshots.length} liveEventCount={events.length} onSaveMetadata={saveMetadata} onExport={exportEvidence} />}
      {view === "control" && !historical && <ContainmentPanel status={containment} busy={containmentBusy} onRefresh={refreshContainment} onApply={applyContainment} />}
    </main>
    <footer className="status-bar workspace-reveal"><span><i className={historical ? "recorded" : "connected"} /> {historical ? "Recorded journal" : "Connected"}</span><span>{profile?.activeSource ?? "Loading collector"}</span><span>Sequence {visibleSnapshot?.sequence ?? 0}</span><span className="status-spacer" /><span>{paused ? "View paused; collection state retained" : `Updated ${snapshot ? formatTime(snapshot.timestamp) : "—"}`}</span>{latest && <span>Selected {latest.cpu.toFixed(1)}% · {formatBytes(latest.rss)}</span>}<span>{profile?.lifecyclePrecision ?? "Lifecycle source pending"}</span></footer>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function ProcessIndex({ nodes, selectedKey, onSelect }: { nodes: ProcessNode[]; selectedKey: string; onSelect: (key: string) => void }) {
  const [query, setQuery] = useState(""); const visible = nodes.filter((node) => `${node.comm} ${node.command} ${node.key.pid}`.toLowerCase().includes(query.toLowerCase()));
  return <aside className="process-index"><header><div><span>Observed processes</span><b>{nodes.length}</b></div><small>Live and retained records</small></header><label><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a process" /></label><div className="process-index-list">{visible.map((node) => <button key={node.key.id} className={selectedKey === node.key.id ? "active" : ""} onClick={() => onSelect(node.key.id)}><span className={`life-indicator ${node.alive ? "alive" : "dead"}`} /><span><strong>{node.comm}</strong><small>PID {node.key.pid} · {node.isAncestor ? "ancestor" : node.isFocus ? "focus" : "descendant"}</small></span><b>{node.cpuPercent.toFixed(1)}%</b></button>)}</div></aside>;
}
function TelemetrySummary({ snapshot, selected, points }: { snapshot?: GraphSnapshot; selected?: ProcessNode; points: MetricPoint[] }) {
  const peakCpu = Math.max(0, ...points.map((point) => point.cpu)); const peakRss = Math.max(0, ...points.map((point) => point.rss));
  return <aside className="telemetry-summary"><header><Pulse /><div><h2>Selected process</h2><p>{selected ? `${selected.comm} · PID ${selected.key.pid}` : "Waiting for a process"}</p></div></header><div className="telemetry-kpis"><Stat label="Peak CPU" value={`${peakCpu.toFixed(1)}%`} /><Stat label="Peak RSS" value={formatBytes(peakRss)} /><Stat label="Read total" value={formatBytes(points.at(-1)?.read ?? 0)} /><Stat label="Write total" value={formatBytes(points.at(-1)?.write ?? 0)} /></div><div className="scope-summary"><span>Current scope</span><strong>{snapshot?.aliveCount ?? 0} live · {snapshot?.exitedCount ?? 0} retained</strong><p>Charts reflect the selected process only. The lineage view remains scoped independently.</p></div></aside>;
}
function emptyMetadata(sessionId: string): CaseMetadata { return { schema: "process-stasis/case-metadata-v1", sessionId, title: "", summary: "", tags: [], annotations: [], updatedAt: new Date().toISOString() }; }

function snapshotDescendantKeys(snapshot?: GraphSnapshot): Set<string> {
  if (!snapshot) return new Set();
  const children = new Map<string, string[]>();
  snapshot.edges.forEach((edge) => children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]));
  const descendants = new Set<string>();
  const queue = [...(children.get(snapshot.rootKey) ?? [])];
  while (queue.length) {
    const key = queue.shift()!;
    if (descendants.has(key)) continue;
    descendants.add(key);
    queue.push(...(children.get(key) ?? []));
  }
  return descendants;
}

function restoreRecordedFocus(snapshot?: GraphSnapshot, events?: LifecycleEvent[]): GraphSnapshot | undefined {
  if (!snapshot) return undefined;
  const focus = [...(events ?? [])].reverse().find((event) => event.kind === "focus-changed" && snapshot.nodes.some((node) => node.key.id === event.processKey));
  if (!focus || focus.processKey === snapshot.rootKey) return snapshot;
  const parents = new Map(snapshot.edges.map((edge) => [edge.target, edge.source]));
  const ancestors = new Set<string>();
  let cursor = parents.get(focus.processKey);
  while (cursor && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = parents.get(cursor);
  }
  const nodes = snapshot.nodes.map((node) => ({ ...node, isFocus: node.key.id === focus.processKey, isAncestor: ancestors.has(node.key.id) }));
  return { ...snapshot, rootKey: focus.processKey, rootAlive: nodes.find((node) => node.key.id === focus.processKey)?.alive ?? false, nodes };
}

function buildExport({ target, initialTarget, sessionId, snapshot, snapshots, events, details, capture, metadata, profile, includeSensitive }: { target: ProcessListItem; initialTarget: ProcessListItem; sessionId: string; snapshot?: GraphSnapshot; snapshots: GraphSnapshot[]; events: LifecycleEvent[]; details?: ProcessDetails; capture?: RecordedCapture; metadata: CaseMetadata; profile?: CollectorProfile; includeSensitive: boolean }) {
  const scrub = (item: ProcessDetails) => includeSensitive ? item : { ...item, environment: item.environment.map((entry) => `${entry.split("=", 1)[0]}=<redacted>`) };
  return { schema: "process-stasis/session-v0.8.1", exportedAt: new Date().toISOString(), case: metadata, redaction: { environmentValuesIncluded: includeSensitive }, collector: profile, initialTarget: { pid: initialTarget.key.pid, startTimeTicks: initialTarget.key.startTimeTicks, command: initialTarget.command }, target: { pid: target.key.pid, startTimeTicks: target.key.startTimeTicks, command: target.command }, session: { id: sessionId, journal: capture?.info }, latestSnapshot: snapshot, snapshots: capture?.snapshots ?? snapshots, lifecycleEvents: capture?.lifecycleEvents ?? [...events].reverse(), inspections: (capture?.inspections ?? (details ? [{ id: "latest-only", timestamp: details.capturedAt, process: details }] : [])).map((item) => ({ ...item, process: scrub(item.process) })), controlActions: capture?.controlActions ?? [], limitations: ["Procfs lifecycle changes shorter than the sample interval may be missed.", "No syscall payloads or packet contents are captured.", "Live-tree acquisition briefly stops the visible tree and cannot recover children that exited before discovery."] };
}
function renderHtmlReport(payload: ReturnType<typeof buildExport>) {
  const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
  const eventRows = payload.lifecycleEvents.slice(-500).map((event) => `<tr><td>${escape(formatTime(event.timestamp))}</td><td>${escape(event.kind)}</td><td>${escape(event.comm)} · ${escape(event.pid)}</td><td>${escape(event.message)}</td><td>${escape(event.source)} / ${escape(event.confidence)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(payload.case.title || "Process Stasis report")}</title><style>body{margin:0;background:#f3eee4;color:#211e1a;font:14px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:56px 32px}h1{font-size:42px;letter-spacing:-.04em;margin:.1em 0}p{color:#6d665d}.card{background:#fffdf8;border:1px solid #ddd5c9;border-radius:14px;padding:22px;margin:16px 0}code{font:12px ui-monospace,monospace;color:#3158d8}table{width:100%;border-collapse:collapse}th,td{padding:10px;text-align:left;border-bottom:1px solid #e8e0d5;font-size:12px}th{color:#776f65;text-transform:uppercase;font-size:10px}.meta{display:flex;gap:24px}.meta div{display:grid}.meta span{color:#777;font-size:11px}.meta strong{font-size:18px}</style></head><body><main><small>PROCESS STASIS · SESSION 0.8.1</small><h1>${escape(payload.case.title || payload.target.command)}</h1><p>${escape(payload.case.summary || "No investigator summary was provided.")}</p><section class="card meta"><div><span>PID</span><strong>${escape(payload.target.pid)}</strong></div><div><span>Snapshots</span><strong>${payload.snapshots.length}</strong></div><div><span>Events</span><strong>${payload.lifecycleEvents.length}</strong></div><div><span>Exported</span><strong>${escape(formatTime(payload.exportedAt))}</strong></div></section><section class="card"><h2>Timeline</h2><table><thead><tr><th>Time</th><th>Event</th><th>Process</th><th>Observation</th><th>Source</th></tr></thead><tbody>${eventRows}</tbody></table></section><section class="card"><h2>Collection limits</h2><ul>${payload.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section></main></body></html>`;
}
