# Concept

## The actual problem

When a process looks malicious, both obvious choices can be bad:

- killing it may destroy volatile state and trigger a supervisor, watchdog, or
  remote reaction;
- leaving it running may permit encryption, deletion, persistence, lateral
  movement, or exfiltration.

Process Stasis aims to create a third operational path: stop the process tree from
making progress, preserve what can still be observed, and analyze a reconstruction
inside a controlled environment.

This is decision support, not an automatic verdict engine. The tool should expose
evidence and uncertainty rather than label a process malicious from a single score.

## Refined architecture

### 1. Intake and scope guard

Input is an explicitly authorized PID and a case directory. Before changing state,
the tool records the investigator, reason, host clock, target identity, process
start time, PID namespace, and an initial lightweight snapshot. It must defend
against PID reuse by holding and checking a stable process reference where the
kernel permits it.

### 2. Stasis controller

The controller identifies threads and descendants, places the target tree into a
dedicated cgroup when safe, requests a cgroup v2 freeze, and waits until the kernel
reports the frozen state. A signal-based stop is a documented fallback, not an
equivalent guarantee.

Freezing is containment of CPU execution only. It does not retract data already
sent, cancel remote actions, remove persistence, or make the host trustworthy.
Kernel work already queued on behalf of the process and cooperating processes
outside the frozen tree require separate reasoning.

### 3. Evidence collector

The first prototype should collect read-only metadata before attempting full memory
capture:

- process/thread ancestry, credentials, capabilities, namespaces, cgroups, and
  security labels;
- executable identity, hashes, command line, working directory, root directory,
  memory maps, and loaded objects;
- file descriptors, deleted-but-open files, pipes, sockets, and mount view;
- relevant resource limits, signal state, scheduler data, and timestamps;
- a list of failures and fields that changed or could not be read.

Environment variables, process memory, and copied file contents are opt-in because
they commonly contain credentials and personal data. Raw bundles stay private;
sanitized reports are separate artifacts.

### 4. Reconstruction builder

The builder creates a best-effort analysis package rather than claiming a perfect
clone. It includes the executable, required libraries when legally and safely
collectable, selected files, metadata, and an explicit reconstruction manifest.
External services, kernel objects, secrets, and unavailable files are represented
as gaps or synthetic fixtures.

### 5. Controlled replay guest

High-risk replay belongs in a disposable VM or microVM with:

- no host filesystem mounts;
- no shared clipboard, devices, credentials, or management sockets;
- default-deny egress and a local simulated network;
- CPU, memory, process-count, storage, and wall-clock limits;
- immutable base image, disposable overlay, and post-run artifact export;
- host-side logging that the guest cannot rewrite.

Containers or gVisor can be useful development and compatibility layers, but the
project must state their different trust boundaries. Plain Docker is not the
malware boundary.

### 6. Observation and deception

Observation sources may include guest-side audit/trace data, network capture at the
virtual switch, filesystem-diff snapshots, and host-side VM telemetry.

Deception should begin with coarse environmental fixtures:

- fake DNS answers and local HTTP/TCP services;
- a prepared filesystem and fake user profile;
- controlled clock, hostname, locale, and machine identity;
- deterministic failure or success responses for a small set of operations.

Selective syscall mediation is a later research feature. Seccomp user notification
can broker some syscalls, but it has pointer/race pitfalls and must not be the
security policy. Library-call interposition with `LD_PRELOAD` only affects compatible
dynamically linked programs and can be bypassed by direct syscalls, static linking,
custom loaders, or deliberate evasion.

### 7. Report and decision support

Output should separate facts from interpretation:

- immutable evidence inventory and hashes;
- event timeline;
- observed and denied behaviors;
- reconstruction fidelity and missing state;
- containment status and residual risk;
- hypotheses with confidence and contradictory evidence;
- safe next actions such as continued freeze, host isolation, escalation, or
  controlled termination.

## What is feasible

| Idea | Reality | Place in the project |
|---|---|---|
| Freeze a process tree without killing it | Feasible with caveats using cgroup v2 | Early prototype |
| Preserve `/proc`, descriptors, mappings, and binaries | Feasible, permission- and race-dependent | Early prototype |
| Observe syscalls | Feasible through tracing mechanisms, each with trade-offs | Early-to-middle prototype |
| Fake selected syscall results | Feasible only for a controlled subset; complex and race-prone | Later experiment |
| Intercept every libc call | Not general: programs may bypass libc/interposition | Diagnostic option only |
| Move any already-running process into a container | Not a dependable general operation | Not a product promise |
| Checkpoint/restore a compatible process | Sometimes feasible with CRIU and matching resources | Later compatibility experiment |
| Restore a process directly into a different-kernel VM | Generally not equivalent to migration | Replace with reconstruction/replay |
| Safely run hostile code in plain Docker | Inadequate as the only boundary | Explicitly rejected |

## State model

The tool should use an auditable state machine:

`observed -> freeze_requested -> frozen_verified -> captured -> reconstruction_built -> replayed`

Every transition can also end in `failed_safe`. Thawing, terminating, or isolating
the host are explicit investigator-authorized actions; capture should never silently
resume the process.

## Threat model for the first real prototype

In scope:

- an unprivileged or moderately privileged Linux user-space process;
- forks/threads, misleading names, deleted executables/files, local sockets, and
  ordinary TCP/UDP activity;
- incomplete permissions and evidence that changes during initial observation;
- synthetic anti-analysis behavior.

Initially out of scope:

- a compromised kernel, hypervisor, firmware, or hardware;
- kernel modules and eBPF rootkits;
- already-root malware as a safely containable same-host target;
- Windows/macOS, non-x86-64, GPU/device-heavy processes, and distributed state;
- guaranteed transparent replay or automatic attribution.

## Design questions to resolve with experiments

1. Can the full descendant set be moved and frozen without a fork/exit race, and
   how will unavoidable gaps be reported?
2. Which evidence is reliable from `/proc` while the task is frozen, and which
   requires ptrace or another privileged mechanism?
3. What is the smallest useful reconstruction manifest?
4. Should the first replay backend be a conventional KVM/QEMU guest for easier
   inspection or Firecracker for a smaller device model?
5. Which five environmental interactions are most valuable to simulate first?
6. What evidence format remains useful to both a human investigator and later
   automated detectors?
