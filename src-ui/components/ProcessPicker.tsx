import { Archive, ArrowRight, CircleNotch, MagnifyingGlass, ShieldChevron, TerminalWindow } from "@phosphor-icons/react";
import { animate, stagger } from "animejs";
import { useEffect, useMemo, useRef, useState } from "react";
import { listProcesses, systemOverview } from "../api";
import { formatBytes, formatDuration, processStateLabel } from "../format";
import type { ProcessListItem, SessionSummary, SystemOverview } from "../types";

interface Props {
  onSelect: (process: ProcessListItem) => void;
  sessions: SessionSummary[];
  openingSession?: string;
  onOpenSession: (session: SessionSummary) => void;
}

export function ProcessPicker({ onSelect, sessions, openingSession, onOpenSession }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [overview, setOverview] = useState<SystemOverview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    animate(root.current!.querySelectorAll(".reveal"), {
      opacity: [0, 1], y: [18, 0], delay: stagger(55), duration: 620, ease: "outExpo",
    });
    input.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [items, system] = await Promise.all([listProcesses(query, 300), systemOverview()]);
        if (active) {
          setProcesses(items);
          setOverview(system);
          setError("");
          setLoading(false);
        }
      } catch (reason) {
        if (active) {
          setError(String(reason));
          setLoading(false);
        }
      }
    };
    const delay = window.setTimeout(load, query ? 140 : 0);
    const refresh = window.setInterval(load, 2500);
    return () => {
      active = false;
      window.clearTimeout(delay);
      window.clearInterval(refresh);
    };
  }, [query]);

  const chosen = useMemo(() => processes.find((item) => item.key.id === selected), [processes, selected]);
  const attach = (process = chosen) => process && onSelect(process);

  return (
    <div className="picker-screen" ref={root}>
      <header className="picker-header reveal">
        <div className="wordmark"><span className="brand-glyph"><ShieldChevron weight="fill" /></span><span>Process Stasis<small>Linux process observer</small></span></div>
        <span className="version-badge">0.7</span>
      </header>

      <main className="picker-content">
        <section className="picker-intro reveal">
          <p className="eyebrow">New observation</p>
          <h1>Choose what<br />to follow.</h1>
          <p className="lede">Start with a visible Linux process. The observer follows its lineage, retains exited nodes, and makes the collected details available for inspection and export.</p>
          <div className="system-strip">
            <div><span>Visible</span><strong>{overview?.processCount ?? "—"}</strong><small>processes</small></div>
            <div><span>System load</span><strong>{overview?.loadOne.toFixed(2) ?? "—"}</strong><small>one minute</small></div>
            <div><span>Available memory</span><strong>{overview ? formatBytes(overview.memoryAvailableBytes) : "—"}</strong><small>of {overview ? formatBytes(overview.memoryTotalBytes) : "—"}</small></div>
          </div>
          <section className="recent-sessions">
            <header><div><Archive /><span>Recorded investigations</span></div><small>{sessions.length} local</small></header>
            <div>{sessions.slice(0, 4).map((session) => <button key={session.sessionId} onClick={() => onOpenSession(session)} disabled={Boolean(openingSession)}>
              <span><strong>{session.title || session.target?.comm || "Untitled session"}</strong><small>{new Date(session.updatedAt).toLocaleString()} · {session.eventCount} events</small></span>
              {openingSession === session.sessionId ? <CircleNotch className="spinning" /> : <ArrowRight />}
            </button>)}
            {!sessions.length && <p>Recorded sessions will remain reopenable here after the app restarts.</p>}</div>
          </section>
        </section>

        <section className="process-selector reveal">
          <div className="selector-title">
            <div><TerminalWindow size={20} /><span>Choose a process</span></div>
            <span>{processes.length} matches</span>
          </div>
          <label className="process-search">
            <MagnifyingGlass size={20} />
            <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && attach(processes.length === 1 ? processes[0] : chosen)}
              placeholder="Search by PID, name, or command…" spellCheck={false} />
            <kbd>↵</kbd>
          </label>
          <div className="process-list" role="listbox">
            {loading && <div className="list-message"><span className="spinner" /> Reading /proc…</div>}
            {error && <div className="list-message error">{error}</div>}
            {!loading && !error && processes.slice(0, 80).map((process) => (
              <button key={process.key.id} className={`process-row ${selected === process.key.id ? "selected" : ""}`}
                onClick={() => setSelected(process.key.id)} onDoubleClick={() => attach(process)}>
                <span className={`state-dot state-${process.state.toLowerCase()}`} />
                <span className="process-main">
                  <strong>{process.comm}</strong>
                  <small title={process.command}>{process.command}</small>
                </span>
                <span className="process-user">{process.user ?? `uid ${process.uid ?? "?"}`}</span>
                <span className="process-stat"><b>{formatBytes(process.rssBytes)}</b><small>{process.threads} threads</small></span>
                <span className="process-pid"><b>{process.key.pid}</b><small>PPID {process.ppid}</small></span>
                <span className="process-age"><b>{formatDuration(process.ageSeconds)}</b><small>{processStateLabel(process.state)}</small></span>
                <ArrowRight className="row-arrow" size={18} />
              </button>
            ))}
            {!loading && !error && processes.length === 0 && <div className="list-message">No visible process matches “{query}”.</div>}
          </div>
          <footer className="selector-footer">
            <span>Process identity uses PID and start time.</span>
            <button className="primary-button" disabled={!chosen} onClick={() => attach()}>
              Observe process <ArrowRight weight="bold" />
            </button>
          </footer>
        </section>
      </main>
    </div>
  );
}
