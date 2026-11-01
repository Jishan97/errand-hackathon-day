# Gmail by phone — integration handoff

For dashboard setup, server settings, Agents API wiring and first live checks, start with [the teammate setup guide](COMPOSIO_GMAIL_SETUP.md). This document defines the adapter and shared-core contracts.

## Scope and evidence

Implemented on `codex/composio-gmail`, merged with main `524f0d4`, 1 November 2026. The target everyday lane remains **connect Gmail once, then ask by phone**. The now-implemented [operator demo](GMAIL_OPERATOR.md) supplies single-user authentication, durable Supabase storage/approvals, background execution and recovery for a web console. Main now includes general phone chat/reminders. Binding Gmail ownership/approvals into that phone flow and Gmail callbacks remain shared-core integration work. Image generation is implemented in the operator and Agents API tool; see [image setup](GMAIL_IMAGES.md).

The branch provides connections and operator pages, Composio-managed account linking, bounded Gmail reads, immutable text/image proposals, approved draft creation/send and byte-checked readback/reconciliation. Framework-neutral tool definitions remain available for the future phone/chat core. No independent general agent or new model choice is introduced.

Only Gmail is enabled. Calendar, Outlook, Drive, Notion, WhatsApp and Telegram remain disabled preview cards. Sentry production modules and tables are unchanged; Gmail uses separate routes/tables in the same app and Supabase project.

Default local preview loads no credentials and reports setup pending. Vercel now has executable Gmail API entry points, gated by `ENABLE_GMAIL_DEMO`. The owner must apply `db/gmail.sql`, configure the existing services and perform live acceptance. Offline tests cannot prove Google consent or real mailbox delivery.

## Teammate wiring

```js
import { createApp } from './src/app.js';
import { createGmailIntegration, gmailTools, bindGmailTools }
  from './src/integrations/gmail/index.js';

// Generic injection seam for the future phone/chat core. The operator runtime already supplies these via src/core/gmail-runtime.js.
const gmail = createGmailIntegration({
  apiKey: configuration.composioApiKey,
  authConfigId: configuration.gmailAuthConfigId,
  publicOrigin: configuration.publicOrigin,
  store: core.gmailStore,
  approvalGate: core.gmailApprovalGate,
  authorizeRead: context => core.canReadGmail(context),
  resolveImageAsset: (context, assetId) => core.resolveImageAsset(context, assetId),
});
const server = createApp({
  connections: gmail.connections,
  authenticate: request => core.authenticateWebRequest(request),
  publicOrigin: configuration.publicOrigin,
});
// Mount the same createConnectionsHandler in another server if preferred.
// Register gmailTools with the existing agent; adapt envelopes to its selected API.
const dispatch = bindGmailTools(gmail.capability, () => core.currentAdmittedCallContext());
// The durable worker (NOT the model tool dispatcher) may call:
// gmail.capability.executeApproved(context, proposalId)
// gmail.capability.reconcile(context, proposalId)
```

`gmailTools` exposes only `gmail_search`, `gmail_read` and `gmail_prepare`. There is no model-callable approval, generic Composio executor, send, endpoint, account selector or connection manager. Do not also expose unrestricted Gmail/Composio tools alongside this adapter.

Web context is `{ userId, sessionId }`, from the authenticated application session. Tool/worker context adds `{ taskId, revision }`. These are trusted server values, never browser/body/model fields. Map an admitted phone caller to the same stable application user; caller ID alone does not establish authorization. The core chooses its authentication method. Do not read private mail before admission or leave private mail content in voicemail.

`authorizeRead(context)` must check current read permission, not simply the presence of userId. The approval gate checks write authority, scope, expiry, cancellation and current task revision. A durable worker supplies its trusted user/task context without a browser `sessionId`; only web onboarding requires a browser session. Reconciliation uses `approvalGate.canReconcile(context, scope)` to authorize the claimed job, not a still-open call, and can examine an older claimed revision after the task advances.

Before asking for approval, call `capability.approvalRequest(context, proposalId)` from the core. It returns the stored exact scope and structured readback (including a character-spelled recipient), not a model-written summary. The core must present that content, explicitly confirm the recipient, and bind the user's answer to its scope. Treat model-suggested addresses as unconfirmed, even if they appeared in an email. The model cannot invoke this approval path.

