import { useEffect, useMemo, useRef, useState } from 'react';
import type { CopilotResult, DiagnoseRequest, ReportedIssue } from '../../src/api/diagnose.ts';
import { ConfidenceBadge, CopilotCard, verdictOf } from './cards.tsx';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  result?: CopilotResult;
  pending?: boolean;
  error?: string;
}

interface Session {
  id: string;
  title: string;
  team?: string | null;
  verdict?: string;
  updatedAt: number;
  messages: Msg[];
  contactId?: string;
  issue?: ReportedIssue;
  customText?: string;
  targetQueue?: string;
  answers: Record<string, string>;
}

const STORAGE_KEY = 'sdr-copilot-sessions-v1';
const uid = () => Math.random().toString(36).slice(2, 10);

const QUEUES = ['Open Pipe', 'Pending Demos', 'No-Shows', 'Incoming'] as const;

const STARTERS: { label: string; issue: ReportedIssue; queue?: string }[] = [
  { label: 'Missing from Open Pipe', issue: 'missing_open_pipe', queue: 'Open Pipe' },
  { label: 'Check Unassigned Incoming', issue: 'unassigned_incoming', queue: 'Incoming' },
  { label: 'Investigate Cadence Expiration', issue: 'cadence_stopped' },
  { label: 'Lead vanished after demo', issue: 'demo_vanished', queue: 'Pending Demos' },
];

const ID_PATTERN = /(https?:\/\/\S+|\b\d{6,}\b)/g;

/** Prefers the id inside a HubSpot URL (record/0-1/<id>); otherwise the first 6+ digit number. Never the portal id. */
function extractId(text: string): string | null {
  const url = text.match(/(?:record\/0-1\/|contact\/|objectId=)(\d+)/);
  if (url) return url[1]!;
  if (/https?:\/\//.test(text) && !/\d{6,}/.test(text.replace(/https?:\/\/\S+/g, ''))) return null;
  const raw = text.replace(/https?:\/\/\S+/g, ' ').match(/\b(\d{6,})\b/);
  return raw ? raw[1]! : null;
}

function loadSessions(): Session[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Session[];
  } catch {
    return [];
  }
}

