import { relative } from "node:path";
import type { ClassKind, FeatureInfo } from "../core/types.js";
import { docsAbout } from "../engine/docs.js";
import { commitsTouching } from "../engine/history.js";
import type { Project } from "../engine/project.js";
import { listCards } from "./store.js";

const KEY_KINDS: ClassKind[] = ["viewmodel", "reducer", "usecase", "ui", "repository", "logic"];

/** How cards are written. Shared by the MCP tool and the headless backfill prompt. */
export const CARD_RULES = `## How to write cards

- One \`feature\` card: what this feature is for and how a user gets to it.
- \`capability\` cards: one per user-visible flow (post, edit, delete, retry, empty state, error state…).
  Prefer 4–10 that matter over many trivial ones.
- \`regression\` cards: for fix commits worth guarding, one per bug, citing the commit and its ticket.
  Write the expectation as the correct behaviour that the bug broke.
- \`reach\` is a path from app start a tester can follow on a device. Use visible labels, not class names:
  read the screen (UI) files and string resources for the real button and tab texts.
- \`expect\` items must be observable: on screen (ui), in logcat (log), as a request (network) or
  from app state (state). Use \`manual\` only when nothing else can tell.
- Every card cites \`sources\`: the files, docs, commits or tests it came from.
- \`confidence\`: medium when the code or docs make it clear, low when you inferred it — including a
  \`reach\` path or labels you did not find in the code. Only a device run earns high.
- Ids are kebab-case and stable: re-running the backfill updates the same cards.
- Cards someone already approved or rejected are kept as they are; don't re-propose them.`;

/**
 * Everything worth knowing about a feature before writing its cards, gathered without AI:
 * modules, key classes, navigation, docs, history and existing cards.
 */
export function cardContext(project: Project, feature: FeatureInfo): string {
  const root = project.root;
  const dirs = feature.modules.map((m) => relative(root, m.dir).replace(/\\/g, "/"));
  const classes = feature.modules.flatMap((m) => m.classes.map((c) => ({ ...c, module: m.id })));
  const out: string[] = [`# Feature: ${feature.id} (${project.name})`, ""];

  out.push("## Modules");
  for (const m of feature.modules) out.push(`- ${m.id} → ${relative(root, m.dir).replace(/\\/g, "/")} (${m.mainFiles} source, ${m.testFiles} unit test files)`);

  out.push("", "## Key classes", "Test status: direct = has its own test class, referenced = used by tests, none = untested.");
  for (const kind of KEY_KINDS) {
    const ofKind = classes.filter((c) => c.kind === kind).sort((a, b) => b.lines - a.lines).slice(0, kind === "ui" ? 25 : 15);
    if (ofKind.length === 0) continue;
    out.push(`### ${kind}`);
    for (const c of ofKind) out.push(`- ${c.name} [test: ${c.test}] ${c.file}`);
  }

  const nav = project.adapter.navigationHints(root, feature.modules, 40);
  if (nav.length) out.push("", "## Navigation hints (routes, destinations, deep links)", ...nav.map((l) => `- ${l}`));

  const docs = docsAbout(root, feature.id);
  if (docs.length) {
    out.push("", "## Docs");
    for (const d of docs) out.push(`### ${d.ref}`, d.text.trim(), "");
  }

  const commits = commitsTouching(root, dirs);
  if (commits.length) {
    const fixes = commits.filter((c) => c.fix);
    out.push("", `## History (${commits.length} recent commits, ${fixes.length} look like fixes)`);
    out.push("Fixes (regression card candidates):");
    for (const c of fixes.slice(0, 30)) out.push(`- ${c.hash} ${c.date} ${c.subject}`);
    out.push("Other recent changes:");
    for (const c of commits.filter((x) => !x.fix).slice(0, 25)) out.push(`- ${c.hash} ${c.date} ${c.subject}`);
  }

  const existing = listCards(root, feature.id);
  out.push("", "## Existing cards");
  if (existing.length === 0) out.push("None yet.");
  for (const c of existing) out.push(`- ${c.id} [${c.level}, ${c.status}, ${c.confidence}] ${c.title}`);

  out.push("", CARD_RULES);
  return out.join("\n");
}
