# Operating architecture

## Product boundary

Process Stasis is three related workflows, not one transparent migration trick:

1. **Inspect** reads evidence from an authorized live process without changing its
   execution state.
2. **Stasis** explicitly freezes a controlled process group, verifies the freeze,
   and captures evidence without silently resuming it.
3. **Replay** builds a declared reconstruction and starts it inside a disposable
   analysis VM. Replay is not represented as continuation of the original process.

Inspect and the evidence/case workflow are implemented. Stasis can create a
managed cgroup for a new command or acquire a visible existing tree through a
bounded stop/rescan/move transaction before verified freeze. Replay remains
disabled until its VM and network boundary exist.

## End-to-end data flow

```mermaid
flowchart LR
    O[Authorized operator] -->|PID, case metadata| CLI[Unprivileged CLI]
    CLI -->|read-only request| C[Evidence collector]
    C -->|procfs and stable identity checks| P[Live process]
    C -->|bundle v0.1| E[(Private evidence store)]

    CLI -->|bounded JSON through Polkit| S[Small privileged stasis controller]
    S -->|acquire + verified cgroup freeze| P

    E -. selected artifacts + fidelity manifest .-> B[Reconstruction builder]
    B -. run package .-> R[VM runner]
    R --> V[Disposable analysis VM]
    N[Isolated network simulator] <--> V
    V --> T[Guest telemetry]
    R --> H[Host-side telemetry]
    T --> A[Timeline and report]
    H --> A
    E --> A
```

The inspect/evidence and controller arrows are implemented. VM/replay arrows
remain later phases.

## Trust boundaries

```mermaid
flowchart TB
    subgraph Host[Trusted analysis host]
        CLI[CLI and report renderer]
        COL[Unprivileged collector]
        STORE[(Private evidence)]
        CTRL[Minimal privileged controller]
        VMM[VM runner / VMM]
        SIM[Network simulator]
    end

    subgraph Target[Potentially hostile live state]
        PROC[Target process tree]
        PROCFS[Target-controlled strings and metadata]
    end

    subgraph Guest[Disposable untrusted guest]
        SAMPLE[Reconstructed program]
        SENSOR[Guest sensors]
    end

    COL --> PROCFS
    COL --> STORE
    CTRL --> PROC
    STORE --> VMM
    VMM --> SAMPLE
    SIM <--> SAMPLE
    SENSOR --> VMM
```

Anything read from `/proc`, copied from the target, or exported from the guest is
hostile input. Parsers must be bounded and must not execute, import, render as HTML,
or follow paths supplied by that input. The later privileged controller must not
parse evidence or build reports.

## Inspect workflow

```mermaid
stateDiagram-v2
    [*] --> ScopeChecked
    ScopeChecked --> IdentityPinned: open pidfd when available
    IdentityPinned --> Collecting: record PID start time
    Collecting --> IdentityVerified: read start time again
    IdentityVerified --> BundleWritten: identity unchanged
    IdentityVerified --> PartialBundle: process exited or identity changed
    Collecting --> PartialBundle: individual reads fail
    BundleWritten --> [*]
    PartialBundle --> [*]
```

Inspect never sends a signal, changes a cgroup, opens process memory for writing, or
copies arbitrary file contents. Individual collection failures become structured
errors. A target that exits during capture produces a partial result rather than a
false complete result. Read-only does not mean zero observer effect: procfs reads,
executable hashing, page-cache activity, audit records, and filesystem access-time
policy can still leave traces.

## Stasis workflow

Stasis is intentionally a separate, explicit command because it changes system
state.

```mermaid
stateDiagram-v2
    [*] --> IdentityChecked
    IdentityChecked --> TreeStopped
    TreeStopped --> TreeStable: bounded rescan
    TreeStable --> GroupAcquired: move + exact membership
    GroupAcquired --> FreezeRequested
    FreezeRequested --> FrozenVerified: cgroup.events frozen=1
    FreezeRequested --> FailedSafe: timeout or lost control
    FrozenVerified --> Captured
    Captured --> AwaitingDisposition
    AwaitingDisposition --> Thawed: explicit operator action
    AwaitingDisposition --> LeftFrozen: handoff to incident response
```

The current controller rejects PID 1 and the desktop's own process tree, checks
start-time identity before moving each PID, limits discovery to 4,096 members and
twelve stabilization rounds, and rolls partial acquisition back to recorded
original cgroups. It verifies `cgroup.events` after freeze and resume. Managed
launch creates the cgroup before the child execs and drops back to the requesting
desktop user's credentials.

## Replay workflow and network boundary

```mermaid
flowchart LR
    E[(Evidence bundle)] --> F[Fidelity selection]
    F --> M[Reconstruction manifest]
    M --> I[Immutable guest base + disposable overlay]
    I --> VM[Analysis VM]
    VM -->|DNS/HTTP/TCP only| SIM[Local simulator]
    VM -. blocked .-> INTERNET((Internet))
    VM --> DIFF[Filesystem diff]
    VM --> EVENTS[Process/syscall events]
    VM --> PCAP[Packet capture]
    DIFF --> REPORT[Correlated report]
    EVENTS --> REPORT
    PCAP --> REPORT
    M --> REPORT
```

The VM receives no host directories, user credentials, clipboard, USB/GPU devices,
container-engine socket, or unrestricted management channel. Export occurs only
after execution stops, through a bounded artifact path controlled by the runner.

## Evidence lifecycle

1. A case directory is created with owner-only permissions.
2. The collector writes a temporary manifest in that directory.
3. After collection and identity verification, the file is flushed and atomically
   renamed to `manifest.json`.
4. The manifest records capture start/end times, completeness, errors, and hashes.
5. Raw bundles stay under `work/private/` or an operator-selected protected path.
6. A separate later command creates a sanitized report; raw strings are never
   assumed safe to publish.

## Failure rules

- Missing permissions produce a partial bundle, never fabricated empty fields.
- PID exit or identity mismatch marks the capture incomplete.
- Unsupported kernel controls disable the corresponding action.
- A failed or unverified freeze never transitions to `frozen`.
- Replay never receives Internet access as a compatibility fallback.
- A simulator failure stops or isolates replay; it does not route around it.
- No component automatically kills or labels the target malicious.

## Component ownership

| Component | Privilege | Responsibility | Must not do |
|---|---:|---|---|
| CLI | User | Validate operator input and select an explicit workflow | Infer authorization or hide warnings |
| Collector | User by default | Read and normalize bounded process evidence | Signal, attach for writing, or execute target data |
| Stasis controller | Narrow elevated helper | Launch/acquire a tree, create/control cgroup, and verify state | Parse reports, access network, terminate a target, or render UI |
| Evidence store | Owner-only | Preserve versioned raw bundles and integrity metadata | Serve unescaped data to a browser |
| Builder | User | Select artifacts and record reconstruction fidelity | Claim a fresh launch is continuation |
| VM runner | Elevated only where required | Enforce guest, resource, and network boundaries | Mount home directories or silently enable egress |
| Simulator | Isolated service account/guest | Return deterministic fake network responses | Relay to real destinations |
| Correlator | User | Normalize telemetry and report uncertainty | Make an automatic malware verdict |
