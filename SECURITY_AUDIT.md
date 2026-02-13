# Security Audit Report: Call Transcript Merger

**Date:** 2026-02-13
**Scope:** Full codebase review (all source, config, build scripts, frontend)

---

## Executive Summary

The application is a Node.js/Electron desktop + web app that merges call transcripts from Gong, Grain, and custom APIs. The codebase demonstrates several good security practices (UUID validation, atomic writes, Electron context isolation, XSS escaping). However, there are **3 high-severity**, **7 medium-severity**, and **6 low-severity** findings that should be addressed.

---

## HIGH Severity

### H1. Server-Side Request Forgery (SSRF) via Provider Base URLs

**Files:** `src/api/providers/gong.js:7`, `src/api/providers/grain.js:7`, `src/api/providers/custom.js:18`

All three providers allow the user to supply an arbitrary `baseUrl`. The server then makes HTTP requests to those URLs with credentials attached. The custom provider is the most severe case since the user controls the entire URL, endpoint paths, and authentication headers.

**Impact:** An attacker with access to the localhost API (see H3) could make the server issue authenticated requests to:
- Cloud metadata services (`http://169.254.169.254/latest/meta-data/`)
- Internal network services (`http://10.0.0.1/admin`)
- The app's own API (`http://127.0.0.1:3847/api/...`)

**Evidence:**
```js
// gong.js:7 — user-controlled baseUrl
this.baseUrl = config.baseUrl || 'https://api.gong.io/v2';

// custom.js:59-70 — full SSRF chain
async _request(method, url, data = null, params = null) {
  return this.throttledRequest(async () => {
    const response = await axios({ method, url, ... });
```

---

### H2. No Authentication on API Endpoints

**File:** `src/main/server.js` (entire file)

The Express server has zero authentication. Any process running on the local machine can:
- Reconfigure providers with arbitrary credentials (`POST /api/config`)
- Start merges (`POST /api/merge/start`)
- Read session data (`GET /api/sessions`, `GET /api/merge/progress/:id`)
- Delete sessions (`DELETE /api/sessions/:id`)
- Download merged transcripts (`GET /api/merge/download/:id`)

While the server is bound to `127.0.0.1`, this does not protect against other local processes, browser-based attacks (see H3), or malicious browser extensions.

---

### H3. DNS Rebinding Attack Vector

**File:** `src/main/server.js:442`

The server binds to `127.0.0.1` but does **not** validate the `Host` header on incoming requests. This makes it vulnerable to DNS rebinding:

1. A malicious website configures a DNS record that alternates between its own IP and `127.0.0.1`
2. The victim visits the site while the app is running
3. After DNS rebinding, the attacker's JavaScript makes requests to `127.0.0.1:3847` that the browser treats as same-origin
4. The attacker can read all API responses (session data, accounts, transcripts)

**Impact:** A remote attacker could exfiltrate all session data, account lists, and transcripts by having the victim visit a malicious webpage.

---

## MEDIUM Severity

### M1. Credentials Stored in Memory Without Protection

**File:** `src/main/server.js:22-23`

```js
let currentConfig = null;   // holds all API keys/secrets
let providers = {};          // provider instances hold credentials in .config, .auth, .apiKey
```

API credentials (Gong access keys, Grain API keys, custom provider tokens) are stored as plain strings in process memory for the lifetime of the server. They are never cleared, even after providers are reconfigured. A memory dump or core file would expose all credentials.

---

### M2. Session Files Unencrypted with Default Permissions

**File:** `src/services/session.js:8`

```js
const SESSIONS_DIR = path.join(os.homedir(), '.call-transcript-merger', 'sessions');
```

Session files contain potentially confidential business call transcripts, speaker names, email addresses, and summaries. These are stored as plain JSON files. The directory is created with `{ recursive: true }` which inherits the process umask — typically `0755` for directories and `0644` for files, making them world-readable on multi-user systems.

---

### M3. No Input Validation on `/api/config`

**File:** `src/main/server.js:29-68`

```js
app.post('/api/config', (req, res) => {
  currentConfig = req.body;  // entire body stored, no schema validation
```

The config endpoint accepts any JSON body with no schema validation. Unexpected properties are silently stored and passed to provider constructors. This increases the attack surface — if a provider ever accesses an unexpected property, it could lead to unexpected behavior.

---

### M4. Electron ASAR Disabled

**File:** `package.json:68`

```json
"asar": false
```

The Electron app is built without ASAR packaging. This means the full source code is stored as plain files in the app bundle. An attacker with write access to the application directory could modify the source code, and the modified code would run the next time the app launches with full permissions.

---

### M5. Overly Broad macOS Entitlements

**File:** `build/entitlements.mac.plist`

The entitlements include:
- `com.apple.security.cs.allow-unsigned-executable-memory` — allows executing unsigned code in memory
- `com.apple.security.cs.allow-dyld-environment-variables` — allows `DYLD_*` environment variable injection
- `com.apple.security.network.server` — allows listening for network connections

The `allow-dyld-environment-variables` entitlement is particularly concerning as it enables `DYLD_INSERT_LIBRARIES` attacks that can inject arbitrary code into the process. The `network.server` entitlement is only needed for the internal localhost server but grants broader network server capabilities.

---

### M6. Download Endpoint Uses Session-Stored File Path

**File:** `src/main/server.js:402-421`

