# Learning and build roadmap

Each phase produces a small artifact. The existing `systems-security-lab` remains
the place to learn and demonstrate foundations; this repository turns demonstrated
knowledge into a product prototype.

## Phase 0: process investigation foundations

Learn:

- processes versus threads, parentage, sessions, process groups, signals, and PID
  reuse;
- `/proc`, file descriptors, deleted-open files, sockets, credentials, capabilities,
  namespaces, and cgroups;
- evidence quality, timestamps, hashing, volatile state, and collection side effects.

Artifact: independently investigate the benign unfamiliar-process scenario and
write a sanitized report. The cold investigation and independent variation have
passed; the concise sanitized case study remains to be written in
`systems-security-lab`.

## Phase 1: read-only evidence bundle

Build a CLI that accepts a PID and writes a versioned JSON manifest plus sanitized
summary. Use only a purpose-built target. It should handle exited processes,
permission failures, PID reuse, deleted executables, and partial reads honestly.

Learn: Python or Go for the initial collector, Linux procfs semantics, schemas,
tests, and safe filesystem handling.

Exit test: repeated runs against deterministic targets produce valid bundles and
never signal or mutate the target.

## Phase 2: controlled launch and verified freeze

Launch a benign target directly into a dedicated cgroup, freeze the entire group,
verify the kernel-reported state, collect evidence, and leave the group frozen until
the operator explicitly chooses its disposition.

Learn: cgroup v2 delegation, systemd interaction, capabilities, pidfds, race testing,
resource limits, and privilege separation.

Exit test: fork-heavy synthetic targets cannot escape the declared scope without a
recorded failure, and loss of a control surface fails closed.

## Phase 3: isolated replay baseline

Create a disposable KVM/QEMU analysis guest with an immutable base, per-run overlay,
no Internet egress, and artifact export. Replay purpose-built ELF programs from
their entry point using a declared fixture set; do not attempt live restoration yet.

Learn: ELF and dynamic linking, Linux boot/userspace, KVM/QEMU networking and disk
images, VM threat boundaries, reproducible images, and snapshot lifecycle.

Exit test: a synthetic target can modify only its disposable guest, and its network
traffic reaches only the simulator and capture point.

## Phase 4: behavioral observation and environment simulation

Add a filesystem diff, process tree, syscall/event stream, packet capture, fake DNS,
and one local HTTP service. Correlate all observations on a timeline.

Learn: syscall ABI, tracing choices (`ptrace`, audit, eBPF, or guest-native tracing),
DNS/TCP/HTTP, clock synchronization, event normalization, and backpressure.

Exit test: known actions by synthetic targets appear once, in order, with source and
confidence; dropped events are measured rather than hidden.

## Phase 5: selective mediation experiment

Inside the already isolated guest, mediate a very small allowlist of syscalls and
return deterministic values or file descriptors. Separately demonstrate the limits
of `LD_PRELOAD` using dynamic, static, and direct-syscall test programs.

Learn: seccomp BPF/user notification, syscall argument memory, TOCTOU risks, file
descriptor injection, ABI/architecture checks, and adversarial testing.

Exit test: the feature cannot weaken the VM/network containment boundary, and every
synthetic response is visible in the report.

## Phase 6: optional checkpoint/restore research

Test CRIU only on a compatibility matrix of benign programs: single process,
threads, files, pipes, loopback sockets, external TCP, namespaces, and deleted
files. Treat failures and external dependencies as the result.

Learn: process memory and kernel-managed state, checkpoint images, restore
requirements, namespaces, and migration compatibility.

Exit test: publish a precise supported subset; never silently fall back from
checkpointed state to a fresh execution while calling it equivalent.

## Recommended language order

1. Use Python for experiments and fixtures because iteration and evidence parsing
   matter more than performance at first.
2. Learn enough C to understand syscalls, ELF, ptrace/seccomp examples, memory, and
   ABI boundaries.
3. Move the small privileged controller to Rust only after the interfaces and
   invariants are understood. Rust improves memory safety but does not remove Linux
   race conditions or privilege-design mistakes.
4. Add eBPF only when a concrete visibility gap justifies its complexity.

## Current build slices

1. **P1.1 — Identity and bundle skeleton (complete):** pin identity with a pidfd where
   available, parse start time safely, write an owner-only atomic JSON manifest,
   and preserve partial failures.
2. **P1.2 — Core procfs observations (complete):** command line, links, status, cgroup,
   limits, namespaces, descriptors, and executable hash.
3. **P1.3 — Synthetic integration targets (complete):** exercise misleading task
   names, a nested process tree, multiple threads, a deleted-open file, a
   loopback-only socket, and stable wait states.
4. **P1.4 — Network ownership:** correlate socket descriptor inodes with bounded
   entries from the target network namespace without reporting unrelated sockets.
5. **P1.5 — Schema validation and sanitized summary:** validate bundle `0.1`, add a
   separate publishable report, and document collection side effects.
6. **P2.1 — Controlled launcher:** only after Phase 1 passes, launch a benign target
   into a delegated cgroup and verify its membership from birth.

## Desktop product milestones

- **0.3 — identity and recording (complete):** pidfd/start-time identity, scoped
  descendants, retained exits, and crash-tolerant owner-only JSONL recording.
- **0.4 — investigation workspace (complete in 0.7):** reopen journals, searchable
  timeline, provenance filters, bookmarks/notes, and snapshot comparison.
- **0.5 — event-source contract (partial):** lifecycle provenance and capability
  reporting are implemented; a kernel fork/exec source is not installed and the
  UI/export say so explicitly.
- **0.6 — evidence workflow (complete in 0.7):** persistent case metadata, journal
  integrity hash, inspection/control inventory, redacted JSON, and escaped HTML.
- **0.7 — containment gate (complete for existing exclusive cgroups):** verified
  cgroup v2 freeze/thaw with exact recursive membership, authorization reason,
  active recording, and request/result audit trail. Controlled launch and network
  restriction remain separate safety milestones.
