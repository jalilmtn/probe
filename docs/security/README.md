# Security check catalog

The full list of security checks Probe can run, one file per platform. This is the spec the security feature is built from; nothing here is implemented yet.

| File | Covers | Prefix |
|---|---|---|
| [common.md](common.md) | Every project: secrets, dependencies, CI/CD, containers & IaC, privacy, repo hygiene | `COM-` |
| [android.md](android.md) | Android apps: manifest, IPC, deep links, WebView, storage, crypto, network, auth, logging, build | `AND-` |
| [ios.md](ios.md) | iOS apps: Info.plist/entitlements, URL schemes, WKWebView, Keychain/storage, crypto, ATS, build | `IOS-` |
| [web-frontend.md](web-frontend.md) | Browser apps & extensions: XSS, bundle secrets, client auth, cross-origin, headers, PWA | `WEB-` |
| [backend.md](backend.md) | APIs & servers: authn, authz/IDOR, injection, SSRF, CORS/CSRF, rate limits, business logic; per-language patterns | `API-` |
| [cross-platform-mobile.md](cross-platform-mobile.md) | React Native, Flutter, KMP, Capacitor/Cordova, MAUI (on top of Android + iOS) | `XPM-`, `XRN-`, `XFL-`, `XKM-`, `XHY-`, `XMA-` |
| [desktop.md](desktop.md) | Electron, Tauri, native desktop | `DSK-` |

## Which files apply to a project

Probe picks them per feature from the modules it already maps:

| Detected | Catalogs |
|---|---|
| Any project | common |
| `AndroidManifest.xml`, Android Gradle plugin | common + android |
| `*.xcodeproj`, `Info.plist`, `Package.swift` with iOS platform | common + ios |
| KMP (`kotlin("multiplatform")`) | common + android + ios + cross-platform (XKM) |
| `react-native` / `expo` in package.json | common + android + ios + cross-platform (XPM, XRN) |
| `pubspec.yaml` with flutter | common + android + ios + cross-platform (XPM, XFL) |
| `@capacitor/*`, `cordova` | common + android + ios + web-frontend + cross-platform (XHY) |
| React/Vue/Angular/Svelte/Vite/Next client code | common + web-frontend |
| Express/Nest/Fastify/Next API, Django/Flask/FastAPI, Spring/Ktor, Go `net/http`, ASP.NET, Laravel, Rails | common + backend (+ that language's patterns) |
| `electron`, `@tauri-apps/*`, WPF/WinUI/AppKit | common + desktop (+ web-frontend for Electron/Tauri renderers) |

A monorepo gets several sets, each feature checked against the sets of its own modules.

## How a check runs

| Code | Method | Cost | Confidence |
|---|---|---|---|
| **S** | Static: rules over source and config files | cheap | high for config, medium for code patterns |
| **D** | Dependencies: lockfiles against OSV | cheap | high |
| **G** | Git history scan | cheap–medium | high |
| **B** | Built artifact: APK/AAB/IPA/bundle/package | medium (needs a build) | high, and proves what actually ships |
| **R** | Runtime: on a device/emulator/simulator, or against the local server | medium–high | high, but only on the user's own app and localhost |
| **A** | Agent review: an LLM reads the feature's code against the check | high | advisory, needs a person to confirm |

## Severity

Each check lists a **default** severity. A finding keeps it only when there is a real attack path in this project; otherwise it is lowered (or dismissed with a reason, which Probe remembers).

| Level | Meaning |
|---|---|
| Critical | Directly exploitable: account takeover, key theft, remote code execution, data of all users |
| High | Exploitable with a realistic precondition: malicious app on the device, MITM, a logged-in attacker |
| Medium | Weakens protection or needs several conditions |
| Low | Hardening / hygiene |
| Info | Worth knowing, no fix required |

## What every finding records

- check id (e.g. `AND-WEB-07`), severity, CWE / OWASP refs
- file and line, plus the evidence (the matched code or the observed behaviour)
- why it matters here: the attack path in one or two sentences
- the fix, and how Probe will re-check it (the same rule on the changed files, plus the feature's unit tests)

These feed the existing issue → fix prompt → Fix it flow.

## Standards used

OWASP MASVS v2 / MASTG (mobile), OWASP Top 10 2021, OWASP API Security Top 10 2023, OWASP ASVS 4, OWASP WSTG, OWASP Top 10 for LLM apps, CWE.
