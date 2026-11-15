import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import type { Diagnosis } from '../engine/investigator.ts';
import type { Confidence } from '../engine/confidence.ts';
import type { DuplicateContact } from '../engine/hubspot.ts';

dotenv.config({ path: '.env.local', quiet: true });

/** Structured evidence for one lead (built by scripts/investigate.ts). */
export interface LeadDossier {
  contactId: string;
  notFound?: boolean;
  identity?: {
    name: string | null;
    email: string | null;
    sdrOwner: string | null;
    team: string | null;
    companySizeRange: string | null;
    leadSource: string | null;
  };
  deals?: { id: string; name: string | null; pipeline: string | null; stageId: string | null; closed: boolean }[];
  brain?: {
    cycleStart: string | null;
    cycleEnd: string | null;
    cycleOutcome: string | null;
    aiFirstRepliedAt: string | null;
    classification: string | null;
    subClassification: string | null;
    slStage: string | null;
    meetingType: string | null;
  };
  queue?: { summary: string; hits: { listId: string; labels: string[] }[]; allListIds: string[] };
  /** Other contacts sharing this contact's exact email. */
  duplicates?: DuplicateContact[];
}

export interface EngineResult {
  diagnosis: Diagnosis;
  confidence: Confidence;
}

/** Context supplied by the rep (claims, not CRM facts) plus deterministic cross-checks. */
export interface RepContext {
  reportedIssue?: string;
  customIssueText?: string;
  targetQueue?: string;
  /** Question -> answer pairs the rep confirmed (human-readable). */
  confirmedAnswers?: { question: string; answer: string }[];
  /** Deterministic resolution statements derived from the rep's answers. */
  resolution?: string[];
  reportedIssueAssessment?: string;
}

export interface CopilotResponse {
  sdrView: {
    summary: string;
    reason: string;
    nextStep: string;
    slackMessage: string | null;
  };
  adminView: {
    rootCauseCategory: string;
    step: string;
    propertyDiffs: string[];
    remediation: string;
  };
  source: 'llm' | 'fallback';
  model?: string;
  note?: string;
}

/** Base role prompt. The routing/taxonomy/resolver rules come from docs/BIZOPS_PLAYBOOK.md (see getSystemPrompt). */
export const SYSTEM_PROMPT =
  'You are an expert SDR Team Lead and RevOps Specialist. Your task is to interpret a deterministic CRM diagnostic payload for a lead that an SDR cannot find on their dashboard. You must NEVER hallucinate or assume facts not present in the payload. Rely ONLY on the provided dossier.';

/** Used only when docs/BIZOPS_PLAYBOOK.md is missing or unreadable. */
const FALLBACK_RULES = `Core rules (playbook file unavailable):
- Diagnostic order, first BLOCKED step is the root cause: 0 Contact Existence, 1 Deal Lock (active associated deal), 1.5 Owner Gate (sdr_owner empty = Incoming), 2 Brain State (active lead = ai_sdr_cycle_start_time known AND ai_sdr_cycle_end_time empty), 3 AI Handover (ai_sdr__first_replied_at set or sub-classification unqualified), 4 Filter Hygiene (numofemployeesrange 1-10 excluded unless lead source False SBP), 5 Meeting Validation (approved SDR meeting types only), 6 List vs UI Diff (if the contact is in the board list, it is a dashboard cache delay).
- Use only payload facts; rep statements are claims, not CRM data. Flag exact-email duplicates listed in dossier.duplicates.
- Never include the prospect's email address in any output.`;

const PLAYBOOK_PATHS = [new URL('../../docs/BIZOPS_PLAYBOOK.md', import.meta.url), path.resolve(process.cwd(), 'docs/BIZOPS_PLAYBOOK.md')];
const PLAYBOOK_MAX_CHARS = 60_000;
const COACHING_HEADING = '## Live Coaching Rules';

