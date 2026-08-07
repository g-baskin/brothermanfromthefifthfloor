# Security Audit Report: Google Calendar workflow automation

**Audit date:** 2026-08-06  
**Auditor:** security-guardian  
**Scope:** `.gg/plans/google-calendar-workflow-automation.md`; current working-tree implementation in `src/integrations/google/**`, `src/realtime/tools/google-calendar-tools.js`, `src/realtime/tools/tool-schemas.js`, `src/realtime/tool-permissions.js`, `src/main.js`, `src/preload.js`, relevant renderer files, tests, and dependency manifests  
**Application stack:** Electron / JavaScript / Node.js (not Next.js or React)  
**Next.js version audited:** Not installed  
**React version audited:** Not installed  
**CVE watchlist last refreshed:** 2026-07-17 (current; 20 days old)

---

## Executive Summary

The most important finding was a High-severity vulnerable dependency chain in the Electron build/runtime toolchain. It was remediated by upgrading Electron, electron-builder, electron-updater, js-yaml, and undici; the final dependency scan reports **0 Critical and 0 High** vulnerabilities. No Critical findings were detected, and no refresh/access tokens, authorization codes, PKCE verifier, OAuth state, Calendar event content, or PII were exposed through renderer APIs or diagnostics.

The Google Calendar implementation has a strong security posture: loopback OAuth binds only to `127.0.0.1`, uses PKCE S256 and constant-time state validation, persists only the refresh token using Electron `safeStorage`, caches access tokens only in main-process memory, revokes and deletes credentials on disconnect, validates strict Calendar arguments, bounds list ranges/results and mapped response counts, exposes only narrow IPC methods, renders remote text with `textContent`, and logs only event/code/state summaries.

---

## Scorecard

| Category | Status | Findings |
|---|---|---:|
| Financial / Payment Security | OK | 0 |
| PII Exposure | OK | 0 |
| Authentication & Authorization | OK | 0 |
| Injection Vulnerabilities | OK | 0 |
| Dependency Security | FAIL (remediated) | 1 High |
| Configuration & Headers | OK | 0 |
| Data Handling | OK | 0 |

Legend: **OK** = zero findings · **ATTN** = Medium/Low findings documented · **FAIL** = Critical/High finding, fixed in this session.

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **Vulnerable dependencies / supply chain** `package.json:57-67` — The deterministic scan reported High vulnerabilities in the existing Electron toolchain, including `app-builder-lib` search-path manipulation and vulnerable `tar`, `form-data`, `js-yaml`, and `undici` versions. Upgraded `electron` to `^43.3.0`, `electron-builder` to `^26.15.3`, `electron-updater` to `^6.8.9`, and added direct safe-version constraints for `js-yaml` `^5.2.3` and `undici` `^8.10.0`; regenerated `package-lock.json`. Final `npm audit` reports zero High/Critical vulnerabilities.

---

## Medium Findings (follow-up required)

- [ ] **Transitive image-parser denial of service** `package-lock.json:1163` — Final `npm audit` reports seven Moderate advisories inherited from `@nut-tree-fork/nut-js` through Jimp/file-type. No non-breaking fix is available for the root dependency. Treat untrusted image input to computer-control/image-processing paths as potentially hostile and replace or upgrade nut-js/Jimp when an upstream fix becomes available.

---

## Low Findings (documentation only)

None detected.

---

## Focused Control Review

### OAuth loopback, PKCE, and state

- `src/integrations/google/google-oauth.js:51-66,277-380` binds an ephemeral callback listener to `127.0.0.1` and constructs the redirect URI from the actual bound port.
- `src/integrations/google/google-oauth.js:12-15,51-52` creates a 64-byte random PKCE verifier and S256 base64url challenge; OAuth state is 32 random bytes.
- `src/integrations/google/google-oauth.js:288-335,383-407` accepts only the exact callback path, rejects duplicate/missing code or state parameters, uses `timingSafeEqual`, and sends restrictive callback response headers (`no-store`, CSP, `nosniff`, `DENY`).
- `src/integrations/google/google-oauth.js:78-91,178-195` exchanges the code only after callback validation and sends no client secret for the installed-app flow.
- Tests cover entropy/challenge, successful connect, state mismatch, denial, timeout, and no exchange on timeout.

### Encrypted refresh-token persistence and token lifecycle

