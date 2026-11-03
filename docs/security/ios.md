# iOS security checks

Applies to: iOS / iPadOS apps (Swift, Objective-C, SwiftUI/UIKit, Xcode projects, SwiftPM/CocoaPods). Also covers the iOS side of Flutter and React Native apps.
Standards: OWASP MASVS v2 / MASTG, CWE. Shared checks are in [common.md](common.md).

How: **S** static, **D** dependencies, **B** built IPA/app bundle, **R** runtime on simulator/device, **A** agent review.

## 1. App config (Info.plist, entitlements)

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-CFG-01 | ATS disabled | `NSAllowsArbitraryLoads = YES`, `NSAllowsArbitraryLoadsInWebContent`, `NSAllowsLocalNetworking` in release | S, B | High | CWE-319 |
| IOS-CFG-02 | ATS exceptions per domain | `NSExceptionDomains` with `NSExceptionAllowsInsecureHTTPLoads`, `NSExceptionMinimumTLSVersion` < 1.2 | S | Medium | CWE-319 |
| IOS-CFG-03 | Entitlements broader than needed | `get-task-allow` true in release, unused App Groups, iCloud containers, keychain-access-groups shared widely | S, B | Medium | MASVS-PLATFORM |
| IOS-CFG-04 | Usage descriptions for unused permissions | `NS*UsageDescription` (camera, location always, contacts) with no feature | S, A | Low | MASVS-PRIVACY |
| IOS-CFG-05 | Missing privacy manifest | no `PrivacyInfo.xcprivacy`, or required-reason APIs used without declaration | S | Low | App Store policy |
| IOS-CFG-06 | Background modes not needed | `UIBackgroundModes` like `location`, `voip` without feature | S | Low | — |
| IOS-CFG-07 | Debug config in release scheme | `DEBUG` flags, `ENABLE_TESTABILITY`, test endpoints in Release configuration | S | Medium | CWE-489 |

## 2. URL schemes, universal links & extensions

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-LNK-01 | Custom scheme for sensitive flows | OAuth redirect / reset links on `myapp://` (any app can claim it) | S | High | CWE-939 |
| IOS-LNK-02 | URL handler input not validated | `application(_:open:)`, `onOpenURL`, `scene(_:openURLContexts:)` using params to navigate, load WebViews, perform actions | S, A | High | CWE-20 |
| IOS-LNK-03 | Universal link config wrong | `apple-app-site-association` missing, wrong team/bundle id, `paths: ["*"]` | R | Medium | — |
| IOS-LNK-04 | Links skip auth / confirmation | link performs state-changing action without user confirmation or login | R, A | High | CWE-352 |
| IOS-LNK-05 | `sourceApplication` trusted | security decisions based on calling app identity | S | Medium | CWE-290 |
| IOS-LNK-06 | App extension data leaks | share/keyboard/widget extensions reading the shared App Group container with secrets | S, A | Medium | MASVS-PLATFORM |
| IOS-LNK-07 | Custom keyboards allowed on secure fields | no `shouldAllowExtensionPointIdentifier` blocking third-party keyboards in sensitive apps | S | Low | — |
| IOS-LNK-08 | Pasteboard leaks | `UIPasteboard.general` with tokens/passwords, no `localOnly`/expiration | S | Low | CWE-200 |

## 3. WebViews

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-WEB-01 | `UIWebView` still used | deprecated, no JS control, rejected by App Store | S | Medium | — |
| IOS-WEB-02 | JS bridge exposed to any origin | `WKScriptMessageHandler` acting on messages without checking `frameInfo.securityOrigin` | S, A | High | CWE-749 |
| IOS-WEB-03 | No navigation allowlist | `decidePolicyFor navigationAction` allowing everything; URLs from links/push loaded directly | S, A | High | CWE-939 |
| IOS-WEB-04 | File access from file URLs | `allowFileAccessFromFileURLs`, `loadFileURL(allowingReadAccessTo: /)` too wide | S | High | CWE-200 |
| IOS-WEB-05 | TLS errors ignored | `didReceive challenge` → `.useCredential` for any server trust | S | Critical | CWE-295 |
| IOS-WEB-06 | JS injection | `evaluateJavaScript` with interpolated untrusted strings | S | High | CWE-79 |
| IOS-WEB-07 | Inspectable in release | `isInspectable = true` not gated on DEBUG | S | Low | CWE-489 |

