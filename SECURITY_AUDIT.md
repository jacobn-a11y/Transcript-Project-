# Security Audit & Review — Call Transcript Merger

**Date:** 2026-02-13
**Scope:** Full codebase review (all source in `src/`, `public/`, `tests/`)

---

## Does the Tool Work?

**Yes.** The Call Transcript Merger is a well-structured application that merges call transcripts from Gong, Grain, and custom API providers into a single chronological Markdown document. The architecture is sound: Express backend, vanilla JS frontend, provider pattern for API integrations, and a three-phase merge pipeline (fetch call lists, fetch details, generate Markdown). Session persistence with pause/resume handles API rate limiting gracefully.

### Functional Issues

1. **Unbounded Gong pagination** — `getCallsForAccount()` (`src/api/providers/gong.js:181`) loops `while (cursor)` with no page limit. For accounts with thousands of calls, this could run indefinitely or exhaust memory.

2. **Infinite retry on 429** — The Bottleneck `failed` handler (`src/utils/rate-limiter.js:16`) returns a wait time for 429 responses but never checks `jobInfo.retryCount`. Without a max retry limit, a persistently rate-limited endpoint will retry forever, blocking the queue.

3. **Grain account extraction logic** — At `src/api/providers/grain.js:77`, the check `if (accounts.size === 0 && title)` is inside the per-recording loop. Title-based account discovery stops working as soon as one participant-based account is found from any earlier recording.

---

## Security Issues

### HIGH Severity

#### 1. SSRF Protection Bypass via DNS Rebinding and Alternative IP Representations

**Location:** `src/main/server.js:77-99`

The `isPrivateUrl()` function checks the hostname string against known private IP patterns but does **not** resolve DNS before checking. Bypass vectors include:

- Domains resolving to `127.0.0.1` (e.g., `localtest.me`, `vcap.me`, `*.nip.io`)
- Decimal IP notation: `http://2130706433/` (= `127.0.0.1`)
- Octal IP notation: `http://0177.0.0.1/`
- IPv6-mapped IPv4: `http://[::ffff:127.0.0.1]/`
- IPv6 private ranges (`fc00::/7`, `fe80::/10`) are not checked
- DNS rebinding: DNS initially resolves to a public IP (passes check), then changes to an internal IP when the actual HTTP request is made

**Risk context:** For a localhost-only tool where the user provides their own URLs, exploitation requires the user to enter a malicious URL. If ever deployed as a shared service, this becomes critical (e.g., reaching cloud metadata at `169.254.169.254`).

**Recommendation:** Use DNS resolution before the check, validate the resolved IP, and consider using an allowlist of known API domains for built-in providers.

#### 2. CSP Allows `unsafe-inline` for Scripts

**Location:** `src/main/server.js:33`

```
script-src 'self' 'unsafe-inline'
```

`unsafe-inline` effectively nullifies CSP protection against XSS. If an attacker can inject content that renders as HTML, inline scripts will execute.

**Recommendation:** Remove `unsafe-inline` and either use nonce-based CSP or move all inline event handlers (currently in `index.html` as `onclick` attributes) to the external `app.js` file using `addEventListener`.

#### 3. Infinite Retry Loop in Rate Limiter

**Location:** `src/utils/rate-limiter.js:16-37`

The Bottleneck `failed` handler returns a wait duration for 429 responses but never checks `jobInfo.retryCount`. If a server persistently returns 429, the request retries indefinitely, blocking the limiter queue forever.

**Recommendation:** Add a max retry check:
```js
if (jobInfo.retryCount >= 3) return null; // give up
```

---

### MEDIUM Severity

#### 4. Auth Token Leaked in URL Query Parameters

**Location:** `public/js/app.js:368,430` and `src/main/server.js:53`

The download endpoint passes the auth token as a URL query parameter (`?_token=...`). Tokens in URLs can leak via browser history, Referrer headers, server access logs, and browser extensions.

**Recommendation:** Use a short-lived download token or POST-based download flow instead.

#### 5. URL Path Injection in Custom Provider

**Location:** `src/api/providers/custom.js:184,207`

Account IDs and call IDs from API responses are interpolated directly into URL paths via `String.replace()` without encoding. If an API returns an ID containing URL-significant characters (`?`, `#`, `/`, `..`), it could alter the target request URL.

**Recommendation:** Apply `encodeURIComponent()` to interpolated path segments.

#### 6. Regex-Based HTML Sanitization is Fragile

**Location:** `src/services/merger.js:189-192`

```js
return str.replace(/<[^>]*>/g, '');
```

This strips HTML tags but does not handle:
- Markdown-specific injection (e.g., `[Click](javascript:alert(1))`)
- HTML entities or encoded payloads
- Malformed/incomplete tags in edge cases

**Risk context:** Output is `.md`, so actual risk depends on the Markdown viewer used by the consumer.

**Recommendation:** Also escape Markdown link syntax for `javascript:` and `data:` URLs. Consider a library like DOMPurify for the HTML case.

#### 7. Unbounded Session File Growth

**Location:** `src/services/session.js:129`

`completedDetails.push(callDetail)` accumulates all call details (including full transcripts) in the session JSON. For large merges, session files could grow to hundreds of MB, causing disk exhaustion or slow `JSON.parse()`.

**Recommendation:** Stream completed details to a separate file or use a max size limit with overflow to disk.

---

### LOW Severity

#### 8. TOCTOU Race in Output File Creation

**Location:** `src/main/server.js:409-415`

Time-of-check-to-time-of-use race between `fs.existsSync()` and `fs.writeFileSync()`. A symlink could be placed at the target path between the check and the write.

#### 9. Error Sanitization Gaps

**Location:** `src/main/server.js:114-118`

`sanitizeError` replaces Unix file paths but does not catch Windows-style paths, URLs with embedded credentials, or API keys in error messages.

#### 10. Download Path Check Edge Case

**Location:** `src/main/server.js:536`

The condition `resolvedPath !== downloadsDir` would accept the Downloads directory itself as valid, though `res.download()` on a directory fails gracefully.

---

## What's Done Well

The codebase shows strong security awareness overall:

- **Per-session auth token** prevents unauthorized local processes from calling the API
- **Host header validation** mitigates DNS rebinding at the server level
- **SSRF protection** (despite noted bypasses) demonstrates the right approach
- **Restrictive file permissions** (0600) and atomic writes for session persistence
- **UUID regex validation** on session IDs prevents path traversal
- **Frontend escaping** uses `escapeHtml()` and `escapeAttr()` throughout
- **Electron hardening** with `nodeIntegration: false` and `contextIsolation: true`
- **Localhost-only binding** (`127.0.0.1`, not `0.0.0.0`)
- **Blocked sensitive headers** in custom provider auth configuration
- **Input validation** on API endpoints (schema checks, type checks)
- **Rate limiting** on incoming requests (120/min)
