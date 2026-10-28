## Features

Every feature has a manifest, `probe/features/<id>.yaml` (format: `probe/features/README.md`):
what it is, where it lives, its user flows, the rules it must keep, and the exact test that proves
each rule (`covered_by`) or why none does yet (`gap`). Read it before changing a feature. When it
names a `brief`, that doc's "At a glance" section is the short version; `also_read` lists the rest.
The folder is the index: list it rather than relying on memory, and never invent a feature, path
or test that no manifest, brief or code names.

### Finding the feature

- **What features are there?** Each manifest's `id`, `name` and `summary`.
- **What is X / where do I start on X?** Match the manifest by `id`, `name` or `summary`; give its
  summary, brief and the class to open first (the brief's At a glance), then brief yourself on it
  as below. Nothing matches: say so and name the closest.
- **Which features does a change touch?** A file under a manifest's `paths` is owned by that
  feature (by each, when several claim it); one under its `related` only makes it stale. A file
  nobody claims is unmapped: say so, do not guess. A change owned by more than 3 features (an edit
  under a shared module) gets unit tests for all of them and the full check below for the 3 with
  the most owned files.

### Before working on a feature

Load the manifest, its brief (At a glance first) and every `also_read` entry fresh; read code only
under its `paths`. Know, in this order: what it is; the class to open first and the module layout;
the main data flow; every invariant (one with a `gap` is unproven by any test); how to test it (the
unit command, and the rules only device cards prove); the brief's gotchas.

### After changing a feature

1. **Test links.** Every `covered_by` entry `TestClass :: test name` names a test that exists under
   exactly that name. A renamed test breaks the link: fix the entry or give the rule a `gap`.
2. **Unit tests.** Run the manifest's `unit.command`; tie each failure to its invariant.
3. **Rules against the change.** Read the diff. A change that contradicts an invariant, a flow or
   the brief's At a glance means the code or the rule is wrong: fix one in the same change.
4. **Missing knowledge.** New behaviour (a signal, state, endpoint, push type, screen or rule) gets
   an invariant or a flow; a new test proving something no invariant claims gets one.
5. **Cards.** A rule only a device can prove lists its cards (`probe/cards/<feature>/<id>.yaml`)
   under `cards:`. `probe rules <feature>` shows each rule's tests and cards and whether a card's
   last pass still holds; `probe rule <feature/rule> --run` (or `probe_card_run` with `rule`) runs
   them on an emulator, minutes per card. Name the card-only rules the change touches; never start
   a card run unasked.

Behaviour goes in `invariants`, architecture stays in the brief. A `covered_by` entry must name a
test you have found, never one you expect. With the Probe plugin installed, edits mark their
features stale, the end of a turn runs their unit tests and a link check, and corrections to
manifests and briefs arrive as drafts to approve in Probe Studio.
