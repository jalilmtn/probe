import { startCardRun, summarizeCardRun } from "../cards/run.js";
import { listCards } from "../cards/store.js";
import type { Card, CardRun } from "../core/types.js";
import type { Project } from "../engine/project.js";
import { type Freshness, readLedger, ResultFreshness } from "../engine/ledger.js";
import { latestScan } from "../engine/scan.js";
import { cardRef, type FeatureManifest, type Invariant, loadManifest, loadManifests } from "./manifest.js";

/** One device card behind a rule, with what its last run said and whether that still holds. */
export interface CardProof {
  ref: string;
  feature: string;
  id: string;
  card?: Card;
  result?: "passed" | "failed" | "error";
  at?: string;
  freshness: Freshness | "missing";
  reasons: string[];
}

export interface RuleProof {
  feature: string;
  invariant: Invariant;
  cards: CardProof[];
}

/**
 * A rule by its full name: "feature/rule-id" (also "feature:rule-id" or "feature#rule-id").
 * A bare rule id is looked up in every manifest and must be unique.
 */
export function findRule(project: Project, ref: string): { manifest: FeatureManifest; invariant: Invariant } | { error: string } {
  const at = Math.max(ref.lastIndexOf("/"), ref.lastIndexOf("#"), ref.lastIndexOf(":"));
  const candidates = at < 0 ? loadManifests(project.root) : [loadManifest(project.root, ref.slice(0, at))].filter((m): m is FeatureManifest => !!m);
  const id = at < 0 ? ref : ref.slice(at + 1);
  if (at >= 0 && !candidates.length) return { error: `No manifest probe/features/${ref.slice(0, at)}.yaml.` };
  const hits = candidates.flatMap((manifest) => manifest.invariants.filter((i) => i.id === id).map((invariant) => ({ manifest, invariant })));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return { error: `Rule "${id}" is in ${hits.map((h) => h.manifest.id).join(", ")}; name it as feature/${id}.` };
  const known = candidates.flatMap((m) => m.invariants.map((i) => `${m.id}/${i.id}`));
  const near = known.filter((k) => k.includes(id) || id.split("-").some((w) => w.length > 3 && k.includes(w))).slice(0, 5);
  return { error: `No rule "${ref}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}` };
}

/** Every rule of a manifest with its cards' last results; the scan is only read when a card has a result. */
export function ruleProofs(project: Project, manifest: FeatureManifest): RuleProof[] {
  let freshness: ResultFreshness | undefined;
  const ledgers = new Map<string, ReturnType<typeof readLedger>>();
  return manifest.invariants.map((invariant) => ({
    feature: manifest.id,
    invariant,
    cards: invariant.cards.map((ref): CardProof => {
      const { feature, id } = cardRef(manifest.id, ref);
      const card = listCards(project.root, feature).find((c) => c.id === id);
      if (!card) return { ref, feature, id, freshness: "missing", reasons: [] };
      if (!ledgers.has(feature)) ledgers.set(feature, readLedger(project.root, feature));
      const entry = ledgers.get(feature)!.cards?.[id];
      if (!entry) return { ref, feature, id, card, freshness: "never", reasons: [] };
      freshness ??= new ResultFreshness(project, latestScan(project));
      const fresh = freshness.card(card, entry);
      return { ref, feature, id, card, result: entry.result, at: entry.at, freshness: fresh.state, reasons: fresh.reasons };
    }),
  }));
}

/** "passed, still holds" / "failed 2d ago, code changed since" / "never run" / "no such card". */
export function describeCardProof(p: CardProof): string {
  if (p.freshness === "missing") return "no such card";
  if (!p.result) return `never run${p.card?.status === "draft" ? " (draft card)" : ""}`;
  const holds = p.freshness === "fresh" ? "still holds" : p.freshness === "maybe" ? "may not hold: a dependency changed" : `out of date: ${p.reasons.join(", ") || "code changed"}`;
  return `${p.result} ${(p.at ?? "").slice(0, 10)}, ${holds}`;
}

export function summarizeRule(proof: RuleProof): string {
  const inv = proof.invariant;
  const lines = [`${proof.feature}/${inv.id}: ${inv.rule}`];
  for (const t of inv.coveredBy) lines.push(`  test  ${t}`);
  for (const c of proof.cards) lines.push(`  card  ${c.feature}/${c.id}${c.card ? ` "${c.card.title}"` : ""} — ${describeCardProof(c)}`);
  if (!inv.coveredBy.length && !proof.cards.length) lines.push(`  unproven${inv.gap ? `: ${inv.gap}` : ""}`);
  else if (inv.gap) lines.push(`  note  ${inv.gap}`);
  return lines.join("\n");
}

/** Every rule of a feature, one block each. */
export function summarizeRules(project: Project, manifest: FeatureManifest): string {
  return ruleProofs(project, manifest).map(summarizeRule).join("\n");
}

/**
 * Runs the device cards behind a rule, one after another on the same device, and returns
 * each run. A card that does not exist is reported, not run.
 */
export async function runRuleCards(
  project: Project,
  ref: string,
  options: { device?: string; model?: string; log?: (line: string) => void } = {},
): Promise<{ rule: string; runs: CardRun[]; skipped: string[]; error?: string }> {
  const found = findRule(project, ref);
  if ("error" in found) return { rule: ref, runs: [], skipped: [], error: found.error };
  const rule = `${found.manifest.id}/${found.invariant.id}`;
  const proof = ruleProofs(project, found.manifest).find((p) => p.invariant.id === found.invariant.id)!;
  if (!proof.cards.length) {
    return { rule, runs: [], skipped: [], error: `${rule} has no cards. ${found.invariant.coveredBy.length ? "Its unit tests prove it." : "Write one (probe_cards_save) and list it under the rule's cards:."}` };
  }
  const runs: CardRun[] = [];
  const skipped: string[] = [];
  for (const c of proof.cards) {
    if (!c.card) {
      skipped.push(`${c.ref} (no such card)`);
      continue;
    }
    options.log?.(`${rule}: running ${c.feature}/${c.id}`);
    const { done } = startCardRun(project, c.feature, c.id, { device: options.device, model: options.model });
    runs.push(await done);
  }
  return { rule, runs, skipped };
}

export function summarizeRuleRun(r: Awaited<ReturnType<typeof runRuleCards>>): string {
  if (r.error) return r.error;
  const verdict = r.runs.every((x) => x.status === "passed") && !r.skipped.length ? "HOLDS" : r.runs.some((x) => x.status === "failed") ? "BROKEN" : "NOT SHOWN";
  return [`Rule ${r.rule}: ${verdict} on device (${r.runs.length} card${r.runs.length === 1 ? "" : "s"})`, ...r.skipped.map((s) => `  skipped ${s}`), ...r.runs.map(summarizeCardRun)].join("\n");
}
