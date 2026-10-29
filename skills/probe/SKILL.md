---
name: probe
description: Open Probe Studio or use Probe to understand and test an app — feature health, unit tests, feature cards, emulator runs, and end-to-end verification. Use when the user asks to open Studio, check app health or test coverage, run or write tests, test a feature on a device, or verify a change or ticket.
---

# Probe

Probe is a project-agnostic test platform. Its engine does deterministic work (scanning,
running builds, reading reports, driving devices) without AI; you are the judgement on top of it.

## Tools

| Tool | Use it to |
|---|---|
| `probe_doctor` | Check setup before anything else fails mysteriously |
| `probe_init` | Set a project up step by step (settings, agents, scan, features, a manifest per feature, rule cards, agent file); `status: true` only reports. Resumes; writes drafts for review |
| `probe_scan` | The feature map: static unit coverage and a health verdict per feature, with reasons (`refresh: true` after code changes) |
| `probe_feature` | One feature's modules and its riskiest untested classes |
| `probe_unit_run` | Run a feature's unit tests and get failures |
| `probe_unit_write` | Hand writing missing unit tests to a background agent (prefer doing it yourself when you can edit) |
| `probe_cards_context` | Gather code, docs and git history for writing a feature's cards |
| `probe_cards_save` | Save drafted cards (YAML in `probe/cards/<feature>/`) |
| `probe_cards_list` | Read cards: how to reach a behaviour and what must be true |
| `probe_cards_backfill` | Hand drafting to a background agent; with `ticket` (+ `ticketText`), the cards a ticket needs |
| `probe_card_run` | A background agent performs one card on an emulator and judges it; with `rule`, every card that proves that rule |
| `probe_rule` | A feature's rules (or one rule) with the tests and cards that prove each, and whether each card's last pass still holds |
| `probe_explore` | A background agent maps a feature's screens and navigation on an emulator |
| `probe_login_check` | See which account the app on the emulator uses, or log it in as a test role |
| `probe_verify` | Check a change end to end: affected features' unit tests, then their cards on a device |
| `probe_ticket` | A ticket's commits, features and cards; or a ticket draft for a run that did not pass |
| `probe_check` | Check edited features: unit tests, manifest test links, a drafted manifest/brief correction |
| `probe_stale` | Features edited since their last check, and drafts waiting for review |
| `probe_manifest` | Check `probe/features/<feature>.yaml` against the code |
| `probe_studio_open` | Open the GUI for the user |

When opening Studio, call `probe_studio_open` and give the user its local URL as a clickable link.
Only say it opened if the tool call succeeds; otherwise report the tool error and its suggested fix.

Always pass `projectDir` as the current working directory.

A "background agent" is a separate headless coding agent Probe starts, on the CLI
`agents.runner` names (Claude Code by default, or Codex CLI), with the user's own login for it;
it costs their plan and takes minutes. Whichever agent you are, you can do the same work yourself
with the other tools, which is usually better when you can.

## Setup

A project needs none. Probe detects the app (module, install task, application id), an emulator
image and the base branch. Never ask the user to create or edit `probe/probe.yaml`: if
`probe_doctor` shows something missing or wrong, send them to Studio → Setup / Settings
(`probe_studio_open`), which writes it.

## Branches

Each run records the branch, commit and uncommitted-file count it tested (the `code:` log line).
Before verifying, check the branch in `probe_doctor`: if it is the base branch itself or a
detached HEAD, tell the user rather than reporting "nothing changed" as a pass. Never check out,
commit or pull to change what is tested.

## Verifying a change

After implementing something, call `probe_verify` (or `noDevice: true` for a quick unit-only
pass). It maps changed files (committed since the base branch, plus uncommitted and untracked)
to features, runs their unit tests, reinstalls the app from this code once and runs their
approved cards on an emulator. Report per feature: unit result, each card's verdict, perf
warnings, and the run ids so the user can open evidence in Studio. If a feature has no approved
cards, say so: the change was not checked on a device.

## Keeping features current

An edit marks the features the file belongs to as edited (instant, no build), and when you end a
turn a check starts in the background. When it finds failing tests or broken manifest links,
they come back to you once: at the end of the turn or with the user's next message. Fix them
before going on, or say why they are expected.

