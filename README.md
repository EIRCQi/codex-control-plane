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

The dashboard streams Codex JSON events over Server-Sent Events. Active runs can be cancelled, and failed or cancelled phases can be retried without restarting the whole application.

## Usage monitoring

The local Usage overview reads token counts and model metadata from Codex completion events. It reports input, cached input, output and total tokens, plus measured Codex process runtime per task and in aggregate. It does not estimate dollar cost because ChatGPT-authenticated Codex usage does not map directly to API per-token pricing.

## Guardrails

The local settings panel controls maximum concurrent Codex phases, tokens per run, and cumulative tokens per repository. Runs wait in a queue when all concurrency slots are occupied. A repository at quota cannot start another task, and an active run is stopped when an incoming usage event crosses a configured limit. Set either token limit to `0` for unlimited.

## Projects and templates

Register trusted local Git repositories once, then choose them by name when starting a task. Registration stores only the absolute path, current branch, optional origin URL and last-used time; removing a project never deletes repository files. Three built-in templates cover feature implementation, diagnosis/fixes and code review. Custom templates must include a `{{task}}` placeholder and remain local under `.codex-control-plane/`.

## Run history

Search runs by task text or repository and filter by state, project or archive status. The run detail view combines workflow events, Codex JSON events, token/runtime usage and the generated diff. Finished runs can be archived or restored. Deleting a finished history record removes only local control-plane metadata and any remaining isolated worktree; it never deletes the registered repository.

## Notifications

The notification center keeps the latest 50 approval and run-result alerts in the browser, with unread counts and direct links to run details. Optional desktop alerts cover write approvals, diff reviews, successful completion, failures, cancellations and budget stops. Notification preferences and history stay in browser-local storage; permission is requested only after clicking **Enable desktop alerts**.

## Installable app

Browsers with PWA support can install the local dashboard into a standalone application window from the **Install app** button. A service worker caches only the static application shell; API responses, run history and the live SSE stream are deliberately never cached. The local Node runner must remain running for repository access and task execution.

## Desktop runner and system tray

Install development dependencies once with `npm install`, then start the native desktop shell with `npm run desktop`. Electron starts the same local control server, opens an isolated renderer window and adds a system tray menu. Closing the window hides it while the Runner and active Codex tasks continue; use **Quit** in the tray menu to stop the application. The tray can also reopen the window or launch the dashboard in the default browser.

## Desktop installers

Run `npm run dist` to generate the 512px icon and build the installer for the current operating system. The configured targets are DMG/ZIP for macOS, NSIS/portable EXE for Windows, and AppImage/DEB for Linux. Packaged applications store runs, settings, projects and templates in Electron's per-user application-data directory rather than inside the read-only application bundle.

The **Build desktop installers** GitHub Actions workflow can be started manually or by pushing a `v*` tag. It builds unsigned artifacts on native macOS, Windows and Linux runners and attaches them to the workflow run. Public distribution still requires platform-specific code-signing and, on macOS, notarization credentials.

Tag builds additionally verify that the tag matches `package.json`, generate SHA-256 checksums and provenance attestations, and create or update a GitHub Release. See [`docs/RELEASING.md`](docs/RELEASING.md) for the release checklist and verification commands.

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
- Live event history is capped at the latest 500 events per run.
- Cancellation first sends `SIGTERM`, then escalates to `SIGKILL` if the process does not exit.

This is an early MVP. Run it only on repositories you trust and inspect the proposed plan before approving writes.
