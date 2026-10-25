import { stringify } from "yaml";
import { accountsForPrompt } from "../accounts/accounts.js";
import { newRunId } from "../core/store.js";
import type { ExploreRun, NavScreen } from "../core/types.js";
import { crashError, DEVICE_HOW_TO, runOnDevice } from "../devices/harness.js";
import type { Project } from "../engine/project.js";
import { launchRun } from "../engine/runs.js";
import { findFeature, latestScan } from "../engine/scan.js";
import { listCards } from "./store.js";

const NAVMAP_FILE = "navmap.json";

/** Screens per feature from the latest explore run of each. */
export type NavMap = Record<string, { runId: string; at: string; screens: NavScreen[]; issues: string[] }>;

function prompt(project: Project, feature: string, device: string, pkg: string): string {
  const cards = listCards(project.root, feature).map((c) => ({ title: c.title, reach: c.reach }));
  return `You are mapping the "${feature}" feature of the Android app ${pkg} on ${device}. The app has just been launched.

## Task
Reach every screen, sheet and dialog of this feature you can, the way a user would. For each: how you got there (one hop per step, using visible labels), and whether it worked. Go back with the back key or the app's own navigation and check that back returns where it should.
Look for: dead ends, back going to the wrong place, error or empty states without a way out, stuck spinners, clipped or overlapping text, transitions that flash or jump.
Only look and navigate: do not post, send, delete or change anything.

## What Probe already knows about reaching it (feature cards)
\`\`\`yaml
${cards.length ? stringify(cards) : "none yet\n"}\`\`\`

## Test accounts
${accountsForPrompt(project)}

${DEVICE_HOW_TO}

## Finish
Call probe_explore_report exactly once with every screen you reached (name, reach path, the step screenshot file name from observe if you know it, notes) and every issue you saw. Then stop.`;
}

/** An agent walks one feature's screens: the result is that feature's navigation map. */
export function startExploreRun(project: Project, featureId: string, options: { device?: string; model?: string } = {}): { run: ExploreRun; done: Promise<ExploreRun> } {
  const feature = findFeature(latestScan(project), featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  const run: ExploreRun = {
    id: newRunId(),
    kind: "explore",
    feature: feature.id,
    device: "",
    startedAt: new Date().toISOString(),
    status: "running",
    crashes: [],
    timeline: [],
    screens: [],
    issues: [],
    costUsd: 0,
  };
  return launchRun(project, run, async (log) => {
    const session = await runOnDevice(project, run, { ...options, prompt: (d, pkg) => prompt(project, feature.id, d, pkg), reportTools: ["probe_explore_report"] }, log);
    const report = session.report<{ screens: NavScreen[]; issues: string[] }>("explore");
    run.screens = report?.screens ?? [];
    run.issues = report?.issues ?? [];
    const crashed = crashError(run);
    if (crashed) {
      run.status = "failed";
      run.error = crashed;
    } else if (!report) {
      run.status = "error";
      run.error = "The agent finished without a report.";
    } else {
      run.status = run.issues.length ? "failed" : "passed";
      const map = project.store.read<NavMap>(NAVMAP_FILE) ?? {};
      map[feature.id] = { runId: run.id, at: new Date().toISOString(), screens: run.screens, issues: run.issues };
      project.store.write(NAVMAP_FILE, map);
    }
    log(`explore: ${run.screens.length} screens, ${run.issues.length} issues`);
  });
}

export function navMap(project: Project): NavMap {
  return project.store.read<NavMap>(NAVMAP_FILE) ?? {};
}

export function summarizeExplore(run: ExploreRun): string {
  const lines = [`Explore ${run.id} · ${run.feature} · ${run.status.toUpperCase()} · ${run.screens.length} screens · ${run.issues.length} issues · $${run.costUsd.toFixed(2)}`];
  if (run.error) lines.push(run.error);
  for (const s of run.screens) lines.push(`  ▸ ${s.name}: ${s.reach.join(" → ")}${s.notes ? ` (${s.notes})` : ""}`);
  for (const i of run.issues) lines.push(`  ⚠ ${i}`);
  return lines.join("\n");
}
