import { type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { ignoredPathPattern } from "../adapters/adapter.js";
import { gitState } from "./history.js";
import type { Project } from "./project.js";
import { loadWatch, markStale, runningCheck, startCheck } from "./watch.js";

/** Edits settle for this long before they are mapped to features. */
const SETTLE_MS = 3_000;
/** Quiet time after edits outside Claude before Studio checks them itself. */
const CHECK_AFTER_MS = 45_000;
/** Claude edited within this window: its own turn-end hook will check, so Studio does not. */
const CLAUDE_ACTIVE_MS = 10 * 60_000;

/**
 * Watches the project while Studio runs, for edits made outside Claude (an IDE, a person).
 * A branch switch or pull changes files too; those are dropped rather than marked, since they
 * are not someone's edit and the results ledger already treats them as new code.
 */
export function startWatcher(project: Project, log: (line: string) => void = () => {}): () => void {
  const pending = new Set<string>();
  let head = headOf(project);
  let settle: NodeJS.Timeout | undefined;
  let check: NodeJS.Timeout | undefined;

  const flush = () => {
    const files = [...pending];
    pending.clear();
    const now = headOf(project);
    if (now !== head) {
      head = now;
      log(`watch: branch or commit changed; ${files.length} file changes not counted as edits`);
      return;
    }
    // An agent's edits are marked by its own hook already; what is left came from somewhere else.
    // Only files that are still there: tools write temp files beside the real one, and a folder's
    // own entry changes with every file in it.
    const known = new Set(Object.values(loadWatch(project).stale).flatMap((e) => e.files));
    const fresh = files.filter((f) => !known.has(f) && isFile(join(project.root, f)));
    const features = markStale(project, fresh, "editor");
    if (!features.length) return;
    log(`watch: edits outside Claude made ${features.join(", ")} stale`);
    clearTimeout(check);
    check = setTimeout(autoCheck, CHECK_AFTER_MS);
  };

  const autoCheck = () => {
    const stale = Object.values(loadWatch(project).stale);
    const claudeActive = stale.some((e) => (e.sources.includes("claude") || e.sources.includes("agent")) && Date.now() - Date.parse(e.last) < CLAUDE_ACTIVE_MS);
    if (!stale.length || claudeActive || runningCheck(project)) return;
    const started = startCheck(project, { trigger: "editor" });
    if (started) log(`watch: checking ${stale.length} stale feature(s) (run ${started.run.id})`);
  };

  const ignored = ignoredPathPattern(project.adapter);
  let watcher: FSWatcher;
  try {
    watcher = watch(project.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const file = name.toString().replace(/\\/g, "/");
      if (ignored.test(file)) return;
      pending.add(file);
      clearTimeout(settle);
      settle = setTimeout(flush, SETTLE_MS);
    });
  } catch (e) {
    log(`watch: cannot watch ${project.root} (${(e as Error).message}); only Claude's edits are tracked`);
    return () => {};
  }
  return () => {
    clearTimeout(settle);
    clearTimeout(check);
    watcher.close();
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function headOf(project: Project): string {
  const git = gitState(project.root);
  return git ? `${git.branch}@${git.commit}` : "";
}
