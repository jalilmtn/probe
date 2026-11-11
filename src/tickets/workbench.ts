import { spawnSync } from "node:child_process";
import { runAgent } from "../agent/headless.js";
import { discussionText, ticketDiscussion } from "../connections/slack.js";
import { runSignal } from "../core/proc.js";
import { newRunId } from "../core/store.js";
import { WORK_STEPS, type WorkbenchConfig, type WorkStep } from "../core/config.js";
import type { WorkRun, WorkStepState, WorkTicket } from "../core/types.js";
import { dirtyFiles } from "../engine/history.js";
import type { Project } from "../engine/project.js";
import { launchRun } from "../engine/runs.js";
import { latestScan } from "../engine/scan.js";
import { startUnitRun } from "../engine/unit.js";
import { featuresOfFiles, startVerify } from "../engine/verify.js";
import { inboxTicket, type InboxTicket } from "./inbox.js";
import { openTracker } from "./tracker.js";

// The workbench: a developer picks tickets, ticks what the agent should do for each, and the
// agent works through them one at a time. Each ticket's changes become their own commit, made
// locally. Nothing is pushed, and nothing is posted to a tracker unless the person ticked it.

export const STEP_LABEL: Record<WorkStep, string> = {
  context: "Read ticket and Slack",
  fix: "Write the change",
  unitwrite: "Write unit tests",
  unit: "Run unit tests",
  ui: "Test the UI",
  validate: "Check against the ticket",
  commit: "Commit",
  comment: "Comment on the ticket",
};

// ── Pure helpers ────────────────────────────────────────────────────────────

/** A commit type from the ticket's labels and title: fix for bugs, test, docs, chore, else feat. */
export function commitType(ticket: { title: string; labels?: string[] }): string {
  const words = `${(ticket.labels ?? []).join(" ")} ${ticket.title}`.toLowerCase();
  if (/\b(bug|fix|crash|broken|error|regression|defect)\b/.test(words)) return "fix";
  if (/\b(test|tests|coverage)\b/.test(words)) return "test";
  if (/\b(docs?|documentation|readme)\b/.test(words)) return "docs";
  if (/\b(chore|refactor|cleanup|upgrade|bump)\b/.test(words)) return "chore";
  return "feat";
}

/** The commit message the pattern makes for a ticket. Empty `{area}` collapses its brackets. */
export function commitMessage(pattern: string, ticket: { key: string; title: string; labels?: string[] }, area?: string): string {
  const title = ticket.title.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  let out = pattern
    .replace(/\{key\}/g, ticket.key)
    .replace(/\{title\}/g, title)
    .replace(/\{type\}/g, commitType(ticket))
    .replace(/\{area\}/g, area ?? "");
  // "feat(): x" → "feat: x" when no area is known.
  out = out.replace(/\(\s*\)/g, "").replace(/\[\s*\]/g, "").replace(/ {2,}/g, " ").trim();
  return out;
}

export type TicketGroup = "mine" | "notForMe" | "hidden";

/** Whether a ticket is yours to do, not for you by the project's rules, or hidden by hand. */
export function ticketGroup(
  ticket: { id: string; source?: string; assignee?: string; labels: string[]; status: string },
  rules: WorkbenchConfig,
  me: string[],
): { group: TicketGroup; why?: string } {
  if (rules.hidden.includes(`${ticket.source ?? ""}/${ticket.id}`)) return { group: "hidden", why: "you hid it" };
  const labels = new Set(ticket.labels.map((l) => l.toLowerCase()));
  const label = rules.notForMe.labels.find((l) => labels.has(l.toLowerCase()));
  if (label) return { group: "notForMe", why: `label ${label}` };
  const status = rules.notForMe.statuses.find((s) => s.toLowerCase() === ticket.status.toLowerCase());
  if (status) return { group: "notForMe", why: `status ${status}` };
  if (rules.notForMe.otherAssignee && ticket.assignee && me.length && !me.some((m) => m.toLowerCase() === ticket.assignee!.toLowerCase()))
    return { group: "notForMe", why: `assigned to ${ticket.assignee}` };
  return { group: "mine" };
}

/** The chosen steps in their fixed order; unknown ones are dropped. */
export function orderSteps(steps: string[]): WorkStep[] {
  return WORK_STEPS.filter((s) => steps.includes(s));
}

