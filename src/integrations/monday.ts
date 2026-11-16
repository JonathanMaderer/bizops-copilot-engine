/** Monday.com GraphQL helpers for the shadow-pilot webhook. */

const MONDAY_API = 'https://api.monday.com/v2';

export class MondayConfigError extends Error {}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new MondayConfigError('MONDAY_API_TOKEN is not set.');
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[]; error_message?: string };
  if (!res.ok || j.errors?.length || j.error_message) {
    throw new Error(`Monday API ${res.status}: ${j.errors?.map((e) => e.message).join('; ') ?? j.error_message ?? 'request failed'}`);
  }
  return j.data as T;
}

export interface MondayItem {
  id: string;
  name: string;
  columns: { id: string; title: string; text: string | null; value: string | null }[];
}

export async function getItem(itemId: string): Promise<MondayItem | null> {
  const data = await gql<{ items: { id: string; name: string; column_values: { id: string; text: string | null; value: string | null; column: { title: string } | null }[] }[] }>(
    'query ($ids: [ID!]) { items(ids: $ids) { id name column_values { id text value column { title } } } }',
    { ids: [itemId] },
  );
  const it = data.items?.[0];
  if (!it) return null;
  return { id: String(it.id), name: it.name, columns: it.column_values.map((c) => ({ id: c.id, title: c.column?.title ?? c.id, text: c.text, value: c.value })) };
}

export async function createUpdate(itemId: string, body: string): Promise<string> {
  const data = await gql<{ create_update: { id: string } }>('mutation ($id: ID!, $body: String!) { create_update(item_id: $id, body: $body) { id } }', { id: itemId, body });
  return data.create_update.id;
}

const URL_RE = /hubspot\.com\/\S*?(?:record\/0-1\/|contacts?\/\d+\/contact\/|contact\/)(\d{3,})/i;

/**
 * Finds a HubSpot contact on the item. Order: any HubSpot contact URL; then a bare 6+ digit number in a column
 * whose title mentions HubSpot/contact; then the item name. Other numbers (phones, dates) are ignored.
 */
export function extractContactId(item: MondayItem): string | null {
  const texts = [item.name, ...item.columns.flatMap((c) => [c.text ?? '', c.value ?? ''])];
  for (const t of texts) {
    const m = t.match(URL_RE);
    if (m) return m[1]!;
  }
  for (const c of item.columns) {
    if (!/hubspot|contact/i.test(`${c.title} ${c.id}`)) continue;
    const m = (c.text ?? '').trim().match(/^(\d{6,})$/);
    if (m) return m[1]!;
  }
  const n = item.name.match(/\b(?:contact|hs|hubspot)\s*(?:id)?\s*[:#]?\s*(\d{6,})\b/i);
  return n ? n[1]! : null;
}
