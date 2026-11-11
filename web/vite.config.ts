import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const servicePath = path.resolve(here, '../src/api/diagnose.ts');
const feedbackPath = path.resolve(here, '../src/api/feedback.ts');

/** Serves POST /api/diagnose and /api/feedback by running the engine service layer inside the Vite dev server. */
function engineApi(): Plugin {
  return {
    name: 'sdr-engine-api',
    configureServer(server) {
      const route = (url: string, handler: (body: any) => Promise<unknown>) =>
        server.middlewares.use(url, async (req, res) => {
          const send = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(body));
          };
          if (req.method !== 'POST') return send(405, { error: 'Use POST' });
          try {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            send(200, await handler(JSON.parse(raw || '{}')));
          } catch (e) {
            const err = e as Error;
            send(err.constructor?.name === 'InvalidInputError' ? 400 : 500, { error: err.message });
          }
        });
      server.middlewares.use('/api/status', async (_req, res) => {
        const mod = (await server.ssrLoadModule(path.resolve(here, '../src/ai/copilot.ts'))) as typeof import('../src/ai/copilot.ts');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ llm: mod.getLlmStatus() }));
      });
      route('/api/diagnose', async (body) => {
        const mod = (await server.ssrLoadModule(servicePath)) as typeof import('../src/api/diagnose.ts');
        return mod.diagnoseLead({ ...body, contactIdOrUrl: String(body.contactIdOrUrl ?? body.input ?? '') });
      });
      route('/api/feedback', async (body) => {
        const mod = (await server.ssrLoadModule(feedbackPath)) as typeof import('../src/api/feedback.ts');
        mod.saveFeedback(body);
        return { ok: true };
      });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss(), engineApi()],
  server: { port: 5173, fs: { allow: [path.resolve(here, '..')] } },
});
