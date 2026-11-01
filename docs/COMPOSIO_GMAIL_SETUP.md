# Teammate setup: Composio + Gmail + Agents API

Checked against official documentation on 1 November 2026. Start with [operator activation](GMAIL_OPERATOR.md) for the runnable single-user console, then use [GMAIL_INTEGRATION.md](GMAIL_INTEGRATION.md) for the exact storage, approval and worker contracts.

## What runs where

```text
Caller → shared phone/voice core → Agents API
                                  ↓ requests a function
                         Errand backend tool handler
                                  ↓ authenticated request
                         Composio → Gmail API
                                  ↓ result
                         Errand → Agents API → caller

Approved write: exact readback → recorded user approval → durable worker
               → Composio → Gmail → verification → callback
```

The Agents API manages the agent loop. Your application executes function handlers and submits their results; registering a tool does not host its implementation inside OpenAI. This slice uses application functions backed by Composio REST, not a remote Composio MCP connection. See [OpenAI function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions).

**Current state:** `/gmail.html` now has operator sign-in, search/read, exact draft/send approval and durable recovery. The Vercel functions, Supabase migration/store and approved worker are implemented. GPT Image generation through an Agents API function is implemented; apply the additional migration and OpenAI setting in [GMAIL_IMAGES.md](GMAIL_IMAGES.md). General phone/chat caller admission and Gmail result callbacks remain separate work. This branch does not connect Gmail tools to the incident coding agent. Live Google consent/mailbox acceptance is not yet verified.

## 1. Get the code and confirm prerequisites

- Use the `codex/composio-gmail` branch. Fetch it from the shared repository with `git fetch origin`, then check it out with `git switch --track origin/codex/composio-gmail` (or switch to your existing local branch of that name). `git pull main` alone will not obtain these changes. Review this branch before merging into deployed main.
- Use Node 24. Run `npm run check`; no Composio SDK installation is needed because the adapter uses built-in `fetch`.
- Confirm access to the team's existing Composio project, existing OpenAI setup, shared durable store, and the server that will handle authenticated Errand requests. Reuse existing setup; the owner can create missing Composio configuration through the dashboard if it has not been done.
- Have a consenting dedicated Gmail demo account and a second controlled test inbox. Seed a fictional plain-text repair email. Do not use real private emails in a public demo.

## 2. Configure Gmail in Composio

