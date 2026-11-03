import { F, rule, type Rule } from "../rule.js";

/** React Native, Flutter, Kotlin Multiplatform, hybrid and MAUI apps (docs/security/cross-platform-mobile.md). */
export const CROSS_MOBILE: Rule[] = [
  // ── React Native / Expo
  rule("XPM-02", "critical", "rn", F.js, /AsyncStorage\.setItem\s*\(\s*["'`]\w*(token|jwt|auth|session|password|secret)\w*["'`]/i, "Token in AsyncStorage", "AsyncStorage is an unencrypted file (and plain SharedPreferences/plist).", "Use react-native-keychain or expo-secure-store.", ["CWE-312"]),
  rule("XPM-01", "critical", "rn", /(^|\/)(app\.json|app\.config\.[jt]s)$/, /"?extra"?\s*:\s*\{[\s\S]*?\w*(secret|private|password|service_?role)\w*["']?\s*:/i, "Secret in Expo config", "app.json `extra` ships inside the bundle; anyone can read it.", "Keep secrets on a server; ship only public ids.", ["CWE-798"]),
  rule("XPM-04", "critical", "rn", F.js, /trustAllCerts|rejectUnauthorized\s*:\s*false|disableAllSecurity\s*:\s*true|sslPinning\s*:\s*\{\s*certs\s*:\s*\[\s*\]/, "TLS verification turned off", "Any network attacker can read and change the app's traffic.", "Remove it; pin with react-native-ssl-pinning if needed.", ["CWE-295"]),
  rule("XRN-01", "high", "rn", F.js, /originWhitelist\s*=\s*\{\s*\[\s*["']\*["']\s*\]\s*\}/, "WebView allows any origin", "Any page can load and post messages to the app.", "List the origins the WebView may load.", ["CWE-939"]),
  rule("XRN-01", "high", "rn", F.js, /onMessage\s*=\s*\{/, "WebView bridge without an origin check", "Any page shown in the WebView can send messages the app acts on.", "Check event.nativeEvent.url against an allowlist before acting.", ["CWE-749"], { when: /react-native-webview/, unless: /nativeEvent\.url|allowedOrigins|origin/ }),
  rule("XRN-02", "high", "rn", F.js, /allowUniversalAccessFromFileURLs\s*=\s*\{\s*true|allowFileAccessFromFileURLs\s*=\s*\{\s*true|mixedContentMode\s*=\s*["']always["']/, "WebView file or mixed-content access", "Local files can be read by page scripts, or HTTP content injected.", "Remove these props.", ["CWE-200"]),
  rule("XRN-02", "medium", "rn", F.js, /javaScriptCanOpenWindowsAutomatically\s*=\s*\{\s*true|injectedJavaScript\s*=\s*\{\s*`[^`]*\$\{/, "WebView injected script from data", "Values inside injected JS run as code in the page.", "JSON.stringify values passed into injected scripts.", ["CWE-79"]),
  rule("XPM-10", "medium", "rn", F.js, /console\.(log|debug|info)\s*\([^)\n]*(token|password|secret|otp|authorization)/i, "Secret logged", "RN console logs reach logcat / device logs in release.", "Remove it, and strip console with babel-plugin-transform-remove-console in release.", ["CWE-532"]),
  rule("XPM-06", "high", "rn", /(^|\/)(app\.json|app\.config\.[jt]s|Info\.plist|strings\.xml)$/, /CodePushServerURL["']?\s*[:=>]\s*["'<]?http:|"updates"\s*:\s*\{[^}]*"url"\s*:\s*"http:/, "Over-the-air updates over HTTP", "Anyone on the network can push code to the app.", "Use HTTPS and code signing for updates (expo-updates codeSigningCertificate).", ["CWE-494"]),
  rule("XPM-06", "medium", "rn", /(^|\/)(app\.json|app\.config\.[jt]s)$/, /"updates"\s*:\s*\{/, "OTA updates without code signing", "Whoever controls the update server (or its account) ships code to every user.", "Configure updates.codeSigningCertificate.", ["CWE-494"], { unless: /codeSigningCertificate/ }),

  // ── Flutter
  rule("XPM-02", "critical", "flutter", F.dart, /(prefs|preferences|SharedPreferences\S*)\.set(String|Bool)\s*\(\s*["']\w*(token|jwt|auth|session|password|secret)\w*["']/i, "Token in shared_preferences", "shared_preferences is plain storage.", "Use flutter_secure_storage.", ["CWE-312"]),
  rule("XPM-04", "critical", "flutter", F.dart, /badCertificateCallback\s*=\s*\([^)]*\)\s*(=>\s*true|\{\s*return\s+true)/, "TLS verification turned off", "Every certificate is accepted.", "Remove the callback; pin with a SecurityContext if needed.", ["CWE-295"]),
  rule("XFL-01", "high", "flutter", F.dart, /JavaScriptMode\.unrestricted[\s\S]{0,500}(addJavaScriptChannel|JavascriptChannel)/, "WebView JS channel with unrestricted JavaScript", "Any page in the WebView can call the native channel.", "Load only allowlisted URLs (NavigationDelegate) and check the source in the channel.", ["CWE-749"]),
  rule("XFL-03", "medium", "flutter", F.kotlinJava, /setMethodCallHandler\s*\{[\s\S]{0,600}(File\(|startActivity|Intent\(|Uri\.parse)/, "Platform channel acts on Dart arguments", "Arguments decide files, intents or URLs on the native side.", "Validate every argument on the native side.", ["CWE-20"]),
  rule("XPM-10", "medium", "flutter", F.dart, /\b(print|debugPrint|log)\s*\([^)\n]*(token|password|secret|otp|authorization)/i, "Secret logged", "Logs reach logcat and device logs.", "Remove it.", ["CWE-532"]),
  rule("XFL-02", "high", "flutter", F.dart, /String\.fromEnvironment\s*\(\s*["']\w*(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE)\w*["']/, "Secret passed with --dart-define", "dart-define values are compiled into the binary.", "Keep secrets on a server.", ["CWE-798"]),

  // ── Kotlin Multiplatform
  rule("XKM-01", "high", "kmp", /\/iosMain\/.+\.kt$/, /NSUserDefaults\.standardUserDefaults[\s\S]{0,200}(token|password|secret|session)/i, "iOS side stores secrets in NSUserDefaults", "The iOS actual of the storage keeps tokens in a plain plist.", "Use the Keychain on iOS (e.g. KeychainSettings).", ["CWE-312"]),
  rule("XKM-01", "high", "kmp", /\/commonMain\/.+\.kt$/, /(Settings\(\)|settings)\.(putString|set)\s*\(\s*"\w*(token|password|secret|session)\w*"/i, "Shared settings hold a token", "multiplatform-settings is unencrypted on both platforms by default.", "Use an encrypted settings implementation (EncryptedSharedPreferences / Keychain) for secrets.", ["CWE-312"]),
  rule("XKM-02", "critical", "kmp", /\.kt$/, /handleChallenge\s*\{[\s\S]{0,300}NSURLSessionAuthChallengeUseCredential|trustManager\s*=\s*object\s*:\s*X509TrustManager/, "Ktor client trusts every certificate", "Traffic on that platform can be intercepted.", "Remove the override; use certificate pinning instead.", ["CWE-295"]),
  rule("XKM-03", "low", "kmp", /\.kt$/, /(Napier\.base\(DebugAntilog\(\)\)|Logger\.setMinSeverity\(Severity\.Verbose\))/, "Verbose shared logging always on", "Debug logs ship in release on both platforms.", "Initialise debug logging only in debug builds.", ["CWE-532"], { unless: /isDebug|BuildConfig\.DEBUG|Platform\.isDebugBinary/ }),

  // ── Ionic / Capacitor / Cordova
  rule("XHY-02", "high", "hybrid", /(^|\/)config\.xml$/, /<(access\s+origin|allow-navigation\s+href)\s*=\s*"\*"/, "Cordova allows every origin", "The WebView (with native plugins) can load or call any site.", "List the hosts the app needs.", ["CWE-939"]),
  rule("XHY-03", "high", "hybrid", /capacitor\.config\.(json|[jt]s)$/, /cleartext\s*["']?\s*:\s*true|"?url"?\s*:\s*["']http:\/\//, "Capacitor live-reload or cleartext config", "The app loads code from a dev server or over HTTP.", "Remove server.url / cleartext from release config.", ["CWE-319"]),
  rule("XHY-05", "medium", "hybrid", /(^|\/)(www|src|public)\/index\.html$/, /Content-Security-Policy/, "No Content-Security-Policy in the hybrid app", "XSS in a hybrid app reaches native plugins (camera, files, contacts).", "Add a CSP meta tag that allows only your own scripts.", ["CWE-693"], { absent: true }),
  rule("XHY-01", "high", "hybrid", F.js, /cordova\.InAppBrowser\.open\s*\([^)]*,\s*["']_self["']/, "Untrusted page opened inside the app WebView", "With _self the page gets Cordova plugin access.", "Open external pages with _system or _blank.", ["CWE-749"]),

  // ── .NET MAUI / Xamarin
  rule("XMA-01", "critical", "maui", F.cs, /ServerCertificateCustomValidationCallback\s*=\s*[^;]*=>\s*true/, "TLS verification turned off", "Every certificate is accepted.", "Remove the callback.", ["CWE-295"]),
  rule("XMA-03", "high", "maui", F.cs, /Preferences\.(Default\.)?Set\s*\(\s*"\w*(token|password|secret|session)\w*"/i, "Token in Preferences", "Preferences are plain storage.", "Use SecureStorage.", ["CWE-312"]),
];
