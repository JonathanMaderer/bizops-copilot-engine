import { PROPS } from '../config/schema.ts';
import { fetchLead, loadStageMeta, type LeadResult } from '../engine/hubspot.ts';
import { buildDossier, extractContactId, type Dossier } from '../engine/dossier.ts';
import { diagnoseContact, type Diagnosis } from '../engine/investigator.ts';
import { scoreDiagnosis, type Confidence, type StageMeta } from '../engine/confidence.ts';
import { generateCopilotAnalysis, type CopilotResponse, type RepContext } from '../ai/copilot.ts';

export type ReportedIssue = 'missing_open_pipe' | 'demo_vanished' | 'unassigned_incoming' | 'cadence_stopped' | 'other';

export interface DiagnoseRequest {
  contactIdOrUrl: string;
  reportedIssue?: ReportedIssue;
  customIssueText?: string;
  targetQueue?: string; // e.g. 'Sales NA 11-50', 'Social APAC'
  clarificationAnswers?: Record<string, string>; // question id -> chosen option
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  options: string[];
}

/** JSON contract returned to the web UI (and any other client). */
export interface CopilotResult {
  contactId: string;
  generatedAt: string;
  request: Omit<DiagnoseRequest, 'contactIdOrUrl'>;
  dossier: Dossier | { contactId: string; notFound: true };
  engine: {
    diagnosis: Diagnosis;
    /** Confidence after any rep clarifications were applied. */
    confidence: Confidence;
    /** Confidence the deterministic engine produced before clarifications. */
    baseConfidence: Confidence;
  };
  copilot: CopilotResponse;
  /** Present only when confidence < 1.0 and questions remain unanswered. */
  clarificationQuestions?: ClarificationQuestion[];
  needsClarification: boolean;
  /** Deterministic statements derived from the rep's answers (empty before any answers). */
  resolution: string[];
  reportedIssueAssessment?: string;
  links: { hubspotContact: string };
}

export class InvalidInputError extends Error {}

const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID ?? '4021060';

let stageMetaPromise: Promise<StageMeta | undefined> | undefined;
const stageMeta = () => (stageMetaPromise ??= loadStageMeta().catch(() => undefined));

/** Fetches the lead from HubSpot and assembles its evidence dossier. */
export async function fetchLeadDossier(contactId: string): Promise<{ lead: LeadResult; dossier: CopilotResult['dossier'] }> {
  const lead = await fetchLead(contactId);
  const dossier = 'notFound' in lead ? { contactId, notFound: true as const } : await buildDossier(lead);
  return { lead, dossier };
}

/** Runs the deterministic diagnostic waterfall and scores its confidence. */
export async function investigateContact(lead: LeadResult): Promise<{ diagnosis: Diagnosis; confidence: Confidence }> {
  const diagnosis = await diagnoseContact(lead);
  const confidence = scoreDiagnosis(lead, diagnosis, await stageMeta());
  return { diagnosis, confidence };
}

// ---- clarifications --------------------------------------------------------------------------

const QUEUE_VIEWS = ['Open Pipe', 'Pending Demos', 'No-Shows', 'Incoming', 'Not sure'];
const QUESTIONS: Record<string, ClarificationQuestion> = {
  demo_attended: { id: 'demo_attended', question: 'Did the prospect attend the scheduled demo?', options: ['Yes, attended', 'No-show', 'Rescheduled', 'Not sure'] },
  booked_by: { id: 'booked_by', question: 'Who booked this meeting?', options: ['SDR', 'AI SDR', 'AE', 'Prospect self-booked', 'Not sure'] },
  queue_view: { id: 'queue_view', question: 'Which specific queue view were you looking at?', options: QUEUE_VIEWS },
  team_expected: {
    id: 'team_expected',
    question: 'Which team should own this lead?',
    options: ['Sales NA', 'Sales EMEA', 'Sales APAC', 'Social NA', 'Social EMEA', 'Social APAC', 'Not sure'],
  },
  size_confirm: { id: 'size_confirm', question: 'Is the 1-10 company size confirmed inaccurate (False SBP)?', options: ['Yes, size is wrong', 'No, size is correct', 'Not sure'] },
  merged_source: { id: 'merged_source', question: 'Was this ID taken from a duplicate / merged record?', options: ['Yes', 'No', 'Not sure'] },
  id_source: { id: 'id_source', question: 'Where did you get this contact ID?', options: ['HubSpot contact URL', 'Deal or company record', 'Dashboard', 'Other'] },
  deal_open: { id: 'deal_open', question: 'Is the associated deal still open?', options: ['Yes, still open', 'No, it is closed', 'Not sure'] },
};

function buildClarifications(lead: LeadResult, d: Diagnosis, c: Confidence, req: DiagnoseRequest): ClarificationQuestion[] {
  if (c.score >= 1) return [];
  const ids: string[] = [];
  if ('notFound' in lead) ids.push('id_source');
  else {
    const last = d.steps.at(-1);
    if (d.blockedAt?.step === 5) ids.push('demo_attended', 'booked_by');
    if (lead.guard?.status === 'WARN') ids.push('merged_source');
    if (c.reasons.some((r) => /unmapped stage|missing from CLOSED_DEAL_STAGES/i.test(r))) ids.push('deal_open');
    if (last?.step === 6 && last.status === 'WARN') {
      if (!lead.properties[PROPS.sdrTeam] || last.propertyKey === PROPS.sdrTeam) ids.push('team_expected');
      if (!req.targetQueue) ids.push('queue_view');
    }
    if (d.steps.some((s) => s.step === 4 && /override/i.test(s.detail))) ids.push('size_confirm');
  }
  return [...new Set(ids)].slice(0, 2).map((id) => QUESTIONS[id]!);
}

