import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "./rule.js";

/**
 * What kinds of code a project has, from its files: an Android manifest, an Xcode project,
 * a package.json that depends on express, a Dockerfile… A monorepo gets several. This picks
 * the catalogs that run, so every project is checked as what it is.
 */
export function detectPlatforms(root: string, files: string[]): Set<Platform> {
  const found = new Set<Platform>();
  const has = (re: RegExp) => files.some((f) => re.test(f));
  const deps = packageDeps(root, files);
  const dep = (re: RegExp) => [...deps].some((d) => re.test(d));

  if (has(/AndroidManifest\.xml$/)) found.add("android");
  if (has(/\.xcodeproj\/|\.xcworkspace\/|(^|\/)Info\.plist$|\.swift$|(^|\/)Podfile$/)) found.add("ios");
  if (has(/(^|\/)pubspec\.yaml$/) && has(/\.dart$/)) found.add("flutter");
  if (dep(/^(react-native|expo)$/)) found.add("rn");
  if (has(/\/(commonMain|iosMain|androidMain)\//)) found.add("kmp");
  if (dep(/^@capacitor\/|^cordova/) || has(/(^|\/)config\.xml$/) && has(/(^|\/)www\/index\.html$/)) found.add("hybrid");
  if (has(/\.csproj$/) && files.some((f) => /\.csproj$/.test(f) && /Maui|Xamarin/.test(read(root, f)))) found.add("maui");
  if (dep(/^electron$/)) found.add("electron");
  if (dep(/^@tauri-apps\//) || has(/(^|\/)tauri\.conf\.json$/)) found.add("tauri");

  // Browser code: a UI framework, a bundler, or plain pages.
  if (dep(/^(react|react-dom|vue|@angular\/core|svelte|solid-js|preact|next|nuxt|vite|webpack|@sveltejs\/kit|astro|jquery)$/) || has(/(^|\/)(public|static|www)\/.+\.html$|(^|\/)index\.html$/) || has(/(^|\/)manifest\.json$/) && files.some((f) => /(^|\/)manifest\.json$/.test(f) && /"manifest_version"/.test(read(root, f)))) found.add("web");

  // Servers.
  if (dep(/^(express|fastify|koa|@nestjs\/core|@hapi\/hapi|hono|next|@remix-run\/node|nuxt|@sveltejs\/kit|restify|apollo-server|@apollo\/server|graphql-yoga)$/)) found.add("node");
  if (has(/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/) || has(/\.py$/)) found.add("python");
  if (has(/\.(java|kt)$/) && (has(/(^|\/)(pom\.xml)$/) || files.some((f) => /\.gradle(\.kts)?$/.test(f) && /spring|ktor|micronaut|quarkus|javax\.servlet|jakarta/.test(read(root, f))))) found.add("jvm");
  if (has(/(^|\/)go\.mod$/)) found.add("go");
  if (has(/\.csproj$/) && !found.has("maui")) found.add("dotnet");
  if (has(/(^|\/)composer\.json$/) || has(/\.php$/)) found.add("php");
  if (has(/(^|\/)Gemfile$/) || has(/\.rb$/)) found.add("ruby");
  if (["node", "python", "jvm", "go", "dotnet", "php", "ruby"].some((p) => found.has(p as Platform))) found.add("backend");

  // Delivery.
  if (has(/(^|\/)Dockerfile[^/]*$|(^|\/)(docker-)?compose[^/]*\.ya?ml$/)) found.add("docker");
  if (has(/^\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|^\.gitlab\/ci\/|(^|\/)Jenkinsfile$|^\.circleci\/|(^|\/)bitbucket-pipelines\.yml$|(^|\/)azure-pipelines\.ya?ml$/)) found.add("ci");
  if (has(/\.tf$|(^|\/)(k8s|kubernetes|helm|charts|manifests)\/|(^|\/)serverless\.ya?ml$|(^|\/)template\.ya?ml$/)) found.add("iac");
  return found;
}

/** Dependency names from every package.json. */
function packageDeps(root: string, files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files.filter((x) => /(^|\/)package\.json$/.test(x) && !x.includes("node_modules/"))) {
    try {
      const pkg = JSON.parse(read(root, f)) as Record<string, Record<string, string> | undefined>;
      for (const key of ["dependencies", "devDependencies", "peerDependencies"]) for (const name of Object.keys(pkg[key] ?? {})) out.add(name);
    } catch {
      // A broken package.json says nothing about the platform.
    }
  }
  return out;
}

function read(root: string, file: string): string {
  const path = join(root, file);
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** Catalog docs that apply, for the report and the agent's checklist. */
export const PLATFORM_DOCS: Record<Platform, string> = {
  common: "common.md",
  android: "android.md",
  ios: "ios.md",
  web: "web-frontend.md",
  backend: "backend.md",
  node: "backend.md",
  python: "backend.md",
  jvm: "backend.md",
  go: "backend.md",
  dotnet: "backend.md",
  php: "backend.md",
  ruby: "backend.md",
  rn: "cross-platform-mobile.md",
  flutter: "cross-platform-mobile.md",
  kmp: "cross-platform-mobile.md",
  hybrid: "cross-platform-mobile.md",
  maui: "cross-platform-mobile.md",
  electron: "desktop.md",
  tauri: "desktop.md",
  docker: "common.md",
  ci: "common.md",
  iac: "common.md",
};
