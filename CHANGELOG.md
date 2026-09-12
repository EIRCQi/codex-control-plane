# Changelog

## 0.8.0 — 2026-09-12

- Split the long dashboard into mounted workspace pages for tasks, projects, usage, environment, settings and sign-in/help. Added hash navigation, direct page entry, browser history handling and per-page scroll restoration without rebuilding forms. The task page now shows a compact readiness guide, a failed-task metric, clearer status accents and a saved list-density choice.
- Added a report reading mode with a small Markdown subset: headings, flat/indented lists, blockquotes, tables, inline code, fenced code and web links. Escape all content and preserve raw HTML as text; images never create network requests. Source view, copying and downloads retain the original report. Unchanged reports retain their DOM and reading position across live updates.
- Added a file-based patch viewer with path filtering, change counts, old/new line numbers, C-quoted UTF-8 path decoding, binary/rename metadata, wrapping and 500-line display increments. Filtering is presentation-only; applying, copying and downloading still use the complete patch. Selected files and reading positions survive unrelated live events.
- Fixed detail navigation and action controls around a scrollable content area, added full-screen narrow-window details and responsive file navigation, and restored focus to a visible page control when a task's original opener no longer exists.
- Added regression coverage for workspace history/draft preservation, invalid routes, report formatting and injection protection, report-mode persistence, diff parsing/search and incremental rendering. Updated the shell cache and CI script checks for the new frontend modules.

All 107 local Node tests pass. Script syntax, HTML/ARIA references, static selectors and module/cache assets were checked; new frontend assets were fetched from the running local server and matched against their source files. No added dependencies, data migration, changes to execution permissions or native installer publication. Validation uses frontend element adapters and local HTTP/Git fixtures. Real browser layout, native macOS behavior and authenticated model execution still need verification on the user's machine.

## 0.7.0 — 2026-09-11

- Added execution records for each CLI attempt: phase, start/end/checkpoint time, outcome, exit status, report and bounded stderr. Failed, cancelled and budget-limited attempts retain completed agent messages already received. New attempts do not reuse stale output; earlier and legacy reports remain selectable. Copy/download uses the selected execution.
- Checkpoint active records every five seconds and recover unfinished records as interrupted on startup, counting only time observed at the last save. Keep the latest 20 execution records, at most 262,144 UTF-16 code units of each new report and the last 32,768 of stderr, with explicit truncation indicators. Historical usage totals are retained when old execution entries expire. Existing task-list/event retention is unchanged.
- Update live execution clocks without re-rendering reports and provide stopping/quiet-output guidance. Increment run revisions and identify Runner instances so delayed HTTP/SSE replies cannot roll back newer observed state, including equal timestamps and restarts.
- Added a read-only, repository-locked change-check endpoint and an optional approval-panel check. It verifies the baseline and runs `git apply --check --index`; applying still repeats validation. UI checks have a deadline, prevent duplicates and ignore results for an obsolete selection/revision.
- Bound unterminated/oversized CLI lines and tolerate scalar JSON events without crashing the Runner. Preserve subsequent reports and usage. Show bounded stderr diagnostics and recognize an unresolved failed-turn event on process completion.
- Recover streams that deliver heartbeats without a snapshot, or malformed snapshots; ordinary snapshots no longer repeat setup requests. Added regression coverage for recovery, partial reports, deadlines, legacy output selection, stale revisions and real Git checks.

All 98 local Node tests pass, along with syntax checks for 35 scripts, HTML structure/ARIA references, static selectors and module/cache assets. No new dependencies, manual data migration or installer publication. Validation uses local CLI fixtures, not paid model calls. Browser layout, native Mac behavior and real-account execution remain outside this environment's verification.

## 0.6.0 — 2026-09-10

- Replaced expanded run cards with summaries and direct links to the relevant approval/progress tab. Full prompts, reports, events and patches remain in details. Unchanged summary markup retains DOM nodes; log-only updates skip usage-table rendering, and usage rows load in batches of 30 without changing totals.
- Added project-name/ID and multi-term search, four sort orders, saved browser filters, project task shortcuts, terminal-run reuse, and Markdown/patch downloads. New runs retain the original task and template snapshot; legacy or changed templates reuse their expanded prompt without applying a second template. Reusing a task never starts it automatically and asks before replacing an existing draft.
- Added an SSE heartbeat watchdog, manual reconnect and page-cache restore handling. Old connections cannot overwrite a newer stream. Project and budget changes broadcast to other open tabs; stale catalog/settings responses are ignored and edited forms are preserved. Environment checks and path saves share one operation guard.
- Validate budgets before approvals, retries, dequeue and CLI launch, including a fully consumed limit. Saving lower limits checks queued/active work immediately. A failed settings write no longer changes live policy; empty/boolean/unsafe numeric limits are rejected. Empty Git repositories receive an initial-commit explanation before a task is created.
- Added regression coverage for reuse and draft protection, filtering/export preservation, unchanged DOM nodes, heartbeat recovery, concurrent environment operations, budget enforcement and failed-save rollback. Extended real HTTP/Git tests to verify streamed settings/catalog updates and that exhausted queued runs create neither worktrees nor CLI processes.

