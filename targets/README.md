# Benign targets

Targets in this directory are purpose-built fixtures, never live malware.

`observable_target.py` currently exercises:

1. a task name that differs from the Python executable and script command line;
2. a regular file that is unlinked while its descriptor remains open;
3. a loopback-only listening TCP socket;
4. stable executable, working-directory, namespace, credential, and limit metadata;
5. explicit clean signal handling so tests can prove inspection did not stop it.

Later fixtures will separately exercise fork races, rapid descriptor churn, exec
replacement, permission failures, and exit during collection. Those behaviors
should not be folded into one opaque target because each needs an independent
expected-evidence contract.

## Process-tree target

`process_tree_target.py` creates this deterministic tree:

```text
stasis-root
├── stasis-watch
│   └── stasis-leaf     (two threads, deleted-open file)
└── stasis-server       (loopback-only listening socket)
```

Start it in one terminal using a new private runtime directory:

```bash
python3 targets/process_tree_target.py --runtime work/private/tree-target-01
```

After `tree.json` appears, inspect its recorded PIDs from another terminal. Send
`SIGTERM` only to the recorded root PID to stop it; the root performs bounded,
graceful cleanup of its descendants. The automated integration test exercises the
same lifecycle and verifies every node exits.
