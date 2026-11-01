# GPT Image through the Agents API

The operator's **Generate image** action now runs a real Agents API session on the team's `gpt-6.1-sol` model. Its `generate_task_image({ prompt })` function calls the OpenAI Images API using `gpt-image-2.5-flare`, one 1024×1024 medium-quality PNG. This is an application function called by the Agents API, not a native image tool hosted inside that API. [Function contract](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [image generation](https://developers.openai.com/api/docs/guides/image-generation).

The backend decodes/re-encodes pixels using pinned `pngjs`, rejects invalid/oversized images and trailing payloads, and strips metadata. It asks `gpt-6.1-sol` to describe the saved pixels, validates that description, and saves the immutable task-owned image in the existing private Gmail asset store. The agent receives only its asset ID, description, filename, size and digest. No bytes, credentials or arbitrary download URLs enter tool results. The image limit remains **5 MiB**.

## Teammate activation

1. Follow [Gmail/Composio setup](COMPOSIO_GMAIL_SETUP.md) and apply `db/gmail.sql` if not already installed.
2. Apply **`db/gmail-image-jobs.sql` once afterward** in the existing Supabase project. It adds the service-role-only generation-claim table/RPC; it does not change Sentry tables.
3. Supply the existing **`OPENAI_API_KEY`** to this branch's deployment alongside the Gmail settings. Its project needs Agents API access, `gpt-6.1-sol` and `gpt-image-2.5-flare` access. No new key or service is required by the code. Private dotenv files are not loaded automatically.
4. In `/gmail.html`, sign in, connect Gmail, expand **Generate an image to attach**, enter a fictional prompt and generate. The task and asset fields fill automatically. Enter the email, prepare, review the exact message and image description, check both consent boxes and approve.
5. Check for **verified** in the operator console and open the image in the consenting recipient's mailbox. Local mocked tests do not prove model access, provider payload limits, delivery or phone completion.

## Shared-core integration

Register `runtime.tools` (Gmail search/read/prepare plus `generate_task_image`) and execute pending Agents API functions through `runtime.bindTools(getAdmittedContext)`. The callback supplies trusted `{ userId, taskId, revision }`; the model cannot choose ownership. Before phone wiring, bind generation to the caller-requested prompt; email content must never authorize an image request or disclosure to the image provider. The operator runner enforces an exact prompt match. Pass the returned `assetId` in `gmail_prepare.attachmentAssetIds`. Approval and sending remain server-owned actions outside the model tool registry. The runnable operator demonstrates the image function round trip; general phone admission, Gmail voice approval and callbacks still need the teammate's shared-core wiring. Never map arbitrary callers to the fixed `operator-demo` mailbox.

## Recovery and boundaries

Generation claims are permanent and scoped to task/revision before the paid request. An identical repeat returns the saved asset without regenerating. A different prompt in that revision, concurrent generation or a failed/uncertain request cannot trigger another paid request. If no saved image exists, explicitly start a new message/task to retry; this may incur another charge. Once an image is saved, a failed Agents API tool-result submission logs a fixed diagnostic and still returns the saved asset. Session cleanup cancels, checks terminal turns and deletes; an unconfirmed cleanup logs a fixed diagnostic without prompt or session IDs. No email is sent by generation.

The operator waits for generation (bounded to 220 seconds plus 15 seconds of cleanup), and stores its task ID before starting. If the browser disconnects, use that task ID and the same prompt to recover a saved image. This is not a durable automatic generation queue or a callback implementation. A process interruption before saving can consume the claim without a recoverable image. Image changes require a new proposal and approval. Captions are model-generated descriptions, not a visual preview or a guarantee of image accuracy. Re-encoding removes embedded metadata, including any provider provenance metadata. The filename identifies it as generated; the approved email body is not silently changed.

Run `npm run check`, `npm test`, and the PostgreSQL harness `node db/test-gmail.mjs /absolute/path/to/pglite/dist/index.js`. It applies both Gmail migrations and checks the real durable claim, ownership, saved image and Gmail approval path with fictional provider responses.

Recorded offline checks: 398 JavaScript tests and 9 Gmail PostgreSQL tests passed on Node 24, including generation replay/failure, real SQL claims, image ownership, sanitization and the approval-bound attachment path. No live provider calls were made.

Opus 5.5 reviewed this addition. Its API/reliability findings were addressed: explicit low reasoning effort and caption budget, longer planning window, Agents-compatible tool fields, cancel/terminal-check cleanup, durable SQL coverage and preserving saved-image success after tool-result submission failure. Focused tests were rerun after these fixes. Live acceptance is still pending.
