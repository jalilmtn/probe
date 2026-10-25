import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openInBrowser } from "../core/proc.js";
import { doctor, formatDoctor } from "../engine/doctor.js";
import { openProject } from "../engine/project.js";
import { findFeature, latestScan, riskyGaps, scan } from "../engine/scan.js";
import { startUnitRun, summarizeRun } from "../engine/unit.js";
import { startStudio } from "../studio/server.js";
import { formatAtlas, formatCards } from "../cli/format.js";
import { startBackfill, summarizeBackfill } from "../cards/backfill.js";
import { cardContext } from "../cards/context.js";
import { CardInput } from "../cards/schema.js";
import { listCards, saveCards } from "../cards/store.js";
import { listAccounts, Secrets } from "../accounts/accounts.js";
import { startCardRun, summarizeCardRun } from "../cards/run.js";
import { DeviceSession } from "../devices/session.js";
import { formatUiTree } from "../devices/uitree.js";
import { describeLogin, startLoginRun } from "../accounts/login.js";
import { startExploreRun, summarizeExplore } from "../cards/explore.js";
import type { Run } from "../core/types.js";
import { featureHealth } from "../engine/health.js";
import { startUnitWrite, summarizeUnitWrite } from "../engine/unitwrite.js";
import { startFix, summarizeFix } from "../engine/fix.js";
import { findIssue, fixPrompt, issuesOf } from "../engine/issues.js";
import { startVerify, summarizeVerify } from "../engine/verify.js";
import { ticketDraft, ticketInfo } from "../tickets/tickets.js";

const projectDir = z
  .string()
  .optional()
  .describe("Project root. Defaults to the directory the session was opened in.");

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * Probe as tools for any MCP-capable agent (Claude Code, Cursor, Codex, Copilot…).
 * Each tool is a thin call into the engine; no tool holds logic of its own.
 */
