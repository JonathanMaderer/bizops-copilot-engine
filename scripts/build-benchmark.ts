/**
 * Expands data/golden-benchmark.json from live HubSpot data (run manually; the benchmark itself is a frozen snapshot).
 *
 *   npx tsx scripts/build-benchmark.ts            # dry run: prints what would be added
 *   npx tsx scripts/build-benchmark.ts --write    # rewrites data/golden-benchmark.json
 *
 * Existing cases are kept as-is (annotated). New cases are only added when the live engine verdict
 * matches the intended category, so every case is a real, currently-reproducible edge case.
 */
import fs from 'node:fs';
import dotenv from 'dotenv';
import { PROPS } from '../src/config/schema.ts';
import { fetchLead, getContact, loadStageMeta } from '../src/engine/hubspot.ts';
import { diagnoseContact, type Diagnosis } from '../src/engine/investigator.ts';
import { scoreDiagnosis } from '../src/engine/confidence.ts';

dotenv.config({ path: '.env.local', quiet: true });

const FILE = new URL('../data/golden-benchmark.json', import.meta.url);
const CLAW = new URL('../data/claw-results.json', import.meta.url);
const WRITE = process.argv.includes('--write');

type Filter = { propertyName: string; operator: string; value?: string; values?: string[] };
const has = (p: string): Filter => ({ propertyName: p, operator: 'HAS_PROPERTY' });
const not = (p: string): Filter => ({ propertyName: p, operator: 'NOT_HAS_PROPERTY' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(groups: Filter[][], limit = 100): Promise<{ id: string; props: Record<string, string | null> }[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: groups.map((filters) => ({ filters })),
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
        properties: [PROPS.sdrTeam, PROPS.numEmployeesRange],
        limit,
      }),
    });
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { results: { id: string; properties: Record<string, string | null> }[] };
    return j.results.map((c) => ({ id: c.id, props: c.properties }));
  }
  throw new Error('search rate-limited');
}

const noDeals = (f: Filter[]): Filter[][] => [
  [...f, { propertyName: 'num_associated_deals', operator: 'EQ', value: '0' }],
  [...f, not('num_associated_deals')],
];

const regionOf = (team: string | null | undefined): 'NA' | 'EMEA' | 'APAC' | null =>
  !team ? null : /apac/i.test(team) ? 'APAC' : /emea/i.test(team) ? 'EMEA' : /north america|\bna\b/i.test(team) ? 'NA' : null;

// ---- snapshot ------------------------------------------------------------------------------------
const stageMeta = await loadStageMeta().catch(() => undefined);

interface Snap {
  contactId: string;
  diagnosis: Diagnosis;
  score: number;
  team: string | null;
  sizeRange: string | null;
}

async function snap(id: string): Promise<Snap | null> {
  try {
    const lead = await fetchLead(id);
    if ('notFound' in lead) return null;
    const diagnosis = await diagnoseContact(lead);
    return {
      contactId: id,
      diagnosis,
      score: scoreDiagnosis(lead, diagnosis, stageMeta).score,
      team: lead.properties[PROPS.sdrTeam] ?? null,
      sizeRange: lead.properties[PROPS.numEmployeesRange] ?? null,
    };
  } catch (e) {
    console.error(`  skip ${id}: ${(e as Error).message.slice(0, 100)}`);
    return null;
  }
}

const finalStatus = (d: Diagnosis) => (d.blockedAt ? 'BLOCKED' : d.steps.some((s) => s.status === 'WARN') ? 'WARN' : 'PASS');
/** Step that determines the verdict: the blocker, else the last WARN step. */
const verdictStep = (d: Diagnosis) => d.blockedAt ?? [...d.steps].reverse().find((s) => s.status === 'WARN');

function toCase(s: Snap, category: string, notes: string, sourceTickets: string[] = []) {
  const d = s.diagnosis;
  const status = finalStatus(d);
  const v = verdictStep(d);
  const stepStatuses: Record<string, string> = {};
  for (const st of d.steps) stepStatuses[String(st.step)] = st.status;
  return {
    contactId: s.contactId,
    category,
    region: regionOf(s.team),
    expected: {
      status,
      mode: status === 'PASS' ? null : String(v!.step),
      blockedAt: d.blockedAt ? { step: d.blockedAt.step, title: d.blockedAt.title } : null,
      title: v?.title ?? 'All steps pass',
      conclusion: d.conclusion,
      minConfidence: Math.floor(s.score * 10) / 10,
      stepStatuses,
      ...(d.duplicates?.length ? { duplicateIds: d.duplicates.map((x) => x.id) } : {}),
    },
    team: s.team,
    sizeRange: s.sizeRange,
    sourceTickets,
    notes,
  };
}

