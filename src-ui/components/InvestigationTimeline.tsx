import { BookmarkSimple, ClockCounterClockwise, Funnel, MagnifyingGlass, Scales, X } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { formatBytes, formatTime } from "../format";
import type { CaseAnnotation, GraphSnapshot, LifecycleEvent } from "../types";

interface Props {
  events: LifecycleEvent[];
  snapshots: GraphSnapshot[];
  annotations: CaseAnnotation[];
  currentSnapshot?: GraphSnapshot;
  onSelectProcess: (key: string) => void;
  onSelectSnapshot: (snapshot: GraphSnapshot) => void;
  onBookmark: (event: LifecycleEvent) => void;
}
export function InvestigationTimeline({ events, snapshots, annotations, currentSnapshot, onSelectProcess, onSelectSnapshot, onBookmark }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>();
  const [severity, setSeverity] = useState<string>();
  const [windowMinutes, setWindowMinutes] = useState(0);
  const [fromIndex, setFromIndex] = useState(0);

  const ordered = useMemo(() => [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp)), [events]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cutoff = windowMinutes ? Date.now() - windowMinutes * 60_000 : 0;
    return ordered.filter((event) =>
      (!kind || event.kind === kind)
      && (!severity || event.severity === severity)
      && (!cutoff || new Date(event.timestamp).getTime() >= cutoff)
      && (!needle || `${event.kind} ${event.comm} ${event.pid} ${event.message} ${event.source ?? ""}`.toLowerCase().includes(needle))
    );
  }, [ordered, query, kind, severity, windowMinutes]);
  const virtualizer = useVirtualizer({ count: visible.length, getScrollElement: () => parent.current, estimateSize: () => 72, overscan: 12 });
  const bookmarked = useMemo(() => new Set(annotations.filter((item) => item.kind === "bookmark").map((item) => item.eventId)), [annotations]);
  const compareFrom = snapshots[Math.min(fromIndex, Math.max(0, snapshots.length - 1))];
  const compareTo = currentSnapshot ?? snapshots.at(-1);
  const comparison = useMemo(() => compareSnapshots(compareFrom, compareTo), [compareFrom, compareTo]);
  const kinds = [...new Set(events.map((event) => event.kind))].slice(0, 8);

  return <section className="timeline-workspace">
    <div className="timeline-panel">
      <header className="timeline-header">
        <div><span className="panel-icon compact"><ClockCounterClockwise /></span><div><h1>Investigation timeline</h1><p>Search lifecycle evidence and jump directly to its process.</p></div></div>
        <span className="timeline-count">{visible.length} / {events.length}</span>
      </header>
      <div className="timeline-tools">
        <label className="timeline-search"><MagnifyingGlass /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search command, PID, source, or message" /></label>
        <div className="timeline-filter-row"><Funnel />
          {kinds.map((item) => <button key={item} className={kind === item ? "active" : ""} onClick={() => setKind(kind === item ? undefined : item)}>{item}</button>)}
          <button className={severity === "warning" ? "active warning" : ""} onClick={() => setSeverity(severity === "warning" ? undefined : "warning")}>Warnings</button>
          <select value={windowMinutes} onChange={(event) => setWindowMinutes(Number(event.target.value))} aria-label="Timeline time window"><option value={0}>All time</option><option value={5}>Last 5 min</option><option value={15}>Last 15 min</option><option value={60}>Last hour</option></select>
          {(kind || severity || query) && <button className="filter-reset" onClick={() => { setKind(undefined); setSeverity(undefined); setQuery(""); }}><X /> Reset</button>}
        </div>
      </div>
      <div className="timeline-scroll" ref={parent}>
        {visible.length === 0 ? <div className="timeline-empty"><MagnifyingGlass /><strong>No matching evidence</strong><span>Clear a filter or keep the observer running.</span></div> :
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const event = visible[row.index];
              return <article key={event.id} className={`timeline-event severity-${event.severity}`} style={{ transform: `translateY(${row.start}px)` }}>
                <button className="event-main" onClick={() => onSelectProcess(event.processKey)}>
                  <time>{formatTime(event.timestamp)}</time><span className={`event-kind kind-${event.kind}`}>{event.kind}</span>
                  <span className="event-identity"><strong>{event.comm}</strong><code>PID {event.pid}</code></span>
                  <span className="event-copy">{event.message}</span>
                  <span className="event-provenance">{event.source ?? "unknown"} · {event.confidence ?? "unspecified"}</span>
                </button>
                <button className={`bookmark-button ${bookmarked.has(event.id) ? "active" : ""}`} title="Bookmark event" onClick={() => onBookmark(event)}><BookmarkSimple weight={bookmarked.has(event.id) ? "fill" : "regular"} /></button>
              </article>;
            })}
          </div>}
      </div>
    </div>

    <aside className="comparison-panel">
      <header><Scales /><div><h2>Snapshot comparison</h2><p>What changed between two retained graph states.</p></div></header>
      {snapshots.length < 2 ? <div className="comparison-empty">Record at least two snapshots to compare process state.</div> : <>
        <div className="snapshot-range">
          <div><span>Baseline</span><strong>#{compareFrom?.sequence ?? "—"}</strong><small>{compareFrom ? formatTime(compareFrom.timestamp) : "—"}</small></div>
          <div><span>Current</span><strong>#{compareTo?.sequence ?? "—"}</strong><small>{compareTo ? formatTime(compareTo.timestamp) : "—"}</small></div>
        </div>
        <input className="snapshot-slider" type="range" min={0} max={Math.max(0, snapshots.length - 2)} value={Math.min(fromIndex, Math.max(0, snapshots.length - 2))} onChange={(event) => { const index = Number(event.target.value); setFromIndex(index); onSelectSnapshot(snapshots[index]); }} />
        <div className="comparison-metrics">
          <CompareMetric label="Appeared" value={comparison.appeared.length} tone="blue" />
          <CompareMetric label="Exited" value={comparison.exited.length} tone="red" />
          <CompareMetric label="Image changes" value={comparison.imageChanges.length} tone="amber" />
          <CompareMetric label="RSS delta" value={comparison.rssDelta} bytes tone="purple" />
        </div>
        <div className="change-list">
          {[...comparison.appeared.map((value) => ({ tone: "blue", label: "Appeared", value })), ...comparison.exited.map((value) => ({ tone: "red", label: "Exited", value })), ...comparison.imageChanges.map((value) => ({ tone: "amber", label: "Exec", value }))].slice(0, 10).map((item, index) => <div key={`${item.label}-${item.value}-${index}`}><i className={item.tone} /><span><b>{item.label}</b>{item.value}</span></div>)}
          {!comparison.appeared.length && !comparison.exited.length && !comparison.imageChanges.length && <p>No identity or image changes in this interval.</p>}
        </div>
      </>}
    </aside>
  </section>;
}

