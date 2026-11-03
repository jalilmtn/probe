import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { SecurityFinding } from "../core/types.js";
import { makeFinding, mask } from "./findings.js";
import type { Rule } from "./rule.js";

/**
 * What actually ships: the newest APK/AAB/IPA and web build output on disk. Obfuscation
 * renames classes but leaves the string pool alone, so secrets compiled in are still there.
 * Nothing is built here; with no artifact the layer is skipped.
 */
export function findArtifacts(root: string): { apps: string[]; web: string[] } {
  const apps: { path: string; mtime: number }[] = [];
  const web: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".gradle" || e.name === "Pods" || e.name === "intermediates" || e.name === "tmp") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        // Web build output: the folder a bundler writes with static assets.
        if (/^(dist|build|out|\.next)$/.test(e.name) && depth <= 3) collectWeb(path, web);
        visit(path, depth + 1);
      } else if (/\.(apk|aab|ipa)$/.test(e.name)) {
        apps.push({ path, mtime: statSync(path).mtimeMs });
      }
    }
  };
  visit(root, 0);
  // Newest per kind: an old debug APK says little about the release.
  const newest = (ext: string) => apps.filter((a) => a.path.endsWith(ext)).sort((a, b) => b.mtime - a.mtime).slice(0, 2).map((a) => a.path);
  return { apps: [...newest(".apk"), ...newest(".aab"), ...newest(".ipa")], web: [...new Set(web)].slice(0, 400) };
}

function collectWeb(dir: string, out: string[]): void {
  const visit = (d: string, depth: number) => {
    if (depth > 5 || out.length > 400) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== "server" && e.name !== "cache") visit(p, depth + 1);
      else if (/\.(js|mjs|map)$/.test(e.name) && !/[\\/](outputs|intermediates|generated|tmp|kotlin|classes)[\\/]/.test(p)) out.push(p);
    }
  };
  visit(dir, 0);
}

/** Runs the secret rules and the ship-only checks over every artifact found. */
export function artifactFindings(root: string, rules: Rule[], owner: (file: string) => string): { findings: SecurityFinding[]; scanned: string[] } {
  const { apps, web } = findArtifacts(root);
  const secretRules = rules.filter((r) => r.secret && r.match && !r.when && !r.absent && r.platform === "common");
  const out: SecurityFinding[] = [];
  for (const path of apps) {
    const rel = relative(root, path).replace(/\\/g, "/");
    let entries: ZipEntry[];
    try {
      entries = readZip(readFileSync(path));
    } catch {
      continue;
    }
    out.push(...packageFindings(rel, entries, secretRules, owner(rel)));
  }
  const maps = web.filter((p) => p.endsWith(".map"));
  if (maps.length) {
    const rel = relative(root, maps[0]!).replace(/\\/g, "/");
    out.push(artifact("WEB-SEC-02", "low", rel, `${maps.length} source map(s), e.g. ${rel}`, "Source maps in the web build", "If these are deployed, anyone can read your original source code and comments.", "Do not deploy .map files (hidden-source-map + upload to your error tracker).", ["CWE-540"], owner(rel)));
  }
  for (const path of web.filter((p) => !p.endsWith(".map"))) {
    let text: string;
    try {
      if (statSync(path).size > 8 * 1024 * 1024) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, path).replace(/\\/g, "/");
    for (const r of secretRules) {
      const m = r.match!.exec(text);
      if (m) out.push(artifact(r.id, r.severity, rel, mask(m[0]), `${r.title} — in the shipped web bundle`, `${r.why} The browser downloads this file, so every visitor has it.`, r.fix, [...r.refs, "WEB-SEC-01"], owner(rel)));
    }
  }
  return { findings: out, scanned: [...apps, ...(web.length ? [`${web.length} web build file(s)`] : [])].map((p) => (p.includes(root) ? relative(root, p).replace(/\\/g, "/") : p)) };
}

