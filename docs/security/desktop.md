# Desktop app security checks

Applies to: Electron, Tauri, and native desktop apps (Windows .NET/WPF/WinUI, macOS AppKit/SwiftUI, Qt, Java/Compose Desktop).
Shared checks in [common.md](common.md). Electron/Tauri renderers are web pages, so [web-frontend.md](web-frontend.md) XSS checks apply too — with much bigger impact, because XSS can become code execution.

How: **S** static, **D** dependencies, **B** built package, **R** runtime, **A** agent review.

## 1. Electron

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| DSK-EL-01 | Node integration in renderer | `nodeIntegration: true`, `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames` | S | Critical | CWE-94 |
| DSK-EL-02 | Context isolation off | `contextIsolation: false` | S | Critical | CWE-653 |
| DSK-EL-03 | Sandbox off | `sandbox: false` on windows loading remote content | S | High | CWE-653 |
| DSK-EL-04 | Web security off | `webSecurity: false`, `allowRunningInsecureContent: true`, `experimentalFeatures` | S | High | CWE-693 |
| DSK-EL-05 | Preload exposes too much | `contextBridge.exposeInMainWorld` exposing `ipcRenderer`, `require`, `fs`, or generic `invoke(channel, …)` | S, A | High | CWE-749 |
| DSK-EL-06 | IPC handlers trust renderer | `ipcMain.handle` doing file/shell/network work without validating args or `event.senderFrame` origin | S, A | High | CWE-20 |
| DSK-EL-07 | `shell.openExternal` with untrusted URLs | no scheme allowlist (`file:`, `smb:`, custom protocols → RCE) | S | High | CWE-78 |
| DSK-EL-08 | Navigation / new windows not restricted | no `will-navigate` / `setWindowOpenHandler` limits | S | Medium | CWE-939 |
| DSK-EL-09 | Remote content loaded | `loadURL('http…')` of remote sites in privileged windows; `<webview>` tag enabled | S | High | CWE-829 |
| DSK-EL-10 | No CSP | renderer pages without CSP | S, R | Medium | CWE-693 |
| DSK-EL-11 | `@electron/remote` / `enableRemoteModule` | remote module in use | S | High | — |
| DSK-EL-12 | Custom protocol handlers | `protocol.registerFileProtocol` serving paths without traversal checks; `setAsDefaultProtocolClient` handlers parsing argv unsafely | S | High | CWE-22 |
| DSK-EL-13 | Outdated Electron | Electron major out of support (Chromium CVEs) | D | High | CWE-1104 |
| DSK-EL-14 | Fuses not hardened | `RunAsNode`, `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable` on; ASAR integrity off | B | Medium | CWE-693 |
| DSK-EL-15 | DevTools in production | `openDevTools()` not gated | S | Low | CWE-489 |

## 2. Tauri

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| DSK-TA-01 | Capabilities too broad | `fs:allow-*` on `$HOME/**`, `shell:allow-execute` with open args, `http` scope `*` | S | High | CWE-250 |
| DSK-TA-02 | Commands trust frontend | `#[tauri::command]` doing file/shell work with unvalidated args | S, A | High | CWE-20 |
| DSK-TA-03 | CSP disabled | `"csp": null` in `tauri.conf.json` | S | Medium | CWE-693 |
| DSK-TA-04 | Remote URLs given IPC access | `remote` domains in capabilities | S | High | CWE-829 |
| DSK-TA-05 | Dangerous `asset:` / `convertFileSrc` scope | asset protocol scope over the whole disk | S | Medium | CWE-22 |

## 3. Native desktop (all OSes)

| ID | Check | Look for | How | Sev | Ref |
|---|---|---|---|---|---|
| DSK-NT-01 | Secrets stored in plain files / registry | tokens in config files, `%APPDATA%`, `~/Library/Preferences`, registry instead of DPAPI / Keychain / libsecret | S, R | High | CWE-312 |
| DSK-NT-02 | Auto-update insecure | update feed over HTTP, unsigned updates, signature not verified (Squirrel, Sparkle without EdDSA, custom updaters) | S | Critical | CWE-494 |
| DSK-NT-03 | DLL / dylib hijacking | loading libraries by relative name; `LoadLibrary` without full path; `@rpath` to writable dirs | S, B | High | CWE-427 |
| DSK-NT-04 | Writable install directory | app installed per-machine with user-writable files; services running as SYSTEM from writable paths | B, R | High | CWE-276 |
| DSK-NT-05 | Local IPC / ports open | named pipes, Unix sockets, localhost HTTP servers without auth (any local process or website via DNS rebinding can call them) | S, R | High | CWE-306 |
| DSK-NT-06 | Custom URL scheme handlers | `myapp://` arguments passed to shell/file APIs | S | High | CWE-78 |
| DSK-NT-07 | Unsigned binaries / no notarization | missing Authenticode / Apple notarization; hardened runtime off | B | Medium | — |
| DSK-NT-08 | macOS entitlements too broad | `com.apple.security.cs.disable-library-validation`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables` | B | Medium | CWE-693 |
| DSK-NT-09 | Temp files insecure | predictable temp file names, world-readable temp files with secrets | S | Medium | CWE-377 |
| DSK-NT-10 | Memory-unsafe code | C/C++ `strcpy`, `sprintf`, unchecked buffers | S | Medium | CWE-120 |
| DSK-NT-11 | Logs with secrets | log files in user dirs containing tokens | S, R | Medium | CWE-532 |
