# Probe

Agent-driven test platform. Maps an app into features and judges each one's health: what is
unit-tested, what passes, what works on a device. It runs and writes unit tests, drafts feature
cards from code, docs, git history or a ticket, and has AI agents use the app on an emulator:
running cards, mapping screens, measuring performance. `verify` checks a whole change end to
end. Runs locally; works with Claude Code as a plugin and with any MCP-capable agent.

Probe is **project-agnostic**. Knowledge about a kind of project lives in an *adapter*
(`src/adapters/`); Android/Gradle is the first. A project needs no setup: Probe finds the app
module, its install task and application id, an emulator image and the base branch on its own.
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

Then, inside a project, `/probe init` sets it up: settings, the manifest format, a scan, the features to cover, an agent-drafted manifest per
feature (paths, flows, rules and the exact tests proving them), device cards for the rules no unit
test can prove, and the Features section in `AGENTS.md`: how any coding agent
finds a feature, works on it and checks it after a change (`CLAUDE.md` imports it). It resumes where it stopped;
everything it writes into the project's knowledge arrives as a draft to review.

`/probe` opens Studio. Its **Setup** tab lists what is found and what is
still missing (app, emulator, test account, agent model, cards, branch), each with a button to the
place that fixes it. A project that cannot be tested yet opens on that tab.

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

Other agents (Cursor, Codex, Copilot, Gemini CLI): register the MCP server
`node <path-to-probe>/dist/probe.cjs mcp` and, where supported, add `skills/probe/SKILL.md`.

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
| Watch | While you code: an edit marks its features as edited; at the end of a Claude turn (or 45s after edits in an IDE, while Studio runs) a check runs their unit tests and manifest test links, and drafts manifest/brief corrections for review. Rules only a device card proves are named, with an offer to run their cards. Results go back to the Claude session | `hooks/hooks.json`, `check`, `stale`, Studio → feature |
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
```

Agents run on your own Claude Code login and plan. They use `agents.model` from `probe.yaml`
(default `sonnet`), never your Claude Code default, which may be a model your plan bills from
usage credits; `--model <name>` overrides it for one run.

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
  adapters/    one folder per project type (android-gradle)
  engine/      project, scan, health, unit runs, test writing, verify, git history, docs, doctor
  cards/       feature cards: schema, store, context, backfill, card runs, explore
  agent/       headless Claude Code runner
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
```

## Static coverage, by design

The scan judges coverage from source: a class is *direct* when a test class is named after it,
*referenced* when a test uses it, *untested* otherwise. It needs no build and takes seconds on
a large app. Measured line coverage (Kover/JaCoCo) can be added as an extra layer.

## Roadmap

1. ✅ Engine, scan, Atlas, unit runs, MCP, Studio, plugin
2. ✅ Feature cards from code, docs, git history and tickets; review in Studio
3. ✅ Agents on an emulator: cards, navigation map, login, performance, video
4. ✅ `verify`: a change's unit tests and cards end to end
5. ✅ Writing missing unit tests · tickets in/out · health map
6. Next: Test Bridge (app-side hooks for state checks) · record/replay · measured coverage · iOS/web adapters · server mode
