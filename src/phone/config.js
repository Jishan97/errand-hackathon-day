const configurationGroups = Object.freeze({
  voice: [
    "PUBLIC_BASE_URL",
    "OPERATOR_TOKEN",
    "STREAM_TOKEN_SECRET",
    "OPENAI_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "TEST_RESIDENT_NUMBER",
  ],
  worker: ["OPERATOR_TOKEN", "OPENAI_API_KEY", "OPENAI_AGENT_MODEL"],
});

const m1ConfigurationNames = Object.freeze([
  "SUPABASE_URL", "SUPABASE_SECRET_KEY",
]);

const configurationNames = [
  ...new Set(Object.values(configurationGroups).flat()),
  "OPENAI_VOICE_MODEL",
  "ENABLE_LIVE_VOICE",
  "ENABLE_M1_INTAKE",
  "ENABLE_SHARED_ASSISTANT", "GITHUB_DEMO_REPO", "GITHUB_DEMO_TOKEN", "GITHUB_DEMO_URL",
  "ENABLE_GITHUB_APP", "GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY_BASE64", "GITHUB_APP_SLUG", "GITHUB_APP_SESSION_SECRET",
  "ENABLE_INCIDENT_DEMO", "SENTRY_WEBHOOK_SECRET", "SENTRY_PROJECT_ID", "SENTRY_ORG_SLUG", "SENTRY_AUTH_TOKEN",
  ...m1ConfigurationNames,
];

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const phoneNames = new Set([...configurationGroups.voice, ...configurationGroups.worker,
  ...m1ConfigurationNames, "OPENAI_VOICE_MODEL", "ENABLE_LIVE_VOICE", "ENABLE_M1_INTAKE", "ENABLE_SHARED_ASSISTANT", "PORT"]);

