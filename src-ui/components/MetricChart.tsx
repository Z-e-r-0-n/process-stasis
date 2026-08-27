import { ChartLineUp } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { formatBytes } from "../format";
import type { MetricPoint } from "../types";

interface Props {
  points: MetricPoint[];
  mode: "cpu" | "memory" | "io";
  onModeChange: (mode: Props["mode"]) => void;
}

export function MetricChart({ points, mode, onModeChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const values = points.length ? points : [{ timestamp: Date.now() / 1000, cpu: 0, rss: 0, read: 0, write: 0 }];
    const data: uPlot.AlignedData = mode === "cpu"
      ? [values.map((point) => point.timestamp), values.map((point) => point.cpu)]
      : mode === "memory"
        ? [values.map((point) => point.timestamp), values.map((point) => point.rss)]
        : [values.map((point) => point.timestamp), values.map((point) => point.read), values.map((point) => point.write)];
    const series: uPlot.Series[] = mode === "io"
      ? [{}, { label: "Read", stroke: "#315efb", width: 2, fill: "rgba(49,94,251,.07)" }, { label: "Write", stroke: "#ef7b45", width: 1.8 }]
      : [{}, { label: mode === "cpu" ? "CPU" : "RSS", stroke: "#315efb", width: 2, fill: "rgba(49,94,251,.08)" }];
    const options: uPlot.Options = {
      width: Math.max(280, host.current.clientWidth), height: Math.max(112, host.current.clientHeight),
      cursor: { show: true, drag: { x: false, y: false } }, legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [0, max <= 0 ? 1 : max * 1.18] } },
      axes: [
        { stroke: "#7b8190", grid: { stroke: "rgba(66,72,87,.09)", width: 1 }, ticks: { stroke: "transparent" }, font: "11px Inter, system-ui", size: 30 },
        { stroke: "#7b8190", grid: { stroke: "rgba(66,72,87,.09)", width: 1 }, ticks: { stroke: "transparent" }, font: "11px Inter, system-ui", size: 56,
          values: (_u, ticks) => ticks.map((value) => mode === "cpu" ? `${value.toFixed(0)}%` : formatBytes(value, 0)) },
      ], series,
    };
    const plot = new uPlot(options, data, host.current);
    let resizeFrame = 0;
    const resize = new ResizeObserver(([entry]) => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        const width = Math.max(280, Math.floor(entry.contentRect.width));
        const height = Math.max(112, Math.floor(entry.contentRect.height));
        if (width !== plot.width || height !== plot.height) plot.setSize({ width, height });
      });
    });
    resize.observe(host.current);
    return () => { resize.disconnect(); window.cancelAnimationFrame(resizeFrame); plot.destroy(); };
  }, [points, mode]);

  return (
    <section className="metrics-panel">
      <div className="metrics-header">
        <div><ChartLineUp /><span>Resource history</span></div>
        <div className="segmented">
          {(["cpu", "memory", "io"] as const).map((item) => <button key={item} className={mode === item ? "active" : ""} onClick={() => onModeChange(item)}>{item === "memory" ? "Memory" : item.toUpperCase()}</button>)}
        </div>
        <span className="history-window">Selected process · 15 minute buffer</span>
      </div>
      <div className="metric-chart" ref={host} />
    </section>
  );
}
