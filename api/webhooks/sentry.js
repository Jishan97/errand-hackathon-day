import { handleSentryWebhook } from '../../src/integrations/sentry-webhook.js';
import { waitUntil } from '@vercel/functions';
import { createIncidentRuntime, runtimeValues, scheduleIncident } from '../../src/core/runtime.js';

export default {
  fetch(request) {
    return handleSentryWebhook(request, {
      getConfig: () => ({
        webhookSecret: process.env.SENTRY_WEBHOOK_SECRET,
        projectId: process.env.SENTRY_PROJECT_ID,
      }),
      async onVerified(receipt, event, capture) {
        console.info(JSON.stringify({ event: 'sentry_alert_verified', ...receipt }));
        if (process.env.ENABLE_FAST_INCIDENT_DEMO !== 'true') return;
        const runtime = createIncidentRuntime(runtimeValues(process.env));
        const alert = await runtime.alertDemo.accept(event, capture);
        if (['queued', 'duplicate'].includes(alert.status)) {
          if (alert.status === 'queued') waitUntil(runtime.alertDemo.run(alert.jobReceiptId).catch(() => {
            console.info(JSON.stringify({ event: 'alert_demo_requires_review' }));
          }));
          return alert;
        }
        const accepted = await runtime.store.accept(event);
        if (['queued', 'duplicate'].includes(accepted.status)) scheduleIncident(runtime, event.eventId, waitUntil);
        return accepted;
      },
    });
  },
};
