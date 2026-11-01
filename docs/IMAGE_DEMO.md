# Image demo — phone request to web screen

Branch `codex/image-demo` starts at main `524f0d4`. This is independent of the Gmail worktree. No Composio, Google consent or email is needed. Phone-to-screen adds one private table in the existing Supabase database; the web text fallback needs no migration.

Open `/image.html`: the demo host enters the existing operator token privately under **Demo access** and clicks **Watch phone requests**. The caller phones the existing admitted demo number, describes a picture, hears the image description read back, and confirms. The shared Agents API planner routes `generate_image`; the existing spoken-confirmation gate authorizes it. Generation runs in the background and saves the result privately. The screen polls every 2.5 seconds, displays the finished JPEG and offers download. The phone caller does not need the operator token.

The text box remains a fallback for rehearsal. Tokens are kept only in the page field/memory, never URLs or browser storage. The fallback image stays in its tab until downloaded; phone results can be reloaded from the private store after entering the token again. The operator screen shows the most recent approved phone request in this controlled demo, not a public or multi-user gallery.

## Owner setup

1. Review/merge or deploy this branch through the existing Vercel project/preview. Production main is not changed by creating this branch. The existing API function configuration allows up to 300 seconds; this image call times out at 180 seconds.
2. Reuse existing server settings **OPENAI_API_KEY** and **OPERATOR_TOKEN**, including the appropriate Vercel Preview scope if testing a branch preview. The operator token must be 32–128 letters, digits, underscores or dashes, matching the incident demo's existing format. Keep values private. No agent reads, creates or loads private dotenv files.
3. Optional new setting for coordination: **OPENAI_IMAGE_MODEL**. Default is `gpt-image-2.5-flare`, selected from current official documentation for everyday generation. An explicit server model is respected with no fallback. If the project uses an approved existing image model (e.g. `gpt-image-2`), set it explicitly. This does not change the agent/voice models. Check image-model account access/verification and available quota privately.
4. Redeploy after changing settings, open `/image.html` on that deployment and run one fictional prompt, such as a birthday card with cats and balloons. Confirm the image actually appears and the downloaded JPEG opens. A health check or an offline test cannot prove generation.

## Enable phone-to-screen (owner steps)

1. Apply additive `db/image-demo.sql` once to the **existing** Supabase project. It creates the private RLS-enabled `errand_image_runs` table, revokes public/anon/authenticated access, and grants only service-role access. This branch does not apply the migration or inspect production rows.
2. Reuse **SUPABASE_URL** (canonical HTTPS origin, no trailing slash) and **SUPABASE_SECRET_KEY** on the image web deployment. They must select the same project as the phone deployment. No storage bucket or new credentials are required. The table holds at most 3 MiB per JPEG encoded as base64; keep this to fictional demo pictures and arrange private retention cleanup afterward.
3. Deploy this branch's updated phone code to the existing phone host as well as its web/API files to Vercel. On the phone host, set **ENABLE_PHONE_IMAGES=true**, preserving existing **ENABLE_LIVE_VOICE**, **ENABLE_M1_INTAKE**, **ENABLE_SHARED_ASSISTANT**, API/model/voice/Twilio and caller-admission settings. Keep the selected voice/agent models unchanged. Optional **OPENAI_IMAGE_MODEL** applies there too. New setting names are constructor/environment contracts for the owner; no private dotenv files are created here.
4. Both deployments use the existing operator token. Open `/image.html`, enter it and connect the screen. Call the configured consenting test number and ask: “Make a picture of a cat with balloons.” The phone planner uses at most 160 characters for the image description so it can be read back clearly. Confirm the request when asked. Check the screen changes from waiting to creating to the actual picture; download and open the JPEG.
5. Decline or correct a proposal and confirm no old image request starts. Repeat confirmation/replayed work and confirm the same claim cannot regenerate. A generation accepted before hangup continues subject to the host's lifetime/budget. Closing a call before approval starts no image job. The phone says generation is starting; it must not claim ready or promise an unimplemented completion call.

`GET /api/images/latest` returns protected metadata; `GET /api/images/result?id=…` returns the protected JPEG. Both require the operator bearer token and are no-store. No base64 image goes into the model conversation. Staging and claiming bind the admitted call hash, exact description/summary digest and nonce. The database claim changes proposed → running atomically; the same proposal cannot execute again. Proposals expire after ten minutes. The generation promise is retained with Vercel `waitUntil` where available, or by the long-lived phone process.

This is a bounded demonstration, not a resumable queue: a restarted/terminated phone worker leaves a claimed record, shown as uncertain after five minutes. It never re-generates automatically. The operator investigates before making another request. No callbacks, email delivery or universal phone onboarding are added by this slice. Existing phone admission and its database prerequisites still apply.

The default `npm start` / `npm run dev` preview intentionally loads no credentials and returns setup-required on authorized generation. For an owner-managed local runtime, inject `imageOptions: { getToken, getConfig }` into `createApp`, using the owner's existing secure config source; do not introduce dotenv loading. Production `api/images/generate.js` supplies settings from the deployment environment, following the existing API entry-point pattern.

## Backend contract

`POST /api/images/generate`, `Authorization: Bearer <existing operator token>`, JSON `{ "prompt": "A friendly dragon on a bicycle" }`. Returns `image/jpeg` bytes on success, no-store; errors are bounded JSON codes. The browser cannot choose a model, API key or destination. Prompt length is 1–2,000 characters. Output is one 1024×1024 low-quality JPEG (compression 80), at most 3 MiB.

`src/images/generate.js` exports `generateImage({ prompt, apiKey, model, fetcher }) → { bytes, contentType, filename }`. `src/images/phone.js` implements private image storage and the approved phone job. The existing shared Agents API planner delegates the image operation; the image rendering itself uses the Images API. There is no second conversational agent or Composio dependency.

No automatic generation retries run. Timeouts/network failures may still have incurred cost; the UI reports uncertainty and the operator checks before making another request. The phone claim/result is durable; automatic job resumption after a process crash is not implemented. The web text fallback has no cross-request deduplication or saved result.

## Validation

Node 24: `npm ci --ignore-scripts`, `npm run check`, `npm test`. Tests inject fictional provider responses and cover authorization, model binding, input/response limits, binary output, moderation/rate-limit errors, timeouts/no retry, and local routing. They do not generate a real image. Keep live acceptance results separate.

Phone tests also cover shared-core planning → scoped approval → one-use claim → image result → protected screen retrieval, refusal/stale consent, disabled capability and uncertain output. The existing incident tests needed only Windows path normalization in two fixture helpers. Full JavaScript suite passes locally. Live phone/image generation and the owner-applied migration still require acceptance.

SQL was executed offline against PGlite with synthetic data: anonymous/authenticated table access is denied, a second claim cannot run, and a ready result requires image content. To repeat, install `@electric-sql/pglite@0.5.14` in an isolated temporary directory and run `node db/test-image-demo.mjs /absolute/path/to/pglite/dist/index.js`. This never connects to the project database.

Browser QA used an explicitly injected solid-colour fixture (not provider generation) to verify phone-screen waiting → creating → displayed image → successful JPEG download. Default-preview access/setup errors and the prompt example controls were also checked. Live acceptance must produce a genuine AI image from a real approved phone request.

Official API references: [Images generation](https://developers.openai.com/api/docs/guides/image-generation#generate-images), [output options](https://developers.openai.com/api/docs/guides/image-generation#customize-image-output). For one prompt/one image the Images API is the direct path; the backend decodes `data[0].b64_json` and returns JPEG bytes.
