import { waitUntil } from '@vercel/functions';
import { handleGmailDemo } from '../../src/core/gmail-http.js';
import { gmailRuntimeValues } from '../../src/core/gmail-runtime.js';

export default { fetch: request => handleGmailDemo(request, {
  getValues: () => gmailRuntimeValues(process.env), schedule: promise => waitUntil(promise),
}) };
