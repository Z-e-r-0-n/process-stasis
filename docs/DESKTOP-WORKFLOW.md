# Desktop workflow and evidence contract

This document describes the implemented Process Stasis `0.7.0` desktop
application. The Python `0.1` point-in-time collector remains documented in
[`CURRENT-WORKFLOW.md`](CURRENT-WORKFLOW.md).

## Product boundary

The application has three implemented paths:

1. **Observe** follows one authorized PID and its visible descendants without
   sending a signal or changing execution.
2. **Investigate** records, reopens, searches, annotates, compares, and exports
   the evidence collected by Observe.
3. **Control** can request cgroup v2 freeze or thaw only when every safety gate
   below passes. It does not move processes between cgroups.

It does not capture syscall arguments, packets, file contents, or memory; block
network traffic; terminate a process; migrate execution; emulate libc/syscalls;
restore a checkpoint; or launch a replay VM.

```text
choose PID
  -> verify PID + start time
  -> follow scoped temporal family
  -> stream snapshots + normalized lifecycle events
  -> optionally journal evidence
  -> inspect / search / annotate / compare
  -> export JSON or HTML
  -> optionally verify gates -> record request -> freeze/thaw -> verify result
```

## Attach, identity, and scope

1. The picker scans numeric `/proc` entries and displays visible PID, PPID, task
   name, command, UID/user, state, RSS, threads, and age.
2. The selected PID and its expected `/proc/PID/stat` start-time ticks are passed
   to Rust. Attach fails if that identity changed after the picker sample.
3. Stable keys contain boot ID, PID, and start-time ticks. The observer also
   attempts `pidfd_open` for every retained identity.
4. Visible ancestors are retained as context. They cannot introduce siblings.
5. The focus process and known living descendants can introduce children.
6. The initial scan recursively includes visible descendants. Later scans repeat
   child discovery so a parent and grandchild found in one sample are both added.
7. Exited nodes and edges remain in the graph. If the focus exits, collection
   continues for already known living descendants.

The graph is an observed temporal reconstruction, not an audit log. A process
that forks, execs, and exits entirely between 500 ms samples can be missed.

## Event sources and confidence

| Event | Source label | Confidence |
|---|---|---|
| Attach/detach | `observer` | exact application action |
| Spawn | `procfs-diff` | inferred from a newly visible stable child identity |
| Exec | `procfs-diff` | inferred from a changed task name or executable link |
| Exit | `procfs+pidfd` | observed missing identity, with retained pidfd polling when available |

The collector profile states that the active source is
`procfs-polling+pidfd`. Kernel lifecycle streaming is reported as unavailable;
the application does not imply that eBPF, audit, or process connector telemetry
is installed.

## Graph samples and telemetry

Every 500 ms sample contains:

- session, sequence, UTC timestamp, focus key, focus-live status, and counts;
- every retained node's stable key, current PPID and retained parent key;
- task name, command, executable, UID/user, state, and role flags;
- identity guard, discovery time, exit time, and process age;
- CPU, RSS, virtual memory, read/write totals, threads, and descriptor count;
- retained parent edges, their discovery time, relationship, and live/historical state.

CPU is the change in user plus system ticks divided by elapsed wall time and
kernel clock frequency. Multi-threaded processes can exceed 100 percent.

The graph pause button pauses presentation only. Live collection continues. The
UI retains up to 1,800 metric points per selected identity and 1,800 two-second
comparison snapshots.

## Deep inspection

A selected live process is identity-checked before and after collection. The
inspection contains:

| Evidence | Source / derivation |
|---|---|
| Arguments | `/proc/PID/cmdline` |
| Status/security fields | `/proc/PID/status` |
| Executable, cwd, root | `/proc/PID/{exe,cwd,root}` links |
| Executable SHA-256 | bytes through `/proc/PID/exe`, maximum 512 MiB |
| Executable file identity | size, modification time, device, inode, mode, UID, GID, deleted-link state |
| Environment | `/proc/PID/environ`, maximum 2 MiB; values hidden in UI |
| I/O, cgroup, limits, maps | corresponding procfs files |
| Namespaces | `/proc/PID/ns/*`, compared with the observer's namespace IDs |
| Descriptors | maximum 8,192 links plus bounded `fdinfo` position/flags |
| Process-owned sockets | FD inode correlation with target network-namespace proc tables |

