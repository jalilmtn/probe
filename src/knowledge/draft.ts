import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runAgent } from "../agent/headless.js";
import { unifiedDiff } from "../core/diff.js";
import { capture } from "../core/proc.js";
import { newRunId } from "../core/store.js";
import type { Project } from "../engine/project.js";
import { briefGlance, FEATURES_DIR, type FeatureManifest, type ManifestCheck, summarizeCheck } from "./manifest.js";

/**
 * A correction to a feature's manifest or brief that an agent drafted after a code change.
 * It is never applied on its own: a person approves it, and it applies only if the files are
 * still what the agent saw.
 */
export interface Draft {
  id: string;
  feature: string;
  createdAt: string;
  /** The check or init run that drafted it. */
  runId?: string;
  /** What made it: a check after a code change, or a step of `probe init`. */
  origin?: "check" | "init";
  /** The init step, for origin "init": "manifests", "cards" or "agentfile". */
  step?: string;
  status: "pending" | "approved" | "rejected";
  /** What the agent said it changed and why. */
  summary: string;
  files: DraftFile[];
}

interface DraftFile {
  /** Repo-relative path of the file the draft would change, or create. */
  path: string;
  /** Hash of that file when the agent read it (of "" when it did not exist); a different hash on approve means a conflict. */
  base: string;
  /** Name of the agent's edited copy inside the draft folder. */
  staged: string;
}

const DRAFTS = "drafts";

function draftDir(project: Project, id: string): string {
  return join(project.store.dir, DRAFTS, id);
}

const hash = (text: string) => createHash("sha1").update(text).digest("hex");

const current = (project: Project, path: string) => {
  const abs = join(project.root, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
};

/** A draft being written: its folder, and the copies in it that may change. */
export interface DraftWork {
  id: string;
  dir: string;
  feature: string;
  files: DraftFile[];
}

/**
 * Opens a draft folder and copies each file into it under its staged name. A file that does
 * not exist yet starts as `initial`, so a draft can also create a file.
 */
export function openDraft(project: Project, feature: string, files: { path: string; staged: string; initial?: string }[]): DraftWork {
  const id = `${newRunId()}-${feature.replace(/[^\w-]/g, "_")}`;
  const dir = draftDir(project, id);
  mkdirSync(dir, { recursive: true });
  const staged = files.map((f) => {
    const text = current(project, f.path);
    writeFileSync(join(dir, f.staged), existsSync(join(project.root, f.path)) ? text : (f.initial ?? ""));
    return { path: f.path, base: hash(text), staged: f.staged };
  });
  const format = join(project.root, FEATURES_DIR, "README.md");
  if (existsSync(format)) copyFileSync(format, join(dir, "FORMAT.md"));
  return { id, dir, feature, files: staged };
}

/** Saves the draft when a copy now differs from the project's file; null when nothing changed. */
export function closeDraft(project: Project, work: DraftWork, details: Pick<Draft, "summary" | "runId" | "origin" | "step">): Draft | null {
  const changed = work.files.filter((f) => {
    const staged = readFileSync(join(work.dir, f.staged), "utf8");
    return staged.trim() !== "" && staged !== current(project, f.path);
  });
  if (!changed.length) {
    rmSync(work.dir, { recursive: true, force: true });
    return null;
  }
  const draft: Draft = { id: work.id, feature: work.feature, createdAt: new Date().toISOString(), status: "pending", ...details, summary: details.summary.slice(0, 4000), files: changed };
  writeFileSync(join(work.dir, "draft.json"), JSON.stringify(draft, null, 2));
  return draft;
}

export interface DraftInput {
  manifest: FeatureManifest;
  check: ManifestCheck;
  /** Changed files of this feature, repo relative. */
  files: string[];
  /** Short unit result, e.g. "passed, 212 tests" or the failing tests. */
  unit: string;
  runId?: string;
  model?: string;
}

/**
 * An agent reads the change and drafts corrections to the manifest and brief. It works on
 * copies in a scratch folder and may edit nothing else; the project is read-only to it.
 * Returns the draft, or none when the agent found nothing to correct.
 */
export async function draftCorrections(project: Project, input: DraftInput, log: (line: string) => void): Promise<{ draft: Draft | null; costUsd: number }> {
  const { manifest } = input;
  const work = openDraft(project, manifest.id, [
    { path: manifest.file, staged: "manifest.yaml" },
    ...(manifest.brief && existsSync(join(project.root, manifest.brief)) ? [{ path: manifest.brief, staged: "brief.md" }] : []),
  ]);
  const { dir, files } = work;
  writeFileSync(join(dir, "CHANGE.md"), changeContext(project, input));

  const result = await runAgent(
    project,
    {
      prompt: draftPrompt(project, input, files),
      probeTools: [],
      cwd: dir,
      addDirs: [project.root],
      editOnly: ["./manifest.yaml", "./brief.md"],
      model: input.model,
    },
    log,
  );

  const draft = closeDraft(project, work, { summary: result.summary, runId: input.runId, origin: "check" });
  if (!draft) {
    log(`${manifest.id}: nothing to correct${result.ok ? "" : ` (agent: ${result.summary.slice(0, 200)})`}`);
    return { draft: null, costUsd: result.costUsd };
  }
  log(`${manifest.id}: drafted a correction to ${draft.files.map((f) => f.path).join(", ")} — review it in Studio`);
  return { draft, costUsd: result.costUsd };
}

/** The change as the agent sees it: files, diff, unit result and what the link check found. */
function changeContext(project: Project, input: DraftInput): string {
  const files = input.files.slice(0, 40);
  const tracked = capture("git", ["diff", "HEAD", "--", ...files], project.root) ?? "";
  const untracked = (capture("git", ["ls-files", "--others", "--exclude-standard", "--", ...files], project.root) ?? "").split("\n").filter(Boolean);
  const added = untracked.map((f) => `### new file ${f}\n\`\`\`\n${readFileSync(join(project.root, f), "utf8").split("\n").slice(0, 200).join("\n")}\n\`\`\``).join("\n\n");
  const diff = `${tracked}\n${added}`.slice(0, 60_000);
  return `# Change to feature ${input.manifest.id}

Changed files (${input.files.length}${input.files.length > files.length ? `, first ${files.length} shown` : ""}):
${files.map((f) => `- ${f}`).join("\n")}

## Unit tests after the change
${input.unit}

## Manifest check
${summarizeCheck(input.check)}

## Diff (against the last commit; uncommitted work included)
${diff.trim() ? `\`\`\`diff\n${diff}\n\`\`\`` : "(no diff: the change is already committed, read the files instead)"}
`;
}

function draftPrompt(project: Project, input: DraftInput, files: DraftFile[]): string {
  const m = input.manifest;
  const glance = briefGlance(project.root, m);
  return `You keep the written knowledge of the feature "${m.name ?? m.id}" in step with its code.

Your working folder holds copies you may edit:
- manifest.yaml — a copy of ${m.file}
${files.some((f) => f.staged === "brief.md") ? `- brief.md — a copy of ${m.brief}\n` : ""}and read-only context:
- FORMAT.md — the manifest and brief formats. Read it first.
- CHANGE.md — what just changed: files, diff, unit test result, broken test links.

The project itself is at ${project.root}. Read its code there (${m.paths.join(", ")}), and ${m.alsoRead.length ? m.alsoRead.join(", ") : "its CLAUDE.md"} for the rules. You cannot change anything in the project.
${glance ? `\nThe brief's At a glance, as it stands:\n${glance}\n` : ""}
Do this:
1. Fix every broken \`covered_by\` link in manifest.yaml: point it at the renamed test if you can find it in the code, otherwise remove the entry. If that leaves an invariant with nothing proving it, add a \`gap:\` saying why.
2. If the change adds behaviour a user or a caller can see (a new flow, a new rule that must hold, a new endpoint, signal or push type), add it: a \`flows\` entry or an \`invariants\` entry. Only link tests you have read in the code, by their exact name.
3. If the change makes a line of the brief's At a glance or an invariant wrong, correct it.
4. Change nothing else. Do not reformat, reorder or reword what is still true. Keep comments.

If nothing needs correcting, change no file. Finish with two or three sentences: what you changed and why, or that nothing needed changing.`;
}