function packageFindings(rel: string, entries: ZipEntry[], secretRules: Rule[], feature: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const isApk = /\.(apk|aab)$/.test(rel);
  const strings: string[] = [];
  for (const e of entries) {
    if (isApk ? /(^|\/)classes\d*\.dex$|resources\.arsc$|^(base\/)?assets\/|\.(json|properties|xml|txt|js)$/.test(e.name) : /\.app\/[^/]+$|\.(plist|json|js|strings)$/.test(e.name)) {
      const data = e.read();
      if (data) strings.push(...printable(data));
    }
  }
  const pool = strings.join("\n");
  const seen = new Set<string>();
  for (const r of secretRules) {
    const re = new RegExp(r.match!.source, `${r.match!.flags.replace("g", "")}g`);
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(pool)) && n < 5) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      n++;
      out.push(artifact(isApk ? "AND-BLD-03" : "IOS-BLD-01", "critical", rel, mask(m[0]), `${r.title} — in the shipped app`, `${r.why} It is in the built ${isApk ? "APK" : "IPA"}: unzip and a string search recover it, obfuscated or not.`, "Remove it from the client entirely (serve it from your backend as a short-lived token) and rotate it.", [...r.refs, isApk ? "AND-BLD-03" : "IOS-BLD-01"], feature));
    }
  }
  if (isApk) {
    const tools: [RegExp, string][] = [
      [/com\/chuckerteam\/chucker\/internal/, "Chucker (HTTP inspector)"],
      [/leakcanary\/internal/, "LeakCanary"],
      [/com\/facebook\/flipper\/core/, "Flipper"],
      [/com\/facebook\/stetho\/inspector/, "Stetho"],
      [/androidx\/compose\/ui\/tooling\/PreviewActivity/, "Compose PreviewActivity"],
    ];
    for (const [re, name] of tools) if (re.test(pool)) out.push(artifact("AND-MAN-11", "low", rel, name, `${name} shipped in the app`, "Debug tooling in a distributed build can expose network traffic, heap data or extra exported activities.", "Use debugImplementation (and the -no-op artifact) so it stays out of release builds.", ["MASVS-CODE"], feature));
    const unstripped = entries.filter((e) => /^(base\/)?lib\/[^/]+\/[^/]+\.so$/.test(e.name)).find((e) => {
      const data = e.read();
      return data !== null && data.includes(".debug_info");
    });
    if (unstripped) out.push(artifact("AND-BLD-06", "info", rel, unstripped.name, "Native library with debug info shipped", "Full debug info makes native code much easier to reverse engineer.", "Strip native libraries in release (the default unless debugSymbolLevel FULL or keepDebugSymbols is set).", [], feature));
  } else {
    if (/NSAllowsArbitraryLoads/.test(pool)) out.push(artifact("IOS-CFG-01", "high", rel, "NSAllowsArbitraryLoads", "ATS exception in the shipped app", "The released app may load plain HTTP.", "Remove NSAllowsArbitraryLoads from the release Info.plist.", ["CWE-319"], feature));
    if (/get-task-allow<\/key>\s*<true/.test(pool)) out.push(artifact("IOS-CFG-03", "medium", rel, "get-task-allow", "Debuggable IPA", "A debugger can attach to this build.", "Export with a distribution profile.", ["CWE-489"], feature));
  }
  return out;
}

function artifact(check: string, severity: SecurityFinding["severity"], file: string, evidence: string, title: string, why: string, fix: string, refs: string[], feature: string): SecurityFinding {
  return makeFinding({ check, title, severity, layer: "artifact", file, evidence, why, fix, refs, feature });
}

/** Runs of 6+ printable characters (ASCII, and UTF-16LE as resources.arsc stores them). */
function printable(data: Buffer): string[] {
  const out: string[] = [];
  let run = "";
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
    else {
      if (run.length >= 6) out.push(run);
      run = "";
    }
  }
  if (run.length >= 6) out.push(run);
  run = "";
  for (let i = 0; i + 1 < data.length; i += 2) {
    const c = data[i]!;
    if (data[i + 1] === 0 && c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
    else {
      if (run.length >= 8) out.push(run);
      run = "";
    }
  }
  return out;
}

// ── A small zip reader: APK, AAB and IPA are zip files.

export interface ZipEntry {
  name: string;
  size: number;
  read(): Buffer | null;
}

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    entries.push({
      name,
      size,
      read: () => {
        // Large entries (media, native libs above 64 MB) are not worth inflating.
        if (size > 64 * 1024 * 1024 || local + 30 > buf.length) return null;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + compressed);
        try {
          return method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
        } catch {
          return null;
        }
      },
    });
  }
  return entries;
}
