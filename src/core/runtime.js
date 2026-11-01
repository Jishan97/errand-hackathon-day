import { createFastStore, createFastRpc } from '../storage/fast-store.js';
import { createIncidentRunner } from '../agents/incident-runner.js';
import { createIncidentGithub } from '../assistant/incident-github.js';
import { githubAppIsConfigured } from '../github/app-client.js';
import { createCompletionCaller, completionCallIsConfigured } from '../voice/completion-call.js';
import { createFastWorker } from './fast-worker.js';

// Only deployed entry points call this after signature/operator checks. Tests
// pass synthetic values; no private file is loaded anywhere in this app.
export function createIncidentRuntime(values) {
  if (values.ENABLE_FAST_INCIDENT_DEMO !== 'true') throw Error('incident_disabled');
  const config = { values, incidentDemoEnabled: true, githubAppEnabled: values.ENABLE_GITHUB_APP === 'true',
    liveVoiceEnabled: values.ENABLE_LIVE_VOICE === 'true' };
  if (!config.githubAppEnabled) throw Error('incident_github_disabled');
  if (!githubAppIsConfigured(config)) throw Error('incident_github_unconfigured');
  if (!config.liveVoiceEnabled) throw Error('incident_callback_disabled');
  if (!completionCallIsConfigured(config)) throw Error('incident_callback_unconfigured');
  if (values.OPENAI_AGENT_MODEL !== 'gpt-6.1-sol') throw Error('incident_model_unconfigured');
  if (!values.OPENAI_API_KEY) throw Error('incident_openai_unconfigured');
  const store = createFastStore({ rpc: createFastRpc({ url: values.SUPABASE_URL, secret: values.SUPABASE_SECRET_KEY }) });
  const github = createIncidentGithub({ config });
  const runner = createIncidentRunner({ config });
  const caller = createCompletionCaller({ config });
  const worker = createFastWorker({ store, github, runner, caller,
    logger: (entry) => console.info(JSON.stringify(entry)) });
  return { store, github, worker };
}

export function runtimeValues(env) {
  const names = ['ENABLE_FAST_INCIDENT_DEMO', 'ENABLE_GITHUB_APP', 'ENABLE_LIVE_VOICE', 'PUBLIC_BASE_URL',
    'OPENAI_API_KEY', 'OPENAI_AGENT_MODEL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'GITHUB_DEMO_REPO', 'GITHUB_DEMO_URL',
    'GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_SLUG',
    'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_SESSION_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER', 'TEST_RESIDENT_NUMBER'];
  return Object.fromEntries(names.map((name) => [name, env[name]]));
}

export function scheduleIncident(runtime, receiptId, schedule) {
  schedule(runtime.worker.run(receiptId).catch(() => {
    // The durable lease/state remains available for an operator status/resume.
    console.info(JSON.stringify({ event: 'incident_resume_required', receiptId }));
  }));
}
