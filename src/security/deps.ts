import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SecurityFinding, Severity } from "../core/types.js";
import { makeFinding } from "./findings.js";
import { readText } from "./static.js";

/** A dependency at an exact version, as OSV names ecosystems. */
export interface Dependency {
  ecosystem: "npm" | "PyPI" | "Maven" | "Go" | "RubyGems" | "Packagist" | "Pub" | "crates.io" | "NuGet" | "CocoaPods" | "SwiftURL";
  name: string;
  version: string;
  /** The lockfile or manifest it came from. */
  file: string;
}

/**
 * Exact dependency versions from lockfiles (and version catalogs / pinned manifests where
 * there is no lockfile). Ranges are left out: OSV needs an exact version to answer.
 */
export function readDependencies(root: string, files: string[]): { deps: Dependency[]; unpinned: SecurityFinding[] } {
  const deps: Dependency[] = [];
  const unpinned: SecurityFinding[] = [];
  const add = (ecosystem: Dependency["ecosystem"], name: string, version: string | undefined, file: string) => {
    const v = version?.trim().replace(/^[v=]/, "");
    if (name && v && /^\d/.test(v)) deps.push({ ecosystem, name, version: v, file });
  };

  for (const file of files) {
    const base = file.split("/").pop()!;
    const reader = READERS[base] ?? (/\.versions\.toml$/.test(base) ? READERS["libs.versions.toml"] : /\.csproj$/.test(base) ? READERS[".csproj"] : undefined);
    if (!reader) continue;
    const text = readText(join(root, file));
    if (text === null) continue;
    try {
      reader(text, (e, n, v) => add(e, n, v, file), file, unpinned);
    } catch {
      // A lockfile we cannot parse adds nothing; the other layers still run.
    }
  }
  return { deps: uniq(deps), unpinned };
}

type Reader = (text: string, add: (e: Dependency["ecosystem"], name: string, version: string | undefined) => void, file: string, unpinned: SecurityFinding[]) => void;

