import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { Secrets } from "../src/accounts/accounts.js";
import { newRunId } from "../src/core/store.js";
import type { CardRun, VerifyRun } from "../src/core/types.js";
import { listBuilds, parseBadging, parseBuildRef, resolveBuild, serviceAccountAssertion } from "../src/devices/builds.js";
import { pickTarget, runTargets } from "../src/devices/driver.js";
import { webUrl } from "../src/devices/web.js";
import { openProject, type Project } from "../src/engine/project.js";
import { buildSettings, saveBuildSettings, saveTracker, testOptions, trackerSettings } from "../src/studio/qa.js";
import { buildState, buildTags, inbox, postResult, resultComment } from "../src/tickets/inbox.js";
import { buildInText, Jira, Linear, openTracker, tokenKey, type Fetch } from "../src/tickets/tracker.js";

// The store lives under the home folder: point it at a scratch one.
const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

function fixture(files: Record<string, string> = {}): Project {
  const root = mkdtempSync(join(tmpdir(), "probe-qa-"));
  for (const [path, text] of Object.entries({ "probe/probe.yaml": "name: shop\n", ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return openProject(root);
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers from a table of `METHOD url-substring` → response, and records every call. */
function fakeFetch(routes: [string, (call: Call) => { status?: number; json?: unknown; bytes?: Buffer }][]): { fetcher: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A form body stays text.
    }
    const call: Call = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    const route = routes.find(([key]) => {
      const [method, part] = key.split(" ");
      return method === call.method && url.includes(part!);
    });
    if (!route) return new Response(JSON.stringify({ message: `no route for ${call.method} ${url}` }), { status: 404 });
    const answer = route[1](call);
    const status = answer.status ?? 200;
    return new Response(status === 204 ? null : answer.bytes ? new Uint8Array(answer.bytes) : JSON.stringify(answer.json ?? {}), { status });
  };
  return { fetcher, calls };
}

const jiraIssue = (key: string, fields: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: "Checkout button stays disabled", description: "Steps…\nBuild: 142", status: { name: "Ready for QA" }, reporter: { displayName: "Sara" }, assignee: null, updated: "2026-11-01T10:00:00.000+0000", labels: ["checkout"], fixVersions: [{ name: "1.4.0" }], ...fields },
});

describe("ticket text", () => {
  test("a build number is read from the usual ways of writing it", () => {
    assert.equal(buildInText("Please test.\nBuild: 142"), "142");
    assert.equal(buildInText("fixed in build #1.4.2."), "1.4.2");
    assert.equal(buildInText("Build number 88, staging"), "88");
    assert.equal(buildInText("We should build a new page"), undefined);
    assert.equal(buildInText("rebuild 3 times"), undefined);
  });
});

