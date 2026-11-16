import { LIST_IDS, PROPS } from '../config/schema.ts';
import { getContactPropertiesByName, getOwnerName, type DuplicateContact, type LeadData, type PropertyHistory } from './hubspot.ts';

/** Accepts a numeric ID or any HubSpot URL containing one (…/contact/123, …/record/0-1/123). */
export function extractContactId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/(?:contact\/|record\/0-1\/|objectId=)(\d+)/) ?? s.match(/(\d{3,})/);
  return m ? m[1]! : null;
}

// ---- list labels: id -> human-readable queue names -------------------------------------------
const listLabels = new Map<string, Set<string>>();
const addLabel = (id: unknown, label: string) => {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return;
  (listLabels.get(id) ?? listLabels.set(id, new Set()).get(id)!).add(label);
};
const KEY_LABELS: Record<string, string> = {
  openPipe: 'Open Pipe',
  pendingDemos: 'Pending Demos',
  noShows: 'No-Shows',
  incoming: 'Incoming',
  primary: 'Primary',
  secondary: 'Secondary',
  multiThread: 'Multi-Thread 201+',
};
for (const [team, lists] of Object.entries(LIST_IDS.teams as Record<string, Record<string, string>>)) {
  for (const [k, id] of Object.entries(lists)) addLabel(id, `${KEY_LABELS[k] ?? k} [${team}]`);
}
for (const [k, id] of Object.entries(LIST_IDS.shared)) addLabel(id, `${KEY_LABELS[k] ?? k} [shared]`);
addLabel(LIST_IDS.tables.PENDING_DEMOS, 'Pending Demos');
addLabel(LIST_IDS.tables.NO_SHOWS, 'No-Shows');
addLabel(LIST_IDS.tables.MULTI_THREAD_201_PLUS, 'Multi-Thread 201+');

function queuePosition(listIds: string[]) {
  const hits = listIds
    .filter((id) => listLabels.has(id))
    .map((id) => ({ listId: id, labels: [...listLabels.get(id)!] }));
  const kinds = new Set<string>();
  for (const h of hits) {
    for (const l of h.labels) {
      if (l.startsWith('Open Pipe')) kinds.add('Open Pipe');
      else if (l.startsWith('Pending Demos')) kinds.add('Pending Demos');
      else if (l.startsWith('No-Shows')) kinds.add('No-Shows');
    }
  }
  return { summary: kinds.size ? [...kinds].join(' + ') : 'None', hits, allListIds: listIds };
}

// ---- dossier ---------------------------------------------------------------------------------
export async function buildDossier(lead: LeadData) {
  const id = lead.resolvedId ?? lead.contactId;
  const p = lead.properties;
  const ident = await getContactPropertiesByName(id, ['firstname', 'lastname', 'email']);
  const ownerId = p[PROPS.sdrOwner] || p[PROPS.xdrManager] || null;
  const ownerName = ownerId ? await getOwnerName(String(ownerId)) : null;
  const history = (lead.propertyHistory ?? {}) as PropertyHistory;
  const historyOwnerIds = [
    ...new Set(Object.entries(history).filter(([k]) => /owner|manager/.test(k)).flatMap(([, v]) => v.map((c) => c.value)).filter((v) => /^\d+$/.test(v))),
  ].slice(0, 15);
  const ownerNames: Record<string, string> = {};
  await Promise.all(
    historyOwnerIds.map(async (id) => {
      const n = await getOwnerName(id);
      if (n && !n.includes('@')) ownerNames[id] = n;
    }),
  );
  return {
    contactId: lead.contactId,
    identity: {
      name: [ident.firstname, ident.lastname].filter(Boolean).join(' ') || null,
      email: ident.email ?? null,
      sdrOwner: ownerId ? `${ownerName ?? 'unknown'} (${ownerId})` : null,
      team: p[PROPS.sdrTeam] ?? null,
      companySizeRange: p[PROPS.numEmployeesRange] ?? null,
      leadSource: p[PROPS.sdrLeadSource] ?? null,
    },
    deals: lead.deals.map((d) => ({
      id: d.id,
      name: d.dealname,
      pipeline: d.pipeline,
      stageId: d.dealstage,
      closed: !d.active,
    })),
    brain: {
      cycleStart: p[PROPS.cycleStart] ?? null,
      cycleEnd: p[PROPS.cycleEnd] ?? null,
      cycleOutcome: p[PROPS.cycleOutcome] ?? null,
      aiFirstRepliedAt: p[PROPS.firstRepliedAt] ?? null,
      classification: p[PROPS.classification] ?? null,
      subClassification: p[PROPS.subClassification] ?? null,
      slStage: p[PROPS.slStage] ?? null,
      meetingType: p[PROPS.meetingType] ?? null,
    },
    queue: queuePosition(lead.listIds),
    /** Chronological change history for routing/ownership properties (empty when HubSpot returned none). */
    propertyHistory: history,
    ownerNames,
    /** Filled by diagnoseLead from the engine's exact-email duplicate check. */
    duplicates: [] as DuplicateContact[],
  };
}
export type Dossier = Awaited<ReturnType<typeof buildDossier>>;
