import { existsSync } from "node:fs";
import { Secrets } from "../accounts/accounts.js";
import { loadConfig, saveLocal, saveProject, TRACKERS, type TrackerId } from "../core/config.js";
import type { BuildSource, RunTarget } from "../core/types.js";
import { releasePackage } from "../devices/builds.js";
import { runTargets } from "../devices/driver.js";
import { playwrightStatus, webUrl } from "../devices/web.js";
import type { Project } from "../engine/project.js";
import { clearInbox } from "../tickets/inbox.js";
import { JIRA_DEFAULT_FILTER, openTracker, tokenKey, TRACKER_LABEL, trackerMissing } from "../tickets/tracker.js";

// What Studio needs for a tester's work: the tracker connection, and what a test can run
// against (the working tree, a finished build, the deployed web app).

/** The tracker connection as Settings shows it. The token never leaves this machine or comes back out. */
export function trackerSettings(project: Project) {
  const t = project.config.tickets;
  const hasToken = !!t.tracker && new Secrets(project.store.dir).hasKey(tokenKey(t.tracker));
  return {
    tracker: t.tracker ?? null,
    site: t.site ?? null,
    email: t.email ?? null,
    filter: t.filter ?? null,
    team: t.team ?? null,
    buildField: t.buildField ?? null,
    hasToken,
    /** What is still needed before the inbox can load; null when connected. */
    missing: trackerMissing(t, hasToken),
    defaultFilter: JIRA_DEFAULT_FILTER,
    trackers: TRACKERS.map((id) => ({ id, label: TRACKER_LABEL[id] })),
  };
}

export interface TrackerBody {
  tracker?: string | null;
  site?: string | null;
  email?: string | null;
  filter?: string | null;
  team?: string | null;
  buildField?: string | null;
  /** Stored sealed on this machine; an empty value keeps the one already there. */
  token?: string;
}

/**
 * Saves the connection: what the team shares (which tracker, the site, the filter) to
 * probe/probe.yaml, the email to this machine's settings, the token to this machine's secrets.
 * Returns an error message or null.
 */
export function saveTracker(project: Project, body: TrackerBody): string | null {
  const tracker = body.tracker?.trim() || null;
  if (tracker && !TRACKERS.includes(tracker as TrackerId)) return `Tracker: one of ${TRACKERS.join(", ")}`;
  let site = body.site?.trim().replace(/\/+$/, "") || null;
  if (tracker === "jira") {
    if (!site) return "Jira needs the site address, e.g. https://acme.atlassian.net";
    if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
    try {
      // The token is sent there, so it has to be a plain site address and nothing else.
      const url = new URL(site);
      if (url.username || url.password || url.search || url.hash) return "Site: only the address, e.g. https://acme.atlassian.net";
      site = url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      return "Site: a web address, e.g. https://acme.atlassian.net";
    }
  }
  const email = body.email?.trim() || undefined;
  if (email && !/^\S+@\S+$/.test(email)) return "Email: the address of the Jira account the token belongs to";

  saveProject(project.root, {
    tickets: {
      tracker: tracker as TrackerId | null,
      site: tracker === "jira" ? site : null,
      filter: body.filter?.trim() || null,
      team: tracker === "linear" ? body.team?.trim() || null : null,
      buildField: tracker === "jira" ? body.buildField?.trim() || null : null,
      // A link for ticket ids elsewhere in Studio, when nobody set one.
      ...(tracker === "jira" && site && !project.config.tickets.url ? { url: `${site}/browse/{id}` } : {}),
    },
  });
  saveLocal(project.store.dir, { tickets: tracker === "jira" && email ? { email } : undefined });
  if (tracker && body.token?.trim()) new Secrets(project.store.dir).setKey(tokenKey(tracker as TrackerId), body.token.trim());
  project.config = loadConfig(project.root, project.store.dir);
  clearInbox(project);
  return null;
}

/** Forgets this machine's token for the project's tracker. */
export function disconnectTracker(project: Project): void {
  const tracker = project.config.tickets.tracker;
  if (tracker) new Secrets(project.store.dir).removeKey(tokenKey(tracker));
  clearInbox(project);
}