describe("Jira", () => {
  const config = { pattern: "x", tracker: "jira" as const, site: "https://acme.atlassian.net/", email: "me@acme.com", filter: 'status = "Ready for QA"' };

  test("lists tickets with basic auth, the filter as JQL, and the build from the text", async () => {
    const { fetcher, calls } = fakeFetch([["POST /rest/api/2/search/jql", () => ({ json: { issues: [jiraIssue("SHOP-7")] } })]]);
    const tickets = await new Jira(config, "tok", fetcher).list();
    assert.equal(calls[0]!.url, "https://acme.atlassian.net/rest/api/2/search/jql");
    assert.equal(calls[0]!.headers.authorization, `Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`);
    assert.equal((calls[0]!.body as { jql: string }).jql, 'status = "Ready for QA"');
    assert.deepEqual(
      tickets.map((t) => [t.id, t.title, t.status, t.author, t.build, t.url]),
      [["SHOP-7", "Checkout button stays disabled", "Ready for QA", "Sara", "142", "https://acme.atlassian.net/browse/SHOP-7"]],
    );
  });

  test("falls back to the old search on a server without the new one, and to the fix version without a build in the text", async () => {
    const { fetcher, calls } = fakeFetch([
      ["POST /rest/api/2/search/jql", () => ({ status: 404 })],
      ["POST /rest/api/2/search", () => ({ json: { issues: [jiraIssue("SHOP-8", { description: "no number here" })] } })],
    ]);
    const tickets = await new Jira({ ...config, email: undefined }, "pat", fetcher).list();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.headers.authorization, "Bearer pat");
    assert.equal(tickets[0]!.build, "1.4.0");
  });

  test("a build field named in settings is found by name and wins", async () => {
    const { fetcher, calls } = fakeFetch([
      ["GET /rest/api/2/field", () => ({ json: [{ id: "customfield_10050", name: "QA Build" }] })],
      ["GET /rest/api/2/issue/SHOP-9", () => ({ json: jiraIssue("SHOP-9", { customfield_10050: { value: "150" } }) })],
    ]);
    const ticket = await new Jira({ ...config, buildField: "qa build" }, "tok", fetcher).get("SHOP-9");
    assert.equal(ticket.build, "150");
    assert.ok(calls[1]!.url.includes("customfield_10050"));
  });

  test("a refused token says so in Jira's own words", async () => {
    const { fetcher } = fakeFetch([["GET /rest/api/2/myself", () => ({ status: 401, json: { errorMessages: ["Client must be authenticated"] } })]]);
    await assert.rejects(new Jira(config, "bad", fetcher).me(), /401: Client must be authenticated.*Check the token/);
  });

  test("a comment is posted as plain text", async () => {
    const { fetcher, calls } = fakeFetch([["POST /rest/api/2/issue/SHOP-7/comment", () => ({ status: 201, json: { id: "1" } })]]);
    await new Jira(config, "tok", fetcher).comment("SHOP-7", "*Probe test: PASSED*");
    assert.deepEqual(calls[0]!.body, { body: "*Probe test: PASSED*" });
  });
});

describe("Linear", () => {
  const issue = { id: "uuid-1", identifier: "ENG-12", title: "Profile photo upload", description: "Works on build 77", url: "https://linear.app/acme/issue/ENG-12", updatedAt: "2026-11-02T09:00:00.000Z", state: { name: "In Review" }, creator: { name: "Ali" }, assignee: null, labels: { nodes: [{ name: "build:81" }] } };

  test("lists tickets by status name and team, the key as the Authorization header", async () => {
    const { fetcher, calls } = fakeFetch([["POST api.linear.app/graphql", () => ({ json: { data: { issues: { nodes: [issue] } } } })]]);
    const tickets = await new Linear({ pattern: "x", tracker: "linear", filter: "In Review, Ready for QA", team: "ENG" }, "lin_key", fetcher).list();
    assert.equal(calls[0]!.headers.authorization, "lin_key");
    const sent = calls[0]!.body as { variables: { filter: unknown } };
    assert.deepEqual(sent.variables.filter, { state: { name: { in: ["In Review", "Ready for QA"] } }, team: { key: { eq: "ENG" } } });
    // A build label wins over a number in the text.
    assert.deepEqual([tickets[0]!.id, tickets[0]!.status, tickets[0]!.author, tickets[0]!.build], ["ENG-12", "In Review", "Ali", "81"]);
  });

  test("without a filter it lists what is started or to do", async () => {
    const { fetcher, calls } = fakeFetch([["POST api.linear.app/graphql", () => ({ json: { data: { issues: { nodes: [] } } } })]]);
    await new Linear({ pattern: "x", tracker: "linear" }, "k", fetcher).list();
    assert.deepEqual((calls[0]!.body as { variables: { filter: unknown } }).variables.filter, { state: { type: { in: ["started", "unstarted"] } } });
  });

  test("a comment goes to the ticket's own id, and GraphQL errors surface", async () => {
    const { fetcher, calls } = fakeFetch([
      ["POST api.linear.app/graphql", (call) => (String((call.body as { query: string }).query).includes("commentCreate") ? { json: { data: { commentCreate: { success: true } } } } : { json: { data: { issue } } })],
    ]);
    await new Linear({ pattern: "x", tracker: "linear" }, "k", fetcher).comment("ENG-12", "**ok**");
    assert.deepEqual((calls[1]!.body as { variables: unknown }).variables, { issueId: "uuid-1", body: "**ok**" });
    const failing = fakeFetch([["POST api.linear.app/graphql", () => ({ json: { errors: [{ message: "Authentication required" }] } })]]);
    await assert.rejects(new Linear({ pattern: "x", tracker: "linear" }, "k", failing.fetcher).me(), /Linear: Authentication required/);
  });
});