Where your agent has hooks wired to Probe (the Claude Code plugin does this itself), all of that
runs on its own. Otherwise feed it yourself: after editing files run `probe hook edit <files…>`,
and at the end of your turn `probe hook stop`, which prints any problems a finished check found
(else starts a check). `probe hook prompt` prints results that arrived since. A git pre-commit
hook (`probe hooks install`) and Studio's file watcher also mark edits, with no agent involved.

A feature with a manifest (`probe/features/<id>.yaml`, format in `probe/features/README.md`)
also gets an agent-drafted correction to its manifest and brief after a change. It is never
applied on its own; the user reviews it in Studio. Never apply a draft yourself.

## Setting a project up

A project with no `probe/features/` is not set up. Call `probe_init { status: true }` and show the
steps. Then `probe_init` runs what Probe can do alone and stops where a person decides: which
features get a manifest (`accept: true` takes the scan's proposal; ask before taking it for the
user) and the drafts to review. The manifests and cards steps run an agent per feature, minutes
each: say so before starting them, and offer `limit` or `features` for a first pass. Never apply
a draft yourself; point the user to Studio → Setup or `probe draft approve <id>`.

## Rules and their cards

Each manifest rule (`invariants`) lists the unit tests (`covered_by`) and the device cards
(`cards`) that prove it. When the user asks whether a behaviour still holds, find the rule with
`probe_rule` (a feature, or `feature/rule-id`) and answer from its proof: a test link, or a card
whose last pass still holds for this code. When only a card can prove it and that pass is missing
or out of date, offer `probe_card_run { rule }`; it takes minutes per card and needs an emulator,
so start it when asked. When the turn-end check names rules "only a device proves", tell the
user and offer the same. A rule with no card that needs one: draft it with `probe_cards_context` +
`probe_cards_save`, then add its id under the rule's `cards:`.

## Shared results

Results are recorded in `probe/results/` with a fingerprint of the code they ran on, so they
travel with git. `probe_scan` health says when one is outdated for the current checkout.
`probe_verify` skips cards whose result is still up to date; `outdated: true` re-runs only
outdated or missing results. Tell the user to commit `probe/results/` with their change.

## Fixing what a run found

`probe_issues` lists a run's problems with ids. To fix one yourself, read `probe_fix_prompt`
(problem, evidence, card, modules, how to check), fix it, then re-run the unit tests and the
card. `probe_fix` hands it to a background agent instead; use it only when asked. Never commit.

## Feature cards

A card is one user-visible behaviour: how to reach it, the steps, and what must be observably
true. `feature` = overview, `capability` = a flow, `regression` = guards a past bug. Cards are
drafts until a person approves them in Studio; you can never approve your own.

## Device runs

Card runs, explore runs and login checks boot or pick an **emulator** (a real phone only if the
user allowed its serial on that machine) and let a separate agent drive the app. Every run keeps
step screenshots, a timeline, a screen recording, crashes from logcat and performance (cold
start, janky frames, frame-time percentiles, memory; thresholds in Studio → Settings). A crash
fails the run; a perf threshold only warns. Verdicts: `passed`, `failed`, or `blocked` (login
needs something missing, or the app is logged in with a non-test account).

Test accounts are added in Studio → Settings: roles and usernames go to
`probe/hints/accounts.yaml`, passwords stay encrypted on that machine, and device agents type them
without seeing them. Never ask the user for a password in chat.

## How to read the results

- **direct**: a test class is named after the class (`FooTest`, `FooReducerExhaustiveTest` → `FooReducer`).
- **referenced**: no test class of its own, but some test uses it. Weak coverage, not none.
- **untested**: no test mentions it. Static coverage says a test exists, not that it checks the right thing.
- Risk ranks untested classes by kind (reducer > use case/view model > mapper/repository/logic > other)
  and size. DI modules, interfaces and plain models are never ranked.
- **Health** per feature: `fail` (failing unit tests, a card failing on device, navigation issues),
  `warn` (blocked runs, perf warnings, low coverage, no cards, cards never run), `ok`, or `unknown`
  (nothing has run yet).

## Rules

- When asked to write missing unit tests: start from the top of `probe_feature`'s ranking,
  follow the project's existing test style and helpers (read neighbouring tests and the
  project's CLAUDE.md / AGENTS.md first), make each test fail when the behaviour it pins is
  broken, then rerun `probe_unit_run` to show they pass.
- Probe never files tickets from an agent: offer the draft from `probe_ticket` and let the user
  file it from Studio.
- Never commit, push or stage anything. Leave changes in the working tree for review.