/** Files changed by a ticket: new or different since `before`. Files already dirty before are `conflicts`. */
export function changedSince(before: Map<string, string>, after: Map<string, string>): { files: string[]; conflicts: string[] } {
  const files: string[] = [];
  const conflicts: string[] = [];
  for (const [file, st] of after) {
    if (!before.has(file)) files.push(file);
    else if (before.get(file) !== st) conflicts.push(file);
  }
  return { files: files.sort(), conflicts: conflicts.sort() };
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface WorkOptions {
  tickets: { key: string; source?: string }[];
  steps: string[];
  commitPattern?: string;
  /** Coding model and account for this run, over Settings → AI. */
  model?: string;
  account?: string;
}

function git(root: string, args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

function ticketPrompt(t: InboxTicket, discussion: string, task: "fix" | "unitwrite", files: string[]): string {
  const head = [
    `You are working on ticket ${t.id}${t.sourceLabel ? ` from ${t.sourceLabel}` : ""}: ${t.title}`,
    "",
    "Ticket text:",
    t.description.trim() || "(no description)",
    t.labels.length ? `\nLabels: ${t.labels.join(", ")}` : "",
    discussion ? `\nWhat the team said about it in Slack (newest first):\n${discussion}` : "",
  ];
  if (task === "fix")
    return [
      ...head,
      "",
      "Make the change this ticket asks for in this project's code. Read the code first (probe_feature helps find a feature's files).",
      "Keep the change focused on this ticket. Do not commit, do not run commands. Edit files only.",
      "When done, answer with a short summary of what you changed and anything still open.",
    ].join("\n");
  return [
    ...head,
    "",
    `The change for this ticket touched: ${files.join(", ") || "(no files yet)"}.`,
    "Write or extend unit tests that prove the ticket's behaviour, next to the project's existing tests and in their style.",
    "Only add or edit test files. Do not run commands. Answer with a short list of the tests you wrote.",
  ].join("\n");
}

function validatePrompt(t: InboxTicket, diff: string): string {
  return [
    `Ticket ${t.id}: ${t.title}`,
    "",
    t.description.trim() || "(no description)",
    "",
    "This is the change made for it (git diff):",
    diff.slice(0, 60_000) || "(no change)",
    "",
    "Judge whether the change does what the ticket asks, criterion by criterion. Do not edit anything.",
    'End your answer with one line: "VERDICT: PASS" or "VERDICT: FAIL", then one line saying why.',
  ].join("\n");
}

/** Works through the tickets one at a time; each gets its own steps and, if chosen, its own commit. */
export function startWork(project: Project, options: WorkOptions): { run: WorkRun; done: Promise<WorkRun> } {
  const steps = orderSteps(options.steps);
  if (!options.tickets.length) throw new Error("Choose at least one ticket.");
  if (!steps.length) throw new Error("Choose at least one step.");
  const pattern = options.commitPattern?.trim() || project.config.workbench.commitPattern;
  const run: WorkRun = {
    id: newRunId(),
    kind: "work",
    feature: "*",
    startedAt: new Date().toISOString(),
    status: "running",
    steps,
    commitPattern: pattern,
    costUsd: 0,
    tickets: options.tickets.map((t) => ({
      key: t.key,
      source: t.source,
      title: t.key,
      status: "queued",
      files: [],
      steps: steps.map((step) => ({ step, status: "queued" })),
    })),
  };

  return launchRun(project, run, async (log) => {
    for (const ticket of run.tickets) {
      if (runSignal.getStore()?.aborted) break;
      log(`══ ${ticket.key}`);
      ticket.status = "running";
      try {
        await workOn(project, run, ticket, steps, pattern, options.model, options.account, log);
      } catch (e) {
        ticket.status = "error";
        ticket.summary = (e as Error).message;
        log(`${ticket.key}: ${(e as Error).message}`);
      }
      for (const s of ticket.steps) if (s.status === "queued") s.status = "skipped";
    }
    const bad = run.tickets.filter((t) => t.status !== "passed");
    run.status = bad.length === 0 ? "passed" : run.tickets.some((t) => t.status === "error") ? "failed" : "blocked";
    if (bad.length) run.error = `${bad.length} of ${run.tickets.length} ticket(s) need you: ${bad.map((t) => t.key).join(", ")}.`;
  });
}

async function workOn(project: Project, run: WorkRun, ticket: WorkTicket, steps: WorkStep[], pattern: string, model: string | undefined, account: string | undefined, log: (l: string) => void): Promise<void> {
  const state = (step: WorkStep) => ticket.steps.find((s) => s.step === step)!;
  const fail = (s: WorkStepState, note: string, status: WorkStepState["status"] = "failed") => {
    s.status = status;
    s.note = note;
    ticket.status = "needs-you";
    log(`✗ ${STEP_LABEL[s.step]}: ${note}`);
  };
  const t = await inboxTicket(project, ticket.key, undefined, ticket.source);
  ticket.title = t.title;
  const before = dirtyFiles(project.root);
  let discussion = "";
  let features: string[] = t.features;

  for (const step of steps) {
    if (runSignal.getStore()?.aborted) return;
    if (ticket.status === "needs-you") return;
    const s = state(step);
    s.status = "running";
    log(`── ${STEP_LABEL[step]}`);

    if (step === "context") {
      const found = await ticketDiscussion(project, { id: t.id, title: t.title, labels: t.labels });
      discussion = discussionText(found.matches);
      s.status = "passed";
      s.note = `${found.matches.length} Slack message(s)${found.searched.length ? ` in ${found.searched.join(", ")}` : ""}${found.errors.length ? ` · ${found.errors.join("; ")}` : ""}`;
      continue;
    }

    if (step === "fix" || step === "unitwrite") {
      const changed = changedSince(before, dirtyFiles(project.root)).files;
      const result = await runAgent(
        project,
        { prompt: ticketPrompt(t, discussion, step, changed), probeTools: ["probe_feature", "probe_cards_list"], model: model ?? undefined, allowEdits: true, role: "coding", account },
        log,
      );
      run.costUsd += result.costUsd;
      if (step === "fix") ticket.summary = result.summary.slice(0, 2000);
      const now = changedSince(before, dirtyFiles(project.root));
      ticket.files = now.files;
      if (!result.ok) {
        fail(s, `agent stopped: ${result.summary.slice(0, 200)}`);
        return;
      }
      if (step === "fix" && now.files.length === 0) {
        fail(s, `no file changed. Agent: ${result.summary.slice(0, 200)}`, "blocked");
        return;
      }
      s.status = "passed";
      s.note = `${now.files.length} file(s) changed`;
      continue;
    }

    if (step === "unit" || step === "ui") {
      const scanned = latestScan(project);
      const own = featuresOfFiles(project, scanned, ticket.files).byFeature;
      features = [...new Set([...own.keys(), ...(own.size ? [] : features)])];
      if (!features.length) {
        s.status = "skipped";
        s.note = "no feature owns the changed files";
        continue;
      }
      if (step === "unit") {
        for (const feature of features) {
          const { run: unit, done } = startUnitRun(project, feature);
          s.runId = unit.id;
          const finished = await done;
          if (finished.status !== "passed") {
            fail(s, `${feature}: unit tests ${finished.status}${finished.error ? ` (${finished.error})` : ""}`);
            return;
          }
        }
        s.status = "passed";
        s.note = `${features.join(", ")} passed`;
      } else {
        const { run: verify, done } = startVerify(project, { features, noUnit: true, cards: "all", model });
        s.runId = verify.id;
        const finished = await done;
        run.costUsd += finished.costUsd;
        if (finished.status !== "passed") {
          fail(s, `UI test ${finished.status}${finished.error ? ` (${finished.error})` : ""}`);
          return;
        }
        s.status = "passed";
      }
      continue;
    }

    if (step === "validate") {
      const diff = ticket.files.length ? (git(project.root, ["diff", "--", ...ticket.files]).stdout ?? "") : "";
      const result = await runAgent(project, { prompt: validatePrompt(t, diff), probeTools: [], role: "review" }, log);
      run.costUsd += result.costUsd;
      const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(result.summary)?.[1]?.toUpperCase();
      const why = result.summary.split(/VERDICT:\s*(?:PASS|FAIL)/i)[1]?.trim().split("\n")[0] ?? "";
      if (verdict !== "PASS") {
        fail(s, verdict === "FAIL" ? `does not meet the ticket: ${why || result.summary.slice(-200)}` : "the check gave no verdict");
        return;
      }
      s.status = "passed";
      s.note = why.slice(0, 200);
      continue;
    }

    if (step === "commit") {
      const now = changedSince(before, dirtyFiles(project.root));
      ticket.files = now.files;
      if (now.conflicts.length) {
        fail(s, `not committed: ${now.conflicts.slice(0, 5).join(", ")} had uncommitted changes before this ticket. Review and commit by hand.`, "blocked");
        return;
      }
      if (!now.files.length) {
        s.status = "skipped";
        s.note = "nothing to commit";
        continue;
      }
      const area = features.length === 1 ? features[0] : undefined;
      const message = commitMessage(pattern, { key: t.id, title: t.title, labels: t.labels }, area);
      const add = git(project.root, ["add", "--", ...now.files]);
      if (add.status !== 0) {
        fail(s, `git add failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`);
        return;
      }
      // Only this ticket's files: anything else staged stays out of the commit.
      const commit = git(project.root, ["commit", "-m", message, "--", ...now.files]);
      if (commit.status !== 0) {
        fail(s, `git commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}`);
        return;
      }
      const hash = git(project.root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
      ticket.commit = { hash, message };
      s.status = "passed";
      s.note = `${hash} ${message}`;
      log(`committed ${hash}: ${message}`);
      continue;
    }

    if (step === "comment") {
      const tracker = openTracker(project, undefined, ticket.source);
      const lines = [
        tracker.bold(`Probe workbench: ${ticket.key}`),
        ...ticket.steps.filter((x) => x.step !== "comment" && x.status !== "queued").map((x) => `- ${x.status === "passed" ? "✓" : x.status === "skipped" ? "–" : "✗"} ${STEP_LABEL[x.step]}${x.note ? `: ${x.note}` : ""}`),
        ticket.commit ? `\nCommitted locally as ${ticket.commit.hash} (not pushed).` : "",
      ];
      await tracker.comment(ticket.key, lines.join("\n").trim());
      s.status = "passed";
      continue;
    }
  }
  ticket.status = "passed";
}