describe("tracker connection", () => {
  test("saving validates, splits shared and machine settings, and seals the token", () => {
    const project = fixture();
    assert.equal(trackerSettings(project).missing, "No ticket tracker chosen.");
    assert.match(saveTracker(project, { tracker: "trello" })!, /one of jira, linear/);
    assert.match(saveTracker(project, { tracker: "jira" })!, /site address/);
    assert.match(saveTracker(project, { tracker: "jira", site: "https://user:pw@acme.atlassian.net" })!, /only the address/);

    assert.equal(saveTracker(project, { tracker: "jira", site: "acme.atlassian.net/", email: "me@acme.com", filter: "project = SHOP", token: "s3cret" }), null);
    const yaml = readFileSync(join(project.root, "probe", "probe.yaml"), "utf8");
    assert.match(yaml, /tracker: jira/);
    assert.match(yaml, /site: https:\/\/acme\.atlassian\.net/);
    assert.match(yaml, /url: https:\/\/acme\.atlassian\.net\/browse\/\{id\}/);
    // Neither the email nor the token is in the file the team shares.
    assert.ok(!yaml.includes("me@acme.com") && !yaml.includes("s3cret"));
    assert.ok(!readFileSync(join(project.store.dir, "secrets.json"), "utf8").includes("s3cret") || process.platform !== "win32");

    const settings = trackerSettings(project);
    assert.deepEqual([settings.tracker, settings.site, settings.email, settings.filter, settings.hasToken, settings.missing], ["jira", "https://acme.atlassian.net", "me@acme.com", "project = SHOP", true, null]);
    assert.equal(new Secrets(project.store.dir).getKey(tokenKey("jira")), "s3cret");
    assert.equal(openTracker(project).id, "jira");
  });

  test("without a token the tracker cannot be opened, and says where to connect", () => {
    const project = fixture({ "probe/probe.yaml": "tickets:\n  tracker: linear\n" });
    assert.throws(() => openTracker(project), /No Linear API token on this machine.*Settings/);
  });
});

function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A repository with one commit for SHOP-7 inside tag v142 and one for SHOP-8 after it. */
function repoWithBuilds(): Project {
  const project = fixture({ "probe/probe.yaml": "tickets:\n  tracker: jira\n  site: https://jira.example.com\n", "src/checkout/pay.ts": "export const a = 1;\n" });
  git(project.root, "init", "-q");
  git(project.root, "config", "user.email", "t@example.com");
  git(project.root, "config", "user.name", "Tester");
  git(project.root, "add", ".");
  git(project.root, "commit", "-q", "-m", "SHOP-7 fix the checkout button");
  git(project.root, "tag", "v142");
  writeFileSync(join(project.root, "src/checkout/pay.ts"), "export const a = 2;\n");
  git(project.root, "commit", "-q", "-am", "SHOP-8 round the total");
  return project;
}

describe("builds and commits", () => {
  test("the tag of a build follows the configured pattern, else the usual spellings", () => {
    assert.deepEqual(buildTags("release/{build}", "142"), ["release/142"]);
    assert.deepEqual(buildTags(undefined, "142"), ["142", "v142", "build-142", "release-142"]);
  });

  test("a build contains a ticket's commits, misses them, or cannot be told", () => {
    const project = repoWithBuilds();
    const [second, first] = git(project.root, "log", "--format=%h").split("\n");
    assert.deepEqual(buildState(project, "142", [first!]), { state: "included", tag: "v142" });
    assert.deepEqual(buildState(project, "142", [first!, second!]), { state: "missing", tag: "v142" });
    assert.deepEqual(buildState(project, "999", [first!]), { state: "unknown", tag: undefined });
    assert.deepEqual(buildState(project, "142", []), { state: "unknown", tag: "v142" });
    // A build number from a ticket is never handed to a shell or read as an option.
    assert.equal(buildState(project, "--exec=x; rm -rf", [first!]).state, "unknown");
  });

  test("the inbox joins the tracker's tickets with the repository", async () => {
    const project = repoWithBuilds();
    new Secrets(project.store.dir).setKey(tokenKey("jira"), "tok");
    const { fetcher } = fakeFetch([
      ["POST /rest/api/2/search/jql", () => ({ json: { issues: [jiraIssue("SHOP-7"), jiraIssue("SHOP-8", { description: "Build: 142" }), jiraIssue("SHOP-9", { description: "new idea", fixVersions: [] })] } })],
    ]);
    const tickets = await inbox(project, { refresh: true, fetcher });
    assert.deepEqual(
      tickets.map((t) => [t.id, t.commits, t.build, t.buildState]),
      [
        ["SHOP-7", 1, "142", "included"],
        ["SHOP-8", 1, "142", "missing"],
        ["SHOP-9", 0, undefined, undefined],
      ],
    );
  });
});

