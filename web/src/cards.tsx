import { useState } from 'react';
import type { CopilotResult } from '../../src/api/diagnose.ts';

export type Step = CopilotResult['engine']['diagnosis']['steps'][number];
export type Status = 'PASS' | 'BLOCKED' | 'WARN' | 'SKIPPED';

const CANONICAL: { step: number; title: string }[] = [
  { step: 1, title: 'Deal Lock' },
  { step: 1.5, title: 'Owner Gate' },
  { step: 2, title: 'Brain State' },
  { step: 3, title: 'AI Handover' },
  { step: 4, title: 'Filter Hygiene' },
  { step: 5, title: 'Meeting Validation' },
  { step: 6, title: 'List vs UI Diff' },
];

const mono = 'font-mono text-[11px]';
const STATUS_STYLE: Record<Status, { dot: string; badge: string }> = {
  PASS: { dot: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30' },
  BLOCKED: { dot: 'bg-rose-500', badge: 'bg-rose-500/10 text-rose-400 ring-rose-500/30' },
  WARN: { dot: 'bg-amber-500', badge: 'bg-amber-500/10 text-amber-400 ring-amber-500/30' },
  SKIPPED: { dot: 'bg-zinc-600', badge: 'bg-zinc-800 text-zinc-500 ring-zinc-700' },
};

export function verdictOf(r: CopilotResult): { text: string; status: Status; short: string } {
  const d = r.engine.diagnosis;
  const last = d.steps.at(-1);
  if (d.blockedAt) return { text: `BLOCKED: Step ${d.blockedAt.step} ${d.blockedAt.title}`, status: 'BLOCKED', short: `Step ${d.blockedAt.step}` };
  if (last?.status === 'WARN') return { text: `WARN: Step ${last.step} ${last.title}`, status: 'WARN', short: `Step ${last.step} warn` };
  return { text: 'PASS', status: 'PASS', short: 'PASS' };
}

function Badge({ status }: { status: Status }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ring-1 ring-inset ${STATUS_STYLE[status].badge}`}>{status}</span>;
}

export function ConfidenceBadge({ score }: { score: number }) {
  const [label, cls] =
    score >= 1 ? ['Definitive', 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40'] : score >= 0.8 ? ['Heuristic', 'bg-amber-500/15 text-amber-300 ring-amber-500/40'] : ['Review', 'bg-rose-500/15 text-rose-300 ring-rose-500/40'];
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>
      <span className={mono}>{score.toFixed(1)}</span> {label}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${done ? 'bg-emerald-500 text-white' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? '✓ Copied!' : '📋 Copy'}
    </button>
  );
}

function Waterfall({ r }: { r: CopilotResult }) {
  const byStep = new Map<number, Step>(r.engine.diagnosis.steps.map((s) => [s.step, s]));
  const rows = [...(byStep.has(0) ? [{ step: 0, title: byStep.get(0)!.title }] : []), ...CANONICAL];
  return (
    <ol className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
      {rows.map(({ step, title }) => {
        const s = byStep.get(step);
        const status: Status = s ? s.status : 'SKIPPED';
        return (
          <li key={step} className="px-3 py-2">
            <div className="flex items-center gap-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[status].dot}`} />
              <span className={`${mono} w-6 text-zinc-500`}>{step}</span>
              <span className="flex-1 text-sm text-zinc-200">{s?.title ?? title}</span>
              <Badge status={status} />
            </div>
            {s && <p className="ml-14 mt-1 break-words text-xs text-zinc-500">{s.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function DiffTable({ steps }: { steps: Step[] }) {
  const rows = steps.filter((s) => s.propertyKey && s.status !== 'PASS');
  if (!rows.length) return <p className="text-xs text-zinc-500">No failing properties.</p>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
        <tr>
          <th className="py-1.5 pr-3 font-semibold">Property</th>
          <th className="py-1.5 pr-3 font-semibold">Current CRM Value</th>
          <th className="py-1.5 font-semibold">Target Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.step} className="border-t border-zinc-800 align-top">
            <td className={`py-1.5 pr-3 text-zinc-300 ${mono}`}>{s.propertyKey}</td>
            <td className={`py-1.5 pr-3 text-rose-400 ${mono}`}>{s.currentValue === null || s.currentValue === undefined ? 'null' : String(s.currentValue)}</td>
            <td className="py-1.5 text-emerald-400">{s.expectedValue ?? '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Inspector({ r }: { r: CopilotResult }) {
  const a = r.copilot.adminView;
  const [raw, setRaw] = useState(false);
  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-900/60">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-zinc-300 hover:text-white">
        <span>🔍 RevOps Inspector</span>
        <span className="text-zinc-500 transition group-open:rotate-90">▸</span>
      </summary>
      <div className="space-y-3 border-t border-zinc-800 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-zinc-100">{a.rootCauseCategory}</p>
            <p className="text-xs text-zinc-500">{a.step}</p>
            <p className="mt-1 text-xs text-zinc-400">Remediation: {a.remediation}</p>
          </div>
          <a href={r.links.hubspotContact} target="_blank" rel="noreferrer" className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
            Open in HubSpot ↗
          </a>
        </div>
        <Waterfall r={r} />
        <DiffTable steps={r.engine.diagnosis.steps} />
        <button className="text-[11px] text-indigo-400 hover:underline" onClick={() => setRaw(!raw)}>
          {raw ? 'Hide raw JSON' : 'Show raw JSON'}
        </button>
        {raw && <pre className="max-h-72 overflow-auto rounded bg-black p-3 text-[11px] text-zinc-300">{JSON.stringify(r, null, 2)}</pre>}
      </div>
    </details>
  );
}

function Feedback({ r }: { r: CopilotResult }) {
  const [state, setState] = useState<'idle' | 'down' | 'saved'>('idle');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function save(rating: 'up' | 'down', actualReason?: string) {
    setErr(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contactId: r.contactId,
          rating,
          actualReason,
          engineVerdict: r.engine.diagnosis.conclusion,
          confidence: r.engine.confidence.score,
          reportedIssue: r.request.reportedIssue,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed');
      setState('saved');
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  if (state === 'saved') return <p className="text-xs text-emerald-400">✓ Feedback saved. Thanks!</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      <button onClick={() => save('up')} className="rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-emerald-400">👍</button>
      <button onClick={() => setState(state === 'down' ? 'idle' : 'down')} className={`rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-rose-400 ${state === 'down' ? 'bg-zinc-800 text-rose-400' : ''}`}>👎</button>
      {state === 'down' && (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void save('down', reason.trim());
          }}
        >
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What was the actual reason?"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
          />
          <button className="rounded-md bg-zinc-100 px-2.5 py-1 font-medium text-zinc-900 hover:bg-white">Save</button>
        </form>
      )}
      {err && <span className="text-rose-400">{err}</span>}
    </div>
  );
}

export function CopilotCard({ r, interactive, onAnswer }: { r: CopilotResult; interactive: boolean; onAnswer: (qid: string, option: string, question: string) => void }) {
  const v = verdictOf(r);
  const d = r.dossier;
  const header = 'notFound' in d ? null : d.identity;
  const s = r.copilot.sdrView;
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">{header?.name ?? `Contact ${r.contactId}`}</h3>
            <span className={`${mono} text-zinc-500`}>{r.contactId}</span>
            {header?.team && <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[11px] text-indigo-300 ring-1 ring-inset ring-indigo-500/30">{header.team}</span>}
          </div>
          {header && <p className="text-xs text-zinc-500">Owner: {header.sdrOwner ?? 'unassigned'}</p>}
          {!header && <p className="text-xs text-rose-400">Not found in HubSpot (404)</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLE[v.status].badge}`}>[{v.text}]</span>
          <ConfidenceBadge score={r.engine.confidence.score} />
        </div>
      </div>

      <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3">
        <p className="mb-1 text-xs font-semibold text-indigo-300">{s.reason}</p>
        <p className="text-sm leading-relaxed text-zinc-200">{s.summary}</p>
        <p className="mt-2 text-sm text-amber-300">→ {s.nextStep}</p>
        {r.resolution.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-emerald-400">
            {r.resolution.map((x) => <li key={x}>{x}</li>)}
          </ul>
        )}
      </div>

      {s.slackMessage && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Slack message</span>
            <CopyButton text={s.slackMessage} />
          </div>
          <p className="whitespace-pre-wrap text-sm text-zinc-300">{s.slackMessage}</p>
        </div>
      )}

      {r.clarificationQuestions?.map((q) => (
        <div key={q.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-2 text-sm text-zinc-200">{q.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => (
              <button
                key={o}
                disabled={!interactive}
                onClick={() => onAnswer(q.id, o, q.question)}
                className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-200 transition hover:border-indigo-400 hover:text-indigo-300 disabled:cursor-default disabled:opacity-40 disabled:hover:border-zinc-700 disabled:hover:text-zinc-200"
              >
                {o}
              </button>
            ))}
          </div>
        </div>
      ))}

      <Inspector r={r} />
      <Feedback r={r} />
    </div>
  );
}
