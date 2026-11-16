/**
 * Transport-agnostic API handlers shared by the Vite dev server (web/vite.config.ts) and the Vercel
 * functions in /api. Each returns { status, body }; nothing here throws to the caller.
 */
import { diagnoseLead, InvalidInputError, type CopilotResult } from './diagnose.ts';
import { saveFeedback } from './feedback.ts';
import { answerLeadFollowup, formatCoachingRule, getLlmStatus } from '../ai/copilot.ts';
import { commitLearnedRule, GitHubConfigError } from '../integrations/github.ts';
import { createUpdate, extractContactId, getItem, MondayConfigError } from '../integrations/monday.ts';

export interface ApiResponse {
  status: number;
  body: unknown;
}

export class BadRequest extends Error {}
class ServiceUnavailable extends Error {}

type Body = Record<string, any>;

async function guard(label: string, fn: () => Promise<unknown>): Promise<ApiResponse> {
  try {
    return { status: 200, body: await fn() };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err instanceof BadRequest || err instanceof InvalidInputError) return { status: 400, body: { error: err.message } };
    if (err instanceof ServiceUnavailable || err instanceof GitHubConfigError || err instanceof MondayConfigError) {
      return { status: 503, body: { error: err.message } };
    }
    console.error(`[api ${label}]`, err);
    return { status: 500, body: { error: 'Internal Server Error', details: err.message } };
  }
}

/** Only a bare numeric ID or a HubSpot contact URL; conversational text is rejected. */
export function validContactInput(raw: string): boolean {
  return /^\d{3,}$/.test(raw) || /^https?:\/\/\S+\/(?:record\/0-1|contact|contacts)\/\d+/.test(raw);
}

export const handleStatus = () => guard('status', async () => ({ llm: getLlmStatus() }));

export const handleDiagnose = (body: Body) =>
  guard('diagnose', async () => {
    const raw = String(body.contactId ?? body.contactIdOrUrl ?? body.input ?? '').trim();
    if (!validContactInput(raw)) throw new BadRequest('Please provide a valid HubSpot Contact ID.');
    return diagnoseLead({ ...body, contactIdOrUrl: raw });
  });

export const handleFollowup = (body: Body) =>
  guard('followup', async () => {
    if (typeof body.question !== 'string' || !body.question.trim()) throw new BadRequest('question is required');
    if (!body.dossier || typeof body.dossier !== 'object') throw new BadRequest('dossier is required');
    const { answer, suggestedQuestions } = await answerLeadFollowup({
      dossier: body.dossier,
      diagnosis: body.diagnosis ?? { contactId: body.dossier.contactId ?? '', steps: [], conclusion: '' },
      question: body.question.trim(),
    });
    return { answer, suggestedQuestions };
  });

export const handleFeedback = (body: Body) =>
  guard('feedback', async () => {
    if (!body.contactId || (body.rating !== 'up' && body.rating !== 'down')) throw new BadRequest('contactId and rating (up|down) are required');
    saveFeedback(body as Parameters<typeof saveFeedback>[0]);
    return { ok: true };
  });

export const handleTeach = (body: Body) =>
  guard('teach', async () => {
    const contactId = String(body.contactId ?? '').trim();
    const expectedVerdict = String(body.expectedVerdict ?? '').trim();
    const ruleExplanation = String(body.ruleExplanation ?? '').trim();
    if (!/^\d{3,}$/.test(contactId)) throw new BadRequest('contactId is required');
    if (!expectedVerdict) throw new BadRequest('expectedVerdict is required');
    if (ruleExplanation.length < 10) throw new BadRequest('ruleExplanation must explain the rule (10+ characters)');
    if (ruleExplanation.length > 2000) throw new BadRequest('ruleExplanation is too long (max 2000 characters)');
    const currentVerdict = body.currentVerdict ? String(body.currentVerdict) : undefined;

    const { bullet, source } = await formatCoachingRule({ contactId, currentVerdict, expectedVerdict, ruleExplanation });
    try {
      const commit = await commitLearnedRule(bullet, `Teach agent: coaching rule from contact ${contactId}`);
      return { committed: true, rule: bullet, ruleSource: source, ...commit };
    } catch (e) {
      if (e instanceof GitHubConfigError) throw new ServiceUnavailable(`${e.message} Formatted rule (not saved): ${bullet}`);
      throw e;
    }
  });

// ---- Monday.com shadow pilot -----------------------------------------------------------------------

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML body for the Monday item update (no prospect email; Monday renders basic HTML). */
export function mondayUpdateBody(r: CopilotResult): string {
  const d = r.engine.diagnosis;
  const v = d.blockedAt ?? [...d.steps].reverse().find((s) => s.status === 'WARN');
  const verdict = d.blockedAt ? `BLOCKED at Step ${d.blockedAt.step} (${d.blockedAt.title})` : v ? `WARN at Step ${v.step} (${v.title})` : 'PASS: no blocking gate';
  const s = r.copilot.sdrView;
  const lines = [
    '<p><strong>🤖 SDR Copilot (shadow pilot)</strong>: diagnosis only, no action was taken.</p>',
    `<p><strong>Verdict:</strong> ${esc(verdict)} · confidence ${r.engine.confidence.score.toFixed(1)} (${esc(r.engine.confidence.band)})</p>`,
    `<p>${esc(s.summary)}</p>`,
    `<p><strong>Next step:</strong> ${esc(s.nextStep)}</p>`,
  ];
  if (r.copilot.adminView.propertyDiffs.length) lines.push(`<p><strong>CRM change:</strong> <code>${esc(r.copilot.adminView.propertyDiffs.join('; '))}</code></p>`);
  if (d.duplicates?.length) lines.push(`<p><strong>Exact-email duplicates:</strong> ${esc(d.duplicates.map((x) => x.id).join(', '))}</p>`);
  lines.push(`<p><a href="${r.links.hubspotContact}">Open contact ${esc(r.contactId)} in HubSpot</a></p>`);
  return lines.join('');
}

const recent = new Map<string, number>();
const DEDUPE_MS = 10 * 60_000;

export const handleMondayWebhook = (body: Body) =>
  guard('monday-webhook', async () => {
    if (body?.challenge) return { challenge: body.challenge };
    const event = body?.event ?? {};
    // Our own create_update would otherwise re-trigger update-subscribed webhooks.
    if (['create_update', 'edit_update', 'delete_update', 'create_reply'].includes(String(event.type ?? ''))) return { skipped: 'update event' };
    const itemId = event.pulseId ?? event.itemId;
    if (!itemId) return { skipped: 'no item id in event' };

    // Every failure past this point is reported in a 200 body so Monday does not retry endlessly.
    try {
      const item = await getItem(String(itemId));
      if (!item) return { skipped: `item ${itemId} not found` };
      const contactId = extractContactId(item);
      if (!contactId) return { skipped: 'no HubSpot contact ID or URL on the item', itemId: String(itemId) };

      const key = `${itemId}:${contactId}`;
      const now = Date.now();
      if (now - (recent.get(key) ?? 0) < DEDUPE_MS) return { skipped: 'already diagnosed recently', itemId: String(itemId), contactId };
      recent.set(key, now);

      const result = await diagnoseLead({ contactIdOrUrl: contactId });
      const updateId = await createUpdate(String(itemId), mondayUpdateBody(result));
      return { ok: true, itemId: String(itemId), contactId, updateId };
    } catch (e) {
      if (e instanceof MondayConfigError) throw e;
      console.error('[monday-webhook]', e);
      return { ok: false, error: (e as Error).message };
    }
  });
