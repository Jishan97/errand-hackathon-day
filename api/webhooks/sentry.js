import { handleSentryWebhook } from '../../src/integrations/sentry-webhook.js';

export default {
  fetch(request) {
    return handleSentryWebhook(request, {
      getConfig: () => ({
        webhookSecret: process.env.SENTRY_WEBHOOK_SECRET,
        projectId: process.env.SENTRY_PROJECT_ID,
      }),
      onVerified(receipt) {
        console.info(JSON.stringify({ event: 'sentry_alert_verified', ...receipt }));
      },
    });
  },
};
