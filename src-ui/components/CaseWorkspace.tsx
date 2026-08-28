import { Archive, BookmarkSimple, Check, DownloadSimple, FileHtml, Fingerprint, FloppyDisk, NotePencil, ShieldCheck, Tag } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { formatBytes, formatTime } from "../format";
import type { CaseMetadata, CollectorProfile, RecordedCapture, RecordingInfo, SessionSummary } from "../types";

interface Props {
  sessionId: string;
  summary?: SessionSummary;
  capture?: RecordedCapture;
  metadata: CaseMetadata;
  recordingInfo?: RecordingInfo;
  profile?: CollectorProfile;
  liveSnapshotCount?: number;
  liveEventCount?: number;
  onSaveMetadata: (metadata: CaseMetadata) => Promise<void>;
  onExport: (format: "json" | "html", includeSensitive: boolean) => void;
}

export function CaseWorkspace({ sessionId, summary, capture, metadata, recordingInfo, profile, liveSnapshotCount = 0, liveEventCount = 0, onSaveMetadata, onExport }: Props) {
  const [draft, setDraft] = useState(metadata);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(metadata), [metadata]);
  const persist = async (next = draft) => {
    setSaving(true);
    try { await onSaveMetadata(next); setDraft(next); setSaved(true); window.setTimeout(() => setSaved(false), 1500); }
    finally { setSaving(false); }
  };
  const addNote = async () => {
    const body = note.trim(); if (!body) return;
    const timestamp = new Date().toISOString();
    const next = { ...draft, annotations: [...draft.annotations, { id: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp, kind: "note" as const, body }] };
    setNote(""); setDraft(next); await persist(next);
  };
  const tags = draft.tags.join(", ");
  const info = capture?.info ?? recordingInfo;

  return <section className="case-workspace">
    <header className="case-hero">
      <div><span className="view-kicker">Evidence workspace</span><h1>{draft.title || summary?.target?.comm || "Untitled observation"}</h1><p>Reopenable case context, integrity signals, annotations, and controlled exports—kept beside the native journal.</p></div>
      <button className="primary-button" disabled={saving} onClick={() => persist()}>{saved ? <Check /> : <FloppyDisk />}{saving ? "Saving…" : saved ? "Saved" : "Save case"}</button>
    </header>
    <div className="case-layout">
      <div className="case-main-column">
        <article className="case-card case-editor">
          <header><NotePencil /><div><h2>Investigator context</h2><p>Human conclusions stay separate from observed facts.</p></div></header>
          <label><span>Case title</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Name this investigation" maxLength={240} /></label>
          <label><span>Summary</span><textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="Scope, hypothesis, handoff context…" rows={4} /></label>
          <label><span>Tags</span><div className="tag-input"><Tag /><input value={tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 64) })} placeholder="triage, persistence, network" /></div></label>
        </article>
        <article className="case-card annotation-card">
          <header><BookmarkSimple /><div><h2>Notes & bookmarks</h2><p>{draft.annotations.length} retained annotations</p></div></header>
          <div className="new-note"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an investigator note…" rows={2} /><button onClick={addNote} disabled={!note.trim()}>Add note</button></div>
          <div className="annotation-list">{[...draft.annotations].reverse().map((item) => <div key={item.id} className={`annotation-item ${item.kind}`}><span>{item.kind === "bookmark" ? <BookmarkSimple weight="fill" /> : <NotePencil />}</span><div><p>{item.body}</p><small>{formatTime(item.createdAt)}{item.eventId ? ` · event ${item.eventId.slice(0, 8)}` : ""}</small></div></div>)}
            {!draft.annotations.length && <div className="annotation-empty">Bookmark timeline events or add a note for handoff.</div>}</div>
        </article>
      </div>
      <aside className="case-side-column">
        <article className="case-card evidence-inventory"><header><Archive /><div><h2>Evidence inventory</h2><p>What this case currently preserves.</p></div></header>
          <Inventory label="Journal" value={info?.active ? "Recording…" : info ? formatBytes(info.byteCount) : "Not started"} detail={info?.fileName ?? sessionId} />
          <Inventory label="Snapshots" value={String(Math.max(capture?.snapshots.length ?? info?.snapshotCount ?? 0, liveSnapshotCount))} detail="Periodic graph states" />
          <Inventory label="Lifecycle" value={String(Math.max(capture?.lifecycleEvents.length ?? info?.eventCount ?? 0, liveEventCount))} detail="Normalized events" />
          <Inventory label="Inspections" value={String(capture?.inspections.length ?? summary?.inspectionCount ?? 0)} detail="Deep procfs captures" />
          <Inventory label="Control actions" value={String(capture?.controlActions.length ?? summary?.controlActionCount ?? 0)} detail="Requested and verified" />
        </article>
        <article className="case-card integrity-card"><header><Fingerprint /><div><h2>Integrity</h2><p>Journal identity and recovery state.</p></div></header>
          <code>{summary?.integritySha256 ?? "Available after reopening the journal"}</code>
          <div className="integrity-state"><ShieldCheck weight="fill" /><span>{summary?.partialTailIgnored ? "Recovered with one trailing partial line ignored" : "Journal parsed without structural errors"}</span></div>
        </article>
        <article className="case-card export-card"><header><DownloadSimple /><div><h2>Portable exports</h2><p>Environment values are excluded by default.</p></div></header>
          <button onClick={() => onExport("json", false)}><DownloadSimple /> Redacted JSON</button>
          <button onClick={() => onExport("html", false)}><FileHtml /> Readable HTML report</button>
          <button className="sensitive-export" onClick={() => onExport("json", true)}>Full JSON with environment</button>
        </article>
        <article className="case-card collector-card"><header><ShieldCheck /><div><h2>Collection sources</h2><p>{profile?.activeSource ?? "Loading profile…"}</p></div></header>
          {profile?.capabilities.map((capability) => <div className="collector-row" key={capability.id}><i className={`state-${capability.state}`} /><span><b>{capability.label}</b><small>{capability.detail}</small></span></div>)}
        </article>
      </aside>
    </div>
  </section>;
}

function Inventory({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="inventory-row"><span>{label}</span><strong>{value}</strong><small title={detail}>{detail}</small></div>; }
