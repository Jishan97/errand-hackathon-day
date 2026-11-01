import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { authorizeOperator } from "./auth.js";
import { loadConfig, m1IsAvailable, voiceIsAvailable } from "./config.js";
import { createVoiceBridge } from "./voice/bridge.js";
import { validateStreamSignature } from "./voice/security.js";
import { createM1VoiceController } from "./voice/m1-controller.js";
import { createServerRpcClient } from "./storage/context-repository.js";
import { createIdentityRepository } from "./storage/identity-repository.js";
import { createAssistantRepository } from "./storage/assistant-repository.js";
import { createAssistantService } from "./assistant/service.js";
import { createAssistantWorker } from "./assistant/worker.js";
import { waitUntil } from '@vercel/functions';
import { createImageStore, createPhoneImages } from '../images/phone.js';

function rejectUpgrade(socket, status, code) {
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 503: "Service Unavailable" }[status];
  const body = JSON.stringify({ error: { code } });
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Cache-Control: no-store",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

export function createRuntime({ config = loadConfig(), logger = (entry) => console.info(JSON.stringify(entry)), voiceOptions = {}, m1Options = {} } = {}) {
  let m1 = null;
  let assistant = null;
  let assistantWorker = null;
  if (m1IsAvailable(config)) {
    if (m1Options.controller) m1 = m1Options.controller;
    else if (config.sharedAssistantEnabled && config.agentModel === "gpt-6.1-sol") {
      const rpc = m1Options.rpc ?? createServerRpcClient({ supabaseUrl: config.values.SUPABASE_URL, secretKey: config.values.SUPABASE_SECRET_KEY });
      const repository = m1Options.repository ?? createIdentityRepository({ rpc });
      const assistantRepository = m1Options.assistantRepository ?? createAssistantRepository({ rpc, callbacksOnly: true });
      const images = config.values.ENABLE_PHONE_IMAGES === 'true' ? createPhoneImages({
        store: m1Options.imageStore ?? createImageStore({ url: config.values.SUPABASE_URL, secret: config.values.SUPABASE_SECRET_KEY }),
        apiKey: config.values.OPENAI_API_KEY, model: config.values.OPENAI_IMAGE_MODEL || undefined,
        schedule: m1Options.imageSchedule ?? waitUntil, generate: m1Options.imageGenerate,
      }) : null;
      assistant = createAssistantService({ config, repository: assistantRepository, images, planner: m1Options.planner, assessor: m1Options.actionAssessor });
      assistantWorker = createAssistantWorker({ config, repository: assistantRepository, logger, placeCall: m1Options.placeCall });
      m1 = createM1VoiceController({ config, repository, assistant });
    }
  }
  const app = createApp({ config, logger, m1, assistant, assistantWorker });
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const mediaSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const voice = createVoiceBridge({ ...voiceOptions, config, logger, m1 });
  let closing;

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});

    if (closing) return rejectUpgrade(socket, 503, "server_closing");
    if (request.url === "/api/media") {
      if (!voiceIsAvailable(config)) return rejectUpgrade(socket, 503, "voice_disabled_or_unconfigured");
      if (!validateStreamSignature(request.headers["x-twilio-signature"], config)) return rejectUpgrade(socket, 403, "invalid_twilio_signature");
      if (!voice.capacityAvailable()) return rejectUpgrade(socket, 503, "voice_capacity_reached");
      mediaSockets.handleUpgrade(request, socket, head, (connection) => voice.attach(connection));
      return;
    }
    if (request.url !== "/api/internal/ws-probe") return rejectUpgrade(socket, 404, "not_found");

    const authorization = authorizeOperator(request.headers.authorization, config.operatorToken);
    if (authorization === "unconfigured") return rejectUpgrade(socket, 503, "operator_not_configured");
    if (authorization !== "authorized") return rejectUpgrade(socket, 401, "unauthorized");

    sockets.handleUpgrade(request, socket, head, (connection) => {
      sockets.emit("connection", connection);
    });
  });

  sockets.on("connection", (connection) => {
    const timeout = setTimeout(() => connection.terminate(), 3000);
    timeout.unref();
    connection.on("close", () => clearTimeout(timeout));
    connection.on("error", () => {});
    connection.once("message", (message, isBinary) => {
      let payload;

      try {
        payload = JSON.parse(message.toString());
      } catch {
        connection.close(1008, "Expected a ping message");
        return;
      }

      if (isBinary || !payload || payload.type !== "ping" || Object.keys(payload).length !== 1) {
        connection.close(1008, "Expected a ping message");
        return;
      }

      connection.send(JSON.stringify({ type: "pong", mode: "diagnostic_only", provider_connections: 0 }));
      connection.close(1000, "Diagnostic complete");
    });
  });

  return {
    app,
    server,
    close() {
      closing ??= (async () => {
        for (const connection of sockets.clients) connection.terminate();
        await voice.close();
        for (const connection of mediaSockets.clients) connection.terminate();
        await new Promise((resolve) => mediaSockets.close(resolve));
        await new Promise((resolve, reject) => sockets.close(() => {
          server.close((error) => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") return reject(error);
            resolve();
          });
          server.closeAllConnections();
        }));
      })();
      return closing;
    },
  };
}
