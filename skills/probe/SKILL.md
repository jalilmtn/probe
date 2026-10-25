---
name: probe
description: Use Probe to understand and test an app — feature health (what is tested, untested, passing, failing), unit tests and writing missing ones, feature cards, running cards and mapping screens on an emulator, verifying a change end to end, tickets, and the Probe Studio GUI. Use when the user asks about test coverage or app health, running or writing tests, testing a feature on a device, or verifying a change or a ticket.
---

# Probe

Probe is a project-agnostic test platform. Its engine does deterministic work (scanning,
running builds, reading reports, driving devices) without AI; you are the judgement on top of it.

## Tools

| Tool | Use it to |
|---|---|
| `probe_doctor` | Check setup before anything else fails mysteriously |
| `probe_scan` | The feature map: static unit coverage and a health verdict per feature, with reasons (`refresh: true` after code changes) |
| `probe_feature` | One feature's modules and its riskiest untested classes |
| `probe_unit_run` | Run a feature's unit tests and get failures |
| `probe_unit_write` | Hand writing missing unit tests to a background agent (prefer doing it yourself when you can edit) |
| `probe_cards_context` | Gather code, docs and git history for writing a feature's cards |
| `probe_cards_save` | Save drafted cards (YAML in `probe/cards/<feature>/`) |
| `probe_cards_list` | Read cards: how to reach a behaviour and what must be true |
| `probe_cards_backfill` | Hand drafting to a background agent; with `ticket` (+ `ticketText`), the cards a ticket needs |
| `probe_card_run` | A background agent performs one card on an emulator and judges it |
| `probe_explore` | A background agent maps a feature's screens and navigation on an emulator |
| `probe_login_check` | See which account the app on the emulator uses, or log it in as a test role |
| `probe_verify` | Check a change end to end: affected features' unit tests, then their cards on a device |
| `probe_ticket` | A ticket's commits, features and cards; or a ticket draft for a run that did not pass |
| `probe_studio_open` | Open the GUI for the user |

Always pass `projectDir` as the current working directory.

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
