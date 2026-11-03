import { relative } from "node:path";
import { runAgent } from "../agent/headless.js";
import type { FeatureInfo, SecurityFinding, Severity } from "../core/types.js";
import type { Project } from "../engine/project.js";
import { makeFinding, SEVERITY_ORDER } from "./findings.js";
import { PLATFORM_DOCS } from "./platforms.js";
import type { Platform } from "./rule.js";
import androidDoc from "../../docs/security/android.md";
import backendDoc from "../../docs/security/backend.md";
import commonDoc from "../../docs/security/common.md";
import mobileDoc from "../../docs/security/cross-platform-mobile.md";
import desktopDoc from "../../docs/security/desktop.md";
import iosDoc from "../../docs/security/ios.md";
import webDoc from "../../docs/security/web-frontend.md";

const DOCS: Record<string, string> = {
  "common.md": commonDoc,
  "android.md": androidDoc,
  "ios.md": iosDoc,
  "web-frontend.md": webDoc,
  "backend.md": backendDoc,
  "cross-platform-mobile.md": mobileDoc,
  "desktop.md": desktopDoc,
};

/**
 * An agent reads one feature's code against the catalogs of the project's platforms and
 * reports what pattern rules cannot see: authorization gaps, IDOR, business-logic abuse,
 * trust boundaries. Read-only. Its findings are advisory: a person confirms them.
 */
export async function agentFindings(
  project: Project,
  feature: FeatureInfo,
  platforms: Set<Platform>,
  known: SecurityFinding[],
  log: (line: string) => void,
  model?: string,
): Promise<{ findings: SecurityFinding[]; costUsd: number; error?: string }> {
  const prompt = reviewPrompt(project, feature, platforms, known);
  const result = await runAgent(project, { prompt, probeTools: ["probe_feature"], model }, (l) => log(`  ${l}`));
  const parsed = parseAgentFindings(result.summary, feature.id);
  if (!result.ok && !parsed.length) return { findings: [], costUsd: result.costUsd, error: result.summary.slice(0, 300) || "the agent did not finish" };
  return { findings: parsed, costUsd: result.costUsd };
}

export function reviewPrompt(project: Project, feature: FeatureInfo, platforms: Set<Platform>, known: SecurityFinding[]): string {
  const docs = [...new Set(["common", ...platforms].map((p) => PLATFORM_DOCS[p as Platform]))].map((d) => DOCS[d]).filter(Boolean);
  const modules = feature.modules.map((m) => `- ${m.id} — ${relative(project.root, m.dir).replace(/\\/g, "/") || "."}`).join("\n");
  const already = known.filter((f) => f.feature === feature.id).slice(0, 40).map((f) => `- ${f.check} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} — ${f.title}`).join("\n");
  return `You are a security reviewer. Review the "${feature.id}" feature of the project in the current directory for security problems.

## The feature's code (modules)
${modules || "- (whole project)"}

## Already reported by Probe's pattern rules (do not repeat these)
${already || "- none"}

## What to look for
Pattern rules already cover obvious API misuse. Spend your effort on what needs reading the code:
- authentication and authorization: routes, screens, actions or queries that skip the login or ownership check; IDOR (an id from the request or a deep link used without checking it belongs to the user); admin-only actions reachable by others
- trust boundaries: data from deep links, intents, push payloads, WebView messages, IPC, webhooks or third-party APIs used without validation
- secrets and crypto used as security controls in the client (keys shipped in the app, client-side signing)
- business logic: prices, quantities, roles or limits decided on the client; steps that can be skipped; races (double spend)
- sensitive data: tokens or personal data stored, logged, cached or sent where they should not be
- for LLM features: untrusted content reaching prompts that can call tools

Use the catalog below for check ids. Read the code with your file tools. Report only problems with a concrete attack path in this code, not general advice; if a protection exists elsewhere (middleware, a base class), it is not a finding. It is fine to report nothing.

## Catalog (check ids and what they mean)
${docs.join("\n\n---\n\n")}

## Answer
End with exactly one fenced json block and nothing after it:
\`\`\`json
{"findings": [{"check": "API-AUZ-01", "title": "short title", "severity": "critical|high|medium|low|info", "file": "path/relative/to/project", "line": 42, "evidence": "the code that shows it (one or two lines)", "why": "the attack path in one or two sentences", "fix": "the smallest change that closes it"}]}
\`\`\``;
}

/** The json block at the end of the agent's answer, as findings. Anything malformed is dropped. */
export function parseAgentFindings(text: string, feature: string): SecurityFinding[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1]![1]! : (/\{[\s\S]*"findings"[\s\S]*\}/.exec(text)?.[0] ?? "");
  let data: { findings?: unknown };
  try {
    data = JSON.parse(raw) as { findings?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(data.findings)) return [];
  return data.findings
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null && typeof (f as { title?: unknown }).title === "string")
    .map((f) => {
      const severity = SEVERITY_ORDER.includes(String(f.severity).toLowerCase() as Severity) ? (String(f.severity).toLowerCase() as Severity) : "medium";
      const check = typeof f.check === "string" && /^[A-Z]{2,4}-[\w-]+$/.test(f.check) ? f.check : "AGENT";
      return makeFinding({
        check,
        title: String(f.title).slice(0, 160),
        severity,
        layer: "agent",
        file: typeof f.file === "string" ? f.file.replace(/\\/g, "/").replace(/^\.\//, "") : undefined,
        line: typeof f.line === "number" && f.line > 0 ? Math.floor(f.line) : undefined,
        evidence: String(f.evidence ?? "").slice(0, 400),
        why: String(f.why ?? "").slice(0, 600),
        fix: String(f.fix ?? "").slice(0, 600),
        refs: [check],
        feature,
      });
    });
}