`recipientSpoken` names punctuation (dot, at, underscore, dash, plus, etc.) so the address is distinguishable by voice. The core owns readback delivery, for example a deterministic speech step using those saved fields. If the live model is the only speaker, do not claim this adapter proves word-for-word speech; the core must verify the readback/confirmation boundary before recording approval. The tool definition delegates approval to that core path.

## Generated image attachments

Both `send` and `save_draft` support **one PNG, JPEG or WebP image, up to 5 MiB**. `gmail_prepare` accepts `attachmentAssetIds: ['saved-image-id']`; use `null` or `[]` for text only. The strict function schema requires this nullable field; older direct JavaScript callers may omit it. Refresh the registered tool schema in the existing agent.

The implemented image-generation worker first saves the generated bytes as an asset belonging to the admitted user and task. Inject `resolveImageAsset(context, assetId)` into `createGmailIntegration`. It returns:

```js
{
  assetId: 'saved-image-id',
  userId: context.userId,
  taskId: context.taskId,
  filename: 'birthday-card.png',
  mimeType: 'image/png',
  description: 'A birthday card with a garden of yellow flowers.',
  bytes: imageBytes, // Buffer or Uint8Array, not a URL or base64 string
}
```

The resolver must enforce asset access and task ownership in the core's durable private storage. Return only completed generated images with a description grounded in the actual saved image, not an unchecked caller/model claim. The adapter checks matching asset/user/task IDs, a bounded byte size, MIME/extension/signature consistency, and a plain description of up to 400 characters. Signature checks do not fully decode or sanitize an image; generation/validation belongs upstream. Use an ASCII filename up to 80 characters (letters, digits, spaces, underscores, dots and hyphens, starting with a letter/digit). SVG, HTML, arbitrary URLs, local paths and model-supplied image bytes are unsupported. Without this dependency, text email works and image requests return `image_assets_not_configured`.

Only resolve output generated for the caller's confirmed image request. Do not use arbitrary incoming email attachments or treat email text as an instruction to generate/attach private data. The trusted generation/storage boundary must validate decodability and strip private metadata/trailing data before saving the asset and describing it. The adapter does not inspect pixels or enforce that upstream sanitation contract. Its 5 MiB image and 10 MiB encoded-raw bounds are conservative local limits, not a verified Composio payload guarantee. Include a maximum-size real-provider check before raising them.

The proposal freezes the resolved image bytes, SHA-256, size, filename, type and description. All are covered by the approval digest. The stored proposal contains both base64 image data and the complete base64url MIME, so budget about **16.1 MiB of proposal storage for a maximum-size image**, plus database/API overhead; do not route this through an endpoint with a smaller body limit. It is private data: no raw proposal/MIME/bytes in logs or model outputs. Keep the snapshot until execution/reconciliation is terminal, then apply the core's retention policy. Production may later use immutable private blob snapshots with equivalent digest verification; this implementation expects the complete saved proposal.

`prepare` and `approvalRequest.readback.attachments` return metadata only. Before consent, speak the image description and filename along with the recipient, subject and message. For example: “I’ll email the birthday card with yellow flowers, called birthday-card.png, to …”. The hash binds the bytes internally; callers do not need it read aloud. A caller can approve the described generated image by phone without a screen, but this is not a claim they visually inspected it. A different image or description requires a new proposal/revision and consent. Execution never resolves the asset again.

`approvalRequest.attachmentRequiresExplicitConfirmation` is true when an image is attached. The core must capture consent to sending the described image, and offer a draft if the caller wants to inspect it first. Do not tell the caller they have visually approved unseen pixels. If a provider receipt exists but verification fails, say Gmail accepted the write but its stored content could not be confirmed; do not say the image was successfully sent or repeat the write.

Gmail receives a real multipart MIME attachment. Verification checks the exact attachment count, filename, MIME type, byte size and SHA-256, fetching the returned message's attachment through the fixed Composio Gmail proxy if Gmail supplies an `attachmentId`. Missing, additional or changed parts cannot pass. Failed reads remain unresolved and can be reconciled without another send. This verifies Gmail's stored image, not inbox delivery or visual quality.