// ---- existing cases ------------------------------------------------------------------------------
type Case = ReturnType<typeof toCase> | (Record<string, any> & { contactId: string });
const bench = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { note: string; createdAt: string; cases: Record<string, any>[] };
const existing: Record<string, any>[] = bench.cases.map((c) => {
  if (c.category) return c;
  const e = c.expected;
  return {
    contactId: c.contactId,
    category: `step-${e.mode}`,
    region: regionOf(c.team),
    expected: { ...e, blockedAt: { step: Number(e.mode), title: e.title } },
    team: c.team,
    sizeRange: c.sizeRange,
    sourceTickets: c.sourceTickets ?? [],
    notes: `Historical ticket case. Snapshot: ${e.title}. ${e.conclusion}`,
  };
});
const used = new Set(existing.map((c) => c.contactId));
const added: Case[] = [];
const tally: Record<string, number> = {};
const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

async function tryAdd(id: string, category: string, ok: (s: Snap) => boolean, notes: (s: Snap) => string, tickets: string[] = []) {
  if (used.has(id)) return false;
  const s = await snap(id);
  if (!s || !ok(s)) return false;
  used.add(id);
  added.push(toCase(s, category, notes(s), tickets));
  bump(category);
  console.log(`  + ${category.padEnd(12)} ${id}  ${finalStatus(s.diagnosis)}@${verdictStep(s.diagnosis)?.step ?? '-'}`);
  return true;
}

// ---- 1. historical (claw) edge cases -------------------------------------------------------------
const claw = JSON.parse(fs.readFileSync(CLAW, 'utf8')) as { contactId: string; mode: string; ticketTitles: string[] }[];
const clawQuota: Record<string, number> = { '1': 3, '1.5': 2, '2': 2, '3': 3, '5': 3 };
console.log('Historical (claw) cases');
for (const [mode, quota] of Object.entries(clawQuota)) {
  let n = 0;
  for (const c of claw.filter((x) => x.mode === mode)) {
    if (n >= quota) break;
    const ok = await tryAdd(
      c.contactId,
      `step-${mode}`,
      (s) => String(s.diagnosis.blockedAt?.step) === mode,
      (s) => `Historical ticket case, verdict re-confirmed live. ${s.diagnosis.blockedAt?.detail ?? ''}`.trim(),
      c.ticketTitles,
    );
    if (ok) n++;
  }
}

// ---- 2. Step 4 (company size / filter hygiene) ----------------------------------------------------
console.log('Step 4 cases');
const step4Searches: { label: string; groups: Filter[][] }[] = [
  {
    label: 'company size 1-10 without the False SBP override',
    groups: [
      [has(PROPS.cycleStart), not(PROPS.cycleEnd), not(PROPS.firstRepliedAt), has(PROPS.sdrOwner), { propertyName: PROPS.numEmployeesRange, operator: 'EQ', value: '1-10' }, { propertyName: PROPS.sdrLeadSource, operator: 'NEQ', value: 'False SBP' }],
      [has(PROPS.cycleStart), not(PROPS.cycleEnd), not(PROPS.firstRepliedAt), has(PROPS.sdrOwner), { propertyName: PROPS.numEmployeesRange, operator: 'EQ', value: '1-10' }, not(PROPS.sdrLeadSource)],
    ],
  },
  {
    label: 'free-text unqualified reason with empty new_unqualified_reason dropdown',
    groups: noDeals([has(PROPS.unqualifiedReasonText), not(PROPS.newUnqualifiedReason)]),
  },
];
const step4Quota = [3, 2];
for (const [i, sc] of step4Searches.entries()) {
  let n = 0;
  for (const c of await search(sc.groups)) {
    if (n >= step4Quota[i]!) break;
    if (await tryAdd(c.id, 'step-4', (s) => s.diagnosis.blockedAt?.step === 4, () => `Step 4 edge case: ${sc.label}.`)) n++;
  }
}

// ---- 2b. Step 5 (meeting type strings) ---------------------------------------------------------------
console.log('Step 5 cases');
{
  let n = 0;
  const meetingPool = await search(noDeals([has(PROPS.meetingType), has(PROPS.cycleStart), not(PROPS.cycleEnd), not(PROPS.firstRepliedAt)]));
  const seenTypes = new Set<string>();
  for (const c of meetingPool) {
    if (n >= 3) break;
    const ok = await tryAdd(
      c.id,
      'step-5',
      (sn) => sn.diagnosis.blockedAt?.step === 5 && !seenTypes.has(sn.diagnosis.blockedAt.detail),
      (sn) => `Step 5 edge case: unapproved meeting type string. ${sn.diagnosis.blockedAt?.detail ?? ''}`.trim(),
    );
    if (ok) {
      n++;
      seenTypes.add(added.at(-1)!.expected.conclusion);
    }
  }
}

