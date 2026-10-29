// Runs the tests under test/ with Node's own runner. Each test file is bundled the way the
// plugin is (TypeScript, .html as text), so tests exercise the same code that ships.
import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const out = ".test-dist";
rmSync(out, { recursive: true, force: true });
const files = readdirSync("test").filter((f) => f.endsWith(".test.ts"));
await build({
  entryPoints: files.map((f) => `test/${f}`),
  outdir: out,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  packages: "external",
  loader: { ".html": "text", ".md": "text" },
  logLevel: "warning",
});
const result = spawnSync(process.execPath, ["--test", ...files.map((f) => `${out}/${f.replace(/\.ts$/, ".cjs")}`)], { stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
