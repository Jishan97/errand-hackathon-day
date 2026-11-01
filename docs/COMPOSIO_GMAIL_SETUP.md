# Teammate setup: Composio + Gmail + Agents API

Checked against official documentation on 1 November 2026. Start here for setup, then use [GMAIL_INTEGRATION.md](GMAIL_INTEGRATION.md) for the exact storage, approval and worker contracts.

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

**Current state:** the Gmail module and UI exist, including outgoing image attachments; this worktree does not instantiate an OpenAI client, create an agent, wire the function-event loop, implement the shared store/image generator, or deploy a backend. Those remain shared-core integration tasks. Do not interpret offline tests as a live Agents API/Gmail pass.

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

## 3. Supply server configuration and the shared core

The following names are proposed for the existing owner-managed secret/configuration system. Map them to constructor arguments; the module does not automatically read environment variables or load dotenv files.

| Server setting | Constructor field | Value |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | `apiKey` | Project API key, server only |
| `COMPOSIO_GMAIL_AUTH_CONFIG_ID` | `authConfigId` | The enabled managed Gmail `ac_…` config |
| `ERRAND_PUBLIC_ORIGIN` | `publicOrigin` | Actual HTTPS app origin, with no path or trailing slash |

Use `createGmailIntegration` from `src/integrations/gmail/index.js`. The [integration example](GMAIL_INTEGRATION.md#teammate-wiring) shows the imports. Supply:

- `store`: the eight durable methods in the [store contract](GMAIL_INTEGRATION.md#store-contract-must-be-durable), implemented using the shared database.
- `approvalGate.claim` and `approvalGate.canReconcile`: the core's atomic write authorization and recovery authorization.
- `authorizeRead`: the admitted caller's current Gmail-read permission.
- `resolveImageAsset(context, assetId)`: for image email, resolve completed user/task-owned generated bytes from private storage. See the [image asset contract](GMAIL_INTEGRATION.md#generated-image-attachments). Omit only for text email. No new Composio connector or Gmail write endpoint is needed for images; attachment readback needs the existing Gmail read permission.
- For web routes, `authenticate(request)` returning trusted `{ userId, sessionId }`. Use the same stable user ID for the admitted phone caller and web onboarding. The model must not choose it.

Mount `createConnectionsHandler` in the shared Node backend, or use `createApp({ connections, authenticate, publicOrigin })`. Start/listen through that backend's normal entry point. Serve the page and API paths on the same public HTTPS origin, directly or through same-origin routing. The existing `npm start` intentionally remains a credential-free preview and will show **Setup pending**.

**Vercel caveat:** the current `vercel.json` publishes static `public/` files. Adding secrets or deploying the new page does not make `src/app.js` execute. The shared-core owner must add a backend/function deployment adapter and route `/api/connections/*` to it. An OAuth callback cannot land on static HTML or deployment-protection login. Do not replace the shared core with the memory store in the tests.

## 4. Enable the callback identity verifier

After the authenticated HTTPS handlers are reachable, open Composio project **Settings → General → Configuration** and configure callback identity verification:

```text
https://YOUR_ACTUAL_APP_HOST/api/connections/gmail/callback
```

Use the same origin as `ERRAND_PUBLIC_ORIGIN`. This is the application's verifier URL, not a Google OAuth redirect URI to invent or replace. Local `127.0.0.1` is not accepted; an owner-managed public HTTPS tunnel is an option for local backend testing.

This verifier is mandatory for this adapter and applies project-wide to OAuth connections. Coordinate it with anyone using other OAuth flows in the same Composio project. Once enabled, begin the Gmail connection from **Errand's Connect Gmail button**, not the Composio dashboard: dashboard-owned users cannot satisfy your app's identity check. The provider's `callback_url` does not replace this verifier setting. [Verifier setup and behavior](https://docs.composio.dev/reference/v3/api-reference/connected-accounts#callback-identity-verification).

Keep the initiating authenticated browser session through the top-level return (`HttpOnly`, `Secure`, appropriate `SameSite=Lax`). Suppress query strings for this route in proxy/CDN/access/error/analytics logs. Composio returns a one-use `session_uri`; our handler redeems it with the signed-in user ID, matches the saved pending account, checks Gmail ownership/status and saves the binding. Do not manually replay callback URLs or trust a `status=success` query. [Completion endpoint](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth).

## 5. Wire the existing Agents API loop

Keep the team's chosen model and existing agent/session. Register the definitions exported as `gmailTools` in that agent's tools. The adapter's `strict` field and schema constraints must be validated against the team's chosen API/SDK when wiring; do not assume the local unit tests checked that API configuration.

Create `dispatch = bindGmailTools(gmail.capability, getTrustedCallContext)`. Handle pending functions in `session.required_actions` from the `agent.session.requires_action` event (or a retrieved session). Pass the selected function name and its arguments to dispatch, preserving the server-owned caller/task context. Submit its result using `agent.session.input.tool_result` with the original `turn_id` and `call_id`. The existing core should durably cache results by session/turn/call and resubmit cached results on reconnect, rather than blindly running the action again. [Official function-event contract](https://developers.openai.com/api/docs/guides/agents-api/tools/functions).

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

For the image demo, the core's generation tool saves the output and returns its asset ID to the agent. The agent then prepares `{ action: 'send', to, subject, body, attachmentAssetIds: [assetId] }`. Refresh `gmailTools` in the agent configuration: the strict schema now requires `attachmentAssetIds` (use `null` for no image). The core must read back the saved attachment description and filename and enforce `attachmentRequiresExplicitConfirmation` before approving it. Preparation freezes one PNG/JPEG/WebP up to 2 MiB; the worker later verifies Gmail's stored bytes. The upstream generator must decode the image and strip private metadata/trailing data before saving it, typically using an image library; the Gmail adapter only checks its signature. Keep proposal bytes private and account for approximately 6.5 MiB of persisted data at the maximum size; smaller demo images reduce storage/proxy load. Image generation itself must be wired by the teammate in the shared agent; it is not implemented in this branch.

## 6. Connect and prove the flow

1. Sign into Errand as the consenting demo user, then open `/connections.html` on the configured HTTPS origin. Before connection, authenticated `GET /api/connections/gmail` should return `not_connected`, not 503 or 401.
2. Choose **Connect Gmail**, review Google's account and permissions, and complete consent in that browser session. Return to the connections page and confirm the intended mailbox appears as **Connected**. OAuth connects Gmail; it does not itself start an Agents API session.
3. Through the admitted phone/agent context, search for the seeded fictional email and read its plain-text body. Confirm no cross-user mailbox access.
4. Prepare a short **save draft** request to the controlled recipient. Hear the exact readback and approve it. Inspect Gmail Drafts to confirm the actual result; it must not send.
5. Prepare a separate **send** request. Correct the date before approval and verify the previous proposal cannot execute. Approve the final recipient, subject and body. Confirm Gmail Sent and receipt in the controlled inbox. The adapter's `verified` status proves Gmail readback, not recipient delivery.
6. Replay the same worker job and verify no second external write. Test uncertainty/reconciliation without auto-retrying. Hang up before completion and confirm the shared worker persists and calls back with the actual result.
7. Repeat draft/send with a small generated fictional image. Check the actual resolver path decoded and stripped metadata/trailing bytes before storing the asset. Confirm the received attachment opens and changed image bytes cannot satisfy the old approval. Separately test the maximum supported size through Composio, including Gmail attachment download and reported decoded sizes. A Gmail Sent readback alone does not prove delivery.

Only after these checks should the team describe the full Gmail-by-phone demo as working. Keep evidence redacted: operation/status/test result rather than raw mail, tokens, phone numbers or private account IDs.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Setup pending / 503 / API returns HTML | Shared backend is not mounted, dependencies were not injected, or static Vercel routing is serving the request. Credentials alone do not fix this. |
| Sign-in needed / 401 | Errand web authentication is absent/expired. Connect as the same user/session that will return from Google. |
| `invalid_origin` / 403 on connect | Exact HTTPS origin, same-origin routing and `X-Errand-Intent: connect-gmail`; never derive trusted origin from request Host. |
| Google says app blocked or Workspace refuses consent | Owner/admin must check provider policy and managed-app access. Do not bypass security warnings or silently switch to custom OAuth. |
| Connection failed on return | Verifier setting, public backend path, session cookie, matching pending attempt and 10-minute expiry. A dashboard-created flow is not an Errand-user flow. |
| `connection_unavailable` | Same project/config, Gmail toolkit, managed OAuth, ACTIVE/enabled account and config, expected owner; status also checks Gmail profile. Reconnect after fixing access. |
| Gmail read works but draft/send is rejected | Review granted compose/send permissions and Workspace policy; this is not proof that a write succeeded. |
| `approval_required_or_already_claimed` | Check latest task revision, exact proposal digest/action/binding, consent and existing execution. Never reset a consumed claim just to retry. |
| `claim_outcome_required` | Core claim transaction failed to create the durable `attempting` outcome. Fix the store contract before a live write. |
| `uncertain` / `verification_pending` | Reconcile or use the documented manual-review path; do not create another send automatically. |
| No callback after hangup | Shared worker/job/callback integration, not Composio authentication. |

Keep other connector cards disabled. No iMessage integration is included.