// ---- 3. Step 6 + PASS controls from one pool of active, owned, routed leads -----------------------
console.log('Step 6 cases and PASS controls');
const poolFilters = [has(PROPS.cycleStart), not(PROPS.cycleEnd), not(PROPS.firstRepliedAt), has(PROPS.sdrOwner), has(PROPS.sdrTeam)];
const pool = await search(noDeals(poolFilters));
const passQuota: Record<string, number> = { NA: 4, EMEA: 3, APAC: 3 };
let step6 = 0;
for (const c of pool) {
  const region = regionOf(c.props[PROPS.sdrTeam]);
  const needPass = region && (passQuota[region] ?? 0) > 0;
  if (step6 >= 6 && !needPass) continue;
  if (step6 >= 6 && Object.values(passQuota).every((n) => n <= 0)) break;
  const s = await snap(c.id);
  if (!s) continue;
  const status = finalStatus(s.diagnosis);
  const step = verdictStep(s.diagnosis)?.step;
  if (status === 'WARN' && step === 6 && step6 < 6) {
    const d = s.diagnosis.steps.find((x) => x.step === 6)!;
    used.add(c.id);
    added.push(toCase(s, 'step-6', `Step 6 edge case: contact is not in its team's board list. ${d.detail}`));
    bump('step-6');
    step6++;
    console.log(`  + step-6       ${c.id}  WARN@6 (${regionOf(s.team) ?? 'n/a'})`);
  } else if (status === 'PASS' && region && passQuota[region]! > 0 && s.score >= 1 && !used.has(c.id)) {
    used.add(c.id);
    added.push(toCase(s, 'pass-control', `Healthy control (${region}): active lead, owned, routed, in its board list. Any BLOCKED here is a false positive.`));
    passQuota[region]!--;
    bump('pass-control');
    console.log(`  + pass-control ${c.id}  PASS (${region}, ${s.team})`);
  }
  if (s.diagnosis.duplicates?.length) console.log(`    ! duplicates for ${c.id}: ${s.diagnosis.duplicates.map((x) => x.id).join(',')}`);
}

// Fill any PASS-control quota the generic pool could not (region-specific searches).
const regionTeams: Record<string, string[]> = {
  NA: ['North America 11-100 ET', 'North America 11-100 CT', 'North America 51-200', 'Social North America'],
  EMEA: ['EMEA 11-100', 'Social EMEA'],
  APAC: ['APAC 11-100', 'Social APAC'],
};
for (const [region, left] of Object.entries(passQuota)) {
  if (left <= 0) continue;
  const candidates = await search(noDeals([...poolFilters.filter((f) => f.propertyName !== PROPS.sdrTeam), { propertyName: PROPS.sdrTeam, operator: 'IN', values: regionTeams[region]! }]));
  for (const c of candidates) {
    if (passQuota[region]! <= 0) break;
    await tryAdd(c.id, 'pass-control', (sn) => finalStatus(sn.diagnosis) === 'PASS' && sn.score >= 1, (sn) => `Healthy control (${region}): active lead, owned, routed, in its board list. Any BLOCKED here is a false positive.`).then((ok) => {
      if (ok) passQuota[region]!--;
    });
  }
}

// ---- 4. exact-email duplicates ----------------------------------------------------------------------
// Every diagnosed contact already ran the duplicate check; HubSpot enforces unique primary emails, so none are expected.
const dupHits = added.filter((c) => (c as any).expected?.duplicateIds?.length);
console.log(`Exact-email duplicates among ${used.size} diagnosed contacts: ${dupHits.length}`);

// ---- write -------------------------------------------------------------------------------------------
const all = [...existing, ...added];
console.log(`\nAdded ${added.length}: ${JSON.stringify(tally)}; total ${all.length}`);
if (WRITE) {
  const out = {
    note: 'Snapshot of engine verdicts on real historical contacts. HubSpot data is live, so re-baseline (scripts/build-benchmark.ts) when contacts legitimately change. status is BLOCKED | WARN | PASS; mode is the verdict step (null for PASS); PASS controls must never be blocked.',
    createdAt: bench.createdAt,
    updatedAt: new Date().toISOString(),
    cases: all,
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/golden-benchmark.json');
} else {
  console.log('Dry run. Re-run with --write to save.');
}
