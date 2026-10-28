// Bundles the whole tool into one file so the plugin runs straight from a git checkout,
// with no `npm install` on the user's machine.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/probe.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  loader: { ".html": "text", ".md": "text" },
  logLevel: "info",
});
