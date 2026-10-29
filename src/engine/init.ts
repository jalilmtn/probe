import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stemOf } from "../core/testfiles.js";
import { dirname, join, relative } from "node:path";
import featuresGuide from "../../templates/agents-features.md";
import featuresReadme from "../../templates/features-README.md";
import { runAgent } from "../agent/headless.js";
import { listCards } from "../cards/store.js";
import { CONFIG_TEMPLATE, configPath } from "../core/config.js";
import { newRunId } from "../core/store.js";
import type { FeatureInfo, InitRun, InitStepState } from "../core/types.js";
import { closeDraft, type Draft, listDrafts, openDraft } from "../knowledge/draft.js";
import { checkManifest, FEATURES_DIR, loadManifest, loadManifests, manifestFile, type ManifestKind, summarizeCheck, testIndex, testNames } from "../knowledge/manifest.js";
import { docsAbout } from "./docs.js";
import { areaGraph, usedBy, uses } from "./impact.js";
import { doctor } from "./doctor.js";
import type { Project } from "./project.js";
import { launchRun, liveRun } from "./runs.js";
import { latestScan, scan } from "./scan.js";

/**
 * `probe init`: everything a project needs before Probe can keep its features current, in order.
 * Each step reads its state from the project itself (files, drafts), so running init again
 * picks up where it stopped and never redoes or overwrites finished work. Whatever lands in the
 * project's knowledge (manifests, their card links, the agent file) arrives as a draft to review.
 * Nothing is written for one agent only: how to work with the features goes in AGENTS.md, which
 * every coding agent reads, and CLAUDE.md just imports it.
 */
export const INIT_STEPS = [
  { id: "doctor", label: "Tools", what: "Node, the build, devices: what this machine can run" },
  { id: "config", label: "Settings file", what: "probe/probe.yaml, every setting optional" },
  { id: "kit", label: "Manifest format", what: "probe/features/README.md: the manifest and brief formats" },
  { id: "scan", label: "Scan", what: "modules, test classes and coverage" },
  { id: "features", label: "Features", what: "which features and platform areas (core, common, the app module) get a manifest" },
  { id: "manifests", label: "Manifests", what: "an agent drafts each feature's or platform area's manifest: paths, flows, rules and the tests proving them" },
  { id: "cards", label: "Rule cards", what: "an agent drafts device cards for the feature rules no unit test can prove; platform areas only when named" },
  { id: "agentfile", label: "Agent file", what: "the Features section in AGENTS.md (CLAUDE.md imports it), so every coding agent knows the manifests and how to work with them" },
  { id: "check", label: "Link check", what: "every test and card link in the manifests resolves" },
] as const;

export type InitStepId = (typeof INIT_STEPS)[number]["id"];

const STATE = "init.json";

/** What only a person decides, so it cannot be read back from the project. Per machine. */
interface InitState {
  /** Features and platform areas chosen for manifests. Unset: not chosen yet. */
  features?: string[];
  /** Everything proposed when the choice was last made, so an area that appears later is offered. */
  seen?: string[];
  /** Features whose cards step found no rule needing a device. */
  cardsNone?: string[];
}

const readState = (project: Project): InitState => project.store.read<InitState>(STATE) ?? {};
const writeState = (project: Project, patch: InitState) => project.store.write(STATE, { ...readState(project), ...patch });

const KIT: { path: string; text: string }[] = [{ path: `${FEATURES_DIR}/README.md`, text: featuresReadme }];

/** Init's drafts for one step, newest first. */
function initDrafts(project: Project, step: string, feature?: string): Draft[] {
  return listDrafts(project, feature).filter((d) => d.origin === "init" && d.step === step);
}

export interface ProposedArea {
  id: string;
  kind: ManifestKind;
  modules: number;
  testable: number;
  testFiles: number;
}

/**
 * What a scan proposes for a manifest: the app's own features, then its platform areas (core,
 * common, the app module) that hold code or tests. A platform area of resources or annotations
 * alone has no behaviour to state a rule about.
 */
export function proposedAreas(project: Project): ProposedArea[] {
  const areas = latestScan(project)
    .features.filter((f) => f.group === "feature" || f.stats.testable > 0 || f.stats.testFiles > 0)
    .map((f) => ({ id: f.id, kind: f.group, modules: f.stats.modules, testable: f.stats.testable, testFiles: f.stats.testFiles }));
  // Platform areas with the most code first: a list cut short still names the ones worth a manifest.
  const platform = areas.filter((a) => a.kind === "platform").sort((a, b) => b.testable - a.testable || a.id.localeCompare(b.id));
  return [...areas.filter((a) => a.kind === "feature"), ...platform];
}