## 4. Data storage

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-STO-01 | Secrets in `UserDefaults` | tokens, passwords, keys in `UserDefaults` / `@AppStorage` / plist files | S, R | Critical | CWE-312 |
| IOS-STO-02 | Weak Keychain accessibility | `kSecAttrAccessibleAlways`, `…AfterFirstUnlock` for high-value items; not `ThisDeviceOnly` when it should be | S | Medium | MASVS-STORAGE |
| IOS-STO-03 | Missing file protection | files written without `.completeFileProtection` / `NSFileProtectionComplete`; app default protection lowered | S | Medium | CWE-311 |
| IOS-STO-04 | Core Data / SQLite / Realm unencrypted with PII | stores holding messages, PII, tokens without encryption | S, R | High | CWE-312 |
| IOS-STO-05 | Sensitive data backed up | sensitive files not marked `isExcludedFromBackup` | S | Low | MASVS-STORAGE |
| IOS-STO-06 | Cache leaks | `URLCache` storing authenticated responses; images/PDFs of private content in `Caches` | S, R | Low | CWE-524 |
| IOS-STO-07 | Keyboard cache / autocorrect | secure fields without `isSecureTextEntry`, `autocorrectionType = .no` | S | Low | — |
| IOS-STO-08 | Snapshot on backgrounding | sensitive screen captured in the app switcher snapshot (no blur/overlay in `sceneWillResignActive`) | S, R | Low | MASVS-PLATFORM |
| IOS-STO-09 | Keychain not cleared on reinstall | stale tokens survive uninstall (first-launch wipe missing) | A | Low | — |
| IOS-STO-10 | What's actually in the container | dump the simulator app container after login; grep for tokens, emails, passwords | R | — | MASTG |

## 5. Cryptography

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-CRY-01 | Hard-coded keys | keys in source, `Info.plist`, `.xcconfig`, asset catalogs | S, B | Critical | CWE-321 |
| IOS-CRY-02 | CommonCrypto misuse | `kCCOptionECBMode`, zero/constant IV, `CCCrypt` without MAC | S | High | CWE-327, CWE-329 |
| IOS-CRY-03 | Weak hashes | `CC_MD5`, `CC_SHA1`, `Insecure.MD5` for security | S | Medium | CWE-328 |
| IOS-CRY-04 | Insecure random | `arc4random` fine; `rand()`, `random()`, seeded generators for tokens | S | High | CWE-338 |
| IOS-CRY-05 | Keys not in Keychain / Secure Enclave | key material in files; `SecKeyCreateRandomKey` without `kSecAttrTokenIDSecureEnclave` where expected | S, A | Medium | MASVS-CRYPTO |
| IOS-CRY-06 | Biometric not bound to Keychain | `LAContext.evaluatePolicy` result used as a boolean gate instead of `SecAccessControl` with `.biometryCurrentSet` | S | Medium | MASVS-AUTH |

## 6. Network & TLS

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-NET-01 | Server trust bypass | `URLSessionDelegate` accepting any `serverTrust`; Alamofire `DisabledTrustEvaluator` / `.disableEvaluation` | S | Critical | CWE-295 |
| IOS-NET-02 | No pinning on sensitive hosts | no `NSPinnedDomains`, `PinnedCertificatesTrustEvaluator`, TrustKit | S | Medium | MASVS-NETWORK |
| IOS-NET-03 | `http://` endpoints | base URLs in code, plist, xcconfig | S, B | Medium | CWE-319 |
| IOS-NET-04 | Secrets in query strings | API keys in URLs | S | Medium | CWE-598 |
| IOS-NET-05 | Network logging in release | request/response body loggers, Pulse, netfox not gated | S | High | CWE-532 |
| IOS-NET-06 | MITM test | proxy with a user-trusted CA; see which hosts accept it | R | — | MASTG |

