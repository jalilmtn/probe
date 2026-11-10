import { spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { ProbeConfig } from "../core/config.js";
import { isWindows, throwIfStopped } from "../core/proc.js";
import type { BuildRef, BuildSource, TestedBuild } from "../core/types.js";
import { resolveApp } from "../engine/app.js";
import type { Project } from "../engine/project.js";
import { androidSdk } from "./adb.js";
import type { AndroidDevice } from "./android.js";

// A finished build is what testers get: a release file, a Firebase App Distribution release, or
// the copy Google Play signed for a track. A run that names one installs that instead of
// building the working tree, and says in its record which build it tested.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const BUILD_SOURCE_LABEL: Record<BuildSource, string> = { file: "File", firebase: "Firebase", play: "Google Play" };

/** A build on this machine, ready to install. */
export interface ResolvedBuild {
  /** An .apk, .aab or .apks file. */
  file: string;
  tested: TestedBuild;
}

/** A build a source offers, for Studio's picker. */
export interface BuildChoice {
  /** What to pass back as `BuildRef.value`. */
  value: string;
  label: string;
  at?: string;
}

/** Parses "firebase:142", "play", "file:C:\\builds\\app.apk" (CLI and MCP). */
export function parseBuildRef(text: string): BuildRef {
  const m = /^(file|firebase|play)(?::(.*))?$/s.exec(text.trim());
  if (!m) throw new Error(`Build: "firebase", "firebase:<build>", "play", "play:<version code>" or "file:<path to .apk/.aab>", not "${text}".`);
  return { source: m[1] as BuildSource, value: m[2]?.trim() || undefined };
}

// ── Google APIs (Firebase App Distribution, Play) ─────────────────────────────

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The signed request a service account trades for an access token. */
export function serviceAccountAssertion(account: ServiceAccount, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const aud = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iss: account.client_email, scope, aud, iat: nowSeconds, exp: nowSeconds + 3000 }))}`;
  return `${unsigned}.${base64url(createSign("RSA-SHA256").update(unsigned).sign(account.private_key))}`;
}

function readServiceAccount(config: ProbeConfig): ServiceAccount {
  const file = config.builds.serviceAccount;
  if (!file) throw new Error("No Google service account key on this machine. Set its JSON file in Studio → Settings → Builds.");
  if (!existsSync(file)) throw new Error(`The Google service account key file ${file} does not exist.`);
  const account = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceAccount>;
  if (!account.client_email || !account.private_key) throw new Error(`${file} is not a service account key (no client_email / private_key).`);
  return account as ServiceAccount;
}

async function accessToken(config: ProbeConfig, scope: string, fetcher: Fetch): Promise<string> {
  const account = readServiceAccount(config);
  const res = await fetcher(account.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(account, scope) }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google did not accept the service account ${account.client_email}: ${body.error_description ?? body.error ?? res.status}.`);
  return body.access_token;
}