function UserBubble({ text }: { text: string }) {
  const parts = text.split(ID_PATTERN);
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-zinc-800 px-4 py-2.5 text-sm text-zinc-100">
        {parts.map((p, i) =>
          i % 2 === 1 ? (
            <span key={i} className="rounded bg-indigo-500/20 px-1 font-mono text-[12px] text-indigo-300">
              {p.length > 48 ? `${p.slice(0, 45)}…` : p}
            </span>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </div>
    </div>
  );
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [input, setInput] = useState('');
  const [draftQueue, setDraftQueue] = useState<string | undefined>(undefined);
  const [engine, setEngine] = useState<string>('Connecting…');
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const busy = !!active?.messages.some((m) => m.pending);
  const queue = active ? active.targetQueue : draftQueue;

  useEffect(() => {
    const clean = sessions.slice(0, 25).map((s) => ({ ...s, messages: s.messages.filter((m) => !m.pending) }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  }, [sessions]);

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((j: { llm: { provider: string; model: string } | null }) =>
        setEngine(j.llm ? `Deterministic Engine v1.0 • ${j.llm.model} Connected` : 'Deterministic Engine v1.0 • AI offline (template)'),
      )
      .catch(() => setEngine('Deterministic Engine v1.0 • status unavailable'));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [active?.messages.length, busy]);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [input]);

  const update = (sid: string, fn: (s: Session) => Session) => setSessions((prev) => prev.map((s) => (s.id === sid ? fn(s) : s)));

  function ensureSession(): string {
    if (activeId && active) return activeId;
    const s: Session = { id: uid(), title: 'New investigation', updatedAt: Date.now(), messages: [], answers: {}, targetQueue: draftQueue };
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    return s.id;
  }

  const addMsg = (sid: string, m: Msg) => update(sid, (s) => ({ ...s, messages: [...s.messages, m], updatedAt: Date.now() }));

  /** Calls diagnoseLead (via /api/diagnose) with the accumulated conversation context. */
  async function run(sid: string, ctx: Pick<Session, 'contactId' | 'issue' | 'customText' | 'targetQueue' | 'answers'>) {
    const mid = uid();
    update(sid, (s) => ({ ...s, ...ctx, messages: [...s.messages, { id: mid, role: 'assistant', pending: true }] }));
    const body: DiagnoseRequest = {
      contactIdOrUrl: ctx.contactId!,
      reportedIssue: ctx.issue,
      customIssueText: ctx.customText,
      targetQueue: ctx.targetQueue,
      clarificationAnswers: Object.keys(ctx.answers).length ? ctx.answers : undefined,
    };
    try {
      const res = await fetch('/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      const result = json as CopilotResult;
      const name = 'notFound' in result.dossier ? null : result.dossier.identity.name;
      const team = 'notFound' in result.dossier ? null : result.dossier.identity.team;
      update(sid, (s) => ({
        ...s,
        title: name ?? `Contact ${result.contactId}`,
        team,
        verdict: verdictOf(result).short,
        updatedAt: Date.now(),
        messages: s.messages.map((m) => (m.id === mid ? { id: mid, role: 'assistant', result } : m)),
      }));
    } catch (e) {
      update(sid, (s) => ({ ...s, messages: s.messages.map((m) => (m.id === mid ? { id: mid, role: 'assistant', error: (e as Error).message } : m)) }));
    }
  }

  function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    const sid = ensureSession();
    addMsg(sid, { id: uid(), role: 'user', text });
    setInput('');
    const cur = sessions.find((s) => s.id === sid);
    const id = extractId(text);

    if (id) {
      // New contact: fresh clarification state; any extra words become a custom issue note.
      const note = text.replace(ID_PATTERN, ' ').replace(/\s+/g, ' ').trim();
      const issue = note.length > 3 ? 'other' : cur?.issue;
      void run(sid, { contactId: id, issue, customText: note.length > 3 ? note : undefined, targetQueue: cur?.targetQueue ?? draftQueue, answers: {} });
      return;
    }
    if (cur?.contactId) {
      // Follow-up answer: match it to a pending clarification question, else treat it as extra issue context.
      const last = [...cur.messages].reverse().find((m) => m.result)?.result;
      const lower = text.toLowerCase();
      for (const q of last?.clarificationQuestions ?? []) {
        const hit = q.options.find((o) => lower === o.toLowerCase() || lower.includes(o.toLowerCase()));
        if (hit) {
          void run(sid, { contactId: cur.contactId, issue: cur.issue, customText: cur.customText, targetQueue: cur.targetQueue, answers: { ...cur.answers, [q.id]: hit } });
          return;
        }
      }
      void run(sid, { contactId: cur.contactId, issue: 'other', customText: text, targetQueue: cur.targetQueue, answers: cur.answers });
      return;
    }
    addMsg(sid, { id: uid(), role: 'assistant', text: 'Paste a HubSpot contact URL or ID and I will investigate why the lead is not visible.' });
  }

  function chooseStarter(label: string, issue: ReportedIssue, targetQueue?: string) {
    const sid = ensureSession();
    addMsg(sid, { id: uid(), role: 'user', text: label });
    update(sid, (s) => ({ ...s, issue, targetQueue: targetQueue ?? s.targetQueue }));
    if (targetQueue) setDraftQueue(targetQueue);
    addMsg(sid, { id: uid(), role: 'assistant', text: `Got it: "${label}". Paste the HubSpot contact URL or ID of the lead.` });
  }

  /** Sets the queue the rep was looking at; re-diagnoses the open contact so the engine sees it. */
  function changeQueue(value: string) {
    const q = value || undefined;
    setDraftQueue(q);
    if (!active) return;
    update(active.id, (s) => ({ ...s, targetQueue: q }));
    if (active.contactId && !busy) {
      addMsg(active.id, { id: uid(), role: 'user', text: q ? `Queue I was checking: ${q}` : 'Queue: any' });
      void run(active.id, { contactId: active.contactId, issue: active.issue, customText: active.customText, targetQueue: q, answers: active.answers });
    }
  }

  function answerChip(qid: string, option: string) {
    if (!active?.contactId || busy) return;
    addMsg(active.id, { id: uid(), role: 'user', text: option });
    void run(active.id, { contactId: active.contactId, issue: active.issue, customText: active.customText, targetQueue: active.targetQueue, answers: { ...active.answers, [qid]: option } });
  }

  const lastCardId = useMemo(() => [...(active?.messages ?? [])].reverse().find((m) => m.result)?.id, [active]);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 antialiased" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-64' : 'w-0'} flex shrink-0 flex-col overflow-hidden border-r border-zinc-800 bg-zinc-900 transition-[width] duration-200`}>
        <div className="w-64 p-3">
          <button
            onClick={() => {
              setActiveId(null);
              setInput('');
              setDraftQueue(undefined);
            }}
            className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-left text-sm font-medium text-zinc-100 hover:bg-zinc-800"
          >
            + New Investigation
          </button>
        </div>
        <nav className="w-64 flex-1 space-y-0.5 overflow-y-auto px-2">
          {sessions.length === 0 && <p className="px-2 py-3 text-xs text-zinc-600">No investigations yet.</p>}
          {sessions.map((s) => (
            <div key={s.id} className={`group flex items-center rounded-lg ${s.id === activeId ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}`}>
              <button onClick={() => setActiveId(s.id)} className="min-w-0 flex-1 px-2.5 py-2 text-left">
                <div className="truncate text-sm text-zinc-200">{s.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
                  {s.team && <span className="rounded bg-indigo-500/10 px-1 text-indigo-300">{s.team}</span>}
                  {s.verdict && <span className={s.verdict === 'PASS' ? 'text-emerald-400' : 'text-rose-400'}>{s.verdict}</span>}
                </div>
              </button>
              <button
                title="Delete"
                onClick={() => {
                  setSessions((prev) => prev.filter((x) => x.id !== s.id));
                  if (s.id === activeId) setActiveId(null);
                }}
                className="mr-1.5 hidden rounded px-1.5 text-xs text-zinc-500 hover:text-rose-400 group-hover:block"
              >
                ✕
              </button>
            </div>
          ))}
        </nav>
        <div className="w-64 border-t border-zinc-800 px-3 py-2.5 text-[11px] text-zinc-500">
          <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${engine.includes('Connected') ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {engine}
        </div>
      </aside>

      {/* Chat */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar" className="absolute left-3 top-3 z-10 rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
          ☰
        </button>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-4 pb-40 pt-14">
            {!active || active.messages.length === 0 ? (
              <div className="flex flex-col items-center pt-[18vh] text-center">
                <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-indigo-500 text-lg font-bold">S</div>
                <h1 className="text-2xl font-semibold">SDR RevOps Copilot</h1>
                <p className="mt-1 text-sm text-zinc-500">Why can't the rep see this lead? Paste a HubSpot contact URL or ID.</p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => (
                    <button key={s.label} onClick={() => chooseStarter(s.label, s.issue, s.queue)} className="rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:border-indigo-400 hover:text-indigo-300">
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              active.messages.map((m) => {
                if (m.role === 'user') return <UserBubble key={m.id} text={m.text ?? ''} />;
                return (
                  <div key={m.id} className="flex gap-3">
                    <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-indigo-500 text-xs font-bold">S</div>
                    <div className="min-w-0 flex-1">
                      {m.pending && (
                        <div className="flex items-center gap-2 py-2 text-sm text-zinc-500">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" /> Investigating…
                        </div>
                      )}
                      {m.text && <p className="py-1 text-sm text-zinc-300">{m.text}</p>}
                      {m.error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{m.error}</p>}
                      {m.result && <CopilotCard r={m.result} interactive={m.id === lastCardId && !busy} onAnswer={answerChip} />}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>
        </div>

        {/* Pinned prompt bar */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent px-4 pb-5 pt-10">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="pointer-events-auto mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl focus-within:border-indigo-500"
          >
            <select
              value={queue ?? ''}
              disabled={busy}
              onChange={(e) => changeQueue(e.target.value)}
              title="Queue the rep was looking at (sent as targetQueue)"
              className="h-10 shrink-0 rounded-xl border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
            >
              <option value="">Any queue</option>
              {QUEUES.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                // Pasted HubSpot URLs collapse to the bare contact ID.
                const t = e.clipboardData.getData('text');
                if (/hubspot\.com/.test(t)) {
                  const id = extractId(t);
                  if (id) {
                    e.preventDefault();
                    setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${id}`);
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={active?.contactId ? 'Answer or add context, or paste another contact ID…' : 'Paste a HubSpot URL or contact ID…'}
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-60"
            />
            <button disabled={busy || !input.trim()} className="rounded-xl bg-indigo-500 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-40">
              ↑
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
