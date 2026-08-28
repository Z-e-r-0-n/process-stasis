# Architecture decisions

These decisions define the first coherent product. A decision can change after an
experiment, but the replacement must record why.

| ID | Decision | Reason |
|---|---|---|
| D001 | Target Linux x86-64 first | It matches the learning environment and avoids hiding ABI differences. |
| D002 | Expose Inspect, Stasis, and Replay as separate workflows | Read-only inspection, state-changing containment, and hostile execution have different authorization and failure models. |
| D003 | Make Inspect the only Phase 1 command | It produces useful evidence without pretending containment already exists. |
| D004 | Use Python and the standard library for the first collector | Fast iteration, no new runtime dependencies, and readable procfs parsing. |
| D005 | Reserve Rust for the later privileged controller | Memory safety is valuable at the privilege boundary after the Linux interface is experimentally understood. |
| D006 | Use a versioned JSON manifest and owner-only case directory | JSON supports inspection and future tooling; versioning prevents silent semantic changes. |
| D007 | Treat each field as available, unavailable, or failed | Empty data is not equivalent to an access denial, race, unsupported field, or exited process. |
| D008 | Use pidfds when available and verify `/proc/PID/stat` start time | This narrows PID reuse risk without claiming the process cannot exit during capture. |
| D009 | Do not collect environment, memory, or open-file contents by default | Those sources frequently contain credentials and unrelated personal data. |
| D010 | Build controlled-cgroup stasis before arbitrary-process attachment | A process launched in the group starts inside the declared control boundary; retrofitting a live tree is race-prone. |
| D011 | Require explicit operator disposition after a verified freeze | Capture must never silently thaw or kill the original process. |
| D012 | Use conventional QEMU/KVM for the first replay lab | It is easier to inspect and learn before optimizing toward a microVM backend. |
| D013 | Use a fresh reconstruction launch as the normal replay model | It is testable and can report fidelity honestly; universal live migration is not feasible. |
| D014 | Keep CRIU as a later compatibility experiment | Checkpoint/restore depends on process and kernel-managed resources and cannot be a universal promise. |
| D015 | Keep syscall mediation inside an already isolated guest | Mediation is an analysis feature, not the containment boundary. |
| D016 | Default replay networking to local simulation with no egress | Compatibility failure must not expose the Internet or real services. |
| D017 | Keep the first interface as a CLI | It makes actions, logs, tests, and privilege transitions easier to audit than an early web UI. |
| D018 | Never produce an automatic malicious/benign verdict | The product exposes evidence, gaps, behavior, and hypotheses for an investigator. |
| D019 | Keep original observations append-only and case annotations in a sidecar | Notes and bookmarks must not rewrite captured evidence. |
| D020 | Label lifecycle provenance and confidence in both UI and export | Procfs diffs must not be mistaken for kernel audit events. |
| D021 | Reopen only bounded owner-only journals with canonical UUID names | Persistent cases should survive restart without accepting arbitrary paths or symlinks. |
| D022 | Permit freeze/thaw only for an already-exclusive cgroup subtree | Exact recursive membership avoids freezing unrelated processes and does not pretend live migration is atomic. |
| D023 | Require active evidence recording before a containment action | Every state change needs a request and verified result in the native journal. |
| D024 | Keep network restriction visibly unavailable until a separate helper exists | Elevating the full WebView or implying container isolation would violate the trust boundary. |

## Deferred choices

- Guest distribution and image build system.
- Exact VM-to-simulator network topology.
- Host/guest telemetry mechanism for Phase 4.
- Memory acquisition mechanism and privacy workflow.
- Supported subset, if any, for attaching Stasis to an arbitrary existing tree.
- Whether Firecracker or gVisor becomes a second replay backend.
