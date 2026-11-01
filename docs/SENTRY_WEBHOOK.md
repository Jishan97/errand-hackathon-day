# Signed Sentry alert receiver

Endpoint: [POST /api/webhooks/sentry](https://errand-hackathon-day.vercel.app/api/webhooks/sentry).
Opening this URL in a browser returns **405** with `Allow: POST`.

This slice verifies delivery only. A matching signed alert returns:

```json
{"status":"verified","receiptId":"<32 hexadecimal characters>","processing":"not_connected"}
```

It emits one structured `sentry_alert_verified` log with that same receipt. It does not persist an incident, deduplicate work, investigate, call anyone, create a PR or repair the demo. A receipt is not a queued job. Repeated deliveries return the same receipt for the same project/issue/release and can log again. Validation-only deliveries will need a new deliberate rehearsal after durable processing is connected.

## Configuration

The owner manages these existing server-only settings in **Vercel → errand-hackathon-day → Settings → Environment Variables → Production**:

| Variable | Purpose |
| --- | --- |
| `SENTRY_WEBHOOK_SECRET` | Internal integration's Client Secret; verifies the HMAC |
| `SENTRY_PROJECT_ID` | Monitored demo's numeric project ID; digits only |

The API token and organization slug already collected for future API operations are not used by this receiver. The separate demo keeps its own `SENTRY_DSN`. No additional setting names or SDKs are required. Keep `ENABLE_INCIDENT_DEMO=false`; full incident execution is still disconnected and this validation-only receiver is independent of that future feature flag.

No dotenv files are loaded. The deployed function reads platform-injected configuration only after a structurally valid signature header is supplied. Local preview uses an empty configuration by default; tests inject fictional settings. Owner-run real delivery checks remain separate from offline tests.

## Verification rules

- POST only, no query string, JSON content type and no compressed body.
- At most 64 KiB, enforced against streamed bytes as well as declared length.
- HMAC-SHA256 over the exact raw bytes, compared in constant time before JSON parsing.
- Only `Sentry-Hook-Resource: event_alert` and action `triggered` proceed.
- Only the configured project and `errand_demo=upload_lf_v1`, a 40-character hexadecimal release and a valid numeric issue ID match.
- Actor/contact information, request contents, stack traces and supplied URLs are discarded. Responses/logs contain only fixed status fields and an opaque receipt digest. No outgoing URL is fetched.

| HTTP status | Meaning |
| --- | --- |
| 200 | Matching alert verified; processing is not connected |
| 202 | Signed payload is outside the selected demo/alert contract and ignored |
| 400 | Query string or correctly signed malformed JSON |
| 401 | Missing/malformed signature; configuration has not been accessed |
| 403 | Signature does not match raw bytes |
| 405 | Use POST |
| 413 | Body exceeds the bounded limit |
| 415 | Expected uncompressed JSON |
| 503 | Receiver unavailable or delivery verification could not finish; no secret/exception text returned |

## Tests and owner-run live check

Run `npm run check` and `npm test` on Node.js 24. The test suite uses invented secrets/IDs, covers the real local HTTP adapter and does not load configuration or call a provider.

After the production deployment is READY, an unauthenticated GET must return 405 and a JSON POST without a signature must return 401. These checks prove routing and rejection only, independently of private settings.

For a real signed Sentry delivery, the owner:

1. Sets this integration's Webhook URL to `https://errand-hackathon-day.vercel.app/api/webhooks/sentry` and enables **Alert Action**. Keep the generic Issues/Errors/Comments/Seer subscription boxes unchecked.
2. Adds the integration to an Issue Alert's **Send a notification via an integration** action. Scope the rule to the fictional demo tag and choose a condition that actually matches the next rehearsal event; the existing issue is already unresolved, so a new-issue-only condition will not necessarily fire again.
3. Triggers the controlled fictional upload and checks Sentry's delivery result plus the sanitized `sentry_alert_verified` receipt log. A generic test notification can lack the required tag/release/issue bindings and return `ignored`; that is not a matching demo acceptance.
4. Shares only redacted status/receipt evidence. A 200/verified receipt proves this receiver boundary, not a phone call or repair. A 503 needs an owner-only check of the saved Client Secret and numeric project ID; values stay private.

The agent does not read deployment secrets, private dotenv files, or run credential-dependent acceptance checks. No real signed delivery is claimed by the synthetic suite or an unsigned production probe.

## Reuse and sources

Release evidence: [77ab8f4](https://github.com/Jishan97/errand-hackathon-day/commit/77ab8f4b9dd4f5998f28661486fecda30e3a807a) reached READY in production on 1 November 2026. All 13 tests pass on Node 24.22.2 and Node 26.7.0. Anonymous production checks returned GET/HEAD 405, missing/malformed-signature POST 401, non-JSON 415 and query-string 400; home/CSS/static health each returned 200 with bytes matching source. These probes do not access deployment configuration. Real signed Sentry delivery and private-setting authentication remain unverified.

The HMAC, project/tag/release binding, normalized incident fields and stable project/issue/release digest are adapted from Errand's pre-event MVP verifier and raw-body HTTP intake. The Vercel Web Request adapter, bounded streaming reader, validation-only receipts and tests were added during the hackathon. No third-party runtime dependency was introduced.

Current official references checked for this implementation: [Sentry webhook signing](https://docs.sentry.io/integrations/integration-platform/webhooks/), [Issue Alert payload](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/), [Sentry Alert Action setup](https://www.sentry.help/en/articles/17443113-how-can-i-enable-webhooks-as-an-alert-action-in-sentry), [Vercel Functions quickstart](https://vercel.com/docs/functions/quickstart).
