/**
 * Grades the engine against data/golden-benchmark.json.
 *
 *   npx tsx scripts/eval-benchmark.ts                     deterministic checks, all cases
 *   npx tsx scripts/eval-benchmark.ts --limit N | --id <contactId>
 *   npx tsx scripts/eval-benchmark.ts --with-llm          + Gemini grounding/safety assertions on a stratified sample
 *       --llm-sample N   sample size (default 12)         --llm-all   run the LLM on every case
 *
 * Exit code 0 when deterministic accuracy >= 95% (and, with --with-llm, LLM assertion pass rate >= 95%).
 */
import { readFileSync } from 'node:fs';
import { fetchLead, loadStageMeta, type LeadData } from '../src/engine/hubspot.ts';
import { diagnoseContact, type Diagnosis } from '../src/engine/investigator.ts';
import { scoreDiagnosis, type Confidence } from '../src/engine/confidence.ts';
import { buildDossier } from '../src/engine/dossier.ts';
import { generateCopilotAnalysis, getLlmStatus, slackTags, type CopilotResponse, type LeadDossier } from '../src/ai/copilot.ts';

interface Case {
  contactId: string;
  category?: string;
  expected: {
    mode?: string | null;
    status: string;
    title?: string;
    minConfidence?: number;
    blockedAt?: { step: number; title: string } | null;
    stepStatuses?: Record<string, string>;
    duplicateIds?: string[];
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
const withLlm = args.includes('--with-llm');
const llmAll = args.includes('--llm-all');
const llmSample = argVal('--llm-sample') ? Number(argVal('--llm-sample')) : 12;

const file = new URL('../data/golden-benchmark.json', import.meta.url);
let cases = (JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] }).cases;
if (onlyId) cases = cases.filter((c) => c.contactId === onlyId);
if (limit && limit > 0) cases = cases.slice(0, limit);
if (!cases.length) {
  console.error(onlyId ? `No benchmark case for contact ${onlyId}.` : 'No benchmark cases found.');
  process.exit(1);
}

// ---- helpers -----------------------------------------------------------------
const normStatus = (s: string) => (s === 'OK' ? 'PASS' : s);
const actualStatus = (d: Diagnosis) => (d.blockedAt ? 'BLOCKED' : d.steps.some((s) => s.status === 'WARN') ? 'WARN' : 'PASS');
const verdictStep = (d: Diagnosis) => d.blockedAt ?? [...d.steps].reverse().find((s) => s.status === 'WARN');
const label = (status: string, mode: string | null | undefined, title?: string) =>
  status === 'PASS' ? 'PASS' : `${status}@${mode ?? '?'}${title ? ` (${title})` : ''}`;
