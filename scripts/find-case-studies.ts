import dotenv from 'dotenv';
import { PROPS, CLOSED_DEAL_STAGES } from '../src/config/schema.ts';
import { fetchLead } from '../src/engine/hubspot.ts';
import { diagnoseContact, type Diagnosis } from '../src/engine/investigator.ts';

dotenv.config({ path: '.env.local', quiet: true });

const BASE = 'https://api.hubapi.com';
const CANDIDATES = 15;

type Filter = { propertyName: string; operator: string; value?: string; values?: string[] };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function searchContacts(filters: Filter[], orExtra: Filter[][] = []): Promise<string[]> {
  const r = await post<{ results: { id: string }[] }>('/crm/v3/objects/contacts/search', {
    filterGroups: (orExtra.length ? orExtra.map((x) => [...filters, ...x]) : [filters]).map((f) => ({ filters: f })),
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
    properties: ['email'],
    limit: CANDIDATES,
  });
  return r.results.map((c) => c.id);
}

async function activeDealContacts(): Promise<string[]> {
  const deals = await post<{ results: { id: string }[] }>('/crm/v3/objects/deals/search', {
    filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'NOT_IN', values: [...CLOSED_DEAL_STAGES] }] }],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit: CANDIDATES,
  });
  if (!deals.results.length) return [];
  const assoc = await post<{ results: { to: { toObjectId: number }[] }[] }>(
    '/crm/v4/associations/deals/contacts/batch/read',
    { inputs: deals.results.map((d) => ({ id: d.id })) },
  );
  return [...new Set(assoc.results.flatMap((r) => r.to.map((t) => String(t.toObjectId))))];
}

interface Scenario {
  name: string;
  expected: string;
  find: () => Promise<string[]>;
  matches: (d: Diagnosis) => boolean;
}

const has = (p: string): Filter => ({ propertyName: p, operator: 'HAS_PROPERTY' });
const not = (p: string): Filter => ({ propertyName: p, operator: 'NOT_HAS_PROPERTY' });

const scenarios: Scenario[] = [
  {
    name: 'A: Healthy Lead',
    expected: 'Passes steps 1-5; reaches Step 6',
    find: () =>
      searchContacts([
        has(PROPS.cycleStart),
        not(PROPS.cycleEnd),
        has(PROPS.sdrTeam),
        { propertyName: PROPS.numEmployeesRange, operator: 'NEQ', value: '1-10' },
      ]),
    matches: (d) => !d.blockedAt,
  },
  {
    name: 'B: Deal Lock',
    expected: 'BLOCKED @ Step 1',
    find: activeDealContacts,
    matches: (d) => d.blockedAt?.step === 1,
  },
  {
    name: 'C: Cycle Ended',
    expected: 'BLOCKED @ Step 2',
    find: () => searchContacts([has(PROPS.cycleEnd)]),
    matches: (d) => d.blockedAt?.step === 2,
  },
  {
    name: 'D1: Standard Size Block (1-10)',
    expected: 'BLOCKED @ Step 4',
    find: () =>
      searchContacts(
        [
          has(PROPS.cycleStart),
          not(PROPS.cycleEnd),
          not(PROPS.firstRepliedAt),
          has(PROPS.sdrOwner),
          { propertyName: PROPS.numEmployeesRange, operator: 'EQ', value: '1-10' },
        ],
        // Lead source is NOT 'False SBP' (or empty), so the size override can't apply.
        [
          [{ propertyName: PROPS.sdrLeadSource, operator: 'NEQ', value: 'False SBP' }],
          [not(PROPS.sdrLeadSource)],
        ],
      ),
    matches: (d) => d.blockedAt?.step === 4,
  },
  {
    name: 'D2: False SBP Override (1-10 allowed)',
    expected: 'PASS Step 4 (reaches Step 6)',
    find: () =>
      searchContacts([
        has(PROPS.cycleStart),
        { propertyName: PROPS.numEmployeesRange, operator: 'EQ', value: '1-10' },
        { propertyName: PROPS.sdrLeadSource, operator: 'EQ', value: 'False SBP' },
      ]),
    matches: (d) => d.steps.find((s) => s.step === 4)?.status === 'PASS',
  },
  {
    name: 'F: AI Handover',
    expected: 'BLOCKED @ Step 3 (outbound cadences paused for AE follow-up)',
    find: () => searchContacts([has(PROPS.firstRepliedAt), has(PROPS.cycleStart), not(PROPS.cycleEnd), has(PROPS.sdrOwner)]),
    matches: (d) => d.blockedAt?.step === 3,
  },
  {
    name: 'G: Approved Meeting',
    expected: 'PASS Step 5 if approved (-> Step 6); BLOCKED @ Step 5 + remediation if unapproved',
    find: () =>
      searchContacts(
        [has(PROPS.meetingType), has(PROPS.cycleStart), not(PROPS.cycleEnd), not(PROPS.firstRepliedAt)],
        [[{ propertyName: 'num_associated_deals', operator: 'EQ', value: '0' }], [not('num_associated_deals')]],
      ),
    matches: (d) => {
      const s5 = d.steps.find((s) => s.step === 5);
      if (!s5 || !s5.detail.includes('meeting_type_cp__c')) return false;
      return s5.status === 'PASS' || (s5.status === 'BLOCKED' && !!s5.remediation);
    },
  },
  {
    name: 'H: Owner Gate (no SDR owner)',
    expected: 'BLOCKED @ Step 1.5 (Owner Gate: Unassigned SDR)',
    find: () =>
      searchContacts(
        [not(PROPS.sdrOwner), has(PROPS.cycleStart), not(PROPS.cycleEnd)],
        [[{ propertyName: 'num_associated_deals', operator: 'EQ', value: '0' }], [not('num_associated_deals')]],
      ),
    matches: (d) => d.blockedAt?.step === 1.5,
  },
  {
    name: 'I: Not Found Guard (404)',
    expected: 'BLOCKED @ Step 0 (Contact Not Found)',
    find: async () => ['999999999999999'],
    matches: (d) => d.blockedAt?.step === 0 && d.blockedAt.title === 'Contact Not Found',
  },
  {
    name: 'E: Hygiene Error',
    expected: 'BLOCKED @ Step 4',
    find: () =>
      searchContacts(
        [has(PROPS.unqualifiedReasonText), not(PROPS.newUnqualifiedReason)],
        // No associated deals (property is either 0 or never set), so Step 1 can't intercept.
        [[{ propertyName: 'num_associated_deals', operator: 'EQ', value: '0' }], [not('num_associated_deals')]],
      ),
    matches: (d) => d.blockedAt?.step === 4,
  },
];

