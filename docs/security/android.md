# Android security checks

Applies to: Android apps (Gradle, Kotlin/Java, native NDK code). Built from a real Android audit plus the gaps that audit listed for follow-up.
Standards: OWASP MASVS v2 / MASTG, CWE. Shared checks (secrets, dependencies, CI) are in [common.md](common.md).

How each check runs: **S** static (source/config), **D** dependencies, **B** built APK/AAB, **R** runtime on a device or emulator, **A** agent review. **Sev** is the default; the real severity depends on the attack path found.

## 1. Manifest & app config

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-MAN-01 | App is debuggable in release | `android:debuggable="true"`, `isDebuggable = true` on a release build type | S, B | High | CWE-215, MASVS-RESILIENCE |
| AND-MAN-02 | Backup exposes app data | `allowBackup="true"` without rules; `fullBackupContent` / `dataExtractionRules` that include tokens, DBs, prefs | S | Medium | CWE-530, MASVS-STORAGE |
| AND-MAN-03 | Backup/transfer rules include secrets (Android 12+) | `data_extraction_rules.xml` cloud-backup and device-transfer sections not excluding token store / credential files | S | Medium | MASVS-STORAGE |
| AND-MAN-04 | Cleartext traffic allowed app-wide | `usesCleartextTraffic="true"`, `cleartextTrafficPermitted="true"` in base-config | S, B | High | CWE-319, MASVS-NETWORK |
| AND-MAN-05 | No network security config | missing `networkSecurityConfig` attribute / `network_security_config.xml` | S, B | Medium | MASVS-NETWORK |
| AND-MAN-06 | User-installed CAs trusted in release | `<certificates src="user"/>` outside `debug-overrides` | S | High | CWE-295 |
| AND-MAN-07 | Old minSdk / targetSdk | `minSdk` < 23 (no runtime perms, weak TLS), `targetSdk` behind Play's current requirement | S | Low | MASVS-CODE |
| AND-MAN-08 | Dangerous or unused permissions | `READ_SMS`, `READ_CALL_LOG`, `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, `REQUEST_INSTALL_PACKAGES` with no feature using them | S, A | Medium | MASVS-PRIVACY |
| AND-MAN-09 | Custom permission protection too weak | `<permission>` with `protectionLevel="normal"` guarding sensitive components; typo'd permission names | S | Medium | CWE-276 |
| AND-MAN-10 | `taskAffinity` / `launchMode` enables task hijacking (StrandHogg) | non-default `taskAffinity`, `singleTask` on sensitive activities, `allowTaskReparenting` | S | Medium | CWE-1021 |
| AND-MAN-11 | Tooling/debug components shipped | `PreviewActivity`, Chucker, LeakCanary, Flipper, Stetho, debug drawers present in the release manifest | B | Low | MASVS-CODE |
| AND-MAN-12 | `sharedUserId` used | `android:sharedUserId` (deprecated, widens trust between apps) | S | Low | CWE-266 |

## 2. Exported components & IPC

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-IPC-01 | Exported activity without a permission | `exported="true"` (or implicit via intent-filter on targetSdk < 31) and no `android:permission` | S, B | Medium–High | CWE-926 |
| AND-IPC-02 | Exported service without a permission | same for `<service>`, especially bound services with AIDL | S, B | High | CWE-926 |
| AND-IPC-03 | Exported broadcast receiver without a permission | `<receiver exported="true">`; `registerReceiver` without `RECEIVER_NOT_EXPORTED` (Android 14+) | S | Medium | CWE-925 |
| AND-IPC-04 | Exported content provider | `<provider exported="true">` with no read/write permission; `grantUriPermissions="true"` on a wide path | S, B | High | CWE-200 |
| AND-IPC-05 | Content provider SQL injection | `query()` building SQL from `selection`/`sortOrder` without `SQLiteQueryBuilder.setStrict` / projection map | S, A | High | CWE-89 |
| AND-IPC-06 | Content provider path traversal | `openFile()` using `uri.lastPathSegment` / `getPath()` without canonicalising | S | High | CWE-22 |
| AND-IPC-07 | Intent redirection | exported component reads an `Intent` from extras (`getParcelableExtra("intent")`) and calls `startActivity` with it | S, A | High | CWE-940 |
| AND-IPC-08 | Implicit intent carrying sensitive data | `sendBroadcast`/`startActivity` with an implicit intent and tokens/PII in extras | S | Medium | CWE-927 |
| AND-IPC-09 | Mutable or implicit PendingIntent | `FLAG_MUTABLE` without need; PendingIntent wrapping an implicit intent; `FLAG_UPDATE_CURRENT` with untrusted extras | S | Medium | CWE-927 |
| AND-IPC-10 | Untrusted extras trusted | navigation route, URL or user id taken from extras (push, notification, share) without validation | S, A | Medium | CWE-20 |
| AND-IPC-11 | Share/`SEND` handler trusts incoming URIs | accepts `file://`, accepts `content://` pointing at the app's own provider, no MIME/size checks | S, A | Medium | CWE-73 |
| AND-IPC-12 | Unsafe Parcelable / Serializable | `readSerializable`, `getSerializableExtra` on exported paths; Parcel mismatch bugs | S | Medium | CWE-502 |
| AND-IPC-13 | Exported component reachable on device | actually launch every exported component with `adb shell am start/startservice/broadcast` and empty / hostile extras | R | — | MASTG-TEST-0029 |

