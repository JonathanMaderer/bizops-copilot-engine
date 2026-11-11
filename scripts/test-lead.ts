import { fetchLead } from '../src/engine/hubspot.ts';
import { diagnoseContact } from '../src/engine/investigator.ts';

const contactId = process.argv[2];
if (!contactId) {
  console.error('Usage: npx tsx scripts/test-lead.ts <contactId>');
  process.exit(1);
}

const icon = { PASS: 'PASS', BLOCKED: 'BLOCKED', WARN: 'WARN' } as const;

const lead = await fetchLead(contactId);
const result = await diagnoseContact(lead);

console.log(`Contact ${contactId}`);
for (const s of result.steps) console.log(`[${icon[s.status]}] ${s.step}. ${s.title}: ${s.detail}`);
console.log(`\nConclusion: ${result.conclusion}`);