export function proposedFeatures(project: Project): string[] {
  return proposedAreas(project).map((a) => a.id);
}

/** A manifest's own `kind` wins; otherwise the scan's group. */
export function kindOf(project: Project, id: string): ManifestKind {
  try {
    const m = loadManifest(project.root, id);
    if (m) return m.kind;
  } catch {
    // Falls back to the scan; the check step reports the manifest.
  }
  return latestScan(project).features.find((f) => f.id === id)?.group ?? "feature";
}

/**
 * The chosen features and platform areas. A written manifest counts as chosen, so a project
 * that already has manifests chose them by writing them.
 */
export function chosenFeatures(project: Project): string[] | null {
  const state = readState(project);
  const written = loadManifests(project.root).map((m) => m.id);
  if (!state.features && !written.length) return null;
  return [...new Set([...(state.features ?? []), ...written])];
}

/**
 * Proposed areas nobody has decided on yet: neither chosen nor proposed when the choice was
 * made. A project whose features all have manifests is offered its platform areas this way.
 */
export function undecidedAreas(project: Project): ProposedArea[] {
  const chosen = new Set(chosenFeatures(project) ?? []);
  const seen = new Set(readState(project).seen ?? []);
  return proposedAreas(project).filter((a) => !chosen.has(a.id) && !seen.has(a.id));
}

/**
 * Chooses which areas get a manifest. "replace" is a full choice (Studio's ticked list): what
 * it leaves out is declined until chosen. "add" chooses more and keeps the rest. The words
 * `features` and `platform` stand for every proposed area of that kind.
 */
export function chooseFeatures(project: Project, features: string[], mode: "replace" | "add" = "replace"): string[] {
  const proposed = proposedAreas(project);
  const expanded = features.flatMap((f) => (f === "features" || f === "platform" ? proposed.filter((a) => a.kind === (f === "features" ? "feature" : "platform")).map((a) => a.id) : [f]));
  const known = new Set(latestScan(project).features.map((f) => f.id));
  const unknown = expanded.filter((f) => !known.has(f));
  if (unknown.length) throw new Error(`Not features or platform areas of this project: ${unknown.join(", ")}. Run \`probe scan\` to list them.`);
  const state = readState(project);
  const chosen = [...new Set([...(mode === "add" ? (state.features ?? []) : []), ...expanded])];
  const seen = mode === "add" ? [...new Set([...(state.seen ?? []), ...expanded])] : proposed.map((a) => a.id);
  writeState(project, { features: chosen, seen });
  return chosen;
}

const hasManifest = (project: Project, id: string) => existsSync(join(project.root, manifestFile(id)));


