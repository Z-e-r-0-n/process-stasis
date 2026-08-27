# Desktop observer workflow and collected data

This document describes the implemented Process Stasis `0.2.0` desktop observer.
The older Python snapshot collector remains available and is documented in
[`CURRENT-WORKFLOW.md`](CURRENT-WORKFLOW.md).

## What the desktop application does

The application accepts one visible Linux PID and creates a live, temporal view
of that process, its ancestors, and its observed descendants. It reads procfs. It
does not signal, pause, inject into, debug, contain, terminate, or modify the
target.

```text
choose PID -> pin identity -> discover family -> stream samples and inferred events
           -> retain exited nodes -> inspect a selected node -> record/export JSON
```

No acknowledgement or investigation-reason form is required by the local UI.
The operator is still responsible for selecting only processes they own or are
authorized to inspect.

## Exact attach and tracking sequence

1. The picker scans numeric `/proc` entries and reads each visible process.
2. Selecting a row passes its PID to the native observer.
3. The observer reads `/proc/PID/stat` and builds a stable key from
   `boot ID + PID + process start-time ticks`.
4. It walks the current PPID chain to visible ancestors, then recursively
   discovers currently visible descendants.
5. Every 500 ms it rescans procfs, updates metrics for known live identities, and
   discovers processes whose current parent is a known live identity.
6. A new child produces an inferred `spawn` event and a retained edge.
7. A changed task name or executable symlink produces an inferred `exec` event.
8. A missing stable identity produces an inferred `exit` event. Its last known
   node and parent edge remain in the graph.
9. If the original focus process exits, sampling continues for every known live
   child. The focus process is not silently replaced.
10. Selecting a live node performs a deeper point-in-time procfs inspection. The
    PID start time is checked before and after capture to reject PID reuse.
11. Export writes versioned JSON through a temporary file and atomic rename. The
    resulting file has mode `0600`.

The pause button freezes only graph presentation. Collection continues. The
record button stores one graph snapshot every two seconds plus lifecycle events;
the latest snapshot and 15-minute UI telemetry buffer exist without recording.

## Live process-list fields

| UI field | Linux source or derivation |
|---|---|
| Stable key | `/proc/sys/kernel/random/boot_id`, PID, `/proc/PID/stat` start time |
| PID, PPID, name, state, threads | `/proc/PID/stat` |
| Command | `/proc/PID/cmdline`, falling back to stat name |
| Executable | `/proc/PID/exe` symlink |
| UID and user | `/proc/PID/status` and `/etc/passwd` |
| Resident memory | stat RSS pages × system page size |
| Age | system uptime minus process start time |

Search matches PID, task name, or command. Results are ordered by RSS and capped
at 300 in the current UI.

## Data in every graph sample

Each retained node contains its stable key; PID; PPID; retained parent key; task
name; command; executable; UID and user; state; live/exited, focus, and ancestor
flags; discovery and exit timestamps; age; CPU percentage; RSS; virtual memory;
cumulative read/write bytes; thread count; and open-FD count.

Each snapshot contains the UTC sample time, sequence, root identity, root-live
status, live/exited counts, all retained edges, and the polling limitation flag.

CPU percentage is the change in user plus system CPU ticks divided by elapsed
wall time and the kernel clock-tick frequency. A multi-threaded process can
exceed 100 percent.

## Deep inspection fields

| Data | Source |
|---|---|
| Command arguments | `/proc/PID/cmdline` |
| Name, state, IDs, capabilities, seccomp, memory status | `/proc/PID/status` |
| Executable, working directory, process root | `/proc/PID/{exe,cwd,root}` symlinks |
| Executable SHA-256 | `/proc/PID/exe`, maximum 512 MiB |
| Environment | `/proc/PID/environ`, maximum 2 MiB |
| I/O counters | `/proc/PID/io` |
| Cgroup membership and resource limits | `/proc/PID/{cgroup,limits}` |
| Memory mappings | `/proc/PID/maps` |
| Namespace identifiers | `/proc/PID/ns/*` symlinks |
| File descriptors | `/proc/PID/fd/*` plus position/flags from `fdinfo` |
| Owned sockets | FD inodes correlated with `/proc/PID/net/{tcp,tcp6,udp,udp6,unix}` |

Text reads are capped at 4 MiB unless a smaller limit is stated. FD enumeration
is capped at 8,192. Failed or permission-denied reads become collection errors,
not successful empty evidence. Environment values are masked until revealed.

## Export structure

Exported JSON uses `process-stasis/session-v0.2`:

```text
schema
exportedAt
collection { mode, intervalMs, inferredLifecycleEvents, limitations[] }
target { pid, startTimeTicks, command }
session { id, recordingStartedAt, latestSequence }
latestSnapshot
snapshots[]
lifecycleEvents[]
selectedProcessDetails
```

Exports are limited to 64 MiB. Environment, command-line, file, mapping, and
socket metadata may be sensitive despite mode `0600`. Do not save evidence into
a synchronized or shared directory unintentionally.

## What “process tree” means here

The application reconstructs an **observed temporal process graph**, not an
authoritative audit log.

- The initial view includes the visible ancestor chain and recursively visible
  descendants at attach time.
- Later edges are inferred from repeated PPID observations.
- Exited identities and observed edges remain available.
- PID reuse is distinguished by start-time ticks.
- A process that starts and exits entirely between scans can be missed.
- A process reparented before a scan may appear without its original edge.
- `exec` is inferred from visible changes and can miss a short-lived image.

These limits are displayed and written into every export. Kernel event tracing
is a planned upgrade, not an implemented claim.

## Explicit non-features in version 0.2

- no syscall, library-call, packet, DNS, or file-content capture;
- no memory dump, stack unwind, or core dump;
- no signals, ptrace, seccomp injection, freezing, or cgroup movement;
- no threat verdict, automated remediation, or termination;
- no container/VM migration, checkpoint, replay, deception, or containment;
- no claim that polling produces an atomic or complete historical record.