export function loadConfig(environment = process.env) {
  environment = Object.fromEntries([...phoneNames].map((name) => [name, environment[name]]));
  const values = Object.fromEntries(
    configurationNames.map((name) => [name, environment[name]?.trim() ?? ""]),
  );
  const portValue = environment.PORT?.trim() || "3000";

  if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) {
    throw new ConfigurationError("PORT must be an integer between 1 and 65535.");
  }

  if (values.OPERATOR_TOKEN && !/^[A-Za-z0-9_-]{32,128}$/.test(values.OPERATOR_TOKEN)) {
    throw new ConfigurationError("OPERATOR_TOKEN must be 32–128 URL-safe characters.");
  }

  for (const name of ["ENABLE_LIVE_VOICE", "ENABLE_M1_INTAKE", "ENABLE_SHARED_ASSISTANT", "ENABLE_GITHUB_APP", "ENABLE_INCIDENT_DEMO"]) {
    if (values[name] && !["true", "false"].includes(values[name])) {
      throw new ConfigurationError(`${name} must be true or false.`);
    }
  }

  if (values.STREAM_TOKEN_SECRET && !/^[A-Za-z0-9_-]{32,128}$/.test(values.STREAM_TOKEN_SECRET)) {
    throw new ConfigurationError("STREAM_TOKEN_SECRET must be 32–128 URL-safe characters.");
  }

  if (values.STREAM_TOKEN_SECRET && values.STREAM_TOKEN_SECRET === values.OPERATOR_TOKEN) {
    throw new ConfigurationError("Use separate operator and stream credentials.");
  }

  if (values.TWILIO_ACCOUNT_SID && !/^AC[0-9a-f]{32}$/i.test(values.TWILIO_ACCOUNT_SID)) {
    throw new ConfigurationError("TWILIO_ACCOUNT_SID must be a Twilio account identifier.");
  }

  for (const name of ["TWILIO_FROM_NUMBER", "TEST_RESIDENT_NUMBER"]) {
    if (values[name] && !/^\+[1-9]\d{7,14}$/.test(values[name])) {
      throw new ConfigurationError(`${name} must use E.164 format.`);
    }
  }

  if (values.OPENAI_VOICE_MODEL && !/^gpt-live-[a-zA-Z0-9.-]+$/.test(values.OPENAI_VOICE_MODEL)) {
    throw new ConfigurationError("OPENAI_VOICE_MODEL must explicitly select a GPT-Live model.");
  }

  if (values.PUBLIC_BASE_URL) {
    let publicUrl;

    try {
      publicUrl = new URL(values.PUBLIC_BASE_URL);
    } catch {
      throw new ConfigurationError("PUBLIC_BASE_URL must be a canonical HTTPS origin.");
    }

    if (
      publicUrl.protocol !== "https:" ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.port ||
      publicUrl.pathname !== "/" ||
      publicUrl.search ||
      publicUrl.hash
    ) {
      throw new ConfigurationError("PUBLIC_BASE_URL must be a canonical HTTPS origin.");
    }

    values.PUBLIC_BASE_URL = publicUrl.origin;
  }

  if (values.SUPABASE_URL) {
    let url;
    try { url = new URL(values.SUPABASE_URL); }
    catch { throw new ConfigurationError("SUPABASE_URL must be a canonical Supabase HTTPS origin."); }
    if (
      url.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash
    ) throw new ConfigurationError("SUPABASE_URL must be a canonical Supabase HTTPS origin.");
    values.SUPABASE_URL = url.origin;
  }

  if (values.SUPABASE_SECRET_KEY && !/^sb_secret_[A-Za-z0-9_-]{20,200}$/.test(values.SUPABASE_SECRET_KEY)) {
    throw new ConfigurationError("SUPABASE_SECRET_KEY must be a new server-only secret key.");
  }

  if (values.GITHUB_DEMO_REPO && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.GITHUB_DEMO_REPO)) throw new ConfigurationError("GITHUB_DEMO_REPO must be owner/repository.");
  if (values.GITHUB_DEMO_TOKEN && (values.GITHUB_DEMO_TOKEN.length > 512 || /[\s\u0000-\u001f]/u.test(values.GITHUB_DEMO_TOKEN))) throw new ConfigurationError("GITHUB_DEMO_TOKEN must be a private scoped token.");
  if (values.GITHUB_DEMO_URL) {
    let url;
    try { url = new URL(values.GITHUB_DEMO_URL); } catch { throw new ConfigurationError("GITHUB_DEMO_URL must be a Vercel HTTPS origin."); }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app") || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new ConfigurationError("GITHUB_DEMO_URL must be a Vercel HTTPS origin.");
    values.GITHUB_DEMO_URL = url.origin;
  }

  if (values.GITHUB_APP_ID && !/^[1-9]\d{0,19}$/.test(values.GITHUB_APP_ID)) throw new ConfigurationError("GITHUB_APP_ID must be a decimal app ID.");
  if (values.GITHUB_APP_CLIENT_ID && !/^[A-Za-z0-9_.-]{8,128}$/.test(values.GITHUB_APP_CLIENT_ID)) throw new ConfigurationError("GITHUB_APP_CLIENT_ID must be an app client identifier.");
  if (values.GITHUB_APP_SLUG && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(values.GITHUB_APP_SLUG)) throw new ConfigurationError("GITHUB_APP_SLUG must be a GitHub App slug.");
  if (values.GITHUB_APP_CLIENT_SECRET && (values.GITHUB_APP_CLIENT_SECRET.length > 512 || /[\s\u0000-\u001f]/u.test(values.GITHUB_APP_CLIENT_SECRET))) throw new ConfigurationError("GITHUB_APP_CLIENT_SECRET must be a private app credential.");
  if (values.GITHUB_APP_PRIVATE_KEY_BASE64 && (values.GITHUB_APP_PRIVATE_KEY_BASE64.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(values.GITHUB_APP_PRIVATE_KEY_BASE64))) throw new ConfigurationError("GITHUB_APP_PRIVATE_KEY_BASE64 must contain a privately encoded PEM key.");
  if (values.GITHUB_APP_SESSION_SECRET && !/^[A-Za-z0-9_-]{32,128}$/.test(values.GITHUB_APP_SESSION_SECRET)) throw new ConfigurationError("GITHUB_APP_SESSION_SECRET must be 32–128 URL-safe characters.");
  if (values.GITHUB_APP_SESSION_SECRET && [values.OPERATOR_TOKEN, values.STREAM_TOKEN_SECRET].includes(values.GITHUB_APP_SESSION_SECRET)) throw new ConfigurationError("Use a separate GitHub web session secret.");
  if (values.SENTRY_PROJECT_ID && !/^[1-9]\d{0,24}$/.test(values.SENTRY_PROJECT_ID)) throw new ConfigurationError("SENTRY_PROJECT_ID must be a decimal demo project ID.");
  if (values.SENTRY_ORG_SLUG && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(values.SENTRY_ORG_SLUG)) throw new ConfigurationError("SENTRY_ORG_SLUG must identify the dedicated Sentry demo organization.");
  if (values.SENTRY_WEBHOOK_SECRET && (values.SENTRY_WEBHOOK_SECRET.length < 32 || values.SENTRY_WEBHOOK_SECRET.length > 256 || /\s/.test(values.SENTRY_WEBHOOK_SECRET))) throw new ConfigurationError("SENTRY_WEBHOOK_SECRET must contain the private integration Client Secret.");
  if (values.SENTRY_AUTH_TOKEN && (values.SENTRY_AUTH_TOKEN.length > 512 || /\s/.test(values.SENTRY_AUTH_TOKEN))) throw new ConfigurationError("SENTRY_AUTH_TOKEN must be a private issue-write credential.");

  return Object.freeze({
    port: Number(portValue),
    operatorToken: values.OPERATOR_TOKEN,
    voiceEnabled: values.ENABLE_LIVE_VOICE === "true",
    m1Enabled: values.ENABLE_M1_INTAKE === "true",
    // Enable explicitly after the additive shared-worker migration is ready.
    sharedAssistantEnabled: values.ENABLE_M1_INTAKE === "true" && values.ENABLE_SHARED_ASSISTANT === "true",
    githubAppEnabled: values.ENABLE_GITHUB_APP === "true",
    incidentDemoEnabled: values.ENABLE_INCIDENT_DEMO === "true",
    voiceModel: values.OPENAI_VOICE_MODEL || "gpt-live-1",
    agentModel: values.OPENAI_AGENT_MODEL || null,
    values: Object.freeze(values),
  });
}

