import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const routesPath = path.resolve(here, '../src/api/routes.ts');

type Routes = typeof import('../src/api/routes.ts');
type Handler = (routes: Routes, body: Record<string, any>) => Promise<{ status: number; body: unknown }>;

/** Serves /api/* in dev with the same handlers (validation + error handling) as the Vercel functions in /api. */
function engineApi(): Plugin {
  return {
    name: 'sdr-engine-api',
    configureServer(server) {
      const sendJson = (res: ServerResponse, status: number, body: unknown) => {
        if (res.headersSent || res.writableEnded) return;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const mount = (url: string, method: 'GET' | 'POST', handler: Handler) =>
        server.middlewares.use(url, async (req, res) => {
          try {
            if (req.method !== method) return sendJson(res, 405, { error: `Use ${method}` });
            let body: Record<string, any> = {};
            if (method === 'POST') {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              try {
                body = JSON.parse(raw || '{}') ?? {};
              } catch {
                return sendJson(res, 400, { error: 'Invalid JSON body' });
              }
            }
            const routes = (await server.ssrLoadModule(routesPath)) as Routes;
            const r = await handler(routes, body);
            sendJson(res, r.status, r.body);
          } catch (e) {
            console.error(`[api ${url}]`, e);
            sendJson(res, 500, { error: 'Internal Server Error', details: (e as Error).message });
          }
        });
      mount('/api/status', 'GET', (r) => r.handleStatus());
      mount('/api/diagnose', 'POST', (r, b) => r.handleDiagnose(b));
      mount('/api/followup', 'POST', (r, b) => r.handleFollowup(b));
      mount('/api/feedback', 'POST', (r, b) => r.handleFeedback(b));
      mount('/api/teach', 'POST', (r, b) => r.handleTeach(b));
      mount('/api/monday-webhook', 'POST', (r, b) => r.handleMondayWebhook(b));
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss(), engineApi()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, fs: { allow: [path.resolve(here, '..')] } },
});
