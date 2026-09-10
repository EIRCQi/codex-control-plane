# Codex 控制台

在本机调用 Codex，管理任务、审批代码变更并查看执行用量。

## 最新更新：v0.6.0 日常使用优化

- **任务列表更清晰**：摘要卡片显示状态、阶段、用量和最新事件；“阅读方案并审批”“检查代码变更”直接进入相应详情。完整报告、日志与补丁集中在详情页，减少页面滚动与重复渲染。
- **更方便地查找与复用**：可按任务、项目名称、仓库和 ID 搜索，多关键词同时匹配；支持最新创建、最近更新、待处理优先和 Token 排序。筛选与排序保存在当前浏览器。项目卡片可直接新建或查看任务；终态任务可“复用任务”，填写完成后仍需手动开始。
- **结果可导出**：详情页可下载 Markdown 报告和原始 `.patch` 补丁；用量表每次显示 30 条，点击任务可打开详情，汇总始终包含全部现存记录。
- **恢复与保存更可靠**：45 秒未收到服务事件时自动重连，也可点击“立即重连”；项目和预算变更会同步到其他打开的控制台页面。程序路径保存防止重复提交，重新检查环境会保留未保存的输入。
- **预算检查提前**：审批、重试、出队和启动 CLI 前均检查剩余预算；达到上限即停止继续执行。保存更低限额时会检查已有排队及运行任务。重试累计原任务用量，需要提高上限或填 0 才能继续。无效限额被拒绝，写盘失败保留原生效设置。

先在原启动终端按 **Ctrl+C** 正常退出旧服务，再更新：

```bash
git pull --ff-only
npm run open
```

刷新页面；有更新提示时点击“重新加载”。浏览器版本无需安装 Electron，也无需新增依赖或迁移数据。旧任务仍可查看和复用：若原始模板输入不可恢复，将使用已有完整指令，避免重复套用模板。详细操作见 [中文使用指南](docs/GETTING_STARTED.zh-CN.md)。

86 项本地 Node 测试全部通过，脚本语法、HTML 结构、页面选择器和资源引用检查通过。验证包含本地 HTTP/Git 工作区流程、前端控制器与断线恢复测试；真实浏览器布局和 Mac/Electron 原生交互仍需在本机确认。本次发布源代码更新，未生成新的安装包。

## v0.5.0 中文界面

主界面、登录引导、任务创建与详情、审批操作、通知、项目与模板、用量和环境提示现已使用简体中文。内置模板也提供中文指令；历史记录和用户自定义内容保留原文。事件既可按中文名称搜索，也可按原始事件标识搜索。

第一次使用建议先完成一次“代码审查”：检查环境并登录 → 添加本地 Git 仓库 → 新建任务 → 选择“代码审查”模板 → 开始审查 → 在“输出”中看报告。需要修改文件时，再使用“先分析，审批后实施”，分别批准隔离修改和最终应用。应用补丁只写回本机，Git 提交和推送仍由你完成。

首页新增“怎么使用”说明；完整步骤、任务示例和故障排查见 [中文使用指南](docs/GETTING_STARTED.zh-CN.md)。

先正常退出原执行器，再更新并重启：

```bash
git pull --ff-only
npm run open
```

刷新浏览器页面；出现更新提示时点击“重新加载”。本次无需安装新依赖或迁移数据。76 项本地 Node 测试、脚本语法及 HTML/资源检查通过；控制器测试不替代真实浏览器布局和 Mac 原生交互验证，本次未构建安装包。

## v0.4.1 — reliable local Runner detection

Fixed a reproduced Node 24.19.0 case where a healthy local Runner was reported as unresponsive because the health request used Node's globally configured HTTP proxy. Loopback probes now use a separate direct agent. Codex/Git proxy settings and the process environment are unchanged. Node documents how proxy settings affect the global agent in its [HTTP proxy documentation](https://nodejs.org/api/http.html#built-in-proxy-support).

The probe now allows five seconds instead of two and has a total deadline, including connecting and reading partial responses. An occupied or unrecognized port still prevents a second Runner from starting. Run `git pull --ff-only` and `npm run open` to use the fixed launcher; a healthy running v0.4.0 service can be reused.

If opening still fails, run **`npm run status`**. This read-only command checks `/api/health` directly and, on macOS/Linux, shows the listening process PID, parent PID, state and command name. It does not print command arguments or environment values and never signals processes. Windows users receive a PowerShell listener-inspection command.

A process in state **T** is suspended. In the terminal that started it, run `jobs -l`, find the job with that PID, and resume that job with `fg %N` (replace `N` with its job number). Press Ctrl+C there if you want to stop it. An Electron-owned Runner can be stopped with its tray **Quit** action. If the process belongs to another application, use that application's own controls.

