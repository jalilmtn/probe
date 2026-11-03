import { Adb, shQuote } from "../devices/adb.js";
import { listDevices } from "../devices/android.js";
import type { SecurityFinding, Severity } from "../core/types.js";
import type { Project } from "../engine/project.js";
import { makeFinding, mask } from "./findings.js";
import type { Rule } from "./rule.js";

/** Only the user's own app on their own machine: runtime checks never touch another host. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".test");
  } catch {
    return false;
  }
}

function found(check: string, severity: Severity, evidence: string, title: string, why: string, fix: string, refs: string[], file?: string): SecurityFinding {
  return makeFinding({ check, title, severity, layer: "runtime", file, evidence, why, fix, refs, feature: "project" });
}

/**
 * The running web app or API at a local URL: response headers, cookie flags, CORS behaviour and
 * well-known paths that should never answer (.env, .git, actuator, pprof). Read-only requests.
 */
export async function webRuntimeFindings(url: string, log: (line: string) => void): Promise<SecurityFinding[]> {
  if (!isLocalUrl(url)) throw new Error(`security.url must be a local address (localhost, 127.0.0.1, *.localhost, *.test); got ${url}.`);
  const out: SecurityFinding[] = [];
  const base = url.replace(/\/$/, "");
  const res = await get(base);
  if (!res) {
    log(`  ${base} did not answer: start the app, or unset security.url`);
    return out;
  }
  const h = res.headers;
  const html = (h.get("content-type") ?? "").includes("text/html");
  if (html) {
    const csp = h.get("content-security-policy");
    if (!csp) out.push(found("WEB-HDR-01", "medium", `GET ${base} → no Content-Security-Policy`, "No Content-Security-Policy", "Without CSP, any XSS runs freely.", "Send a CSP that allows only your own scripts (nonces or hashes).", ["CWE-693"]));
    else if (/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\s\*)/.test(csp)) out.push(found("WEB-HDR-01", "medium", `CSP: ${csp.slice(0, 200)}`, "Weak Content-Security-Policy", "unsafe-inline / unsafe-eval / * leaves XSS exploitable.", "Use nonces or hashes for scripts.", ["CWE-693"]));
    if (!h.get("x-frame-options") && !/frame-ancestors/.test(csp ?? "")) out.push(found("WEB-HDR-02", "medium", `GET ${base} → no X-Frame-Options or frame-ancestors`, "Page can be framed (clickjacking)", "Another site can load your page invisibly and trick users into clicking.", "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: DENY).", ["CWE-1021"]));
    if (!h.get("referrer-policy")) out.push(found("WEB-HDR-05", "low", `GET ${base} → no Referrer-Policy`, "No Referrer-Policy", "Full URLs (with any tokens in them) go to other sites in the Referer header.", "Send Referrer-Policy: strict-origin-when-cross-origin.", ["CWE-200"]));
  }
  if (!h.get("x-content-type-options")) out.push(found("WEB-HDR-04", "low", `GET ${base} → no X-Content-Type-Options`, "MIME sniffing not disabled", "Browsers may run uploaded files as scripts.", "Send X-Content-Type-Options: nosniff.", []));
  if (base.startsWith("https:") && !h.get("strict-transport-security")) out.push(found("WEB-HDR-03", "low", `GET ${base} → no Strict-Transport-Security`, "No HSTS", "The first request can be downgraded to HTTP.", "Send Strict-Transport-Security: max-age=31536000; includeSubDomains.", ["CWE-319"]));
  const powered = h.get("x-powered-by") ?? (/\d/.test(h.get("server") ?? "") ? h.get("server") : null);
  if (powered) out.push(found("API-LOG-01", "info", `${h.get("x-powered-by") ? "X-Powered-By" : "Server"}: ${powered}`, "Server software and version disclosed", "Version headers help attackers pick known exploits.", "Remove X-Powered-By (app.disable('x-powered-by')) and version numbers from Server.", ["CWE-200"]));

  for (const cookie of setCookies(h)) {
    const name = cookie.split("=")[0]!.trim();
    if (!/sess|sid|token|auth|jwt|remember|login/i.test(name)) continue;
    const missing = [!/;\s*httponly/i.test(cookie) && "HttpOnly", base.startsWith("https:") && !/;\s*secure/i.test(cookie) && "Secure", !/;\s*samesite=/i.test(cookie) && "SameSite"].filter(Boolean);
    if (missing.length) out.push(found("WEB-HDR-07", "medium", `Set-Cookie: ${name}=…; missing ${missing.join(", ")}`, `Session cookie ${name} without ${missing.join(", ")}`, "Without HttpOnly scripts (XSS) can steal it; without Secure it goes over HTTP; without SameSite other sites can send it (CSRF).", "Set HttpOnly; Secure; SameSite=Lax on session cookies.", ["CWE-1004", "CWE-614"]));
  }

  // CORS: does the app trust an origin it has never heard of?
  const probeOrigin = "https://cors-check.probe.invalid";
  const cors = await get(base, { origin: probeOrigin });
  const acao = cors?.headers.get("access-control-allow-origin");
  if (acao === probeOrigin || (acao === "*" && cors?.headers.get("access-control-allow-credentials") === "true")) {
    out.push(found("API-HTTP-01", cors?.headers.get("access-control-allow-credentials") === "true" ? "high" : "medium", `Origin: ${probeOrigin} → Access-Control-Allow-Origin: ${acao}${cors?.headers.get("access-control-allow-credentials") === "true" ? ", Allow-Credentials: true" : ""}`, "CORS trusts any origin", "Any website can call the app from a visitor's browser and read the answers (with their cookies when credentials are allowed).", "Allow only your own origins.", ["CWE-942"]));
  }

  // Paths that must never answer in a deployed app.
  const exposed: [string, RegExp, string, string, Severity][] = [
    ["/.env", /^[A-Z_]+=.+/m, "COM-SEC-03", ".env served over HTTP", "critical"],
    ["/.git/config", /\[core\]/, "COM-SEC-05", ".git folder served over HTTP", "high"],
    ["/actuator/env", /"propertySources"|"activeProfiles"/, "API-LOG-04", "Spring actuator env exposed", "high"],
    ["/actuator/heapdump", /JAVA PROFILE|HPROF/, "API-LOG-04", "Heap dump downloadable", "critical"],
    ["/debug/pprof/", /Types of profiles available|goroutine/, "API-LOG-04", "Go pprof exposed", "high"],
    ["/phpinfo.php", /phpinfo\(\)|PHP Version/, "API-LOG-04", "phpinfo exposed", "high"],
    ["/server-status", /Apache Server Status/, "API-LOG-04", "Apache server-status exposed", "medium"],
    ["/__debug__/", /djdt|Django Debug Toolbar/, "API-LOG-01", "Django debug toolbar exposed", "high"],
  ];
  for (const [path, signature, check, title, severity] of exposed) {
    const r = await get(`${base}${path}`);
    if (r && r.status === 200 && signature.test(r.body.slice(0, 20_000))) out.push(found(check, severity, `GET ${path} → 200`, title, "This path leaks configuration, secrets or memory to anyone who asks.", "Block the path (or the tool) in the deployed app; serve only what users need.", ["CWE-200"]));
  }

  // GraphQL introspection: useful in development, a map of the API in production.
  const gql = await post(`${base}/graphql`, { query: "{__schema{queryType{name}}}" });
  if (gql && gql.status === 200 && /"__schema"/.test(gql.body)) out.push(found("API-RES-04", "low", "POST /graphql {__schema} → 200", "GraphQL introspection enabled", "Introspection gives attackers the full schema, including admin fields.", "Disable introspection in production.", ["API9"]));

  // A stack trace on a bad request.
  const bad = await get(`${base}/%ff%fe/probe-${Date.now()}?id='"`);
  if (bad && /(at\s+[\w.$]+\s*\([^)]*:\d+:\d+\)|Traceback \(most recent call last\)|\.java:\d+\)|Exception in thread|<b>Warning<\/b>:.*on line)/.test(bad.body)) out.push(found("API-LOG-01", "medium", `GET ${new URL(bad.url).pathname} → stack trace in the response`, "Stack trace shown on errors", "Traces reveal file paths, libraries and queries.", "Return a generic error page and log details server-side.", ["CWE-209"]));
  return out;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string; url: string } | null> {
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return { status: res.status, headers: res.headers, body: await res.text().catch(() => ""), url };
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.text().catch(() => "") };
  } catch {
    return null;
  }
}

