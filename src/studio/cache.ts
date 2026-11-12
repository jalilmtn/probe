import { type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { ignoredPathPattern } from "../adapters/adapter.js";
import { onStoreWrite } from "../core/store.js";
import type { Project } from "../engine/project.js";

/**
 * What Studio's pages show, computed once and kept until something it depends on may have
 * changed: a file in the project, Probe's own records, an action, or Refresh. Working out
 * results freshness, the change against the base branch or the setup steps runs git several
 * times on a large repository; doing it on every click is what made Studio slow.
 */
let version = 0;
const values = new Map<string, { version: number; value: unknown }>();

/** Goes up each time the cache is dropped: Studio's worker reads the project again after a change. */
export function cacheVersion(): number {
  return version;
}

/** Everything kept so far is out of date. */
export function invalidate(): void {
  version++;
  values.clear();
}

/** `compute()`'s value for `key`, from the last call while nothing has changed since. */
export function cached<T>(key: string, compute: () => T): T {
  const hit = values.get(key);
  if (hit && hit.version === version) return hit.value as T;
  const value = compute();
  values.set(key, { version, value });
  return value;
}

/** The same for work that waits (a tracker): one request at a time per key. */
export async function cachedAsync<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = values.get(key);
  if (hit && hit.version === version) return (await hit.value) as T;
  const at = version;
  const pending = compute();
  values.set(key, { version: at, value: pending });
  try {
    return await pending;
  } catch (e) {
    if (values.get(key)?.value === pending) values.delete(key);
    throw e;
  }
}

/** A stamp of the repository's HEAD and index, so a commit or checkout made elsewhere shows. */
export function gitStamp(root: string): string {
  const stamp = (f: string) => {
    try {
      return statSync(join(root, ".git", f)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return `${stamp("HEAD")}:${stamp("index")}`;
}

/**
 * Drops the cache when files of the project change (outside build output and other ignored
 * folders) or when Probe writes a run, a scan or settings. Returns how to stop watching.
 */
const KEPT_COPIES = new Set(["inbox.json", "tracker-me.json"]);

export function watchForChanges(project: Project): () => void {
  const ignored = ignoredPathPattern(project.adapter);
  let timer: NodeJS.Timeout | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(invalidate, 300);
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(project.root, { recursive: true }, (_event, name) => {
      if (name && !ignored.test(name.toString().replace(/\\/g, "/"))) soon();
    });
  } catch {
    // Without recursive watching (some Linux setups) Refresh still brings everything up to date.
  }
  const stopWrites = onStoreWrite((dir, name) => {
    // The kept ticket list and tracker names are Studio's own copies: writing them changes nothing shown.
    if (dir === project.store.dir && !KEPT_COPIES.has(name)) soon();
  });
  invalidate();
  return () => {
    clearTimeout(timer);
    watcher?.close();
    stopWrites();
  };
}