All 86 local Node tests pass, along with script syntax, HTML structure, literal DOM selectors and module/cache asset checks. No dependency changes, data migration or installer publication. Existing two-stage write/change approvals remain in force. Budget enforcement uses reported events and does not guarantee an exact token ceiling while a Codex turn is still running. Browser layout and native Mac interactions remain outside this environment's validation.

## 0.5.0 — 2026-09-10

- Localized the main interface, onboarding, task forms/details, approvals, notifications, project/template management, usage, environment checks and desktop tray labels to Simplified Chinese. Added `zh-CN` document/manifest metadata, local date/number formatting and Chinese font fallbacks.
- Added presentation-only translations for known control-plane messages and workflow event labels, including older saved events. Unknown errors, dynamic paths, user content, original event records and code patches remain intact. Event search accepts both Chinese labels and original identifiers. Archive empty-state actions now use an explicit action key instead of matching visible button text.
- Translated built-in template names, descriptions and instructions while retaining their IDs, task placeholder and modes. Custom templates and existing task instructions are not rewritten. Updated the static shell cache to include the localization module.
- Added an in-app usage guide and `docs/GETTING_STARTED.zh-CN.md`, covering login, local project paths, an initial read-only review, two-stage change approval, Git staging versus committing/pushing, usage and port troubleshooting.
- Updated existing UI assertions and added two tests for preserving raw diagnostic/event data and searching localized event labels. All 76 local Node tests pass, along with JavaScript syntax, HTML nesting/ARIA references and module/cache-asset checks. Real browser layout and native Mac/Electron interactions remain unverified in this environment.

No added dependencies, data migration or native installer publication. Stop the previous Runner, pull the update, run `npm run open` and reload the browser so the translated built-in templates and interface are loaded together.

## 0.4.1 — 2026-09-09

- Fixed local health probes inheriting Node's global HTTP proxy. Reproduced on Node 24.19.0 with a healthy loopback server and a nonresponding proxy; the old launcher contacted the proxy and falsely timed out. A dedicated direct HTTP agent now handles loopback checks without changing Codex/Git proxy settings or the environment.
- Increased the probe allowance from two to five seconds and replaced the socket inactivity timeout with a total deadline. Slow healthy Runners can be reused; connecting or continuously receiving partial data cannot extend the deadline indefinitely. Timeout errors distinguish an accepted TCP connection from an inability to connect.
- Added dependency-free `npm run status` diagnostics and linked it from launcher errors. macOS/Linux reports include listening PIDs and process states using read-only `lsof`/`ps` calls, with recovery guidance for suspended jobs. Process arguments and environment values are not reported. Windows receives a PowerShell listener-inspection command. No automatic process termination or fallback Runner is introduced.
- Added five regression tests for native proxy isolation, slow responses, partial-response deadlines and port diagnostics. All 74 local Node tests pass. This source-only fix adds no dependencies, migration or native installer publication; the user's actual Mac listener still needs local verification if it remains unresponsive.

## 0.4.0 — 2026-09-09

- Added a Quick start panel for environment checks, ChatGPT sign-in and project/task entry. Login progress streams over SSE; duplicate clicks are guarded, stale HTTP replies cannot overwrite newer state, and reconnects or environment checks refresh credential status.
- Added local-only login/status/refresh/cancel endpoints using the installed Codex CLI. Existing credentials are reused; successful browser login is confirmed with a status probe. Cancellation and a three-minute timeout terminate the owned login process, with forced termination after a three-second grace period. Runner shutdown waits for login cleanup. Starting tasks or changing executable paths is blocked during login; active/queued tasks prevent starting login.
- Kept authentication output out of app data and API responses. Only sanitized status and a validated OpenAI browser authorization request URL are exposed in memory. Credentials remain managed by Codex. Cancellation never logs out or deletes saved credentials.
- Added dependency-free `npm run open` and an executable macOS `Start-Control-Plane.command` entry point. Known local Runners are reused; otherwise the launcher starts one in the current terminal and opens the browser. Added application identity/readiness to health responses. Older/unrelated, unready and unresponsive listeners receive actionable errors and are never stopped by the launcher.
- Updated Electron to attach to a recognized existing Runner. Its tray distinguishes closing an attached window from stopping an owned Runner, preserving tasks in the existing service. External navigation uses the system browser for HTTP(S) links.
- Added 17 tests for login lifecycle, simulated-CLI HTTP authorization, task exclusion, redaction, launcher ownership, malformed port responses, frontend duplicate clicks and reconnect races. All 69 local Node tests pass, plus syntax and static HTML/asset checks. Real account authorization, native Electron/macOS behavior and browser layout remain unverified in this environment.

No new dependencies, data migration or native installer publication. Quit a pre-v0.4.0 Runner once before pulling this update, then use `npm run open`; later opens can reuse the running service.

## 0.3.1 — 2026-09-08

