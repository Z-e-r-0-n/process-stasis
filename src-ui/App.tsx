import {
  CircleNotch, DownloadSimple, FloppyDisk, MagnifyingGlass, Pause, Pulse,
  Record, ShieldChevron, TreeStructure,
} from "@phosphor-icons/react";
import { animate } from "animejs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseExportPath, getProcessDetails, startTracking, writeExport } from "./api";
import { EventStream } from "./components/EventStream";
import { Inspector } from "./components/Inspector";
import { MetricChart } from "./components/MetricChart";
import { ProcessGraph, type GraphDepth, type GraphScope } from "./components/ProcessGraph";
import { ProcessPicker } from "./components/ProcessPicker";
import { formatBytes, formatTime } from "./format";
import type { GraphSnapshot, LifecycleEvent, MetricPoint, ProcessDetails, ProcessListItem, ProcessNode, TrackingMessage } from "./types";

type WorkspaceView = "lineage" | "activity" | "inspect" | "session";
const views: { id: WorkspaceView; label: string; icon: typeof TreeStructure }[] = [
  { id: "lineage", label: "Lineage", icon: TreeStructure },
  { id: "activity", label: "Activity", icon: Pulse },
  { id: "inspect", label: "Inspect", icon: MagnifyingGlass },
  { id: "session", label: "Session", icon: FloppyDisk },
];

export default function App() {
  const [target, setTarget] = useState<ProcessListItem>();
  if (!target) return <ProcessPicker onSelect={setTarget} />;
  return <Workspace target={target} onDetach={() => setTarget(undefined)} />;
}

