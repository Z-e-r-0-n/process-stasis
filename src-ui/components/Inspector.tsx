import { ArrowsClockwise, CheckCircle, Copy, Eye, EyeSlash, Files, Globe, HardDrives, Info, Memory, Warning, WarningCircle } from "@phosphor-icons/react";
import { animate } from "animejs";
import { useEffect, useState } from "react";
import { formatBytes, formatDuration, processStateLabel, truncateMiddle } from "../format";
import type { ProcessDetails, ProcessNode } from "../types";

type Tab = "overview" | "files" | "network" | "memory" | "environment";

interface Props {
  process?: ProcessNode;
  details?: ProcessDetails;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
}

const tabs: { id: Tab; label: string; icon: typeof Info }[] = [
  { id: "overview", label: "Overview", icon: Info }, { id: "files", label: "Files", icon: Files },
  { id: "network", label: "Network", icon: Globe }, { id: "memory", label: "Memory", icon: Memory },
  { id: "environment", label: "Env", icon: HardDrives },
];

export function Inspector({ process, details, loading, error, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [showEnvironment, setShowEnvironment] = useState(false);
  useEffect(() => {
    const content = document.querySelector(".inspector-content");
    if (content) animate(content, { opacity: [0.35, 1], x: [7, 0], duration: 280, ease: "outQuad" });
  }, [tab, process?.key.id]);
  if (!process) return <aside className="inspector-panel inspector-empty"><CrosshairEmpty /><strong>Select a node</strong><span>Process details will appear here.</span></aside>;

  return (
    <aside className="inspector-panel">
      <div className="inspector-identity">
        <div className="identity-top"><span className={`life-indicator ${process.alive ? "alive" : "dead"}`} /><span>{process.alive ? "LIVE PROCESS" : "HISTORICAL PROCESS"}</span>
          <button className="icon-button" onClick={onRefresh} disabled={!process.alive || loading} title="Refresh deep inspection"><ArrowsClockwise className={loading ? "spinning" : ""} /></button></div>
        <div className="identity-title"><h2>{process.comm}</h2><span>PID {process.key.pid}</span></div>
        <p title={process.command}>{process.command}</p>
        <div className="identity-chips"><span>{process.user ?? `uid ${process.uid ?? "?"}`}</span><span>{processStateLabel(process.state)}</span><span>{formatDuration(process.ageSeconds)}</span></div>
      </div>
      <nav className="inspector-tabs">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon /><span>{label}</span></button>)}
      </nav>
      <div className="inspector-content">
        {error && <div className="inspect-warning"><Warning />{error}</div>}
        {details?.collectionErrors.length ? <div className="inspect-warning"><Warning />Partial capture: {details.collectionErrors.join(" · ")}</div> : null}
        {tab === "overview" && <Overview process={process} details={details} />}
        {tab === "files" && <FilesTab details={details} />}
        {tab === "network" && <NetworkTab details={details} />}
        {tab === "memory" && <MemoryTab details={details} />}
        {tab === "environment" && <EnvironmentTab details={details} visible={showEnvironment} onToggle={() => setShowEnvironment(!showEnvironment)} />}
      </div>
    </aside>
  );
}

function Overview({ process, details }: { process: ProcessNode; details?: ProcessDetails }) {
  return <>
    <Observations process={process} details={details} />
    <Section title="Live metrics"><div className="metric-grid">
      <Metric label="CPU" value={`${process.cpuPercent.toFixed(1)}%`} accent /> <Metric label="Resident" value={formatBytes(process.rssBytes)} />
      <Metric label="Virtual" value={formatBytes(process.virtualBytes)} /> <Metric label="Threads" value={String(process.threads)} />
      <Metric label="Open FDs" value={String(process.fdCount)} /> <Metric label="I/O total" value={formatBytes(process.readBytes + process.writeBytes)} />
    </div></Section>
    <Section title="Identity"><KeyValues values={[
      ["Executable", details?.executable ?? process.executable ?? "unavailable"], ["SHA-256", details?.executableSha256 ?? "collecting…"],
      ["Image size", details?.executableMetadata ? formatBytes(details.executableMetadata.sizeBytes) : "unavailable"],
      ["Device / inode", details?.executableMetadata ? `${details.executableMetadata.device} / ${details.executableMetadata.inode}` : "unavailable"],
      ["Mode / owner", details?.executableMetadata ? `${details.executableMetadata.mode.toString(8)} · ${details.executableMetadata.uid}:${details.executableMetadata.gid}` : "unavailable"],
      ["Modified", details?.executableMetadata?.modifiedAt ?? "unavailable"], ["Identity guard", process.identityGuard],
      ["Working dir", details?.cwd ?? "unavailable"], ["Parent PID", String(process.ppid)], ["Start ticks", String(process.key.startTimeTicks)],
    ]} /></Section>
    <Section title="Namespaces"><div className="namespace-grid">{details?.namespaces.map((entry) => <div key={entry.name} className={entry.differsFromObserver ? "namespace-different" : ""}><span>{entry.name}{entry.differsFromObserver && <i title="Different from observer namespace" />}</span><code>{entry.identifier.match(/\d+/)?.[0] ?? entry.identifier}</code></div>) ?? <SkeletonRows />}</div></Section>
    <Section title="Security context"><KeyValues values={[["Seccomp", details?.status.Seccomp ?? "—"], ["Capabilities", details?.status.CapEff ?? "—"], ["No new privileges", details?.status.NoNewPrivs ?? "—"], ["Cgroup", details?.cgroup.trim() || "—"]]} /></Section>
  </>;
}