## 3. Deep links & App Links

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-LNK-01 | `http(s)` link filter without `autoVerify` | VIEW + BROWSABLE `https` filter missing `autoVerify="true"`; duplicate unverified filters next to verified ones | S, B | High | CWE-939 |
| AND-LNK-02 | `assetlinks.json` missing or wrong | `/.well-known/assetlinks.json` absent, wrong package or SHA-256 cert | R | Medium | MASVS-PLATFORM |
| AND-LNK-03 | Custom scheme used for sensitive flows | OAuth redirect, password reset, magic link on `myapp://` (hijackable by any app) | S | High | CWE-939 |
| AND-LNK-04 | Deep link parameters not validated | host/path/query used to open URLs, WebViews, files or screens without allowlist | S, A | High | CWE-20 |
| AND-LNK-05 | Deep link skips auth | link opens a screen that should require login or re-auth | R, A | High | CWE-306 |
| AND-LNK-06 | Overly broad path pattern | `pathPattern="/.*"` capturing paths the app doesn't handle | S | Low | — |

## 4. WebView

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-WEB-01 | JS bridge exposed to any origin | `addJavascriptInterface` while loading URLs not on an allowlist | S, A | High | CWE-749 |
| AND-WEB-02 | No URL allowlist | `loadUrl` with URLs from deep links, push, server, intents; `shouldOverrideUrlLoading` returning false for everything | S, A | High | CWE-939 |
| AND-WEB-03 | `intent://` handling | `Intent.parseUri` from page URLs, launching components or honouring `browser_fallback_url` without filtering | S | High | CWE-470 |
| AND-WEB-04 | File access enabled | `setAllowFileAccess(true)`, `allowFileAccessFromFileURLs`, `allowUniversalAccessFromFileURLs` | S | High | CWE-200 |
| AND-WEB-05 | Content access enabled | `setAllowContentAccess(true)` with a loaded remote page | S | Medium | — |
| AND-WEB-06 | Mixed content allowed | `MIXED_CONTENT_ALWAYS_ALLOW` | S | Medium | CWE-319 |
| AND-WEB-07 | SSL errors ignored | `onReceivedSslError { handler.proceed() }` | S | Critical | CWE-295 |
| AND-WEB-08 | JS string building | `evaluateJavascript` / `loadUrl("javascript:…")` concatenating untrusted data | S | High | CWE-79 |
| AND-WEB-09 | Debugging on in release | `WebView.setWebContentsDebuggingEnabled(true)` not gated on debug | S | Medium | CWE-489 |
| AND-WEB-10 | Cookies / tokens shared with untrusted pages | `CookieManager` third-party cookies on, auth headers added to all URLs | S, A | Medium | CWE-201 |
| AND-WEB-11 | Safe Browsing disabled | `<meta-data android:name="android.webkit.WebView.EnableSafeBrowsing" android:value="false">` | S | Low | — |

## 5. Data storage

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-STO-01 | Tokens stored in plaintext | access/refresh tokens, session ids in SharedPreferences / DataStore without encryption | S, R | Critical | CWE-312, CWE-922 |
| AND-STO-02 | Credentials stored at all | passwords (even "encrypted") persisted on device | S | Critical | CWE-256 |
| AND-STO-03 | Database unencrypted with PII | Room/SQLite holding messages, PII, tokens without SQLCipher | S, R | High | CWE-312 |
| AND-STO-04 | External/shared storage for private data | `getExternalStorageDirectory`, `MediaStore` writes of private files, `Environment.DIRECTORY_DOWNLOADS` | S | High | CWE-922 |
| AND-STO-05 | World-readable/writable modes | `MODE_WORLD_READABLE`, `MODE_WORLD_WRITEABLE`, `chmod 777`, `setReadable(true, false)` | S | High | CWE-276 |
| AND-STO-06 | Sensitive data in cache / temp | files with tokens or PII in `cacheDir` / `createTempFile` not cleaned | S, R | Low | CWE-459 |
| AND-STO-07 | FileProvider paths too broad | `<root-path>`, `path="."` on cache/files/external | S | Medium | CWE-200 |
| AND-STO-08 | Keyboard cache / autofill on secrets | password/OTP fields without `inputType=textPassword` / `importantForAutofill` rules; `textNoSuggestions` missing | S | Low | MASVS-STORAGE |
| AND-STO-09 | Clipboard exposure | tokens, OTPs, passwords copied without `EXTRA_IS_SENSITIVE` (Android 13+) or auto-clear | S | Low | CWE-200 |
| AND-STO-10 | What's actually on disk | dump `/data/data/<pkg>` on a debug/rooted emulator after login; grep for tokens, emails, passwords | R | — | MASTG-TEST-0001 |

