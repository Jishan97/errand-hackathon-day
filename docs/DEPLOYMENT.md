# Deployment and verification

Source is the public [errand-hackathon-day](https://github.com/Jishan97/errand-hackathon-day) repository, production branch main. Vercel publishes [errand-hackathon-day.vercel.app](https://errand-hackathon-day.vercel.app) through its existing Git connection. Generated/scoped aliases may require authentication; use the short public URL.

The Gmail connections/operator pages and API functions coexist with the incident routes in this branch. Follow [operator activation](GMAIL_OPERATOR.md): apply `db/gmail.sql`, reuse main's operator/Supabase/base-URL settings and explicitly enable `ENABLE_GMAIL_DEMO`. Its default is disabled. Gmail activation is independent of `ENABLE_FAST_INCIDENT_DEMO`; no Sentry production handler or table is changed.

The repository root is this standalone repository, not a nested hackathon-day path. The Other preset installs the pinned lockfile with npm ci --ignore-scripts, runs syntax checks and both offline JavaScript test directories, and publishes public/ plus incident and Gmail API entry points. Node.js is 24.x. Functions have a 300-second limit; the incident driver stops starting new steps after 220 seconds and persists work for explicit resume. Gmail durably queues approval before `waitUntil`, then reconciles interrupted claimed work after a five-minute lease. There is no new scheduler.

The [controlled repair guide](FAST_INCIDENT.md) describes private activation, exact-revision approval, schema deployment and live acceptance. The owner manages Vercel settings; agents do not pull environment files or inspect values. Native Git delivery needs no extra deployment token.

## Local checks

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run dev
```

Local preview serves allowlisted pages and adapts the same webhook/operator routes, with provider access disabled. Tests inject fictional values. The PostgreSQL harnesses `db/test-fast-incident.mjs` and `db/test-gmail.mjs` run against an isolated PGlite installation with no project credentials.

## Release acceptance

Verify the READY deployment's commit, public home and /incident.html, webhook GET405/unsignedPOST401, and operator unauthenticated401. Never include real operator tokens or signatures in agent-run probes. The owner performs the authenticated rehearsal and reports only redacted outcomes. Static /healthz is publication evidence only and deliberately says servicesConnected:false.

Before claiming end-to-end success, observe a real signed event, actual hosted before/after proof, expected CI, exact deployed commit and sample success, then a heard callback. A mocked call submission or queued job does not establish this.