**Implemented:** the image-generation function, durable asset store/resolver and pixel-grounded description; see [GPT Image integration](GMAIL_IMAGES.md). **Still owned by the shared core:** caller binding, voice approval, job/callback wiring and live acceptance. There is no upload endpoint. The model gets the saved asset ID from the core's generation result, then calls `gmail_prepare`; it cannot invoke approval or send directly.

## Store contract (must be durable)

All methods are async. `src/storage/gmail-store.js` and `db/gmail.sql` implement this contract in the existing Supabase project for the operator demo. The in-memory implementation in `test/gmail.test.js` is solely a fixture.

| Method | Required behavior |
| --- | --- |
| `getBinding(userId)` | Return null or `{ userId, accountId, bindingId, email }`. Enforce owner isolation. `bindingId` is a fresh generation on every completed link. |
| `putAttempt(attempt)` | Save `{ id, userId, sessionId, accountId, expiresAt }` before returning the Connect Link. Supersede older pending attempts for that user/session. |
| `getAttempt(userId, sessionId)` | Return only that session's current pending attempt. |
| `finishAttempt(attempt, binding)` | In one transaction compare attempt ID, owner, session, account, expiry and unused state; consume it and save the binding; return boolean. Concurrent or replayed attempts must fail. Rebinding invalidates old task approvals. |
| `putProposal(proposal)` | Immutably store the complete proposal (including raw MIME and digest), checking the task owner/current revision; select it as the task's latest proposal and invalidate older approvals atomically. Reject new attempts while the same work has an unresolved execution. Never upsert over an existing proposal ID. Return exactly true on success, otherwise false/throw. |
| `getProposal(id)` | Load an immutable proposal. Adapter additionally checks owner/task/revision and recomputes its digest. Restrict database access; this contains private mail. |
| `recordOutcome(id, outcome)` | Durably record the claimed execution's receipt/status. Do not release the claim. Protect terminal states against stale concurrent updates. |
| `getOutcome(id)` | Return the persisted outcome, including a known provider ID. |

`approvalGate.claim(scope)` is the critical transaction. Scope contains **userId, taskId, revision, proposalId, action, accountId, bindingId, digest**. Return `true` only if ALL match a live approval produced by an authorized explicit user confirmation, the task still selects this proposal, the binding is current, and no previous execution has claimed it. Atomically consume approval and initialize `{ status: 'attempting' }` for crash recovery via `getOutcome` before returning true. Otherwise return false. The adapter refuses the external write if that recovery record is absent. `approvalGate.canReconcile(context, scope)` returns true only for a core-authorized worker/operator accessing that exact previously claimed scope; it must not require a current browser session or the task's latest revision.

**A claim never becomes available again**, even if a worker lease expires, a provider request times out or persistence after the request fails. An abandoned started execution becomes uncertain and is reconciled by reads. Do not auto-requeue its external write. A fresh approval is not proof an earlier uncertain send failed; resolve uncertainty before proposing another send of the same work.

The adapter guarantees at most one write request per successfully enforced claim, not end-to-end exactly-once delivery. It cannot compensate for a broken/non-atomic core store or deduplicate a fresh task that repeats an uncertain action.

Revision rule: the core allocates a new revision before each new proposal, including a correction. At most one proposal can be saved for a task/revision; a second `prepare` on the same revision must fail. Core retries should retrieve the already saved proposal instead of creating another. Define the same logical errand by its stable task ID; do not bypass unresolved-work blocking by cloning the task. Duplicate caller intents across tasks need core deduplication.

Reconcile only after the original worker has finished or its lease has expired; `canReconcile` must deny it while a write is in flight. Provider outages/revocation/deletion may throw during reconciliation; keep the prior unresolved outcome and tell the caller verification is unavailable. A reconnect may use a new Composio account ID for the same verified mailbox address to reconcile old work; execution still requires the original binding generation.

Manual resolution belongs to the core: for a send/draft that cannot be reconciled, explain that it may already exist and have the user/operator check the dedicated mailbox. Record an explicit `manual_review_closed` decision with actor, time, evidence (if any), and acknowledgement of possible prior delivery before ending that logical work. This is not `verified` or proof of failure and never reopens the old claim. Any genuinely new send is a separate, explicitly approved request with possible duplication explained; never silently retry. The operator console and `close_manual` RPC now implement this flow; closure waits for worker completion or lease expiry and cannot overwrite/reopen a terminal claim.

## Connection setup