async function googleJson<T>(fetcher: Fetch, token: string, url: string, what: string, method = "GET"): Promise<T> {
  const res = await fetcher(url, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      // Not JSON: the first characters are all there is.
    }
    throw new Error(`${what} answered ${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function download(fetcher: Fetch, url: string, file: string, headers: Record<string, string>, what: string): Promise<void> {
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Downloading ${what} answered ${res.status}.`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function buildsDir(project: Project): string {
  const dir = join(project.store.dir, "builds");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Firebase App Distribution ─────────────────────────────────────────────────

interface FirebaseRelease {
  name: string;
  displayVersion?: string;
  buildVersion?: string;
  createTime?: string;
  binaryDownloadUri?: string;
}

const FIREBASE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function firebaseParent(config: ProbeConfig): string {
  const app = config.builds.firebaseApp;
  if (!app) throw new Error("No Firebase app id. Set it in Studio → Settings → Builds (Firebase console → Project settings → Your apps → App ID).");
  const number = /^\d+:(\d+):android:/.exec(app)?.[1];
  if (!number) throw new Error(`"${app}" is not an Android Firebase app id (it looks like 1:1234567890:android:abc123).`);
  return `projects/${number}/apps/${app}`;
}

async function firebaseReleases(config: ProbeConfig, fetcher: Fetch): Promise<FirebaseRelease[]> {
  const token = await accessToken(config, FIREBASE_SCOPE, fetcher);
  const data = await googleJson<{ releases?: FirebaseRelease[] }>(fetcher, token, `https://firebaseappdistribution.googleapis.com/v1/${firebaseParent(config)}/releases?pageSize=50`, "Firebase App Distribution");
  return (data.releases ?? []).sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""));
}

const firebaseLabel = (r: FirebaseRelease) => `${r.displayVersion ?? "?"} (${r.buildVersion ?? "?"})`;

async function resolveFirebase(project: Project, wanted: string | undefined, fetcher: Fetch, log: (line: string) => void): Promise<ResolvedBuild> {
  const releases = await firebaseReleases(project.config, fetcher);
  if (!releases.length) throw new Error("Firebase App Distribution has no releases of this app.");
  const release = wanted ? releases.find((r) => r.buildVersion === wanted || r.displayVersion === wanted) : releases[0];
  if (!release) throw new Error(`Firebase App Distribution has no release ${wanted}. Newest: ${releases.slice(0, 5).map(firebaseLabel).join(", ")}.`);
  if (!release.binaryDownloadUri) throw new Error(`Firebase release ${firebaseLabel(release)} has no download link.`);
  const base = join(buildsDir(project), `firebase-${(release.buildVersion ?? release.name.split("/").pop() ?? "build").replace(/[^\w.-]/g, "_")}`);
  let file = [".apk", ".aab"].map((ext) => base + ext).find(existsSync);
  if (!file) {
    log(`downloading Firebase release ${firebaseLabel(release)}…`);
    const tmp = `${base}.download`;
    // The link is signed for this release: it takes no Authorization header.
    await download(fetcher, release.binaryDownloadUri, tmp, {}, `Firebase release ${firebaseLabel(release)}`);
    const bytes = readFileSync(tmp);
    file = base + (bytes.includes("BundleConfig.pb") ? ".aab" : ".apk");
    writeFileSync(file, bytes);
  }
  return { file, tested: { source: "firebase", label: `Firebase ${firebaseLabel(release)}`, versionCode: release.buildVersion, versionName: release.displayVersion } };
}

// ── Google Play ───────────────────────────────────────────────────────────────

const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PLAY = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

/** The id of the app as Play knows it: the release build's, never one with a debug suffix. */
export function releasePackage(project: Project): string | undefined {
  return project.config.app.releasePackage ?? resolveApp(project).package?.replace(/\.(debug|dev|staging)$/, "");
}

interface PlayRelease {
  name?: string;
  versionCodes?: string[];
  status?: string;
}

/** A track's releases. Play only shows them inside an edit, which is thrown away unchanged. */
async function playReleases(project: Project, pkg: string, token: string, fetcher: Fetch): Promise<PlayRelease[]> {
  const track = project.config.builds.playTrack;
  const edit = await googleJson<{ id: string }>(fetcher, token, `${PLAY}/${pkg}/edits`, "Google Play", "POST");
  try {
    const data = await googleJson<{ releases?: PlayRelease[] }>(fetcher, token, `${PLAY}/${pkg}/edits/${edit.id}/tracks/${encodeURIComponent(track)}`, `Google Play (${track} track)`);
    return data.releases ?? [];
  } finally {
    await fetcher(`${PLAY}/${pkg}/edits/${edit.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

const newestCode = (releases: PlayRelease[]) => releases.flatMap((r) => r.versionCodes ?? []).sort((a, b) => Number(b) - Number(a))[0];

async function resolvePlay(project: Project, wanted: string | undefined, fetcher: Fetch, log: (line: string) => void): Promise<ResolvedBuild> {
  const pkg = releasePackage(project);
  if (!pkg) throw new Error("Probe does not know the app's id on Google Play. Set the release app id in Studio → Settings → Builds.");
  const token = await accessToken(project.config, PLAY_SCOPE, fetcher);
  const track = project.config.builds.playTrack;
  let code = wanted && /^\d+$/.test(wanted) ? wanted : undefined;
  let name: string | undefined;
  if (!code) {
    const releases = await playReleases(project, pkg, token, fetcher);
    const release = wanted ? releases.find((r) => r.name === wanted) : releases.find((r) => (r.versionCodes ?? []).includes(newestCode(releases) ?? ""));
    code = wanted ? newestCode(release ? [release] : []) : newestCode(releases);
    name = release?.name;
    if (!code) throw new Error(wanted ? `The ${track} track of ${pkg} has no release named ${wanted}.` : `The ${track} track of ${pkg} has no release.`);
  }
  const file = join(buildsDir(project), `play-${pkg}-${code}.apk`);
  if (!existsSync(file)) {
    // The copies Play made from the uploaded bundle and signed with the app's own key.
    const generated = await googleJson<{ generatedApks?: { generatedUniversalApk?: { downloadId?: string } }[] }>(fetcher, token, `${PLAY}/${pkg}/generatedApks/${code}`, "Google Play");
    const id = generated.generatedApks?.map((g) => g.generatedUniversalApk?.downloadId).find(Boolean);
    if (!id) throw new Error(`Google Play has no installable copy of ${pkg} ${code}: the version must be uploaded as an app bundle and signed by Play.`);
    log(`downloading ${pkg} ${code} from Google Play…`);
    await download(fetcher, `${PLAY}/${pkg}/generatedApks/${code}/downloads/${encodeURIComponent(id)}:download?alt=media`, file, { authorization: `Bearer ${token}` }, `${pkg} ${code}`);
  }
  return { file, tested: { source: "play", label: `Google Play ${track}${name ? ` ${name}` : ""} (${code})`, versionCode: code, versionName: name, package: pkg } };
}

// ── A file on this machine ────────────────────────────────────────────────────

function resolveFile(project: Project, value: string | undefined): ResolvedBuild {
  if (!value) throw new Error("Give the path of the .apk or .aab to test.");
  const file = isAbsolute(value) ? value : resolve(project.root, value);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`No build file at ${file}.`);
  if (![".apk", ".aab", ".apks"].includes(extname(file).toLowerCase())) throw new Error(`${file} is not an .apk, .aab or .apks file.`);
  return { file, tested: { source: "file", label: file.split(/[\\/]/).pop()! } };
}

/** Finds the build a run asked for and brings it to this machine. */
export async function resolveBuild(project: Project, ref: BuildRef, log: (line: string) => void, fetcher: Fetch = fetch): Promise<ResolvedBuild> {
  const build = ref.source === "file" ? resolveFile(project, ref.value) : ref.source === "firebase" ? await resolveFirebase(project, ref.value, fetcher, log) : await resolvePlay(project, ref.value, fetcher, log);
  const info = extname(build.file).toLowerCase() === ".apk" ? apkInfo(project.root, build.file) : null;
  build.tested = { ...build.tested, package: info?.package ?? build.tested.package, versionCode: info?.versionCode ?? build.tested.versionCode, versionName: info?.versionName ?? build.tested.versionName };
  if (ref.source === "file" && info?.versionName) build.tested.label += ` · ${info.versionName} (${info.versionCode})`;
  return build;
}

/** The builds a source has, newest first, for Studio's picker. */
export async function listBuilds(project: Project, source: BuildSource, fetcher: Fetch = fetch): Promise<BuildChoice[]> {
  if (source === "firebase") {
    return (await firebaseReleases(project.config, fetcher)).map((r) => ({ value: r.buildVersion ?? r.displayVersion ?? "", label: firebaseLabel(r), at: r.createTime })).filter((b) => b.value);
  }
  if (source === "play") {
    const pkg = releasePackage(project);
    if (!pkg) throw new Error("Probe does not know the app's id on Google Play. Set the release app id in Studio → Settings → Builds.");
    const releases = await playReleases(project, pkg, await accessToken(project.config, PLAY_SCOPE, fetcher), fetcher);
    return releases
      .flatMap((r) => (r.versionCodes ?? []).map((code) => ({ value: code, label: `${r.name ?? "release"} (${code})${r.status && r.status !== "completed" ? ` · ${r.status}` : ""}` })))
      .sort((a, b) => Number(b.value) - Number(a.value));
  }
  return [];
}

// ── Installing ────────────────────────────────────────────────────────────────

/** The newest aapt2 in the Android SDK, which reads an APK's id and version. */
function aapt2(projectRoot: string): string | null {
  const sdk = androidSdk(projectRoot);
  const tools = sdk ? join(sdk, "build-tools") : null;
  if (!tools || !existsSync(tools)) return null;
  const versions = readdirSync(tools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const exe = join(tools, v, isWindows ? "aapt2.exe" : "aapt2");
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** An APK's application id and version, or null when the SDK has no aapt2. */
export function apkInfo(projectRoot: string, file: string): { package: string; versionCode?: string; versionName?: string } | null {
  const tool = aapt2(projectRoot);
  if (!tool) return null;
  const r = spawnSync(tool, ["dump", "badging", file], { encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return parseBadging(r.stdout ?? "");
}

export function parseBadging(out: string): { package: string; versionCode?: string; versionName?: string } | null {
  const line = /^package:.*$/m.exec(out)?.[0];
  const pkg = line && /\bname='([^']+)'/.exec(line)?.[1];
  if (!line || !pkg) return null;
  return { package: pkg, versionCode: /versionCode='([^']*)'/.exec(line)?.[1] || undefined, versionName: /versionName='([^']*)'/.exec(line)?.[1] || undefined };
}

function bundletool(project: Project, args: string[], timeoutMs: number): { ok: boolean; out: string } {
  const jar = project.config.builds.bundletool;
  if (!jar) throw new Error("Installing an .aab needs bundletool. Download bundletool-all.jar from github.com/google/bundletool/releases and set its path in Studio → Settings → Builds, or test the .apk instead.");
  if (!existsSync(jar)) throw new Error(`bundletool is not at ${jar}.`);
  const r = spawnSync("java", ["-jar", jar, ...args], { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`bundletool needs Java on the PATH: ${r.error.message}`);
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Whether the device already runs this build, as far as it can tell: same app, same version code. */
export function alreadyInstalled(device: AndroidDevice, build: ResolvedBuild): boolean {
  const t = build.tested;
  return !!t.package && !!t.versionCode && device.isInstalled(t.package) && device.versionCode(t.package) === t.versionCode;
}

/**
 * Installs the build and returns the app's id. A copy signed with another key (a debug build
 * of the same app) cannot be updated in place: it is removed first, and its data with it.
 */
export function installBuild(project: Project, device: AndroidDevice, build: ResolvedBuild, log: (line: string) => void): string {
  const before = build.tested.package ? null : new Set(device.packages());
  const ext = extname(build.file).toLowerCase();
  log(`installing ${build.tested.label}…`);
  if (ext === ".apk") {
    let result = device.install(build.file);
    const conflict = /INSTALL_FAILED_(UPDATE_INCOMPATIBLE|VERSION_DOWNGRADE)/.exec(result.out)?.[0];
    const pkg = build.tested.package ?? /Package ([\w.]+) signatures do not match/.exec(result.out)?.[1];
    if (!result.ok && conflict && pkg) {
      log(`${pkg} on the device is another copy (${conflict.replace("INSTALL_FAILED_", "").toLowerCase().replace(/_/g, " ")}): removing it and its data, then installing the build`);
      device.uninstall(pkg);
      result = device.install(build.file);
    }
    if (!result.ok) throw new Error(`Installing ${build.tested.label} failed: ${result.out.split("\n").filter(Boolean).pop() ?? "adb install failed"}`);
  } else {
    throwIfStopped();
    let apks = build.file;
    if (ext === ".aab") {
      apks = join(buildsDir(project), "bundle.apks");
      const built = bundletool(project, ["build-apks", `--bundle=${build.file}`, `--output=${apks}`, "--overwrite", "--connected-device", `--device-id=${device.serial}`, `--adb=${device.adb.bin}`], 10 * 60_000);
      if (!built.ok) throw new Error(`bundletool could not build APKs from ${build.tested.label}: ${built.out.split("\n").pop()}`);
    }
    const installed = bundletool(project, ["install-apks", `--apks=${apks}`, `--device-id=${device.serial}`, `--adb=${device.adb.bin}`], 10 * 60_000);
    if (!installed.ok) throw new Error(`Installing ${build.tested.label} failed: ${installed.out.split("\n").pop()}`);
  }
  if (build.tested.package) return build.tested.package;
  const added = device.packages().filter((p) => !before!.has(p));
  const pkg = added.length === 1 ? added[0] : releasePackage(project);
  if (!pkg || !device.isInstalled(pkg)) throw new Error("The build installed, but Probe cannot tell its app id. Set the release app id in Studio → Settings → Builds.");
  return pkg;
}
