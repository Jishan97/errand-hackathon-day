# Gmail operator demo on the shared app

This branch merges main `524f0d4` and adds a single-user Gmail console at `/gmail.html`. It reuses the existing operator token, Supabase project, Vercel deployment and Composio project. Sentry production code and its tables are unchanged. This is a web operator demo, **not yet a phone/chat agent**. It does not require Sentry, GitHub, Twilio or OpenAI to be enabled.

## Owner activation

1. Fetch/check out `codex/composio-gmail`. Keep it on this branch until the team reviews it. Its Vercel preview needs the settings below; they are not automatically copied from production.
2. Review and apply [db/gmail.sql](../db/gmail.sql) once in the existing Supabase project's SQL editor. It adds only `errand.gmail_records`, `gmail_tasks`, `gmail_proposals` and `public.errand_gmail`. The RPC and tables are service-role only. Do not replace or rerun `fast-incident.sql` for this feature.
3. Reuse `PUBLIC_BASE_URL` (the exact public HTTPS app origin, optional trailing slash), `OPERATOR_TOKEN`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Add `ENABLE_GMAIL_DEMO=true`, `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID` in the existing owner-managed configuration. No dotenv files are loaded or needed. Keep the switch off on deployments that are not ready.
4. Follow [Composio Gmail setup](COMPOSIO_GMAIL_SETUP.md#2-configure-gmail-in-composio): use managed Gmail OAuth with read and compose/send access. Configure the project-wide identity verifier as `https://YOUR_APP_HOST/api/connections/gmail/callback`. Use a consenting dedicated demo mailbox. The callback must be reachable without Vercel deployment protection, and callback query strings must not be captured in logs/analytics.
5. Open `/gmail.html`, enter the **existing operator token**, and sign in. Then follow **Connections**, connect Gmail and complete Google consent in the same browser session. Return to the console to search/read, prepare, and approve an exact draft or send.
6. First test with text, then a small image already saved by the generation worker. Separately test a 5 MiB image through the actual Supabase → Composio → Gmail path before claiming maximum-size support works live. The configured adapter cap is 5 MiB (10 MiB raw MIME; about 16.1 MiB stored proposal), not a proven upstream service limit.

The token is checked in constant time and exchanged for a separate HKDF-signed 30-minute `HttpOnly; Secure; SameSite=Lax` cookie. Composio ownership is fixed server-side to `operator-demo`; this is deliberately one mailbox for the authorized operator, not a multi-user login system. Do not share the operator token with callers. Logout clears this browser's cookie; a copied cookie remains valid until expiry or operator-token rotation. The browser remembers only the last proposal/task IDs, never the token or email content.

## Queue, approval and recovery

Preparation writes an immutable proposal only. The console displays the stored recipient, action, subject/body and optional image description. Approval requires its exact digest, explicit message confirmation and separate image confirmation. The server durably records `queued` before `waitUntil` starts the worker. One database transaction consumes approval and records `attempting`; repeated clicks/workers cannot regain that claim. Provider writes have no automatic retries.

The pending list restores unresolved work after reload/sign-in. **Check status** reads the durable result. **Resume / verify outcome** executes a still-queued approved job or reconciles an already-attempted job by reading Gmail. After a worker interruption, reconciliation waits five minutes from the claim; Vercel functions are bounded to 300 seconds. Any alternative host must enforce the same worker lifetime. A known receipt is retained, and unknown sends are searched by the saved Message-ID. A verified send means matching content in Gmail Sent, not recipient delivery.

Queued work can be cancelled before it is claimed, including after reconnecting to another mailbox. Claimed work cannot be cancelled or retried. If it cannot be reconciled (for example a draft timeout without a receipt), first inspect the mailbox manually. The console's manual-closure control requires acknowledgement that the email may already have been sent. It records `manual_review_closed`, operator/time and possible delivery, never `verified` or definite failure. The old approval remains consumed and terminal outcomes cannot be overwritten. A new send requires a new explicit approval; avoid duplicating a prior uncertain delivery.

Changing a prepared message advances the same task's revision and invalidates the previous unclaimed proposal. Invalid addresses/text are rejected before advancing it. Asset/provider failures can still leave that revision without a proposal; prepare a corrected revision again. Unresolved work blocks new work and returns the blocking proposal ID with HTTP 409.

## Shared-core seams

`createGmailRuntime(values)` supplies `connections`, `capability`, `store`, `auth`, `tools`, `bindTools(getAdmittedContext)`, `contextFor(proposalId)` and `run(proposalId)`. The existing incident runtime is not called. Gmail never registers tools on the incident coding agent or reuses the incident's fixed completion-call script.

Main now includes general phone conversation/reminders under `src/phone/`; these commits are included unchanged. Gmail is not registered in that phone runtime yet. The shared core must bind its authenticated caller to the connected Gmail owner, choose trusted task/revision context, register `runtime.tools`, and dispatch function requests through `runtime.bindTools`. It must durably cache tool results and present the saved approval readback before recording consent. Sending remains a worker action. Replacing the single-user operator admission with caller identity is a separate integration step; do not trust caller ID or model-supplied ownership.

Images require a real generation/validation worker. Create a task via `store.newTask()`, generate and sanitize the image for the user's confirmed request, then call the internal `store.putImageAsset({ assetId, userId, taskId, filename, mimeType, description, bytes })`. Use that task and asset ID in the console's saved-image fields or the `gmail_prepare` tool. The runtime resolves the bytes privately from Supabase; no upload endpoint, arbitrary URL fetcher or image generator is introduced here. PNG/JPEG/WebP are supported up to 5 MiB; filenames must be safe ASCII and the image description must match the saved pixels. The upstream worker must decode and strip private metadata/trailing bytes.

## Checks

Run Node 24: `npm ci --ignore-scripts`, `npm run check`, `npm test`. Both `test/*.test.js` (Gmail capability) and `tests/*.test.js` (main plus Gmail operator) run. The incident oracle test harness also works on Windows; its production oracle is unchanged.

For actual PostgreSQL semantics without credentials, install `@electric-sql/pglite@0.5.14` in a disposable external directory and run:

```sh
node db/test-gmail.mjs /absolute/path/to/pglite/dist/index.js
node db/test-fast-incident.mjs /absolute/path/to/pglite/dist/index.js
```

These are local SQL/provider-fixture tests. Owner-run Google consent, maximum-size proxy requests, real mailbox effects and deployment routing still need live acceptance. Do not claim a completed phone/image-generation flow from these checks.

Recorded result after merging main `524f0d4`: **392 JavaScript tests passed on Node 24**, plus **20 separately executed PostgreSQL tests** (8 Gmail, 7 incident, 5 phone), syntax checks and `git diff --check`. SQL tests are not part of `npm test` or the Vercel build. PGlite serializes calls on one connection, so the claim tests prove one-use behavior rather than cross-connection lock contention. Opus 5.5 reviewed the operator implementation and fixes; no code blockers remained in its final review. Subsequent small review findings were fixed and the full suite rerun. The local browser showed the console's honest setup-pending state; deployment CSP and real sign-in remain owner-run acceptance.
