# Probe

Agent-driven test platform. Maps an app into features and judges each one's health: what is
unit-tested, what passes, what works on a device. It runs and writes unit tests, drafts feature
cards from code, docs, git history or a ticket, and has AI agents use the app on an emulator:
running cards, mapping screens, measuring performance. `verify` checks a whole change end to
end. Runs locally; works with Claude Code and Codex as plugins and with any MCP-capable agent.

Probe is **project-agnostic**. Knowledge about a kind of project lives in an *adapter*
(`src/adapters/`): Android/Gradle (everything, devices included), Node/TypeScript, and a generic
one for any other git repository (see [Project types](#project-types)). A project needs no setup:
Probe finds the app module, its install task and application id, an emulator image and the base
branch on its own.
Anything it guessed wrong is changed in Studio → Settings, which writes `probe/probe.yaml`; nobody
edits YAML by hand.

## Install (Claude Code)

Inside Claude Code:

```
/plugin marketplace add jalilmtn/probe
/plugin install probe@probe-tools
```

Or from a terminal:

```bash
claude plugin marketplace add jalilmtn/probe
claude plugin install probe@probe-tools
```

To update later: `claude plugin marketplace update probe-tools`, then start a new session. A
marketplace added from an older address (`claude plugin marketplace list` shows its source) is
switched with `claude plugin marketplace remove probe-tools` before adding it again.

## Install (Codex)

From Codex CLI, add the GitHub repository as a plugin marketplace and install Probe:

```bash
codex plugin marketplace add jalilmtn/probe
codex plugin add probe@probe-tools
```

In the Codex desktop app, open `/plugins` and install Probe from the **Probe Tools** marketplace
after adding the repository with the commands above. Open a project in Codex and start a new chat;
Probe's tools and the `$probe` skill are then available in that project. Codex needs Node.js 20 or
newer on the machine to launch Probe's local MCP server.

This connects Codex to Probe's tools. To have Probe start its own background agent tasks through
Codex CLI as well, set **Agents → Runner** to **Codex CLI** in Probe Studio, or set
`agents.runner: codex` in `probe/probe.yaml`.

Once installed, open a project in your coding agent and initialize Probe. In Claude Code, run
`/probe init`; in Codex, invoke `$probe` and ask it to initialize the project. Probe sets up
settings, the manifest format, a scan, the features and platform areas (core, common, the app module) to cover, an agent-drafted manifest per
feature or area (paths, flows, rules and the exact tests proving them), device cards for the rules no unit
test can prove, and the Features section in `AGENTS.md`: how any coding agent
finds a feature, works on it and checks it after a change (`CLAUDE.md` imports it for Claude Code). It resumes where it stopped;
everything it writes into the project's knowledge arrives as a draft to review.

In Claude Code, `/probe` opens Studio. In Codex, invoke `$probe` and ask it to open Studio. Its **Setup** tab lists what is found and what is
still missing (app, emulator, test account, agent model, cards, branch), each with a button to the
place that fixes it. A project that cannot be tested yet opens on that tab.

Claude Code also provides these slash commands:

```
/probe init               set the project up, step by step (resumes)
/probe                    open Probe Studio (local GUI)
/probe verify             check the current change: unit tests + cards on an emulator
/probe scan               feature map with health
/probe write-tests chat   write missing unit tests
/probe run comment comment-add
/probe explore comment    map a feature's screens
/probe ticket PROJ-1234
```

## Other agents

Probe is not tied to Claude. Three parts, each usable on its own:

1. **Knowledge and tools — any MCP-capable agent** (Cursor, Codex, Copilot, Gemini CLI, …).
   Register the MCP server `node <path-to-probe>/dist/probe.cjs mcp` (set `PROBE_PROJECT` to the
   project, or run it from inside it) and, where the agent supports skills, add
   `skills/probe/SKILL.md`. `probe init` writes the Features section into `AGENTS.md`, which most
   agents read on their own; the manifests and briefs are plain YAML and Markdown.

2. **The agents Probe starts itself** (drafting cards, device runs, explore, login, writing unit
   tests, fix, init, manifest drafts) run headless on a coding-agent CLI chosen with
   `agents.runner`, in `probe/probe.yaml` for the team or Studio → Settings → Agents for this
   machine:

   | `agents.runner` | CLI | How Probe runs it |
   |---|---|---|
   | `claude` (default) | Claude Code | `claude -p --output-format stream-json`, Probe as the only MCP server, built-in tools allow-listed (read-only unless the job writes files; never a shell) |
   | `codex` | Codex CLI | `codex exec --json --ignore-user-config`, Probe attached with `-c mcp_servers.probe.*` (only the job's tools enabled and pre-approved), `--sandbox read-only`, or `workspace-write` for jobs that write files. Codex reads files through sandboxed shell commands, so it keeps a shell (device runs get none); it reports tokens, not a price. Your `~/.codex/config.toml` model and Windows sandbox mode are carried over |

   `agents.model` is a name that runner's `--model` accepts; left out, Claude Code uses `sonnet`
   and Codex its own default. A model set by the team is dropped on a machine that switches to
   another runner. `probe doctor` checks that the chosen CLI is installed.

3. **The watch loop** (edits mark features stale; a check runs their tests and drafts manifest
   corrections). Claude Code feeds it through `hooks/hooks.json`. Any other agent feeds it with
   the same entry points, called from its own hooks, rules or a wrapper script:

   ```bash
   probe hook edit src/foo.ts src/bar.ts   # after an edit (no files: what changed since the last sweep)
   probe hook stop                         # end of a turn: prints problems a check found, else starts a check
   probe hook prompt                       # results that arrived since; --session <id> per agent
   ```

   They print plain text and never fail. Two ways that need no agent support at all:
   `probe hooks install` adds a git **pre-commit** hook that marks the staged files' features
   stale and starts a check in the background (it never blocks a commit; `probe hooks uninstall`
   removes it), and Studio's **file watcher** checks edits made while Studio is open.

## What it does

| Area | What | Where |
|---|---|---|
| Init | Sets a project up step by step and resumes where it stopped; manifests, rule cards and the agent file arrive as drafts | `init [--status] [--step id] [--yes] [--features a,b]`, `probe_init`, Studio → Setup |
| Atlas | Features, static unit coverage, health per feature (table or map) | Studio → Atlas, `probe scan`, `probe_scan` |
| Unit | Run a feature's unit tests; an agent writes the missing ones | `unit`, `write-tests` |
| Cards | What each feature does, how to reach it, what must be true | `backfill`, `cards`; review in Studio |
| Device | An agent performs a card on an emulator: verdict, screenshots, video, perf | `run`, ▶ Run on device |
| Navigation | An agent walks a feature's screens: map + issues | `explore`, ⌖ Map screens |
| Login | Who the app is logged in as; log in with a test account | `login`, Studio → Settings |
| Verify | Diff → features → unit tests → reinstall → cards on device | `verify`, Studio → Verify |
| Tickets | In: commits/features/cards of a ticket, cards from ticket text. Out: ticket draft of a failed run | `ticket`, Studio → Verify, ⧉ Ticket draft |
| Fix | Every problem a run found gets **⧉ Fix prompt** (context to paste into any coding agent) and **✦ Fix** (an agent edits the code, then Probe re-runs the unit tests and the card) | `issues`, `fix-prompt`, `fix`; under every run |
| Watch | While you code: an edit marks its features as edited, and an edit in a platform module also marks the areas that depend on it (`watch.impactDepth`, from the build files); at the end of an agent's turn, on a commit (or 45s after edits in an IDE, while Studio runs) a check runs their unit tests and manifest test links, and drafts manifest/brief corrections for review. Rules only a device card proves are named, with an offer to run their cards. Results go back to the agent session | `hooks/hooks.json`, `hook edit\|stop\|prompt`, `hooks install`, `check`, `stale`, Studio → feature |
| Rules | Each manifest rule lists the unit tests and device cards that prove it; ask whether a rule holds, or run its cards on an emulator by rule | `rules`, `rule --run`, `probe_rule`, `probe_card_run { rule }`, Studio → feature |
| Stop | Any running run stops: its build or agent is killed, it is saved as `stopped` and never counts toward health | ■ Stop, Ctrl+C in the CLI |

## CLI

```
node dist/probe.cjs doctor | scan | studio                   --project <app>
node dist/probe.cjs init [--status] [--step <id>] [--yes] [--features a,b] [--limit n]
node dist/probe.cjs feature <id> | unit <feature>
node dist/probe.cjs write-tests <feature> [--limit 5]
node dist/probe.cjs cards [feature] [--detail] | context <feature>
node dist/probe.cjs backfill <feature|*> [--ticket PROJ-1 [--ticket-text file.md]]
node dist/probe.cjs run <feature> <card> [--device <serial>]
node dist/probe.cjs explore <feature> | login [role]
node dist/probe.cjs verify [--base origin/develop] [--features a,b] [--ticket PROJ-1] [--no-device] [--all-cards] [--max-cards 10]
node dist/probe.cjs ticket <id> | ticket draft <run> | ticket file <run>
node dist/probe.cjs issues <run> | fix-prompt <issue> | fix <issue>
node dist/probe.cjs results [feature] | verify --outdated [--rerun-fresh]
node dist/probe.cjs accounts | account set <role> [--code]
node dist/probe.cjs devices [allow <serial> | avd <name>]
node dist/probe.cjs check [features] [--no-drafts] | stale | manifest <feature>
node dist/probe.cjs rules <feature> | rule <feature/rule> [--run] [--device <serial>]
node dist/probe.cjs drafts [feature] | draft show|approve|reject <id>
node dist/probe.cjs hook edit [files…] | hook stop | hook prompt [--session <id>]
node dist/probe.cjs hooks install | uninstall | status
```

Agents run on your own login and plan for the CLI `agents.runner` names (Claude Code by default,
or Codex CLI; see [Other agents](#other-agents)). They use `agents.model` from `probe.yaml`
(Claude Code default `sonnet`), never your own CLI default, which may be a model your plan bills
from usage credits; `--model <name>` overrides it for one run.

## Device runs

A device run picks a running emulator, or boots the chosen emulator image (the first one on the
machine when none is chosen), installs the app with its install task when missing (verify always reinstalls once, from the current code), cold-starts
it with timing and hands the task to a headless agent. The agent sees a screenshot and a
numbered element list per step and acts by element number. Kept with every run: step
screenshots, a timeline, a screen recording, crashes from logcat, and performance (cold start,
janky frames, p50/p90/p99 frame time, memory). A crash fails the run; a perf threshold only warns.

Safety: real phones are never used unless their serial is allowed on that machine; agents never
see passwords (Probe types them on the device); a run stops as `blocked` if the app is logged in
with an account that is not a test account, or a login needs a code or captcha it lacks. Agents
never file tickets; a person does, from Studio, with the team's own command.

## Shared results

Every unit run and card run that judged the code is written to `probe/results/<feature>.yaml`:
the verdict, when, by whom, on which device and commit, and a **fingerprint** of exactly what
it ran on. Commit it with the code, and whoever fetches sees the same health map. Screenshots,
video and logs stay on the machine that ran it.

The fingerprint hashes the content of the files themselves (as git blob ids, uncommitted work
included), so it holds whichever branch or commit someone is on:

| Part | What |
|---|---|
| Own modules | each module the card or feature runs on, one hash each |
| Card | the card's title, steps, expectations, reach (not its review status) |
| Dependencies | every module those depend on, transitively, from the build files, as one hash |

| State | Meaning |
|---|---|
| ✓ up to date | nothing it ran on changed: the result holds for this code |
| ⟳ outdated | the card or one of its modules changed since (named) |
| ? maybe outdated | only a module it depends on changed (named when the recorded commit is present) |
| · never | no result |

An outdated result does not count as passing or failing in health. Verify skips a card whose
result is up to date (it would repeat itself; `--rerun-fresh` runs it anyway), and
**⟳ Bring up to date** in Atlas (`verify --outdated`, per feature in Cards) re-runs only what is
outdated or missing. `probe results [feature]` lists it all.

## Fixing what Probe finds

A problem is one thing someone could fix: a failing unit test, a card expectation that was not
true, a crash, a navigation issue, a performance warning, a build that does not compile. A
verify run lists the problems of every run it started. Each has two buttons:

| Button | What happens |
|---|---|
| ⧉ Fix prompt | A self-contained prompt: the problem, its evidence (expectation and what was seen, the agent's last steps, the crash stack, the test message), the card, the feature's modules, how to check the fix. Copy it into any agent. |
| ✦ Fix | A background agent fixes it on the current branch: it may edit files, never run commands or touch git. Probe then runs the feature's unit tests and, for a problem seen on a device, the card again from a fresh install. Changes stay uncommitted for review. |

## Branches

Every run records the branch, commit and number of uncommitted files it tested, and Studio's
header shows the branch the project is on. Studio sends that branch with every action; if the
project has been switched to another branch meanwhile (in a terminal or the IDE), the server
refuses the action and Studio asks before continuing on the new one. It also warns when the
project is on the base branch itself, on a detached HEAD, or behind its upstream. Verify picks
the base branch from a list. Probe never checks out, commits or pulls: switching branches stays
with the person.

## Project types

The first adapter that recognises the project folder wins:

| Adapter | Recognised by | Areas | Unit tests | Devices |
|---|---|---|---|---|
| Android/Gradle | `settings.gradle(.kts)` | Gradle modules; `:feature:<name>:*` is one feature | each module's Gradle test task, JUnit XML from `build/test-results` | ✅ emulator or allowed phone |
| Node/TypeScript | `package.json` | workspaces (`workspaces` or `pnpm-workspace.yaml`), else folders as below | the package manager's `test` script, per workspace when each has one | — |
| Generic | a `.git` folder or `probe/probe.yaml` | top-level folders with code, and each folder inside `src/`, `lib/`, `packages/`, `apps/`, `services/`… | `unit.command` from `probe.yaml` | — |

Without a build tool to ask, the Node and generic adapters inventory **files**, not classes: a
file is covered *directly* when a test is named after it (`jobs.test.ts` → `jobs.ts`) and
*referenced* when a test imports it. Test code is found by convention (`*.test.*`, `*.spec.*`,
`*_test.*`, `test_*.py`, `*Test.kt`, and anything under `test/`, `tests/`, `__tests__/`,
`src/test/`); tests in a folder of their own count for every area they import. Results come from
JUnit XML when `unit.junit` points at it, else from the runner's summary line (node --test, Jest,
Vitest, pytest, cargo), else from the exit code alone, which counts the command as one test.
Device features (cards on a device, screen mapping, login checks) are shown as unavailable on
these projects, and `verify` checks their unit tests only; cards can still be drafted and reviewed.

```yaml
# probe/probe.yaml, for a project without Gradle (all optional)
areas: [packages/*, services/*]      # each matching folder is an area
# areas:                             # or name them
#   engine: src/engine
#   web: [web/src, web/public]
unit:
  command: npm test                  # pytest, go test ./..., cargo test, ...
  areas:
    engine: npx vitest run src/engine  # one area's own command
  junit: reports/junit.xml           # file or folder; optional
```

Adding a project type means one adapter implementing `ProjectAdapter`
(`src/adapters/adapter.ts`), registered in `src/adapters/registry.ts` before the generic one. An
adapter also names its build-output folders (`ignoredDirs`), which edit tracking skips.

## App detection (Android)

| Value | Found from |
|---|---|
| App module | the module applying an Android application plugin (`:app` preferred) |
| Install task | `<module>:install[Flavor]Debug` |
| Application id | `build/outputs/apk/…/debug/output-metadata.json` of the last build (exact, suffixes and ids from secrets included); else `applicationId` + debug `applicationIdSuffix` in the build file; else read after the first install |

What Studio → Settings writes (only the values someone changed):

```yaml
# probe/probe.yaml
app:
  package: com.example.app.debug     # only to override detection
verify:
  base: origin/develop
  cards: approved        # or all
  maxCards: 10
perf:
  maxStartupMs: 4000
  maxJankyPct: 15
  maxP90Ms: 32
tickets:
  url: https://jira.example.com/browse/{id}
  fileCommand: gh issue create --title {title} --body-file {file}
```

## Where things live

| What | Where |
|---|---|
| Project settings (shared, committed; written by Studio) | `<app>/probe/probe.yaml` |
| Results with fingerprints (shared, committed) | `<app>/probe/results/<feature>.yaml` |
| Feature cards (shared, committed, reviewed) | `<app>/probe/cards/<feature>/<id>.yaml` |
| Test accounts: roles and usernames only (shared) | `<app>/probe/hints/accounts.yaml` |
| Passwords (DPAPI-encrypted on Windows), emulator, allowed phones, agent model | `~/.probe/projects/<app>-<hash>/secrets.json`, `local.yaml` |
| Results: scans, runs, navigation map, screenshots, video, ticket drafts | `~/.probe/projects/<app>-<hash>/` (never inside the app repo) |

## Layout

```
src/
  core/        data model, config, local store, process helpers
  adapters/    one folder per project type (android-gradle, node, generic)
  engine/      project, scan, health, unit runs, test writing, verify, git history, docs, doctor
  cards/       feature cards: schema, store, context, backfill, card runs, explore
  agent/       headless agent runners (Claude Code, Codex CLI) behind one AgentRunner interface
  devices/     adb, UI tree, emulator selection, run sessions, device-run harness (perf, video)
  accounts/    test accounts, machine-local secrets, login check
  tickets/     ticket context in, ticket drafts out
  mcp/         MCP server (stdio): tools for AI agents
  studio/      local GUI (single page + small HTTP API)
  cli.ts       command line entry
.claude-plugin/  plugin + marketplace manifests
.mcp.json        plugin's MCP server
commands/        /probe
skills/probe/    how an agent should use Probe
dist/probe.cjs   bundled build, committed so the plugin runs without npm install
```

## Develop

```
npm install
npm run build      # typecheck + bundle to dist/probe.cjs (commit dist/)
npm test           # unit tests under test/ (node --test)
```

## Static coverage, by design

The scan judges coverage from source (files instead of classes for Node and generic projects): a class is *direct* when a test class is named after it,
*referenced* when a test uses it, *untested* otherwise. It needs no build and takes seconds on
a large app. Measured line coverage (Kover/JaCoCo) can be added as an extra layer.

## Roadmap

1. ✅ Engine, scan, Atlas, unit runs, MCP, Studio, plugin
2. ✅ Feature cards from code, docs, git history and tickets; review in Studio
3. ✅ Agents on an emulator: cards, navigation map, login, performance, video
4. ✅ `verify`: a change's unit tests and cards end to end
5. ✅ Writing missing unit tests · tickets in/out · health map
6. Next: Test Bridge (app-side hooks for state checks) · record/replay · measured coverage · more adapters (Python, Go, iOS) and device support beyond Android · server mode