const groupOf = (c: Case) => (normStatus(c.expected.status) === 'PASS' ? 'PASS controls' : `Step ${c.expected.mode}`);
const GROUP_ORDER = ['Step 0', 'Step 1', 'Step 1.5', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6', 'PASS controls', 'Duplicate fixture (synthetic)'];

const stageMeta = await loadStageMeta().catch(() => undefined);

// ---- LLM assertions ------------------------------------------------------------
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID ?? '4021060';
const ID_RE = /\b\d{5,}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const stepsMentioned = (t: string) => [...t.matchAll(/\bStep\s*(\d+(?:\.\d+)?)/gi)].map((m) => Number(m[1]));

interface LlmFailure {
  check: 'llm' | 'ids' | 'align' | 'email' | 'tags' | 'dup';
  msg: string;
}

function checkLlm(resp: CopilotResponse, dossier: LeadDossier, d: Diagnosis, email: string | null, contactId: string, expectDup: boolean): LlmFailure[] {
  const out: LlmFailure[] = [];
  const s = resp.sdrView;
  const a = resp.adminView;
  const slack = s.slackMessage ?? '';
  const prose = [s.summary, s.reason, s.nextStep, slack, a.remediation, a.rootCauseCategory, a.step].join('\n');

  // (a) Zero hallucinated IDs: every long numeric / UUID token must appear verbatim in the evidence the model saw.
  const evidence = JSON.stringify({ dossier, steps: d.steps, conclusion: d.conclusion, duplicates: d.duplicates });
  const allowed = new Set([...(evidence.match(ID_RE) ?? []), PORTAL_ID, contactId]);
  const bad = [...new Set(prose.match(ID_RE) ?? [])].filter((t) => !allowed.has(t));
  if (bad.length) out.push({ check: 'ids', msg: `IDs not in dossier: ${bad.join(', ')}` });

  // (b) Deterministic alignment: the root cause must name the engine's verdict step and no other.
  const v = verdictStep(d);
  const rootText = [a.step, a.rootCauseCategory, s.reason].join(' ');
  const rootSteps = new Set([...stepsMentioned(rootText), ...(a.step.match(/^\s*(\d+(?:\.\d+)?)/) ? [Number(a.step.match(/^\s*(\d+(?:\.\d+)?)/)![1])] : [])]);
  if (v) {
    const wrong = [...rootSteps, ...stepsMentioned(slack)].filter((n) => n !== v.step);
    if (!rootSteps.has(v.step)) out.push({ check: 'align', msg: `root cause does not name Step ${v.step} (adminView.step="${a.step}")` });
    if (wrong.length) out.push({ check: 'align', msg: `blames unrelated step(s) ${[...new Set(wrong)].join(', ')}; engine verdict is Step ${v.step}` });
  } else {
    const blamed = [...rootSteps, ...stepsMentioned(slack)].filter((n) => n <= 5);
    if (blamed.length) out.push({ check: 'align', msg: `engine passes all steps but response blames Step ${[...new Set(blamed)].join(', ')}` });
    if (s.slackMessage) out.push({ check: 'align', msg: 'escalation drafted although the engine found no blocker' });
  }

  // (c) Email privacy: neither the prospect's address nor any email-shaped string may appear anywhere.
  const whole = JSON.stringify(resp);
  if (email && whole.toLowerCase().includes(email.toLowerCase())) out.push({ check: 'email', msg: 'prospect email present in response' });
  const anyEmail = whole.match(EMAIL_RE);
  if (anyEmail) out.push({ check: 'email', msg: `email-shaped string in response: ${anyEmail[0]!.replace(/^(.).*(@.*)$/, '$1***$2')}` });

  // (d) Escalation tagging: blocked cases need the BizOps tags and the HubSpot contact link.
  if (d.blockedAt) {
    if (!slack) out.push({ check: 'tags', msg: 'no Slack escalation on a blocked case' });
    else {
      const missing = slackTags().split(' ').filter((t) => !slack.toLowerCase().includes(t.toLowerCase()));
      if (missing.length) out.push({ check: 'tags', msg: `missing tag(s): ${missing.join(' ')}` });
      if (!new RegExp(`https://app\\.hubspot\\.com/contacts/\\d+/record/0-1/${contactId}\\b`).test(slack)) out.push({ check: 'tags', msg: 'missing HubSpot contact link' });
    }
  }

  // Duplicates must be flagged clearly when the dossier lists them.
  if (expectDup) {
    const ids = (dossier.duplicates ?? []).map((x) => x.id);
    if (!/duplicate/i.test(prose) || !ids.some((id) => prose.includes(id))) out.push({ check: 'dup', msg: 'duplicate contacts not flagged by ID in the response' });
  }
  return out;
}

// ---- run -------------------------------------------------------------------------
interface Failure {
  id: string;
  expected: string;
  got: string;
  reasons: string[];
}
interface Run {
  c: Case;
  lead?: LeadData;
  d?: Diagnosis;
  conf?: Confidence;
  ok: boolean;
}
const failures: Failure[] = [];
const runs: Run[] = [];
const byGroup = new Map<string, { det: [number, number]; llm: [number, number] }>();
const grp = (g: string) => byGroup.get(g) ?? byGroup.set(g, { det: [0, 0], llm: [0, 0] }).get(g)!;
let passed = 0;

for (const c of cases) {
  const exp = c.expected;
  const expLabel = label(normStatus(exp.status), exp.mode, exp.title);
  const g = grp(groupOf(c));
  g.det[1]++;
  try {
    const lead = await fetchLead(c.contactId);
    const d = await diagnoseContact(lead);
    const conf = scoreDiagnosis(lead, d, stageMeta);
    const status = actualStatus(d);
    const v = verdictStep(d);
    const mode = v ? String(v.step) : null;
    const reasons: string[] = [];

    if (normStatus(exp.status) !== status) reasons.push(`status ${exp.status} != ${status}`);
    if (exp.mode != null && mode !== exp.mode) reasons.push(`step ${exp.mode} != ${mode}`);
    if (exp.blockedAt === null && d.blockedAt) reasons.push(`expected no blocker, got Step ${d.blockedAt.step}`);
    if (exp.blockedAt && d.blockedAt?.step !== exp.blockedAt.step) reasons.push(`blockedAt ${exp.blockedAt.step} != ${d.blockedAt?.step ?? 'none'}`);
    for (const [step, want] of Object.entries(exp.stepStatuses ?? {})) {
      const got = d.steps.find((s) => String(s.step) === step)?.status ?? 'MISSING';
      if (got !== want) reasons.push(`step ${step} ${want} != ${got}`);
    }
    if (exp.minConfidence !== undefined && conf.score < exp.minConfidence) reasons.push(`confidence ${conf.score} < ${exp.minConfidence}`);
    for (const id of exp.duplicateIds ?? []) if (!d.duplicates?.some((x) => x.id === id)) reasons.push(`duplicate ${id} not detected`);

    const ok = reasons.length === 0;
    if (ok) {
      passed++;
      g.det[0]++;
    } else failures.push({ id: c.contactId, expected: expLabel, got: label(status, mode, v?.title), reasons });
    runs.push({ c, lead: 'notFound' in lead ? undefined : lead, d, conf, ok });
    console.log(`[${ok ? '✓ PASS' : '✗ FAIL'}] ${c.contactId.padEnd(14)} expected=${expLabel.padEnd(36)} actual=${label(status, mode, v?.title).padEnd(36)} conf=${conf.score.toFixed(2)}`);
  } catch (e) {
    // Network / HubSpot failures must not abort the batch.
    const msg = (e as Error).message;
    failures.push({ id: c.contactId, expected: expLabel, got: 'ERROR', reasons: [msg] });
    runs.push({ c, ok: false });
    console.log(`[✗ FAIL] ${c.contactId.padEnd(14)} expected=${expLabel.padEnd(36)} actual=ERROR (${msg.slice(0, 80)})`);
  }
}

// ---- LLM pass --------------------------------------------------------------------
let llmTotal = 0;
let llmPassed = 0;
const llmFailures: { id: string; group: string; fails: LlmFailure[] }[] = [];
const llmChecks: Record<string, number> = {};

if (withLlm) {
  const eligible = runs.filter((r) => r.lead && r.d);
  // Stratified sample: round-robin across groups so every step (and the PASS controls) is represented.
  const buckets = new Map<string, Run[]>();
  for (const r of eligible) (buckets.get(groupOf(r.c)) ?? buckets.set(groupOf(r.c), []).get(groupOf(r.c))!).push(r);
  const sample: Run[] = [];
  const order = GROUP_ORDER.filter((x) => buckets.has(x));
  for (let i = 0; sample.length < (llmAll ? eligible.length : llmSample); i++) {
    let any = false;
    for (const gname of order) {
      const r = buckets.get(gname)![i];
      if (r && sample.length < (llmAll ? eligible.length : llmSample)) {
        sample.push(r);
        any = true;
      }
    }
    if (!any) break;
  }

  const status = getLlmStatus();
  console.log(`\n=== LLM grounding & safety checks (${sample.length} cases; ${status ? `${status.provider}:${status.model}` : 'NO PROVIDER, grounded template only'}) ===`);

  type Job = { id: string; group: string; dossier: LeadDossier; d: Diagnosis; conf: Confidence; email: string | null; expectDup: boolean };
  const jobs: Job[] = [];
  for (const r of sample) {
    const dossier = (await buildDossier(r.lead!)) as unknown as LeadDossier;
    dossier.duplicates = r.d!.duplicates ?? [];
    jobs.push({ id: r.c.contactId, group: groupOf(r.c), dossier, d: r.d!, conf: r.conf!, email: r.lead!.properties.email ?? null, expectDup: dossier.duplicates.length > 0 });
  }
  // Synthetic duplicate fixture (HubSpot enforces unique primary emails, so no live exact-email duplicate exists).
  const base = jobs.find((j) => j.d.blockedAt);
  if (base) {
    const dup = { id: '900000000001', name: 'Synthetic Duplicate', ownerId: '1', ownerName: 'Test Owner', lifecycleStage: 'lead', createdAt: null };
    jobs.push({
      ...base,
      group: 'Duplicate fixture (synthetic)',
      dossier: { ...base.dossier, duplicates: [dup] },
      d: { ...base.d, duplicates: [dup] },
      expectDup: true,
    });
  }

  for (const j of jobs) {
    const g = grp(j.group);
    g.llm[1]++;
    llmTotal++;
    let fails: LlmFailure[] = [];
    let tag = '';
    try {
      const resp = await generateCopilotAnalysis(j.dossier, { diagnosis: j.d, confidence: j.conf });
      tag = resp.model ?? resp.source;
      if (status && resp.source === 'fallback') fails.push({ check: 'llm', msg: `LLM call failed, template used: ${resp.note ?? ''}`.slice(0, 160) });
      fails = fails.concat(checkLlm(resp, j.dossier, j.d, j.email, j.dossier.contactId, j.expectDup));
    } catch (e) {
      fails.push({ check: 'llm', msg: (e as Error).message.slice(0, 160) });
    }
    for (const f of fails) llmChecks[f.check] = (llmChecks[f.check] ?? 0) + 1;
    if (!fails.length) {
      llmPassed++;
      g.llm[0]++;
    } else llmFailures.push({ id: j.id, group: j.group, fails });
    const checks = ['ids', 'align', 'email', 'tags'].map((k) => `${fails.some((f) => f.check === k) ? '✗' : '✓'} ${k}`).join('  ');
    console.log(`[${fails.length ? '✗ FAIL' : '✓ PASS'}] ${j.id.padEnd(14)} ${j.group.padEnd(28)} ${tag.padEnd(24)} ${checks}`);
    for (const f of fails) console.log(`          ↳ ${f.check}: ${f.msg}`);
  }
}

// ---- summary ---------------------------------------------------------------------
const total = cases.length;
const accuracy = (passed / total) * 100;
const llmRate = llmTotal ? (llmPassed / llmTotal) * 100 : 100;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '-');

