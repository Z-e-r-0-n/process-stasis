# Current collector workflow and output

This document describes implemented behavior in version `0.1.0`. Planned freeze,
tree capture, replay, and reporting features are not described as current behavior.

> This is the legacy Python CLI workflow. The `0.8.1` desktop application now
> implements live descendant discovery, retained temporal evidence, reopenable
> cases, and strictly gated cgroup freeze/thaw; see
> [`DESKTOP-WORKFLOW.md`](DESKTOP-WORKFLOW.md).

## Current input

The implemented command accepts exactly one Linux PID:

```bash
PYTHONPATH=src python3 -m process_stasis inspect \
  --pid PID \
  --output NEW_CASE_DIRECTORY \
  --reason "authorized investigation reason" \
  --ack-authorized
```

Requirements:

- `PID` must be a positive integer.
- The operator must provide the authorization acknowledgement.
- The raw reason must be at most 500 characters and must remain non-empty after
  surrounding whitespace is removed.
- The parent of `NEW_CASE_DIRECTORY` must exist.
- `NEW_CASE_DIRECTORY` must not already exist.

The collector does not accept a process name, service name, cgroup, executable, or
root PID plus descendants.

## Exact execution workflow

1. Record UTC and monotonic capture start times.
2. Attempt `pidfd_open(PID)` when Python and the kernel expose it.
3. Read `/proc/PID/stat` and extract the initial identity:
   `pid`, `ppid`, state, `comm`, and kernel start-time ticks.
4. Collect the fixed artifact set listed below from the same PID.
5. Read `/proc/PID/stat` again.
6. Compare initial and final PID plus start-time ticks.
7. Poll the pidfd, when opened, to determine whether the original process exited.
8. Mark the bundle complete only if identity remained stable, the pidfd check did
   not report exit, and every configured observation succeeded.
9. Create the case directory with mode `0700`.
10. Serialize the evidence to a temporary file, flush it, and atomically rename it
    to `manifest.json` with mode `0600`.
11. Print only the manifest path and `complete` or `partial` status.

No signal is sent. No cgroup is changed. The collector does not freeze, attach to,
resume, terminate, or restart the target.

## Exact data collected for one PID

| Manifest field | Source | Stored value |
|---|---|---|
| `schema_version` | Collector constant | Evidence contract version, currently `0.1`. |
| `case` | CLI arguments | Authorization acknowledgement and reason. |
| `capture.started_at_utc` | System clock | UTC timestamp before collection. |
| `capture.ended_at_utc` | System clock | UTC timestamp after collection. |
| `capture.duration_monotonic_ns` | Monotonic clock | Collection duration in nanoseconds. |
| `capture.collector` | Running collector | Name, version, Python version, and platform. |
| `capture.pidfd` | `pidfd_open` and `poll` | Whether pidfds are supported/opened and whether the original process exited. |
| `capture.complete` | Collector checks | Whether all configured reads succeeded and identity stayed stable. |
| `target.requested_pid` | CLI argument | PID requested by the operator. |
| `target.initial_identity` | `/proc/PID/stat` | PID, PPID, state, stat `comm`, and start-time ticks before artifact reads. |
| `target.final_identity` | `/proc/PID/stat` | The same identity fields after artifact reads. |
| `target.identity_stable` | Identity comparison | Whether PID and start-time ticks matched. |
| `artifacts.cmdline` | `/proc/PID/cmdline` | NUL-separated arguments decoded into a JSON string array. |
| `artifacts.comm` | `/proc/PID/comm` | Current task name. |
| `artifacts.links.exe` | `/proc/PID/exe` | Executable symlink target. |
| `artifacts.links.cwd` | `/proc/PID/cwd` | Working-directory symlink target. |
| `artifacts.links.root` | `/proc/PID/root` | Process root-directory symlink target. |
| `artifacts.status` | `/proc/PID/status` | Full raw text plus selected normalized fields. |
| `artifacts.cgroup` | `/proc/PID/cgroup` | Full raw cgroup membership text. |
| `artifacts.limits` | `/proc/PID/limits` | Full raw resource-limit text. |
| `artifacts.namespaces` | `/proc/PID/ns/*` | Namespace names and symlink identifiers such as `pid:[4026531836]`. |
| `artifacts.file_descriptors` | `/proc/PID/fd/*` | Descriptor number and symlink target only. |
| `artifacts.executable_sha256` | Bytes read through `/proc/PID/exe` | SHA-256 digest, with a 512 MiB read limit. |
| `errors` | Failed collection operations | Stage, source, normalized error kind, and safe message. |

Selected normalized status keys currently include identity, UID/GID/groups, thread
count, namespace-relative IDs, memory totals, signals, capabilities,
`NoNewPrivs`, and seccomp mode/filter count. The full `/proc/PID/status` text is
also stored.

Each artifact uses this wrapper:

```json
{
  "source": "/proc/PID/comm",
  "status": "collected",
  "value": "stasis-leaf"
}
```

