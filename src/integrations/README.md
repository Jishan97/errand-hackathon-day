# Existing service adapters

Implemented: [sentry-webhook.js](sentry-webhook.js) verifies a bounded signed demo alert and returns a validation-only receipt. See the [setup and limits](../../docs/SENTRY_WEBHOOK.md). It does not call Sentry's API or persist/execute work.

Add small reviewed adapters only when their implementation slice needs them. Do not recreate existing accounts, credentials, GitHub App or the controlled demo repository.

| Service | Intended role |
| --- | --- |
| OpenAI | Existing voice/reasoning integration and coding-worker execution; revalidate current API contracts before reuse |
| Twilio | Existing phone transport and callback delivery |
| Supabase | Existing durable context, task, approval, job and outcome storage |
| GitHub App | Access to the explicitly selected personal demo repository; scoped PR/check/change operations |
| Sentry | Controlled incident input |
| Vercel | Existing deployment and exact-source verification path |

Except for Sentry's input verifier, these are planned roles, not installed SDKs or connected clients. Provider success needs a real receipt/evidence. Do not expose credentials to generated-code workspaces, log raw payloads or retry an uncertain write blindly. See [working rules](../../AGENTS.md).
