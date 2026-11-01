# Minimal web deployment

The immediate goal is a working public page and a repeatable Git-to-Vercel pipeline. Bring MVP capabilities across one at a time after this foundation works. Keep existing demos and their connections in MVP.

## Source and target

- Source: [errand-hackathon-day](https://github.com/Jishan97/errand-hackathon-day), production branch `main`.
- Vercel project: `errand-hackathon-day`, in the owner's existing Vercel account.
- Public production URL: [errand-hackathon-day.vercel.app](https://errand-hackathon-day.vercel.app). Use this for sharing; generated deployment/scoped aliases can require Vercel sign-in.
- Repository root: the root of this standalone repository. Do not configure a `hackathon-day/` root directory inside it.
- Production files: only `public/`. MVP and preparation records are outside this repository and output.

## Build settings

Tracked [vercel.json](../vercel.json) selects the Other framework preset, skips installation because there are no dependencies, runs `npm run check`, and publishes `public/`. Node is pinned to 24.x for the build check. There is no bundler or application framework to provision.

The native Vercel GitHub integration handles deployments from pushes to `main`. No GitHub Actions deployment token, private dotenv loading or environment pull is required. Use small reviewed commits; normal `git push origin main` updates the production site once the project connection is active. Do not force-push over the collaborator's changes.

## Local preview

Run `npm run check`, then `npm run dev`. Open `http://127.0.0.1:3000/`. The Node server serves an explicit allowlist of the same HTML, CSS and health JSON used in production; it reads no private configuration and makes no provider requests.

`/healthz` maps to static `health.json` on Vercel. It reports `stage: web-foundation` and `servicesConnected: false`. It proves publication/routing of that file, not application startup, database access, phone service or either full demo. Local non-GET/HEAD requests and unknown paths are rejected; production uses Vercel's static-file routing.

## Release evidence

Before reporting success, check Vercel's deployment status and source commit, then verify the production page and CSS without authentication. Compare the served content with the committed files. A second normal commit should create its own Git-triggered deployment; this distinguishes a repeatable pipeline from a one-off upload.

The public page labels both demos as planned. No calls, task writes, coding sessions, reminders or backend services are enabled here. Existing MVP/demo deployments and secret settings are unchanged.

Official references: [Vercel GitHub deployments](https://vercel.com/docs/git/vercel-for-github), [static project configuration](https://vercel.com/docs/project-configuration/vercel-json). Recheck the applicable docs when adding the first backend capability.