## 7. Authentication & session

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-AUT-01 | OAuth without `ASWebAuthenticationSession` / PKCE | login in embedded WKWebView, no `code_verifier` | S | High | RFC 8252 |
| IOS-AUT-02 | Client-side entitlement checks | premium/admin flags trusted locally; receipt validation only on device | S, A | High | CWE-602 |
| IOS-AUT-03 | Logout leaves data | Keychain items, caches, cookies (`HTTPCookieStorage`, `WKWebsiteDataStore`) remain | R, A | Medium | CWE-613 |
| IOS-AUT-04 | Sign in with Apple / nonce misuse | missing or reused nonce in Apple/Google sign-in | S | Medium | — |
| IOS-AUT-05 | Request signing with shipped key | HMAC with a key in the bundle | S | Critical | CWE-345 |

## 8. Logging & privacy

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-LOG-01 | Secrets in logs | `print`, `NSLog`, `os_log` with `%{public}` on tokens/PII | S | Medium | CWE-532 |
| IOS-LOG-02 | Crash / analytics PII | Crashlytics, Sentry, Firebase Analytics receiving PII or tokens | S, A | Medium | CWE-532 |
| IOS-LOG-03 | Tracking without ATT | IDFA access without `ATTrackingManager` prompt | S | Medium | App Store policy |
| IOS-LOG-04 | Device log check | run main flows, inspect Console / `log stream` for secrets | R | — | — |

## 9. Build, binary & resilience

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-BLD-01 | Secrets in the shipped binary | `strings` on the Mach-O, plist, bundled JSON, `.xcconfig` values baked in | B | Critical | CWE-798 |
| IOS-BLD-02 | Signing material in repo | `.p12`, `.mobileprovision`, `.p8` (App Store Connect / APNs keys) tracked | S | Critical | CWE-522 |
| IOS-BLD-03 | Binary hardening off | PIE missing, stack canaries / ARC disabled (`-fno-stack-protector`) | B | Low | CWE-693 |
| IOS-BLD-04 | Debug symbols / dSYM shipped | dSYM or symbol tables in the IPA | B | Info | — |
| IOS-BLD-05 | No jailbreak / tamper detection where required | banking/payment apps without integrity checks; no App Attest / DeviceCheck | A | Info | MASVS-RESILIENCE |
| IOS-BLD-06 | Dynamic code / JS download | executing downloaded JS (JSContext) or code push outside policy | S | Medium | CWE-494 |
| IOS-BLD-07 | Unsafe C APIs | `strcpy`, `sprintf`, `gets`, unchecked `memcpy` in ObjC/C | S | Medium | CWE-120 |
| IOS-BLD-08 | Format strings | `NSLog(userString)`, `stringWithFormat:` with untrusted format | S | Medium | CWE-134 |

## 10. Injection & parsing

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| IOS-INJ-01 | SQL built from strings | `sqlite3_exec` / FMDB / GRDB with interpolated input | S | High | CWE-89 |
| IOS-INJ-02 | NSPredicate injection | `NSPredicate(format:)` built from user input | S | Medium | CWE-943 |
| IOS-INJ-03 | Unsafe archive decoding | `NSKeyedUnarchiver.unarchiveObject` (non-secure coding) on untrusted data | S | High | CWE-502 |
| IOS-INJ-04 | XXE | `XMLParser` with `shouldResolveExternalEntities = true` | S | Medium | CWE-611 |
| IOS-INJ-05 | Zip slip | unzipping (ZIPFoundation, SSZipArchive) without path checks | S | High | CWE-22 |
