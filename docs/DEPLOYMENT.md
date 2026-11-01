# Web and signed-webhook deployment

The immediate goal is a working public page and a repeatable Git-to-Vercel pipeline. Bring MVP capabilities across one at a time after this foundation works. Keep existing demos and their connections in MVP.

## Source and target

- Source: [errand-hackathon-day](https://github.com/Jishan97/errand-hackathon-day), production branch `main`.
- Vercel project: `errand-hackathon-day`, in the owner's existing Vercel account.
- Public production URL: [errand-hackathon-day.vercel.app](https://errand-hackathon-day.vercel.app). Use this for sharing; generated deployment/scoped aliases can require Vercel sign-in.
- Repository root: the root of this standalone repository. Do not configure a `hackathon-day/` root directory inside it.
- Production output: static `public/` plus the single `api/webhooks/sentry.js` Node.js Function. MVP/private preparation records are outside this repository and output.

## Build settings

Tracked [vercel.json](../vercel.json) selects the Other framework preset, skips installation because there are no dependencies, runs `npm run check && npm test`, and publishes `public/` alongside the API function. Node is pinned to 24.x; the short verification function has a 10-second maximum duration. There is no bundler or application framework to provision.

The native Vercel GitHub integration handles deployments from pushes to `main`. No GitHub Actions deployment token, private dotenv loading or environment pull is required. Use small reviewed commits; normal `git push origin main` updates the production site once the project connection is active. Do not force-push over the collaborator's changes.

## Local preview

Run `npm run check`, `npm test`, then `npm run dev`. Open `http://127.0.0.1:3000/`. The Node server serves the same allowlisted HTML, CSS and health JSON and adapts `/api/webhooks/sentry` to the shared verifier. It reads no private configuration and makes no provider requests; local signed acceptance uses injected fictional configuration in tests. See the [Sentry receiver guide](SENTRY_WEBHOOK.md).

`/healthz` remains a static publication check with `stage: web-foundation` and `servicesConnected: false`. It does not test the webhook, database, phone service or either full demo. Only the webhook route accepts POST; other local public routes remain GET/HEAD only.

## Release evidence

Before reporting success, check Vercel's deployment status and source commit, then verify the production page and CSS without authentication. Compare the served content with the committed files. A second normal commit should create its own Git-triggered deployment; this distinguishes a repeatable pipeline from a one-off upload.

The public page labels both full demos as planned. The one backend route verifies signed alerts and logs a sanitized receipt; persistence, calls, coding and reminders are not connected. Existing MVP/demo deployments and secret settings are unchanged. After deployment, verify the exact commit, unchanged public assets, GET-to-webhook 405 and unsigned JSON POST 401. Real signed delivery is an owner-run follow-up; do not infer it from routing probes or offline tests.

Official references: [Vercel GitHub deployments](https://vercel.com/docs/git/vercel-for-github), [static project configuration](https://vercel.com/docs/project-configuration/vercel-json). Recheck the applicable docs when adding the first backend capability.