function Observations({ process, details }: { process: ProcessNode; details?: ProcessDetails }) {
  const findings: { label: string; detail: string; tone: "notice" | "warning" }[] = [];
  const executable = details?.executable ?? process.executable ?? "";
  if (executable.endsWith(" (deleted)")) findings.push({ label: "Deleted executable", detail: "The running image no longer has its original directory entry.", tone: "warning" });
  if (/\/(tmp|dev\/shm|var\/tmp)\//.test(executable)) findings.push({ label: "Transient executable path", detail: executable, tone: "notice" });
  if (process.uid === 0) findings.push({ label: "Elevated identity", detail: "The process reports effective user ID 0.", tone: "notice" });
  if (details?.status.NoNewPrivs === "0") findings.push({ label: "Privilege growth not blocked", detail: "NoNewPrivs is not enabled for this process.", tone: "notice" });
  if (details?.status.Seccomp === "0") findings.push({ label: "No seccomp filter", detail: "The process reports no seccomp mode.", tone: "notice" });
  const external = details?.sockets.filter((socket) => !/^(127\.|\[?::1\]?|0\.0\.0\.0|\*|—)/.test(socket.remoteAddress)) ?? [];
  if (external.length) findings.push({ label: "Non-loopback sockets", detail: `${external.length} process-owned socket${external.length === 1 ? "" : "s"} report a non-loopback peer.`, tone: "notice" });
  if (process.fdCount > 256) findings.push({ label: "Large descriptor set", detail: `${process.fdCount} descriptors were visible in the bounded scan.`, tone: "notice" });
  return <Section title="Behavioral observations"><p className="observation-disclaimer">Deterministic triage hints from collected facts—not a malware verdict.</p><div className="observation-list">
    {findings.map((finding) => <div className={finding.tone} key={finding.label}>{finding.tone === "warning" ? <WarningCircle weight="fill" /> : <Info weight="fill" />}<span><b>{finding.label}</b><small title={finding.detail}>{finding.detail}</small></span></div>)}
    {!findings.length && <div className="quiet"><CheckCircle weight="fill" /><span><b>No highlighted heuristics</b><small>The current bounded capture did not trigger the built-in observations.</small></span></div>}
  </div></Section>;
}

function FilesTab({ details }: { details?: ProcessDetails }) {
  return <Section title={`File descriptors · ${details?.fileDescriptors.length ?? 0}`}><div className="table-list">
    {details?.fileDescriptors.map((fd) => <div className="table-row" key={fd.fd}><code className="fd-number">{fd.fd}</code><span title={fd.target}>{truncateMiddle(fd.target, 40)}</span><small>{fd.flags ?? "—"}</small></div>) ?? <SkeletonRows />}
  </div></Section>;
}

function NetworkTab({ details }: { details?: ProcessDetails }) {
  return <>
    <Section title={`Process sockets · ${details?.sockets.length ?? 0}`}><div className="socket-list">
      {details?.sockets.length ? details.sockets.map((socket) => <div className="socket-card" key={`${socket.inode}-${socket.protocol}`}><header><span>{socket.protocol}</span><b>{socket.state}</b></header><div><small>LOCAL</small><code>{socket.localAddress}</code></div><div><small>REMOTE</small><code>{socket.remoteAddress}</code></div></div>) : <div className="inspector-placeholder">No process-owned sockets visible.</div>}
    </div></Section>
    <Section title="Collection note"><p className="section-copy">Socket metadata is correlated from the process file-descriptor table. No packets are captured and no connection is altered.</p></Section>
  </>;
}

function MemoryTab({ details }: { details?: ProcessDetails }) {
  return <><Section title="I/O counters"><KeyValues values={Object.entries(details?.io ?? {}).map(([key, value]) => [key, formatBytes(value)])} /></Section>
    <Section title="Memory mappings"><pre className="raw-block">{details?.maps || "Collecting mappings…"}</pre></Section>
    <Section title="Resource limits"><pre className="raw-block">{details?.limits || "Collecting limits…"}</pre></Section></>;
}

function EnvironmentTab({ details, visible, onToggle }: { details?: ProcessDetails; visible: boolean; onToggle: () => void }) {
  return <Section title="Captured environment" action={<button className="text-button" onClick={onToggle}>{visible ? <EyeSlash /> : <Eye />}{visible ? "Hide values" : "Reveal values"}</button>}>
    <div className="privacy-note"><EyeSlash /> Environment values are hidden by default because they may contain credentials.</div>
    <div className="env-list">{details?.environment.map((entry, index) => { const [key, ...parts] = entry.split("="); const value = parts.join("="); return <div key={`${key}-${index}`}><code>{key}</code><span>{visible ? value : "••••••••••••"}</span><button title="Copy value" onClick={() => navigator.clipboard.writeText(value)} disabled={!visible}><Copy /></button></div>; }) ?? <SkeletonRows />}</div>
  </Section>;
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="inspect-section"><header><h3>{title}</h3>{action}</header>{children}</section>;
}
function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <div className={`inspect-metric ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong></div>; }
function KeyValues({ values }: { values: [string, string][] }) { return <div className="key-values">{values.map(([key, value]) => <div key={key}><span>{key}</span><code title={value}>{truncateMiddle(value, 38)}</code></div>)}</div>; }
function SkeletonRows() { return <div className="skeleton-rows"><i /><i /><i /></div>; }
function CrosshairEmpty() { return <div className="empty-crosshair"><i /><i /></div>; }