/** Each step as the project stands now. Cheap: file reads only, no build, no agent. */
export function initStatus(project: Project): InitStepState[] {
  const steps: InitStepState[] = [];
  const add = (id: InitStepId, status: InitStepState["status"], detail: string) => steps.push({ id, label: INIT_STEPS.find((s) => s.id === id)!.label, status, detail });

  const failing = doctor(project).filter((c) => c.status === "fail");
  add("doctor", failing.length ? "warn" : "done", failing.length ? `${failing.map((c) => c.label).join(", ")}: see \`probe doctor\`. Only device runs need these.` : "ready");

  add("config", existsSync(configPath(project.root)) ? "done" : "todo", relative(project.root, configPath(project.root)).replace(/\\/g, "/"));

  const missingKit = KIT.filter((k) => !existsSync(join(project.root, k.path))).map((k) => k.path);
  add("kit", missingKit.length ? "todo" : "done", missingKit.length ? `to write: ${missingKit.join(", ")}` : KIT.map((k) => k.path).join(", "));

  const scanned = project.store.read<{ scannedAt: string; features: FeatureInfo[] }>("scan.json");
  add("scan", scanned ? "done" : "todo", scanned ? `${scanned.features.filter((f) => f.group === "feature").length} features, ${scanned.features.filter((f) => f.group !== "feature").length} platform areas` : "not scanned yet");

  const chosen = chosenFeatures(project);
  const proposed = scanned ? proposedAreas(project) : [];
  const undecided = chosen ? undecidedAreas(project) : [];
  const kinds = (list: ProposedArea[]) => {
    const platform = list.filter((a) => a.kind === "platform").length;
    return `${list.length - platform} features, ${platform} platform areas`;
  };
  add(
    "features",
    !scanned ? "todo" : !chosen || undecided.length ? "waiting" : "done",
    !scanned
      ? "after the scan"
      : !chosen
        ? `choose from ${proposed.length} proposed (${kinds(proposed)}): \`probe init --yes\` takes them all, \`--step features --features a,b\` some (\`features\` or \`platform\` names a whole kind), or tick them in Studio → Setup`
        : [
            `${chosen.length} chosen: ${chosen.join(", ")}`,
            undecided.length
              ? `${undecided.length} more proposed (${kinds(undecided)}): ${undecided.slice(0, 12).map((a) => a.id).join(", ")}${undecided.length > 12 ? " …" : ""} — \`probe init --step features --features a,b\` adds some (\`platform\` adds them all), Studio → Setup ticks or declines them`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
  );

  const features = chosen ?? [];
  const manifests = manifestProgress(project, features);
  add(
    "manifests",
    !chosen ? "todo" : manifests.todo.length ? "todo" : manifests.pending.length ? "waiting" : "done",
    !chosen
      ? "after the features are chosen"
      : [
          `${manifests.written.length}/${features.length} written`,
          manifests.pending.length ? `${manifests.pending.length} drafted, to review: ${manifests.pending.join(", ")}` : "",
          manifests.todo.length ? `${manifests.todo.length} to draft: ${manifests.todo.slice(0, 12).join(", ")}${manifests.todo.length > 12 ? " …" : ""}` : "",
          manifests.rejected.length ? `rejected, left out: ${manifests.rejected.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
  );

  const cards = cardProgress(project, features);
  add(
    "cards",
    !chosen || cards.todo.length ? "todo" : cards.pending.length || cards.waiting.length ? "waiting" : "done",
    !chosen
      ? "after the manifests"
      : [
          cards.todo.length ? `${cards.todo.length} to draft: ${cards.todo.join(", ")}` : "",
          cards.pending.length ? `to review: ${cards.pending.join(", ")}` : "",
          cards.waiting.length ? `${cards.waiting.length} after their manifest is applied` : "",
          cards.done.length ? `${cards.done.length} done` : "",
          cards.optional ? `${cards.optional} older manifests have unproven rules: \`probe init --step cards --features a,b\` drafts their cards` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "nothing to do",
  );

  const pendingAgentFile = initDrafts(project, "agentfile").filter((d) => d.status === "pending");
  add(
    "agentfile",
    agentFileDone(project) ? "done" : pendingAgentFile.length ? "waiting" : "todo",
    agentFileDone(project) ? "AGENTS.md has the Features section and CLAUDE.md imports it" : pendingAgentFile.length ? "drafted, to review" : "a Features section for AGENTS.md, imported by CLAUDE.md",
  );

  const problems = loadManifests(project.root)
    .map((m) => checkManifest(project.root, m.id))
    .filter((c) => c.errors.length || c.broken.length || c.brokenCards.length);
  add("check", problems.length ? "warn" : "done", problems.length ? `${problems.length} manifests with broken links or errors: ${problems.map((c) => c.feature).join(", ")} (\`probe manifest <feature>\`)` : "every link resolves");
  return steps;
}

function manifestProgress(project: Project, features: string[]) {
  const out = { written: [] as string[], pending: [] as string[], rejected: [] as string[], todo: [] as string[] };
  for (const f of features) {
    if (hasManifest(project, f)) out.written.push(f);
    else {
      const drafts = initDrafts(project, "manifests", f);
      if (drafts.some((d) => d.status === "pending")) out.pending.push(f);
      else if (drafts[0]?.status === "rejected") out.rejected.push(f);
      else out.todo.push(f);
    }
  }
  return out;
}

/**
 * Cards are drafted for the manifests init drafted itself, or for features named on purpose.
 * A manifest a team wrote by hand had its cards decided by that team, so init leaves it alone.
 */
function cardProgress(project: Project, features: string[], named?: string[]) {
  const none = new Set(readState(project).cardsNone ?? []);
  const out = { todo: [] as string[], pending: [] as string[], done: [] as string[], waiting: [] as string[], optional: 0 };
  for (const f of named ?? features) {
    // A platform area's rules are proven by unit tests; it gets cards only when named on purpose.
    if (!named && kindOf(project, f) === "platform") continue;
    const drafts = initDrafts(project, "cards", f);
    if (none.has(f) || drafts.some((d) => d.status !== "pending")) out.done.push(f);
    else if (drafts.length) out.pending.push(f);
    else if (!hasManifest(project, f)) {
      if (named || initDrafts(project, "manifests", f).length) out.waiting.push(f);
    } else if (named || initDrafts(project, "manifests", f).some((d) => d.status === "approved")) out.todo.push(f);
    else if (needsCards(project, f)) out.optional++;
  }
  return out;
}

/** A manifest with a rule nothing proves yet, or checks it says only a device can make. */
function needsCards(project: Project, feature: string): boolean {
  try {
    const m = loadManifest(project.root, feature);
    return !!m && (m.deviceOnly.length > 0 || m.invariants.some((i) => !i.coveredBy.length && !i.cards.length));
  } catch {
    return false;
  }
}

function agentFileDone(project: Project): boolean {
  const read = (p: string) => (existsSync(join(project.root, p)) ? readFileSync(join(project.root, p), "utf8") : "");
  return read("AGENTS.md").includes(`${FEATURES_DIR}/`) && /^@AGENTS\.md\s*$/m.test(read("CLAUDE.md"));
}

export interface InitOptions {
  /** One step only; every step in order otherwise. */
  step?: InitStepId;
  /** Takes the proposed features as chosen. */
  accept?: boolean;
  /** Chooses these features (features step), or limits the agent steps to them. */
  features?: string[];
  /** At most this many agents in a step. */
  limit?: number;
  model?: string;
}

export function isInitStep(id: string): id is InitStepId {
  return INIT_STEPS.some((s) => s.id === id);
}

/** Agents a step runs side by side. */
const PARALLEL = 3;

let current: string | null = null;

/** The init running in this process, if any: two at once would draft the same manifests twice. */
export function runningInit(): string | null {
  return current && liveRun(current)?.run.status === "running" ? current : null;
}

/** Runs init's steps in order as one tracked run. Steps that are done are passed over. */
export function startInit(project: Project, options: InitOptions = {}): { run: InitRun; done: Promise<InitRun> } {
  const busy = runningInit();
  if (busy) throw new Error(`Init is already running (run ${busy}).`);
  const run: InitRun = {
    id: newRunId(),
    kind: "init",
    feature: "*",
    only: options.step,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
    drafts: [],
    costUsd: 0,
  };
  const wants = (id: InitStepId) => !options.step || options.step === id;
  current = run.id;

  return launchRun(project, run, async (log) => {
    // The first steps are synchronous: let the caller attach to the log before they print.
    await new Promise((r) => setImmediate(r));
    if (wants("doctor")) {
      const failing = doctor(project).filter((c) => c.status === "fail");
      log(failing.length ? `tools: ${failing.map((c) => `${c.label} (${c.fix ?? c.detail})`).join("; ")} — device runs need these, the rest of init does not` : "tools: ready");
    }
    if (wants("config") && !existsSync(configPath(project.root))) {
      mkdirSync(dirname(configPath(project.root)), { recursive: true });
      writeFileSync(configPath(project.root), CONFIG_TEMPLATE);
      log(`wrote ${relative(project.root, configPath(project.root))}`);
    }
    if (wants("kit")) {
      for (const k of KIT) {
        const abs = join(project.root, k.path);
        if (existsSync(abs)) continue;
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, k.text);
        log(`wrote ${k.path}`);
      }
    }
    if (wants("scan") && (options.step === "scan" || !project.store.read("scan.json"))) {
      const result = scan(project);
      log(`scanned: ${result.features.length} features and platform modules`);
    }
    if (wants("features") && (options.accept || (options.step === "features" && options.features))) {
      // Added to what is chosen, never replacing it: a CLI choice names what to add.
      const chosen = chooseFeatures(project, options.features ?? proposedFeatures(project), "add");
      log(`chosen: ${chosen.length} features and platform areas`);
    }

    const chosen = chosenFeatures(project);
    const undecided = chosen ? undecidedAreas(project) : [];
    if (!chosen) {
      if (!options.step || options.step === "features")
        log(`waiting: choose the features and platform areas — \`probe init --yes\` takes all ${proposedFeatures(project).length} proposed, \`probe init --step features --features a,b\` some, or tick them in Studio → Setup`);
    } else if (undecided.length && (!options.step || options.step === "features")) {
      log(`also proposed, not chosen yet: ${undecided.map((a) => `${a.id}${a.kind === "platform" ? " (platform)" : ""}`).join(", ")} — \`probe init --step features --features a,b\` adds them`);
    }
    if (chosen) {
      const only = (list: string[]) => (options.features && options.step !== "features" ? list.filter((f) => options.features!.includes(f)) : list);
      if (wants("manifests")) await draftManifests(project, run, only(manifestProgress(project, chosen).todo).slice(0, options.limit), options.model, log);
      if (wants("cards")) {
        const named = options.step === "cards" && options.features ? options.features : undefined;
        await draftCards(project, run, only(cardProgress(project, chosen, named).todo).slice(0, options.limit), options.model, log);
      }
      if (wants("agentfile")) draftAgentFile(project, run, log);
    }
    run.steps = initStatus(project);
    const open = run.steps.filter((s) => s.status === "todo" || s.status === "waiting");
    log(open.length ? `left: ${open.map((s) => `${s.label} (${s.status === "waiting" ? "yours" : "Probe"})`).join(", ")}` : "set up: nothing left");
  });
}

/** Runs `work` over `items`, at most PARALLEL at a time. */
async function pool<T>(items: T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await work(items[i]!, i);
      }
    }),
  );
}