If a read fails, `status` is `error`, `value` is `null`, and a corresponding entry
is appended to the top-level `errors` array. Missing evidence is not represented as
an empty successful value.

## What the CLI returns

Standard output from the real four-process demonstration was:

```text
Evidence bundle written: /tmp/.../case-root/manifest.json (complete)
Evidence bundle written: /tmp/.../case-watcher/manifest.json (complete)
Evidence bundle written: /tmp/.../case-leaf/manifest.json (complete)
Evidence bundle written: /tmp/.../case-server/manifest.json (complete)
```

Exit codes:

| Code | Meaning |
|---:|---|
| `0` | A complete bundle was written. |
| `3` | A partial bundle was written. Inspect `errors` and failed observations. |
| `2` | Input validation or bundle output failed. |

The CLI does not currently print a process summary or render a Markdown report.
The JSON manifest is the product output.

## Actual dummy-tree result

The target created this ground-truth tree during the demonstration on 2026-08-25:

```text
69961 stasis-root
├── 69962 stasis-watch
│   └── 69964 stasis-leaf
└── 69963 stasis-server
```

The PIDs are ephemeral example values. The collector was invoked once for each PID.
The four independent manifests contained:

| Role | PID | PPID | State | Threads | Distinguishing evidence | Complete | Errors |
|---|---:|---:|---|---:|---|---|---:|
| root | 69961 | 32479 | `S` | 1 | Launched watcher and server, but children were not listed in its manifest. | yes | 0 |
| watcher | 69962 | 69961 | `S` | 1 | PPID points to root. | yes | 0 |
| leaf | 69964 | 69962 | `S` | 2 | FD 4 pointed to `leaf-deleted-open.txt (deleted)`. | yes | 0 |
| server | 69963 | 69961 | `S` | 1 | FD 4 pointed to `socket:[6217055]`. | yes | 0 |

Relevant excerpt from the real leaf manifest:

```json
{
  "capture": {
    "complete": true,
    "pidfd": {
      "exited_by_end": false,
      "opened": true,
      "supported": true
    }
  },
  "target": {
    "initial_identity": {
      "comm": "stasis-leaf",
      "pid": 69964,
      "ppid": 69962,
      "start_time_ticks": 2107642,
      "state": "S"
    },
    "identity_stable": true
  },
  "artifacts": {
    "comm": {
      "source": "/proc/69964/comm",
      "status": "collected",
      "value": "stasis-leaf"
    },
    "file_descriptors": {
      "source": "/proc/69964/fd",
      "status": "collected",
      "value": [
        {
          "fd": 4,
          "target": {
            "source": "/proc/69964/fd/4",
            "status": "collected",
            "value": "/tmp/.../leaf-deleted-open.txt (deleted)"
          }
        }
      ]
    },
    "executable_sha256": {
      "source": "/proc/69964/exe",
      "status": "collected",
      "value": "b8d8288faefdd300201f43fcf00f6f539a27218eeed3a3dff5ab10b9c4c99700"
    }
  },
  "errors": []
}
```

The real server manifest recorded `socket:[6217055]`. It did not resolve that inode
to `127.0.0.1:44089`; socket endpoint correlation is not implemented yet.

## Are we reconstructing the process tree?

No. Version `0.1.0` collects one PID at a time.

For the dummy test only:

1. The dummy target wrote `tree.json` containing its known PIDs and edges.
2. The test harness read that target-generated file.
3. The harness invoked `stasis inspect` separately for root, watcher, leaf, and
   server.
4. The test verified relationships by matching each manifest's `ppid` to another
   manifest's `pid`.

`tree.json` is test ground truth. It is not evidence generated by Process Stasis.
If the collector receives only PID 69961 today, it does not discover 69962, 69963,
or 69964 and does not produce a tree object.

## Data not currently collected or produced

- ancestors beyond the one PPID stored in `/proc/PID/stat`;
- children, descendants, or a process-tree bundle;
- per-thread identities or stacks; only the thread count from `status`;
- memory maps, memory contents, core dumps, or environment variables;
- open-file contents or copies of deleted-open files;
- executable or library copies;
- socket protocol, local/remote address, port, state, or owning peer;
- packets, DNS, HTTP, or other network payloads;
- syscalls, library calls, filesystem-change timelines, or persistence mechanisms;
- containment, freezing, cgroup movement, replay, emulation, or deception;
- malicious/benign verdicts, scores, hypotheses, or a human-readable report.

## Historical next output change

The next collector slice should accept one root PID and produce one tree-level
bundle containing:

- a bounded set of discovered nodes;
- explicit parent-child edges;
- one per-node evidence object;
- discovery start/end passes so forks, exits, PID reuse, and incomplete traversal
  are reported rather than hidden;
- a tree completeness field distinct from each node's capture completeness.

That feature was implemented in the separate `0.2.0` desktop observer. The Python
`0.1.0` CLI described in this file still collects one PID at a time.
