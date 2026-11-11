import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import type { Diagnosis } from '../engine/investigator.ts';
import type { Confidence } from '../engine/confidence.ts';

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

export const SYSTEM_PROMPT =
  'You are an expert SDR Team Lead and RevOps Specialist. Your task is to interpret a deterministic CRM diagnostic payload for a lead that an SDR cannot find on their dashboard. You must NEVER hallucinate or assume facts not present in the payload. Rely ONLY on the provided dossier.';

const FORMAT_INSTRUCTIONS = `Respond with ONLY a JSON object (no markdown fences) with this exact shape:
{
  "sdrView": {
    "summary": "2-3 sentences, empathetic, clear and direct",
    "reason": "plain-English reason the lead is not visible, e.g. 'AE Deal Lock', 'Unassigned in Incoming', 'Cadence expired'",
    "nextStep": "one concrete action for the SDR",
    "slackMessage": "copy-paste ready Slack message if the rep needs to ping someone (AE about an active deal, RevOps to assign an incoming lead), otherwise null"
  },
  "adminView": {
    "rootCauseCategory": "root cause category",
    "step": "engine step number and title",
    "propertyDiffs": ["use the provided propertyDiffs verbatim; do not invent others"],
    "remediation": "direct remediation action"
  }
}
Rules: repContext holds statements made by the rep (not CRM data): you may use them for tone and to explain the resolution, but never present them as CRM properties. Use only facts in the payload (names, IDs, dates, stages). If a fact is missing, say it is not available. Do not invent people, owners or dates.`;

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
  let slack: string | null = null;
  switch (step) {
    case '0':
      nextStep = 'Double-check the contact link; the record may have been deleted or merged.';
      break;
    case '1': {
      const deal = activeDeals[0];
      nextStep = 'Ask the deal owner to close or advance the active deal so the lead returns to the SDR board.';
      slack = `Hi! ${who} (contact ${dossier.contactId}) is hidden from my SDR board because of an active deal${deal ? ` (#${deal.id}${deal.name ? ` "${deal.name}"` : ''}, stage ${fmt(deal.stageId)})` : ''}. Is that deal still being worked, or can it be closed/advanced?`;
      break;
    }
    case '1.5':
      nextStep = 'Ask RevOps / your team lead to assign an SDR owner so the lead moves from Incoming to Open Pipe.';
      slack = `Hi RevOps! ${who} (contact ${dossier.contactId}) has no sdr_owner and is sitting in Incoming. Could you assign an SDR owner${dossier.identity?.team ? ` on team "${dossier.identity.team}"` : ''}? Thanks!`;
      break;
    case '2':
      nextStep = 'The cadence cycle has ended, so the lead left the board. Ask RevOps to re-activate the cycle if it should still be worked.';
      slack = `Hi RevOps! ${who} (contact ${dossier.contactId}) disappeared from my board: the Brain cycle ended on ${fmt(dossier.brain?.cycleEnd)} (outcome: ${dossier.brain?.cycleOutcome ?? 'not recorded'}). Should this lead be re-activated?`;
      break;
    case '3':
      nextStep = 'The lead replied or is unqualified, so outbound cadences are paused. Coordinate with the AE for manual follow-up.';
      break;
    case '4':
      nextStep = blocker?.remediation ?? 'Fix the filter property named in the diagnosis.';
      break;
    case '5':
      nextStep = 'Update the meeting type on the contact to an approved SDR meeting type.';
      slack = `Hi RevOps! ${who} (contact ${dossier.contactId}) has meeting type "${fmt(dossier.brain?.meetingType)}", which is not an approved SDR meeting type. Can you confirm whether it should be added or corrected?`;
      break;
    case '6':
      nextStep = blocker?.remediation ?? d.steps.at(-1)?.remediation ?? 'Assign an SDR team so the lead can be routed.';
      break;
    default:
      reason = 'Visible in HubSpot; likely dashboard cache delay';
  }
  const summary = `${who} isn't on your board because of: ${reason}. ${d.conclusion}${owner ? ` Current owner: ${owner}.` : ''}`;
  return {
    sdrView: { summary, reason, nextStep, slackMessage: slack },
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
async function callVertex(project: string, prompt: string): Promise<{ text: string; model: string }> {
  const ai = new GoogleGenAI({ vertexai: true, project, location: process.env.GCP_LOCATION || 'us-central1' });
  let lastErr: unknown;
  for (const model of VERTEX_MODELS) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
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

async function callLLM(p: Exclude<Provider, { name: 'vertex' }>, user: string): Promise<string> {
  if (p.name === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        max_tokens: 1200,
        temperature: 0,
        system: SYSTEM_PROMPT,
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
        { role: 'system', content: SYSTEM_PROMPT },
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
  const { step, category } = rootStepLabel(engineResult.diagnosis);
  const payload = {
    dossier,
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
    let raw: string;
    let modelUsed = provider.model;
    if (provider.name === 'vertex') {
      const r = await callVertex(provider.project, prompt);
      raw = r.text;
      modelUsed = r.model;
    } else {
      raw = await withTimeout(callLLM(provider, prompt), LLM_TIMEOUT_MS);
    }
    const j = parseJson(raw) as Partial<CopilotResponse>;
    if (!j.sdrView || !j.adminView) throw new Error('LLM response missing sdrView/adminView');
    return {
      sdrView: {
        summary: String(j.sdrView.summary ?? ''),
        reason: String(j.sdrView.reason ?? ''),
        nextStep: String(j.sdrView.nextStep ?? ''),
        slackMessage: j.sdrView.slackMessage ? String(j.sdrView.slackMessage) : null,
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
