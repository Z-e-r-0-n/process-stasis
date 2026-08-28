import { ArrowRight, Crosshair, Pause, Play, TreeStructure } from "@phosphor-icons/react";
import {
  Background, BackgroundVariant, BaseEdge, EdgeProps, getBezierPath, Handle, MiniMap,
  Node, NodeProps, Position, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import { animate } from "animejs";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../format";
import type { GraphSnapshot, ProcessNode } from "../types";

export type GraphScope = "descendants" | "lineage";
export type GraphDepth = 1 | 2 | "all";
type Point = { x: number; y: number };
type ProcessFlowNode = Node<{
  process: ProcessNode;
  selected: boolean;
  inPath: boolean;
  collapsed: boolean;
  childCount: number;
}, "process">;

interface Props {
  snapshot?: GraphSnapshot;
  selectedKey?: string;
  paused: boolean;
  scope: GraphScope;
  depth: GraphDepth;
  showExited: boolean;
  canPromote: boolean;
  promotingFocus: boolean;
  onPausedChange: (paused: boolean) => void;
  onScopeChange: (scope: GraphScope) => void;
  onDepthChange: (depth: GraphDepth) => void;
  onShowExitedChange: (visible: boolean) => void;
  onSelect: (key: string) => void;
  onInspect: (key: string) => void;
  onPromote: (key: string) => void;
}

const ProcessCard = memo(({ data }: NodeProps<ProcessFlowNode>) => {
  const { process, selected, inPath, collapsed, childCount } = data;
  return <div className={`graph-node ${selected ? "selected" : ""} ${inPath ? "in-path" : ""} ${process.isFocus ? "focus" : ""} ${process.isAncestor ? "ancestor" : ""} ${!process.alive ? "exited" : ""}`}>
    <Handle type="target" position={Position.Top} />
    <div className="node-topline"><span className={`life-indicator ${process.alive ? "alive" : "dead"}`} /><strong>{process.comm}</strong><code>{process.key.pid}</code></div>
    <div className="node-role">{process.isFocus ? "Focus" : process.isAncestor ? "Ancestor" : process.alive ? "Descendant" : "Exited"}{childCount > 0 && <span className={collapsed ? "collapsed" : ""}>{collapsed ? `+${childCount}` : `${childCount} child${childCount === 1 ? "" : "ren"}`}</span>}</div>
    <div className="node-metrics"><span><b>{process.cpuPercent.toFixed(1)}%</b>CPU</span><span><b>{formatBytes(process.rssBytes)}</b>Memory</span></div>
    <Handle type="source" position={Position.Bottom} />
  </div>;
});

const HistoricalEdge = memo((props: EdgeProps) => {
  const [path] = getBezierPath(props);
  return <BaseEdge path={path} markerEnd={props.markerEnd} className={props.data?.current ? "edge-live" : "edge-history"} />;
});

const nodeTypes = { process: ProcessCard };
const edgeTypes = { historical: HistoricalEdge };

function GraphStage(props: Props) {
  const { snapshot, selectedKey, paused, scope, depth, showExited, canPromote, promotingFocus, onPausedChange, onScopeChange, onDepthChange, onShowExitedChange, onSelect, onInspect, onPromote } = props;
  const flow = useReactFlow<ProcessFlowNode>();
  const positions = useRef(new Map<string, Point>());
  const seen = useRef(new Set<string>());
  const initialFitComplete = useRef(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const filtered = useMemo(() => filterSnapshot(snapshot, scope, depth, showExited, collapsed), [snapshot, scope, depth, showExited, collapsed]);
  const freshIds = useMemo(() => filtered?.nodes.map((node) => node.key.id).filter((id) => !seen.current.has(id)) ?? [], [filtered?.sequence, filtered?.nodes.length]);
  const { nodes, edges } = useMemo(() => layoutGraph(filtered, selectedKey, collapsed, positions.current), [filtered, selectedKey, collapsed]);
  const selected = snapshot?.nodes.find((node) => node.key.id === selectedKey);

  useEffect(() => {
    if (!nodes.length || initialFitComplete.current) return;
    initialFitComplete.current = true;
    window.setTimeout(() => flow.fitView({ padding: 0.28, duration: 520 }), 40);
  }, [nodes.length, flow]);

  useEffect(() => {
    if (!freshIds.length) return;
    const ids = new Set(freshIds);
    const targets = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].filter((element) => ids.has(element.dataset.id ?? ""));
    if (targets.length) animate(targets, { opacity: [0, 1], y: [12, 0], scale: [0.96, 1], duration: 420, delay: (_el, index) => Math.min((index ?? 0) * 40, 200), ease: "outCubic" });
    freshIds.forEach((id) => seen.current.add(id));
  }, [freshIds.join("|")]);

  const toggleBranch = (key: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return <section className="graph-panel">
    <header className="graph-header">
      <div className="graph-title"><span className="panel-icon"><TreeStructure /></span><div><h1>Process lineage</h1><p>The viewport stays where you leave it. Double-click a node to fold its branch.</p></div></div>
      <div className="graph-controls">
        <div className="control-group"><span>Scope</span><div className="segmented"><button className={scope === "descendants" ? "active" : ""} onClick={() => onScopeChange("descendants")}>Descendants</button><button className={scope === "lineage" ? "active" : ""} onClick={() => onScopeChange("lineage")}>With ancestors</button></div></div>
        <div className="control-group"><span>Depth</span><div className="segmented">{([1, 2, "all"] as const).map((value) => <button key={value} className={depth === value ? "active" : ""} onClick={() => onDepthChange(value)}>{value === "all" ? "All" : value}</button>)}</div></div>
        <label className="switch-label"><input type="checkbox" checked={showExited} onChange={(event) => onShowExitedChange(event.target.checked)} /><span />Exited</label>
        <button className="icon-button" title={paused ? "Resume visual updates" : "Pause visual updates"} onClick={() => onPausedChange(!paused)}>{paused ? <Play weight="fill" /> : <Pause weight="fill" />}</button>
        <button className="icon-button" title="Fit graph" onClick={() => flow.fitView({ padding: 0.28, duration: 420 })}><Crosshair /></button>
      </div>
    </header>
    <div className="graph-canvas">
      {!snapshot ? <div className="graph-loading"><span className="spinner" /><strong>Building the first snapshot…</strong><small>Pinning process identity and following visible children.</small></div> :
        nodes.length === 0 ? <div className="graph-loading"><strong>No processes match this view</strong><small>Increase depth or include exited records.</small></div> :
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={(_, node) => onSelect(node.id)} onNodeDoubleClick={(_, node) => toggleBranch(node.id)} nodesDraggable={false} nodesConnectable={false} elementsSelectable minZoom={0.25} maxZoom={1.8}>
          <Background variant={BackgroundVariant.Dots} gap={26} size={1.1} color="#d9d1c4" />
          {nodes.length > 8 && <MiniMap pannable zoomable className="graph-minimap" nodeColor={(node) => { const process = (node.data as ProcessFlowNode["data"]).process; return !process.alive ? "#b5ada2" : process.isFocus ? "#3158d8" : "#de765d"; }} maskColor="rgba(247,243,235,.72)" />}
        </ReactFlow>}
    </div>
    {snapshot && <footer className="graph-footer"><div className="graph-counts"><span><i className="live" /> Live {filtered?.aliveCount ?? 0}</span><span><i className="history" /> Exited {filtered?.exitedCount ?? 0}</span><span>{nodes.length} shown of {snapshot.nodes.length}</span></div>{selected && <div className="graph-selection-actions"><button className="inspect-selection" onClick={() => onInspect(selected.key.id)}><span><strong>{selected.comm}</strong><small>PID {selected.key.pid} · {selected.alive ? "live" : "retained"}</small></span>Inspect <ArrowRight /></button>{canPromote && <button className="promote-selection" disabled={promotingFocus} onClick={() => onPromote(selected.key.id)}><Crosshair />{promotingFocus ? "Moving…" : "Make focus"}</button>}</div>}</footer>}
  </section>;
}

export function ProcessGraph(props: Props) { return <ReactFlowProvider><GraphStage {...props} /></ReactFlowProvider>; }

function filterSnapshot(snapshot: GraphSnapshot | undefined, scope: GraphScope, depth: GraphDepth, showExited: boolean, collapsed: Set<string>): GraphSnapshot | undefined {
  if (!snapshot) return undefined;
  const children = new Map<string, string[]>();
  const parents = new Map<string, string>();
  snapshot.edges.forEach((edge) => { children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]); parents.set(edge.target, edge.source); });
  const include = new Set<string>([snapshot.rootKey]);
  const queue: [string, number][] = [[snapshot.rootKey, 0]];
  const maximum = depth === "all" ? Number.POSITIVE_INFINITY : depth;
  while (queue.length) {
    const [key, level] = queue.shift()!;
    if (level >= maximum || collapsed.has(key)) continue;
    for (const child of children.get(key) ?? []) if (!include.has(child)) { include.add(child); queue.push([child, level + 1]); }
  }
  if (scope === "lineage") { let parent = parents.get(snapshot.rootKey); while (parent) { include.add(parent); parent = parents.get(parent); } }
  const nodes = snapshot.nodes.filter((node) => include.has(node.key.id) && (showExited || node.alive || node.isFocus));
  const keys = new Set(nodes.map((node) => node.key.id));
  const edges = snapshot.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target));
  return { ...snapshot, nodes, edges, aliveCount: nodes.filter((node) => node.alive).length, exitedCount: nodes.filter((node) => !node.alive).length };
}