describe("posting a result", () => {
  const verify = (project: Project): VerifyRun => ({
    id: newRunId(),
    kind: "verify",
    feature: "*",
    base: "ticket SHOP-7",
    ticket: "SHOP-7",
    startedAt: new Date().toISOString(),
    status: "failed",
    changed: [],
    unowned: [],
    device: true,
    costUsd: 0.4,
    build: { source: "firebase", label: "Firebase 1.4.2 (142)", versionCode: "142" },
    features: [{ feature: "checkout", files: [], cards: [{ cardId: "pay-button", runId: "r1", status: "passed" }, { cardId: "total-rounding", runId: "r2", status: "failed", note: "Total showed 9.999\nmore" }, { cardId: "—", status: "skipped", note: "no cards" }] }],
    git: { branch: "main", commit: "abc1234", dirty: 0 },
    ...({} as object),
    ...(project ? {} : {}),
  });

  test("the comment says the verdict, the build and each card, in the tracker's own bold", () => {
    const project = fixture();
    const body = resultComment(project, { bold: (t) => `*${t}*` }, verify(project));
    assert.match(body, /^\*Probe test: FAILED\*\nBuild: Firebase 1\.4\.2 \(142\)\n/);
    assert.match(body, /- ✓ pay-button \(passed\)\n- ✗ total-rounding \(failed\): Total showed 9\.999\n/);
    assert.ok(!body.includes("no cards"));
  });

  test("a card run lists its expectations; a run still going is refused", () => {
    const project = fixture();
    const card: CardRun = { id: newRunId(), kind: "card", feature: "checkout", cardId: "pay-button", device: "Chromium", target: "web", startedAt: "", status: "failed", crashes: [], timeline: [], costUsd: 0, verdict: { result: "failed", notes: "Button stayed grey", expectations: [{ text: "Pay is enabled", met: false, evidence: "disabled after filling the form" }] } };
    const body = resultComment(project, { bold: (t) => `**${t}**` }, card);
    assert.match(body, /\*\*Probe test: FAILED\*\*\nWeb app · On: Chromium/);
    assert.match(body, /✗ Pay is enabled — disabled after filling the form/);
    assert.throws(() => resultComment(project, { bold: (t) => t }, { ...card, status: "running" }), /still going/);
  });

  test("posting sends that comment to the ticket", async () => {
    const project = fixture({ "probe/probe.yaml": "tickets:\n  tracker: jira\n  site: https://jira.example.com\n" });
    new Secrets(project.store.dir).setKey(tokenKey("jira"), "tok");
    const { fetcher, calls } = fakeFetch([["POST /rest/api/2/issue/SHOP-7/comment", () => ({ status: 201, json: {} })]]);
    const posted = await postResult(project, "SHOP-7", verify(project), fetcher);
    assert.equal((calls[0]!.body as { body: string }).body, posted);
  });
});

