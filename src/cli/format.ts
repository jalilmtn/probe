import type { Card, ScanResult } from "../core/types.js";
import type { FeatureHealth, Health } from "../engine/health.js";

/** Cards as text, grouped by feature. `detail` adds reach, steps and expectations. */
export function formatCards(cards: Card[], detail: boolean): string {
  if (cards.length === 0) return "No cards yet. Draft them with `probe backfill <feature>` or probe_cards_context + probe_cards_save.";
  const out: string[] = [];
  let feature = "";
  for (const c of cards) {
    if (c.feature !== feature) {
      feature = c.feature;
      out.push("", `## ${feature}`);
    }
    out.push(`- ${c.id} [${c.level} · ${c.status} · ${c.confidence}] ${c.title}${c.tickets.length ? ` (${c.tickets.join(", ")})` : ""}`);
    if (detail) {
      out.push(`    reach: ${c.reach.join(" → ")}`);
      if (c.preconditions.length) out.push(`    given: ${c.preconditions.join("; ")}`);
      c.steps.forEach((s, i) => out.push(`    ${i + 1}. ${s}`));
      c.expect.forEach((e) => out.push(`    ✓ [${e.check}] ${e.text}`));
    }
  }
  return out.join("\n").trim();
}

const HEALTH_MARK: Record<Health, string> = { ok: "✓ ok  ", warn: "! warn", fail: "✗ FAIL", unknown: "? —   " };

/** Plain-text Atlas for terminals and agents; with health, each feature's verdict and why. */
export function formatAtlas(result: ScanResult, health?: Map<string, FeatureHealth>): string {
  const rows = result.features.map((f) => {
    const s = f.stats;
    const pct = s.testable ? Math.round((100 * s.direct) / s.testable) : 0;
    const h = health?.get(f.id);
    const verdict = h ? `  ${HEALTH_MARK[h.health]}  ${h.reasons.slice(0, 2).join("; ")}` : "";
    return `${f.group === "feature" ? " " : "·"} ${f.id.padEnd(28)} ${String(s.modules).padStart(3)} mod  ${String(s.testable).padStart(5)} testable  ${String(pct).padStart(3)}% test class  ${String(s.untested).padStart(5)} untested  ${String(s.testFiles).padStart(4)} test files${verdict}`;
  });
  const testable = result.features.reduce((n, f) => n + f.stats.testable, 0);
  const direct = result.features.reduce((n, f) => n + f.stats.direct, 0);
  const header = [
    `${result.project.name} · ${result.project.adapter} · ${result.features.length} groups · scanned ${result.scannedAt}`,
    `Overall: ${testable} testable classes, ${testable ? Math.round((100 * direct) / testable) : 0}% have a test class`,
  ];
  if (result.excluded.length) header.push(`Excluded: ${result.excluded.join(", ")}`);
  if (health) {
    const n = (h: Health) => [...health.values()].filter((x) => x.health === h).length;
    header.push(`Health: ${n("ok")} ok · ${n("warn")} warn · ${n("fail")} fail · ${n("unknown")} never run`);
  }
  return [...header, "", "  (features first, then · platform groups)", ...rows].join("\n");
}
