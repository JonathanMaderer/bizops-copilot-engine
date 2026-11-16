/** Minimal adapter from Vercel's Node runtime (req/res) to the shared handlers in routes.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiResponse } from './routes.ts';

type Req = IncomingMessage & { body?: unknown };

async function readBody(req: Req): Promise<Record<string, unknown> | null> {
  // Vercel pre-parses JSON into req.body; fall back to reading the stream.
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') return req.body as Record<string, unknown>;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, r: ApiResponse) {
  res.statusCode = r.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(r.body));
}

export function vercelHandler(method: 'GET' | 'POST', handler: (body: Record<string, any>) => Promise<ApiResponse>) {
  return async (req: Req, res: ServerResponse) => {
    try {
      if (req.method !== method) return send(res, { status: 405, body: { error: `Use ${method}` } });
      const body = method === 'POST' ? await readBody(req) : {};
      if (body === null) return send(res, { status: 400, body: { error: 'Invalid JSON body' } });
      send(res, await handler(body));
    } catch (e) {
      send(res, { status: 500, body: { error: 'Internal Server Error', details: (e as Error).message } });
    }
  };
}
