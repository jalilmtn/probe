# Changelog

## 0.8.0 — 2026-11-11

Connections per project, and a ticket workbench for developers.

- Studio → Settings is split into sections for the project picked at the top: General, Connections, AI accounts and models, Workbench, Builds and web, Test accounts. Nothing is shared between projects; tokens and keys are sealed in each project's own store on your machine.
- Connections: a project can use several trackers at once (Jira and Linear side by side) and Slack. Each shows whether it is connected, and can be tested, edited, have its token forgotten, or be removed. The shared part goes to `connections:` in `probe.yaml`.
- Slack: add as many channels as you like, picked from Slack's own list. Per channel, choose whether it is searched for talk about a ticket, whether results may be posted there, and which ticket labels it is for. A ticket shows what was said about it, with links.
- AI accounts: give a project several Claude (or Codex) accounts — the CLI's own login, a separate login folder, or an API key — and choose the account and model for coding, review and testing separately (for example coding on Opus with a work account).
- Tickets is now a workbench: For me, Not for me (assigned to someone else, or labels and statuses you choose), Hidden and All, with status chips, a label filter and search. Tick tickets, choose the steps (read ticket and Slack, write the change, write unit tests, run them, test the UI, check against the ticket, commit, comment on the ticket), and the agent works through them one at a time with a progress grid.
- Each ticket gets its own local commit, named by `workbench.commitPattern` (default `{type}({area}): {title} [{key}]`). Nothing is pushed; a tracker is only changed when "Comment on the ticket" is ticked. A file that already had uncommitted changes is never committed for a ticket.
- The older single `tickets.tracker` setting keeps working and moves into the connections list the first time it is edited.

## 0.7.0 — 2026-11-10

A tester's inbox, finished builds, and web apps.

- Studio → Tickets lists the tickets waiting for a test from Jira or Linear: who wrote each one, its text, the build it names, its commits and cards. Draft cards from a ticket's own text, test it, and post the result to the ticket as a comment (shown first, posted only when you press Post).
- Connect the tracker in Studio → Settings → Ticket tracker. The tracker, site and filter go to `probe.yaml` (`tickets.tracker`, `site`, `filter`, `team`, `buildField`); the API token is encrypted on each machine.
- Cards can run on a finished Android build instead of the working tree: a build file (`.apk`, or `.aab` with bundletool), a Firebase App Distribution release, or the copy Google Play signed for a track. New settings: `app.releasePackage`, `builds.firebaseApp`, `builds.playTrack`, `builds.tag`, and per machine a Google service account key file.
- Cards can run on a web app in Chromium (`web.url`), in any kind of project. The first web run installs Playwright into `~/.probe/tools`.
- A ticket that names a build shows whether that build's git tag contains the ticket's commits.
- `verify` and `run` take `--target web` and `--build <source>`; MCP tools `probe_verify` and `probe_card_run` take `target` and `build`; new MCP tool `probe_inbox`.
- A run on a build or on the web app records which, and is kept out of the shared results.

## 0.6.1 — 2026-11-03

Fixes from Probe's own security check.

- zod 3.25.76 → 4.6.7, for GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized collections). MCP tool schemas are unchanged.
- `.gitignore` ignores `.env*` files (keeps `.env.example`).

## 0.6.0 — 2026-11-03

Security checks, and switching project and branch from Studio.

- `probe security` checks a project with the rules for what it is: Android, iOS, web frontend, backend, cross-platform mobile or desktop, plus checks common to all. The catalog of about 400 checks is in `docs/security/`.
- Six layers: code rules, vulnerable dependencies from lockfiles (OSV), secrets in git history, built artifacts, a running app (localhost web or an Android emulator only), and an optional agent review (`--agent`).
- Findings are issues like any other: ⧉ Fix prompt, ✦ Fix (the check runs again after the edit), and Dismiss with a reason. `probe-security-ignore <ID>` skips a check on one line. New `security` section in `probe.yaml`: `osv`, `historyCommits`, `url`, `failOn`, `skip`, `ignorePaths`.
- Studio → Security shows findings by severity and feature. MCP tools `probe_security` and `probe_security_dismiss`.
- Studio's header has a project picker: switch to any project Probe has scanned on this machine, or open another folder.
- The branch in Studio's header is a searchable picker that switches branch (`git switch`), refusing while files are uncommitted or runs are going.

## 0.5.0 — 2026-11-02

Features for every kind of project, and Kotlin Multiplatform support.

- Features are decided in one place for every project, after the adapter has found the modules. Two new `probe.yaml` settings work with Gradle, Node and plain-folder projects alike:
  - `features.map` names each feature's files with globs (`money: ["shared/**/money", "web/src/money"]`).
  - `features.packages` turns the package or folder after a prefix into a feature (`[app.daywise]` makes `app.daywise.money.*` "money"), so one module can hold several features.
- A module split into several features still runs its unit tests once.
- Kotlin Multiplatform modules are read: `commonMain`, `androidMain` and `iosMain` are code, `commonTest` and `androidUnitTest` are unit tests, `androidInstrumentedTest` runs on a device. Before, a KMP module showed no classes and no tests.

## 0.4.0 — 2026-11-02

Studio's Runs tab, rebuilt so a result is always where you look.

- The selected run opens beside the list instead of below every run, with its own scroll; on a narrow window it covers the list, with a close button (Esc closes it too).
- Each run has its own link (`#runs/<id>`), and opening one brings its row into view.
- Filter runs by kind, status (including "failed or error") and feature, search by run or card, and page through 50 at a time.
- Check runs (the automatic checks after edits) now show their per-feature results and problems, with Fix and Fix prompt. They used to open as an empty panel.
- A failed build names its cause, the compiler's errors or Gradle's "what went wrong", in the problem and its fix prompt.
- Gradle modules are classed as Android or JVM from their `plugins { }` block. A JVM module that depended on an `androidx` artifact got `testDebugUnitTest`, a task it does not have, and Gradle then refused the whole unit run.

## 0.3.0 — 2026-10-31

First cross-agent release candidate.

- Install Probe as a plugin in Claude Code or Codex, or connect any MCP-capable agent directly.
- Open Probe Studio locally to review project setup, feature health, test coverage, and run evidence.
- Map Android/Gradle, Node/TypeScript, and generic Git projects; Android projects can also run checks on an emulator.
- Keep plugin versions and marketplace metadata aligned for client updates.

See the [README](README.md) for installation and setup instructions.