async function draftManifests(project: Project, run: InitRun, features: string[], model: string | undefined, log: (line: string) => void): Promise<void> {
  if (!features.length) return;
  log(`manifests: drafting ${features.length} (${PARALLEL} at a time)`);
  const tests = testIndex(project.root);
  const scanned = latestScan(project);
  await pool(features, async (id, i) => {
    const feature = scanned.features.find((f) => f.id === id);
    if (!feature) return log(`${id}: not in the scan, skipped`);
    const say = (line: string) => log(`[${id}] ${line}`);
    say(`drafting the manifest (${i + 1}/${features.length})`);
    const file = manifestFile(id);
    const kind = feature.group === "platform" ? "kind: platform\n" : "";
    const work = openDraft(project, id, [{ path: file, staged: "manifest.yaml", initial: `# ${id}. Format: ${FEATURES_DIR}/README.md\nid: ${id}\n${kind}` }]);
    writeFileSync(join(work.dir, "FEATURE.md"), featureContext(project, feature, tests));
    if (!existsSync(join(work.dir, "FORMAT.md"))) writeFileSync(join(work.dir, "FORMAT.md"), featuresReadme);

    const agent = (prompt: string) => runAgent(project, { prompt, probeTools: [], cwd: work.dir, addDirs: [project.root], editOnly: ["./manifest.yaml"], model }, say);
    let result = await agent(manifestPrompt(project, feature));
    run.costUsd += result.costUsd;
    // One pass to mend what the link check finds: a guessed test name is the usual slip.
    let check = checkManifest(project.root, id, readFileSync(join(work.dir, "manifest.yaml"), "utf8"));
    if (check.errors.length || check.broken.length || check.unexplained.length) {
      say(`mending ${check.errors.length + check.broken.length + check.unexplained.length} problems the link check found`);
      const fix = await agent(`The manifest.yaml you wrote for the feature "${id}" fails Probe's check:\n\n${summarizeCheck(check)}\n\nFix every problem in manifest.yaml: point a broken covered_by entry at the test's exact name (FEATURE.md lists them), or remove it and give the rule a gap. Change nothing else. Finish with one sentence.`);
      run.costUsd += fix.costUsd;
      check = checkManifest(project.root, id, readFileSync(join(work.dir, "manifest.yaml"), "utf8"));
      result = { ...result, summary: `${result.summary}\n\n${fix.summary}` };
    }
    const draft = closeDraft(project, work, { summary: `${result.summary}\n\n${summarizeCheck(check)}`, runId: run.id, origin: "init", step: "manifests" });
    if (!draft) return say(`no manifest written${result.ok ? "" : ` (agent: ${result.summary.slice(0, 200)})`}`);
    run.drafts.push(draft.id);
    say(`drafted ${file} · ${check.links} test links, ${check.broken.length} broken, ${check.gaps.length} unproven — review it in Studio → Setup`);
  });
}