export async function runMcpServer(version: string): Promise<void> {
  const server = new McpServer({ name: "probe", version });

  server.registerTool(
    "probe_doctor",
    { title: "Check setup", description: "Checks Node, the project, build tooling, SDKs, devices and emulator images.", inputSchema: { projectDir } },
    async ({ projectDir: dir }) => {
      try {
        return text(formatDoctor(doctor(openProject(dir))));
      } catch (e) {
        return text(formatDoctor(doctor(null, (e as Error).message)));
      }
    },
  );

  server.registerTool(
    "probe_scan",
    {
      title: "Scan app",
      description:
        "Maps the project into features and reports per feature: static unit coverage, and a health verdict (ok/warn/fail/unknown) with reasons from the last unit run, card runs on devices, the navigation map and performance. Use refresh=true after code changes.",
      inputSchema: { projectDir, refresh: z.boolean().optional().describe("Rescan instead of using the last scan.") },
    },
    async ({ projectDir: dir, refresh }) => {
      const project = openProject(dir);
      const result = refresh ? scan(project) : latestScan(project);
      return text(formatAtlas(result, featureHealth(project, result)));
    },
  );

  server.registerTool(
    "probe_feature",
    {
      title: "Feature detail",
      description: "One feature's modules and its riskiest untested classes (ranked by kind and size), with file paths.",
      inputSchema: { projectDir, feature: z.string().describe("Feature id from probe_scan, e.g. 'chat' or 'core:network'.") },
    },
    async ({ projectDir: dir, feature: id }) => {
      const feature = findFeature(latestScan(openProject(dir)), id);
      if (!feature) return text(`Unknown feature "${id}". Call probe_scan to list features.`);
      const lines = [`${feature.id} (${feature.group}) · ${feature.stats.testable} testable classes · ${feature.stats.direct} with a test class · ${feature.stats.untested} untested`, "", "Modules:"];
      for (const m of feature.modules) lines.push(`  ${m.id} [${m.platform}] ${m.mainFiles} source files, ${m.testFiles} unit test files${m.unitTestTask ? ` · ${m.unitTestTask}` : ""}`);
      lines.push("", "Riskiest untested classes:");
      for (const c of riskyGaps(feature)) lines.push(`  ${c.risk.toFixed(1).padStart(5)}  ${c.name} (${c.kind}, ~${c.lines} lines)  ${c.file}`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "probe_unit_run",
    {
      title: "Run unit tests",
      description: "Runs every unit test of one feature's modules in a single build and returns per-module results with failures. Can take minutes.",
      inputSchema: { projectDir, feature: z.string() },
    },
    async ({ projectDir: dir, feature }) => {
      const { done } = startUnitRun(openProject(dir), feature);
      return text(summarizeRun(await done));
    },
  );

  server.registerTool(
    "probe_cards_context",
    {
      title: "Card context",
      description:
        "Everything needed to write feature cards for one feature: modules, key classes, navigation hints, docs, git history (fixes marked), existing cards and the card rules. Call before probe_cards_save.",
      inputSchema: { projectDir, feature: z.string() },
    },
    async ({ projectDir: dir, feature: id }) => {
      const project = openProject(dir);
      const feature = findFeature(latestScan(project), id);
      if (!feature) return text(`Unknown feature "${id}". Call probe_scan to list features.`);
      return text(cardContext(project, feature));
    },
  );

  server.registerTool(
    "probe_cards_save",
    {
      title: "Save cards",
      description:
        "Saves drafted feature cards for one feature as YAML in the project (probe/cards/<feature>/). Same id updates the draft; cards a person approved or rejected are never overwritten. Saved cards are drafts until reviewed.",
      inputSchema: { projectDir, feature: z.string(), cards: z.array(CardInput).min(1) },
    },
    async ({ projectDir: dir, feature: id, cards }) => {
      const project = openProject(dir);
      const feature = findFeature(latestScan(project), id);
      if (!feature) return text(`Unknown feature "${id}". Call probe_scan to list features.`);
      const r = saveCards(project.root, feature.id, cards, "backfill");
      return text(
        [
          `Saved ${r.written.length} cards for ${feature.id}: ${r.written.join(", ") || "none"}`,
          r.kept.length ? `Kept (already reviewed): ${r.kept.join(", ")}` : "",
          r.errors.length ? `Errors:\n${r.errors.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "probe_cards_list",
    {
      title: "List cards",
      description: "Feature cards in the project, optionally for one feature: id, level, status, confidence, title, how to reach it and what to expect.",
      inputSchema: { projectDir, feature: z.string().optional(), detail: z.boolean().optional().describe("Include reach, steps and expectations.") },
    },
    async ({ projectDir: dir, feature, detail }) => text(formatCards(listCards(openProject(dir).root, feature), detail ?? false)),
  );

  server.registerTool(
    "probe_cards_backfill",
    {
      title: "Backfill cards (background agent)",
      description:
        "Starts a separate headless agent that drafts cards for a feature ('*' = every feature without cards) and waits for it. Takes minutes and costs tokens. Inside an agent session, prefer probe_cards_context + probe_cards_save yourself.",
      inputSchema: {
        projectDir,
        feature: z.string().describe("Feature id, or '*'"),
        ticket: z.string().optional().describe("Draft the cards this ticket needs; its id goes on each card."),
        ticketText: z.string().optional().describe("The ticket's text, when you have it."),
      },
    },
    async ({ projectDir: dir, feature, ticket, ticketText }) => {
      const { done } = startBackfill(openProject(dir), feature, { ticket: ticket ? { id: ticket, text: ticketText } : undefined });
      return text(summarizeBackfill(await done));
    },
  );

  // ── Device tools: only inside a card run, which hands the agent's MCP server a session ──

  const session = () => {
    const id = process.env.PROBE_SESSION;
    if (!id) throw new Error("Device tools only work inside a Probe device run (card, explore or login check).");
    return DeviceSession.open(openProject().store.dir, id);
  };

  server.registerTool(
    "probe_device_observe",
    {
      title: "Observe screen",
      description: "Screenshot plus a numbered list of on-screen elements (text, description, id, what can be tapped/typed/scrolled, centre point). Call before acting and after every change.",
      inputSchema: { screenshot: z.boolean().optional().describe("Default true. False returns the element list only.") },
    },
    async ({ screenshot }) => {
      const s = session();
      const tree = formatUiTree(s.observe());
      const shot = screenshot === false ? null : s.capture();
      s.record("observe", `${tree.split("\n").length} elements`, shot?.name);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: tree }];
      if (shot) content.push({ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" });
      return { content };
    },
  );

  server.registerTool(
    "probe_device_act",
    {
      title: "Act on device",
      description:
        "One action on the device: tap (element number from the last observe, or x/y), long_press, type (into the focused field), key (back/home/enter/tab/delete), swipe (up/down/left/right scrolls content), wait (ms, for loading), relaunch (restart the app).",
      inputSchema: {
        action: z.enum(["tap", "long_press", "type", "key", "swipe", "wait", "relaunch"]),
        element: z.number().int().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.string().optional(),
        key: z.enum(["back", "home", "enter", "tab", "delete", "app_switch"]).optional(),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        ms: z.number().int().min(100).max(15_000).optional(),
      },
    },
    async (a) => {
      const s = session();
      const d = s.device;
      let detail: string;
      switch (a.action) {
        case "tap":
          detail = d.tap({ element: a.element, x: a.x, y: a.y }) + (a.element ? ` (element ${a.element})` : "");
          break;
        case "long_press": {
          if (a.x === undefined || a.y === undefined) return text("long_press needs x and y (use an element's centre from observe).");
          d.longPress(a.x, a.y);
          detail = `long-pressed ${a.x},${a.y}`;
          break;
        }
        case "type":
          if (!a.text) return text("type needs text.");
          d.type(a.text);
          detail = `typed "${a.text}"`;
          break;
        case "key":
          if (!a.key) return text("key needs key.");
          d.key(a.key);
          detail = `pressed ${a.key}`;
          break;
        case "swipe":
          if (!a.direction) return text("swipe needs direction.");
          d.swipe(a.direction);
          detail = `swiped ${a.direction}`;
          break;
        case "wait":
          await new Promise((r) => setTimeout(r, a.ms ?? 1_500));
          detail = `waited ${a.ms ?? 1_500}ms`;
          break;
        case "relaunch":
          d.stop(s.info.appPackage);
          d.launch(s.info.appPackage);
          await new Promise((r) => setTimeout(r, 3_000));
          detail = "relaunched the app";
          break;
      }
      // Let the screen settle so the next observe sees the result.
      if (a.action !== "wait") await new Promise((r) => setTimeout(r, 700));
      s.record(a.action, detail);
      return text(`${detail}. Observe to see the result.`);
    },
  );

  server.registerTool(
    "probe_device_type_secret",
    {
      title: "Type a stored secret",
      description: "Types a test account's stored password or login code into the focused field. The value never reaches you.",
      inputSchema: { role: z.string(), secret: z.enum(["password", "code"]).default("password") },
    },
    async ({ role, secret }) => {
      const s = session();
      const project = openProject();
      if (!listAccounts(project.root).some((a) => a.role === role)) return text(`No test account with role "${role}".`);
      const value = new Secrets(project.store.dir).get(role, secret);
      if (value === null) return text(`No ${secret} stored for ${role}. Report blocked: it is added in Probe Studio -> Accounts.`);
      s.device.type(value);
      s.record("type_secret", `typed ${role}'s ${secret}`);
      return text(`Typed ${role}'s ${secret}. Observe to see the result.`);
    },
  );

  server.registerTool(
    "probe_card_verdict",
    {
      title: "Card verdict",
      description: "Ends the card run with the result and, for each expectation, whether it was met and what you saw.",
      inputSchema: {
        result: z.enum(["passed", "failed", "blocked"]),
        expectations: z.array(z.object({ text: z.string(), met: z.boolean().nullable(), evidence: z.string() })),
        notes: z.string().default(""),
      },
    },
    async (verdict) => {
      const s = session();
      const shot = s.capture();
      s.record("verdict", `${verdict.result}${verdict.notes ? `: ${verdict.notes}` : ""}`, shot?.name);
      s.saveVerdict(verdict);
      return text(`Verdict recorded: ${verdict.result}. You are done.`);
    },
  );

  server.registerTool(
    "probe_login_report",
    {
      title: "Login report",
      description: "Ends a login check with what the app shows: logged in (and as which test role, or null for a non-test account), logged out, or unknown.",
      inputSchema: {
        state: z.enum(["logged_in", "logged_out", "unknown"]),
        role: z.string().nullable(),
        seenAs: z.string().optional(),
        notes: z.string().default(""),
      },
    },
    async (login) => {
      const s = session();
      const shot = s.capture();
      s.record("report", `login: ${login.state}${login.role ? ` as ${login.role}` : ""}`, shot?.name);
      s.saveReport("login", login);
      return text("Login state recorded. You are done.");
    },
  );

  server.registerTool(
    "probe_explore_report",
    {
      title: "Explore report",
      description: "Ends an explore run with every screen reached (name, reach path, screenshot file, notes) and every issue seen.",
      inputSchema: {
        screens: z.array(z.object({ name: z.string(), reach: z.array(z.string()), screenshot: z.string().optional(), notes: z.string().optional() })),
        issues: z.array(z.string()).default([]),
      },
    },
    async (report) => {
      const s = session();
      s.record("report", `${report.screens.length} screens, ${report.issues.length} issues`);
      s.saveReport("explore", report);
      return text("Map recorded. You are done.");
    },
  );

  server.registerTool(
    "probe_card_run",
    {
      title: "Run a card on a device",
      description:
        "Runs one feature card on an emulator (or an allowed phone) with a separate headless agent and waits: screenshots, timeline, screen recording and a verdict. Takes minutes.",
      inputSchema: { projectDir, feature: z.string(), card: z.string().describe("Card id"), device: z.string().optional().describe("Device serial") },
    },
    async ({ projectDir: dir, feature, card, device }) => {
      const { done } = startCardRun(openProject(dir), feature, card, { device });
      return text(summarizeCardRun(await done));
    },
  );

  server.registerTool(
    "probe_verify",
    {
      title: "Verify a change",
      description:
        "Checks the current change end to end: maps files changed since the base branch (plus uncommitted work) to features, runs their unit tests, then reinstalls the app and runs their cards on an emulator. Waits; can take a long time. noDevice = unit tests only.",
      inputSchema: {
        projectDir,
        base: z.string().optional().describe("Branch to compare with; default verify.base or develop/main."),
        features: z.array(z.string()).optional().describe("Check these features instead of the diff's."),
        ticket: z.string().optional().describe("Check what a ticket's commits touched, its cards first."),
        noDevice: z.boolean().optional(),
        cards: z.enum(["approved", "all"]).optional().describe("Which cards run on the device (default approved)."),
        maxCards: z.number().int().min(0).max(50).optional(),
        outdated: z.boolean().optional().describe("Instead of a diff: re-run only results (unit and cards) that are outdated or missing for this checkout."),
        rerunFresh: z.boolean().optional().describe("Also re-run cards whose recorded result still holds for this code (normally skipped)."),
      },
    },
    async ({ projectDir: dir, ...options }) => {
      const { done } = startVerify(openProject(dir), options);
      return text(summarizeVerify(await done));
    },
  );

  server.registerTool(
    "probe_unit_write",
    {
      title: "Write missing unit tests (background agent)",
      description:
        "Starts a separate agent that writes unit tests for a feature's riskiest untested classes, then runs the feature's tests. In a session that can edit files, prefer probe_feature and writing the tests yourself.",
      inputSchema: { projectDir, feature: z.string(), limit: z.number().int().min(1).max(15).optional().describe("Classes to cover (default 5).") },
    },
    async ({ projectDir: dir, feature, limit }) => {
      const { done } = startUnitWrite(openProject(dir), feature, { limit });
      return text(summarizeUnitWrite(await done));
    },
  );

  server.registerTool(
    "probe_issues",
    {
      title: "Problems a run found",
      description: "Lists the fixable problems of a run (failing tests, unmet card expectations, crashes, navigation issues, performance warnings), each with an issue id for probe_fix_prompt / probe_fix. A verify run lists the issues of the runs it started.",
      inputSchema: { projectDir, runId: z.string() },
    },
    async ({ projectDir: dir, runId }) => {
      const project = openProject(dir);
      const run = project.store.read<Run>(`runs/${runId}.json`);
      if (!run) return text(`No run ${runId}.`);
      const list = issuesOf(project, run);
      return text(list.length ? list.map((i) => `${i.id}  [${i.kind}] ${i.feature}: ${i.title}`).join("\n") : "No issues.");
    },
  );

  server.registerTool(
    "probe_fix_prompt",
    {
      title: "Context for fixing one issue",
      description: "Everything needed to fix one issue: the problem, its evidence, the card, the feature's modules and how to check the fix. In a session that can edit code, prefer this and fix it yourself over probe_fix.",
      inputSchema: { projectDir, issueId: z.string() },
    },
    async ({ projectDir: dir, issueId }) => {
      const project = openProject(dir);
      const found = findIssue(project, issueId);
      return text(found ? fixPrompt(project, found.issue, found.run, false) : `No issue ${issueId}.`);
    },
  );

  server.registerTool(
    "probe_fix",
    {
      title: "Fix one issue (background agent)",
      description: "A separate agent fixes the issue in the code (edits files, never git), then Probe runs the feature's unit tests and, for a problem seen on a device, the card again. Changes stay uncommitted for review. Takes minutes.",
      inputSchema: { projectDir, issueId: z.string() },
    },
    async ({ projectDir: dir, issueId }) => {
      const { done } = startFix(openProject(dir), issueId);
      return text(summarizeFix(await done));
    },
  );

  server.registerTool(
    "probe_explore",
    {
      title: "Map a feature's navigation on a device",
      description:
        "A separate agent walks every screen of a feature on an emulator and reports the screens, how each is reached, and navigation or visual issues. The result feeds the Atlas. Takes minutes.",
      inputSchema: { projectDir, feature: z.string(), device: z.string().optional() },
    },
    async ({ projectDir: dir, feature, device }) => {
      const { done } = startExploreRun(openProject(dir), feature, { device });
      return text(summarizeExplore(await done));
    },
  );

  server.registerTool(
    "probe_login_check",
    {
      title: "Check or set the device login",
      description:
        "A separate agent looks at the app on the emulator and reports whether it is logged in and with which test account; with role, it logs in as that test account.",
      inputSchema: { projectDir, role: z.string().optional(), device: z.string().optional() },
    },
    async ({ projectDir: dir, role, device }) => {
      const { done } = startLoginRun(openProject(dir), role, { device });
      const run = await done;
      return text(`Login ${run.status}: ${run.login ? describeLogin(run.login) : (run.error ?? "no report")}`);
    },
  );

  server.registerTool(
    "probe_ticket",
    {
      title: "Ticket context or draft",
      description:
        "With ticket: commits naming it, the features they touched and cards citing it. With runId: a ticket draft (title and markdown body) for a run that did not pass. Probe never files tickets from here; a person files them from Studio.",
      inputSchema: { projectDir, ticket: z.string().optional(), runId: z.string().optional() },
    },
    async ({ projectDir: dir, ticket, runId }) => {
      const project = openProject(dir);
      if (runId) {
        const run = project.store.read<Run>(`runs/${runId}.json`);
        if (!run) return text(`Unknown run ${runId}.`);
        const d = ticketDraft(project, run);
        return text(`# ${d.title}\n\n${d.body}`);
      }
      if (!ticket) return text("Pass ticket or runId.");
      const info = ticketInfo(project, ticket);
      return text(
        [
          `${info.id}${info.url ? ` · ${info.url}` : ""}`,
          `Features: ${info.features.join(", ") || "none found"}`,
          `Cards: ${info.cards.join(", ") || "none"}`,
          "Commits:",
          ...info.commits.map((c) => `  ${c.hash} ${c.date} ${c.subject}`),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "probe_studio_open",
    { title: "Open Studio", description: "Starts the local Probe Studio GUI and opens it in the browser.", inputSchema: { projectDir } },
    async ({ projectDir: dir }) => {
      const url = await startStudio(openProject(dir));
      openInBrowser(url);
      return text(`Probe Studio is running at ${url} (opened in the browser). It stays up while this session runs.`);
    },
  );

  await server.connect(new StdioServerTransport());
}