Owner-managed settings: `ENABLE_GMAIL_DEMO`, `COMPOSIO_API_KEY`, `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, plus main's existing `PUBLIC_BASE_URL`, `OPERATOR_TOKEN`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Only deployed entry points read their named settings. No private dotenv files are loaded or inspected.

1. Have the owner confirm the project's Composio setup (not verified by this worktree). Select a Gmail OAuth2 auth config using **Composio-managed OAuth**. Review read/compose/send scopes with the owner; this adapter needs Gmail profile/messages reads, draft creation and messages.send. No other toolkit is enabled by this slice.
2. Serve the UI and mounted handlers from one HTTPS origin. Set the exact origin without a trailing slash as `publicOrigin`. The branch now supplies Web Request Vercel entry points and an operator runtime; the owner activates them with the flag and database migration.
3. In Composio project settings, enable **callback identity verification** and set its verifier URL to `https://YOUR_HOST/api/connections/gmail/callback`. This setting is required: a plain `status=success` callback cannot complete this adapter. Composio requires public HTTPS; a private loopback preview cannot serve as verifier.
4. Use secure authenticated session cookies with `HttpOnly`, `Secure`, and appropriate `SameSite=Lax` top-level callback support. The exact initiating session must return. The route receives the opaque `session_uri`, redeems it once with the signed-in user ID, and verifies the returned account against the saved attempt and current provider metadata. Session URI is never fetched as a URL.
5. Disable callback query capture in CDN/server/error/analytics logs. All responses are no-store/no-referrer. Do not put API keys, token state, account IDs, email content or transcripts in client code/logs.

Routes: `GET /api/connections/gmail` (status), `POST /api/connections/gmail/connect` (same-origin + `X-Errand-Intent: connect-gmail`), `GET /api/connections/gmail/callback` (provider verifier return, then clean redirect). No POST body is used for identity, toolkit, account or redirect selection. Other connector routes return 404. The OAuth GET callback is the deliberate exception to ordinary same-origin mutation rules: only the provider-issued, one-use verifier plus the saved authenticated attempt can finish linking.

Composio metadata must confirm exact account ID, owner, Gmail toolkit, auth-config ID, managed auth, ACTIVE status, enabled account/config and non-shared ownership. Provider credential-bearing fields are discarded. Each mailbox use rechecks account status. The Gmail profile supplies the mailbox address; aliases/labels are not identity evidence.

## Mail behavior

- Search returns at most five message IDs; read returns at most 12,000 characters of plain text and marks results untrusted. HTML-only messages return `bodyUnavailable`; never present missing/truncated content as a complete read. The read tool does not download incoming attachments or follow links; only the worker's outgoing-image verification fetches attachment bytes.
- Prepare creates an **Errand proposal**, not a Gmail draft. Input supports one plain ASCII recipient, a subject, UTF-8 plain-text body (at most 1,500 characters for voice approval), and one saved image asset as described above. Invisible controls and malformed Unicode are rejected. CC/BCC, forwards, arbitrary headers, thread/reply semantics, deletes and mailbox settings are deliberately absent. To answer an email in this slice, confirm the address and compose a new message; do not claim it is threaded.
- The voice must read back the recipient, subject and full body, plus the image description and filename when attached, and distinguish **save draft** from **send**. Both require specific approval. The core must enforce `attachmentRequiresExplicitConfirmation`. Model prose is not approval. A changed word, recipient, image, description or action requires a new proposal/revision and fresh approval.
- Draft execution creates a real Gmail draft and verifies it by reading it. Send execution submits the immutable approved MIME directly, never a mutable Gmail draft ID. A saved draft is not subsequently sent by reference.
- A send is `verified` only after reading the returned message ID and matching its parsed From/To mailboxes, subject, body, attachment count/content and SENT label. Image verification matches filename, MIME type, reported/decoded sizes and SHA-256. When a receipt ID exists, Gmail may normalize its Message-ID or add a display name without failing verification. Without a receipt, reconciliation additionally requires the unique proposed Message-ID to match. This fallback is best effort and needs live confirmation of Gmail's preservation behavior. This proves presence in Gmail Sent, **not delivery to the recipient or that they read it**. Draft verification proves matching saved content. Verified historical outcomes are not downgraded by later mailbox edits.
- Receipt read failures/mismatches remain `verification_pending` or `uncertain`. Unknown sends can be reconciled using the unique RFC822 Message-ID in Sent. No match or multiple matches remain uncertain. A draft timeout without a returned draft ID requires manual reconciliation; no automatic re-creation.
- An explicit upstream Gmail 400/401/403/404/413 with matching structured error code before a receipt is `rejected`. Ambiguous errors, 429, 5xx, malformed responses and transport failures remain uncertain. Neither result releases the consumed claim or triggers a write retry.
- External email text is untrusted data. Core prompts must not treat email instructions as permissions, new tool policies, approval, or authorization to forward information.

