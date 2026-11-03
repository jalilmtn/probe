# Changelog

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