## 6. Cryptography

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-CRY-01 | Hard-coded key | AES/HMAC/EC keys in source, `BuildConfig`, resources, native strings | S, B | Critical | CWE-321 |
| AND-CRY-02 | Static or zero IV | `IvParameterSpec(ByteArray(16))`, constant IV, IV derived from key | S | Critical | CWE-329 |
| AND-CRY-03 | Weak mode | `AES/ECB`, `"AES"` with no mode (defaults to ECB), CBC without MAC | S | High | CWE-327 |
| AND-CRY-04 | Weak algorithm | DES, 3DES, RC4, MD5/SHA-1 for integrity or passwords | S | High | CWE-327, CWE-328 |
| AND-CRY-05 | Insecure random | `java.util.Random`, `Math.random`, seeded `SecureRandom` for tokens/keys/IVs | S | High | CWE-338 |
| AND-CRY-06 | Keys not in Android Keystore | key material generated/stored in app files instead of `AndroidKeyStore` | S, A | High | MASVS-CRYPTO |
| AND-CRY-07 | Weak key derivation | password → key with plain hash, low PBKDF2 iterations, no salt | S | High | CWE-916 |
| AND-CRY-08 | Outdated crypto library | SpongyCastle, old Bouncy Castle, Conscrypt pins | D | Medium | CWE-1104 |
| AND-CRY-09 | Home-made crypto / signing | custom XOR "encryption", client-side HMAC signing as a security control | S, A | High | CWE-327 |
| AND-CRY-10 | Biometric not bound to crypto | `BiometricPrompt` without a `CryptoObject` (bypassable with hooking) | S | Medium | MASVS-AUTH |

## 7. Network & TLS

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-NET-01 | Trust-all TrustManager | custom `X509TrustManager` with empty `checkServerTrusted` | S | Critical | CWE-295 |
| AND-NET-02 | Hostname verification off | `HostnameVerifier { _, _ -> true }`, `ALLOW_ALL_HOSTNAME_VERIFIER` | S | Critical | CWE-297 |
| AND-NET-03 | No certificate pinning on sensitive APIs | no `CertificatePinner` / `<pin-set>` for auth and payment hosts | S | Medium | MASVS-NETWORK |
| AND-NET-04 | Pinning without backup pin / expiry | single pin, no `expiration` — bricks app on rotation | S | Medium | — |
| AND-NET-05 | `http://` URLs in code/config | base URLs, endpoints, image hosts | S, B | Medium | CWE-319 |
| AND-NET-06 | Secrets in query strings | `api_key`, `client_secret`, tokens appended to URLs | S | Medium | CWE-598 |
| AND-NET-07 | HTTP logging in release | OkHttp `HttpLoggingInterceptor.Level.BODY` / Chucker not gated on debug | S | High | CWE-532 |
| AND-NET-08 | No retry/backoff | 429/503 retry storms | S | Low | — |
| AND-NET-09 | MITM test | run the app through a proxy with a user CA installed; see which hosts accept it | R | — | MASTG-TEST-0021 |

## 8. Authentication & session

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-AUT-01 | Client-side auth decisions | `isPremium`, `isAdmin`, PIN check done locally and trusted to unlock server data | S, A | High | CWE-602 |
| AND-AUT-02 | Tokens never expire / refresh unprotected | no expiry handling, refresh token reused indefinitely | A | Medium | CWE-613 |
| AND-AUT-03 | Logout doesn't clear state | tokens, DB, caches, WebView cookies left after logout | R, A | Medium | CWE-613 |
| AND-AUT-04 | OAuth without PKCE / via WebView | custom-tab-less OAuth in WebView, no `code_verifier` | S | High | RFC 8252 |
| AND-AUT-05 | Request signing with a shipped key | HMAC/nonce computed with a key in the APK (forgeable) | S | Critical | CWE-345 |
| AND-AUT-06 | Replay possible | signed requests without nonce/timestamp | A | Medium | CWE-294 |
| AND-AUT-07 | Local PIN / biometric bypass | lock screen state stored in prefs, bypass via exported activity | R, A | High | CWE-287 |

