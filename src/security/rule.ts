import type { Severity } from "../core/types.js";

/**
 * Where a rule applies. "common" runs on every project; the others run when the project has
 * that kind of code (see platforms.ts), so an Android check never reads a Django app.
 */
export type Platform =
  | "common"
  | "android"
  | "ios"
  | "web"
  | "backend"
  | "node"
  | "python"
  | "jvm"
  | "go"
  | "dotnet"
  | "php"
  | "ruby"
  | "rn"
  | "flutter"
  | "kmp"
  | "hybrid"
  | "maui"
  | "electron"
  | "tauri"
  | "docker"
  | "ci"
  | "iac";

/**
 * One static check from the catalog (docs/security). A rule reads the files `files` matches
 * and reports each place `match` matches; `absent` turns it round (the file lacks `match`),
 * and `fileOnly` reports the file's mere presence (a keystore in the repo).
 */
export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  platform: Platform;
  files: RegExp;
  match?: RegExp;
  /** Only files whose text matches this. */
  when?: RegExp;
  /** Never files whose text matches this (the protection is already there). */
  unless?: RegExp;
  absent?: boolean;
  fileOnly?: boolean;
  /** The match is a secret: evidence is masked. */
  secret?: boolean;
  /** Test files are read too (by default they are skipped: fixtures are full of fake keys). */
  tests?: boolean;
  why: string;
  fix: string;
  refs: string[];
}

type Extra = Partial<Pick<Rule, "when" | "unless" | "absent" | "fileOnly" | "secret" | "tests">>;

/** A rule in one line, so the catalogs read like the tables in docs/security. */
export function rule(id: string, severity: Severity, platform: Platform, files: RegExp, match: RegExp | undefined, title: string, why: string, fix: string, refs: string[], extra: Extra = {}): Rule {
  return { id, severity, platform, files, match, title, why, fix, refs, ...extra };
}

// File kinds the catalogs share.
export const F = {
  kotlinJava: /\.(kt|kts|java)$/,
  kotlin: /\.kt$/,
  manifest: /AndroidManifest\.xml$/,
  gradle: /\.gradle(\.kts)?$/,
  androidXml: /\/res\/xml\/[^/]+\.xml$/,
  androidRes: /\/res\/values[^/]*\/[^/]+\.xml$/,
  proguard: /(proguard|r8)[^/]*\.(pro|txt|cfg)$/,
  swiftObjc: /\.(swift|m|mm|h)$/,
  swift: /\.swift$/,
  plist: /\.plist$/,
  entitlements: /\.entitlements$/,
  js: /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte)$/,
  html: /\.html?$/,
  py: /\.py$/,
  go: /\.go$/,
  cs: /\.cs$/,
  php: /\.php$/,
  rb: /\.rb$/,
  dart: /\.dart$/,
  c: /\.(c|cc|cpp|cxx|h|hpp|m|mm)$/,
  anyCode: /\.(kt|kts|java|swift|m|mm|m?[jt]sx?|cjs|vue|svelte|py|go|cs|php|rb|dart|rs|scala|groovy|c|cc|cpp|h)$/,
  config: /\.(ya?ml|json|properties|toml|ini|conf|cfg|env|xml|plist|xcconfig|gradle|kts|tf|tfvars)$|(^|\/)\.env(\.[\w-]+)?$/,
  text: /\.(kt|kts|java|swift|m|mm|h|m?[jt]sx?|cjs|vue|svelte|py|go|cs|php|rb|dart|rs|scala|groovy|c|cc|cpp|ya?ml|json|properties|toml|ini|conf|cfg|xml|plist|xcconfig|gradle|tf|tfvars|md|txt|sh|bash|ps1|http|ipynb|html?)$|(^|\/)\.env(\.[\w-]+)?$|(^|\/)Dockerfile[^/]*$/,
  dockerfile: /(^|\/)Dockerfile[^/]*$|\.dockerfile$/,
  compose: /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
  ghActions: /^\.github\/workflows\/[^/]+\.ya?ml$/,
  gitlabCi: /(^|\/)\.gitlab-ci\.ya?ml$|^\.gitlab\/ci\/.+\.ya?ml$/,
  terraform: /\.tf$/,
  k8s: /(^|\/)(k8s|kubernetes|manifests|helm|charts|deploy)\/.+\.ya?ml$/,
  packageJson: /(^|\/)package\.json$/,
};