```js
app.get('/api/merge/download/:sessionId', (req, res) => {
  const session = sessionManager.load(req.params.sessionId);
  // ...
  if (!fs.existsSync(session.result.filePath)) {
    // Regenerate and WRITE to session.result.filePath
    fs.writeFileSync(session.result.filePath, markdown, 'utf-8');
  }
  res.download(session.result.filePath, session.result.fileName);
```

The `filePath` is read from the session JSON file on disk. If a local attacker modifies the session file (in `~/.call-transcript-merger/sessions/`), they could:
- Point `filePath` to an arbitrary path, causing `res.download()` to serve any readable file
- Point `filePath` to a writable system location, and if the file doesn't exist, the server writes Markdown content there

---

### M7. No Content-Security-Policy Header

**File:** `src/main/server.js` (absent), `public/index.html` (absent)

Neither the Express server nor the HTML sets a `Content-Security-Policy` header. While the app uses `escapeHtml()` properly, a CSP would provide defense-in-depth against XSS. The HTML also uses inline `onclick` handlers throughout, which would need `'unsafe-inline'` and limits CSP effectiveness.

---

## LOW Severity

### L1. Unescaped Values in innerHTML Template

**File:** `public/js/app.js:298`

```js
logEl.innerHTML = data.logs.map(l =>
  `<div class="entry ${l.level || ''}">[${l.time || ''}] ${escapeHtml(l.message)}</div>`
).join('');
```

`l.level` and `l.time` are interpolated into the innerHTML string without escaping. While both values originate from server-controlled code (`addLog()` at `server.js:329` uses hardcoded level strings), this violates defense-in-depth. If the data flow ever changes such that these values become attacker-influenced, it would be an XSS vulnerability.

---

### L2. Custom Provider Header Name Injection

**File:** `src/api/providers/custom.js:36`

```js
headers[this.authConfig.headerName || 'X-API-Key'] = this.authConfig.token;
```

The user controls the HTTP header name. While axios validates header names, a user could set it to sensitive headers like `Host`, `Authorization`, or `Cookie`, potentially causing unexpected behavior in downstream requests.

---

### L3. No Rate Limiting on Incoming Server Endpoints

**File:** `src/main/server.js` (entire file)

The server has no rate limiting on its own endpoints. While bound to localhost, a local attacker or runaway script could flood endpoints like `/api/accounts` (which triggers upstream API calls), burning API quota on the Gong/Grain services.

---

### L4. Markdown Output Contains Unsanitized API Content

**File:** `src/services/merger.js:63-140`

Speaker names, titles, transcript text, summaries, and other content from external APIs are written directly into the Markdown output without sanitization. If a Markdown renderer supports inline HTML (many do, including GitHub), content like `<img src=x onerror=alert(1)>` in a speaker name or transcript would execute as HTML/JavaScript when the Markdown is viewed.

---

### L5. Error Messages Leak Implementation Details

**File:** `src/main/server.js:84`, `src/main/server.js:365`

```js
res.json({ success: false, message: e.message });  // line 84
res.status(404).json({ error: e.message });          // line 365
```

Raw error messages from axios, file system operations, and provider code are returned in API responses. These can reveal internal paths, network topology, and stack trace fragments.

---

### L6. Broad Dependency Version Ranges

**File:** `package.json:17-21`

```json
"axios": "^1.13.5",
"express": "^4.22.1",
"electron": "^28.0.0"
```

Caret ranges allow automatic minor/patch version updates. While generally safe, a compromised package version within the range could be automatically installed. Using exact versions or a lockfile check-in (which is done — `package-lock.json` exists) mitigates this. The lockfile should be verified during CI/CD.

---

## Positive Security Findings

The following good practices were observed:

| Practice | Location | Notes |
|---|---|---|
| **UUID validation** | `session.js:9,27-30` | Session IDs validated against strict UUID regex, preventing path traversal |
| **Atomic file writes** | `session.js:167-179` | Write-to-temp + rename prevents data corruption |
| **Electron context isolation** | `electron.js:19-20` | `nodeIntegration: false`, `contextIsolation: true` |
| **XSS escaping** | `app.js:594-601` | `escapeHtml()` and `escapeAttr()` used consistently in dynamic HTML |
| **Server bound to localhost** | `server.js:442` | `app.listen(PORT, '127.0.0.1')` prevents remote network access |
| **External links in default browser** | `electron.js:45-48` | `setWindowOpenHandler` prevents navigation to untrusted origins |
| **JSON body size limit** | `server.js:16` | `express.json({ limit: '2mb' })` prevents large payload DoS |
| **Safe field allowlist** | `session.js:99` | `update()` only allows `['status', 'error', 'result', 'updatedAt']` |
| **Filename sanitization** | `server.js:280` | `projectName` stripped of special characters and length-limited |
| **Sensitive files in .gitignore** | `.gitignore:3` | `.env` excluded from version control |
| **Test coverage for security** | `server.test.js:158-176` | Tests for path traversal and invalid session ID rejection |

---

## Recommended Remediation Priority

1. **H3** (DNS rebinding) — Add `Host` header validation middleware
2. **H2** (no auth) — Add a per-session random token for API authentication
3. **H1** (SSRF) — Validate base URLs against an allowlist or block private/reserved IP ranges
4. **M5** (entitlements) — Remove `allow-dyld-environment-variables` unless required
5. **M6** (download path) — Validate `filePath` is within the Downloads directory before serving/writing
6. **M4** (asar) — Enable ASAR packaging
7. **M7** (CSP) — Add a Content-Security-Policy header