## 9. Privacy & UI

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-PRV-01 | No `FLAG_SECURE` on sensitive screens | login, OTP, payment, private content screens | S, R | Low | MASVS-PLATFORM |
| AND-PRV-02 | Tapjacking / overlay | sensitive buttons without `filterTouchesWhenObscured` / `setHideOverlayWindows` | S | Low | CWE-1021 |
| AND-PRV-03 | Sensitive data in notifications | OTPs, messages visible on lock screen (`VISIBILITY_PUBLIC`) | S | Low | CWE-200 |
| AND-PRV-04 | Device identifiers | IMEI, MAC, `ANDROID_ID` sent to third parties | S, A | Low | MASVS-PRIVACY |
| AND-PRV-05 | Third-party SDK data collection | analytics/ads SDKs receiving PII; Data Safety form mismatch | A | Medium | MASVS-PRIVACY |
| AND-PRV-06 | Recents thumbnail leaks | sensitive screen visible in the app switcher | R | Low | — |

## 10. Logging

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-LOG-01 | Secrets in logs | `Log.*`, Timber, custom loggers printing tokens, passwords, OTPs, (even their lengths) | S | Medium | CWE-532 |
| AND-LOG-02 | Logs forwarded to crash/analytics | Crashlytics/Sentry breadcrumbs carrying PII or tokens | S, A | Medium | CWE-532 |
| AND-LOG-03 | Verbose logs not stripped in release | no R8 `-assumenosideeffects` for `Log.d/v`; logger not gated | S, B | Low | — |
| AND-LOG-04 | What logcat shows | run a login + main flows, grep logcat for tokens, emails, passwords | R | — | MASTG-TEST-0003 |

## 11. Build, code & resilience

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-BLD-01 | Release not minified/obfuscated | `isMinifyEnabled=false`, `-dontobfuscate`, obfuscation only on CI | S, B | Low | MASVS-RESILIENCE |
| AND-BLD-02 | Secrets in `BuildConfig` / resources | `buildConfigField` or `resValue` with keys; secrets-gradle-plugin keys not `ignore.`-prefixed | S, B | Medium–Critical | CWE-798 |
| AND-BLD-03 | Secrets in the shipped binary | grep dex string pools, `resources.arsc`, `assets/`, `.so` files of the built APK | B | Critical | CWE-798 |
| AND-BLD-04 | Signing keystore in repo | `*.jks`, `*.keystore` tracked by git | S | Critical | CWE-522 |
| AND-BLD-05 | Signing passwords in build files | `storePassword` literal in `build.gradle(.kts)` / `gradle.properties` | S | High | CWE-798 |
| AND-BLD-06 | Native debug symbols shipped | unstripped `.so`, `debugSymbolLevel FULL` in the bundle served to users | B | Info | — |
| AND-BLD-07 | Debug builds distributed | debuggable builds sent to testers via Firebase / App Center | S | Low | CWE-215 |
| AND-BLD-08 | No integrity / attestation | no Play Integrity on sensitive endpoints; no signature check | A | Info | MASVS-RESILIENCE |
| AND-BLD-09 | No root / hook detection where required | banking/payment apps without RASP | A | Info | MASVS-RESILIENCE |
| AND-BLD-10 | Dynamic code loading | `DexClassLoader`, `PathClassLoader` from downloaded files, `Runtime.exec` | S | High | CWE-494 |
| AND-BLD-11 | Native code memory safety | `strcpy`, `sprintf`, `gets` in JNI/NDK sources | S | Medium | CWE-120 |
| AND-BLD-12 | `google-services.json` committed with unrestricted keys | Firebase config tracked + API key without app restriction | S | Low | — |

## 12. Injection on device

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| AND-INJ-01 | SQL built from strings | `rawQuery`/`execSQL` with concatenation, Room `@RawQuery`, `SimpleSQLiteQuery` from input | S | High | CWE-89 |
| AND-INJ-02 | Command execution | `Runtime.exec`, `ProcessBuilder` with input | S | High | CWE-78 |
| AND-INJ-03 | Zip slip | `ZipInputStream` entries written without checking `..` | S | High | CWE-22 |
| AND-INJ-04 | Unsafe XML parsing | `DocumentBuilderFactory` / `XmlPullParser` without disabling external entities | S | Medium | CWE-611 |
| AND-INJ-05 | Unsafe deserialization | `ObjectInputStream`, Gson/Jackson polymorphic typing on untrusted data | S | High | CWE-502 |
| AND-INJ-06 | Fragment injection | `PreferenceActivity` without `isValidFragment` | S | Medium | CWE-470 |
