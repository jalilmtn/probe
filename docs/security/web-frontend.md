# Web frontend security checks

Applies to: browser apps and sites — React, Next.js (client side), Vue/Nuxt, Angular, Svelte, plain JS/TS, static sites, browser extensions (section 9).
Standards: OWASP Top 10 2021, OWASP ASVS 4, OWASP WSTG, CWE. Server-side rendering and API routes are in [backend.md](backend.md); shared checks in [common.md](common.md).

How: **S** static, **D** dependencies, **B** built bundle, **R** runtime against the local dev/preview server, **A** agent review.

## 1. XSS & DOM injection

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-XSS-01 | Raw HTML rendering | `dangerouslySetInnerHTML`, `v-html`, `[innerHTML]`, `{@html}`, `innerHTML =`, `outerHTML`, `insertAdjacentHTML`, `document.write` with non-constant data | S | High | CWE-79 |
| WEB-XSS-02 | Sanitiser missing or misused | HTML rendered without DOMPurify; DOMPurify config allowing `script`/`on*`; Angular `bypassSecurityTrust*` | S | High | CWE-79 |
| WEB-XSS-03 | `javascript:` URLs | `href`/`src` bound to user/server values without scheme check | S | High | CWE-79 |
| WEB-XSS-04 | Code from strings | `eval`, `new Function`, `setTimeout("string")`, `setInterval("string")` | S | High | CWE-95 |
| WEB-XSS-05 | DOM sources to sinks | `location.hash/search`, `document.referrer`, `window.name`, `postMessage` data flowing into sinks | S, A | High | CWE-79 |
| WEB-XSS-06 | Markdown / rich text rendering | markdown libs with HTML enabled (`marked` without sanitize, `markdown-it` `html: true`) | S | Medium | CWE-79 |
| WEB-XSS-07 | Template injection on client | Vue/Angular templates compiled from user strings | S | High | CWE-1336 |
| WEB-XSS-08 | Reflected / stored XSS test | inject payloads into the app's own forms and URL params, see if they execute | R | — | WSTG-INPV-01/02 |
| WEB-XSS-09 | Prototype pollution | deep merge / `lodash.merge`/`set` with user objects, `__proto__` keys from query parsing | S, D | Medium | CWE-1321 |

## 2. Secrets & data in the bundle

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-SEC-01 | Server secrets shipped to the browser | `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` holding secret keys; service-role keys (Supabase), Stripe secret keys, OpenAI keys in client code | S, B | Critical | CWE-798 |
| WEB-SEC-02 | Source maps in production | `.map` files served, `productionSourceMap: true`, `devtool: 'source-map'` | B, R | Low | CWE-540 |
| WEB-SEC-03 | Internal URLs / debug endpoints in bundle | staging hosts, admin APIs, feature flags that unlock hidden features | B | Low | CWE-200 |
| WEB-SEC-04 | Firebase / Supabase rules | client SDK with permissive Firestore/RTDB/Storage rules or RLS disabled | S, A | Critical | CWE-284 |
| WEB-SEC-05 | Map/analytics keys unrestricted | Google Maps etc. keys without HTTP referrer restriction | A | Low | — |

## 3. Auth & session on the client

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-AUT-01 | Tokens in Web Storage | access/refresh tokens in `localStorage`/`sessionStorage`/IndexedDB (readable by any XSS) | S | Medium | CWE-922 |
| WEB-AUT-02 | Authorization only in the UI | routes/buttons hidden by role on the client while the API doesn't check | S, A, R | High | CWE-602 |
| WEB-AUT-03 | OAuth implicit flow / no PKCE / no state | `response_type=token`, missing `state` or `code_verifier` | S | High | CWE-352 |
| WEB-AUT-04 | JWT decoded and trusted on client | role/claims from `jwt-decode` used to unlock data without server check | S | Medium | CWE-345 |
| WEB-AUT-05 | Logout incomplete | tokens/caches/service-worker caches survive logout; no server revoke | R, A | Medium | CWE-613 |
| WEB-AUT-06 | Password field hygiene | `autocomplete` wrong on password/OTP fields; password shown in URL (GET forms) | S | Low | CWE-598 |