function baseVoiceIsAvailable(config) {
  return config.voiceEnabled && configurationGroups.voice.every((name) => Boolean(config.values[name]));
}

function m1SettingsPresent(config) {
  return m1ConfigurationNames.every((name) => Boolean(config.values[name]));
}

export function voiceIsAvailable(config) {
  return baseVoiceIsAvailable(config) && (!config.m1Enabled || m1SettingsPresent(config));
}

export function m1IsAvailable(config) {
  return config.m1Enabled && baseVoiceIsAvailable(config) && m1SettingsPresent(config);
}

export function getReadiness(config) {
  const integrations = Object.fromEntries(
    Object.entries(configurationGroups).map(([name, requiredNames]) => {
      const missing = requiredNames.filter((requiredName) => !config.values[requiredName]);

      return [name, {
        implementation: name === "voice" ? "implemented_live_unverified" : config.sharedAssistantEnabled ? "shared_prototype_implemented_live_unverified" : "pending",
        configuration: missing.length ? "incomplete" : "present_not_verified",
        missing,
      }];
    }),
  );

  if (config.m1Enabled) {
    const missing = [...configurationGroups.voice, ...m1ConfigurationNames].filter((name) => !config.values[name]);
    integrations.m1 = {
      implementation: "in_progress",
      configuration: missing.length ? "incomplete" : "present_not_verified",
      missing,
    };
  }

  return {
    service: "errand-mvp",
    milestone: config.m1Enabled ? "M1" : "M0",
    status: config.m1Enabled ? (m1IsAvailable(config) ? "m1_configured_not_verified" : "m1_locked") : "local_voice_bridge_only",
    checks: {
      http: "available",
      operator_access: config.operatorToken ? "configured" : "locked",
      websocket_probe: config.operatorToken ? "available" : "locked",
      voice_admission: voiceIsAvailable(config) ? (config.m1Enabled ? "allowed_test_number" : "test_numbers_only") : "locked",
      ...(config.m1Enabled ? { m1_intake: m1IsAvailable(config) ? "configured_not_verified" : "locked" } : {}),
    },
    integrations,
    external_actions: { calls: voiceIsAvailable(config), emails: false, task_writes: m1IsAvailable(config) },
    safety: { resident_authenticated: false, replay_guard: "per_instance_only", max_call_seconds: 240 },
    live_acceptance: {
      deployed_websocket: "pending",
      inbound_conversation: "pending",
      outbound_conversation: "pending",
      agents_function_round_trip: "pending",
    },
  };
}
