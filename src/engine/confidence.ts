import { SIZE_OVERRIDE_LEAD_SOURCE, PROPS } from '../config/schema.ts';
import type { LeadResult } from './hubspot.ts';
import type { Diagnosis } from './investigator.ts';

export interface Confidence {
  score: number;
  band: 'Definitive' | 'Heuristic / Override' | 'Ambiguous / Review';
  reasons: string[];
}

const band = (n: number): Confidence['band'] => (n >= 1 ? 'Definitive' : n >= 0.6 ? 'Heuristic / Override' : 'Ambiguous / Review');

/** Stage id -> metadata from the HubSpot deal pipelines (see loadStageMeta in hubspot.ts). */
export type StageMeta = Map<string, { label: string; isClosed: boolean }>;

/**
 * Penalties (< 0.8) are reserved for: unmapped team strings (Step 6), unknown meeting types (Step 5),
 * deals in unmapped pipeline stages, and 404 / merge anomalies. Everything else is a clear rule match;
 * in particular Owner Gate (1.5) and Brain State (2) blocks are expected even while the contact sits in
 * an Open Pipe list (Incoming lead; cadence expiry hides leads regardless of static list membership).
 */
export function scoreDiagnosis(lead: LeadResult, d: Diagnosis, stageMeta?: StageMeta): Confidence {
  const reasons: string[] = [];
  if ('notFound' in lead) {
    return { score: 0.5, band: 'Ambiguous / Review', reasons: ['0.5: 404 anomaly: contact does not exist (deleted, merged away, or wrong ID).'] };
  }

  let score = 1;
  const cap = (n: number, why: string) => {
    if (n < score) score = n;
    reasons.push(`${n.toFixed(1)}: ${why}`);
  };
  const p = lead.properties;
  const last = d.steps[d.steps.length - 1];

  if (d.steps.some((s) => s.step === 4 && s.status === 'PASS' && /override/i.test(s.detail))) {
    cap(0.8, `Qualified via exception rule ('${SIZE_OVERRIDE_LEAD_SOURCE}' size override).`);
  }
  if (lead.guard?.status === 'WARN') cap(0.7, 'Merge anomaly: contact was merged; diagnosed the primary record.');

  if (stageMeta) {
    for (const deal of lead.activeDeals) {
      const m = deal.dealstage ? stageMeta.get(deal.dealstage) : undefined;
      if (!m) cap(0.5, `Deal ${deal.id} is in unmapped stage "${deal.dealstage}" (not found in any pipeline).`);
      else if (m.isClosed) cap(0.5, `Deal ${deal.id} stage "${m.label}" (${deal.dealstage}) is closed in HubSpot but missing from CLOSED_DEAL_STAGES.`);
    }
  }

  if (d.blockedAt) {
    const b = d.blockedAt;
    if (b.step === 5) cap(0.5, `Unexpected meeting type "${p[PROPS.meetingType] ?? ''}" not in approved lists (list lag possible).`);
    if (reasons.length === 0) reasons.push(`1.0: Unambiguous rule matched (${b.title}).`);
  } else if (last?.step === 6) {
    const team = p[PROPS.sdrTeam];
    if (last.status === 'WARN') {
      if (last.propertyKey === PROPS.sdrTeam && team) {
        cap(0.4, `Unmapped team string "${team}" (no matching LIST_IDS.teams key).`);
      } else if (!team) {
        cap(0.9, 'Unrouted: no SDR team assigned (clear routing blocker).');
      } else if (/could not be fully evaluated|Could not read|no filterBranch/i.test(last.detail)) {
        cap(0.8, 'List filter criteria could not be fully evaluated (heuristic).');
      } else {
        cap(0.8, 'Not in board list; filter criteria evaluated heuristically.');
      }
    } else if (/active on board under/i.test(last.detail)) {
      cap(0.9, 'Present in another board table queue.');
    } else if (reasons.length === 0) {
      reasons.push('1.0: Confirmed inside the board list.');
    }
  }
  if (reasons.length === 0) reasons.push('1.0: Clear rule match.');
  return { score: Number(score.toFixed(1)), band: band(score), reasons };
}
