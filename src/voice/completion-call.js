// Adapted from the preparation Twilio transport. Completion is a short spoken
// notification; it does not create a second interactive voice runtime.
const accountPattern = /^AC[0-9a-fA-F]{32}$/;
const callPattern = /^CA[0-9a-fA-F]{32}$/;
const phonePattern = /^\+[1-9][0-9]{7,14}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const maximumResponseBytes = 8192;
const acceptedStatuses = new Set(['queued', 'ringing', 'in-progress', 'completed']);
const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>' +
  'This is Errand, an AI assistant. The sample upload bug is fixed. ' +
  'The regression tests and GitHub checks passed, and I verified the upload on the live deployment. ' +
  'You can try sending the sample attachment again. Goodbye.' +
  '</Say><Hangup/></Response>';

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function completionCallIsConfigured(config) {
  const values = config?.values;
  return config?.liveVoiceEnabled === true &&
    accountPattern.test(values?.TWILIO_ACCOUNT_SID ?? '') &&
    typeof values?.TWILIO_AUTH_TOKEN === 'string' &&
    /^[0-9a-fA-F]{32}$/.test(values.TWILIO_AUTH_TOKEN) &&
    phonePattern.test(values?.TWILIO_FROM_NUMBER ?? '') &&
    phonePattern.test(values?.TEST_RESIDENT_NUMBER ?? '');
}

function verified(evidence) {
  return evidence?.testsPassed === true && evidence?.ciPassed === true &&
    evidence?.deploymentVerified === true && evidence?.replayVerified === true &&
    typeof evidence?.mergeCommit === 'string' && commitPattern.test(evidence.mergeCommit) &&
    evidence.deployedCommit === evidence.mergeCommit;
}

async function boundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumResponseBytes)) {
    await response.body?.cancel().catch(() => {});
    throw failure('callback_submission_unconfirmed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('callback_submission_unconfirmed');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) throw failure('callback_submission_unconfirmed');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw failure('callback_submission_unconfirmed');
  } finally {
    reader.releaseLock();
  }
}

function createCaller({ config, fetcher = fetch }, verifyEvidence, message) {
  return Object.freeze({
    async call(evidence) {
      if (!verifyEvidence(evidence)) throw failure('callback_evidence_required');
      if (!completionCallIsConfigured(config) || typeof fetcher !== 'function') {
        throw failure('callback_disabled_or_unconfigured');
      }
      const values = config.values;
      // The caller cannot choose a recipient, message, URL or credentials.
      const parameters = new URLSearchParams({
        From: values.TWILIO_FROM_NUMBER,
        To: values.TEST_RESIDENT_NUMBER,
        Twiml: message,
        Timeout: '20',
        TimeLimit: '45',
        Record: 'false',
      });
      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${values.TWILIO_ACCOUNT_SID}/Calls.json`;
      try {
        const response = await fetcher(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: `Basic ${Buffer.from(`${values.TWILIO_ACCOUNT_SID}:${values.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: parameters.toString(),
        });
        if (response.status !== 201) {
          await response.body?.cancel().catch(() => {});
          throw failure('callback_submission_unconfirmed');
        }
        const result = await boundedJson(response);
        if (!callPattern.test(result?.sid ?? '') || result.account_sid !== values.TWILIO_ACCOUNT_SID ||
          result.from !== values.TWILIO_FROM_NUMBER || result.to !== values.TEST_RESIDENT_NUMBER ||
          result.direction !== 'outbound-api' || !acceptedStatuses.has(result.status)) {
          throw failure('callback_submission_unconfirmed');
        }
        // No provider/call/contact identifiers escape into a receipt or log.
        // API acceptance alone does not prove that the recipient heard the call.
        return { status: 'submitted_not_verified' };
      } catch {
        // Do not retry here: a timeout or lost response may follow a real call.
        throw failure('callback_submission_unconfirmed');
      }
    },
  });
}

export function createCompletionCaller(options) { return createCaller(options, verified, twiml); }

export function createErrorAlertCaller(options) {
  const verify = evidence => evidence?.signedAlert === true && commitPattern.test(evidence?.baseSha ?? '') &&
    /^https:\/\/github\.com\/Jishan97\/errand-agent-demo\/pull\/[1-9]\d*$/.test(evidence?.pullRequest ?? '');
  const message = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>' +
    'This is Errand, an AI assistant. Sentry reported that the Common Ground sample attachment failed. ' +
    'I opened a draft pull request with the prepared line ending fix and regression tests. ' +
    'Please review it on GitHub. The fix has not been merged or deployed. Goodbye.' +
    '</Say><Hangup/></Response>';
  return createCaller(options, verify, message);
}