/** Reads the playbook fresh on each call so appended coaching rules apply without a restart. Null if missing/empty. */
export function loadPlaybook(): string | null {
  for (const p of PLAYBOOK_PATHS) {
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (!text) continue;
      if (text.length <= PLAYBOOK_MAX_CHARS) return text;
      // Over budget: trim the body but always keep the coaching section (it overrides everything above).
      const i = text.indexOf(COACHING_HEADING);
      const coaching = i >= 0 ? text.slice(i) : '';
      const body = (i >= 0 ? text.slice(0, i) : text).slice(0, Math.max(0, PLAYBOOK_MAX_CHARS - coaching.length));
      return `${body}\n\n${coaching}`.trim();
    } catch {
      /* try next location */
    }
  }
  return null;
}

export function getSystemPrompt(): string {
  const playbook = loadPlaybook();
  if (!playbook) console.warn('docs/BIZOPS_PLAYBOOK.md not found; using built-in fallback rules.');
  return `${SYSTEM_PROMPT}\n\n# BIZOPS PLAYBOOK\n${playbook ?? FALLBACK_RULES}`;
}

// ---- Slack escalation to BizOps ----------------------------------------------------------------

const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID ?? '4021060';
const hubspotLink = (id: string) => `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${id}`;

export function slackTags(): string {
  return `${process.env.SLACK_TAG_JONATHAN || '@Jonathan'} ${process.env.SLACK_TAG_DEAN || '@Dean'}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Removes email addresses from a draft, then makes sure it opens with the BizOps tags. */
function sanitizeSlack(msg: string): string {
  const clean = msg.replace(EMAIL_RE, '[email removed]').trim();
  const tags = slackTags();
  const lower = clean.toLowerCase();
  return tags.split(' ').every((t) => lower.includes(t.toLowerCase())) ? clean : `${tags} ${clean}`;
}

function duplicateLine(dossier: LeadDossier): string | null {
  const dups = dossier.duplicates ?? [];
  if (!dups.length) return null;
  return `Exact-email duplicates: ${dups.map((x) => `${x.id} (owner: ${x.ownerName ?? x.ownerId ?? 'none'}, lifecycle: ${x.lifecycleStage ?? 'n/a'})`).join('; ')}`;
}

/** Deterministic BizOps escalation (also the fallback when the LLM draft is missing). Null when nothing is blocking. */
export function buildEscalation(dossier: LeadDossier, r: EngineResult): string | null {
  const d = r.diagnosis;
  if (!d.blockedAt && !d.steps.some((s) => s.status !== 'PASS')) return null;
  const { step, title } = rootStepLabel(d);
  const diffs = propertyDiffs(d);
  const change = diffs.length ? diffs.join('; ') : (d.blockedAt?.remediation ?? d.steps.find((s) => s.remediation)?.remediation ?? 'see engine remediation');
  const lines = [
    `${slackTags()} Contact ${dossier.contactId}: ${hubspotLink(dossier.contactId)}`,
    `Root cause: Step ${step}${title ? ` ${title}` : ''}: ${d.conclusion}`,
    `CRM change needed: ${change}`,
  ];
  const dup = duplicateLine(dossier);
  if (dup) lines.push(dup);
  return lines.join('\n');
}

const FORMAT_INSTRUCTIONS = `Respond with ONLY a JSON object (no markdown fences) with this exact shape:
{
  "sdrView": {
    "summary": "2-3 sentences, empathetic, clear and direct",
    "reason": "plain-English reason the lead is not visible, e.g. 'AE Deal Lock', 'Unassigned in Incoming', 'Cadence expired'",
    "nextStep": "one concrete action for the SDR",
    "slackMessage": "concise internal Slack escalation to BizOps (see Slack rules below), or null if the engine found no blocker"
  },
  "adminView": {
    "rootCauseCategory": "root cause category",
    "step": "engine step number and title",
    "propertyDiffs": ["use the provided propertyDiffs verbatim; do not invent others"],
    "remediation": "direct remediation action"
  }
}
Rules: repContext holds statements made by the rep (not CRM data): you may use them for tone and to explain the resolution, but never present them as CRM properties. Use only facts in the payload (names, IDs, dates, stages). If a fact is missing, say it is not available. Do not invent people, owners or dates.
If dossier.duplicates is non-empty, state in the summary that other contacts share this exact email (list their IDs and owners) and that the rep may be looking at the wrong record; this never replaces the engine's root cause.
Slack rules: a single internal ping, no greetings or filler, in this order: start with the tags in payload.slackTags; the HubSpot Contact ID and payload.hubspotLink; the verified root cause (engine step and title); the exact CRM property change needed, formatted "property: current -> target" using propertyDiffs. If duplicates exist, add one line with their IDs, owners and lifecycle stages. NEVER include the prospect's email address or phone number.`;

// ---- deterministic building blocks ----------------------------------------------------------

const CATEGORY_BY_STEP: Record<string, string> = {
  '0': 'Contact Not Found',
  '1': 'AE Deal Lock',
  '1.5': 'Unassigned Owner (Incoming queue)',
  '2': 'Brain Cycle Ended (cadence expired / closed)',
  '3': 'AI Handover / Unqualified / Protected Status',
  '4': 'Filter Hygiene / Company Size',
  '5': 'Meeting Type Not Approved',
  '6': 'Routing / Team / List Membership',
};

function fmt(v: unknown): string {
  return v === null || v === undefined || v === '' ? 'null' : String(v);
}

/** Exact property diffs derived from the engine steps (never LLM-generated). */
export function propertyDiffs(d: Diagnosis): string[] {
  const s = d.blockedAt ?? [...d.steps].reverse().find((x) => x.status !== 'PASS');
  if (!s || !s.propertyKey) return [];
  const short = (v: unknown) => {
    const t = fmt(v);
    return /^\d{4}-\d{2}-\d{2}T/.test(t) ? t.slice(0, 10) : t;
  };
  let expected = s.expectedValue ?? 'expected value';
  if (s.step === 1.5) expected = 'Needs assignment';
  if (s.step === 2 && s.propertyKey.includes('cycle_end')) expected = 'Inactive';
  return [`${s.propertyKey}: ${short(s.currentValue)} -> ${expected}`];
}

function rootStepLabel(d: Diagnosis): { step: string; category: string; title: string } {
  const s = d.blockedAt ?? [...d.steps].reverse().find((x) => x.status !== 'PASS') ?? d.steps.at(-1);
  if (!s) return { step: '-', category: 'Unknown', title: '' };
  const step = String(s.step);
  const category = d.blockedAt || s.status !== 'PASS' ? (CATEGORY_BY_STEP[step] ?? s.title) : 'No blocker (dashboard sync/cache delay)';
  return { step, category, title: s.title };
}

/** Grounded fallback: templated from the dossier only, used when no LLM key is configured or the call fails. */
function fallbackAnalysis(dossier: LeadDossier, r: EngineResult, note: string): CopilotResponse {
  const d = r.diagnosis;
  const { step, category, title } = rootStepLabel(d);
  const diffs = propertyDiffs(d);
  const blocker = d.blockedAt;
  const who = dossier.identity?.name ? `${dossier.identity.name}` : `contact ${dossier.contactId}`;
  const owner = dossier.identity?.sdrOwner;
  const activeDeals = (dossier.deals ?? []).filter((x) => !x.closed);

  let reason = category;
  let nextStep = blocker?.remediation ?? 'No action needed; refresh the board and re-check.';
  switch (step) {
    case '0':
      nextStep = 'Double-check the contact link; the record may have been deleted or merged.';
      break;
    case '1': {
      const deal = activeDeals[0];
      nextStep = 'Ask the deal owner to close or advance the active deal so the lead returns to the SDR board.';
      break;
    }
    case '1.5':
      nextStep = 'Ask RevOps / your team lead to assign an SDR owner so the lead moves from Incoming to Open Pipe.';
      break;
    case '2':
      nextStep = 'The cadence cycle has ended, so the lead left the board. Ask RevOps to re-activate the cycle if it should still be worked.';
      break;
    case '3':
      nextStep = 'The lead replied or is unqualified, so outbound cadences are paused. Coordinate with the AE for manual follow-up.';
      break;
    case '4':
      nextStep = blocker?.remediation ?? 'Fix the filter property named in the diagnosis.';
      break;
    case '5':
      nextStep = 'Update the meeting type on the contact to an approved SDR meeting type.';
      break;
    case '6':
      nextStep = blocker?.remediation ?? d.steps.at(-1)?.remediation ?? 'Assign an SDR team so the lead can be routed.';
      break;
    default:
      reason = 'Visible in HubSpot; likely dashboard cache delay';
  }
  const summary = `${who} isn't on your board because of: ${reason}. ${d.conclusion}${owner ? ` Current owner: ${owner}.` : ''}`;
  return {
    sdrView: { summary, reason, nextStep, slackMessage: buildEscalation(dossier, r) },
    adminView: {
      rootCauseCategory: category,
      step: `Step ${step}${title ? `: ${title}` : ''}`,
      propertyDiffs: diffs,
      remediation: blocker?.remediation ?? d.steps.find((s) => s.remediation)?.remediation ?? 'None required.',
    },
    source: 'fallback',
    note,
  };
}

// ---- LLM providers (native fetch; whichever key is present in .env.local) --------------------

const VERTEX_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const VERTEX_MODELS = [process.env.COPILOT_VERTEX_MODEL ?? 'gemini-2.5-flash', 'gemini-1.5-flash'];
const LLM_TIMEOUT_MS = 30_000;

/** Resolves the service-account key to an absolute path and writes it back to GOOGLE_APPLICATION_CREDENTIALS. */
function resolveGcpKeyPath(): string | null {
  const abs = path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS || 'gcp-key.json');
  if (!fs.existsSync(abs)) return null;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = abs;
  return abs;
}