const verdict = (d: Diagnosis) => (d.blockedAt ? `BLOCKED @ Step ${d.blockedAt.step}` : 'No block (reached Step 6)');
const rootCause = (d: Diagnosis) => {
  if (d.blockedAt) {
    return `${d.blockedAt.title}: ${d.blockedAt.detail}${d.blockedAt.remediation ? ` -> ${d.blockedAt.remediation}` : ''}`;
  }
  const s6 = d.steps.find((s) => s.step === 6);
  if (s6?.remediation) {
    return `Passed Steps 1-5; stopped at Step 6 only because it is unrouted. ${s6.detail} Fix: ${s6.remediation}`;
  }
  return d.conclusion;
};

if (!process.env.HUBSPOT_ACCESS_TOKEN) {
  console.error('Missing HUBSPOT_ACCESS_TOKEN in .env.local');
  process.exit(1);
}

const used = new Set<string>();
const rows: string[][] = [];
const discovered: string[] = [];

for (const sc of scenarios) {
  try {
    const candidates = (await sc.find()).filter((id) => !used.has(id));
    if (!candidates.length) {
      rows.push([sc.name, '-', sc.expected, 'NOT FOUND', 'No contact matched the search criteria.']);
      continue;
    }
    // Prefer the first candidate whose verdict matches the scenario's expectation.
    let chosen: { id: string; d: Diagnosis } | undefined;
    let first: { id: string; d: Diagnosis } | undefined;
    for (const id of candidates) {
      const d = await diagnoseContact(await fetchLead(id));
      first ??= { id, d };
      if (sc.matches(d)) {
        chosen = { id, d };
        break;
      }
    }
    const pick = chosen ?? first!;
    used.add(pick.id);
    discovered.push(pick.id);
    rows.push([
      sc.name,
      pick.id,
      `${sc.expected} -> ${chosen ? 'MATCH' : 'MISMATCH'}: ${verdict(pick.d)}`,
      '',
      rootCause(pick.d),
    ]);
  } catch (e) {
    rows.push([sc.name, '-', sc.expected, 'ERROR', (e as Error).message.slice(0, 140)]);
  }
}

const headers = ['Scenario', 'Contact ID', 'Expected vs Actual', 'Root Cause Summary'];
const table = rows.map((r) => [r[0]!, r[1]!, r[3] ? `${r[2]} -> ${r[3]}` : r[2]!, r[4]!]);
const widths = headers.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
console.log(fmt(headers));
console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
for (const r of table) console.log(fmt(r));

// Raw team values for pinned contacts (Step 6 team-mapping investigation).
console.log('\nRaw sdr__sdr_team_ for pinned contacts:');
for (const id of ['261437842253', '261433693727']) {
  const lead = await fetchLead(id);
  const t = 'notFound' in lead ? null : lead.properties[PROPS.sdrTeam];
  console.log(`  ${id}: ${t === null || t === undefined || t === '' ? '(blank)' : JSON.stringify(t)}`);
}
console.log(`\nRe-run in batch: npx tsx scripts/test-batch.ts ${discovered.join(' ')}`);