function setCookies(h: Headers): string[] {
  const all = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (all) return all;
  const one = h.get("set-cookie");
  return one ? one.split(/,(?=\s*\w+=)/) : [];
}

/**
 * The installed Android app on an emulator (or a real phone the user allowed): its package
 * flags, what it wrote to logcat, and, when it is debuggable, what its private files hold.
 */
export function androidRuntimeFindings(project: Project, pkg: string, rules: Rule[], log: (line: string) => void): SecurityFinding[] {
  const adb = Adb.forProject(project.root);
  const devices = listDevices(adb).filter((d) => d.emulator || project.config.devices.allowReal.includes(d.serial));
  if (!devices.length) {
    log("  no emulator running (real phones need devices.allowReal): skipped the device checks");
    return [];
  }
  const serial = devices[0]!.serial;
  const sh = (cmd: string) => adb.run(["-s", serial, "shell", cmd], 30_000);
  const dump = sh(`dumpsys package ${shQuote(pkg)}`);
  if (!dump.ok || !dump.out.includes(`Package [${pkg}]`)) {
    log(`  ${pkg} is not installed on ${serial}: skipped the device checks`);
    return [];
  }
  log(`  device ${serial}, package ${pkg}`);
  const out: SecurityFinding[] = [];
  const flags = /pkgFlags=\[([^\]]*)\]/.exec(dump.out)?.[1] ?? /flags=\[([^\]]*)\]/.exec(dump.out)?.[1] ?? "";
  const debuggable = /\bDEBUGGABLE\b/.test(flags);
  if (debuggable) out.push(found("AND-MAN-01", "info", `${pkg} flags: ${flags.trim()}`, "Installed build is debuggable", "Fine for a debug build; a release build must never be (run-as reads all private data).", "Check this on the release build: it must not show DEBUGGABLE.", ["CWE-215"]));
  if (/\bALLOW_BACKUP\b/.test(flags)) out.push(found("AND-MAN-02", "medium", `${pkg} flags include ALLOW_BACKUP`, "App data can be backed up", "adb backup and cloud backup copy tokens and databases off the device.", "Set allowBackup=false or exclude secrets with dataExtractionRules.", ["CWE-530"]));

  // Secrets the app logged, from the device's log buffer.
  const secretRules = rules.filter((r) => r.secret && r.match && !r.when && r.platform === "common");
  const pid = sh(`pidof ${shQuote(pkg)}`).out.trim().split(/\s+/)[0];
  const logcat = adb.run(["-s", serial, "logcat", "-d", "-v", "brief", ...(pid ? ["--pid", pid] : []), "-t", "20000"], 30_000).out;
  const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  const bearer = /\b(Authorization|Bearer|access_token|refresh_token|password)\b\s*[:=]?\s*\S{8,}/i;
  const logged = logcat.split("\n").filter((l) => jwt.test(l) || bearer.test(l) || secretRules.some((r) => r.match!.test(l))).slice(0, 5);
  if (logged.length) out.push(found("AND-LOG-04", "high", logged.map((l) => mask(l.slice(0, 160))).join(" | "), "Tokens or credentials in logcat", "Anything in logcat is readable over USB, in bug reports and by crash tools.", "Remove the logging (or redact it) and strip debug logs from release builds.", ["CWE-532", "MASTG-TEST-0003"]));

  // With a debuggable build, run-as shows exactly what is stored in plain files.
  if (debuggable) {
    const files = sh(`run-as ${shQuote(pkg)} sh -c 'ls shared_prefs/*.xml files/datastore/*.preferences_pb 2>/dev/null'`).out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 40);
    for (const file of files) {
      const text = sh(`run-as ${shQuote(pkg)} cat ${shQuote(file)}`).out;
      const hit = /(token|jwt|password|secret|session)[^<>"\n]{0,40}["'>=:]\s*([A-Za-z0-9._\-+/=]{16,})/i.exec(text) ?? jwt.exec(text);
      if (hit && !/encrypted|__androidx_security_crypto/i.test(text)) out.push(found("AND-STO-10", "critical", `${file}: ${mask(hit[0].slice(0, 120))}`, "Token stored in a plain file on the device", "Backups, rooted devices and forensic tools read this file directly.", "Store tokens with EncryptedSharedPreferences / Tink with an Android Keystore key.", ["CWE-312", "MASTG-TEST-0001"], file));
    }
  }
  return out;
}