1. Open the [Composio dashboard](https://dashboard.composio.dev/) and select the intended team project. Keep the project API key and auth config in that same project.
2. Under **Auth Configs**, inspect an existing Gmail configuration. If none exists, choose **Create Auth Config**, select **Gmail**, and use **OAuth2 with Composio-managed authentication**. Save the config and retain its `ac_…` ID server-side. Dashboard wording can change; the required properties are toolkit `gmail`, OAuth2, managed auth and enabled status.
3. Use the project's API key from its API-key settings. Never paste it into source, chat, screenshots or client JavaScript.
4. Check the permissions offered by managed auth against the operations below. Google may display Composio's name during consent. This path does not require creating your own Google OAuth client or collecting a Gmail password. [Managed OAuth documentation](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app).

| Capability | Gmail permission to verify |
| --- | --- |
| Profile, search, read message bodies and read Sent for verification | `https://www.googleapis.com/auth/gmail.readonly` or an applicable broader granted scope |
| Create/read drafts and send the approved message | `https://www.googleapis.com/auth/gmail.compose` or an applicable broader granted scope |

`gmail.compose` includes send capability; `gmail.send` alone cannot create/read drafts, and `gmail.metadata` cannot read message bodies. These are required capabilities to check against the managed grant, not instructions to add custom scopes unsupported by the managed app. If its available grant does not cover the flow, stop and coordinate the configuration change. This adapter deliberately rejects custom/non-managed auth configs; switching to your own Google OAuth app needs a reviewed code/config change. Avoid requesting full permanent-delete access for this demo. [Google scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes).

An auth config (`ac_…`) is a shared authentication blueprint. A connected account (`ca_…`) belongs to a specific user after consent. Do not substitute one for the other or use one team mailbox as every caller's account. [Composio auth configs](https://docs.composio.dev/reference/api-reference/auth-configs).

## 3. Activate the operator runtime in the existing app

Follow [GMAIL_OPERATOR.md](GMAIL_OPERATOR.md). Apply `db/gmail.sql` once in the existing Supabase project. Keep the incident tables and worker untouched. The server entry points now construct `createGmailRuntime`; there is no separate backend to build for this operator demo.

| Setting | Purpose |
| --- | --- |
| `ENABLE_GMAIL_DEMO=true` | Explicit opt-in; disabled otherwise |
| `COMPOSIO_API_KEY` | Existing project API key, server only |
| `COMPOSIO_GMAIL_AUTH_CONFIG_ID` | Enabled managed Gmail auth config |
| `PUBLIC_BASE_URL` | Reuse main's public HTTPS app origin, optional trailing slash |
| `OPERATOR_TOKEN` | Reuse main's operator token; exchanged for a signed browser cookie |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Reuse main's service-role database access |

Owner supplies these in the existing private configuration system, never source or a real dotenv file accessed by an agent. `ERRAND_PUBLIC_ORIGIN` is superseded by `PUBLIC_BASE_URL`. The runtime normalizes the trailing slash before passing the exact origin to the Gmail adapter.

The deployment includes `api/gmail/[action].js` and `api/connections/gmail/index.js` / `[action].js`, using main's Web Request and `waitUntil` pattern. The same routes can be mounted locally with `createApp({ gmailOptions })` and synthetic injected dependencies for tests. Default `npm start` remains credential-free/setup-pending; it does not instantiate real providers. The owner performs live checks on the configured HTTPS deployment.

## 4. Enable the callback identity verifier

After the authenticated HTTPS handlers are reachable, open Composio project **Settings → General → Configuration** and configure callback identity verification:

```text
https://YOUR_ACTUAL_APP_HOST/api/connections/gmail/callback
```

Use the same origin as `PUBLIC_BASE_URL`. This is the application's verifier URL, not a Google OAuth redirect URI to invent or replace. Local `127.0.0.1` is not accepted; an owner-managed public HTTPS tunnel is an option for local backend testing.

This verifier is mandatory for this adapter and applies project-wide to OAuth connections. Coordinate it with anyone using other OAuth flows in the same Composio project. Once enabled, begin the Gmail connection from **Errand's Connect Gmail button**, not the Composio dashboard: dashboard-owned users cannot satisfy your app's identity check. The provider's `callback_url` does not replace this verifier setting. [Verifier setup and behavior](https://docs.composio.dev/reference/v3/api-reference/connected-accounts#callback-identity-verification).

Keep the initiating authenticated browser session through the top-level return (`HttpOnly`, `Secure`, appropriate `SameSite=Lax`). Suppress query strings for this route in proxy/CDN/access/error/analytics logs. Composio returns a one-use `session_uri`; our handler redeems it with the signed-in user ID, matches the saved pending account, checks Gmail ownership/status and saves the binding. Do not manually replay callback URLs or trust a `status=success` query. [Completion endpoint](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth).

## 5. Later: wire the shared phone/chat Agents API loop

Text-email controls are deterministic. The image-generation control runs an Agents API session; see [GMAIL_IMAGES.md](GMAIL_IMAGES.md). Main's coding-agent loop is incident-specific; do not attach Gmail to it. When the shared phone/chat loop is available, keep the team's chosen model and agent/session. Register `runtime.tools` in that agent's tools to include Gmail and image generation. `runtime.tools` omits the Responses-only `strict` field to match the installed Agents API SDK contract. The backend validates every argument.

Create `dispatch = runtime.bindTools(getTrustedCallContext)`. Handle pending functions in `session.required_actions` from the `agent.session.requires_action` event (or a retrieved session). Pass the selected function name and its arguments to dispatch, preserving the server-owned caller/task context. Submit its result using `agent.session.input.tool_result` with the original `turn_id` and `call_id`. The existing core should durably cache results by session/turn/call and resubmit cached results on reconnect, rather than blindly running the action again. [Official function-event contract](https://developers.openai.com/api/docs/guides/agents-api/tools/functions).

Example of the adapter call inside the core's existing pending-action handler (not a standalone runnable agent):

```js
// Only after verifying this is a pending call for the user's bound agent session.
const output = await dispatch(action.name, action.arguments);
// Persist output under sessionId + action.turn_id + action.call_id before returning it.
await client.beta.agents.sessions.events.create(sessionId, {
  events: [{
    type: 'agent.session.input.tool_result',
    turn_id: action.turn_id,
    call_id: action.call_id,
    success: true,
    output: JSON.stringify(output),
  }],
});
```

Use the core's existing error path to send sanitized `success: false` results. Do not return raw provider errors, credentials or callback tokens. Handle only names present in `gmailTools`; the dispatcher rejects everything else. Do not enable the full Gmail toolkit or an unrestricted Composio MCP server alongside these bounded functions.

The model can search, read and prepare. **Sending and saving a Gmail draft stay in the core's approved durable worker:** get `approvalRequest`, deliver its saved readback, record exact user consent, then invoke `executeApproved`. A spoken “yes” must be bound by the core to the current proposal; the model cannot grant itself permission. `gmail_prepare` returning successfully means a proposal is saved, not that Gmail has been changed.

For the image demo, the core's generation tool saves the output and returns its asset ID to the agent. The agent then prepares `{ action: 'send', to, subject, body, attachmentAssetIds: [assetId] }`. Refresh `runtime.tools` in the agent configuration: the schema requires `attachmentAssetIds` (use `null` for no image). The core must read back the saved attachment description and filename and enforce `attachmentRequiresExplicitConfirmation` before approving it. Preparation freezes one PNG/JPEG/WebP up to 5 MiB; the worker later verifies Gmail's stored bytes. The upstream generator must decode the image and strip private metadata/trailing data before saving it, typically using an image library; the Gmail adapter only checks its signature. Keep proposal bytes private and account for approximately 16.1 MiB of persisted data at the maximum size; smaller demo images reduce storage/proxy load. The generator and operator Agents API round trip are implemented in this branch. The teammate must still register these tools and caller-scoped approval in the shared phone agent.

## 6. Connect and prove the operator flow

1. Open `/gmail.html` on the configured HTTPS origin. Sign in using the existing operator token; it is cleared from the input and is not stored in browser storage.
2. Follow **Connections**, connect the dedicated demo Gmail account, and complete consent within the same 30-minute browser session. OAuth attempts expire after ten minutes.
3. Return to the console. Search a fictional seeded email and read its plain-text body.
4. Prepare **Save a draft**. Review the exact recipient, subject and message, tick confirmation, and approve. Check status and inspect Gmail Drafts; it must not send.
5. Prepare a separate **Send an email**. Correct a field and re-prepare; the old revision must fail approval. Approve the final content. Check Gmail Sent and the controlled receiving inbox.
6. Reload and use the restored pending proposal. Repeated jobs must not duplicate a send. Test an interrupted worker, resume/reconcile, queued cancellation after reconnect, and explicit manual closure when a result cannot be resolved.
7. For images, first save a generated/sanitized asset through the core worker seam described in [GMAIL_OPERATOR.md](GMAIL_OPERATOR.md#shared-core-seams). Use its task/asset IDs in the console. Confirm image-specific consent and the receiving inbox's image. Test a small image first, then the maximum 5 MiB route separately.

Only after these owner-run checks should the team call the operator Gmail demo live. Phone/chat, image generation and heard callbacks remain separate acceptance checks. Keep evidence redacted rather than raw mail, credentials or account IDs.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Setup pending / 503 / API returns HTML | Check ENABLE_GMAIL_DEMO, branch deployment/API routes, PUBLIC_BASE_URL and the Gmail migration. Preview settings can differ from production. |
| Sign-in needed / 401 | Sign in at /gmail.html with the existing operator token, then connect in that same browser session. |
| `invalid_origin` / 403 on connect | Exact HTTPS origin, same-origin routing and `X-Errand-Intent: connect-gmail`; never derive trusted origin from request Host. |
| Google says app blocked or Workspace refuses consent | Owner/admin must check provider policy and managed-app access. Do not bypass security warnings or silently switch to custom OAuth. |
| Connection failed on return | Verifier setting, public backend path, session cookie, matching pending attempt and 10-minute expiry. A dashboard-created flow is not an Errand-user flow. |
| `connection_unavailable` | Same project/config, Gmail toolkit, managed OAuth, ACTIVE/enabled account and config, expected owner; status also checks Gmail profile. Reconnect after fixing access. |
| Gmail read works but draft/send is rejected | Review granted compose/send permissions and Workspace policy; this is not proof that a write succeeded. |
| `approval_required_or_already_claimed` | Check latest task revision, exact proposal digest/action/binding, consent and existing execution. Never reset a consumed claim just to retry. |
| `claim_outcome_required` | Core claim transaction failed to create the durable `attempting` outcome. Fix the store contract before a live write. |
| `uncertain` / `verification_pending` | Open the pending proposal, reconcile, or inspect the mailbox and explicitly record manual closure. Never automatically resend. |
| No callback after hangup | Shared worker/job/callback integration, not Composio authentication. |

Keep other connector cards disabled. No iMessage integration is included.