function Workspace({ target, onDetach }: { target: ProcessListItem; onDetach: () => void }) {
  const shell = useRef<HTMLDivElement>(null);
  const viewHost = useRef<HTMLElement>(null);
  const selectedRef = useRef(target.key.id);
  const recordingRef = useRef(false);
  const archive = useRef<GraphSnapshot[]>([]);
  const eventArchive = useRef<LifecycleEvent[]>([]);
  const detailCache = useRef<Record<string, ProcessDetails>>({});
  const [view, setView] = useState<WorkspaceView>("lineage");
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<GraphSnapshot>();
  const [visibleSnapshot, setVisibleSnapshot] = useState<GraphSnapshot>();
  const [events, setEvents] = useState<LifecycleEvent[]>([]);
  const [selectedKey, setSelectedKey] = useState(target.key.id);
  const [details, setDetails] = useState<ProcessDetails>();
  const [detailError, setDetailError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedAt, setRecordedAt] = useState<string>();
  const [metricMode, setMetricMode] = useState<"cpu" | "memory" | "io">("cpu");
  const [metrics, setMetrics] = useState<Record<string, MetricPoint[]>>({});
  const [trackingError, setTrackingError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState("");
  const [graphScope, setGraphScope] = useState<GraphScope>("descendants");
  const [graphDepth, setGraphDepth] = useState<GraphDepth>(2);
  const [showExited, setShowExited] = useState(true);

  useEffect(() => {
    if (!shell.current) return;
    animate(shell.current.querySelectorAll(".workspace-reveal"), {
      opacity: [0, 1], y: [8, 0], duration: 460, delay: (_el, index) => (index ?? 0) * 40, ease: "outExpo",
    });
  }, []);

  useEffect(() => {
    if (viewHost.current) animate(viewHost.current, { opacity: [0.35, 1], x: [10, 0], duration: 320, ease: "outCubic" });
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => Promise<void>) | undefined;
    const receive = (message: TrackingMessage) => {
      if (message.type === "event") {
        setEvents((previous) => [message.payload, ...previous].slice(0, 5000));
        if (recordingRef.current) eventArchive.current.push(message.payload);
        return;
      }
      const next = message.payload;
      setSnapshot(next);
      if (recordingRef.current && next.sequence % 4 === 0) archive.current.push(next);
      const selected = next.nodes.find((node) => node.key.id === selectedRef.current)
        ?? next.nodes.find((node) => node.key.id === next.rootKey);
      if (selected) {
        const point: MetricPoint = { timestamp: new Date(next.timestamp).getTime() / 1000, cpu: selected.cpuPercent, rss: selected.rssBytes, read: selected.readBytes, write: selected.writeBytes };
        setMetrics((previous) => ({ ...previous, [selected.key.id]: [...(previous[selected.key.id] ?? []), point].slice(-1800) }));
      }
    };
    startTracking(target.key.pid, receive).then((session) => {
      if (cancelled) session.stop();
      else { setSessionId(session.sessionId); stop = session.stop; }
    }).catch((reason) => setTrackingError(String(reason)));
    return () => { cancelled = true; stop?.(); };
  }, [target.key.id]);

  useEffect(() => { if (!paused && snapshot) setVisibleSnapshot(snapshot); }, [snapshot, paused]);
  useEffect(() => { selectedRef.current = selectedKey; }, [selectedKey]);
  useEffect(() => { recordingRef.current = recording; }, [recording]);

  const selectedProcess = useMemo(() => snapshot?.nodes.find((node) => node.key.id === selectedKey), [snapshot, selectedKey]);
  const loadDetails = useCallback(async () => {
    if (!selectedProcess?.alive) return;
    setDetailsLoading(true); setDetailError("");
    try {
      const captured = await getProcessDetails(selectedProcess.key.pid, selectedProcess.key.startTimeTicks);
      detailCache.current[selectedProcess.key.id] = captured;
      setDetails(captured);
    } catch (reason) { setDetailError(String(reason)); }
    finally { setDetailsLoading(false); }
  }, [selectedProcess?.key.id, selectedProcess?.alive]);

  useEffect(() => {
    if (selectedProcess?.alive && !detailCache.current[selectedProcess.key.id]) loadDetails();
  }, [selectedProcess?.key.id, selectedProcess?.alive, loadDetails]);

  const chooseNode = (key: string, nextView?: WorkspaceView) => {
    setSelectedKey(key); selectedRef.current = key; setDetails(detailCache.current[key]); setDetailError("");
    if (nextView) setView(nextView);
  };

  const toggleRecording = () => {
    if (!recording) { archive.current = snapshot ? [snapshot] : []; eventArchive.current = []; setRecordedAt(new Date().toISOString()); }
    setRecording(!recording);
  };

  const exportEvidence = async () => {
    setExporting(true);
    try {
      const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
      const path = await chooseExportPath(`process-stasis-${target.key.pid}-${timestamp}.json`);
      if (!path) return;
      const payload = {
        schema: "process-stasis/session-v0.2", exportedAt: new Date().toISOString(),
        collection: { mode: "procfs-polling", intervalMs: 500, inferredLifecycleEvents: true, limitations: ["Processes shorter than the polling interval may not be observed.", "No syscall or packet content is captured."] },
        target: { pid: target.key.pid, startTimeTicks: target.key.startTimeTicks, command: target.command },
        session: { id: sessionId, recordingStartedAt: recordedAt, latestSequence: snapshot?.sequence ?? 0 },
        latestSnapshot: snapshot, snapshots: archive.current.length ? archive.current : snapshot ? [snapshot] : [],
        lifecycleEvents: eventArchive.current.length ? eventArchive.current : [...events].reverse(), selectedProcessDetails: details,
      };
      await writeExport(path, JSON.stringify(payload, null, 2));
      setToast(`Evidence saved to ${path}`); window.setTimeout(() => setToast(""), 4200);
    } catch (reason) { setToast(`Export failed: ${String(reason)}`); }
    finally { setExporting(false); }
  };

  const root = snapshot?.nodes.find((node) => node.key.id === snapshot.rootKey);
  const points = metrics[selectedKey] ?? [];
  const latest = points.at(-1);
  const survivors = snapshot?.nodes.filter((node) => node.alive && !node.isAncestor && node.key.id !== snapshot.rootKey) ?? [];
  const followSurvivor = () => survivors[0] && chooseNode(survivors[0].key.id, "inspect");

  return (
    <div className="workspace" ref={shell}>
      <header className="app-header workspace-reveal">
        <button className="brand-button" onClick={onDetach} title="Choose another process">
          <span className="brand-mark"><ShieldChevron weight="fill" /></span><span><strong>Process Stasis</strong><small>Observer</small></span>
        </button>
        <nav className="workspace-nav" aria-label="Workspace views">
          {views.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}><Icon weight={view === id ? "fill" : "regular"} /><span>{label}</span></button>)}
        </nav>
        <div className="header-actions">
          <button className={`record-button ${recording ? "recording" : ""}`} onClick={toggleRecording}>{recording ? <Pause weight="fill" /> : <Record weight="fill" />}{recording ? "Stop" : "Record"}</button>
          <button className="export-button" onClick={exportEvidence} disabled={exporting || !snapshot}>{exporting ? <CircleNotch className="spinning" /> : <DownloadSimple />} Export</button>
        </div>
      </header>

      <section className="target-bar workspace-reveal">
        <div className="target-identity"><span className={`status-orb ${snapshot?.rootAlive === false ? "dead" : ""}`} /><strong>{root?.comm ?? target.comm}</strong><code>PID {target.key.pid}</code><span className="target-command" title={target.command}>{target.command}</span></div>
        <div className="target-stats"><Stat label="CPU" value={`${(root?.cpuPercent ?? 0).toFixed(1)}%`} /><Stat label="Memory" value={formatBytes(root?.rssBytes ?? target.rssBytes)} /><Stat label="Observed" value={String(snapshot?.nodes.length ?? "—")} /></div>
      </section>

      {trackingError && <div className="global-alert"><strong>Observer error</strong><span>{trackingError}</span><button onClick={onDetach}>Return to picker</button></div>}
      {snapshot && !snapshot.rootAlive && <div className="root-exit-banner workspace-reveal"><span className="exit-dot" /><span><strong>Focus process exited.</strong> Its record remains available; collection continues for {survivors.length} known living {survivors.length === 1 ? "descendant" : "descendants"}.</span>{survivors.length > 0 && <button onClick={followSurvivor}>Inspect a survivor</button>}</div>}

      <main className={`workspace-main view-${view} workspace-reveal`} ref={viewHost}>
        {view === "lineage" && <ProcessGraph snapshot={visibleSnapshot} selectedKey={selectedKey} paused={paused} scope={graphScope} depth={graphDepth} showExited={showExited} onPausedChange={setPaused} onScopeChange={setGraphScope} onDepthChange={setGraphDepth} onShowExitedChange={setShowExited} onSelect={chooseNode} onInspect={(key) => chooseNode(key, "inspect")} />}
        {view === "activity" && <div className="activity-view"><MetricChart points={points} mode={metricMode} onModeChange={setMetricMode} /><EventStream events={events} onSelect={(key) => chooseNode(key, "inspect")} /></div>}
        {view === "inspect" && <div className="inspect-view"><ProcessIndex nodes={snapshot?.nodes ?? []} selectedKey={selectedKey} onSelect={chooseNode} /><Inspector process={selectedProcess} details={details} loading={detailsLoading} error={detailError} onRefresh={loadDetails} /></div>}
        {view === "session" && <SessionView target={target} snapshot={snapshot} events={events} sessionId={sessionId} recording={recording} recordedAt={recordedAt} exporting={exporting} onRecord={toggleRecording} onExport={exportEvidence} />}
      </main>

      <footer className="status-bar workspace-reveal"><span><i className="connected" /> Connected</span><span>500 ms polling</span><span>Sequence {snapshot?.sequence ?? 0}</span><span className="status-spacer" /><span>{paused ? "View paused; collection continues" : `Updated ${snapshot ? formatTime(snapshot.timestamp) : "—"}`}</span>{latest && <span>Selected {latest.cpu.toFixed(1)}% · {formatBytes(latest.rss)}</span>}<span>Lifecycle events are inferred</span></footer>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function ProcessIndex({ nodes, selectedKey, onSelect }: { nodes: ProcessNode[]; selectedKey: string; onSelect: (key: string) => void }) {
  const [query, setQuery] = useState("");
  const visible = nodes.filter((node) => `${node.comm} ${node.command} ${node.key.pid}`.toLowerCase().includes(query.toLowerCase()));
  return <aside className="process-index"><header><div><span>Observed processes</span><b>{nodes.length}</b></div><small>Live and retained records</small></header><label><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a process" /></label><div className="process-index-list">{visible.map((node) => <button key={node.key.id} className={selectedKey === node.key.id ? "active" : ""} onClick={() => onSelect(node.key.id)}><span className={`life-indicator ${node.alive ? "alive" : "dead"}`} /><span><strong>{node.comm}</strong><small>PID {node.key.pid} · {node.isAncestor ? "ancestor" : node.isFocus ? "focus" : "descendant"}</small></span><b>{node.cpuPercent.toFixed(1)}%</b></button>)}</div></aside>;
}