describe("finished builds", () => {
  test("a build is named as source and value", () => {
    assert.deepEqual(parseBuildRef("firebase:142"), { source: "firebase", value: "142" });
    assert.deepEqual(parseBuildRef("play"), { source: "play", value: undefined });
    assert.deepEqual(parseBuildRef("file:C:\\builds\\app.apk"), { source: "file", value: "C:\\builds\\app.apk" });
    assert.throws(() => parseBuildRef("testflight:9"), /firebase/);
  });

  test("an APK's id and version are read from aapt2's output", () => {
    assert.deepEqual(parseBadging("package: name='com.shop.app' versionCode='142' versionName='1.4.2' platformBuildVersionName='14'\nsdkVersion:'24'"), { package: "com.shop.app", versionCode: "142", versionName: "1.4.2" });
    assert.equal(parseBadging("ERROR: not an apk"), null);
  });

  test("a service account's request is a JWT signed with its key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = serviceAccountAssertion({ client_email: "probe@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, "scope-a", 1_000);
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), { iss: "probe@x.iam.gserviceaccount.com", scope: "scope-a", aud: "https://oauth2.googleapis.com/token", iat: 1_000, exp: 4_000 });
    assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url")));
  });

  /** A project set up for Firebase and Play, with a real key file so the token request can be signed. */
  function withGoogle(): Project {
    const project = fixture({ "probe/probe.yaml": "app:\n  releasePackage: com.shop.app\nbuilds:\n  firebaseApp: \"1:555:android:abc123\"\n" });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = join(project.store.dir, "sa.json");
    writeFileSync(key, JSON.stringify({ client_email: "probe@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }));
    assert.equal(saveBuildSettings(project, { releasePackage: "com.shop.app", firebaseApp: "1:555:android:abc123", serviceAccount: key }), null);
    return project;
  }

  const token: [string, () => { json: unknown }] = ["POST oauth2.googleapis.com/token", () => ({ json: { access_token: "ya29.x" } })];
  const releases = { releases: [{ name: "projects/555/apps/a/releases/r1", displayVersion: "1.4.1", buildVersion: "141", createTime: "2026-10-01T00:00:00Z", binaryDownloadUri: "https://dl.example/141" }, { name: "projects/555/apps/a/releases/r2", displayVersion: "1.4.2", buildVersion: "142", createTime: "2026-11-01T00:00:00Z", binaryDownloadUri: "https://dl.example/142" }] };

  test("Firebase: the newest release, or the one asked for, is downloaded once", async () => {
    const project = withGoogle();
    const { fetcher, calls } = fakeFetch([token, ["GET firebaseappdistribution.googleapis.com/v1/projects/555/apps/1:555:android:abc123/releases", () => ({ json: releases })], ["GET dl.example/", () => ({ bytes: Buffer.from("PK apk bytes") })]]);
    assert.deepEqual((await listBuilds(project, "firebase", fetcher)).map((b) => b.label), ["1.4.2 (142)", "1.4.1 (141)"]);

    const newest = await resolveBuild(project, { source: "firebase" }, () => undefined, fetcher);
    assert.equal(newest.tested.label, "Firebase 1.4.2 (142)");
    assert.equal(newest.tested.versionCode, "142");
    assert.ok(newest.file.endsWith("firebase-142.apk") && existsSync(newest.file));
    assert.equal(calls.find((c) => c.url.includes("/releases"))!.headers.authorization, "Bearer ya29.x");
    // The download link is signed: the token is not sent to it.
    assert.equal(calls.find((c) => c.url.includes("dl.example"))!.headers.authorization, undefined);

    const downloads = () => calls.filter((c) => c.url.includes("dl.example")).length;
    const before = downloads();
    await resolveBuild(project, { source: "firebase", value: "142" }, () => undefined, fetcher);
    assert.equal(downloads(), before);
    const older = await resolveBuild(project, { source: "firebase", value: "1.4.1" }, () => undefined, fetcher);
    assert.ok(older.file.endsWith("firebase-141.apk"));
    await assert.rejects(resolveBuild(project, { source: "firebase", value: "999" }, () => undefined, fetcher), /no release 999\. Newest: 1\.4\.2 \(142\)/);
  });

  test("Firebase: an app bundle is kept as an .aab", async () => {
    const project = withGoogle();
    const { fetcher } = fakeFetch([token, ["GET firebaseappdistribution", () => ({ json: releases })], ["GET dl.example/", () => ({ bytes: Buffer.from("PK…BundleConfig.pb…") })]]);
    assert.ok((await resolveBuild(project, { source: "firebase" }, () => undefined, fetcher)).file.endsWith("firebase-142.aab"));
  });

  test("Play: the newest version on the track is found in a throwaway edit and its signed copy downloaded", async () => {
    const project = withGoogle();
    const { fetcher, calls } = fakeFetch([
      token,
      ["POST /applications/com.shop.app/edits", () => ({ json: { id: "e1" } })],
      ["GET /edits/e1/tracks/internal", () => ({ json: { releases: [{ name: "1.4.2", versionCodes: ["142"], status: "completed" }, { name: "1.4.1", versionCodes: ["141"] }] } })],
      ["DELETE /edits/e1", () => ({ status: 204 })],
      ["GET /generatedApks/142/downloads/dl-9:download", () => ({ bytes: Buffer.from("PK play apk") })],
      ["GET /generatedApks/142", () => ({ json: { generatedApks: [{ generatedUniversalApk: { downloadId: "dl-9" } }] } })],
    ]);
    const build = await resolveBuild(project, { source: "play" }, () => undefined, fetcher);
    assert.equal(build.tested.label, "Google Play internal 1.4.2 (142)");
    assert.equal(build.tested.package, "com.shop.app");
    assert.equal(readFileSync(build.file, "utf8"), "PK play apk");
    assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/edits/e1")), "the edit is thrown away");
    assert.deepEqual((await listBuilds(project, "play", fetcher)).map((b) => b.value), ["142", "141"]);
  });

  test("Play: a version with no signed copy says why", async () => {
    const project = withGoogle();
    const { fetcher } = fakeFetch([token, ["GET /generatedApks/77", () => ({ json: {} })]]);
    await assert.rejects(resolveBuild(project, { source: "play", value: "77" }, () => undefined, fetcher), /no installable copy of com\.shop\.app 77/);
  });

  test("a build file must exist and be an APK or bundle; without a key, Google sources say where to set it", async () => {
    const project = fixture({ "builds/notes.txt": "x" });
    await assert.rejects(resolveBuild(project, { source: "file", value: "builds/app.apk" }, () => undefined), /No build file at/);
    await assert.rejects(resolveBuild(project, { source: "file", value: "builds/notes.txt" }, () => undefined), /not an \.apk/);
    await assert.rejects(resolveBuild(project, { source: "play", value: "5" }, () => undefined), /release app id/);
    const firebase = fixture({ "probe/probe.yaml": "builds:\n  firebaseApp: \"1:555:android:abc123\"\n" });
    await assert.rejects(resolveBuild(firebase, { source: "firebase" }, () => undefined), /No Google service account key/);
  });
});

describe("what a test runs against", () => {
  test("a project with no app and no web address has nothing to run cards on", () => {
    const project = fixture();
    assert.deepEqual(runTargets(project), []);
    assert.throws(() => pickTarget(project), /set its address in Studio/);
    assert.deepEqual(testOptions(project), []);
  });

  test("a web address makes the web target, saved normalised to the shared file", () => {
    const project = fixture();
    assert.match(saveBuildSettings(project, { webUrl: "ftp://x" })!, /Web app address/);
    assert.match(saveBuildSettings(project, { firebaseApp: "abc" })!, /Firebase app id/);
    assert.match(saveBuildSettings(project, { tag: "v1" })!, /\{build\}/);
    assert.equal(saveBuildSettings(project, { webUrl: "staging.shop.example/app" }), null);
    assert.equal(buildSettings(project).webUrl, "https://staging.shop.example/app");
    assert.deepEqual(runTargets(project), ["web"]);
    assert.equal(pickTarget(project), "web");
    assert.throws(() => pickTarget(project, "android"), /Device testing is not available/);
    assert.deepEqual(testOptions(project).map((o) => o.id), ["web"]);
    const yaml = readFileSync(join(project.root, "probe", "probe.yaml"), "utf8");
    assert.match(yaml, /web:\n  url: https:\/\/staging\.shop\.example\/app/);
    // Sections with nothing in them are not written.
    assert.ok(!/builds:|app:/.test(yaml), yaml);
    // Clearing it removes the target again.
    assert.equal(saveBuildSettings(project, { webUrl: "" }), null);
    assert.deepEqual(runTargets(project), []);
  });

  test("a web address is checked before a browser opens", () => {
    assert.equal(webUrl(" http://localhost:3000 "), "http://localhost:3000/");
    assert.throws(() => webUrl(undefined), /No web app address/);
    assert.throws(() => webUrl("javascript:alert(1)"), /not an http/);
  });
});

describe("sign-in tries", () => {
  test("a stored secret is counted per account and secret", async () => {
    const { MAX_SECRET_TRIES, secretTries } = await import("../src/devices/session.js");
    const at = "2026-01-01T00:00:00.000Z";
    const timeline = [
      { at, action: "type_secret", detail: "typed user_a's password" },
      { at, action: "type_secret", detail: "typed user_a's password" },
      { at, action: "type_secret", detail: "typed user_b's password" },
      { at, action: "act", detail: "tap 12" },
    ];
    assert.equal(secretTries(timeline, "user_a", "password"), 2);
    assert.equal(secretTries(timeline, "user_b", "password"), 1);
    assert.ok(secretTries(timeline, "user_a", "password") >= MAX_SECRET_TRIES);
  });
});

describe("unblocking a blocked run", () => {
  test("the reason comes from the agent, or from its notes on older runs", async () => {
    const { blockReason } = await import("../src/engine/unblock.js");
    assert.equal(blockReason("missing-data", "anything"), "missing-data");
    assert.equal(blockReason(undefined, "Logged in as @someone, which is not a test account."), "wrong-account");
    assert.equal(blockReason(undefined, "The sign-in was refused: wrong password shown under the field."), "sign-in");
    assert.equal(blockReason(undefined, "It asks for the SMS code sent to the phone."), "needs-code");
    assert.equal(blockReason(undefined, "There is no active story to open."), "missing-data");
    assert.equal(blockReason(undefined, "A 'No connection – Trying to reconnect' banner stayed on."), "no-connection");
    assert.equal(blockReason(undefined, "The screen stayed white."), "other");
  });

  test("a verify reruns its blocked cards and the ones a failed sign-in skipped", async () => {
    const { unblockOf } = await import("../src/engine/unblock.js");
    const project = fixture();
    const at = new Date().toISOString();
    const card: CardRun = {
      id: "20260101-000001", kind: "card", feature: "story", cardId: "close", status: "blocked", startedAt: at, device: "emulator", timeline: [], crashes: [], costUsd: 0,
      verdict: { result: "blocked", expectations: [], notes: "Sign-in refused.", blockedBy: "sign-in" },
    } as unknown as CardRun;
    project.store.writeRun(card.id, card);
    const verify = {
      id: "20260101-000000", kind: "verify", feature: "*", status: "blocked", startedAt: at, base: "main", changed: [], unowned: [], device: true, costUsd: 0,
      features: [{ feature: "story", files: [], cards: [
        { cardId: "close", runId: card.id, status: "blocked", note: "Sign-in refused." },
        { cardId: "sheet", status: "skipped", note: "not run: sign-in failed on story/close; fix the test accounts" },
        { cardId: "open", status: "passed", runId: "x" },
      ] }],
    } as unknown as VerifyRun;
    const u = unblockOf(project, verify)!;
    assert.equal(u.reason, "sign-in");
    assert.equal(u.settings, "accounts");
    assert.deepEqual(u.cards, ["story/close", "story/sheet"]);
    assert.equal(unblockOf(project, { ...verify, features: [{ feature: "story", files: [], cards: [{ cardId: "open", status: "passed" }] }] } as VerifyRun), null);
  });
});

describe("test accounts", () => {
  test("the name an account shows is learned only after Probe signed in with it", async () => {
    const { learnShownAs, listAccounts, saveAccount } = await import("../src/accounts/accounts.js");
    const project = fixture();
    saveAccount(project.root, { role: "user_a", username: "a@example.com", shownAs: "@old" });
    const log: string[] = [];
    const at = "2026-01-01T00:00:00.000Z";
    assert.equal(learnShownAs(project.root, "user_a", "@new", [{ action: "act", detail: "tap 3" }], (l) => log.push(l)), false);
    assert.equal(listAccounts(project.root)[0]!.shownAs, "@old");
    assert.equal(learnShownAs(project.root, "user_a", "@new", [{ at, action: "type_secret", detail: "typed user_a's password" } as never], (l) => log.push(l)), true);
    assert.equal(listAccounts(project.root)[0]!.shownAs, "@new");
    assert.match(log[0]!, /was @old/);
  });
});
