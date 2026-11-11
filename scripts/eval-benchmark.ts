import { readFileSync } from 'node:fs';
import { fetchLead, loadStageMeta } from '../src/engine/hubspot.ts';
import { diagnoseContact, type Diagnosis } from '../src/engine/investigator.ts';
import { scoreDiagnosis } from '../src/engine/confidence.ts';

interface Case {
  contactId: string;
  expected: {
    mode?: string;
    status: string;
    title?: string;
    minConfidence?: number;
    stepStatuses?: Record<string, string>;
  };
}

const PASS_THRESHOLD = 95;

// ---- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = argVal('--limit') ? Number(argVal('--limit')) : undefined;
const onlyId = argVal('--id');

const file = new URL('../data/golden-benchmark.json', import.meta.url);
let cases = (JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] }).cases;
if (onlyId) cases = cases.filter((c) => c.contactId === onlyId);
if (limit && limit > 0) cases = cases.slice(0, limit);
if (!cases.length) {
  console.error(onlyId ? `No benchmark case for contact ${onlyId}.` : 'No benchmark cases found.');
  process.exit(1);
}

// ---- Helpers ---------------------------------------------------------------
const actualStatus = (d: Diagnosis) => (d.blockedAt ? 'BLOCKED' : d.steps.some((s) => s.status === 'WARN') ? 'WARN' : 'OK');
const normStatus = (s: string) => (s === 'PASS' ? 'OK' : s);
const modeLabel = (status: string, mode: string | undefined, title?: string) =>
  status === 'BLOCKED' ? `BLOCKED@${mode ?? '?'}${title ? ` (${title})` : ''}` : status;

const stageMeta = await loadStageMeta().catch(() => undefined);

interface Failure {
  id: string;
  expected: string;
  got: string;
  reasons: string[];
}
const failures: Failure[] = [];
let passed = 0;

// ---- Run -------------------------------------------------------------------
for (const c of cases) {
  const exp = c.expected;
  const expLabel = modeLabel(exp.status, exp.mode, exp.title);
  try {
    const lead = await fetchLead(c.contactId);
    const d = await diagnoseContact(lead);
    const conf = (d as Diagnosis & { confidence?: { score: number } }).confidence ?? scoreDiagnosis(lead, d, stageMeta);

    const status = actualStatus(d);
    const mode = d.blockedAt ? String(d.blockedAt.step) : undefined;
    const gotLabel = modeLabel(status, mode, d.blockedAt?.title);
    const reasons: string[] = [];

    if (normStatus(exp.status) !== status) reasons.push(`status ${exp.status} != ${status}`);
    if (status === 'BLOCKED' && exp.mode !== undefined && mode !== exp.mode) reasons.push(`step ${exp.mode} != ${mode}`);
    for (const [step, want] of Object.entries(exp.stepStatuses ?? {})) {
      const got = d.steps.find((s) => String(s.step) === step)?.status ?? 'MISSING';
      if (got !== want) reasons.push(`step ${step} ${want} != ${got}`);
    }
    if (exp.minConfidence !== undefined && conf.score < exp.minConfidence) reasons.push(`confidence ${conf.score} < ${exp.minConfidence}`);

    const ok = reasons.length === 0;
    if (ok) passed++;
    else failures.push({ id: c.contactId, expected: expLabel, got: gotLabel, reasons });
    console.log(`[${ok ? '✓ PASS' : '✗ FAIL'}] ${c.contactId.padEnd(14)} expected=${expLabel.padEnd(34)} actual=${gotLabel.padEnd(34)} conf=${conf.score.toFixed(2)}`);
  } catch (e) {
    // Network / HubSpot failures must not abort the batch.
    const msg = (e as Error).message;
    failures.push({ id: c.contactId, expected: expLabel, got: 'ERROR', reasons: [msg] });
    console.log(`[✗ FAIL] ${c.contactId.padEnd(14)} expected=${expLabel.padEnd(34)} actual=ERROR (${msg})`);
  }
}

// ---- Summary ---------------------------------------------------------------
const total = cases.length;
const accuracy = (passed / total) * 100;
console.log('\n=== Benchmark Summary ===');
console.log(`Total Evaluated: ${total}`);
console.log(`Passed: ${passed}   Failed: ${failures.length}`);
console.log(`Accuracy: ${accuracy.toFixed(1)}%  (threshold ${PASS_THRESHOLD}%)`);
if (failures.length) {
  console.log('\nRegressions:');
  for (const f of failures) {
    console.log(`  ${f.id}  Expected: ${f.expected}, Got: ${f.got}`);
    console.log(`      ${f.reasons.join('; ')}`);
  }
}
process.exit(accuracy >= PASS_THRESHOLD ? 0 : 1);
