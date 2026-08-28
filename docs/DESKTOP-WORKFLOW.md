# Desktop workflow and evidence contract

This document describes the implemented Process Stasis `0.8.0` desktop
application. The Python `0.1` point-in-time collector remains documented in
[`CURRENT-WORKFLOW.md`](CURRENT-WORKFLOW.md).

## Product boundary

The application has three implemented paths:

1. **Observe** follows one authorized PID and its visible descendants without
   sending a signal or changing execution.
2. **Investigate** records, reopens, searches, annotates, compares, and exports
   the evidence collected by Observe.
3. **Control** uses a narrowly scoped privileged helper to acquire a visible live
   tree into a dedicated cgroup v2, freeze it, resume it, and verify each kernel
   transition. A command can alternatively be launched in the managed group from
   birth.

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
  -> Control automatically starts journal
  -> stop and stabilize visible tree -> move to dedicated cgroup
  -> freeze/thaw -> verify cgroup.events -> capture frozen process details
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
comparison snapshots. Node coordinates and the operator's viewport persist
across samples. New nodes receive one entry transition; existing nodes are not
remounted or automatically refitted. Double-clicking a node folds or unfolds its
descendant branch.

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

JSON exports use `process-stasis/session-v0.8` and contain:

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

## Managed launch and cgroup freeze/thaw

The desktop remains unprivileged. A Control action invokes the same executable
through `pkexec --process-stasis-helper` and sends one bounded JSON request on
standard input. The helper exits before the WebView receives the result.

For an already-running PID, Freeze performs this transaction:

1. automatically start or continue the owner-only evidence journal;
2. verify the focus PID and start-time ticks;
3. scan the full current descendant tree, rejecting PID 1, the desktop process,
   and trees larger than 4,096 processes;
4. send `SIGSTOP` only to members not already stopped, rescan, and require two
   identical tree discoveries within twelve bounded rounds;
5. create `/sys/fs/cgroup/process-stasis/SESSION_UUID`;
6. verify every identity again and move each process through `cgroup.procs`;
7. require exact cgroup membership, write `1` to `cgroup.freeze`, and poll
   `cgroup.events` until it reports `frozen 1`;
8. clear only the temporary `SIGSTOP` signals; the cgroup freezer retains the
   stopped execution state;
9. record the request/result and capture a bounded deep inspection of up to 256
   acquired members while the group is frozen.

If acquisition fails, the helper thaws the temporary group, moves any migrated
members back to their recorded original cgroups, resumes only processes it
stopped, and removes the empty session group. Resume writes `0` and requires the
kernel to report `frozen 0`. The managed group remains in place so descendants
inherit it and the same tree can be frozen again.

**Launch under Stasis** creates the group first, forks a minimal shell wrapper,
moves the child into the group before `exec`, drops to the requesting user's UID,
GID, and supplementary groups, and then starts the requested command. This path
avoids the acquisition race for the initial process and all descendants inherit
the group.

The Control view contains one Freeze/Resume action. It has no authorization
checkbox, mandatory reason, visible gate matrix, failure-contract card, or dead
network-control panel. Kernel and cgroup validation still occur in the helper;
technical state is available through a compact disclosure.

## Remaining boundaries

- No kernel fork/exec event stream is installed, so sub-sample activity can be missed.
- No syscall arguments, library calls, packet contents, DNS, or file-content timeline.
- Live-tree acquisition cannot recover a child that forked and exited before any
  scan observed it; managed launch is the exact-from-birth path.
- No network policy, ptrace injection, termination, or cgroup release/move-back
  command after a successful acquisition.
- No VM replay, environment simulation, syscall mediation, or CRIU restore.
- No automatic verdict or remediation decision.
