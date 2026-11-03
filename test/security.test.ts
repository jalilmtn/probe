import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, test } from "node:test";
import { newRunId, Store } from "../src/core/store.js";
import type { SecurityRun } from "../src/core/types.js";
import { findIssue, fixPrompt, issuesOf } from "../src/engine/issues.js";
import type { Project } from "../src/engine/project.js";
import { parseAgentFindings } from "../src/security/agent.js";
import { readZip } from "../src/security/artifact.js";
import { RULES, rulesFor } from "../src/security/catalog/index.js";
import { readDependencies } from "../src/security/deps.js";
import { dedupe, dismiss, loadDismissals, mask } from "../src/security/findings.js";
import { detectPlatforms } from "../src/security/platforms.js";
import { recheckFinding } from "../src/security/run.js";
import { isLocalUrl } from "../src/security/runtime.js";
import { runStatic } from "../src/security/static.js";

const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// Built at runtime so this file never holds something a secret scanner takes for a real key.
const STRIPE_LIVE = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

function project(files: Record<string, string>): Project {
  const root = mkdtempSync(join(tmpdir(), "probe-sec-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const config = { security: { osv: false, historyCommits: 0, failOn: "high", skip: [], ignorePaths: [] }, devices: { allowReal: [] } } as unknown as Project["config"];
  return { root, name: "fake", adapter: {} as Project["adapter"], config, store: new Store(root) };
}

const scanAll = (p: Project, files: string[]) => runStatic(p.root, files, rulesFor(detectPlatforms(p.root, files)), { owner: () => "app", skip: [] });

describe("catalog", () => {
  test("every rule has a catalog id, a reason and a fix", () => {
    for (const r of RULES) {
      assert.match(r.id, /^[A-Z]{3}-[A-Z0-9]+(-\d+)?$|^X[A-Z]{1,2}-\d+$/, r.id);
      assert.ok(r.why.length > 10 && r.fix.length > 5, r.id);
      assert.ok(r.match || r.fileOnly, `${r.id} matches nothing`);
    }
  });

  test("rule ids exist in the docs", async () => {
    const { readFileSync } = await import("node:fs");
    const docs = ["common", "android", "ios", "web-frontend", "backend", "cross-platform-mobile", "desktop"].map((d) => readFileSync(join("docs/security", `${d}.md`), "utf8")).join("\n");
    const missing = [...new Set(RULES.map((r) => r.id))].filter((id) => !docs.includes(id));
    assert.deepEqual(missing, []);
  });
});

describe("platforms", () => {
  test("detected from the files", () => {
    const p = project({
      "app/src/main/AndroidManifest.xml": "<manifest/>",
      "web/package.json": JSON.stringify({ dependencies: { react: "18.3.1", express: "4.19.2" } }),
      "Dockerfile": "FROM node:20",
      ".github/workflows/ci.yml": "on: push",
    });
    const found = detectPlatforms(p.root, ["app/src/main/AndroidManifest.xml", "web/package.json", "Dockerfile", ".github/workflows/ci.yml"]);
    for (const k of ["android", "web", "node", "backend", "docker", "ci"]) assert.ok(found.has(k as never), k);
    assert.ok(!found.has("ios"));
  });
});

describe("static rules", () => {
  test("Android manifest and code problems", () => {
    const files = {
      "app/src/main/AndroidManifest.xml": `<manifest><application android:allowBackup="true" android:usesCleartextTraffic="true">
        <activity android:name=".Share" android:exported="true"/>
        <activity android:name=".Main" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity>
      </application></manifest>`,
      "app/src/main/java/a/Crypto.kt": `val spec = IvParameterSpec(ByteArray(16))\nval c = Cipher.getInstance("AES")\nwebView.setWebContentsDebuggingEnabled(true)`,
    };
    const p = project(files);
    const ids = new Set(scanAll(p, Object.keys(files)).map((f) => f.check));
    for (const id of ["AND-MAN-02", "AND-MAN-04", "AND-MAN-05", "AND-IPC-01", "AND-CRY-02", "AND-CRY-03", "AND-WEB-09"]) assert.ok(ids.has(id), id);
  });

  test("protections already in place stop a finding", () => {
    const files = { "a/Net.kt": `val c = OkHttpClient.Builder().certificatePinner(CertificatePinner.Builder().build())` };
    const ids = scanAll(project(files), Object.keys(files)).map((f) => f.check);
    assert.ok(!ids.includes("AND-NET-03"));
  });

  test("secrets are masked and test files skipped", () => {
    const files = { "src/pay.js": `const key = "${STRIPE_LIVE}";`, "test/pay.test.js": `const key = "${STRIPE_LIVE}";` };
    const found = scanAll(project(files), Object.keys(files)).filter((f) => f.check === "COM-SEC-01");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.file, "src/pay.js");
    assert.ok(!found[0]!.evidence.includes(STRIPE_LIVE));
  });

  test("probe-security-ignore skips one check on that line", () => {
    const files = { "src/a.js": `// probe-security-ignore WEB-XSS-04\neval(userInput)\neval(other)` };
    const p = project(files);
    const lines = runStatic(p.root, Object.keys(files), RULES, { owner: () => "app", skip: [] }).filter((f) => f.check === "WEB-XSS-04").map((f) => f.line);
    assert.deepEqual(lines, [3]);
  });

  test("backend rules per language", () => {
    const files = {
      "package.json": JSON.stringify({ dependencies: { express: "4.19.2" } }),
      "api/users.ts": "db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)\nres.redirect(req.query.next)",
      "svc/app.py": "import pickle\ndata = pickle.loads(body)\nsubprocess.run(cmd, shell=True)",
    };
    const ids = new Set(scanAll(project(files), Object.keys(files)).map((f) => f.check));
    for (const id of ["API-INJ-01", "API-SRV-07", "API-SRV-04", "API-INJ-03"]) assert.ok(ids.has(id), id);
  });

  test("key files are found by their presence", () => {
    const files = { "app/signing/release.jks": "binary" };
    assert.ok(scanAll(project(files), Object.keys(files)).some((f) => f.check === "COM-SEC-02"));
  });
});

describe("dependencies", () => {
  test("exact versions from lockfiles, floating ones flagged", () => {
    const files = {
      "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/lodash": { version: "4.17.20" }, "node_modules/a/node_modules/@x/y": { version: "1.0.0" } } }),
      "package.json": JSON.stringify({ dependencies: { left: "latest" } }),
      "requirements.txt": "django==3.2.1\nrequests>=2\n",
      "gradle/libs.versions.toml": `[versions]\nokhttp = "4.9.0"\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\n`,
    };
    const p = project(files);
    const { deps, unpinned } = readDependencies(p.root, Object.keys(files));
    const names = deps.map((d) => `${d.ecosystem}:${d.name}@${d.version}`);
    for (const n of ["npm:lodash@4.17.20", "npm:@x/y@1.0.0", "PyPI:django@3.2.1", "Maven:com.squareup.okhttp3:okhttp@4.9.0"]) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => n.includes("requests")));
    assert.equal(unpinned.length, 1);
  });
});