function SessionView({ target, snapshot, events, sessionId, recording, recordedAt, exporting, onRecord, onExport }: { target: ProcessListItem; snapshot?: GraphSnapshot; events: LifecycleEvent[]; sessionId: string; recording: boolean; recordedAt?: string; exporting: boolean; onRecord: () => void; onExport: () => void }) {
  return <section className="session-view"><header className="view-title"><div><span className="view-kicker">Evidence session</span><h1>Capture what the observer knows.</h1><p>Recording keeps periodic graph snapshots in memory. Export writes a structured JSON case file you can inspect or process elsewhere.</p></div></header><div className="session-grid">
    <article className="session-card session-primary"><div className={`session-record-state ${recording ? "active" : ""}`}><Record weight="fill" /></div><div><span>Recording</span><h2>{recording ? "Capture in progress" : "Ready to record"}</h2><p>{recording ? `Started ${recordedAt ? formatTime(recordedAt) : "now"}.` : "Start before reproducing the behavior you want to preserve."}</p></div><button className={recording ? "danger-button" : "primary-button"} onClick={onRecord}>{recording ? <Pause weight="fill" /> : <Record weight="fill" />}{recording ? "Stop recording" : "Start recording"}</button></article>
    <article className="session-card"><span>Target</span><h3>{target.comm}</h3><code>PID {target.key.pid} · start {target.key.startTimeTicks}</code><p title={target.command}>{target.command}</p></article>
    <article className="session-card"><span>Session</span><h3>{snapshot?.sequence ?? 0} samples</h3><code>{sessionId || "Connecting…"}</code><p>{snapshot?.nodes.length ?? 0} processes · {events.length} lifecycle events</p></article>
    <article className="session-card session-export"><span>Case file</span><h3>Structured JSON</h3><p>Includes target identity, current and recorded snapshots, inferred lifecycle events, collection limits, and the selected deep inspection.</p><button className="export-button" disabled={exporting || !snapshot} onClick={onExport}>{exporting ? <CircleNotch className="spinning" /> : <DownloadSimple />} Export evidence</button></article>
    <article className="session-card session-limitations"><span>Collection boundaries</span><ul><li>Reads visible Linux procfs data every 500 ms.</li><li>Short-lived processes may occur between samples.</li><li>No syscall payloads or packet contents are captured.</li><li>No signal or control action is sent to the target.</li></ul></article>
  </div></section>;
}