You can also check the health endpoint independently on macOS:

```bash
curl --noproxy '*' --max-time 5 http://127.0.0.1:4310/api/health
lsof -nP -iTCP:4310 -sTCP:LISTEN
```

All 74 local Node tests pass, including configured-proxy isolation, responses slower than two seconds, partial-response deadlines and suspended-process diagnostics. This reproduces a possible cause of the timeout; it does not establish why a particular machine's listener is unresponsive. No dependencies or data migrations were added.

## v0.4.0 — open the dashboard and connect Codex

Run `npm run open`, or double-click **Start-Control-Plane.command** on macOS. The launcher opens the browser and reuses a recognized local Runner if one is already listening. Otherwise it starts a Runner in the current terminal; keep that terminal open and use Ctrl+C to stop it and its tasks. Browser mode needs no `npm install` or Electron download.

The **Quick start** panel guides you through local tools, **Sign in with ChatGPT**, and registering a project or creating a task. Sign-in opens the official Codex browser flow, reports progress live, and checks `codex login status` before showing success. If the browser did not open, a validated **Open sign-in page** link appears when the CLI supplies one. **Check login** also recognizes a login completed separately in your terminal.

Existing CLI credentials are reused. Login can be cancelled and times out after three minutes; stopping waits for the login process to exit, escalating after three seconds if needed. Finish or cancel running/queued tasks before starting login. New task starts, approvals, retries and executable-path changes wait until login finishes or is cancelled. Cancelling never logs you out or removes credentials already saved by Codex.

Codex owns authentication and credential storage. Browser authorization completes with OpenAI; the control plane keeps only sanitized progress and the browser authorization request URL in memory, without saving raw CLI login output to its data files. Codex caches credentials for subsequent sessions, so signing in is usually a first-use action. Local credential availability does not verify online access or remaining quota. See [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).

**Upgrade from v0.3.1 or earlier:** quit the old Runner once, then run `git pull --ff-only` and `npm run open`. Older health responses cannot identify the application, so the new launcher refuses to reuse that listener. It never stops an unrelated process. Future opens can reuse this version's Runner. No new dependencies or data migration are required.

The 69 local Node tests pass, including simulated-CLI HTTP login, duplicate/cancel/timeout handling, credential-output redaction, service reuse and reconnect state. JavaScript syntax, HTML structure and shell assets were checked. Tests do not exercise real account authorization, native macOS/Electron behavior or browser layout; those need verification on the user's machine. This source update does not publish native installers.

## v0.3.1 — read live events at your own pace

The **Events** tab now has message/type search, **Pause display**, **Resume display** and **Jump to latest** controls. Pausing freezes the displayed snapshot while the task continues running; the interface reports how many newer events remain available in the latest 500-event buffer. Search stays active as events arrive. Scrolling back stops automatic following; **Jump to latest** resumes it. The workflow timeline is expandable above the log viewer.

Existing event rows, unchanged output and unchanged diffs remain in place during live updates, reducing interrupted text selection and unnecessary rendering. Detail tabs keep separate reading positions. Returning to **Tasks / Mission Control** clears previous queue filters, and the active navigation indicator follows quick filters and archive selection. Keyboard shortcuts respect editable content.

This update also corrects a macOS test-cleanup path mismatch between `/var` and `/private/var`, which had caused the fixture to attempt removing its own main worktree after the functional tests passed.

The 52 Node tests cover runtime behavior and frontend controller state, including pause/resume, the rolling event buffer, duplicate events, retained row identity and action-focus matching. JavaScript syntax, HTML nesting, tab targets and static asset paths were also checked. Controller tests use an element adapter; actual browser layout, native focus and visual behavior remain unverified because local browser preview was unavailable. Native installers were not built.

Stop the current runner, run `git pull --ff-only`, then `npm start` and reload the dashboard. No new dependencies or data migration are required; browser mode does not need an Electron download.

## v0.3.0 — smoother task interactions

The task queue now comes first. Click a status metric or a quick filter to find running tasks, pending approvals or failures, clear filters in one step, and load history in groups of 20. Narrow windows have a compact section navigation bar.

New tasks keep a browser-local draft of the selected project, template, mode and task details. Closing the form, reloading the page or reconnecting to the runner preserves that draft. Expand **Preview task instructions** to see the template applied to your text before submitting. Read-only templates lock the effective mode and restore your previous choice when you switch templates. **Clear draft** removes the saved draft; an accepted submission clears it automatically. If browser storage is unavailable, the form explains that the draft cannot be saved.

