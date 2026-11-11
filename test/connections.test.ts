import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { Secrets } from "../src/accounts/accounts.js";
import { aiEnv, aiFor, connections, removeAiAccount, saveAiAccount, saveAiUse, saveConnection, trackerConnections } from "../src/connections/connections.js";
import { channelApplies, mentionsTicket, ticketDiscussion, type Fetch } from "../src/connections/slack.js";
import type { WorkbenchConfig } from "../src/core/config.js";
import { openProject, type Project } from "../src/engine/project.js";
import { inbox } from "../src/tickets/inbox.js";
import { changedSince, commitMessage, commitType, orderSteps, ticketGroup } from "../src/tickets/workbench.js";

const home = mkdtempSync(join(tmpdir(), "probe-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

function fixture(yaml = "name: shop\n"): Project {
  const root = mkdtempSync(join(tmpdir(), "probe-conn-"));
  mkdirSync(join(root, "probe"), { recursive: true });
  writeFileSync(join(root, "probe/probe.yaml"), yaml);
  spawnSync("git", ["init", "-q"], { cwd: root });
  return openProject(root);
}

/** Answers by URL substring; records calls. */
function fake(routes: [string, (url: string, body: unknown) => unknown][]): { fetcher: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher: Fetch = async (url, init) => {
    urls.push(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const route = routes.find(([part]) => url.includes(part));
    return new Response(JSON.stringify(route ? route[1](url, body) : { ok: false, error: "no_route" }), { status: route ? 200 : 404 });
  };
  return { fetcher, urls };
}

describe("connections per project", () => {
  test("a project holds several trackers and a Slack workspace; tokens stay in that project's store", () => {
    const a = fixture();
    const b = fixture();
    const jira = saveConnection(a, { kind: "jira", site: "acme.atlassian.net", email: "you@example.com", token: "jira-secret" });
    const linear = saveConnection(a, { kind: "linear", team: "ENG", token: "lin-secret" });
    const slack = saveConnection(a, { kind: "slack", workspace: "acme", token: "xoxb-1", channels: [{ id: "C0123456", name: "#shop-qa" }, { id: "C0654321", name: "shop-dev", post: true, labels: ["android"] }] });
    assert.deepEqual([jira, linear, slack], [{ id: "jira" }, { id: "linear" }, { id: "slack" }]);
    assert.deepEqual(trackerConnections(a).map((c) => c.id), ["jira", "linear"]);

    const shared = readFileSync(join(a.root, "probe/probe.yaml"), "utf8");
    assert.match(shared, /site: https:\/\/acme\.atlassian\.net/);
    assert.match(shared, /name: shop-qa/);
    assert.doesNotMatch(shared, /secret|xoxb|you@example\.com/, "tokens and emails never go to the shared file");

    const reread = openProject(a.root);
    assert.equal(connections(reread).find((c) => c.id === "jira")?.email, "you@example.com");
    assert.equal(connections(reread).find((c) => c.id === "slack")?.channels?.[1]?.labels?.[0], "android");
    assert.equal(new Secrets(a.store.dir).getKey("connection.jira.token"), "jira-secret");
    assert.equal(connections(b).length, 0, "another project sees none of it");
    assert.equal(new Secrets(b.store.dir).getKey("connection.jira.token"), null);
  });

  test("the older single tracker shows as a connection and moves to the list, token and all, when edited", () => {
    const p = fixture("tickets:\n  tracker: linear\n  team: ENG\n");
    new Secrets(p.store.dir).setKey("tracker.linear.token", "old-token");
    assert.deepEqual(connections(p).map((c) => [c.id, c.legacy]), [["tracker", true]]);
    const saved = saveConnection(p, { id: "tracker", team: "OPS" });
    assert.deepEqual(saved, { id: "linear" });
    assert.deepEqual(connections(p).map((c) => [c.id, c.team, !!c.legacy]), [["linear", "OPS", false]]);
    assert.equal(new Secrets(p.store.dir).getKey("connection.linear.token"), "old-token");
    assert.doesNotMatch(readFileSync(join(p.root, "probe/probe.yaml"), "utf8"), /tracker: linear/);
  });

  test("Jira refuses a site address that carries more than the address", () => {
    const p = fixture();
    assert.deepEqual(saveConnection(p, { kind: "jira", site: "https://user:pw@acme.atlassian.net" }), { error: "Site: only the address, e.g. https://acme.atlassian.net" });
  });

  test("the inbox lists every tracker's tickets, each marked with where it came from", async () => {
    const p = fixture();
    saveConnection(p, { kind: "jira", site: "https://acme.atlassian.net", token: "t1" });
    saveConnection(p, { kind: "linear", token: "t2" });
    const { fetcher } = fake([
      ["/search/jql", () => ({ issues: [{ key: "SHOP-1", fields: { summary: "Cart", status: { name: "Ready for dev" }, labels: [] } }] })],
      ["api.linear.app", () => ({ data: { issues: { nodes: [{ id: "x", identifier: "ENG-9", title: "Login", url: "u", updatedAt: "", state: { name: "Todo" } }] } } })],
    ]);
    const tickets = await inbox(p, { fetcher, refresh: true });
    assert.deepEqual(tickets.map((t) => [t.id, t.source]), [["SHOP-1", "jira"], ["ENG-9", "linear"]]);
  });
});

describe("Slack", () => {
  test("a message is about a ticket when it names its key as a word, or quotes a long title", () => {
    assert.ok(mentionsTicket("fixed SHOP-412 in 2.3.1", "SHOP-412"));
    assert.ok(mentionsTicket("see <https://x/browse/SHOP-412|shop-412>", "SHOP-412"));
    assert.ok(!mentionsTicket("SHOP-4120 is different", "SHOP-412"));
    assert.ok(mentionsTicket("the checkout button does nothing on android 14 again", "X-1", "Checkout button does nothing on Android 14"));
    assert.ok(!mentionsTicket("login", "X-1", "Login"));
  });

  test("a channel with labels is only searched for tickets with one of them", () => {
    const ch = { id: "C1", name: "android", search: true, post: false, labels: ["Android"] };
    assert.ok(channelApplies(ch, ["android"]));
    assert.ok(!channelApplies(ch, ["web"]));
    assert.ok(!channelApplies({ ...ch, search: false, labels: [] }, []));
  });

  test("the discussion searches every chosen channel and reports one it cannot read", async () => {
    const p = fixture();
    saveConnection(p, { kind: "slack", token: "xoxb-1", channels: [{ id: "C0000001", name: "qa" }, { id: "C0000002", name: "secret" }] });
    const now = Math.floor(Date.now() / 1000);
    const { fetcher } = fake([
      ["auth.test", () => ({ ok: true, user: "probe-bot", team: "Acme", url: "https://acme.slack.com/" })],
      ["channel=C0000001", () => ({ ok: true, messages: [{ ts: `${now}.000100`, user: "U1", text: "SHOP-7 fixed, needs QA" }, { ts: `${now}.000050`, user: "U1", text: "lunch?" }] })],
      ["channel=C0000002", () => ({ ok: false, error: "not_in_channel" })],
      ["users.info", () => ({ ok: true, user: { real_name: "Sara" } })],
    ]);
    const d = await ticketDiscussion(p, { id: "SHOP-7" }, fetcher);
    assert.equal(d.matches.length, 1);
    assert.equal(d.matches[0]!.user, "Sara");
    assert.equal(d.matches[0]!.link, `https://acme.slack.com/archives/C0000001/p${now}000100`);
    assert.match(d.errors[0]!, /#secret: .*invite/);
  });
});

describe("AI accounts", () => {
  test("each project has its own accounts, and each kind of work its own account and model", () => {
    const a = fixture();
    const b = fixture();
    const work = saveAiAccount(a, { name: "Work Claude (Max)", mode: "profile", profileDir: "/tmp/claude-work" });
    const client = saveAiAccount(a, { name: "Client API", mode: "apiKey", apiKey: "sk-ant-test" });
    assert.deepEqual([work, client], [{ id: "work-claude-max" }, { id: "client-api" }]);
    assert.equal(saveAiUse(a, { coding: { account: "client-api", model: "opus" }, review: { model: "sonnet" } }), null);

    const coding = aiFor(a, "coding");
    assert.equal(coding.account?.name, "Client API");
    assert.equal(coding.model, "opus");
    assert.deepEqual(aiEnv(a, coding.account), { ANTHROPIC_API_KEY: "sk-ant-test" });
    assert.equal(aiFor(a, "review").account?.id, "work-claude-max", "no choice: the first account");
    assert.deepEqual(aiEnv(a, aiFor(a, "review").account), { CLAUDE_CONFIG_DIR: "/tmp/claude-work" });
    assert.deepEqual(aiEnv(b, aiFor(b, "coding").account), {}, "another project uses the CLI's own login");

    removeAiAccount(a, "client-api");
    assert.equal(aiFor(a, "coding").account?.id, "work-claude-max");
    assert.equal(new Secrets(a.store.dir).getKey("ai.client-api.apiKey"), null);
    assert.match(String((saveAiUse(a, { coding: { account: "nope" } }))), /unknown account/);
  });
});

describe("workbench", () => {
  const rules: WorkbenchConfig = { commitPattern: "", notForMe: { otherAssignee: true, labels: ["backend"], statuses: ["Blocked"] }, steps: [], hidden: ["jira/SHOP-9"] };

  test("commit messages follow the pattern, and an unknown area leaves no empty brackets", () => {
    const t = { key: "SHOP-412", title: "Checkout button does nothing on Android 14.", labels: ["bug"] };
    assert.equal(commitMessage("{type}({area}): {title} [{key}]", t, "checkout"), "fix(checkout): Checkout button does nothing on Android 14 [SHOP-412]");
    assert.equal(commitMessage("{type}({area}): {title} [{key}]", t), "fix: Checkout button does nothing on Android 14 [SHOP-412]");
    assert.equal(commitMessage("{key} {title}", { key: "A-1", title: "Add dark mode" }), "A-1 Add dark mode");
    assert.equal(commitType({ title: "Add dark mode" }), "feat");
  });

  test("tickets are yours, not for you by the rules, or hidden by hand", () => {
    const base = { id: "SHOP-1", source: "jira", labels: [] as string[], status: "Ready for dev" };
    assert.deepEqual(ticketGroup({ ...base, assignee: "Alex" }, rules, ["alex"]), { group: "mine" });
    assert.deepEqual(ticketGroup(base, rules, ["Alex"]), { group: "mine" }, "unassigned is yours to take");
    assert.deepEqual(ticketGroup({ ...base, assignee: "Sara" }, rules, ["Alex"]), { group: "notForMe", why: "assigned to Sara" });
    assert.equal(ticketGroup({ ...base, labels: ["Backend"] }, rules, []).group, "notForMe");
    assert.equal(ticketGroup({ ...base, status: "blocked" }, rules, []).group, "notForMe");
    assert.equal(ticketGroup({ ...base, id: "SHOP-9" }, rules, []).group, "hidden");
  });

  test("steps keep their fixed order, and a ticket's files are only those it changed", () => {
    assert.deepEqual(orderSteps(["commit", "fix", "nope", "context"]), ["context", "fix", "commit"]);
    const before = new Map([["a.ts", " M"]]);
    const after = new Map([["a.ts", "MM"], ["b.ts", "??"]]);
    assert.deepEqual(changedSince(before, after), { files: ["b.ts"], conflicts: ["a.ts"] });
  });
});