export function listDrafts(project: Project, feature?: string): Draft[] {
  const root = join(project.store.dir, DRAFTS);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => join(root, id, "draft.json"))
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as Draft)
    .filter((d) => !feature || d.feature === feature)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findDraft(project: Project, id: string): Draft | null {
  const file = join(draftDir(project, id), "draft.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Draft) : null;
}

/** The draft as diffs against the files as they are now, and whether those files moved on since. */
export function draftDiffs(project: Project, draft: Draft): { path: string; diff: string; conflict: boolean }[] {
  return draft.files.map((f) => {
    const now = current(project, f.path);
    const staged = readFileSync(join(draftDir(project, draft.id), f.staged), "utf8");
    return { path: f.path, diff: unifiedDiff(now, staged, f.path), conflict: hash(now) !== f.base };
  });
}

/**
 * Applies a pending draft. Refuses when a file changed after the agent read it: applying would
 * overwrite someone's edit, so the draft has to be made again.
 */
export function approveDraft(project: Project, id: string): { ok: boolean; error?: string; files?: string[] } {
  const draft = findDraft(project, id);
  if (!draft) return { ok: false, error: `No draft ${id}.` };
  if (draft.status !== "pending") return { ok: false, error: `Draft ${id} is already ${draft.status}.` };
  const conflicts = draftDiffs(project, draft).filter((d) => d.conflict);
  if (conflicts.length) return { ok: false, error: `${conflicts.map((c) => c.path).join(", ")} changed after this draft was made. Reject it and check the feature again.` };
  for (const f of draft.files) {
    const abs = join(project.root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, readFileSync(join(draftDir(project, id), f.staged), "utf8"));
  }
  setStatus(project, draft, "approved");
  return { ok: true, files: draft.files.map((f) => f.path) };
}

export function rejectDraft(project: Project, id: string): { ok: boolean; error?: string } {
  const draft = findDraft(project, id);
  if (!draft) return { ok: false, error: `No draft ${id}.` };
  if (draft.status !== "pending") return { ok: false, error: `Draft ${id} is already ${draft.status}.` };
  setStatus(project, draft, "rejected");
  return { ok: true };
}

function setStatus(project: Project, draft: Draft, status: Draft["status"]): void {
  writeFileSync(join(draftDir(project, draft.id), "draft.json"), JSON.stringify({ ...draft, status }, null, 2));
}