describe("issues, prompt, dismiss, re-check", () => {
  function securityRun(p: Project): SecurityRun {
    mkdirSync(join(p.root, "src"), { recursive: true });
    writeFileSync(join(p.root, "src/page.js"), "el.innerHTML = location.hash;");
    const findings = runStatic(p.root, ["src/page.js"], RULES, { owner: () => "project", skip: [] });
    const run: SecurityRun = { id: newRunId(), kind: "security", feature: "*", startedAt: new Date().toISOString(), status: "failed", platforms: ["web"], layers: [], findings: dedupe(findings), dismissed: 0, files: 1, costUsd: 0 };
    p.store.writeRun(run.id, run);
    return run;
  }

  test("findings become issues with a security fix prompt", () => {
    const p = project({ "package.json": "{}" });
    p.store.write("scan.json", { project: {}, scannedAt: "", features: [], excluded: [] });
    const run = securityRun(p);
    const issues = issuesOf(p, run);
    assert.ok(issues.length >= 1);
    assert.equal(issues[0]!.kind, "security");
    const found = findIssue(p, issues[0]!.id)!;
    const prompt = fixPrompt(p, found.issue, found.run, false);
    assert.match(prompt, /security problem/);
    assert.match(prompt, /probe-security-ignore/);
    assert.match(prompt, /src\/page\.js:1/);
  });

  test("a dismissal is kept with its reason", () => {
    const p = project({});
    const run = securityRun(p);
    dismiss(p, run.findings[0]!, "only used in the local dev tool");
    assert.equal(loadDismissals(p)[0]!.reason, "only used in the local dev tool");
    assert.throws(() => dismiss(p, run.findings[0]!, "  "));
  });

  test("re-check sees the fix", async () => {
    const p = project({});
    const run = securityRun(p);
    const f = run.findings.find((x) => x.check === "WEB-XSS-05" || x.check === "WEB-XSS-01")!;
    assert.equal((await recheckFinding(p, f)).stillFound, true);
    writeFileSync(join(p.root, "src/page.js"), "el.textContent = location.hash;");
    const after = await recheckFinding(p, f);
    assert.equal(after.checked, true);
    assert.equal(after.stillFound, false);
  });
});

describe("helpers", () => {
  test("mask keeps the ends only", () => {
    const m = mask(STRIPE_LIVE);
    assert.ok(m.startsWith("sk_l") && !m.includes("4eC39HqLyjWDarjt"));
  });

  test("runtime checks only take local URLs", () => {
    assert.ok(isLocalUrl("http://localhost:3000"));
    assert.ok(isLocalUrl("http://app.test/x"));
    assert.ok(!isLocalUrl("https://example.com"));
    assert.ok(!isLocalUrl("http://localhost.evil.com"));
  });

  test("zip reader inflates entries", () => {
    const data = Buffer.from("hello classes.dex");
    const comp = deflateRawSync(data);
    const name = Buffer.from("classes.dex");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const cdStart = local.length + name.length + comp.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    const zip = Buffer.concat([local, name, comp, central, name, eocd]);
    const entries = readZip(zip);
    assert.equal(entries[0]!.name, "classes.dex");
    assert.equal(entries[0]!.read()!.toString(), "hello classes.dex");
  });

  test("agent findings are parsed from the last json block", () => {
    const text = 'Looked around.\n```json\n{"findings":[{"check":"API-AUZ-01","title":"Order fetched without owner check","severity":"High","file":"./api/orders.ts","line":12,"evidence":"findById(req.params.id)","why":"any user reads any order","fix":"check ownerId"},{"nope":1}]}\n```';
    const list = parseAgentFindings(text, "orders");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.severity, "high");
    assert.equal(list[0]!.file, "api/orders.ts");
    assert.equal(list[0]!.layer, "agent");
    assert.deepEqual(parseAgentFindings("no json here", "x"), []);
  });
});
