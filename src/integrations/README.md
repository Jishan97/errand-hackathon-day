# Existing service adapters — planned

Add small reviewed adapters only when their implementation slice needs them. Do not recreate existing accounts, credentials, GitHub App or the controlled demo repository.

| Service | Intended role |
| --- | --- |
| OpenAI | Existing voice/reasoning integration and coding-worker execution; revalidate current API contracts before reuse |
| Twilio | Existing phone transport and callback delivery |
| Supabase | Existing durable context, task, approval, job and outcome storage |
| GitHub App | Access to the explicitly selected personal demo repository; scoped PR/check/change operations |
| Sentry | Controlled incident input |
| Vercel | Existing deployment and exact-source verification path |

These are planned roles, not installed SDKs or connected clients. Provider success needs a real receipt/evidence. Do not expose credentials to generated-code workspaces, log raw payloads or retry an uncertain write blindly. See [working rules](../../AGENTS.md).
