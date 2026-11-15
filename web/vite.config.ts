import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const servicePath = path.resolve(here, '../src/api/diagnose.ts');
const feedbackPath = path.resolve(here, '../src/api/feedback.ts');

class BadRequest extends Error {}

/** Serves POST /api/diagnose and /api/feedback by running the engine service layer inside the Vite dev server. */
function engineApi(): Plugin {
  return {
    name: 'sdr-engine-api',
    configureServer(server) {
      const sendJson = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
        if (res.headersSent || res.writableEnded) return;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      /** Reads the JSON body and runs the handler; any failure becomes a JSON response, never a server crash. */
      const route = (url: string, handler: (body: any) => Promise<unknown>) =>
        server.middlewares.use(url, async (req, res) => {
          try {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
            let raw = '';
            for await (const chunk of req) raw += chunk;
            let body: any;
            try {
              body = JSON.parse(raw || '{}');
            } catch {
              return sendJson(res, 400, { error: 'Invalid JSON body' });
            }
            sendJson(res, 200, await handler(body ?? {}));
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            console.error(`[api ${url}]`, err);
            if (err instanceof BadRequest || err.constructor?.name === 'InvalidInputError') return sendJson(res, 400, { error: err.message });
            sendJson(res, 500, { error: 'Internal Server Error', details: err.message });
          }
        });
      server.middlewares.use('/api/status', async (_req, res) => {
        try {
          const mod = (await server.ssrLoadModule(path.resolve(here, '../src/ai/copilot.ts'))) as typeof import('../src/ai/copilot.ts');
          sendJson(res, 200, { llm: mod.getLlmStatus() });
        } catch (e) {
          sendJson(res, 500, { error: 'Internal Server Error', details: (e as Error).message });
        }
      });
      route('/api/diagnose', async (body) => {
        // Only a bare numeric ID or a HubSpot contact URL is accepted; conversational text is rejected cleanly.
        const raw = String(body.contactId ?? body.contactIdOrUrl ?? body.input ?? '').trim();
        const valid = /^\d{3,}$/.test(raw) || /^https?:\/\/\S+\/(?:record\/0-1|contact|contacts)\/\d+/.test(raw);
        if (!valid) {
          throw new BadRequest('Please provide a valid HubSpot Contact ID.');
        }
        const mod = (await server.ssrLoadModule(servicePath)) as typeof import('../src/api/diagnose.ts');
        return mod.diagnoseLead({ ...body, contactIdOrUrl: raw });
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