/** Asks the tracker who the token belongs to. */
export async function testTracker(project: Project): Promise<{ ok: boolean; message: string }> {
  try {
    return { ok: true, message: await openTracker(project).me() };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Builds and web settings as Studio shows them. */
export function buildSettings(project: Project) {
  const c = project.config;
  return {
    releasePackage: c.app.releasePackage ?? null,
    /** What Probe would use when none is set. */
    releasePackageFound: releasePackage(project) ?? null,
    firebaseApp: c.builds.firebaseApp ?? null,
    playTrack: c.builds.playTrack,
    tag: c.builds.tag ?? null,
    serviceAccount: c.builds.serviceAccount ?? null,
    bundletool: c.builds.bundletool ?? null,
    webUrl: c.web.url ?? null,
    android: project.adapter.supportsDevices,
    playwright: playwrightStatus(project.root),
  };
}

export interface BuildSettingsBody {
  releasePackage?: string | null;
  firebaseApp?: string | null;
  playTrack?: string | null;
  tag?: string | null;
  serviceAccount?: string | null;
  bundletool?: string | null;
  webUrl?: string | null;
}

const PACKAGE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;

/** Validates and saves; key file and bundletool paths go to this machine, the rest to probe/probe.yaml. */
export function saveBuildSettings(project: Project, body: BuildSettingsBody): string | null {
  const clean = (v: string | null | undefined) => v?.trim() || null;
  const pkg = clean(body.releasePackage);
  if (pkg && !PACKAGE.test(pkg)) return "Release app id: an application id such as com.example.app";
  const firebase = clean(body.firebaseApp);
  if (firebase && !/^\d+:\d+:android:[0-9a-f]+$/i.test(firebase)) return "Firebase app id: it looks like 1:1234567890:android:abc123 (Firebase console → Project settings → Your apps)";
  const track = clean(body.playTrack);
  if (track && !/^[\w:.-]+$/.test(track)) return "Play track: internal, alpha, beta, production or a custom track's name";
  const tag = clean(body.tag);
  if (tag && !tag.includes("{build}")) return "Build tag: a tag name with {build} in it, e.g. v{build}";
  const key = clean(body.serviceAccount);
  if (key && !existsSync(key)) return `Service account key: no file at ${key}`;
  const jar = clean(body.bundletool);
  if (jar && !existsSync(jar)) return `bundletool: no file at ${jar}`;
  let web = clean(body.webUrl);
  if (web) {
    try {
      // A bare host gets a scheme: http for this machine, https for anything else.
      web = webUrl(/^[a-z][\w+.-]*:\/\//i.test(web) ? web : `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(web) ? "http" : "https"}://${web}`);
    } catch (e) {
      return `Web app address: ${(e as Error).message}`;
    }
  }
  saveProject(project.root, { app: { releasePackage: pkg }, builds: { firebaseApp: firebase, playTrack: track === "internal" ? null : track, tag }, web: { url: web } });
  saveLocal(project.store.dir, { builds: key || jar ? { serviceAccount: key ?? undefined, bundletool: jar ?? undefined } : undefined });
  project.config = loadConfig(project.root, project.store.dir);
  return null;
}

export interface TestOption {
  /** What a run is asked for: `android`, `web`, or `android:<source>` for a finished build. */
  id: string;
  label: string;
  target: RunTarget;
  source?: BuildSource;
  /** Why it cannot be chosen yet; absent when it can. */
  missing?: string;
}

/** What a test can run against in this project, each with what is still missing to use it. */
export function testOptions(project: Project): TestOption[] {
  const c = project.config;
  const out: TestOption[] = [];
  const targets = runTargets(project);
  if (targets.includes("android")) {
    const key = c.builds.serviceAccount ? undefined : "set the Google service account key file in Settings → Builds and web";
    out.push(
      { id: "android", label: "Android · this code (builds and installs it)", target: "android" },
      { id: "android:firebase", label: "Android · Firebase App Distribution build", target: "android", source: "firebase", missing: c.builds.firebaseApp ? key : "set the Firebase app id in Settings → Builds and web" },
      { id: "android:play", label: `Android · Google Play build (${c.builds.playTrack})`, target: "android", source: "play", missing: releasePackage(project) ? key : "set the release app id in Settings → Builds and web" },
      { id: "android:file", label: "Android · a build file (.apk / .aab)", target: "android", source: "file" },
    );
  }
  if (targets.includes("web")) out.push({ id: "web", label: `Web · ${c.web.url}`, target: "web" });
  return out;
}
