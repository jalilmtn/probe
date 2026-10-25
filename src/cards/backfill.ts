import { runAgent } from "../agent/headless.js";
import { newRunId } from "../core/store.js";
import type { BackfillRun, FeatureInfo } from "../core/types.js";
import type { Project } from "../engine/project.js";
import { launchRun } from "../engine/runs.js";
import { findFeature, latestScan } from "../engine/scan.js";
import { listCards } from "./store.js";

export interface TicketInput {
  id: string;
  /** The ticket's text as pasted by a person; optional, commits naming the ticket are found anyway. */
  text?: string;
}

/** The headless agent's instructions for one feature. */
function prompt(feature: FeatureInfo, ticket?: TicketInput): string {
  const fromTicket = ticket
    ? `
This run starts from the ticket ${ticket.id}. Draft the cards this ticket needs (the behaviour it asks for or the bug it fixes) and put "${ticket.id}" in each card's tickets. Keep other cards as they are.
${ticket.text ? `\n## Ticket ${ticket.id}\n\`\`\`\n${ticket.text.slice(0, 8000)}\n\`\`\`\n` : ""}`
    : "";
  return `You are ${ticket ? "drafting" : "backfilling"} Probe feature cards for the feature "${feature.id}" of the project in the current directory.
${fromTicket}
1. Call probe_cards_context with feature "${feature.id}". It lists modules, key classes, navigation hints, docs, git history and the rules for cards.
2. Read the code you need to understand the user-visible behaviour: the screen/UI files (for the labels a user sees and how the feature is entered), view models / reducers, use cases, and the existing unit tests. Read only; do not edit anything.
3. Draft the cards following the rules${ticket ? ` for what ${ticket.id} covers` : ": one feature card, capability cards for the flows that matter, regression cards for fix commits worth guarding"}.
4. Call probe_cards_save once with feature "${feature.id}" and all cards. If it reports validation errors, fix those cards and save them again.
5. Finish with a two-line summary: how many cards, and anything you could not work out from the code.`;
}

/**
 * Drafts cards with a headless agent per feature. `featureId` "*" means every feature that
 * has none yet; a list (from a ticket) means exactly those.
 */
export function startBackfill(
  project: Project,
  featureId: string | string[],
  options: { model?: string; ticket?: TicketInput } = {},
): { run: BackfillRun; done: Promise<BackfillRun> } {
  const scan = latestScan(project);
  const targets =
    featureId === "*"
      ? scan.features.filter((f) => f.group === "feature" && listCards(project.root, f.id).length === 0)
      : (Array.isArray(featureId) ? featureId : [featureId]).map((id) => findFeature(scan, id)).filter((f): f is FeatureInfo => f !== undefined);
  if (targets.length === 0) {
    throw new Error(featureId === "*" ? "Every feature already has cards." : `Unknown feature "${String(featureId)}".`);
  }

  const run: BackfillRun = {
    id: newRunId(),
    kind: "backfill",
    feature: featureId === "*" || targets.length > 1 ? "*" : targets[0]!.id,
    ticket: options.ticket?.id,
    startedAt: new Date().toISOString(),
    status: "running",
    written: [],
    kept: [],
    costUsd: 0,
  };

  return launchRun(project, run, async (log) => {
    // Feature id plus the agent's last words, which say why it wrote nothing (limits, errors).
    const failed: string[] = [];
    for (const [i, feature] of targets.entries()) {
      log(`── ${feature.id} (${i + 1}/${targets.length})`);
      const before = new Map(listCards(project.root, feature.id).map((c) => [c.id, c.updatedAt]));
      const result = await runAgent(project, { prompt: prompt(feature, options.ticket), probeTools: ["probe_cards_context", "probe_cards_save"], model: options.model }, log);
      run.costUsd += result.costUsd;

      // What changed on disk is the truth, whatever the agent says it did.
      const after = listCards(project.root, feature.id);
      const written = after.filter((c) => before.get(c.id) !== c.updatedAt).map((c) => `${feature.id}/${c.id}`);
      run.written.push(...written);
      run.kept.push(...after.filter((c) => c.status !== "draft").map((c) => `${feature.id}/${c.id}`));
      log(`${feature.id}: ${written.length} cards written`);
      if (!result.ok || written.length === 0) failed.push(`${feature.id} (agent: ${result.summary.slice(0, 200)})`);
    }
    if (failed.length) {
      run.status = "failed";
      run.error = `No cards written for: ${failed.join(", ")}`;
    }
  });
}

export function summarizeBackfill(run: BackfillRun): string {
  const lines = [`Backfill ${run.id} · ${run.feature}${run.ticket ? ` · from ${run.ticket}` : ""} · ${run.status.toUpperCase()} · ${run.written.length} cards written · $${run.costUsd.toFixed(2)}`];
  if (run.error) lines.push(run.error);
  for (const id of run.written) lines.push(`  + ${id}`);
  if (run.kept.length) lines.push(`  kept (already reviewed): ${run.kept.join(", ")}`);
  return lines.join("\n");
}