- Added event search, pause/resume display, new-event counts and jump-to-latest controls. Pausing holds the displayed snapshot while the runner continues; the live buffer retains at most 500 events. Duplicate equal events are counted individually. Search survives live updates and resets when opening a different task.
- Kept retained log rows and unchanged output/diff content in the DOM instead of replacing the entire detail panel on each event. Added independent tab reading positions, hidden-region-aware scroll restoration and a focus fallback when the original task card is no longer present. The workflow timeline is now expandable.
- Fixed Tasks/Mission Control navigation retaining an earlier approval filter. Quick-filter and archive changes now update navigation state. Global shortcuts respect all editable content. Added narrow-window styles for event controls and the Settings scroll target.
- Fixed macOS integration-test teardown by canonicalizing its temporary directory before comparing paths returned by Git. All functional subtests had passed; the `/var` versus `/private/var` mismatch caused cleanup to misidentify the main worktree.
- Added five dependency-free tests for frozen snapshots, rolling-buffer and duplicate-event counts, search/reset behavior, retained rows, manual scroll control and unambiguous action-focus restoration. All 52 local Node tests pass; frontend syntax, HTML structure and asset checks pass. The element adapter does not verify native browser layout, selection or focus behavior; real-browser preview was unavailable.

This source update adds no dependencies or data migration and does not publish native installers. Restart the runner and reload the interface after pulling it.

## 0.3.0 — 2026-09-08

- Added browser-local task drafts, template instruction previews, an explicit clear-draft action and mode selection that survives template changes and reconnects. Failed submissions retain inputs; duplicate submissions are blocked until the request finishes.
- Split task details into Overview, Output, Events and Diff tabs with keyboard navigation. Added a persistent action footer, output/patch copying, colored diff lines and state-specific next-step guidance. Live updates preserve the current tab, scroll and supported control focus.
- Added visible pending-action feedback, persistent error messages, success notifications and archive undo. Delayed HTTP replies no longer replace newer SSE state. Unsaved budget fields remain intact on reconnect.
- Put the task queue first, added status shortcuts, quick filters, clear-filter and empty-state actions, and load-more history pagination in groups of 20.
- Added narrow-window navigation, visible keyboard focus, keyboard-accessible notification entries, task/search shortcuts and reduced-motion styles. Updated the service-worker shell cache to include the new frontend modules.
- Added five form-controller tests for preview parity, saved drafts, template/mode selection, failed/duplicate submissions and clearing accepted drafts. All 47 Node tests pass; frontend syntax and HTML structure checks pass. The form adapter does not validate browser layout or native focus behavior. Browser preview was blocked in the development environment, so real browser interaction and visual checks remain unverified.

This source update adds no dependencies or data migration and does not publish native installers. Restart the runner and reload the interface after pulling it.

## 0.2.1 — 2026-09-07

- Fixed change collection to compare the final worktree against the task's original commit. Staged edits, agent commits, new files, removals, renames and binary changes are included in the approval patch. Explicit patch prefixes and disabled text conversion keep patches applicable with custom Git diff settings.
- Fixed implementation retries and cancellation cleanup to reset to the task's original commit. Failed agent commits are removed from the retry worktree. Missing temporary worktrees can be recreated while preserving that baseline. Retry refuses a source repository whose HEAD, branch or working state has changed.
- Fixed UTF-8 decoding for Codex output, Git output and incoming JSON bodies, including characters split across stream chunks.
- Coalesced log-only SSE updates per run at 100 ms intervals. Workflow state transitions still publish immediately and cancel stale queued log updates.
- Updated only changed task cards, preserving expanded sections, scroll positions and action focus. Open task details now update with live state, logs and usage. Task submission and in-flight actions prevent duplicate clicks.
- Added real-Git regression scenarios for staged/committed/mixed patches, failed-commit retries, temporary-worktree recovery and split UTF-8 streams, plus event coalescing coverage. Tests use a local simulated CLI without model requests.

Existing history remains unchanged. Pending diffs generated by an older version retain their previously displayed contents; discard and rerun those tasks to collect a fresh patch with the corrected baseline comparison. This source update does not publish new native installers.

## 0.2.0 — 2026-09-07

- Added an Environment panel and dependency-free `npm run doctor` command for Git, Codex, credential-status and data-directory checks. Diagnostic subprocesses have timeouts and bounded output; authentication output is never returned.
- Added persistent absolute executable-path settings, environment-variable overrides, and common macOS executable lookup locations. Path changes are blocked while runs are pending or stopping. Missing Codex executables are rejected before creating a run or worktree.
- Added a read-only review task mode. The built-in Code review template selects it automatically. Successful reviews return a report and clean up their isolated worktrees; write approvals and applying patches are unavailable for this mode, including after retry.
- Display completed agent messages as readable reports in task cards and details while retaining raw events. Updated the PWA shell cache for the new interface modules.
- Exposed the application version in health/diagnostics responses and the dashboard. Existing runs without a mode keep their implementation workflow; existing data files remain compatible.
- Extended regression coverage for diagnostics, executable selection, configuration persistence, missing tools, legacy history and read-only execution/retry. Integration tests use a local simulated CLI with no model requests.

This release updates source and packaging metadata. Native installers, code signing and real authenticated Codex execution require their respective platform environments.