Task details separate **Overview**, **Output**, **Events** and **Diff**. Approval, apply/discard, cancellation, retry and history actions are available in the detail footer. Copy an output or patch, inspect colored diff lines, and keep the selected tab and log scroll position during live updates. Busy controls prevent repeated actions, failures stay visible, and archiving provides an **Undo** action. Budget edits also survive runner reconnects.

| Shortcut | Action |
| --- | --- |
| `N` | Open a new task when you are not typing in a field |
| `/` | Focus task search when you are not typing in a field |
| `Ctrl+Enter` / `Cmd+Enter` | Submit the open task form |
| `Esc` | Close a dialog or notification popover; task submission must finish first |
| `←` / `→`, `Home` / `End` | Switch focused task-detail tabs |

Stop the current runner, run `git pull --ff-only`, then `npm start`. Use **Reload** if the browser reports an interface update. This update adds no dependencies and does not require downloading Electron for browser mode. Projects, budgets and task history remain compatible.

Validation includes 47 passing Node tests, including draft/selection retention and submission behavior using a small form adapter. JavaScript syntax and HTML structure were checked. Real browser interaction and visual verification were unavailable in the development environment; native installers were not built for this source update.

## v0.2.1: complete approval patches and baseline retries

Approval diffs now compare the final worktree to the commit saved when the task started. They include staged and committed agent changes, new files and binary changes. This avoids reporting "no file changes" after an agent runs `git add` or `git commit`. Git's [commit-to-worktree comparison](https://git-scm.com/docs/git-diff) supplies the complete patch.

Implementation retries reset the isolated worktree to that same commit, removing failed agent commits before retrying. A missing temporary worktree can be recreated. If the source repository's HEAD, branch or clean state has changed, create a new task so the new baseline receives fresh analysis and approval.

Live logs use UTF-8 stream decoding and coalesce noisy updates at 100 ms intervals; approval and result transitions publish immediately. Unchanged task cards stay in place, expanded sections and scroll positions survive updates, and open task details follow the selected run. Duplicate submissions are blocked while a task is being created.

Stop the current runner, use `git pull --ff-only`, then `npm start`. Browser mode still needs no Electron download. Existing history is retained; discard and rerun any pending diff generated by an earlier version if you need its staged or committed changes recollected. See [CHANGELOG.md](CHANGELOG.md) for details.

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

Install development dependencies once with `npm install`, then start the native desktop shell with `npm run desktop`. Electron starts the local control server or attaches to a recognized Runner already using the configured port, opens an isolated renderer window and adds a system tray menu. Closing the window hides it while the Runner and active Codex tasks continue. The tray can reopen the window or launch the dashboard in the default browser.

When Electron starts its own Runner, **Quit** stops that Runner and its tasks. When it attaches to an existing Runner, the menu shows **Quit window (keep Runner)**: quitting closes only the desktop shell. It displays the existing Runner's projects and history from that Runner's data directory, instead of loading a separate desktop data set. Reopening an already running desktop app brings its existing window forward.

## Desktop installers

Run `npm run dist` to generate the 512px icon and build the installer for the current operating system. The configured targets are DMG/ZIP for macOS, NSIS/portable EXE for Windows, and AppImage/DEB for Linux. Packaged applications store runs, settings, projects and templates in Electron's per-user application-data directory rather than inside the read-only application bundle.

The **Build desktop installers** GitHub Actions workflow can be started manually or by pushing a `v*` tag. It builds unsigned artifacts on native macOS, Windows and Linux runners and attaches them to the workflow run. Public distribution still requires platform-specific code-signing and, on macOS, notarization credentials.

Tag builds additionally verify that the tag matches `package.json`, generate SHA-256 checksums and provenance attestations, and create or update a GitHub Release. See [`docs/RELEASING.md`](docs/RELEASING.md) for the release checklist and verification commands.

## Requirements

- Node.js 20+
- Codex CLI installed; authenticate through Quick start or `codex login`
- A local Git repository to operate on

## Run locally

```bash
npm run open
```

The launcher opens <http://127.0.0.1:4310>. On macOS you can also double-click **Start-Control-Plane.command** in the repository. `npm start` remains available to start only the server without opening a browser or attaching to an existing instance.

If port `4310` is occupied by an older Runner, quit it once before upgrading. For another application, inspect the listener with `lsof -nP -iTCP:4310 -sTCP:LISTEN` or use `PORT=4311 npm run open`. Use a separate `CODEX_CONTROL_PLANE_DATA_DIR` if you intentionally run multiple Runners; a different port alone does not isolate saved data.

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