const RESOLUTIONS: Record<string, (a: string) => string> = {
  demo_attended: (a) =>
    a === 'No-show'
      ? 'Rep confirmed the prospect no-showed: handle through the no-show playbook; the unapproved meeting type does not qualify for SDR credit.'
      : a === 'Rescheduled'
        ? 'Rep confirmed the demo was rescheduled: update the meeting type/date on the rescheduled meeting.'
        : a.startsWith('Yes')
          ? 'Rep confirmed the demo took place: the meeting type must be corrected to an approved SDR type for the lead to count.'
          : '',
  booked_by: (a) => (a === 'Not sure' ? '' : `Rep confirmed the meeting was booked by: ${a}.`),
  queue_view: (a) => (a === 'Not sure' ? '' : `Rep was looking at the "${a}" queue view.`),
  team_expected: (a) => (a === 'Not sure' ? '' : `Rep expects the lead on team "${a}"; assign sdr__sdr_team_ accordingly.`),
  size_confirm: (a) => (a.startsWith('Yes') ? 'Rep confirmed the size is wrong: the False SBP override is valid.' : a.startsWith('No') ? 'Rep says the size is correct: the False SBP override should be reviewed.' : ''),
  merged_source: (a) => (a === 'Yes' ? 'Rep confirmed the ID came from a merged/duplicate record: use the primary contact.' : ''),
  id_source: (a) => `Rep obtained the ID from: ${a}.`,
  deal_open: (a) => (a.startsWith('Yes') ? 'Rep confirmed the deal is open: the deal lock is valid.' : a.startsWith('No') ? 'Rep says the deal is closed: its stage should be added to CLOSED_DEAL_STAGES.' : ''),
};

function applyClarifications(base: Confidence, questions: ClarificationQuestion[], answers: Record<string, string>) {
  const answered = questions.filter((q) => answers[q.id]);
  const resolution = answered.map((q) => RESOLUTIONS[q.id]?.(answers[q.id]!) ?? '').filter(Boolean);
  if (!questions.length || answered.length < questions.length) return { confidence: base, resolution };
  const unsure = answered.some((q) => /not sure/i.test(answers[q.id]!));
  const score = unsure ? Math.max(base.score, 0.8) : 1;
  const band: Confidence['band'] = score >= 1 ? 'Definitive' : 'Heuristic / Override';
  return {
    confidence: { score, band, reasons: [...base.reasons, `${score.toFixed(1)}: upgraded after rep clarification (${answered.map((q) => `${q.id}=${answers[q.id]}`).join(', ')}).`] },
    resolution,
  };
}

/** Compares the rep's reported issue with the engine's finding. */
function assessReportedIssue(req: DiagnoseRequest, d: Diagnosis): string | undefined {
  if (!req.reportedIssue || req.reportedIssue === 'other') return req.customIssueText ? `Rep note: ${req.customIssueText}` : undefined;
  const step = d.blockedAt?.step;
  const expected: Record<string, number[]> = {
    missing_open_pipe: [1, 2, 3, 4, 6],
    demo_vanished: [5],
    unassigned_incoming: [1.5],
    cadence_stopped: [2, 3],
  };
  const label = req.reportedIssue.replace(/_/g, ' ');
  if (step === undefined) return `Reported "${label}", but the engine found no blocking gate; the lead should be visible (check board filters / sync).`;
  return expected[req.reportedIssue]?.includes(step)
    ? `Reported "${label}" is consistent with the engine finding (Step ${step}).`
    : `Reported "${label}", but the engine's root cause is Step ${step} (${d.blockedAt?.title}).`;
}

export async function diagnoseLead(input: string | DiagnoseRequest): Promise<CopilotResult> {
  const req: DiagnoseRequest = typeof input === 'string' ? { contactIdOrUrl: input } : input;
  const contactId = extractContactId(req.contactIdOrUrl ?? '');
  if (!contactId) throw new InvalidInputError('Enter a numeric HubSpot contact ID or a HubSpot contact URL.');

  const { lead, dossier } = await fetchLeadDossier(contactId);
  const { diagnosis, confidence: baseConfidence } = await investigateContact(lead);

  const allQuestions = buildClarifications(lead, diagnosis, baseConfidence, req);
  const answers = req.clarificationAnswers ?? {};
  const { confidence, resolution } = applyClarifications(baseConfidence, allQuestions, answers);
  const pending = allQuestions.filter((q) => !answers[q.id]);

  const reportedIssueAssessment = assessReportedIssue(req, diagnosis);
  const repContext: RepContext = {
    reportedIssue: req.reportedIssue,
    customIssueText: req.customIssueText,
    targetQueue: req.targetQueue,
    confirmedAnswers: allQuestions.filter((q) => answers[q.id]).map((q) => ({ question: q.question, answer: answers[q.id]! })),
    resolution,
    reportedIssueAssessment,
  };
  const copilot = await generateCopilotAnalysis(dossier as never, { diagnosis, confidence }, repContext);

  return {
    contactId,
    generatedAt: new Date().toISOString(),
    request: {
      reportedIssue: req.reportedIssue,
      customIssueText: req.customIssueText,
      targetQueue: req.targetQueue,
      clarificationAnswers: req.clarificationAnswers,
    },
    dossier,
    engine: { diagnosis, confidence, baseConfidence },
    copilot,
    clarificationQuestions: pending.length ? pending : undefined,
    needsClarification: pending.length > 0,
    resolution,
    reportedIssueAssessment,
    links: { hubspotContact: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${contactId}` },
  };
}
