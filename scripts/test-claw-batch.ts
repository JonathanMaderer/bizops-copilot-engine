import fs from 'node:fs';
import path from 'node:path';
import { fetchLead, loadStageMeta, type LeadResult } from '../src/engine/hubspot.ts';
import { diagnoseContact, type Diagnosis } from '../src/engine/investigator.ts';
import { scoreDiagnosis } from '../src/engine/confidence.ts';
import { PROPS } from '../src/config/schema.ts';
import type { ExtractedEntry } from './ingest-claw-tickets.ts';

// Usage: npx tsx scripts/test-claw-batch.ts [--all] [--limit N]
//   default: URL-sourced contact IDs only. --all: every extracted contact (URL + raw numeric guesses).
const args = process.argv.slice(2);
const includeRaw = args.includes('--all');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
const BATCH_SIZE = 5;
const PAUSE_MS = 200;

const file = path.resolve('data/extracted-tickets.json');
if (!fs.existsSync(file)) {
  console.error('Run `npx tsx scripts/ingest-claw-tickets.ts` first.');
  process.exit(1);
}
const entries = (JSON.parse(fs.readFileSync(file, 'utf8')) as ExtractedEntry[])
  .filter((e) => includeRaw || e.confidence === 'url')
  .slice(0, limit);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < 3 && /HubSpot (429|5\d\d)/.test((e as Error).message)) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

// ---- failure modes ---------------------------------------------------------------------------
const MODE_LABELS: Record<string, string> = {
  '0': 'Step 0: Contact Not Found',
  '1': 'Step 1: Deal Lock',
  '1.5': 'Step 1.5: Owner Gate (Unassigned SDR)',
  '2': 'Step 2: Brain Cycle Ended',
  '3': 'Step 3: AI Handover / Unqualified',
  '4': 'Step 4: Filter Hygiene / Size',
  '5': 'Step 5: Meeting Validation',
  '6': 'Step 6: Routing / Team / List (warning)',
  pass: 'All steps passed (board OK)',
  error: 'Error (could not diagnose)',
};
const MODE_ORDER = ['0', '1', '1.5', '2', '3', '4', '5', '6', 'pass', 'error'];

function modeOf(d: Diagnosis): string {
  if (d.blockedAt) return String(d.blockedAt.step);
  const last = d.steps.at(-1);
  return last?.step === 6 && last.status === 'WARN' ? '6' : 'pass';
}

export interface ClawResult {
  contactId: string;
  mode: string;
  status: 'BLOCKED' | 'WARN' | 'PASS' | 'ERROR';
  title: string;
  conclusion: string;
  confidence: number;
  confidenceReasons: string[];
  team: string | null;
  sizeRange: string | null;
  stepStatuses: Record<string, string>;
  tickets: number;
  ticketTitles: string[];
  categories: string[];
  source: 'url' | 'raw';
  error?: string;
}

async function diagnoseOne(e: ExtractedEntry, stageMeta: Awaited<ReturnType<typeof loadStageMeta>> | undefined): Promise<ClawResult> {
  const base = {
    contactId: e.contactId,
    tickets: e.tickets.length,
    ticketTitles: e.tickets.map((t) => t.title).slice(0, 3),
    categories: e.categories,
    source: e.confidence,
  };
  try {
    const lead: LeadResult = await withRetry(() => fetchLead(e.contactId));
    const d = await withRetry(() => diagnoseContact(lead));
    const c = scoreDiagnosis(lead, d, stageMeta);
    const mode = modeOf(d);
    const last = d.blockedAt ?? d.steps.at(-1)!;
    const props = 'notFound' in lead ? {} : lead.properties;
    return {
      ...base,
      mode,
      status: d.blockedAt ? 'BLOCKED' : last.status === 'WARN' ? 'WARN' : 'PASS',
      title: last.title,
      conclusion: d.conclusion,
      confidence: c.score,
      confidenceReasons: c.reasons,
      team: props[PROPS.sdrTeam] ?? null,
      sizeRange: props[PROPS.numEmployeesRange] ?? null,
      stepStatuses: Object.fromEntries(d.steps.map((s) => [String(s.step), s.status])),
    };
  } catch (err) {
    return {
      ...base,
      mode: 'error',
      status: 'ERROR',
      title: 'Error',
      conclusion: (err as Error).message.slice(0, 160),
      confidence: 0,
      confidenceReasons: [],
      team: null,
      sizeRange: null,
      stepStatuses: {},
      error: (err as Error).message,
    };
  }
}

