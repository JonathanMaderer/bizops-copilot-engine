import fs from 'node:fs';
import path from 'node:path';

interface RawTicket {
  ticket_id: string;
  created_at?: string;
  reporter?: string;
  title?: string;
  description?: string;
  status?: string;
  resolution_notes?: string;
}

export interface ExtractedTicketRef {
  ticketId: string;
  title: string;
  status: string;
  reporter: string;
  createdAt: string;
  source: 'url' | 'raw';
}

export interface ExtractedEntry {
  contactId: string;
  /** 'url' when at least one ticket links the contact via a HubSpot URL; otherwise 'raw' (numeric guess). */
  confidence: 'url' | 'raw';
  categories: string[];
  tickets: ExtractedTicketRef[];
}

const RAW_PATH = path.resolve('data/sdr-tickets-raw.json');
const OUT_PATH = path.resolve('data/extracted-tickets.json');

const URL_RE = /(?:record\/0-1\/|contacts?\/(?:\d+\/)?(?:record\/0-1\/)?)(\d{6,14})/g;
const OTHER_OBJECT_URL_RE = /record\/0-(?:2|3|\d+)\/\d+/g; // company / deal / other objects
const RAW_RE = /(?<![\d+\-./])(\d{9,12})(?![\d])/g;

function extractIds(text: string): { url: Set<string>; raw: Set<string> } {
  const url = new Set<string>();
  for (const m of text.matchAll(/record\/0-1\/(\d+)/g)) url.add(m[1]!);
  for (const m of text.matchAll(/hubspot\.com\/contacts\/\d+\/contact\/(\d+)/g)) url.add(m[1]!);
  // Strip URLs (all kinds) before scanning raw digits so portal/deal/company IDs aren't picked up.
  const stripped = text.replace(/https?:\/\/\S+/g, ' ').replace(OTHER_OBJECT_URL_RE, ' ');
  const raw = new Set<string>();
  for (const m of stripped.matchAll(RAW_RE)) if (!url.has(m[1]!)) raw.add(m[1]!);
  return { url, raw };
}
void URL_RE;

const CATEGORIES: [string, RegExp][] = [
  ['Lead missing from board/dashboard', /(missing|not (showing|appear|visible)|disappear|can'?t see|don'?t see|not in my|did not appear)/i],
  ['No-show / meeting handling', /(no[\s-]?show|cancel|reschedul|meeting (booked|type)|demo)/i],
  ['Wrong / missing SDR owner or team', /(wrong (sdr|owner|team)|owner|not assigned|unassigned|reassign|assign)/i],
  ['Routing / team / region', /(rout|region|team|country|time ?zone|queue|incoming)/i],
  ['Deal / pipeline issue', /(deal|pipeline|closed (won|lost)|stage)/i],
  ['Task / cadence / sequence', /(task|cadence|sequence|salesloft|due today)/i],
  ['Qualification / unqualified', /(unqualif|disqualif|qualif|size|employees)/i],
];

function categorize(t: RawTicket): string {
  const text = `${t.title ?? ''} ${t.description ?? ''}`;
  for (const [name, re] of CATEGORIES) if (re.test(text)) return name;
  return 'Other';
}

function main() {
  const tickets: RawTicket[] = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
  const byContact = new Map<string, ExtractedEntry>();
  let withIds = 0;
  const statusCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  for (const t of tickets) {
    const text = [t.title, t.description, t.resolution_notes].filter(Boolean).join('\n');
    const ids = extractIds(text);
    const ticketId = String(t.ticket_id);
    ids.raw.delete(ticketId); // never treat the ticket's own id as a contact
    if (!ids.url.size && !ids.raw.size) continue;
    withIds++;
    const cat = categorize(t);
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    statusCounts.set(t.status ?? '-', (statusCounts.get(t.status ?? '-') ?? 0) + 1);

    const add = (id: string, source: 'url' | 'raw') => {
      const e =
        byContact.get(id) ??
        byContact.set(id, { contactId: id, confidence: source, categories: [], tickets: [] }).get(id)!;
      if (source === 'url') e.confidence = 'url';
      if (!e.categories.includes(cat)) e.categories.push(cat);
      if (!e.tickets.some((x) => x.ticketId === ticketId)) {
        e.tickets.push({
          ticketId,
          title: t.title ?? '',
          status: t.status ?? '',
          reporter: t.reporter ?? '',
          createdAt: t.created_at ?? '',
          source,
        });
      }
    };
    ids.url.forEach((id) => add(id, 'url'));
    ids.raw.forEach((id) => add(id, 'raw'));
  }

  const entries = [...byContact.values()].sort(
    (a, b) => Number(b.confidence === 'url') - Number(a.confidence === 'url') || b.tickets.length - a.tickets.length,
  );
  fs.writeFileSync(OUT_PATH, JSON.stringify(entries, null, 2));

  const urlCount = entries.filter((e) => e.confidence === 'url').length;
  const top = (m: Map<string, number>, n = 5) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `  ${String(c).padStart(4)}  ${k}`);

  console.log('Claw ticket ingestion');
  console.log(`  Tickets scanned:              ${tickets.length}`);
  console.log(`  Tickets with contact IDs:     ${withIds}`);
  console.log(`  Unique contact IDs:           ${entries.length}`);
  console.log(`    from HubSpot URLs:          ${urlCount}`);
  console.log(`    from raw numbers (guesses): ${entries.length - urlCount}`);
  console.log('\nTop issue summaries (tickets with contact IDs):');
  console.log(top(categoryCounts).join('\n'));
  console.log('\nTop ticket statuses:');
  console.log(top(statusCounts).join('\n'));
  console.log(`\nSaved ${entries.length} entries to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main();