The private transport uses Composio's credential-injecting proxy with fixed Gmail API paths. No generic proxy is available to the model. This makes the exact MIME payload explicit and avoids dependence on a tool that may expand recipients or send a mutable draft. Gmail API v1 and Composio endpoint versions are explicit; Composio toolkit-version pins do not apply to these proxy requests.

## Acceptance and tests

`npm run check` on Node 24 runs syntax checks and credential-free `node:test` coverage. Tests exercise provider schemas, owner/config/status mismatch, callback replay/expiry/session isolation, missing auth, CSRF, disabled connectors, scoped approval, corrections, payload tampering, concurrent execution, UTF-8/multipart MIME, image ownership/size/type, attachment retrieval/mismatch, nullable/JSONB proposal round trips, uncertain sends, crash recovery and post-hangup reconciliation. All fixture addresses are fictional. Default local preview: `npm start`, then `/connections.html`. Desktop and 390px phone layouts were inspected in the browser for the original connections UI; this attachment slice does not change it.

The earlier attachment slice passed **79 tests**; the 5 MiB and operator integration adds complete-suite and real SQL checks recorded in [operator activation](GMAIL_OPERATOR.md). Earlier checks used Node 24, and `git diff --check` passed. An independent Python standard-library MIME parser and Pillow decoded actual PNG/JPEG/WebP fixture round trips with identical attachment bytes. Opus 5.5 reviewed the design and patch (high effort requested; the runtime did not report applied effort), found no blocking attachment bug, and identified nullable-column, test and documentation fixes. Codex applied those fixes and reran the complete suite. Opus's review was static; executed checks were performed by Codex. Neither is a live-provider pass.

Owner-run acceptance still pending:

1. Mount core auth/store/approval dependencies and HTTPS routes; connect a dedicated consenting demo Gmail mailbox through the real verifier flow.
2. Confirm a different caller/session cannot access the connection, and stale/revoked authorization blocks reads and sends.
3. Read a seeded fictional repair email by phone. Prepare an exact message; change the date; confirm the old approval fails.
4. Approve save-draft and verify actual Gmail draft content; separately approve a send and verify Sent plus receipt in the dedicated test inbox.
5. Replay the job and simulate a worker interruption; demonstrate no second write from the same claim and honest uncertainty until reconciliation.
6. Hang up, let the shared durable worker finish, and hear the callback only after verified outcome. Rehearse refusal/cancellation and ordinary conversation while waiting.
7. Generate and save a small fictional image through the shared core. Check the real resolver path decoded it and stripped metadata/trailing bytes before saving (the core will typically need an image library). Prepare by asset ID and approve its saved description. Verify the draft and a separately approved send contain the actual image; open it in the controlled receiving inbox, including WebP if used. Separately test maximum size through the proxy and attachment download, including Gmail's reported sizes/type/filename. Change the image before approval, test a wrong-task ID, and interrupt attachment verification to prove there is no second send. Do not call the generated-image demo working until this owner-run check passes.

## Official contracts consulted

- [Composio managed Connect Links](https://docs.composio.dev/reference/v3/api-reference/connected-accounts/postConnectedAccountsLink)
- [Connected-account metadata](https://docs.composio.dev/reference/v3/api-reference/connected-accounts/getConnectedAccountsByNanoid)
- [Callback identity verification](https://docs.composio.dev/reference/v3/api-reference/connected-accounts)
- [Complete deferred OAuth](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth)
- [Composio proxy request/response](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy)
- [Gmail messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [drafts.create](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create), [messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail structured errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Gmail MIME attachments](https://developers.google.com/workspace/gmail/api/guides/sending#create_messages_with_attachments), [attachment retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get)

These are documentation checks, not evidence of credentials or a live provider pass.
