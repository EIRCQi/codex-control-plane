# Changelog

## 0.2.0 — 2026-09-07

- Added an Environment panel and dependency-free `npm run doctor` command for Git, Codex, credential-status and data-directory checks. Diagnostic subprocesses have timeouts and bounded output; authentication output is never returned.
- Added persistent absolute executable-path settings, environment-variable overrides, and common macOS executable lookup locations. Path changes are blocked while runs are pending or stopping. Missing Codex executables are rejected before creating a run or worktree.
- Added a read-only review task mode. The built-in Code review template selects it automatically. Successful reviews return a report and clean up their isolated worktrees; write approvals and applying patches are unavailable for this mode, including after retry.
- Display completed agent messages as readable reports in task cards and details while retaining raw events. Updated the PWA shell cache for the new interface modules.
- Exposed the application version in health/diagnostics responses and the dashboard. Existing runs without a mode keep their implementation workflow; existing data files remain compatible.
- Extended regression coverage for diagnostics, executable selection, configuration persistence, missing tools, legacy history and read-only execution/retry. Integration tests use a local simulated CLI with no model requests.

This release updates source and packaging metadata. Native installers, code signing and real authenticated Codex execution require their respective platform environments.
