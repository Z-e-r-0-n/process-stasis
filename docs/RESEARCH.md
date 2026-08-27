# Research notes

Checked on 2026-08-15. These are design inputs, not claims that every host supports
every feature.

## Primary references

- [Linux cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html):
  `cgroup.freeze` stops a cgroup and descendants, and `cgroup.events` reports when
  the frozen state is reached. The documentation also describes races involving
  processes entering or leaving a frozen cgroup.
- [Linux seccomp filter documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html):
  seccomp reduces exposed syscall surface and user notification can send selected
  syscalls to a supervisor; pointer arguments require careful handling because of
  time-of-check/time-of-use risk.
- [seccomp user-notification manual](https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html):
  the notification/continue mechanism must not itself implement the security policy.
- [Linux Landlock userspace API](https://docs.kernel.org/userspace-api/landlock.html):
  unprivileged processes can add restrictions over filesystem and selected network
  access; it complements rather than replaces other controls.
- [CRIU project documentation](https://criu.org/Main_Page): CRIU can checkpoint a
  compatible application or container and later restore it. This supports a bounded
  experiment, not a promise of universal transplantation.
- [gVisor architecture](https://gvisor.dev/docs/): gVisor intercepts application
  syscalls and implements a userspace application kernel, trading compatibility and
  syscall overhead for a reduced host-kernel interface.
- [gVisor compatibility documentation](https://gvisor.dev/docs/user_guide/compatibility/):
  many workloads work, but Linux API gaps remain and must be tested per target.
- [Firecracker project documentation](https://firecracker-microvm.github.io/):
  Firecracker uses KVM microVMs and a companion jailer as an additional isolation
  layer. It is a candidate backend after a conventional VM prototype is understood.

## Current decisions

- Start with observation, not emulation.
- Capture and replay are separate operations with separately stated fidelity.
- A verified cgroup freeze is useful evidence preservation, not complete incident
  containment.
- VM isolation and default-deny networking remain in force even when syscall
  mediation is enabled.
- CRIU and gVisor are compatibility experiments/backends, not interchangeable with
  a hardware-virtualized trust boundary.
