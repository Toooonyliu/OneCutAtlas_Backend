import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAvatarRoute, sendJson } from './server/http.js';

export function createBackendServer(options = {}) {
  const route = createAvatarRoute({ serviceInfoRoot: true, ...options });
  const server = http.createServer(async (req, res) => {
    try {
      if (await route(req, res, new URL(req.url, 'http://localhost'))) return;
      sendJson(res, 404, { error: 'Not found.' });
    } catch { sendJson(res, 500, { error: 'Request unavailable.' }); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 4174);
  const host = process.env.HOST || '0.0.0.0';
  createBackendServer().listen(port, host, () => console.log(`One Cut Atlas API listening on ${host}:${port}`));
}
