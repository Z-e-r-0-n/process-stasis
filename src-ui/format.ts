export function formatBytes(value = 0, precision = 1): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : precision)} ${units[index]}`;
}

export function formatDuration(seconds = 0): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function formatTime(value: string | number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function truncateMiddle(value: string, length = 46): string {
  if (value.length <= length) return value;
  const side = Math.floor((length - 1) / 2);
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

export function processStateLabel(state: string): string {
  return ({ R: "Running", S: "Sleeping", D: "Disk wait", Z: "Zombie", T: "Stopped", I: "Idle" } as Record<string, string>)[state] ?? state;
}
