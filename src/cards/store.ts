import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { CONFIG_DIR } from "../core/config.js";
import type { Card, CardStatus } from "../core/types.js";
import { CardInput } from "./schema.js";

/**
 * Cards live in the project, `probe/cards/<feature>/<id>.yaml`, so they are reviewed and
 * shared like code. Feature ids may contain ":" (platform groups), which is not a legal
 * folder character on Windows.
 */
export function cardsDir(root: string, feature?: string): string {
  const base = join(root, CONFIG_DIR, "cards");
  return feature ? join(base, feature.replace(/:/g, "__")) : base;
}

export function listCards(root: string, feature?: string): Card[] {
  const base = cardsDir(root);
  if (!existsSync(base)) return [];
  const folders = feature ? [cardsDir(root, feature)] : readdirSync(base).map((d) => join(base, d));
  return folders
    .filter(existsSync)
    .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => join(dir, f)))
    .map((file) => parse(readFileSync(file, "utf8")) as Card)
    .sort((a, b) => a.feature.localeCompare(b.feature) || levelOrder(a) - levelOrder(b) || a.id.localeCompare(b.id));
}

export function findCard(root: string, feature: string, id: string): Card | undefined {
  return listCards(root, feature).find((c) => c.id === id);
}

export interface SaveResult {
  written: string[];
  /** Ids skipped because a person already approved or rejected them. */
  kept: string[];
  errors: string[];
}

/**
 * Writes agent-drafted cards. A card someone has reviewed is never overwritten, and
 * confidence is capped at "medium" unless a source says it was seen on a device.
 */
export function saveCards(root: string, feature: string, inputs: unknown[], createdBy: Card["createdBy"]): SaveResult {
  const result: SaveResult = { written: [], kept: [], errors: [] };
  const existing = new Map(listCards(root, feature).map((c) => [c.id, c]));
  const dir = cardsDir(root, feature);
  mkdirSync(dir, { recursive: true });

  inputs.forEach((raw, i) => {
    const parsed = CardInput.safeParse(raw);
    if (!parsed.success) {
      result.errors.push(`card ${i}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      return;
    }
    const input = parsed.data;
    const prior = existing.get(input.id);
    if (prior && prior.status !== "draft") {
      result.kept.push(input.id);
      return;
    }
    const seenOnDevice = input.sources.some((s) => s.type === "device");
    const card: Card = {
      id: input.id,
      feature,
      level: input.level,
      title: input.title,
      summary: input.summary,
      reach: input.reach,
      preconditions: input.preconditions,
      steps: input.steps,
      expect: input.expect,
      accounts: input.accounts,
      modules: input.modules,
      tickets: input.tickets,
      sources: input.sources,
      confidence: input.confidence === "high" && !seenOnDevice ? "medium" : input.confidence,
      status: "draft",
      createdBy,
      updatedAt: new Date().toISOString(),
    };
    writeCard(root, card);
    result.written.push(card.id);
  });
  return result;
}

export function setCardStatus(root: string, feature: string, id: string, status: CardStatus): Card {
  const card = listCards(root, feature).find((c) => c.id === id);
  if (!card) throw new Error(`No card "${id}" in ${feature}`);
  const updated = { ...card, status, updatedAt: new Date().toISOString() };
  writeCard(root, updated);
  return updated;
}

/**
 * A passing device run is what earns "high": the card was seen to be true. Its review status
 * is left alone; passing a run is not the same as a person approving the card.
 */
export function recordDeviceRun(root: string, feature: string, id: string, runId: string): void {
  const card = listCards(root, feature).find((c) => c.id === id);
  if (!card) return;
  const sources = [...card.sources.filter((s) => s.type !== "device"), { type: "device" as const, ref: runId, note: "passed on device" }];
  writeCard(root, { ...card, confidence: "high", sources, updatedAt: new Date().toISOString() });
}

function writeCard(root: string, card: Card): void {
  writeFileSync(join(cardsDir(root, card.feature), `${card.id}.yaml`), stringify(card, { lineWidth: 100 }));
}

function levelOrder(c: Card): number {
  return c.level === "feature" ? 0 : c.level === "capability" ? 1 : 2;
}

export interface CardCounts {
  total: number;
  draft: number;
  approved: number;
  rejected: number;
  low: number;
}

export function countCards(cards: Card[]): Map<string, CardCounts> {
  const out = new Map<string, CardCounts>();
  for (const c of cards) {
    const n = out.get(c.feature) ?? { total: 0, draft: 0, approved: 0, rejected: 0, low: 0 };
    n.total++;
    n[c.status]++;
    if (c.confidence === "low") n.low++;
    out.set(c.feature, n);
  }
  return out;
}
