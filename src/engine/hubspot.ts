import dotenv from 'dotenv';
import { CONTACT_PROPERTIES, CLOSED_DEAL_STAGES } from '../config/schema.ts';

dotenv.config({ path: '.env.local' });

const BASE = 'https://api.hubapi.com';

async function hs<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('Missing HUBSPOT_ACCESS_TOKEN in .env.local');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new HubSpotError(res.status, `HubSpot ${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

export class HubSpotError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ContactGuard {
  status: 'BLOCKED' | 'WARN';
  title: string;
  detail: string;
}

export type ContactProps = Record<string, string | null | undefined>;

export interface Deal {
  id: string;
  dealstage: string | null;
  dealname: string | null;
  pipeline: string | null;
  active: boolean;
}

export interface LeadData {
  contactId: string;
  properties: ContactProps;
  deals: Deal[];
  activeDeals: Deal[];
  listIds: string[];
  /** Resolved contact ID (differs from contactId when the requested ID was merged). */
  resolvedId?: string;
  /** Set when the contact is deleted (BLOCKED) or was merged into another (WARN). */
  guard?: ContactGuard;
}

export async function getContact(
  contactId: string,
  properties: string[] = CONTACT_PROPERTIES,
): Promise<{ id: string; properties: ContactProps }> {
  const qs = new URLSearchParams({ properties: properties.join(',') });
  return hs<{ id: string; properties: ContactProps }>(`/crm/v3/objects/contacts/${contactId}?${qs}`);
}

export async function getContactPropertiesByName(contactId: string, names: string[]): Promise<ContactProps> {
  return (await getContact(contactId, names)).properties;
}

export interface ListDefinition {
  listId: string;
  name: string;
  processingType?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filterBranch?: any;
}

/** GET /crm/v3/lists/{listId}: returns the list's filterBranch criteria (active/dynamic lists). */
export async function fetchListDefinition(listId: string): Promise<ListDefinition> {
  const r = await hs<{ list: ListDefinition }>(`/crm/v3/lists/${listId}?includeFilters=true`);
  return { ...r.list, listId: String(r.list.listId) };
}

export async function getContactProperties(contactId: string): Promise<ContactProps> {
  return (await getContact(contactId)).properties;
}

export async function getContactDeals(contactId: string): Promise<Deal[]> {
  const assoc = await hs<{ results: { toObjectId: number | string }[] }>(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`,
  );
  const ids = assoc.results.map((r) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs<{ results: { id: string; properties: Record<string, string | null> }[] }>(
    '/crm/v3/objects/deals/batch/read',
    {
      method: 'POST',
      body: JSON.stringify({ properties: ['dealstage', 'dealname', 'pipeline'], inputs: ids.map((id) => ({ id })) }),
    },
  );
  return batch.results.map((d) => {
    const stage = d.properties.dealstage ?? null;
    return {
      id: d.id,
      dealstage: stage,
      dealname: d.properties.dealname ?? null,
      pipeline: d.properties.pipeline ?? null,
      active: !CLOSED_DEAL_STAGES.has((stage ?? '').toLowerCase()),
    };
  });
}

/** Stage id -> { label, isClosed } across all deal pipelines. */
export async function loadStageMeta(): Promise<Map<string, { label: string; isClosed: boolean }>> {
  const r = await hs<{ results: { stages: { id: string; label: string; metadata?: { isClosed?: string } }[] }[] }>(
    '/crm/v3/pipelines/deals',
  );
  const m = new Map<string, { label: string; isClosed: boolean }>();
  for (const pl of r.results) {
    for (const st of pl.stages) m.set(st.id, { label: st.label, isClosed: st.metadata?.isClosed === 'true' });
  }
  return m;
}

/** Resolves a HubSpot owner id to a display name (null if unavailable). */
export async function getOwnerName(ownerId: string): Promise<string | null> {
  try {
    const o = await hs<{ firstName?: string; lastName?: string; email?: string }>(`/crm/v3/owners/${ownerId}`);
    return [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || null;
  } catch {
    return null;
  }
}

export async function getContactListIds(contactId: string): Promise<string[]> {
  type Page = {
    results?: { listId: string | number }[];
    lists?: { listId: string | number }[];
    paging?: { next?: { after?: string } };
  };
  const ids = new Set<string>();
  let after: string | undefined;
  do {
    const qs = new URLSearchParams({ limit: '250' });
    if (after) qs.set('after', after);
    const r = await hs<Page>(`/crm/v3/lists/records/0-1/${contactId}/memberships?${qs}`);
    for (const l of r.results ?? r.lists ?? []) ids.add(String(l.listId));
    after = r.paging?.next?.after;
  } while (after);
  return [...ids];
}

export interface NotFound {
  notFound: true;
  contactId: string;
}
export type LeadResult = LeadData | NotFound;

export async function fetchLead(contactId: string): Promise<LeadResult> {
  let contact: { id: string; properties: ContactProps };
  try {
    contact = await getContact(contactId);
  } catch (e) {
    if (e instanceof HubSpotError && e.status === 404) {
      return { notFound: true, contactId };
    }
    throw e;
  }
  const resolvedId = String(contact.id);
  const merged = resolvedId !== String(contactId);
  const [deals, listIds] = await Promise.all([getContactDeals(resolvedId), getContactListIds(resolvedId)]);
  const lead: LeadData = {
    contactId,
    resolvedId,
    properties: contact.properties,
    deals,
    activeDeals: deals.filter((d) => d.active),
    listIds,
  };
  if (merged) {
    lead.guard = {
      status: 'WARN',
      title: 'Contact Merged',
      detail: `Contact ${contactId} was merged; primary contact ID is ${resolvedId}. Diagnosing the primary record.`,
    };
  }
  return lead;
}
