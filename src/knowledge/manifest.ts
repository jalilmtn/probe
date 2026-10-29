import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { listCards } from "../cards/store.js";
import { capture } from "../core/proc.js";
import { isTestPath, SOURCE_EXT, stemOf, testNamesIn } from "../core/testfiles.js";

/**
 * What a team writes down about one feature, in `probe/features/<id>.yaml`: the code it owns,
 * what a user can do with it, and the rules that must hold, each tied to the test that proves it.
 * Modules, classes and coverage are not in here: the scan derives those from the code.
 * A platform area (shared code such as `core:database`) has a manifest of the same shape.
 */
export interface FeatureManifest {
  id: string;
  /** A product feature, or a platform area other code builds on. Unset reads as "feature". */
  kind: ManifestKind;
  name?: string;
  summary?: string;
  owner?: string | null;
  /** The feature's doc for people and agents, repo relative. */
  brief?: string;
  alsoRead: string[];
  /** Code this feature owns (prefix match, repo relative). */
  paths: string[];
  /** Code owned elsewhere that this feature depends on: an edit there marks it stale. */
  related: { path: string; why?: string }[];
  unitCommand?: string;
  flows: { id: string; text: string }[];
  invariants: Invariant[];
  deviceOnly: string[];
  /** Repo-relative path of the manifest itself. */
  file: string;
}

export interface Invariant {
  id: string;
  rule: string;
  /** "TestClass :: test name", exactly as the test is written. */
  coveredBy: string[];
  /**
   * Device cards that prove the rule, "card-id" in this feature or "feature/card-id" in another.
   * Read from `cards:`, or the older single `card:`.
   */
  cards: string[];
  gap?: string | null;
}

export type ManifestKind = "feature" | "platform";
export const MANIFEST_KINDS: readonly ManifestKind[] = ["feature", "platform"];

export const FEATURES_DIR = "probe/features";

/**
 * Platform ids contain ":" (`core:database`), which no Windows file name may: it becomes "__",
 * as in card folders and result ledgers.
 */
export function manifestFile(id: string): string {
  return `${FEATURES_DIR}/${id.replace(/:/g, "__")}.yaml`;
}

/** The id a manifest file name stands for: `core__database.yaml` → "core:database". */
export function manifestIdOf(fileName: string): string {
  return basename(fileName, ".yaml").replace(/__/g, ":");
}

export function loadManifest(root: string, id: string): FeatureManifest | null {
  const file = manifestFile(id);
  const abs = join(root, file);
  if (!existsSync(abs)) return null;
  return normalize(parse(readFileSync(abs, "utf8")) ?? {}, file);
}

/** Every manifest in the project; one that does not parse is skipped rather than failing the rest. */
export function loadManifests(root: string): FeatureManifest[] {
  const dir = join(root, FEATURES_DIR);
  if (!existsSync(dir)) return [];
  const out: FeatureManifest[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
    try {
      const m = loadManifest(root, manifestIdOf(name));
      if (m) out.push(m);
    } catch {
      // A half-edited manifest must not stop the edit hook; checkManifest reports it.
    }
  }
  return out;
}

type Raw = Record<string, unknown>;

function normalize(raw: Raw, file: string): FeatureManifest {
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const slash = (p: string) => String(p).replace(/\\/g, "/");
  return {
    id: String(raw.id ?? manifestIdOf(file)),
    kind: raw.kind === "platform" ? "platform" : "feature",
    name: raw.name as string | undefined,
    summary: raw.summary as string | undefined,
    owner: (raw.owner as string | null | undefined) ?? null,
    brief: raw.brief as string | undefined,
    alsoRead: list<string>(raw.also_read),
    paths: list<string>(raw.paths).map(slash),
    related: list<Raw | string>(raw.related).map((r) => (typeof r === "string" ? { path: slash(r) } : { path: slash(String(r.path)), why: r.why as string | undefined })),
    unitCommand: (raw.unit as Raw | undefined)?.command as string | undefined,
    flows: list<Raw>(raw.flows).map((f) => ({ id: String(f.id), text: String(f.text ?? "") })),
    invariants: list<Raw>(raw.invariants).map((i) => ({
      id: String(i.id),
      rule: String(i.rule ?? ""),
      coveredBy: list<string>(i.covered_by),
      cards: [...list<string>(i.cards), ...(typeof i.card === "string" && i.card ? [i.card] : [])].map(String),
      gap: (i.gap as string | null | undefined) ?? null,
    })),
    deviceOnly: list<Raw | string>(raw.device_only).map((d) => (typeof d === "string" ? d : String(d.text ?? ""))),
    file,
  };
}

