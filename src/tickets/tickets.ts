import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCards } from "../cards/store.js";
import { formatPerf } from "../cards/run.js";
import { isWindows } from "../core/proc.js";
import type { Run } from "../core/types.js";
import { commitsForTicket, filesOfCommit } from "../engine/history.js";
import type { Project } from "../engine/project.js";
import { scan } from "../engine/scan.js";
import { featuresOfFiles } from "../engine/verify.js";

// Tickets are a boundary, not a system Probe owns. In: a ticket id (and optionally its text)
// scopes card drafting and verify runs. Out: a failed run becomes a ticket draft, filed only
// by a command the team configured, and only when a person asks.

export function ticketPattern(project: Project): RegExp {
  return new RegExp(`^${project.config.tickets.pattern}$`);
}

export function ticketUrl(project: Project, id: string): string | undefined {
  return project.config.tickets.url?.replace("{id}", encodeURIComponent(id));
}

/** What the repo knows about a ticket: commits naming it, the features they touched, cards citing it. */
export function ticketInfo(project: Project, id: string) {
  const commits = commitsForTicket(project.root, id);
  const files = [...new Set(commits.flatMap((c) => filesOfCommit(project.root, c.hash)))];
  const { byFeature } = featuresOfFiles(project, scan(project), files);
  const cards = listCards(project.root).filter((c) => c.tickets.includes(id));
  return { id, url: ticketUrl(project, id), commits, features: [...byFeature.keys()], cards: cards.map((c) => `${c.feature}/${c.id}`) };
}

export interface TicketDraft {
  title: string;
  body: string;
}

/** A ticket for a run that did not pass: what was tested, what happened, the evidence. */
export function ticketDraft(project: Project, run: Run): TicketDraft {
  const evidence = join(project.store.dir, "runs", run.id);
  const lines: string[] = [];
  let title = `[Probe] ${run.feature}: ${run.kind} ${run.status}`;
  switch (run.kind) {
    case "card": {
      const card = listCards(project.root, run.feature).find((c) => c.id === run.cardId);
      title = `[Probe] ${run.feature}: "${card?.title ?? run.cardId}" ${run.status} on device`;
      if (card) {
        lines.push(`**Card:** ${card.title} (\`${run.feature}/${card.id}\`, ${card.level})`, "", card.summary, "");
        lines.push("### Steps to reproduce", ...card.reach.map((r, i) => `${i + 1}. ${r}`), ...card.steps.map((s, i) => `${card.reach.length + i + 1}. ${s}`), "");
        if (card.tickets.length) lines.push(`Related: ${card.tickets.join(", ")}`, "");
      }
      const unmet = run.verdict?.expectations.filter((e) => e.met !== true) ?? [];
      if (unmet.length) lines.push("### Expected vs seen", ...unmet.map((e) => `- **Expected:** ${e.text}\n  **Seen:** ${e.evidence}`), "");
      if (run.verdict?.notes) lines.push("### Notes", run.verdict.notes, "");
      break;
    }
    case "explore":
      title = `[Probe] ${run.feature}: ${run.issues.length} navigation issue${run.issues.length === 1 ? "" : "s"}`;
      lines.push("### Issues", ...run.issues.map((i) => `- ${i}`), "", "### Screens reached", ...run.screens.map((s) => `- ${s.name}: ${s.reach.join(" → ")}`), "");
      break;
    case "unit":
      title = `[Probe] ${run.feature}: unit tests ${run.status}`;
      lines.push("### Failing tests", ...run.results.flatMap((r) => r.failures.map((f) => `- \`${f.className}.${f.name}\` (${r.module}): ${(f.message ?? "").split("\n")[0]}`)), "");
      break;
    case "verify":
      title = `[Probe] Verify vs ${run.base}: ${run.status}`;
      for (const f of run.features) {
        lines.push(`- **${f.feature}**: unit ${f.unitStatus ?? "—"}`, ...f.cards.filter((c) => c.status !== "passed").map((c) => `  - ${c.cardId}: ${c.status}${c.note ? ` — ${c.note}` : ""}`));
      }
      lines.push("");
      break;
    default:
      break;
  }
  if ("perf" in run && run.perf) lines.push("### Performance", formatPerf(run.perf), ...run.perf.issues.map((i) => `- ⚠ ${i}`), "");
  if ("crashes" in run && run.crashes.length) lines.push("### Crash", "```", run.crashes[0]!, "```", "");
  if (run.error) lines.push(`**Probe:** ${run.error}`, "");
  if ("device" in run && typeof run.device === "string" && run.device) lines.push(`Device: ${run.device}`);
  lines.push(`Probe run \`${run.id}\` · evidence (screenshots, video, log): \`${evidence}\``);
  return { title, body: lines.join("\n") };
}

/**
 * Files a draft with the team's configured command and returns what it printed (usually
 * the new ticket's URL). Only Studio and the CLI call this, on a person's request.
 */
export function fileTicket(project: Project, run: Run, draft: TicketDraft = ticketDraft(project, run)): string {
  const template = project.config.tickets.fileCommand;
  if (!template) throw new Error("No tickets.fileCommand in probe/probe.yaml; copy the draft instead.");
  const dir = join(project.store.dir, "tickets");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run.id}.md`);
  writeFileSync(file, draft.body);
  const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
  const command = template.replace(/\{title\}/g, quote(draft.title)).replace(/\{file\}/g, quote(file));
  const r = spawnSync(command, { cwd: project.root, windowsHide: true, shell: isWindows ? "cmd.exe" : "/bin/sh", encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Filing failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout.trim();
}