/** What the agent gets to know about the feature before it reads the code. */
function featureContext(project: Project, feature: FeatureInfo, tests: Map<string, string[]>): string {
  const rel = (dir: string) => relative(project.root, dir).replace(/\\/g, "/");
  const dirs = feature.modules.map((m) => `${rel(m.dir)}/`);
  const tasks = feature.modules.map((m) => m.unitTestTask).filter((t): t is string => !!t);
  const command = tasks.length ? (project.adapter.id === "android-gradle" ? `./gradlew ${tasks.join(" ")}` : [...new Set(tasks)].join(" && ")) : null;
  const testFiles = [...tests.values()].flat().filter((f) => dirs.some((d) => f.startsWith(d)));
  const testList = testFiles.slice(0, 60).map((f) => {
    const names = testNames(join(project.root, f));
    return `### ${stemOf(f.split("/").pop()!)} (${f})\n${names.slice(0, 80).map((n) => `- ${n}`).join("\n")}${names.length > 80 ? `\n- … ${names.length - 80} more` : ""}`;
  });
  const platform = feature.group === "platform";
  // "core:database" is written "database" in prose.
  const docs = docsAbout(project.root, platform ? feature.id.split(":").pop()! : feature.id, 12_000);
  const manifests = loadManifests(project.root);
  const examples = [...manifests.filter((m) => (m.kind === "platform") === platform), ...manifests.filter((m) => (m.kind === "platform") !== platform)].slice(0, 2).map((m) => m.file);
  const graph = areaGraph(project, latestScan(project));
  const users = usedBy(graph, feature.id);
  const used = uses(graph, feature.id);
  return `# ${platform ? "Platform area" : "Feature"} ${feature.id}

## Modules
${feature.modules.map((m) => `- ${m.id} — ${rel(m.dir)}/ (${m.mainFiles} source files, ${m.testFiles} test files${m.unitTestTask ? `, unit task ${m.unitTestTask}` : ""})`).join("\n")}

Unit command: ${command ?? "none (no module has unit tests)"}

## Depends on (areas its build files name)
${used.join(", ") || "(none found)"}

## Used by (areas whose build files name it; an edit here makes them stale)
${users.length ? `${users.length}: ${users.join(", ")}` : "(none found; a convention plugin may add it everywhere)"}

## Unit tests in these modules (class, then each test's exact name)
${testList.join("\n\n") || "(none)"}${testFiles.length > 60 ? `\n\n… ${testFiles.length - 60} more test files under the same folders` : ""}

## Docs that mention it
${docs.map((d) => `### ${d.ref}\n${d.text}`).join("\n\n") || "(none found)"}
${examples.length ? `\n## Manifests already written in this project, as examples\n${examples.map((e) => `- ${e}`).join("\n")}\n` : ""}`;
}

function manifestPrompt(project: Project, feature: FeatureInfo): string {
  return feature.group === "platform" ? platformPrompt(project, feature) : featurePrompt(project, feature);
}

/** Shared code has no user of its own: its rules are the contract it keeps for the code built on it. */
function platformPrompt(project: Project, feature: FeatureInfo): string {
  return `You write the Probe manifest for the platform area "${feature.id}" of the project at ${project.root}: shared code that features and other areas build on, not a feature a user sees.

Your working folder holds:
- manifest.yaml — the file you write. It starts with its id and kind.
- FORMAT.md — the manifest format and its rules. Read it first.
- FEATURE.md — the area's modules, its unit command, which areas use it, every unit test in its modules with its exact name, and docs that mention it.

The project is read-only to you. Read its code: the public API the modules expose (interfaces, entry points, the types other modules import) and the tests FEATURE.md lists.

Write manifest.yaml:
1. id "${feature.id}", kind: platform, a name, a summary of one or two lines saying what it provides to the code that uses it, owner: null.
2. paths: the folders of its modules. related: only code owned elsewhere whose change can break this area (another platform area it wraps), each with a why; only paths that exist. Do not list the areas that use it: Probe finds those from the build files.
3. unit.command: the one FEATURE.md gives.
4. flows: what the code using it does with it (the main calls or services it offers), one line each.
5. invariants: the contract it must keep — behaviour a unit test can fail on (results, errors, persistence, threading, mapping), not architecture. For each, covered_by with the tests that prove it, written "TestClass :: exact test name" exactly as FEATURE.md lists them. Never invent a test name. A rule no test proves gets covered_by: [] and a gap saying why. Unit tests are the proof here; a device card only for what no unit test can reach (real hardware, the OS).
6. device_only: usually empty; only checks no unit test can make.
7. brief: its doc if one exists (FEATURE.md lists docs that mention it); otherwise leave it out.

Prefer fewer, sharper rules that the tests really prove over many vague ones. Finish with two sentences: what the area provides, and what you could not work out.`;
}

function featurePrompt(project: Project, feature: FeatureInfo): string {
  return `You write the Probe manifest for the feature "${feature.id}" of the project at ${project.root}.

Your working folder holds:
- manifest.yaml — the file you write. It starts with only its id.
- FORMAT.md — the manifest format and its rules. Read it first.
- FEATURE.md — the feature's modules, its unit command, every unit test in its modules with its exact name, and docs that mention it.

The project is read-only to you. Read its code: the screens, view models, use cases, repositories and the tests FEATURE.md lists.

Write manifest.yaml:
1. id "${feature.id}", a name, a summary of one or two lines from the user's point of view, owner: null.
2. paths: the folders of its modules. related: code owned elsewhere it depends on (core modules, other features' api), each with a why; only paths that exist.
3. unit.command: the one FEATURE.md gives.
4. flows: what a user can do with it, one line each.
5. invariants: the rules that must hold — behaviour a test or a device run can fail on, not architecture. For each, covered_by with the tests that prove it, written "TestClass :: exact test name" exactly as FEATURE.md lists them. Never invent a test name. A rule no test proves gets covered_by: [] and a gap saying why (and whether only a device can show it).
6. device_only: checks no unit test can make (system UI, permissions, real devices, other apps).
7. brief: the feature's doc if one exists (FEATURE.md lists docs that mention it); otherwise leave it out.

Prefer fewer, sharper rules that the tests really prove over many vague ones. Finish with two sentences: what the feature is, and what you could not work out.`;
}

async function draftCards(project: Project, run: InitRun, features: string[], model: string | undefined, log: (line: string) => void): Promise<void> {
  if (!features.length) return;
  log(`cards: drafting for ${features.length} features (${PARALLEL} at a time)`);
  await pool(features, async (id, i) => {
    const say = (line: string) => log(`[${id}] ${line}`);
    say(`looking for rules only a device can prove (${i + 1}/${features.length})`);
    const before = new Map(listCards(project.root, id).map((c) => [c.id, c.updatedAt]));
    const work = openDraft(project, id, [{ path: manifestFile(id), staged: "manifest.yaml" }]);
    if (!existsSync(join(work.dir, "FORMAT.md"))) writeFileSync(join(work.dir, "FORMAT.md"), featuresReadme);
    const result = await runAgent(
      project,
      { prompt: cardsPrompt(project, id), probeTools: ["probe_cards_context", "probe_cards_save"], cwd: work.dir, addDirs: [project.root], editOnly: ["./manifest.yaml"], model },
      say,
    );
    run.costUsd += result.costUsd;
    const written = listCards(project.root, id).filter((c) => before.get(c.id) !== c.updatedAt).map((c) => c.id);
    const draft = closeDraft(project, work, { summary: `${result.summary}\n\nCards written (as drafts): ${written.join(", ") || "none"}`, runId: run.id, origin: "init", step: "cards" });
    if (draft) {
      run.drafts.push(draft.id);
      say(`${written.length} cards drafted, linked to their rules in a manifest draft — review both in Studio`);
    } else if (result.ok) {
      writeState(project, { cardsNone: [...new Set([...(readState(project).cardsNone ?? []), id])] });
      say(written.length ? `${written.length} cards drafted but linked to no rule` : "no rule needs a device card");
    } else say(`agent did not finish: ${result.summary.slice(0, 200)}`);
  });
}

function cardsPrompt(project: Project, feature: string): string {
  return `You give the feature "${feature}" of the project at ${project.root} device cards for the rules no unit test can prove.

Your working folder holds manifest.yaml (a copy of ${manifestFile(feature)}, which you may edit) and FORMAT.md (its format; read the part about cards).

1. Read manifest.yaml. Pick the invariants with empty covered_by whose gap says a device, the system or another app is needed, and the device_only checks that state a rule. Leave rules a unit test could prove: they need a test, not a card.
2. If none qualify, change nothing and say so.
3. Call probe_cards_context with feature "${feature}" for the card rules, read the code the rule is about (screens, the labels a user sees), and draft one capability card per such rule. Save them all with one probe_cards_save call for feature "${feature}"; fix and save again if it reports errors.
4. In manifest.yaml add each card's id to its rule's \`cards:\` list. Keep the gap. Change nothing else.

Finish with two sentences: which rules got cards, and which you left and why.`;
}

/** The Features section, drafted into AGENTS.md for every coding agent; CLAUDE.md imports it for Claude Code. */
function draftAgentFile(project: Project, run: InitRun, log: (line: string) => void): void {
  if (agentFileDone(project) || initDrafts(project, "agentfile").some((d) => d.status === "pending")) return;
  const manifests = loadManifests(project.root).map((m) => m.id);
  const features = manifests.length ? manifests : (chosenFeatures(project) ?? []);
  if (!features.length) return;
  const work = openDraft(project, "_project", [
    { path: "AGENTS.md", staged: "agents.md" },
    { path: "CLAUDE.md", staged: "claude.md" },
  ]);
  const edit = (staged: string, change: (text: string) => string) => {
    const abs = join(work.dir, staged);
    const before = readFileSync(abs, "utf8");
    const crlf = before.includes("\r\n");
    const after = change(before.replace(/\r\n/g, "\n"));
    writeFileSync(abs, crlf ? after.replace(/\n/g, "\r\n") : after);
  };
  if (!readFileSync(join(work.dir, "agents.md"), "utf8").includes(`${FEATURES_DIR}/`)) edit("agents.md", (t) => `${t.trimEnd()}${t.trim() ? "\n\n" : ""}${featuresSection(project, features)}\n`);
  edit("claude.md", (t) => {
      if (/^@AGENTS\.md\s*$/m.test(t)) return t;
      // After the title, when there is one, so the import reads as part of the file's header.
      const title = /^# .*\n+/.exec(t);
      return title ? `${t.slice(0, title[0].length)}@AGENTS.md\n\n${t.slice(title[0].length)}` : `@AGENTS.md\n${t ? `\n${t}` : ""}`;
    });
  const draft = closeDraft(project, work, {
    summary: "Adds the Features section to AGENTS.md, which every coding agent reads: the manifests, finding a feature, working on one and checking it after a change. CLAUDE.md imports AGENTS.md, since Claude Code reads CLAUDE.md.",
    runId: run.id,
    origin: "init",
    step: "agentfile",
  });
  if (draft) {
    run.drafts.push(draft.id);
    log("agent file: drafted the Features section for AGENTS.md — review it in Studio → Setup");
  }
}

function featuresSection(project: Project, ids: string[]): string {
  const platform = ids.filter((id) => kindOf(project, id) === "platform");
  const features = ids.filter((id) => !platform.includes(id));
  return `${featuresGuide.trimEnd()}\n\nFeatures: ${features.join(" · ")}.${platform.length ? `\n\nPlatform areas: ${platform.join(" · ")}.` : ""}`;
}

/** The pending drafts init made, for review in one place. */
export function initPendingDrafts(project: Project): Draft[] {
  return listDrafts(project).filter((d) => d.origin === "init" && d.status === "pending");
}

export function summarizeInit(run: InitRun, steps: InitStepState[] = run.steps): string {
  const lines = [
    `Init ${run.id}${run.only ? ` · step ${run.only}` : ""} · ${run.status.toUpperCase()}${run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ""}${run.drafts.length ? ` · ${run.drafts.length} drafts to review` : ""}`,
  ];
  if (run.error) lines.push(run.error);
  lines.push(formatInitStatus(steps));
  return lines.join("\n");
}

export function formatInitStatus(steps: InitStepState[]): string {
  const icon = { done: "✓", todo: "·", waiting: "…", warn: "!" };
  const open = steps.filter((s) => s.status === "todo" || s.status === "waiting");
  return [
    ...steps.map((s) => `  ${icon[s.status]} ${s.label.padEnd(18)} ${s.detail}`),
    "",
    open.length ? `Next: ${open[0]!.status === "waiting" ? "yours" : "`probe init`"} — ${open[0]!.label}. ✓ done · · Probe does it · … waiting for you · ! worth a look` : "Set up: nothing left.",
  ].join("\n");
}
