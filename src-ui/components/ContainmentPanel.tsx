import { ArrowClockwise, CheckCircle, CircleNotch, LockKey, PauseCircle, ShieldWarning, Snowflake, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ContainmentOutcome, ContainmentStatus } from "../types";

interface Props {
  status?: ContainmentStatus;
  recording: boolean;
  busy: boolean;
  onRefresh: () => void;
  onApply: (freeze: boolean, reason: string, acknowledged: boolean) => Promise<ContainmentOutcome | undefined>;
}
export function ContainmentPanel({ status, recording, busy, onRefresh, onApply }: Props) {
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const apply = async () => {
    setError("");
    try { await onApply(!status?.frozen, reason, acknowledged); }
    catch (value) { setError(String(value)); }
  };
  const ready = Boolean(status?.available && recording && reason.trim().length >= 8 && acknowledged);

  return <section className="containment-workspace">
    <header className="containment-hero"><div><span className="view-kicker">Explicit control plane</span><h1>Contain only what can be proven.</h1><p>Freeze is enabled only for an exclusive, writable, non-root cgroup whose live membership exactly matches the tracked scope.</p></div><button className="icon-button" onClick={onRefresh} title="Recheck containment gates"><ArrowClockwise className={busy ? "spinning" : ""} /></button></header>
    <div className="containment-layout">
      <article className={`freeze-card ${status?.frozen ? "frozen" : ""}`}>
        <div className="freeze-visual"><span className="freeze-ring"><Snowflake weight="duotone" /></span><i /></div>
        <div className="freeze-copy"><span>Process-tree state</span><h2>{status?.frozen ? "Verified frozen" : status?.available ? "Ready for verified freeze" : "Control unavailable"}</h2><p>{status?.reason ?? "Checking kernel and scope gates…"}</p>{status?.cgroupPath && <code>{status.cgroupPath}</code>}</div>
        <div className="control-form">
          <label><span>Operator reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Why is this state-changing action necessary?" /></label>
          <label className="authorization-check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span><CheckCircle weight={acknowledged ? "fill" : "regular"} /> I am authorized to change this process group.</span></label>
          {!recording && <div className="control-requirement"><PauseCircle /> Start evidence recording before a control action.</div>}
          {error && <div className="control-error"><WarningCircle />{error}</div>}
          <button className={status?.frozen ? "thaw-button" : "freeze-button"} disabled={!ready || busy} onClick={apply}>{busy ? <CircleNotch className="spinning" /> : status?.frozen ? <PauseCircle /> : <Snowflake />}{status?.frozen ? "Verify and thaw" : "Verify and freeze"}</button>
        </div>
      </article>
      <aside className="gate-panel"><header><LockKey /><div><h2>Safety gates</h2><p>Every gate must pass at action time.</p></div></header>
        <div className="gate-list">{status?.gates.map((gate) => <div className={gate.passed ? "passed" : "failed"} key={gate.id}>{gate.passed ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}<span><b>{gate.label}</b><small>{gate.detail}</small></span></div>) ?? <div className="gate-loading"><CircleNotch className="spinning" /> Inspecting cgroup state…</div>}</div>
      </aside>
      <article className="network-boundary"><ShieldWarning /><div><span>Network restriction</span><h3>{status?.networkRestrictionAvailable ? "Available" : "Not installed"}</h3><p>{status?.networkReason ?? "Checking capability…"}</p></div></article>
      <article className="containment-contract"><h3>Failure contract</h3><ul><li>No signal is sent when any gate fails.</li><li>A freeze is accepted only after <code>cgroup.events</code> confirms it.</li><li>If membership changes during freeze verification, the group remains frozen for review.</li><li>Thaw is always a separate, recorded operator action.</li></ul></article>
    </div>
  </section>;
}
