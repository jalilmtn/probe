# Cross-platform mobile security checks

Applies to: Flutter, React Native (incl. Expo), Kotlin Multiplatform, .NET MAUI / Xamarin, Ionic / Capacitor / Cordova.
These apps still ship as an Android APK and an iOS IPA, so **every check in [android.md](android.md) and [ios.md](ios.md) also applies** to the native shells. This file adds what is specific to each framework.

How: **S** static, **D** dependencies, **B** built app, **R** runtime, **A** agent review.

## 1. Shared across frameworks

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| XPM-01 | Secrets in the JS/Dart/C# bundle | keys in `.env` files baked by `react-native-config`, `flutter_dotenv`, `--dart-define`, `app.json`/`app.config.js` `extra` | S, B | Critical | CWE-798 |
| XPM-02 | Insecure storage plugin | `AsyncStorage`, `shared_preferences`, `Preferences` (Capacitor), `Xamarin.Essentials.Preferences` for tokens | S | Critical | CWE-312 |
| XPM-03 | Secure storage plugin misconfigured | `flutter_secure_storage` / `react-native-keychain` / `expo-secure-store` with weak accessibility options | S | Medium | MASVS-STORAGE |
| XPM-04 | TLS bypass in framework HTTP client | Dio `badCertificateCallback = (…) => true`, `HttpClient` override, RN fetch with custom trust | S | Critical | CWE-295 |
| XPM-05 | No pinning on sensitive hosts | no `ssl_pinning`/`http_certificate_pinning`/`react-native-ssl-pinning` where expected | S | Medium | MASVS-NETWORK |
| XPM-06 | Over-the-air updates unsigned | CodePush / EAS Update / Shorebird without code signing; update URL over HTTP | S | High | CWE-494 |
| XPM-07 | Dev menus / debug in release | RN dev menu, Flipper, Flutter `debugPrint`/`kDebugMode` gates missing | S, B | Medium | CWE-489 |
| XPM-08 | Native plugin with risky permissions | plugins adding permissions or exported components to the merged manifest | B | Medium | CWE-926 |
| XPM-09 | Deep-link handling in shared code | `Linking`/`go_router`/`uni_links` routes performing actions or opening URLs without validation | S, A | High | CWE-20 |
| XPM-10 | Logs in shared code | `console.log`, `print`, `debugPrint` with tokens/PII in release | S | Medium | CWE-532 |
| XPM-11 | Obfuscation off | Flutter without `--obfuscate --split-debug-info`; Hermes bytecode not used; source maps shipped in bundle | B | Low | MASVS-RESILIENCE |

## 2. React Native / Expo

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| XRN-01 | `react-native-webview` with bridge open | `onMessage` handlers without origin check; `originWhitelist={['*']}`; `injectedJavaScript` with input | S | High | CWE-749 |
| XRN-02 | WebView file access | `allowFileAccess`, `allowUniversalAccessFromFileURLs`, `mixedContentMode="always"` | S | High | CWE-200 |
| XRN-03 | JS bundle readable | plain `index.android.bundle` with business logic and keys | B | Low | — |
| XRN-04 | Expo config leaks | secrets in `app.json` `extra`, `expo-constants` | S, B | High | CWE-798 |
| XRN-05 | `eval` of remote code | `eval`/`Function` on server strings | S | High | CWE-95 |

## 3. Flutter

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| XFL-01 | `webview_flutter` JS channels open | `JavaScriptChannel` + `JavaScriptMode.unrestricted` on non-allowlisted URLs | S | High | CWE-749 |
| XFL-02 | `--dart-define` secrets | secrets passed at build time end up in `libapp.so` | S, B | High | CWE-798 |
| XFL-03 | Platform channels trust input | `MethodChannel` handlers doing file/intent/URL work from unvalidated args | S, A | Medium | CWE-20 |
| XFL-04 | Release built in debug/profile | APK built with `--debug`/`--profile` distributed | B | Medium | CWE-489 |

## 4. Kotlin Multiplatform

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| XKM-01 | Platform storage `expect/actual` insecure on one side | secure on Android (Keystore), plain `NSUserDefaults` on iOS or vice versa (`multiplatform-settings` without encryption) | S, A | High | CWE-312 |
| XKM-02 | Ktor client TLS overrides | custom `engine { https { trustManager = … } }` / Darwin `handleChallenge` accepting all | S | Critical | CWE-295 |
| XKM-03 | Shared logging (Napier, Kermit) in release | log levels not gated per platform | S | Low | CWE-532 |

## 5. Ionic / Capacitor / Cordova

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| XHY-01 | Whole app is a WebView | all [web-frontend.md](web-frontend.md) XSS checks apply, with native plugin access as impact | S | High | CWE-79 |
| XHY-02 | Cordova `<access origin="*">` / `allow-navigation *` | open whitelist | S | High | CWE-939 |
| XHY-03 | Capacitor `server.url` / `cleartext: true` in release | live-reload config shipped | S, B | High | CWE-319 |
| XHY-04 | Old Cordova platforms / plugins | known CVEs in `cordova-android`, `cordova-plugin-inappbrowser` | D | Medium | CWE-1104 |
| XHY-05 | No CSP in `index.html` | missing `Content-Security-Policy` meta | S | Medium | CWE-693 |

## 6. .NET MAUI / Xamarin

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| XMA-01 | `ServerCertificateCustomValidationCallback` returns true | TLS bypass | S | Critical | CWE-295 |
| XMA-02 | Assemblies not linked/obfuscated | DLLs in APK readable with ILSpy, holding secrets | B | Medium | CWE-798 |
| XMA-03 | `Preferences` for tokens | instead of `SecureStorage` | S | High | CWE-312 |
