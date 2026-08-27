import { ArrowRight, Crosshair, Pause, Play, TreeStructure } from "@phosphor-icons/react";
import {
  Background, BackgroundVariant, BaseEdge, EdgeProps, getBezierPath, Handle, MiniMap,
  Node, NodeProps, Position, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import { animate } from "animejs";
import { memo, useEffect, useMemo } from "react";
import { formatBytes } from "../format";
import type { GraphSnapshot, ProcessNode } from "../types";

export type GraphScope = "descendants" | "lineage";
export type GraphDepth = 1 | 2 | "all";
type ProcessFlowNode = Node<{ process: ProcessNode; selected: boolean }, "process">;

interface Props {
  snapshot?: GraphSnapshot;
  selectedKey?: string;
  paused: boolean;
  scope: GraphScope;
  depth: GraphDepth;
  showExited: boolean;
  onPausedChange: (paused: boolean) => void;
  onScopeChange: (scope: GraphScope) => void;
  onDepthChange: (depth: GraphDepth) => void;
  onShowExitedChange: (visible: boolean) => void;
  onSelect: (key: string) => void;
  onInspect: (key: string) => void;
}

const ProcessCard = memo(({ data }: NodeProps<ProcessFlowNode>) => {
  const { process, selected } = data;
  return <div className={`graph-node ${selected ? "selected" : ""} ${process.isFocus ? "focus" : ""} ${process.isAncestor ? "ancestor" : ""} ${!process.alive ? "exited" : ""}`}>
    <Handle type="target" position={Position.Top} />
    <div className="node-topline"><span className={`life-indicator ${process.alive ? "alive" : "dead"}`} /><strong>{process.comm}</strong><code>{process.key.pid}</code></div>
    <div className="node-role">{process.isFocus ? "Focus process" : process.isAncestor ? "Ancestor" : process.alive ? "Descendant" : "Exited descendant"}</div>
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
  const { snapshot, selectedKey, paused, scope, depth, showExited, onPausedChange, onScopeChange, onDepthChange, onShowExitedChange, onSelect, onInspect } = props;
  const flow = useReactFlow<ProcessFlowNode>();
  const filtered = useMemo(() => filterSnapshot(snapshot, scope, depth, showExited), [snapshot, scope, depth, showExited]);
  const { nodes, edges } = useMemo(() => layoutGraph(filtered, selectedKey), [filtered, selectedKey]);
  const selected = snapshot?.nodes.find((node) => node.key.id === selectedKey);

  useEffect(() => {
    if (nodes.length) window.setTimeout(() => flow.fitView({ padding: 0.23, duration: 420 }), 30);
  }, [nodes.length, scope, depth, showExited]);

  useEffect(() => {
    const targets = document.querySelectorAll(".react-flow__node");
    if (targets.length) animate(targets, { opacity: [0, 1], scale: [0.97, 1], duration: 330, delay: (_el, index) => Math.min((index ?? 0) * 25, 180), ease: "outCubic" });
  }, [snapshot?.nodes.length, scope, depth]);

  return <section className="graph-panel">
    <header className="graph-header">
      <div className="graph-title"><span className="panel-icon"><TreeStructure /></span><div><h1>Process lineage</h1><p>Focus and observed descendants. Select a node for actions.</p></div></div>
      <div className="graph-controls">
        <div className="control-group"><span>Scope</span><div className="segmented"><button className={scope === "descendants" ? "active" : ""} onClick={() => onScopeChange("descendants")}>Descendants</button><button className={scope === "lineage" ? "active" : ""} onClick={() => onScopeChange("lineage")}>With ancestors</button></div></div>
        <div className="control-group"><span>Depth</span><div className="segmented">{([1, 2, "all"] as const).map((value) => <button key={value} className={depth === value ? "active" : ""} onClick={() => onDepthChange(value)}>{value === "all" ? "All" : value}</button>)}</div></div>
        <label className="switch-label"><input type="checkbox" checked={showExited} onChange={(event) => onShowExitedChange(event.target.checked)} /><span />Exited</label>
        <button className="icon-button" title={paused ? "Resume visual updates" : "Pause visual updates"} onClick={() => onPausedChange(!paused)}>{paused ? <Play weight="fill" /> : <Pause weight="fill" />}</button>
        <button className="icon-button" title="Fit graph" onClick={() => flow.fitView({ padding: 0.23, duration: 420 })}><Crosshair /></button>
      </div>
    </header>
    <div className="graph-canvas">
      {!snapshot ? <div className="graph-loading"><span className="spinner" /><strong>Building the first snapshot…</strong><small>Pinning process identity and following visible children.</small></div> :
        nodes.length === 0 ? <div className="graph-loading"><strong>No processes match this view</strong><small>Increase depth or include exited records.</small></div> :
        <ReactFlow key={nodes.map((node) => node.id).join("|")} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={(_, node) => onSelect(node.id)} nodesDraggable={false} nodesConnectable={false} elementsSelectable fitView minZoom={0.3} maxZoom={1.6}>
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d9dce3" />
          {nodes.length > 8 && <MiniMap pannable zoomable className="graph-minimap" nodeColor={(node) => { const process = (node.data as ProcessFlowNode["data"]).process; return !process.alive ? "#a5a9b1" : process.isFocus ? "#315efb" : "#8d79e8"; }} maskColor="rgba(245,246,248,.72)" />}
        </ReactFlow>}
    </div>
    {snapshot && <footer className="graph-footer"><div><span><i className="live" /> Live {filtered?.aliveCount ?? 0}</span><span><i className="history" /> Exited {filtered?.exitedCount ?? 0}</span><span>{nodes.length} shown of {snapshot.nodes.length}</span></div>{selected && <button onClick={() => onInspect(selected.key.id)}><span><strong>{selected.comm}</strong><small>PID {selected.key.pid} · {selected.alive ? "live" : "retained"}</small></span>Inspect process <ArrowRight /></button>}</footer>}
  </section>;
}

export function ProcessGraph(props: Props) { return <ReactFlowProvider><GraphStage {...props} /></ReactFlowProvider>; }

function filterSnapshot(snapshot: GraphSnapshot | undefined, scope: GraphScope, depth: GraphDepth, showExited: boolean): GraphSnapshot | undefined {
  if (!snapshot) return undefined;
  const children = new Map<string, string[]>();
  const parents = new Map<string, string>();
  snapshot.edges.forEach((edge) => { children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]); parents.set(edge.target, edge.source); });
  const include = new Set<string>([snapshot.rootKey]);
  const queue: [string, number][] = [[snapshot.rootKey, 0]];
  const maximum = depth === "all" ? Number.POSITIVE_INFINITY : depth;
  while (queue.length) {
    const [key, level] = queue.shift()!;
    if (level >= maximum) continue;
    for (const child of children.get(key) ?? []) { if (!include.has(child)) { include.add(child); queue.push([child, level + 1]); } }
  }
  if (scope === "lineage") { let parent = parents.get(snapshot.rootKey); while (parent) { include.add(parent); parent = parents.get(parent); } }
  const nodes = snapshot.nodes.filter((node) => include.has(node.key.id) && (showExited || node.alive || node.isFocus));
  const keys = new Set(nodes.map((node) => node.key.id));
  const edges = snapshot.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target));
  return { ...snapshot, nodes, edges, aliveCount: nodes.filter((node) => node.alive).length, exitedCount: nodes.filter((node) => !node.alive).length };
}

