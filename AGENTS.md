# Process Stasis working agreements

## Purpose

This repository explores a defensive Linux incident-response tool that preserves
evidence from a suspicious process, contains further impact, and reconstructs a
controlled execution for analysis.

## Safety and scope

- Work only on systems and processes explicitly authorized by their owner.
- Use purpose-built synthetic targets or inert samples during development.
- Do not commit, download, or execute live malware in this repository.
- Do not treat containers, syscall interception, or user-space emulation as the
  sole security boundary for hostile code. Use a disposable VM boundary for any
  future high-risk execution.
- Default to no network egress. Any simulated network service must be local to an
  isolated lab and must not relay traffic to the Internet.
- Treat captured memory, environment variables, command lines, open files, and
  network metadata as potentially sensitive. Keep raw evidence under `work/private/`.
- Never collect from unrelated host processes or users.

## Engineering rules

- Linux-only and x86-64-first until the prototype is coherent.
- Keep the privileged capture component small and separate from parsers, reports,
  and the analysis UI.
- Fail closed when an isolation control is unavailable or its state cannot be
  verified.
- Record hashes, timestamps, tool versions, errors, and collection limitations.
- Prefer structured, versioned evidence formats and deterministic synthetic tests.
- Add exact setup, test, lint, and build commands here once an implementation
  language and toolchain are selected.

## Interface direction

- Follow `docs/UI-DIRECTION.md` for visual and interaction work.
- Do not use a neon-green “cybersecurity dashboard” treatment. Prefer neutral,
  readable surfaces with restrained role-based accent colors.
- Keep one primary analysis task visible at a time. Details belong in dedicated
  views, not inside every graph node or a permanently crowded side panel.
- Do not ship placeholder controls. Remove an action until it has a working path.

## Repository layout

- `docs/`: concept, decisions, research, and roadmap.
- `targets/`: future benign programs designed to exercise observable behavior.
- `work/private/`: future ignored raw evidence from authorized labs.

## Repository commands

- Install desktop dependencies: `npm install`
- Run the Tauri desktop app: `npm run dev`
- Run the synthetic browser preview: `npm run dev:web`
- Type-check and build: `npm run typecheck && npm run build:web`
- Format/check/test Rust:
  `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check && cargo test --manifest-path src-tauri/Cargo.toml`
- Build `.deb` and `.AppImage`: `npm run tauri build`
- Run tests: `pytest`
- Run a read-only inspection from the source tree:
  `PYTHONPATH=src python3 -m process_stasis inspect --pid PID --output NEW_CASE_DIR --reason REASON --ack-authorized`
- Start the benign process-tree target in the foreground:
  `python3 targets/process_tree_target.py --runtime NEW_PRIVATE_RUNTIME_DIR`

The output directory must not already exist. Use only an explicitly authorized PID.

## GitHub continuity

- The canonical public remote is `Z-e-r-0-n/process-stasis`.
- Finish coherent code changes with the relevant checks, a descriptive commit,
  and a push to the canonical remote when it is reachable.
- Never commit or push `work/private/`, runtime captures, exported sessions,
  credentials, build directories, packages, or other host-derived evidence.
- Do not use a filesystem watcher that blindly commits every local change.
  Review the staged diff before every public push.
