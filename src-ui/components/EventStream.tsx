import { Funnel, Pulse, X } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { formatTime } from "../format";
import type { LifecycleEvent } from "../types";

interface Props {
  events: LifecycleEvent[];
  onSelect: (key: string) => void;
}

export function EventStream({ events, onSelect }: Props) {
  const [filter, setFilter] = useState<string>();
  const parent = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filter ? events.filter((event) => event.kind === filter) : events, [events, filter]);
  const virtualizer = useVirtualizer({ count: visible.length, getScrollElement: () => parent.current, estimateSize: () => 54, overscan: 10 });
  const counts = useMemo(() => events.reduce<Record<string, number>>((result, event) => ({ ...result, [event.kind]: (result[event.kind] ?? 0) + 1 }), {}), [events]);

  return (
    <section className="events-panel">
      <div className="events-header">
        <div><Pulse /><span>Lifecycle events</span><b>{events.length}</b></div>
        <div className="event-filters">
          <Funnel /><span className="filter-label">Filter</span>
          {["spawn", "exec", "exit"].map((kind) => <button key={kind} className={filter === kind ? "active" : ""} onClick={() => setFilter(filter === kind ? undefined : kind)}>{kind} <b>{counts[kind] ?? 0}</b></button>)}
          {filter && <button className="clear-filter" onClick={() => setFilter(undefined)}><X /></button>}
        </div>
      </div>
      <div className="events-scroll" ref={parent}>
        {visible.length === 0 ? <div className="empty-events"><Pulse /><span>Waiting for lifecycle changes</span></div> :
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const event = visible[row.index];
              return <button key={event.id} className={`event-row severity-${event.severity}`} onClick={() => onSelect(event.processKey)} style={{ transform: `translateY(${row.start}px)` }}>
                <time>{formatTime(event.timestamp)}</time><span className={`event-kind kind-${event.kind}`}>{event.kind}</span>
                <strong>{event.comm}</strong><span className="event-pid">{event.pid}</span><span className="event-message">{event.message}</span>
              </button>;
            })}
          </div>}
      </div>
    </section>
  );
}
