# Codex Control Plane

A local-first control plane for running Codex against real Git repositories with an explicit approval gate before any file writes.

## MVP workflow

1. Select a local Git repository and describe a task.
2. Codex analyzes it in `read-only` sandbox mode.
3. The run pauses and displays the analysis.
4. A person approves or rejects write access.
5. Only after approval, Codex continues in `workspace-write` mode inside an isolated Git worktree.
6. The app shows the resulting diff and asks for a second approval.
7. Apply the patch to the original working tree or discard the isolated worktree completely.

## Requirements

- Node.js 20+
- Codex CLI installed and authenticated
- A local Git repository to operate on

## Run locally

```bash
npm start
```

Open <http://127.0.0.1:4310>.

Run the state-machine tests with:

```bash
npm test
```

## Security model

- Repository paths must be absolute and contain a `.git` entry.
- Analysis always starts with `--sandbox read-only`.
- Implementation cannot begin until an explicit approval transition.
- Approved implementation uses `--sandbox workspace-write` in a temporary Git worktree.
- The original working tree must be clean and remains untouched during implementation.
- Applying the final diff requires a separate explicit approval.
- Runs and approval events remain on the local machine under `.codex-control-plane/`.

This is an early MVP. Run it only on repositories you trust and inspect the proposed plan before approving writes.
