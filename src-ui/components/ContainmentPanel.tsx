import {
  ArrowClockwise, CircleNotch, Pause, Play, Snowflake, TreeStructure, WarningCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { ContainmentOutcome, ContainmentStatus } from "../types";

interface Props {
  status?: ContainmentStatus;
  busy: boolean;
  onRefresh: () => void;
  onApply: (freeze: boolean) => Promise<ContainmentOutcome | undefined>;
}

export function ContainmentPanel({ status, busy, onRefresh, onApply }: Props) {
  const [error, setError] = useState("");
  const apply = async () => {
    setError("");
    try {
      await onApply(!status?.frozen);
    } catch (value) {
      setError(String(value));
    }
  };
  const state = status?.frozen ? "frozen" : status?.managed ? "managed" : "observed";
  const actionLabel = status?.frozen ? "Resume tree" : status?.managed ? "Freeze tree" : "Acquire & freeze";

  return <section className={`containment-workspace state-${state}`}>
    <header className="containment-hero">
      <div><span className="view-kicker">Process control</span><h1>Hold the tree without killing it.</h1><p>One action acquires the selected process and its visible descendants, then asks the kernel to stop or resume the group.</p></div>
      <button className="icon-button" onClick={onRefresh} title="Refresh process state"><ArrowClockwise className={busy ? "spinning" : ""} /></button>
    </header>

    <div className="containment-stage">
      <article className="control-command-card">
        <div className="stasis-orbit" aria-hidden="true"><span /><span /><Snowflake weight="duotone" /></div>
        <div className="control-state-copy">
          <span className="state-label">{state}</span>
          <h2>{status?.summary ?? "Reading the selected process…"}</h2>
          <p>{status?.managed ? status.cgroupPath : "The tree is not currently in a managed group."}</p>
        </div>
        {error && <div className="control-error"><WarningCircle /> <span>{error}</span></div>}
        <button className="stasis-action" disabled={!status?.available || busy} onClick={apply}>
          {busy ? <CircleNotch className="spinning" /> : status?.frozen ? <Play weight="fill" /> : <Pause weight="fill" />}
          <span>{busy ? "Working…" : actionLabel}</span>
        </button>
      </article>

      <aside className="control-detail-panel">
        <div className="control-progress">
          <StateStep label="Observed" active />
          <i className={status?.managed ? "active" : ""} />
          <StateStep label="Acquired" active={Boolean(status?.managed)} />
          <i className={status?.frozen ? "active" : ""} />
          <StateStep label="Frozen" active={Boolean(status?.frozen)} />
        </div>
        <div className="managed-scope">
          <header><TreeStructure /><div><span>Managed scope</span><strong>{status?.members.length ?? 0} processes</strong></div></header>
          <div className="member-cloud">
            {status?.members.slice(0, 18).map((member) => <code key={member.id}>PID {member.pid}</code>)}
            {!status?.members.length && <p>The process tree will appear here after acquisition.</p>}
            {(status?.members.length ?? 0) > 18 && <code>+{status!.members.length - 18}</code>}
          </div>
        </div>
        <details className="control-technical">
          <summary>Technical state</summary>
          <dl><div><dt>Kernel interface</dt><dd>{status?.supported ? "cgroup v2" : "Unavailable"}</dd></div><div><dt>Group</dt><dd>{status?.cgroupPath ?? "Not acquired"}</dd></div><div><dt>State</dt><dd>{status?.frozen ? "frozen=1" : "frozen=0"}</dd></div></dl>
        </details>
      </aside>
    </div>
  </section>;
}

function StateStep({ label, active }: { label: string; active: boolean }) {
  return <div className={active ? "active" : ""}><span>{active ? "●" : "○"}</span><b>{label}</b></div>;
}
