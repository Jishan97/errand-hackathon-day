import { createRuntime } from '../src/phone/server.js';

// Export the HTTP server so Vercel retains its WebSocket upgrade handler.
export default createRuntime().server;
