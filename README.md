# Process Stasis

Process Stasis is a Linux desktop application for live process intelligence. Give
it a PID and it builds a temporal family graph, streams resource telemetry,
retains processes after exit, follows known surviving children, exposes deep
procfs evidence, and exports a structured investigation session.

Version `0.8.0` adds a root-only helper behind the unprivileged desktop. It can
briefly stop and stabilize a visible process tree, move that tree into a
dedicated cgroup v2, freeze or resume it, and verify the resulting kernel state.
It can also launch a command inside a dedicated group from birth. The WebView
itself does not run as root.

## Implemented desktop workflow

1. Search by PID, task name, or command and select a visible process.
2. Pin each tracked identity with a Linux pidfd when available, plus boot ID,
   PID, and start-time ticks.
3. Display visible ancestors as context and recursively track only the selected
   process and its descendants.
4. Sample the known family every 500 ms, use pidfds for exit identity where
   permitted, and label inferred spawn/exec lifecycle events by source and confidence.
5. Preserve exited nodes and follow known live descendants after focus-process exit.
6. Inspect status, executable hash and filesystem metadata, observer-relative
   namespace differences, descriptors, sockets, maps, I/O, cgroups, limits,
   security context, and masked environment values.
7. Record into an owner-only native journal; preserve deep inspections and
   control actions; reopen sessions after restart.
8. Search/filter the timeline, bookmark evidence, write case notes and tags,
   compare graph snapshots, and export redacted JSON or a readable HTML report.
9. Start the evidence journal automatically when Control is used, acquire the
   visible live tree through a Polkit-elevated helper, and verify freeze/thaw
   through `cgroup.events`.
10. Capture a bounded deep inspection for acquired members immediately after a
    successful freeze.

Start with [`docs/TECHNICAL-OVERVIEW.md`](docs/TECHNICAL-OVERVIEW.md) for the
complete working model, technology stack, component map, runtime data flow,
privilege boundary, containment transaction, packaging model, and current limits.
The exhaustive collection fields, workflow, and export contract are in
[`docs/DESKTOP-WORKFLOW.md`](docs/DESKTOP-WORKFLOW.md). The older `0.1` Python
snapshot collector is documented in
[`docs/CURRENT-WORKFLOW.md`](docs/CURRENT-WORKFLOW.md).

## Run the desktop application

Required on Ubuntu-family Linux systems:

```bash
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  libsoup-3.0-dev libayatana-appindicator3-dev patchelf
```

Then from the repository root:

```bash
npm install
npm run dev
```

Create release packages with:

```bash
npm run tauri build
```

The `.deb` and `.AppImage` are written under
`src-tauri/target/release/bundle/`.

Procfs visibility depends on the current user, `hidepid`, ptrace policy, and
process exit timing. Control normally triggers one desktop Polkit prompt; there
is no reason field or acknowledgement form in the application.

## Browser-only UI preview

```bash
npm run dev:web
```

Open `http://127.0.0.1:1420`. Outside Tauri, the interface uses an animated
synthetic process family and does not inspect host processes.

## Verification

```bash
npm run typecheck
npm run build:web
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
pytest -q
```

## Benign process-tree target

For an authorized local demonstration:

```bash
runtime=$(mktemp -d /tmp/process-stasis-target.XXXXXX)
python3 targets/process_tree_target.py --runtime "$runtime"
```

The foreground target creates `stasis-root`, `stasis-watch`, `stasis-leaf`, and
`stasis-server`. The server listens only on loopback, and the leaf retains one
deleted-open test file. Stop it with `Ctrl+C` after testing.

## Architecture boundary

The desktop uses React, React Flow, Anime.js, uPlot, and a Rust Tauri backend.
Procfs polling remains explicit because short-lived processes can be missed; this
build does not install an eBPF or process-connector collector. The same executable
has a non-GUI helper entry point invoked by `pkexec`; it accepts a bounded JSON
request on standard input, validates PID start time again as root, and exposes
only managed launch, tree acquisition, freeze, and thaw. Network isolation,
syscall mediation, VM replay, and checkpoint/restore remain separate components.

## Packages and compatibility

- The `.deb` is the preferred package for current Kali Rolling and compatible
  Debian-family x86-64 systems. Install it with `sudo apt install ./PACKAGE.deb`
  so the package manager resolves GTK, WebKit, and GStreamer dependencies.
- AppImages carry most runtime libraries but still depend on the build system's
  glibc baseline. Do not describe an AppImage as broadly portable until it has
  been built and tested on the oldest supported distribution.
- Install packages with elevated privileges, but run the application as the
  desktop user. Process Stasis elevates only its helper entry point when a
  managed launch or Control action needs it.
