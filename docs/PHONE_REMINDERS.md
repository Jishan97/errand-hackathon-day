# General phone chat and reminders

The phone runtime is selectively reused from the proven MVP, isolated in `src/phone/`. GPT-Live handles conversation; GPT-6.1 Sol proposes actions and independently assesses fresh spoken permission. Existing Supabase RPCs save the approved task/job. The existing ten-second scheduler wakes a callback-only worker; Twilio calls the configured test number and GPT-Live opens with the saved reminder. Ordinary conversation remains available while work is pending.

This does not change the controlled Sentry repair worker or the separate demo UI. No new accounts, keys, phone numbers, task tables or cron jobs are required. Browser AI chat is outside this phone slice.

## Existing private settings

The owner manages these in the main app's Vercel Production settings. Agents do not read them or load dotenv files. Use the existing values, with `PUBLIC_BASE_URL=https://errand-hackathon-day.vercel.app`:

- `ENABLE_LIVE_VOICE=true`, `ENABLE_M1_INTAKE=true`, `ENABLE_SHARED_ASSISTANT=true`.
- `OPENAI_VOICE_MODEL=gpt-live-1`, `OPENAI_AGENT_MODEL=gpt-6.1-sol`, existing `OPENAI_API_KEY`.
- Existing `OPERATOR_TOKEN`, `STREAM_TOKEN_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`.
- Existing `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TEST_RESIDENT_NUMBER`.

Saving a changed setting requires a fresh deployment. The sanitized template remains `mvp/.env.example` in the parent workspace. Do not create or pull private files.

After the new deployment is READY, the owner changes the **existing Twilio number's incoming Voice webhook** to `https://errand-hackathon-day.vercel.app/api/voice/incoming`, method **POST**. Outgoing callbacks automatically use `/api/voice/outgoing?job=…`; `/api/media` hosts the signed WebSocket. Existing configured-number admission and explicit spoken action confirmation remain in place.

## Database reuse

`db/phone-claim.sql` adds one service-only callback claim RPC over the existing assistant tables. It cannot claim coding/developer jobs. Two-minute expired call submissions become unknown rather than being retried.

After the deployment is READY, `db/phone-scheduler-activate.sql` routes due reminder wake-ups to this app using the existing database-held worker capability. It preserves the legacy developer/incident wake-up destination and the existing cron job. Neither script returns or replaces a secret. No fast-incident tables, worker or scheduler are changed.

## Short live rehearsal

1. Call the existing Errand number and ask an ordinary question.
2. Say: “Call me in two minutes to remind me to water the fictional plants.”
3. Listen to the specific action/time readback, then approve it. Wait for the saved confirmation.
4. Ask an unrelated question, then hang up.
5. Confirm the callback rings and immediately gives the correct reminder. Report only success or a redacted failure; never share private settings or call identifiers.

The next ten-second scheduler tick and provider ringing add delay. The four-minute call limit remains. A submitted call is not proof it was heard. Live acceptance on this deployment remains pending until the owner completes this rehearsal.

## Verification and provenance

294 offline JavaScript tests pass on Node 24 and 26, including signed loopback HTTP/WebSocket reminder approval → saved job → hangup → exactly one callback submission → bound reminder opening. Model/provider and storage fixtures in this test are explicit; this is not a new real phone call. Five isolated PostgreSQL tests execute the claim/scheduler SQL, including due-time filtering, developer isolation, unknown outcomes, token rejection and service-only permissions.

Run `npm run check`, `npm test`, and `node db/test-phone-claim.mjs /absolute/path/to/a/temporary/pglite/dist/index.js` after temporarily installing `@electric-sql/pglite@0.5.14`. `npm run dev:phone` starts the phone server without loading private files. Existing incident tests remain included in `npm test`.

Reused pieces: MVP voice/media transport, conversation and approval gates, stateless Sol tools, identity/task RPC adapters and callback worker. New work: isolated phone entry point/routing, phone-only configuration selection, callback-only claim/scheduler routing and a complete reminder integration test. Existing demo applications stay in place under MVP.

Official integration references checked: [GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations), [Vercel HTTP-server WebSockets](https://vercel.com/docs/functions/websockets), [Supabase database functions](https://supabase.com/docs/guides/database/functions).