function layoutGraph(snapshot: GraphSnapshot | undefined, selectedKey: string | undefined, collapsed: Set<string>, positions: Map<string, Point>) {
  if (!snapshot) return { nodes: [] as ProcessFlowNode[], edges: [] as ReturnType<typeof makeEdge>[] };
  const processById = new Map(snapshot.nodes.map((node) => [node.key.id, node]));
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  snapshot.edges.forEach((edge) => { children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]); parent.set(edge.target, edge.source); });
  children.forEach((items) => items.sort((a, b) => (processById.get(a)?.key.pid ?? 0) - (processById.get(b)?.key.pid ?? 0)));

  const ranks = new Map<string, number>([[snapshot.rootKey, 0]]);
  const queue: string[] = [snapshot.rootKey];
  while (queue.length) {
    const key = queue.shift()!;
    for (const child of children.get(key) ?? []) if (!ranks.has(child)) { ranks.set(child, (ranks.get(key) ?? 0) + 1); queue.push(child); }
  }
  let ancestor = parent.get(snapshot.rootKey);
  let ancestorRank = -1;
  while (ancestor) { ranks.set(ancestor, ancestorRank--); ancestor = parent.get(ancestor); }
  snapshot.nodes.forEach((node) => { if (!ranks.has(node.key.id)) ranks.set(node.key.id, 0); });

  if (!positions.has(snapshot.rootKey)) positions.set(snapshot.rootKey, { x: 90, y: 90 });
  const pending = snapshot.nodes.filter((node) => !positions.has(node.key.id)).sort((a, b) => (ranks.get(a.key.id) ?? 0) - (ranks.get(b.key.id) ?? 0) || a.key.pid - b.key.pid);
  for (const process of pending) {
    const key = process.key.id;
    const rank = ranks.get(key) ?? 0;
    const parentKey = parent.get(key);
    const childKey = children.get(key)?.find((candidate) => positions.has(candidate));
    const anchor = parentKey ? positions.get(parentKey) : childKey ? positions.get(childKey) : positions.get(snapshot.rootKey);
    const siblings = parentKey ? children.get(parentKey) ?? [] : [];
    const index = Math.max(0, siblings.indexOf(key));
    let x = (anchor?.x ?? 90) + (siblings.length > 1 ? (index - (siblings.length - 1) / 2) * 264 : 0);
    const y = (positions.get(snapshot.rootKey)?.y ?? 90) + rank * 182;
    const occupied = new Set([...positions.values()].filter((point) => Math.abs(point.y - y) < 20).map((point) => Math.round(point.x)));
    while ([...occupied].some((value) => Math.abs(value - x) < 232)) x += 264;
    positions.set(key, { x, y });
  }

  const selectedPath = new Set<string>();
  let pathKey = selectedKey;
  while (pathKey) { selectedPath.add(pathKey); pathKey = parent.get(pathKey); }
  const nodes: ProcessFlowNode[] = snapshot.nodes.map((process) => ({
    id: process.key.id,
    type: "process",
    position: positions.get(process.key.id)!,
    data: {
      process,
      selected: process.key.id === selectedKey,
      inPath: selectedPath.has(process.key.id),
      collapsed: collapsed.has(process.key.id),
      childCount: children.get(process.key.id)?.length ?? 0,
    },
  }));
  return { nodes, edges: snapshot.edges.map(makeEdge) };
}

function makeEdge(edge: GraphSnapshot["edges"][number]) {
  return { id: edge.id, source: edge.source, target: edge.target, type: "historical", data: { current: edge.current }, animated: false, style: { strokeWidth: edge.current ? 1.8 : 1.3 }, markerEnd: { type: "arrowclosed" as const, width: 13, height: 13, color: edge.current ? "#3158d8" : "#aaa198" } };
}
