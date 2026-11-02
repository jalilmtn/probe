# Changelog

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