function CompareMetric({ label, value, bytes = false, tone }: { label: string; value: number; bytes?: boolean; tone: string }) {
  return <div className={`compare-metric tone-${tone}`}><span>{label}</span><strong>{bytes ? `${value >= 0 ? "+" : "−"}${formatBytes(Math.abs(value))}` : value}</strong></div>;
}

function compareSnapshots(from?: GraphSnapshot, to?: GraphSnapshot) {
  if (!from || !to) return { appeared: [] as string[], exited: [] as string[], imageChanges: [] as string[], rssDelta: 0 };
  const before = new Map(from.nodes.map((node) => [node.key.id, node]));
  const after = new Map(to.nodes.map((node) => [node.key.id, node]));
  const appeared = [...after.values()].filter((node) => !before.has(node.key.id)).map((node) => `${node.comm} · PID ${node.key.pid}`);
  const exited = [...before.values()].filter((node) => node.alive && !after.get(node.key.id)?.alive).map((node) => `${node.comm} · PID ${node.key.pid}`);
  const imageChanges = [...after.values()].filter((node) => { const previous = before.get(node.key.id); return previous && (previous.comm !== node.comm || previous.executable !== node.executable); }).map((node) => `${node.comm} · PID ${node.key.pid}`);
  const rss = (snapshot: GraphSnapshot) => snapshot.nodes.filter((node) => node.alive).reduce((sum, node) => sum + node.rssBytes, 0);
  return { appeared, exited, imageChanges, rssDelta: rss(to) - rss(from) };
}