export interface LinkProblem {
  invariant: string;
  entry: string;
  problem: "no test class" | "no such test";
  /** The nearest existing test name in that class, when there is one. */
  closest?: string;
}

export interface ManifestCheck {
  feature: string;
  file: string;
  /** The manifest does not parse, or is missing something it needs. */
  errors: string[];
  links: number;
  broken: LinkProblem[];
  /** Invariants nothing proves yet, with the reason the manifest gives. */
  gaps: { invariant: string; rule: string; gap: string }[];
  /** Invariants with no test, no card and no stated gap. */
  unexplained: string[];
  missingPaths: string[];
  cardLinks: number;
  /** Card links that name no card in probe/cards. */
  brokenCards: { invariant: string; card: string; closest?: string }[];
}

/** A rule's card link as a card: "id" belongs to the manifest's own feature. */
export function cardRef(feature: string, ref: string): { feature: string; id: string } {
  const at = ref.lastIndexOf("/");
  return at < 0 ? { feature, id: ref } : { feature: ref.slice(0, at), id: ref.slice(at + 1) };
}

/**
 * Checks a manifest against the code: every `covered_by` names a test that exists under that
 * exact name, every path exists, every unproven rule says why. Pure file reads, no build.
 * `text` checks a manifest that is not on disk yet, such as a draft.
 */
export function checkManifest(root: string, id: string, text?: string): ManifestCheck {
  const file = manifestFile(id);
  const result: ManifestCheck = { feature: id, file, errors: [], links: 0, broken: [], gaps: [], unexplained: [], missingPaths: [], cardLinks: 0, brokenCards: [] };
  let raw: Raw | null;
  try {
    const source = text ?? (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null);
    raw = source === null ? null : ((parse(source) ?? {}) as Raw);
  } catch (e) {
    result.errors.push(`Does not parse: ${(e as Error).message.split("\n")[0]}`);
    return result;
  }
  if (!raw) {
    result.errors.push("No manifest.");
    return result;
  }
  const m = normalize(raw, file);
  if (m.id !== id) result.errors.push(`id is "${m.id}" but the file is ${basename(file)}`);
  if (raw.kind !== undefined && !MANIFEST_KINDS.includes(raw.kind as ManifestKind)) result.errors.push(`kind is "${String(raw.kind)}"; it is one of ${MANIFEST_KINDS.join(", ")}.`);
  if (!m.summary) result.errors.push("No summary.");
  if (m.brief && !existsSync(join(root, m.brief))) result.errors.push(`Brief ${m.brief} does not exist.`);
  for (const p of [...m.paths, ...m.related.map((r) => r.path)]) if (!existsSync(join(root, p))) result.missingPaths.push(p);

  const tests = testIndex(root);
  for (const inv of m.invariants) {
    if (!inv.coveredBy.length && !inv.cards.length) {
      if (inv.gap) result.gaps.push({ invariant: inv.id, rule: inv.rule, gap: inv.gap });
      else result.unexplained.push(inv.id);
    }
    for (const ref of inv.cards) {
      result.cardLinks++;
      const target = cardRef(m.id, ref);
      const ids = listCards(root, target.feature).map((c) => c.id);
      if (ids.includes(target.id)) continue;
      const near = closest(target.id.replace(/-/g, " "), ids.map((i) => i.replace(/-/g, " ")));
      result.brokenCards.push({ invariant: inv.id, card: ref, closest: near?.replace(/ /g, "-") });
    }
    for (const entry of inv.coveredBy) {
      result.links++;
      const [cls, name] = entry.split(" :: ").map((s) => s.trim());
      const files = tests.get(cls ?? "") ?? [];
      if (!files.length) {
        result.broken.push({ invariant: inv.id, entry, problem: "no test class" });
        continue;
      }
      const names = files.flatMap((f) => testNames(join(root, f)));
      if (!names.includes(name ?? "")) result.broken.push({ invariant: inv.id, entry, problem: "no such test", closest: closest(name ?? "", names) });
    }
  }
  return result;
}