function layoutGraph(snapshot?: GraphSnapshot, selectedKey?: string) {
  if (!snapshot) return { nodes: [] as ProcessFlowNode[], edges: [] as ReturnType<typeof makeEdge>[] };
  const keys = new Set(snapshot.nodes.map((node) => node.key.id));
  const incoming = new Set(snapshot.edges.map((edge) => edge.target));
  const children = new Map<string, string[]>();
  snapshot.edges.forEach((edge) => children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]));
  const roots = snapshot.nodes.map((node) => node.key.id).filter((key) => !incoming.has(key));
  const rank = new Map<string, number>();
  const queue: [string, number][] = (roots.length ? roots : [snapshot.rootKey]).map((key) => [key, 0]);
  while (queue.length) {
    const [key, level] = queue.shift()!;
    if ((rank.get(key) ?? -1) >= level) continue;
    rank.set(key, level);
    for (const child of children.get(key) ?? []) if (keys.has(child)) queue.push([child, level + 1]);
  }
  snapshot.nodes.forEach((node) => { if (!rank.has(node.key.id)) rank.set(node.key.id, 0); });
  const layers = new Map<number, string[]>();
  snapshot.nodes.forEach((node) => { const level = rank.get(node.key.id)!; layers.set(level, [...(layers.get(level) ?? []), node.key.id]); });
  const widest = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, level) => layer.forEach((key, index) => positions.set(key, { x: (widest - layer.length) * 131 + index * 262 + 34, y: level * 184 + 34 })));
  const nodes: ProcessFlowNode[] = snapshot.nodes.map((process) => ({ id: process.key.id, type: "process", position: positions.get(process.key.id)!, data: { process, selected: process.key.id === selectedKey } }));
  return { nodes, edges: snapshot.edges.map(makeEdge) };
}

function makeEdge(edge: GraphSnapshot["edges"][number]) {
  return { id: edge.id, source: edge.source, target: edge.target, type: "historical", data: { current: edge.current }, animated: edge.current, style: { strokeWidth: 1.5 }, markerEnd: { type: "arrowclosed" as const, width: 13, height: 13, color: edge.current ? "#6d7fce" : "#a5a9b1" } };
}