const READERS: Record<string, Reader> = {
  "package-lock.json": (text, add) => {
    const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    for (const [path, p] of Object.entries(lock.packages ?? {})) if (path) add("npm", path.slice(path.lastIndexOf("node_modules/") + 13), p.version);
    if (!lock.packages) for (const [name, p] of Object.entries(lock.dependencies ?? {})) add("npm", name, p.version);
  },
  "yarn.lock": (text, add) => {
    for (const block of text.split(/\n(?=\S)/)) {
      const head = /^"?(@?[^@\s"]+)@/.exec(block);
      const version = /\n\s+version:?\s+"?([^"\s]+)"?/.exec(block);
      if (head && version) add("npm", head[1]!, version[1]);
    }
  },
  "pnpm-lock.yaml": (text, add) => {
    const lock = parseYaml(text) as { packages?: Record<string, unknown> };
    for (const key of Object.keys(lock.packages ?? {})) {
      const m = /^\/?(@?[^@(]+)@([^(]+)/.exec(key) ?? /^\/(@?[^/]+(?:\/[^/]+)?)\/([^/(]+)/.exec(key);
      if (m) add("npm", m[1]!, m[2]);
    }
  },
  "requirements.txt": (text, add) => {
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*==\s*([\w.]+)/.exec(line);
      if (m) add("PyPI", m[1]!, m[3]);
    }
  },
  "poetry.lock": (text, add) => tomlPackages(text, (n, v) => add("PyPI", n, v)),
  "uv.lock": (text, add) => tomlPackages(text, (n, v) => add("PyPI", n, v)),
  "Pipfile.lock": (text, add) => {
    const lock = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
    for (const section of ["default", "develop"]) for (const [n, p] of Object.entries(lock[section] ?? {})) add("PyPI", n, p.version?.replace(/^==/, ""));
  },
  "Cargo.lock": (text, add) => tomlPackages(text, (n, v) => add("crates.io", n, v)),
  "go.sum": (text, add) => {
    for (const line of text.split("\n")) {
      const m = /^(\S+)\s+v([^\s/]+?)(\/go\.mod)?\s/.exec(line);
      if (m && !m[3]) add("Go", m[1]!, m[2]);
    }
  },
  "Gemfile.lock": (text, add) => {
    const specs = /^ {4}([\w.-]+) \(([\w.]+)\)$/gm;
    let m: RegExpExecArray | null;
    while ((m = specs.exec(text))) add("RubyGems", m[1]!, m[2]);
  },
  "composer.lock": (text, add) => {
    const lock = JSON.parse(text) as { packages?: { name: string; version: string }[]; "packages-dev"?: { name: string; version: string }[] };
    for (const p of [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])]) add("Packagist", p.name, p.version);
  },
  "pubspec.lock": (text, add) => {
    const lock = parseYaml(text) as { packages?: Record<string, { version?: string; source?: string }> };
    for (const [n, p] of Object.entries(lock.packages ?? {})) if (p.source !== "sdk") add("Pub", n, p.version);
  },
  "Podfile.lock": (text, add) => {
    const re = /^ {2}- ([\w+/-]+) \(([\w.]+)\)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) add("CocoaPods", m[1]!.split("/")[0]!, m[2]);
  },
  "Package.resolved": (text, add) => {
    const lock = JSON.parse(text) as { pins?: { location?: string; repositoryURL?: string; state?: { version?: string } }[]; object?: { pins?: { repositoryURL?: string; state?: { version?: string } }[] } };
    for (const p of lock.pins ?? lock.object?.pins ?? []) add("SwiftURL", ((p as { location?: string }).location ?? p.repositoryURL ?? "").replace(/\.git$/, ""), p.state?.version);
  },
  "gradle.lockfile": (text, add) => {
    for (const line of text.split("\n")) {
      const m = /^([\w.-]+):([\w.-]+):([\w.-]+)=/.exec(line);
      if (m) add("Maven", `${m[1]}:${m[2]}`, m[3]);
    }
  },
  "libs.versions.toml": (text, add, file, unpinned) => {
    // Gradle version catalog: [versions] names, [libraries] module + version.ref.
    const versions = new Map<string, string>();
    const section = (name: string) => new RegExp(`^\\[${name}\\]([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m").exec(text)?.[1] ?? "";
    for (const m of section("versions").matchAll(/^\s*([\w-]+)\s*=\s*"([^"]+)"/gm)) versions.set(m[1]!, m[2]!);
    for (const line of section("libraries").split("\n")) {
      const module = /module\s*=\s*"([^"]+)"/.exec(line)?.[1] ?? /group\s*=\s*"([^"]+)"[^}]*name\s*=\s*"([^"]+)"/.exec(line)?.slice(1, 3).join(":");
      const direct = /version\s*=\s*"([^"]+)"/.exec(line)?.[1];
      const ref = /version\.ref\s*=\s*"([^"]+)"/.exec(line)?.[1];
      const short = /^\s*[\w-]+\s*=\s*"([\w.-]+:[\w.-]+):([^"]+)"/.exec(line);
      const name = module ?? short?.[1];
      const version = direct ?? (ref ? versions.get(ref) : undefined) ?? short?.[2];
      if (!name) continue;
      if (version && /[+]|latest\.|SNAPSHOT/i.test(version)) unpinned.push(unpinnedFinding(file, name, version));
      add("Maven", name, version);
    }
  },
  "pom.xml": (text, add) => {
    const props = new Map<string, string>();
    for (const m of text.matchAll(/<([\w.-]+)>([^<${}]+)<\/\1>/g)) props.set(m[1]!, m[2]!);
    for (const m of text.matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>/g)) {
      const v = m[3]!.replace(/\$\{([^}]+)\}/, (_, k: string) => props.get(k) ?? "");
      add("Maven", `${m[1]}:${m[2]}`, v);
    }
  },
  ".csproj": (text, add) => {
    for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) add("NuGet", m[1]!, m[2]);
  },
  "package.json": (text, add, file, unpinned) => {
    // Lockfiles give exact versions; package.json only adds findings for floating ones.
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    for (const key of ["dependencies", "devDependencies"]) {
      for (const [n, v] of Object.entries(pkg[key] ?? {})) if (v === "*" || v === "latest" || /^(git|github|https?):/.test(v)) unpinned.push(unpinnedFinding(file, n, v));
    }
  },
};

function tomlPackages(text: string, add: (name: string, version: string) => void): void {
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) add(name, version);
  }
}

function unpinnedFinding(file: string, name: string, version: string): SecurityFinding {
  return makeFinding({
    check: "COM-DEP-04",
    title: `Floating dependency version: ${name}@${version}`,
    severity: "medium",
    layer: "deps",
    file,
    evidence: `${name} ${version}`,
    why: "Each build can pull a different (possibly compromised) version without review.",
    fix: "Pin an exact version and update it deliberately (Renovate/Dependabot).",
    refs: ["CWE-829"],
    feature: "project",
  });
}

function uniq(deps: Dependency[]): Dependency[] {
  const seen = new Map<string, Dependency>();
  for (const d of deps) seen.set(`${d.ecosystem}|${d.name}|${d.version}`, d);
  return [...seen.values()];
}

// ── OSV

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
}

const OSV = "https://api.osv.dev/v1";

/**
 * Known vulnerabilities for the dependencies, from OSV (one batch query, then details for each
 * hit). Only package names and versions leave the machine.
 */
export async function osvFindings(deps: Dependency[], owner: (file: string) => string, log: (line: string) => void): Promise<SecurityFinding[]> {
  const out: SecurityFinding[] = [];
  const details = new Map<string, OsvVuln | null>();
  for (let i = 0; i < deps.length; i += 500) {
    const chunk = deps.slice(i, i + 500);
    const res = await fetchJson<{ results: { vulns?: { id: string }[] }[] }>(`${OSV}/querybatch`, {
      queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
    });
    res.results.forEach((r, n) => {
      const dep = chunk[n]!;
      for (const v of r.vulns ?? []) {
        details.set(v.id, null);
        out.push(osvPlaceholder(dep, v.id, owner(dep.file)));
      }
    });
  }
  if (out.length) log(`  ${out.length} known vulnerabilit${out.length === 1 ? "y" : "ies"} in ${new Set(out.map((f) => f.evidence.split(" ")[0])).size} package(s)`);
  // Details for the summary, severity and fixed version: at most 150 lookups.
  for (const id of [...details.keys()].slice(0, 150)) details.set(id, await fetchJson<OsvVuln>(`${OSV}/vulns/${encodeURIComponent(id)}`).catch(() => null));
  return out.map((f) => {
    const v = details.get(f.refs[1]!);
    if (!v) return f;
    const [pkg] = f.evidence.split(" ");
    const fixed = v.affected?.find((a) => a.package?.name === pkg)?.ranges?.flatMap((r) => r.events ?? []).find((e) => e.fixed)?.fixed;
    const cve = v.aliases?.find((a) => a.startsWith("CVE-"));
    return makeFinding({
      ...f,
      title: `${pkg}: ${(v.summary ?? v.details ?? v.id).split("\n")[0]!.slice(0, 120)}`,
      severity: osvSeverity(v),
      why: `${v.id}${cve ? ` (${cve})` : ""}: ${(v.summary ?? v.details ?? "known vulnerability").slice(0, 300)}`,
      fix: fixed ? `Upgrade ${pkg} to ${fixed} or later, then rebuild and run the tests.` : `No fixed version listed for ${pkg}: check ${v.id}, upgrade when a fix ships, or replace the package.`,
      refs: ["CWE-1104", v.id, ...(cve ? [cve] : [])],
    });
  });
}

function osvPlaceholder(dep: Dependency, id: string, feature: string): SecurityFinding {
  return makeFinding({
    check: "COM-DEP-01",
    title: `${dep.name}@${dep.version}: ${id}`,
    severity: "medium",
    layer: "deps",
    file: dep.file,
    evidence: `${dep.name} ${dep.version} (${dep.ecosystem}) ${id}`,
    why: `Known vulnerability ${id}.`,
    fix: `Upgrade ${dep.name}.`,
    refs: ["CWE-1104", id],
    feature,
  });
}

function osvSeverity(v: OsvVuln): Severity {
  const label = v.database_specific?.severity?.toLowerCase();
  if (label === "critical" || label === "high" || label === "low") return label;
  if (label === "moderate" || label === "medium") return "medium";
  const score = v.severity?.map((s) => cvssScore(s.score)).find((n) => n !== null);
  if (score === undefined || score === null) return "medium";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
}

/** The base score of a CVSS vector when it carries one, else a rough reading of its impact. */
function cvssScore(vector: string): number | null {
  const n = Number(vector);
  if (!Number.isNaN(n)) return n;
  if (!/^CVSS:/.test(vector)) return null;
  const high = (vector.match(/\/(C|I|A|VC|VI|VA):H/g) ?? []).length;
  const network = /AV:N/.test(vector);
  const noAuth = /PR:N/.test(vector);
  return high >= 2 && network && noAuth ? 9.1 : high >= 1 && network ? 7.5 : high >= 1 ? 6 : 4;
}

async function fetchJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) } : { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