// ---- run -------------------------------------------------------------------------------------
const stageMeta = await loadStageMeta().catch(() => undefined);
const results: ClawResult[] = [];
console.log(`Diagnosing ${entries.length} contacts (${includeRaw ? 'URL + raw' : 'URL only'}), batches of ${BATCH_SIZE}, ${PAUSE_MS}ms pause...`);
for (let i = 0; i < entries.length; i += BATCH_SIZE) {
  const batch = entries.slice(i, i + BATCH_SIZE);
  results.push(...(await Promise.all(batch.map((e) => diagnoseOne(e, stageMeta)))));
  if ((i / BATCH_SIZE) % 10 === 9) console.log(`  ${results.length}/${entries.length}`);
  await sleep(PAUSE_MS);
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/claw-results.json', JSON.stringify(results, null, 2));

// ---- summary ---------------------------------------------------------------------------------
const total = results.length;
const byMode = new Map<string, ClawResult[]>();
for (const r of results) (byMode.get(r.mode) ?? byMode.set(r.mode, []).get(r.mode)!).push(r);
const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log(`\nTotal contacts diagnosed: ${total}\n`);
console.log('Root-cause breakdown:');
for (const m of MODE_ORDER) {
  const n = byMode.get(m)?.length ?? 0;
  if (n || m !== 'error') console.log(`  ${(MODE_LABELS[m] ?? m).padEnd(44)} ${String(n).padStart(4)}  ${pct(n).padStart(6)}`);
}
const review = results.filter((r) => r.confidence < 0.8 || r.status === 'WARN' || r.status === 'ERROR');
console.log(`\nContacts needing review (confidence < 0.8, WARN or ERROR): ${review.length}`);
for (const r of review) {
  console.log(`  ${r.contactId.padEnd(14)} ${r.status.padEnd(7)} conf ${r.confidence.toFixed(1)}  ${r.title}: ${r.conclusion.slice(0, 90)}`);
}

// ---- failure taxonomy doc --------------------------------------------------------------------
const RECS: Record<string, { driver: string; actions: string[] }> = {
  '0': {
    driver: 'Ticket links point at contacts that were deleted or merged away.',
    actions: ['Resolve merged IDs automatically (follow `hs_merged_object_ids`) before opening a ticket.', 'Validate contact links in the ticket form.'],
  },
  '1': {
    driver: 'Leads hidden by an active associated deal (the lead is "locked" by a deal that is not Closed Won/Lost).',
    actions: [
      'Show the blocking deal (ID, stage, owner) directly on the SDR board row.',
      'Nightly job to flag deals stale in a pre-sales stage > N days and ask the owner to close or advance them.',
      'Keep `CLOSED_DEAL_STAGES` in sync with HubSpot pipelines (auto-generate from the pipelines API).',
    ],
  },
  '1.5': {
    driver: 'Leads reach the lists with no `sdr_owner` and sit in Incoming instead of Open Pipe.',
    actions: [
      'Workflow: auto-assign `sdr_owner` by team/round-robin when a lead enters a team list.',
      'Alert in Slack when a lead has been unowned for > 15 minutes during shift hours.',
      'Fallback owner branch for unmapped regions/sizes so routing never leaves the owner empty.',
    ],
  },
  '2': {
    driver: 'Brain cycle ended (cadence expiry or Won/Lost outcome), which removes the lead from the SDR board regardless of list membership.',
    actions: [
      'Show "cycle ended on <date>, outcome <X>" on the dashboard so SDRs know why a lead vanished.',
      'Notify the SDR 24h before cycle expiry and offer an "extend cycle" action.',
      'Verify `ai_sdr_cycle_end_time` is cleared on re-activation (start_cycle) and re-enroll on new signals.',
    ],
  },
  '3': {
    driver: 'Lead replied to the AI SDR or was classified unqualified; outbound cadences are paused for AE follow-up.',
    actions: ['Create an AE task automatically on first reply.', 'Display an "AI handover" badge with the reply timestamp on the board.'],
  },
  '4': {
    driver: 'Company-size filter (1-10) or an unqualified free-text reason without the dropdown value.',
    actions: [
      'Make `new_unqualified_reason` required whenever the free-text reason is filled.',
      'Surface the size rule (and the False SBP exception) in the SDR dashboard tooltip.',
    ],
  },
  '5': {
    driver: 'Meeting booked with a type that is not in the approved SDR meeting lists.',
    actions: ['Maintain a single allowlist of approved `meeting_type_cp__c` values and drive the lists from it.', 'Warn the booker when an unapproved meeting type is chosen.'],
  },
  '6': {
    driver: 'Routing gap: missing/unmapped SDR team, or contact not in the team list although all gates pass.',
    actions: ['Require `sdr__sdr_team_` before a lead enters the Brain (default by region + size).', 'Add unseen team labels to the alias map as soon as they appear (alert on unmapped values).'],
  },
  pass: {
    driver: 'All deterministic gates pass; the lead should be visible. Usually dashboard sync lag, board filters or a stale view.',
    actions: ['Show last-sync time and a one-click "re-sync lead" action on the dashboard.', 'Auto-answer these tickets with the verdict "visible, refresh the board" before they reach RevOps.'],
  },
  error: { driver: 'The engine could not read the contact (API error).', actions: ['Re-run the batch; investigate persistent API errors.'] },
};

const doc: string[] = [];
doc.push('# SDR Failure Taxonomy');
doc.push('');
doc.push(`_Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/test-claw-batch.ts\` from ${total} historical contacts (${includeRaw ? 'URL + raw-number IDs' : 'URL-sourced IDs only'}) extracted from SDR tickets. Verdicts reflect the contacts' **current** HubSpot state, not their state when the ticket was filed._`);
doc.push('');
doc.push('## 1. Volume and distribution');
doc.push('');
doc.push('| Failure mode | Contacts | Share |');
doc.push('| --- | ---: | ---: |');
for (const m of MODE_ORDER) {
  const n = byMode.get(m)?.length ?? 0;
  if (n) doc.push(`| ${MODE_LABELS[m]} | ${n} | ${pct(n)} |`);
}
doc.push(`| **Total** | **${total}** | **100%** |`);
doc.push('');
const ranked = MODE_ORDER.filter((m) => m !== 'pass' && (byMode.get(m)?.length ?? 0) > 0).sort(
  (a, b) => byMode.get(b)!.length - byMode.get(a)!.length,
);
doc.push('## 2. Top drivers');
doc.push('');
for (const m of ranked.slice(0, 4)) {
  const rs = byMode.get(m)!;
  const cats = new Map<string, number>();
  rs.forEach((r) => r.categories.forEach((c) => cats.set(c, (cats.get(c) ?? 0) + 1)));
  const topCats = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${c} (${n})`);
  doc.push(`### ${MODE_LABELS[m]}: ${rs.length} contacts (${pct(rs.length)})`);
  doc.push('');
  doc.push(RECS[m]?.driver ?? '');
  if (topCats.length) doc.push(`\nMost common ticket themes: ${topCats.join(', ')}.`);
  doc.push('\nExamples:');
  for (const r of rs.slice(0, 3)) doc.push(`- \`${r.contactId}\`: ${r.ticketTitles[0] ?? '(no title)'}`);
  doc.push('');
}
const passN = byMode.get('pass')?.length ?? 0;
if (passN) {
  doc.push(`### ${MODE_LABELS.pass}: ${passN} contacts (${pct(passN)})`);
  doc.push('');
  doc.push(RECS.pass!.driver);
  doc.push('');
}
doc.push('## 3. Recommended RevOps automations');
doc.push('');
let n = 1;
for (const m of [...ranked, 'pass']) {
  if (!(byMode.get(m)?.length)) continue;
  doc.push(`**${n++}. ${MODE_LABELS[m]}** (${byMode.get(m)!.length} contacts)`);
  for (const a of RECS[m]!.actions) doc.push(`- ${a}`);
  doc.push('');
}
doc.push('## 4. Low-confidence and review cases');
doc.push('');
doc.push(`${review.length} contact(s) scored below 0.8 or returned WARN/ERROR; these indicate gaps in the engine's mappings (unmapped teams, meeting types or deal stages) and should be reviewed with \`scripts/investigate.ts\`.`);
doc.push('');
for (const r of review.slice(0, 25)) doc.push(`- \`${r.contactId}\` (${r.status}, conf ${r.confidence.toFixed(1)}): ${r.conclusion.slice(0, 120)}`);
doc.push('');
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/SDR_FAILURE_TAXONOMY.md', doc.join('\n'));

// ---- golden benchmark ------------------------------------------------------------------------
const clean = results.filter((r) => r.confidence >= 0.8 && r.status !== 'ERROR');
const pool = [...clean].sort((a, b) => Number(b.source === 'url') - Number(a.source === 'url') || b.tickets - a.tickets);
const picked = new Map<string, ClawResult>();
const take = (r: ClawResult | undefined) => {
  if (r && picked.size < 20 && !picked.has(r.contactId)) picked.set(r.contactId, r);
};
for (const m of MODE_ORDER) take(pool.find((r) => r.mode === m)); // every distinct step
for (const r of pool) if (r.team && ![...picked.values()].some((p) => p.team === r.team)) take(r); // every distinct team
for (const r of pool) take(r); // fill by ticket volume
const golden = {
  note: 'Snapshot of engine verdicts on real historical contacts. HubSpot data is live, so re-baseline when contacts legitimately change.',
  createdAt: new Date().toISOString(),
  cases: [...picked.values()].map((r) => ({
    contactId: r.contactId,
    expected: { mode: r.mode, status: r.status, title: r.title, conclusion: r.conclusion, minConfidence: r.confidence, stepStatuses: r.stepStatuses },
    team: r.team,
    sizeRange: r.sizeRange,
    sourceTickets: r.ticketTitles,
  })),
};
fs.writeFileSync('data/golden-benchmark.json', JSON.stringify(golden, null, 2));
console.log(`\nSaved: data/claw-results.json, docs/SDR_FAILURE_TAXONOMY.md, data/golden-benchmark.json (${golden.cases.length} cases)`);