## 4. Cross-origin & messaging

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-ORG-01 | `postMessage` without origin check | `addEventListener('message')` handler not checking `event.origin` | S | High | CWE-346 |
| WEB-ORG-02 | `postMessage` to `*` | `targetWindow.postMessage(data, '*')` with sensitive data | S | Medium | CWE-201 |
| WEB-ORG-03 | Open redirect | `window.location = params.get('next')`, router redirects to unvalidated URLs | S, R | Medium | CWE-601 |
| WEB-ORG-04 | Reverse tabnabbing | `target="_blank"` to untrusted URLs without `rel="noopener"` (old browsers) | S | Low | CWE-1022 |
| WEB-ORG-05 | Iframes of untrusted content without sandbox | `<iframe>` user URLs without `sandbox` | S | Medium | CWE-1021 |
| WEB-ORG-06 | Credentials sent cross-origin | `fetch(..., {credentials: 'include'})` to third-party hosts | S | Medium | CWE-201 |

## 5. Security headers & browser policy (served by the app)

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-HDR-01 | No Content-Security-Policy | missing CSP, or `unsafe-inline`/`unsafe-eval`/`*` in `script-src` | R, S | Medium | CWE-693 |
| WEB-HDR-02 | No clickjacking protection | missing `frame-ancestors` / `X-Frame-Options` | R | Medium | CWE-1021 |
| WEB-HDR-03 | No HSTS | missing `Strict-Transport-Security` on HTTPS | R | Low | CWE-319 |
| WEB-HDR-04 | MIME sniffing | missing `X-Content-Type-Options: nosniff` | R | Low | — |
| WEB-HDR-05 | Referrer leaks | no `Referrer-Policy`; tokens in URLs leaking via Referer | R, S | Low | CWE-200 |
| WEB-HDR-06 | Permissions-Policy | camera/mic/geolocation not restricted | R | Info | — |
| WEB-HDR-07 | Cookie flags | auth cookies without `Secure`, `HttpOnly`, `SameSite` | R | Medium | CWE-614, CWE-1004 |
| WEB-HDR-08 | Mixed content | `http://` scripts, images, APIs on HTTPS pages | S, R | Medium | CWE-319 |
| WEB-HDR-09 | Subresource Integrity | third-party CDN scripts without `integrity` | S | Low | CWE-353 |

## 6. Third-party scripts & supply chain (frontend-specific)

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-3P-01 | Third-party scripts with full page access | tag managers, chat widgets, analytics loaded on login/payment pages | S, A | Medium | CWE-829 |
| WEB-3P-02 | Abandoned/compromised CDN hosts | `polyfill.io`-style domains, unpinned `latest` URLs | S | High | CWE-829 |
| WEB-3P-03 | Vulnerable client libraries | old jQuery, Angular.js 1.x, Bootstrap with XSS CVEs | D | Medium | CWE-1104 |

## 7. Storage, caching & PWA

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-STO-01 | PII in Web Storage | personal data persisted unencrypted in `localStorage` | S | Low | CWE-312 |
| WEB-STO-02 | Service worker caches authenticated responses | Workbox runtime caching of `/api/*` with user data | S | Medium | CWE-524 |
| WEB-STO-03 | Service worker scope too broad / from untrusted path | SW registered from a path users can upload to | S | High | — |
| WEB-STO-04 | Sensitive data in URLs | tokens, emails in query params (history, logs, Referer) | S, R | Medium | CWE-598 |

## 8. Forms, uploads & client validation

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-FRM-01 | Validation only on client | limits, prices, roles enforced only in form code | A, R | High | CWE-602 |
| WEB-FRM-02 | CSRF | state-changing requests with cookie auth and no CSRF token / SameSite | R, A | High | CWE-352 |
| WEB-FRM-03 | Uploads previewed unsafely | SVG/HTML uploads rendered inline from the same origin | S, R | High | CWE-79 |
| WEB-FRM-04 | ReDoS | user input matched against catastrophic regexes | S | Low | CWE-1333 |

## 9. Browser extensions

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| WEB-EXT-01 | Over-broad permissions | `<all_urls>`, `tabs`, `cookies`, `webRequest` not needed | S | Medium | — |
| WEB-EXT-02 | Content script ↔ page trust | content scripts trusting page `postMessage` / DOM data | S, A | High | CWE-346 |
| WEB-EXT-03 | `externally_connectable` open | any site can message the extension | S | High | CWE-346 |
| WEB-EXT-04 | Remote code | loading remote scripts (MV3 forbids), `eval` | S | High | CWE-494 |
| WEB-EXT-05 | Secrets in extension storage | tokens in `chrome.storage.sync` | S | Medium | CWE-312 |
