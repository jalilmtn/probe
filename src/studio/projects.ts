import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScanResult } from "../core/types.js";

export interface KnownProject {
  root: string;
  name: string;
  adapter: string;
  scannedAt: string;
}

/**
 * Projects Probe has worked on from this machine: every store folder with a scan says where its
 * project lives. Projects whose folder is gone are left out.
 */
export function knownProjects(): KnownProject[] {
  const dir = join(homedir(), ".probe", "projects");
  if (!existsSync(dir)) return [];
  const out: KnownProject[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const scan = JSON.parse(readFileSync(join(dir, entry.name, "scan.json"), "utf8")) as ScanResult;
      // Throwaway projects in the temp folder (smoke tests, agent scratch dirs) are not worth listing.
      if (scan.project?.root && existsSync(scan.project.root) && !resolve(scan.project.root).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())) out.push({ root: resolve(scan.project.root), name: scan.project.name, adapter: scan.project.adapter, scannedAt: scan.scannedAt });
    } catch {
      // A store without a scan has nothing to show yet.
    }
  }
  const seen = new Set<string>();
  return out
    .filter((p) => !seen.has(p.root.toLowerCase()) && seen.add(p.root.toLowerCase()))
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}