Other text reads are capped at 4 MiB. Permission failures and races are retained
as collection errors. Behavioral observations are deterministic hints such as a
deleted/transient executable, root identity, missing NoNewPrivs/seccomp, an
unusual descriptor count, or non-loopback sockets. They are not a threat score or
malicious/benign verdict.

When recording is active, a deep refresh is appended as an `inspection` journal
entry. A historical session exposes only inspections actually preserved in that
journal.

## Native journal and case storage

The application data `recordings/` directory is mode `0700`. Each journal is
`SESSION_UUID.jsonl`, opened with `O_NOFOLLOW`, mode `0600`, and limited to
32 MiB.

The journal contains:

- a versioned header with the target identity;
- every lifecycle event;
- one graph snapshot every four samples (two seconds);
- pause/resume/end markers;
- preserved deep inspections;
- containment requests and verified control results.

Data is flushed during custom evidence writes, synced at most every ten seconds
during the normal stream, and fully synced on stop/end. Reopening tolerates one
trailing partial JSONL line, records that recovery condition in the session
summary, and rejects corruption elsewhere.

Case metadata is a separate `SESSION_UUID.case.json` sidecar, also mode `0600`
and atomically replaced. It stores title, summary, tags, notes, and event
bookmarks. Keeping annotations separate prevents a later human interpretation
from rewriting the original append-only observations.

The launcher scans valid journals after restart. Each displayed session includes
target, counts, updated time, case title/tags, SHA-256 of the journal, and partial
tail status.

## Timeline and comparison

The timeline can search message, command/name, PID, and source; filter by event
kind, warning severity, and time window; jump to the related process; and create
or remove an event bookmark.

Snapshot comparison selects an earlier retained graph state and compares it with
the current displayed state. It reports stable identities that appeared or
exited, task/executable image changes, and total live RSS delta. This is an
in-session comparison, not a byte-for-byte memory diff.

## Export contract

JSON exports use `process-stasis/session-v0.7` and contain:

```text
schema, exportedAt
case { title, summary, tags, annotations[] }
redaction { environmentValuesIncluded }
collector { activeSource, lifecyclePrecision, sampleIntervalMs, capabilities[] }
target { pid, startTimeTicks, command }
session { id, journal }
latestSnapshot
snapshots[]
lifecycleEvents[]
inspections[]
controlActions[]
limitations[]
```

The default JSON export replaces each environment value with `<redacted>` while
retaining the variable name. A separate explicit action exports full environment
values. HTML reports are escaped, contain no executable target markup, omit
environment values, and include at most the latest 500 lifecycle events. Atomic
export writes are limited to 64 MiB and use mode `0600`.

## Verified cgroup freeze/thaw

Control is unavailable unless all gates pass:

1. unified cgroup v2 is mounted;
2. the tracking session has a current live focus/descendant scope;
3. every living tracked member reports the same unified cgroup;
4. that cgroup is not `/`;
5. recursively enumerating the cgroup subtree (maximum depth 32 and 4,096 PIDs)
   finds exactly the tracked living PIDs and no unrelated PID;
6. `cgroup.freeze` is writable by the application user;
7. every PID still has the expected start-time ticks immediately before action;
8. evidence recording is active;
9. the operator provides a printable 8–500 character reason and checks the
   authorization acknowledgement.

The native backend records the request, writes `1` (freeze) or `0` (thaw), then
polls `cgroup.events` for up to one second. A result is successful only when the
kernel reports the requested `frozen` value and membership is still exact. If a
freeze succeeds but membership changes during verification, the group remains
frozen and the result says that operator review is required. The application
never silently thaws or kills the target.

Network restriction is deliberately unavailable. It requires a separately
audited privileged helper; the WebView is not elevated and a container is not
treated as the sole hostile-code boundary.

## Remaining boundaries

- No kernel fork/exec event stream is installed, so sub-sample activity can be missed.
- No syscall arguments, library calls, packet contents, DNS, or file-content timeline.
- No cgroup creation/launcher or arbitrary live-tree cgroup migration.
- No network policy helper, ptrace injection, signal-based pause, or termination.
- No VM replay, environment simulation, syscall mediation, or CRIU restore.
- No automatic verdict or remediation decision.