console.log('\n=== Benchmark Summary ===');
console.log(`Total Evaluated: ${total}`);
console.log(`Passed: ${passed}   Failed: ${failures.length}`);
console.log(`Accuracy: ${accuracy.toFixed(1)}%  (threshold ${PASS_THRESHOLD}%)`);
console.log('\nBreakdown by step:');
console.log(`  ${'Group'.padEnd(30)} ${'Deterministic'.padEnd(16)} ${withLlm ? 'LLM assertions' : ''}`);
for (const gname of [...GROUP_ORDER, ...[...byGroup.keys()].filter((k) => !GROUP_ORDER.includes(k))]) {
  const g = byGroup.get(gname);
  if (!g) continue;
  const det = g.det[1] ? `${g.det[0]}/${g.det[1]} (${pct(...g.det)})` : '-';
  const llm = withLlm ? (g.llm[1] ? `${g.llm[0]}/${g.llm[1]} (${pct(...g.llm)})` : 'not sampled') : '';
  console.log(`  ${gname.padEnd(30)} ${det.padEnd(16)} ${llm}`);
}
if (withLlm) {
  console.log(`\nLLM assertions: ${llmPassed}/${llmTotal} cases clean (${llmRate.toFixed(1)}%)${Object.keys(llmChecks).length ? `; failed checks: ${JSON.stringify(llmChecks)}` : ''}`);
}
if (failures.length) {
  console.log('\nRegressions:');
  for (const f of failures) {
    console.log(`  ${f.id}  Expected: ${f.expected}, Got: ${f.got}`);
    console.log(`      ${f.reasons.join('; ')}`);
  }
}
if (llmFailures.length) {
  console.log('\nLLM assertion failures:');
  for (const f of llmFailures) for (const x of f.fails) console.log(`  ${f.id} [${f.group}] ${x.check}: ${x.msg}`);
}
process.exit(accuracy >= PASS_THRESHOLD && llmRate >= PASS_THRESHOLD ? 0 : 1);