function vertexProject(keyPath: string): string | null {
  if (process.env.GCP_PROJECT_ID) return process.env.GCP_PROJECT_ID;
  try {
    return (JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { project_id?: string }).project_id ?? null;
  } catch {
    return null;
  }
}

type Provider =
  | { name: 'vertex'; project: string; model: string }
  | { name: 'anthropic' | 'openai'; key: string; model: string };

function pickProvider(): Provider | null {
  const keyPath = resolveGcpKeyPath();
  const project = keyPath ? vertexProject(keyPath) : null;
  if (project) return { name: 'vertex', project, model: VERTEX_MODELS[0]! };
  const model = process.env.COPILOT_MODEL;
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: 'anthropic', key: process.env.ANTHROPIC_API_KEY, model: model ?? 'claude-sonnet-4-5' };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: 'openai', key: process.env.OPENAI_API_KEY, model: model ?? 'gpt-4o' };
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Calls Gemini on Vertex AI via @google/genai; tries the older model only if the first is missing in the region. */
async function callVertex(project: string, prompt: string, system: string = getSystemPrompt()): Promise<{ text: string; model: string }> {
  const ai = new GoogleGenAI({ vertexai: true, project, location: process.env.GCP_LOCATION || 'us-central1' });
  let lastErr: unknown;
  for (const model of VERTEX_MODELS) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            temperature: 0,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            // Thinking tokens count against maxOutputTokens; disabling them keeps the JSON from being truncated.
            ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
        LLM_TIMEOUT_MS,
      );
      const outputText = response.text;
      if (!outputText) throw new Error('empty response');
      return { text: outputText, model };
    } catch (e) {
      lastErr = e;
      if (!/404|not found|NOT_FOUND|not supported|unavailable/i.test((e as Error).message)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function callLLM(p: Exclude<Provider, { name: 'vertex' }>, user: string, system: string = getSystemPrompt()): Promise<string> {
  if (p.name === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 1200,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { content: { type: string; text?: string }[] };
    return j.content.map((c) => c.text ?? '').join('');
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  return j.choices[0]?.message.content ?? '';
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
}

export async function generateCopilotAnalysis(
  dossier: LeadDossier,
  engineResult: EngineResult,
  repContext?: RepContext,
): Promise<CopilotResponse> {
  const provider = pickProvider();
  if (!provider) {
    return fallbackAnalysis(dossier, engineResult, 'No GCP service-account key (GOOGLE_APPLICATION_CREDENTIALS / gcp-key.json) or other LLM key found; using grounded template.');
  }
  const diffs = propertyDiffs(engineResult.diagnosis);
  const escalation = buildEscalation(dossier, engineResult);
  const { step, category } = rootStepLabel(engineResult.diagnosis);
  // The prospect's email never goes to the model, so it cannot leak into a Slack draft.
  const { email: _email, ...identityNoEmail } = dossier.identity ?? ({} as NonNullable<LeadDossier['identity']>);
  const payload = {
    dossier: { ...dossier, identity: dossier.identity ? identityNoEmail : undefined },
    slackTags: slackTags(),
    hubspotLink: hubspotLink(dossier.contactId),
    engine: {
      verdict: engineResult.diagnosis.conclusion,
      blockedAtStep: engineResult.diagnosis.blockedAt?.step ?? null,
      rootStep: step,
      rootCauseCategory: category,
      steps: engineResult.diagnosis.steps,
      confidence: engineResult.confidence,
    },
    propertyDiffs: diffs,
    repContext: repContext ?? null,
  };
  try {
    const prompt = `Diagnostic payload:\n${JSON.stringify(payload, null, 2)}\n\n${FORMAT_INSTRUCTIONS}`;
    let modelUsed = provider.model;
    let j: Partial<CopilotResponse> | undefined;
    // One retry (after 500ms) when the model returns an empty or unparsable JSON reply.
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
      try {
        let raw: string;
        if (provider.name === 'vertex') {
          const r = await callVertex(provider.project, prompt);
          raw = r.text;
          modelUsed = r.model;
        } else {
          raw = await withTimeout(callLLM(provider, prompt), LLM_TIMEOUT_MS);
        }
        j = parseJson(raw) as Partial<CopilotResponse>;
      } catch (e) {
        const retryable = e instanceof SyntaxError || /empty response/i.test((e as Error).message);
        if (attempt === 1 || !retryable) throw e;
        console.warn(`LLM returned ${e instanceof SyntaxError ? 'malformed JSON' : 'an empty response'}; retrying once.`);
      }
    }
    if (!j) throw new Error('no LLM response');
    if (!j.sdrView || !j.adminView) throw new Error('LLM response missing sdrView/adminView');
    return {
      sdrView: {
        summary: String(j.sdrView.summary ?? ''),
        reason: String(j.sdrView.reason ?? ''),
        nextStep: String(j.sdrView.nextStep ?? ''),
        // Always an email-free escalation that opens with the BizOps tags; deterministic draft if the LLM gave none.
        slackMessage: !escalation ? null : j.sdrView.slackMessage ? sanitizeSlack(String(j.sdrView.slackMessage)) : escalation,
      },
      adminView: {
        rootCauseCategory: String(j.adminView.rootCauseCategory ?? category),
        step: String(j.adminView.step ?? step),
        propertyDiffs: diffs, // always the deterministic diffs
        remediation: String(j.adminView.remediation ?? ''),
      },
      source: 'llm',
      model: `${provider.name}:${modelUsed}`,
    };
  } catch (e) {
    const err = e;
    console.error('AI Generation failed:', err);
    return fallbackAnalysis(dossier, engineResult, `LLM call failed (${(e as Error).message.slice(0, 120)}); using grounded template.`);
  }
}

/** Which LLM backend will serve requests (for the UI's engine status indicator). */
export function getLlmStatus(): { provider: string; model: string } | null {
  const p = pickProvider();
  if (!p) return null;
  return { provider: p.name, model: p.model };
}

// ---- follow-up Q&A on an already diagnosed lead ---------------------------------------------------

export interface FollowupInput {
  dossier: LeadDossier;
  diagnosis: Diagnosis;
  question: string;
}
export interface FollowupResult {
  answer: string;
  suggestedQuestions?: string[];
  source: 'llm' | 'fallback';
}

const BROAD_RE = /^(?:so\s+)?(?:what else|anything else|tell me more|more (?:info|information|details)|what do you know|give me (?:more|everything|details)|everything|details|more|else|what more|and\??)\b/i;
const SPECIFIC_RE = /\b(owner|cycle|deal|meeting|list|queue|team|size|employee|step|slack|property|stage|duplicate|reply|replied|classification|timestamp|source|merge|why|which|when|who|how)\b/i;

/** Heuristic for vague, open-ended questions (the LLM is also instructed to apply the broad-question rule). */
export function isBroadQuestion(q: string): boolean {
  const t = q.trim().replace(/[?.!]+$/, '');
  if (!t) return true;
  const words = t.split(/\s+/).length;
  return BROAD_RE.test(t) || (words <= 5 && !SPECIFIC_RE.test(t));
}

/** Concrete narrowing options based on what actually exists in the dossier/diagnosis. */
export function followupTopics(dossier: LeadDossier, d: Diagnosis): string[] {
  const topics: string[] = [];
  if (dossier.brain) topics.push('Check owner & SDR cycle timestamps');
  if (dossier.deals?.length) topics.push('Inspect associated deals');
  if (dossier.brain?.meetingType) topics.push('Check the meeting type on this lead');
  if (dossier.queue) topics.push('Verify SDR dashboard list memberships');
  if (d.steps.some((s) => s.status === 'PASS')) topics.push('Review why other waterfall steps passed');
  if (dossier.duplicates?.length) topics.push('Show the duplicate contacts with the same email');
  if (propertyDiffs(d).length) topics.push('Explain the exact CRM property change needed');
  return topics.slice(0, 4);
}

function fallbackFollowup(input: FollowupInput): FollowupResult {
  const { dossier, diagnosis: d, question } = input;
  const q = question.toLowerCase();
  const topics = followupTopics(dossier, d);
  if (isBroadQuestion(question)) {
    return { answer: 'What specifically would you like to check about this lead?', suggestedQuestions: topics, source: 'fallback' };
  }
  const b = dossier.brain;
  let answer: string | null = null;
  if (/owner|sdr/.test(q) && !/cycle/.test(q)) answer = `Current owner: ${dossier.identity?.sdrOwner ?? 'none assigned'}.`;
  else if (/cycle|timestamp|start|end/.test(q)) answer = `Cycle start: ${fmt(b?.cycleStart)}; cycle end: ${fmt(b?.cycleEnd)}; outcome: ${fmt(b?.cycleOutcome)}.`;
  else if (/deal/.test(q)) answer = dossier.deals?.length ? dossier.deals.map((x) => `Deal ${x.id}${x.name ? ` "${x.name}"` : ''}: stage ${fmt(x.stageId)} (${x.closed ? 'closed' : 'open'})`).join('; ') + '.' : 'No associated deals are in the dossier.';
  else if (/meeting/.test(q)) answer = `Meeting type: ${fmt(b?.meetingType)}.`;
  else if (/list|queue|board/.test(q)) answer = `Board/queue position: ${dossier.queue?.summary ?? 'not available'}; list IDs: ${dossier.queue?.allListIds.join(', ') || 'none'}.`;
  else if (/duplicate/.test(q)) answer = dossier.duplicates?.length ? `Duplicates: ${dossier.duplicates.map((x) => `${x.id} (owner ${x.ownerName ?? x.ownerId ?? 'none'}, ${x.lifecycleStage ?? 'n/a'})`).join('; ')}.` : 'No exact-email duplicates were found.';
  else if (/step|pass|why/.test(q)) answer = `${d.conclusion} ${d.steps.map((s) => `Step ${s.step} ${s.title}: ${s.status}`).join('; ')}.`;
  return answer
    ? { answer, source: 'fallback' }
    : { answer: 'That detail is not available in the dossier. What would you like to check instead?', suggestedQuestions: topics, source: 'fallback' };
}

const FOLLOWUP_RULES = `You are now answering a follow-up question from the SDR about a lead that was ALREADY diagnosed; the diagnosis card is already on screen, so never repeat the diagnosis or the Slack escalation.
Respond with ONLY a JSON object: {"answer": string, "suggestedQuestions": string[]}.
BROAD QUESTION RULE: if the question is vague or open-ended (e.g. "what else do you know?", "tell me more", "anything else?"), do NOT list dossier fields. Answer in 1-2 short sentences asking what they want to check, and return 3-4 concrete options in suggestedQuestions, chosen from payload.availableTopics (you may rephrase them slightly; each must be something answerable from the payload).
SPECIFIC QUESTION RULE: if the question concerns a specific property, deal, meeting, list, owner, cycle or waterfall step, answer concisely (at most 3 sentences) using ONLY facts in payload.dossier and payload.engine. If the requested field is not in the payload, say so clearly. suggestedQuestions may be empty.
GUARDRAILS: never invent IDs, names or dates; never output the prospect's email address or phone number; never output the Slack escalation unless the question explicitly asks for it.`;

export async function answerLeadFollowup(input: FollowupInput): Promise<FollowupResult> {
  const { dossier, diagnosis, question } = input;
  const provider = pickProvider();
  if (!provider) return fallbackFollowup(input);

  const { email: _e, ...identity } = dossier.identity ?? ({} as NonNullable<LeadDossier['identity']>);
  const topics = followupTopics(dossier, diagnosis);
  const evidence = {
    dossier: { ...dossier, identity: dossier.identity ? identity : undefined },
    engine: { verdict: diagnosis.conclusion, blockedAtStep: diagnosis.blockedAt?.step ?? null, steps: diagnosis.steps, duplicates: diagnosis.duplicates ?? [] },
  };
  const prompt = `Payload:\n${JSON.stringify({ ...evidence, hubspotLink: hubspotLink(dossier.contactId), slackTags: slackTags(), availableTopics: topics, question }, null, 2)}`;
  const system = `${getSystemPrompt()}\n\n${FOLLOWUP_RULES}`;
  try {
    const raw =
      provider.name === 'vertex'
        ? (await callVertex(provider.project, prompt, system)).text
        : await withTimeout(callLLM(provider, prompt, system), LLM_TIMEOUT_MS);
    const j = parseJson(raw) as { answer?: unknown; suggestedQuestions?: unknown };
    let answer = String(j.answer ?? '').replace(EMAIL_RE, '[email removed]').trim();
    if (!answer) throw new Error('empty answer');

    // Guardrails enforced in code: no IDs outside the evidence, and no Slack block unless asked for.
    const idRe = /\b\d{5,}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const allowed = new Set([...(JSON.stringify(evidence).match(idRe) ?? []), PORTAL_ID, dossier.contactId]);
    const bad = (answer.match(idRe) ?? []).filter((t) => !allowed.has(t));
    if (bad.length) throw new Error(`ungrounded ID(s) in answer: ${bad.join(', ')}`);
    if (!/slack|escalat|ping/i.test(question) && answer.toLowerCase().includes(slackTags().split(' ')[0]!.toLowerCase())) {
      throw new Error('answer repeated the Slack escalation');
    }

    let suggested = Array.isArray(j.suggestedQuestions)
      ? j.suggestedQuestions.map((x) => String(x).replace(EMAIL_RE, '').trim()).filter(Boolean).slice(0, 4)
      : [];
    if (isBroadQuestion(question) && suggested.length < 3) suggested = topics; // broad questions always get narrowing options
    return { answer, suggestedQuestions: suggested.length ? suggested : undefined, source: 'llm' };
  } catch (e) {
    console.error('Follow-up generation failed:', (e as Error).message);
    return fallbackFollowup(input);
  }
}
