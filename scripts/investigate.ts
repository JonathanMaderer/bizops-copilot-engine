import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fetchLead, loadStageMeta, type LeadResult } from '../src/engine/hubspot.ts';
import { buildDossier, extractContactId, type Dossier } from '../src/engine/dossier.ts';
import { diagnoseContact, type Diagnosis } from '../src/engine/investigator.ts';
import { scoreDiagnosis } from '../src/engine/confidence.ts';
import { generateCopilotAnalysis, type CopilotResponse } from '../src/ai/copilot.ts';

let stageMeta: Awaited<ReturnType<typeof loadStageMeta>> | undefined;
const LOG_PATH = path.resolve('data/manual-investigation-log.json');



const v = (x: unknown) => (x === null || x === undefined || x === '' ? '-' : String(x));
const rule = (t: string) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);

function printDossier(d: Dossier) {
  console.log(`\n######## Lead Evidence Dossier: contact ${d.contactId} ########`);
  rule('Identity & Team');
  console.log(`Name: ${v(d.identity.name)}   Email: ${v(d.identity.email)}`);
  console.log(`SDR Owner: ${v(d.identity.sdrOwner)}   Team: ${v(d.identity.team)}`);
  console.log(`Company Size: ${v(d.identity.companySizeRange)}   Lead Source: ${v(d.identity.leadSource)}`);
  rule('Associated Deals');
  if (!d.deals.length) console.log('(none)');
  for (const x of d.deals) {
    console.log(`#${x.id}  ${v(x.name)}  | pipeline ${v(x.pipeline)} | stage ${v(x.stageId)} | ${x.closed ? 'CLOSED' : 'ACTIVE'}`);
  }
  rule('Brain & Activity');
  const b = d.brain;
  console.log(`Cycle: ${v(b.cycleStart)} -> ${v(b.cycleEnd)}   Outcome: ${v(b.cycleOutcome)}`);
  console.log(`AI First Replied At: ${v(b.aiFirstRepliedAt)}`);
  console.log(`Classification: ${v(b.classification)} / ${v(b.subClassification)}   sl_stage: ${v(b.slStage)}`);
  console.log(`Meeting Type: ${v(b.meetingType)}`);
  rule('Queue Position');
  console.log(`Position: ${d.queue.summary}`);
  for (const h of d.queue.hits) console.log(`  list ${h.listId}: ${h.labels.join('; ')}`);
  console.log(`Total list memberships: ${d.queue.allListIds.length} (full list saved in the log)`);
}

function printVerdict(diag: Diagnosis, conf: ReturnType<typeof scoreDiagnosis>) {
  rule('Engine Diagnosis');
  for (const s of diag.steps) console.log(`[${s.status}] ${s.step}. ${s.title}: ${s.detail}`);
  const rem = (diag.blockedAt ?? [...diag.steps].reverse().find((s) => s.remediation))?.remediation;
  console.log(`\nVerdict:    ${diag.conclusion}`);
  console.log(`Confidence: ${conf.score.toFixed(1)} (${conf.band})`);
  for (const r of conf.reasons) console.log(`  - ${r}`);
  console.log(`Remediation: ${rem ?? 'none required'}`);
}

// ---- input / logging -------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = rl[Symbol.asyncIterator]();
async function ask(q: string): Promise<string | null> {
  process.stdout.write(q);
  const r = await lines.next();
  return r.done ? null : String(r.value).trim();
}

function appendLog(entry: unknown) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  let arr: unknown[] = [];
  try {
    arr = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    /* new log */
  }
  arr.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(arr, null, 2));
}

const AI = process.argv.includes('--ai');

function printCopilot(c: CopilotResponse) {
  rule(`AI Copilot (${c.source === 'llm' ? `LLM: ${c.model}` : 'grounded template'})`);
  if (c.note) console.log(`Note: ${c.note}`);
  console.log('\n-- SDR Rep View --');
  console.log(c.sdrView.summary);
  console.log(`Why it's not visible: ${c.sdrView.reason}`);
  console.log(`Next step: ${c.sdrView.nextStep}`);
  if (c.sdrView.slackMessage) console.log(`\nSlack message (copy-paste):\n> ${c.sdrView.slackMessage.replace(/\n/g, '\n> ')}`);
  console.log('\n-- RevOps Admin View --');
  console.log(`Root cause: ${c.adminView.rootCauseCategory}   (${c.adminView.step})`);
  console.log('Property diff:');
  if (!c.adminView.propertyDiffs.length) console.log('  (none)');
  for (const d of c.adminView.propertyDiffs) console.log(`  ${d}`);
  console.log(`Remediation: ${c.adminView.remediation}`);
}

async function investigate(contactId: string) {
  let lead: LeadResult;
  try {
    lead = await fetchLead(contactId);
  } catch (e) {
    console.error(`Failed to fetch contact ${contactId}: ${(e as Error).message}`);
    return;
  }
  const diag = await diagnoseContact(lead);
  stageMeta ??= await loadStageMeta().catch(() => undefined);
  const conf = scoreDiagnosis(lead, diag, stageMeta);
  const dossier = 'notFound' in lead ? { contactId, notFound: true } : await buildDossier(lead);
  if ('notFound' in lead) console.log(`\nContact ${contactId}: not found in HubSpot.`);
  else printDossier(dossier as Dossier);
  printVerdict(diag, conf);
  if (AI) printCopilot(await generateCopilotAnalysis(dossier as never, { diagnosis: diag, confidence: conf }));

  const ans = (await ask('\nDo you agree with this diagnosis? (y/n/skip): '))?.toLowerCase();
  if (!ans || ans === 'skip' || ans === 's') return;
  if (ans !== 'y' && ans !== 'n') {
    console.log('Unrecognized answer; skipping.');
    return;
  }
  let notes = '';
  let userVerdict = 'agree';
  if (ans === 'n') {
    userVerdict = 'disagree';
    notes = (await ask('What should have happened and why? ')) ?? '';
  }
  appendLog({
    timestamp: new Date().toISOString(),
    contactId,
    dossier,
    engineVerdict: { conclusion: diag.conclusion, blockedAt: diag.blockedAt ?? null, steps: diag.steps, confidence: conf },
    userVerdict,
    notes,
  });
  console.log(`Saved to ${path.relative(process.cwd(), LOG_PATH)}`);
}

const USAGE = 'Usage: npx tsx scripts/investigate.ts <contactIdOrUrl> [--ai]';

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (arg) {
    // Prefers the ID inside a HubSpot URL (record/0-1/<id>); the portal ID in the URL is never used.
    const id = extractContactId(arg);
    if (!id) {
      console.error(`Could not find a contact ID in "${arg}".\n${USAGE}`);
      process.exit(1);
    }
    await investigate(id);
    rl.close();
    return;
  }
  console.log(`${USAGE}\n(No argument given: entering interactive mode.)`);
  for (;;) {
    const input = await ask('\nContact ID or HubSpot URL (blank/q to quit): ');
    if (!input || input.toLowerCase() === 'q') break;
    const id = extractContactId(input);
    if (!id) {
      console.log('No contact ID found in that input.');
      continue;
    }
    await investigate(id);
  }
  rl.close();
}

await main();
