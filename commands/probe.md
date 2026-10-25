---
description: Probe — test GUI, app health, unit tests, cards on a device, verify a change
argument-hint: "[studio | doctor | scan | feature <id> | unit <feature> | write-tests <feature> | cards [feature] | backfill <feature> | run <feature> <card> | explore <feature> | login [role] | verify [--no-device] | ticket <id>]"
---

Use the Probe MCP tools for this request. Always pass `projectDir` as the current working directory.

Arguments: `$ARGUMENTS`

- empty or `studio` → call `probe_studio_open` and tell the user the URL.
- `doctor` → call `probe_doctor` and show the result; for every failing or warning check, give the fix in one line.
- `scan` → call `probe_scan` with `refresh: true`, then summarise: health counts, the failing features with their reasons, the 5 weakest by coverage, and anything excluded.
- `feature <id>` → call `probe_feature` and list the riskiest untested classes with their files.
- `unit <feature>` → call `probe_unit_run`, then report per-module results; for each failure, quote the test and message and suggest the likely cause from the code.
- `write-tests <feature>` → write the tests yourself: `probe_feature` for the targets, read neighbouring tests, write them, then `probe_unit_run` until they pass. Report what you covered and skipped.
- `cards [feature]` → call `probe_cards_list` and summarise per feature: how many, how many still to review.
- `backfill <feature>` → draft the cards yourself: call `probe_cards_context`, read the code it points to, then `probe_cards_save`. Report what you saved and what you could not work out.
- `run <feature> <card>` → call `probe_card_run`, then report the verdict per expectation, perf warnings, any crash, and the run id (Studio → Runs has screenshots and video).
- `explore <feature>` → call `probe_explore` and report the screens found, how each is reached, and every issue.
- `login [role]` → call `probe_login_check` and say who the app is logged in as.
- `verify [--no-device] [--base <branch>]` → call `probe_verify`, then report per feature: unit result and each card's verdict, perf warnings, features with no approved cards (not checked on a device), and run ids.
- `ticket <id>` → call `probe_ticket` with the ticket, then offer `probe_verify` with that ticket.
- `issues <run>` → call `probe_issues` and list the problems with their ids.
- `fix <issue>` → read `probe_fix_prompt`, fix it yourself in this session, then re-run the unit tests (`probe_unit_run`) and the card (`probe_card_run`). Report root cause, files changed and the re-check result.

Never commit, push or stage anything. Never file a ticket yourself.
