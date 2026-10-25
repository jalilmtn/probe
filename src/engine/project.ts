import { dirname, resolve } from "node:path";
import type { ProjectAdapter } from "../adapters/adapter.js";
import { detectAdapter } from "../adapters/registry.js";
import { loadConfig, type ProbeConfig } from "../core/config.js";
import { Store } from "../core/store.js";

export interface Project {
  root: string;
  name: string;
  adapter: ProjectAdapter;
  config: ProbeConfig;
  store: Store;
}

/**
 * Finds the project to work on: an explicit path, then PROBE_PROJECT, then the directory
 * Claude Code was opened in, then the working directory. Walks up to the first folder an
 * adapter recognises, so running from a subfolder works too.
 */
export function openProject(explicit?: string): Project {
  const start = resolve(explicit ?? process.env.PROBE_PROJECT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  let dir = start;
  for (;;) {
    const adapter = detectAdapter(dir);
    if (adapter) {
      const store = new Store(dir);
      const config = loadConfig(dir, store.dir);
      return { root: dir, name: config.name ?? adapter.projectName(dir), adapter, config, store };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No supported project found at or above ${start}. Supported: Android/Gradle.`);
    dir = parent;
  }
}