- `src/integrations/google/encrypted-token-store.js:12-17,25-54,57-87` fails closed when `safeStorage` encryption is unavailable, encrypts/decrypts only in the Electron main process, writes through a mode-`0600` temporary file, atomically renames it, and validates persisted structure.
- `src/integrations/google/google-oauth.js:99-105` stores only refresh token plus bounded non-sensitive metadata; access tokens are not persisted.
- `src/integrations/google/google-oauth.js:108-137` caches access tokens only in memory with a 60-second expiry skew.
- `src/integrations/google/google-oauth.js:122-134,240-249` deletes persisted credentials on `invalid_grant`; `src/integrations/google/google-oauth.js:157-173` revokes the refresh token, clears memory, and deletes local credentials even if network revocation fails.

### Calendar API validation and response bounds

- `src/realtime/tools/google-calendar-tools.js:68-216` rejects non-record/unknown arguments; enforces RFC3339/date formats, chronological ordering, a 366-day maximum range, 1-50 result bounds, bounded query/event fields, event IDs, and non-empty update patches.
- `src/integrations/google/google-calendar-client.js:46-70,125-160` independently clamps `maxResults` to 50, slices returned events to that bound, and truncates mapped remote text/pagination fields to explicit limits.
- `src/integrations/google/google-calendar-client.js:26-42,155-189` retries one 401 with a forced refresh and normalizes failures without returning raw Google response bodies.
- `src/integrations/google/google-calendar-client.js:102-115` allowlists outbound event fields; no arbitrary caller-supplied object is forwarded.

### IPC, preload, renderer, and diagnostics

- `src/preload.js:8-10` exposes only status/connect/disconnect methods for Calendar and never exposes tokens, authorization codes, callback URLs, PKCE data, or arbitrary Calendar API invocation.
- `src/main.js:462-464,1131-1211` keeps OAuth/token operations in the main process and returns bounded status objects.
- `src/renderer/renderer.js:346-362` uses `textContent` for integration status and error messages; no Calendar integration path uses `innerHTML`, `eval`, or another unsafe HTML sink.
- `src/main.js:1169-1180,1193-1206` diagnostic events record only operation names, connection state, normalized error code, and revocation-failure boolean. Tokens, authorization codes, PKCE verifier, state, and event payloads are not logged in these paths.

---

## Dependency Audit

```text
Initial deterministic scan:
  Critical: 0
  High:     10
  Moderate: 7
  Low:      0

Final npm audit after remediation:
  Critical: 0
  High:     0
  Moderate: 7
  Low:      0

Remaining advisory roots:
  @jimp/core, @jimp/custom, @nut-tree-fork/nut-js,
  @nut-tree-fork/provider-interfaces, @nut-tree-fork/shared,
  file-type, jimp (all Moderate; no complete upstream root fix available)
```

The deterministic security-weapon scan was run before remediation. Its ephemeral output was reviewed and then removed so generated scan artifacts would not contaminate linting or the working tree.

---

## Next.js / React CVE Check

This is an Electron application and does not install Next.js, React, or React Server Components. CVE-2025-29927, CVE-2025-55182, CVE-2025-55183, CVE-2025-55184, CVE-2025-66478, and CVE-2026-27978 are therefore not applicable to this implementation.

---

## Verification

- `npm run check` — passed (77 files).
- `node --test` — passed (165/165 tests), including all Google OAuth, encrypted token-store, Calendar client, Calendar-tool validation, IPC-dispatch, and tool-schema tests.
- Focused post-audit hardening tests — passed (16/16), including duplicate OAuth callback parameter rejection, callback security headers, and remote Calendar response truncation.
- `npm audit --json` — zero Critical and zero High vulnerabilities after remediation; seven Moderate transitive advisories remain.
- `git diff -- package.json package-lock.json` and full `git status --short` reviewed. Security remediation is limited to dependency manifests and this report; the other modified/untracked files are the pre-existing approved Google Calendar working-tree implementation.

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `package.json` | Upgraded Electron build/runtime dependencies and constrained safe js-yaml/undici versions. |
| `package-lock.json` | Regenerated resolved dependency graph with High/Critical advisories removed. |
| `library/qa/security/2026-08-06-security-audit.md` | Recorded scan, evidence, remediation, focused review, and verification results. |

Run `git diff` to review every change; the remediation diff was reviewed and confirmed security-scoped on 2026-08-06.

---

## Recommended Follow-Up (architectural)

- Track the seven Moderate Jimp/file-type advisories inherited through `@nut-tree-fork/nut-js`; upgrade or replace the dependency once a compatible fixed release exists.
- Add a CI gate equivalent to `npm audit --audit-level=high` so future High/Critical dependency regressions block release.
- Keep Calendar API response limits and renderer `textContent` handling covered by regression tests when event fields or views expand.

---

*Generated by `security-guardian` using `security-weapon`. Quality-guardian was intentionally not run.*
