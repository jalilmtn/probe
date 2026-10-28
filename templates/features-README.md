# Feature manifests

One file per feature, `probe/features/<id>.yaml`, where `<id>` is the feature id Probe's scan
uses (`call`, `universe`, `chat`, ...). Together they are the feature index: agents list
this folder and reads each `summary`, so there is no separate index file to fall out of date.

Each feature has three layers:

| Layer | Where | Answers | Read by |
|---|---|---|---|
| Summary | `summary:` in the manifest | What is this, in one line? | agents, Studio, people browsing |
| Brief | the doc `brief:` points to (`docs/features/<name>.md`) | What it does, how it works, what must never break | people and agents starting work |
| Manifest | this folder | Which code, tests, cards and rules belong to it | Probe and agents working on the feature |

The manifest never repeats the brief. It points into it.

## Manifest format

```yaml
id: call                      # Probe feature id; must match the scan
name: Calling                 # display name
summary: >-                   # one or two lines, from the user's point of view
  ...
owner: "@someone"             # who approves changes to the authored parts; null until agreed
brief: docs/features/calling.md
also_read:                    # other docs an agent should load, with anchors where useful
  - CLAUDE.md#calling

paths:                        # code that belongs to this feature (prefix match, repo relative)
  - feature/call/
related:                      # code owned elsewhere that this feature depends on; an edit here
  - path: core/push/impl/     # marks the feature stale but does not make it the owner
    why: push types and categories that wake a call

unit:                         # how to run this feature's unit tests
  command: ./gradlew :feature:call:impl:testDebugUnitTest

flows:                        # what a user can do, one line each; each becomes a card candidate
  - id: dial
    text: Start a call from a chat or a profile

invariants:                   # rules that must hold, each tied to what proves it
  - id: own-call-never-rings
    rule: Reconcile never rings for a call this device placed.
    covered_by:               # "TestClass :: test name", exactly as written in the test
      - "CallSignalSourceImplTest :: a reconcile never rings for a call this device placed"
    cards: []                 # device cards that prove it: "card-id" in probe/cards/<this feature>/,
                              # or "other-feature/card-id"
    gap: null                 # why no unit test proves it (needed when covered_by is empty)

device_only:                  # checks no unit test can make; candidates for cards
  - text: Lock screen, incoming call
```

### Rules for the authored fields

- **`invariants`** are behaviour, not architecture. "The reducer is pure" belongs in the brief;
  "a declined outgoing call sends no DELETE" belongs here, because a test or a card can fail on it.
- An invariant with empty `covered_by`, no `cards` and a `gap` is a known hole. One with all three
  empty is invalid: say why it is not covered.
- **`cards`** tie a rule to the device cards in `probe/cards/` that show it on a phone. Use them for
  what a unit test cannot reach (a locked screen, the system ringer, a payment sheet, two devices).
  A rule may have tests and cards both. A card link that names no card is a broken link, like a
  renamed test. A card proves its rule only while its last pass still holds for the code; Probe
  reads that from `probe/results/`. Keep `gap` on a card-only rule to say why no unit test can.
- To check a rule on a device, ask your agent ("does the locked-phone ring rule still hold?"): it runs
  `probe_card_run { rule: "call/full-screen-intent-rings" }`. From a shell: `probe rule
  call/full-screen-intent-rings --run`. `probe rules <feature>` lists every rule with its proof.
  The older single `card: <id>` still reads as a one-item `cards`.
- `covered_by` names must match a real test exactly, so a renamed or deleted test shows up as a
  broken link instead of silently passing.
- `paths` decide ownership when the edit hook asks "which feature did this file touch?". A file
  matched by two features' `paths` belongs to both; `related` only marks a feature stale.

### Derived fields

Modules, classes, test files and coverage are not written here. Probe's scan derives them from the
code on every run, so they cannot go stale. Do not add them by hand.

## Brief format

The brief is the feature's doc in whatever form the team keeps docs (often `docs/features/<name>.md`).
It starts with an **At a glance** section, the part a newcomer reads first:

```
## 0) At a glance
- What it is      — 2–4 lines, user's point of view
- Where it lives  — modules, and the one class to open first
- User flows      — the main paths
- Rules           — pointer to the manifest's invariants, plus the gaps that are still open
- How to test     — unit command, and what needs a device
```

The rest of the doc stays as the team writes it. A feature with no doc yet has no `brief:`.

## Keeping it current

When code under a feature's `paths` changes, the feature is stale. Whoever changed it, or Probe's
check, then confirms:

1. Every `covered_by` test still exists under that exact name.
2. The change does not contradict an invariant, a flow or the brief's At a glance.
3. New behaviour (a new signal, endpoint, screen or rule) has an invariant or flow to go with it.

It drafts the corrections; a person approves them. Nothing here is rewritten without review.
