# Security Audit Report: Gmail read-only integration

**Audit date:** 2026-08-07  
**Auditor:** security-guardian  
**Scope:** Gmail OAuth scope upgrade, encrypted credential reuse, Gmail API client, Realtime tools/permissions, prompt-injection boundary, diagnostics, and tests  
**Application stack:** Electron / JavaScript / Node.js  

## Executive Summary

The Gmail integration is safe for local development after one High-severity diagnostic-PII issue was fixed. Gmail search queries and opaque message IDs are now redacted before diagnostic persistence, message results remain out of diagnostic logs, OAuth tokens remain encrypted or memory-only, read operations require the exact Gmail scope, and email prompt injection is explicitly distrusted at both system-prompt and tool-schema boundaries.

**Production release blocker:** `gmail.readonly` is a Google restricted scope. Because retrieved email is sent to OpenAI for assistant processing, production distribution must complete Google's restricted-scope verification and any required security assessment before release.

## Scorecard

| Category | Status | Findings |
|---|---|---:|
| OAuth / Credentials | OK | 0 |
| PII Exposure | FAIL (remediated) | 1 High |
| Prompt Injection | OK | 0 |
| Input / Response Bounds | OK | 0 |
| Dependency Security | ATTN | 1 Moderate upstream chain |
| Production OAuth Compliance | BLOCKED before release | 1 operational requirement |

## Critical Findings

None detected.

## High Findings — fixed

- [x] **Email-search PII in diagnostics** — `src/main.js:1033` previously sent all tool arguments through the generic diagnostic sanitizer, allowing names, addresses, subjects, or other sensitive terms in Gmail queries to persist in local logs. `src/main.js:1755-1767` now replaces Gmail queries and message IDs with fixed redaction markers before logging.

## Medium / Follow-up

- [ ] **Restricted-scope production verification** — `src/integrations/google/google-oauth.js:8,88` requests `https://www.googleapis.com/auth/gmail.readonly`, which Google classifies as restricted. Configure Gmail API access, add the exact scope to the OAuth consent screen, complete restricted-scope verification, publish a privacy policy describing email processing, and complete a security assessment if Google requires one for server transmission. Source: https://developers.google.com/workspace/gmail/api/auth/scopes
- [ ] **Transitive image-parser denial of service** — `npm audit` reports seven existing Moderate advisories inherited through `@nut-tree-fork/nut-js` / Jimp / `file-type`; zero High or Critical vulnerabilities and no complete upstream fix.

## Focused Control Review

- **Least privilege:** `src/integrations/google/google-oauth.js:8-12` adds only Gmail read-only access; no modify, compose, send, settings, or broad mail scope.
- **Scope upgrade safety:** `src/integrations/google/google-oauth.js:45-62,138` refuses Gmail calls made with the existing Calendar-only grant and instructs the user to reconnect. `getStatus()` exposes whether Gmail was actually granted (`:170-185`).
- **Credential handling:** the existing encrypted refresh-token store is reused; access tokens stay in main-process memory. `src/integrations/google/gmail-client.js:9-21` sends bearer tokens only to the fixed HTTPS Gmail API origin.
- **Data minimization:** search returns bounded metadata/snippets first; full body retrieval is a separate tool. Results cap at 25 messages, snippets at 1,000 characters, and bodies at 20,000 characters (`src/integrations/google/gmail-client.js:2-6,113-115`).
- **Remote-error hygiene:** `src/integrations/google/gmail-client.js:160-191` maps status codes to fixed messages and never returns raw Gmail response bodies.
- **Tool authorization:** Gmail tools are classified `sensitive` in `src/realtime/tool-permissions.js`; existing permission enforcement therefore applies before each email search/read.
- **Prompt injection:** `src/realtime/prompts.js:19` and `src/realtime/tools/tool-schemas.js:415,445` tell the model to treat email as untrusted data and never execute email-borne instructions.
- **Diagnostics:** `src/main.js:1755-1767` redacts Gmail queries and message IDs; `summarizeToolResult` does not persist email content.

## Verification

- Deterministic security scan: **0 Critical, 0 High, 7 Moderate** dependency advisories.
- `npm test`: **182 passed, 0 failed**.
- `npm run check`: passed.
- `git diff --check`: passed before the final report addition.
