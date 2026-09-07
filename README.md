# Codex Control Plane

A local-first control plane for running Codex against real Git repositories with explicit approval before Codex modifies project files.

## Implementation workflow

1. Select a local Git repository and describe a task.
2. Codex analyzes it in `read-only` sandbox mode.
3. The run pauses and displays the analysis.
4. A person approves or rejects write access.
5. Only after approval, Codex continues in `workspace-write` mode inside an isolated Git worktree.
6. The app shows the resulting diff and asks for a second approval.
7. Apply the patch to the original working tree or discard the isolated worktree completely.

The dashboard streams Codex JSON events over Server-Sent Events. Active runs can be cancelled, and failed or cancelled phases can be retried without restarting the whole application.

## v0.2.0: setup diagnostics and read-only reviews

The **Environment** panel checks Git, Codex CLI, local credential status and the task-data directory. It shows the resolved executable paths, versions and actionable setup hints. **Check again** reruns the checks after you fix a missing tool or complete login in a terminal.

The same checks run without starting the server or installing Electron:

```bash
npm run doctor
# Machine-readable output
node scripts/doctor.mjs --json
```

A successful local check exits with code `0`; missing tools, an unconfirmed login or inaccessible storage produce code `1`. The check uses `codex --version` and `codex login status`, has bounded output and timeouts, and does not return raw authentication output. Login status confirms locally stored credentials; it does not validate service connectivity, quota or a future model request. See the [official Codex command reference](https://learn.chatgpt.com/docs/developer-commands).

If desktop launch cannot find a tool, expand **Configure executable paths** and enter its absolute path. Empty values use automatic detection, including common macOS Homebrew and local-bin locations. Save paths after pending tasks have finished, been rejected or discarded, or cancelled. No application restart is needed for saved paths. Environment variables `CODEX_CONTROL_PLANE_GIT_BIN` and `CODEX_CONTROL_PLANE_CODEX_BIN` take precedence over saved paths and require restarting the runner after changes. On Windows, select the native `git.exe` and `codex.exe`; `.cmd` and `.bat` wrappers are not supported. The app executes tools directly without interpolating task text into a shell.

Select **Read-only review** in a new task, or choose the built-in **Code review** template. Codex reviews the committed repository snapshot in an isolated worktree with `--sandbox read-only`, returns a report, and the task completes without requesting write access. The worktree is cleaned up after a successful review. Review tasks cannot be approved for implementation or applied to the source repository, including after a retry. Reports display completed agent messages while preserving the original event history.

To upgrade from 0.1.0, finish or stop active work, quit the existing runner, pull the code and start it again:

```bash
git pull --ff-only
npm run doctor
npm start
```

The dashboard can open even if the doctor reports a missing Codex setup; configure it before starting a task. Existing projects, templates, budgets and history remain in place. Saved runs without a task mode retain the implementation workflow. Runtime paths are stored in `runtime.json` alongside other app data. Source/browser mode uses `.codex-control-plane/`; packaged desktop mode uses the directory shown in the Environment panel. To diagnose that directory from the source checkout, set `CODEX_CONTROL_PLANE_DATA_DIR` to the displayed path. If the browser shows an update notification, use **Reload** to load the new interface.

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

If port `4310` is already occupied, the desktop app or another local Runner may already be active. Open the URL first, inspect the listener with `lsof -nP -iTCP:4310 -sTCP:LISTEN`, or start an independent instance with `PORT=4311 npm start`.

Run the runtime, state-machine and simulated-Codex integration tests with:

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

## Reliability and recovery

The Runner now saves JSON snapshots sequentially using temporary files and atomic replacement. Unreadable or malformed saved data stops startup with its original file preserved. A failed port bind never restores queued jobs. Use one Runner per data directory; a different port alone does not isolate the stored state.

Task actions are serialized per repository. Retry and history deletion wait for the previous phase to stop; rejected write access requires fresh analysis and approval. Applying a diff checks its approval state, original branch, HEAD and clean index before applying, and repeated application is rejected. Old pending diffs without a saved baseline must be discarded and regenerated.

SSE reconnects receive a current snapshot, and failed requests appear in an error banner. Service-worker registration failure does not block the console. Browser mode needs only Node and Git: `npm start` does not require downloading Electron. Desktop mode remains `npm install` followed by `npm run desktop`. Quit (or SIGINT/SIGTERM in browser mode) stops managed Codex processes, waits for their phase cleanup, and saves state. Native Electron behavior and signed installer distribution still require platform testing.

Every push to main and pull request now runs dependency-free runtime checks on Linux, macOS and Windows. The POSIX HTTP/worktree integration test uses a simulated Codex executable and makes no model requests. Windows installer and portable EXE assets have distinct names.