/** One listing serves a pass over every manifest: git takes most of a second on a big repo. */
let indexed: { root: string; at: number; tests: Map<string, string[]> } | null = null;

/** Test source files by class name, from git (tracked and untracked, ignoring build output). */
export function testIndex(root: string): Map<string, string[]> {
  if (indexed && indexed.root === root && Date.now() - indexed.at < 2000) return indexed.tests;
  const out = new Map<string, string[]>();
  const listed = capture("git", ["ls-files", "-co", "--exclude-standard"], root) ?? "";
  for (const f of listed.split("\n")) {
    // Kotlin and Java tests live in Gradle's test source sets; any other language by its own conventions.
    const jvm = /\.(kt|java)$/.test(f);
    if (jvm ? !/\/src\/(test|androidTest)[^/]*\//.test(f) : !SOURCE_EXT.test(f) || !isTestPath(f)) continue;
    const cls = stemOf(basename(f));
    out.set(cls, [...(out.get(cls) ?? []), f]);
  }
  indexed = { root, at: Date.now(), tests: out };
  return out;
}

/** Kotlin backtick names, plain `fun name(` / Java `void name(` methods; other languages' `test("…")`, `def test_…`, `func Test…`. */
export function testNames(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (/\.(kt|java)$/.test(file)) return [...text.matchAll(/fun\s+`([^`]+)`/g), ...text.matchAll(/(?:fun|void)\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!);
  return testNamesIn(text);
}

function closest(name: string, names: string[]): string | undefined {
  const words = new Set(name.toLowerCase().split(/\W+/).filter(Boolean));
  let best: { n: string; score: number } | undefined;
  for (const n of names) {
    const other = n.toLowerCase().split(/\W+/).filter(Boolean);
    const score = other.filter((w) => words.has(w)).length / Math.max(words.size, other.length, 1);
    if (!best || score > best.score) best = { n, score };
  }
  return best && best.score >= 0.5 ? best.n : undefined;
}

/** The brief's "At a glance" section as plain markdown, or null when it has none. */
export function briefGlance(root: string, m: FeatureManifest): string | null {
  if (!m.brief || !existsSync(join(root, m.brief))) return null;
  const text = readFileSync(join(root, m.brief), "utf8");
  const match = /^##\s+(?:0\)\s*)?At a glance\s*$([\s\S]*?)(?=^##\s)/m.exec(text);
  return match ? match[1]!.trim() : null;
}

export function summarizeCheck(c: ManifestCheck): string {
  const lines = [
    `Manifest ${c.file} · ${c.links} test links · ${c.cardLinks} card links · ${c.broken.length + c.brokenCards.length} broken · ${c.gaps.length} unproven rules`,
  ];
  for (const e of c.errors) lines.push(`  error: ${e}`);
  for (const p of c.missingPaths) lines.push(`  missing path: ${p}`);
  for (const b of c.broken) lines.push(`  broken (${b.invariant}): ${b.entry} — ${b.problem}${b.closest ? `; closest: "${b.closest}"` : ""}`);
  for (const b of c.brokenCards) lines.push(`  broken (${b.invariant}): card ${b.card} — no such card${b.closest ? `; closest: "${b.closest}"` : ""}`);
  for (const u of c.unexplained) lines.push(`  ${u}: no test, no card and no gap given`);
  for (const g of c.gaps) lines.push(`  unproven (${g.invariant}): ${g.gap}`);
  return lines.join("\n");
}
