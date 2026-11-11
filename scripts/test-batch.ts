import { fetchLead } from '../src/engine/hubspot.ts';
import { diagnoseContact } from '../src/engine/investigator.ts';

const FALLBACK_IDS: string[] = ['1', '2', '3']; // TODO: replace with real sample contact IDs

const ids = process.argv.slice(2).length ? process.argv.slice(2) : FALLBACK_IDS;
const sym = { PASS: 'PASS', BLOCKED: 'BLOCKED', WARN: 'WARN' } as const;

const headers = ['Contact ID', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6', 'Final Status', 'Summary'];
const rows: string[][] = [];

for (const id of ids) {
  try {
    const result = await diagnoseContact(await fetchLead(id));
    const cells = [1, 2, 3, 4, 5, 6].map((n) => {
      const s = result.steps.find((x) => x.step === n);
      return s ? sym[s.status] : '-';
    });
    const final = result.blockedAt
      ? `BLOCKED@${result.blockedAt.step}`
      : result.steps.some((s) => s.status === 'WARN')
        ? 'WARN'
        : 'OK';
    rows.push([id, ...cells, final, result.conclusion]);
  } catch (e) {
    rows.push([id, '-', '-', '-', '-', '-', '-', 'ERROR', (e as Error).message.slice(0, 120)]);
  }
}

const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
console.log(fmt(headers));
console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
for (const r of rows) console.log(fmt(r));
