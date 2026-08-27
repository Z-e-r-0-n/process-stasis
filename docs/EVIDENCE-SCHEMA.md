# Evidence bundle schema 0.1

Phase 1 writes one `manifest.json`. The machine-readable definition is
[`schemas/evidence-bundle-v0.1.schema.json`](../schemas/evidence-bundle-v0.1.schema.json).

## Top-level fields

| Field | Meaning |
|---|---|
| `schema_version` | Evidence contract version, initially `0.1`. |
| `capture` | Start/end UTC and monotonic timestamps, completeness, and collector identity. |
| `target` | Requested PID, stable identity checks, and top-level process facts. |
| `artifacts` | Bounded observations such as command line, links, namespaces, descriptors, status, cgroup, and executable hash. |
| `errors` | Structured failures with stage, source, error kind, and safe message. |

## Phase 1 data policy

Collected by default:

- PID, parent PID, state, kernel start ticks, comm, command-line arguments;
- `/proc/PID/exe`, `cwd`, and `root` link text;
- selected normalized status fields and raw `status`, `cgroup`, and `limits` text;
- namespace link identifiers;
- descriptor numbers and link targets;
- SHA-256 of the executable when readable;
- capture timing, procfs identity recheck, and all collection errors.

Not collected in Phase 1:

- environment variables;
- process memory or core dumps;
- contents of open descriptors or arbitrary target files;
- packet payloads;
- unrelated processes in the same network namespace;
- automatic copying of the executable or libraries.

## Completeness

`capture.complete` is true only when:

- the target existed at the beginning;
- its start-time identity was parsed;
- the same identity remained visible at the final check; and
- no required field failed.

Optional fields can fail while still producing a bundle, but each failure remains in
`errors`. Schema validity means the bundle is structurally readable; it does not
mean the evidence is complete. A complete Phase 1 bundle also is not an atomic
snapshot: a running process can change executable image, descriptors, mappings, or
other state between individual reads without changing PID start time.

## Safety properties

- The manifest is created with mode `0600` inside a case directory created with
  mode `0700`.
- Output is written to a temporary file and atomically replaced after serialization.
- Target-provided bytes are decoded with escaped replacement where necessary; JSON
  serialization prevents terminal control bytes from being emitted as raw output.
- The CLI prints only bundle location and completion status, not target strings.
- Inspection performs no intentional target-state mutation, but procfs access and
  executable hashing can affect audit logs, caches, or filesystem access times.
