import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

function useFeedback(intervalMs = 3000) {
  const [data, setData] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const tickRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;

    async function tick() {
      try {
        // Cache-bust at the URL level for paranoid proxies
        const res = await fetch(`/api/feedback?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!mounted.current) return;
        setData(json);
        setLastFetchedAt(Date.now());
        setError(null);
      } catch (e) {
        if (!mounted.current) return;
        setError(String(e?.message || e));
      } finally {
        if (!stopped) {
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(tick, intervalMs);
        }
      }
    }
    tickRef.current = tick;
    tick();

    // Browsers throttle setTimeout to ≥60s in background tabs. Force a fresh
    // fetch the moment the tab regains focus or visibility, so re-opening
    // the tab shows current data immediately.
    function onWake() {
      if (document.visibilityState === 'visible' && tickRef.current) {
        clearTimeout(timerRef.current);
        tickRef.current();
      }
    }
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);

    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [intervalMs]);

  return { data, lastFetchedAt, error };
}

function useAge(ts) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s ago`;
}

// Track which (team, attendee) entries are "new" since last seen → flash them
function useFlashTracker(reactionsByTeam) {
  const seen = useRef(new Map()); // key = `${num}:${attendee}` → markdown
  const flashing = useRef(new Set());
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!reactionsByTeam) return;
    const next = new Map();
    let anyNew = false;
    for (const [num, byA] of Object.entries(reactionsByTeam)) {
      for (const [attendee, md] of Object.entries(byA)) {
        const key = `${num}:${attendee}`;
        next.set(key, md);
        const prev = seen.current.get(key);
        if (prev === undefined) {
          // Only flash on subsequent fetches — not the initial paint
          if (seen.current.size > 0) {
            flashing.current.add(key);
            anyNew = true;
            setTimeout(() => {
              flashing.current.delete(key);
              setTick((t) => t + 1);
            }, 1800);
          }
        } else if (prev !== md) {
          flashing.current.add(key);
          anyNew = true;
          setTimeout(() => {
            flashing.current.delete(key);
            setTick((t) => t + 1);
          }, 1800);
        }
      }
    }
    seen.current = next;
    if (anyNew) setTick((t) => t + 1);
  }, [reactionsByTeam]);

  return (key) => flashing.current.has(key);
}

function TeamBlock({ team, byAttendee, notebookUrls, isFlashing, isCurrent }) {
  const entries = byAttendee ? Object.entries(byAttendee).filter(([, md]) => md && md.trim()) : [];
  const empty = entries.length === 0;
  return (
    <section
      id={`team-${team.num}`}
      className={[
        'mb-8 scroll-mt-24',
        isCurrent ? 'rounded-2xl ring-2 ring-amber-400 ring-offset-4 ring-offset-ink-50 bg-amber-50/40 p-4 -mx-4' : '',
      ].join(' ')}
    >
      <header className="flex items-baseline justify-between gap-4 mb-3">
        <div className="flex items-baseline gap-3">
          <span
            className={[
              'inline-flex items-center justify-center w-8 h-8 rounded-full text-[13px] font-mono font-semibold shrink-0',
              empty
                ? 'bg-ink-100 text-ink-500'
                : 'bg-ink-900 text-ink-50',
              isCurrent ? 'ring-2 ring-amber-400 animate-soft-pulse' : '',
            ].join(' ')}
          >
            {team.num}
          </span>
          <h2 className="font-serif text-[22px] sm:text-[26px] tracking-tight text-ink-900">
            Team {team.num}
            {team.descriptor && (
              <span className="ml-2 text-ink-500 italic font-serif text-[18px] sm:text-[20px]">
                — {team.descriptor}
              </span>
            )}
          </h2>
        </div>
        <div className="text-[11px] uppercase tracking-wider text-ink-500 font-mono shrink-0 hidden sm:block">
          {empty ? 'no reactions yet' : `${entries.length} ${entries.length === 1 ? 'reaction' : 'reactions'}`}
        </div>
      </header>

      {empty ? (
        <div className="text-[13px] text-ink-500 italic pl-11">
          No reactions yet — waiting on attendees{isCurrent ? '. (Currently presenting)' : '.'}
        </div>
      ) : (
        <div className="space-y-3 pl-11">
          {entries.map(([attendee, md]) => {
            const flashKey = `${team.num}:${attendee}`;
            const flash = isFlashing(flashKey);
            const url = notebookUrls?.[attendee];
            return (
              <article
                key={attendee}
                className={['card p-4', flash ? 'animate-flash-in' : ''].join(' ')}
              >
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-ink-900">{attendee}</span>
                    {flash && (
                      <span className="text-[10px] uppercase tracking-widest text-amber-600 font-mono">
                        just added
                      </span>
                    )}
                  </div>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-ink-500 hover:text-amber-600 font-mono underline decoration-dotted underline-offset-2"
                    >
                      open notebook →
                    </a>
                  )}
                </div>
                <div className="prose-reaction">
                  <ReactMarkdown>{md}</ReactMarkdown>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatRelativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function ByAttendeeView({ data, isFlashing }) {
  const { reactions, teamDescriptors, notebookUrls, roster = [] } = data;
  // Pivot reactions: byAttendee[name][teamNum] = markdown
  const pivot = {};
  for (const [num, byA] of Object.entries(reactions || {})) {
    for (const [name, md] of Object.entries(byA)) {
      if (!md || !md.trim()) continue;
      if (!pivot[name]) pivot[name] = {};
      pivot[name][num] = md;
    }
  }

  // Build attendee list: roster (everyone discovered) + any contributors
  // we have data for but who aren't in the roster (shouldn't happen, but safe)
  const rosterByName = Object.fromEntries(roster.map((r) => [r.name, r]));
  const allNames = new Set([...roster.map((r) => r.name), ...Object.keys(pivot)]);

  // Sort: contributors first (by name), then non-contributors (by lastEditedTime desc)
  const sorted = [...allNames].sort((a, b) => {
    const aHas = !!pivot[a];
    const bHas = !!pivot[b];
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas) return a.localeCompare(b);
    // both no content: sort by recent edit
    const at = rosterByName[a]?.lastEditedTime || '';
    const bt = rosterByName[b]?.lastEditedTime || '';
    if (at !== bt) return bt.localeCompare(at);
    return a.localeCompare(b);
  });

  if (sorted.length === 0) {
    return (
      <div className="text-center py-16 text-ink-500 italic">
        No attendees discovered yet. (Make sure their notebooks are subpages of the v5 hub.)
      </div>
    );
  }

  const contributorCount = Object.keys(pivot).length;
  const totalCount = sorted.length;

  return (
    <div className="space-y-8">
      <div className="text-[12px] font-mono text-ink-500">
        {totalCount} attendee{totalCount === 1 ? '' : 's'} in roster · {contributorCount} contributing
      </div>

      {sorted.map((name) => {
        const teams = pivot[name] ? Object.entries(pivot[name]).sort((a, b) => Number(a[0]) - Number(b[0])) : [];
        const r = rosterByName[name];
        const url = r?.url || notebookUrls?.[name];
        const empty = teams.length === 0;
        const lastEdit = formatRelativeTime(r?.lastEditedTime);
        return (
          <section key={name} className={empty ? 'opacity-60' : ''}>
            <header className="mb-3 flex items-baseline justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-3">
                <h2 className="font-serif text-[22px] sm:text-[24px] tracking-tight text-ink-900">{name}</h2>
                {empty && <span className="text-[11px] uppercase tracking-wider text-ink-500 font-mono">no reactions yet</span>}
                {lastEdit && (
                  <span className="text-[11px] text-ink-500 font-mono">edited {lastEdit}</span>
                )}
              </div>
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-ink-500 hover:text-amber-600 font-mono underline decoration-dotted underline-offset-2"
                >
                  open notebook →
                </a>
              )}
            </header>
            {!empty && (
              <div className="space-y-3 border-l-2 border-ink-200 pl-5">
                {teams.map(([num, md]) => {
                  const desc = teamDescriptors?.[num];
                  return (
                    <div key={num} className={['card p-4', isFlashing(`${num}:${name}`) ? 'animate-flash-in' : ''].join(' ')}>
                      <div className="text-[11px] uppercase tracking-wider text-ink-500 font-mono mb-1.5">
                        On Team {num}
                        {desc && <span className="ml-1 normal-case tracking-normal text-ink-500 italic"> · {desc}</span>}
                      </div>
                      <div className="prose-reaction">
                        <ReactMarkdown>{md}</ReactMarkdown>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function AddAttendeeBar() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function onAdd() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/add-attendee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`);
      } else {
        setResult(json);
        setName('');
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-2 text-[12px] font-mono">
      <span className="text-ink-500 uppercase tracking-wider">add attendee:</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onAdd()}
        placeholder="name (e.g. Aria Chen)"
        className="border border-ink-200 bg-white/70 rounded px-2 py-0.5 text-[12px] min-w-[180px]"
      />
      <button
        onClick={onAdd}
        disabled={busy || !name.trim()}
        className="bg-ink-900 text-ink-50 rounded px-2.5 py-0.5 text-[12px] disabled:opacity-40 hover:bg-amber-600 transition-colors"
      >
        {busy ? 'claiming…' : 'claim notebook'}
      </button>
      {result && (
        <span className="text-emerald-700">
          ✓ <span className="text-ink-500">{result.previousName} →</span> <span className="font-semibold">{result.newName}</span>
          {' · '}
          <a href={result.url} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-amber-600">
            open in Notion ↗
          </a>
        </span>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}

function PresentingPicker({ teams, current, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-ink-500 font-mono mr-1">presenting:</span>
      <button
        onClick={() => onChange(null)}
        className={[
          'text-[12px] px-2 py-1 rounded font-mono border',
          current == null
            ? 'bg-ink-900 text-ink-50 border-ink-900'
            : 'bg-white text-ink-500 border-ink-200 hover:border-ink-500',
        ].join(' ')}
      >
        none
      </button>
      {teams.map((t) => (
        <button
          key={t.num}
          onClick={() => onChange(t.num)}
          className={[
            'text-[12px] w-7 h-7 rounded font-mono border',
            current === t.num
              ? 'bg-amber-500 text-white border-amber-500'
              : 'bg-white text-ink-700 border-ink-200 hover:border-amber-400',
          ].join(' ')}
        >
          {t.num}
        </button>
      ))}
    </div>
  );
}

function MockAdder({ data, onAdded }) {
  const [team, setTeam] = useState('5');
  const [attendee, setAttendee] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (data?.mode !== 'mock') return null;
  const attendees = data.attendees || [];
  return (
    <div className="card p-3 mt-4 text-[13px]">
      <div className="text-[11px] uppercase tracking-wider text-ink-500 font-mono mb-2">
        Demo: add a mock reaction (mock mode only)
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[80px_180px_1fr_auto] gap-2 items-start">
        <input
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          placeholder="Team #"
          className="border border-ink-200 rounded px-2 py-1 font-mono text-[13px]"
        />
        <select
          value={attendee}
          onChange={(e) => setAttendee(e.target.value)}
          className="border border-ink-200 rounded px-2 py-1 text-[13px]"
        >
          <option value="">— attendee —</option>
          {attendees.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reaction (markdown OK)"
          rows={1}
          className="border border-ink-200 rounded px-2 py-1 text-[13px] min-h-[32px]"
        />
        <button
          disabled={busy || !team || !attendee || !text}
          onClick={async () => {
            setBusy(true);
            try {
              await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ team: Number(team), attendee, text }),
              });
              setText('');
              onAdded?.();
            } finally {
              setBusy(false);
            }
          }}
          className="bg-ink-900 text-ink-50 rounded px-3 py-1 text-[13px] disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { data, lastFetchedAt, error } = useFeedback(3000);
  const age = useAge(lastFetchedAt);
  const isFlashing = useFlashTracker(data?.reactions);
  const [view, setView] = useState('by-talk'); // 'by-talk' | 'by-attendee'

  // Stitch team list with live descriptors taking precedence over mock
  const teamsForView = useMemo(() => {
    if (!data) return [];
    const known = data.teamDescriptors || {};
    // Always show all 18 in order
    return Array.from({ length: 18 }, (_, i) => {
      const num = i + 1;
      return { num, descriptor: known[num] || null };
    });
  }, [data]);

  const teamsWithContent = useMemo(() => {
    if (!data?.reactions) return 0;
    let n = 0;
    for (const byA of Object.values(data.reactions)) {
      if (Object.values(byA).some((md) => md && md.trim())) n++;
    }
    return n;
  }, [data]);

  const contributors = useMemo(() => {
    if (!data?.reactions) return 0;
    const set = new Set();
    for (const byA of Object.values(data.reactions)) {
      for (const [name, md] of Object.entries(byA)) {
        if (md && md.trim()) set.add(name);
      }
    }
    return set.size;
  }, [data]);

  const setPresenting = async (num) => {
    await fetch('/api/presenting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num }),
    });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 backdrop-blur-md bg-ink-50/80 border-b border-ink-200/60">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <h1 className="font-serif text-[28px] sm:text-[32px] tracking-tight leading-none text-ink-900">
                Symposium <span className="italic text-ink-500">·</span> Live Reactions
              </h1>
              <div className="mt-1 text-[12px] font-mono text-ink-500 flex flex-wrap gap-x-4 gap-y-1 items-baseline">
                <span>
                  <span className="text-ink-900 font-semibold">{teamsWithContent}</span>/18 teams with reactions
                </span>
                <span>
                  <span className="text-ink-900 font-semibold">{contributors}</span> contributing
                </span>
                <span className={error ? 'text-red-600' : ''}>
                  {error ? `error: ${error}` : `refreshed ${age}`}
                </span>
                {data?.mode && (
                  <span
                    className={
                      data.stale
                        ? 'text-amber-600'
                        : data.mode === 'notion'
                        ? 'text-emerald-700'
                        : data.mode === 'notion-error'
                        ? 'text-red-600'
                        : 'text-amber-600'
                    }
                  >
                    {data.stale
                      ? 'stale (backoff)'
                      : data.mode === 'notion'
                      ? 'live · notion'
                      : data.mode === 'notion-error'
                      ? 'notion error'
                      : 'demo · mock'}
                  </span>
                )}
                {data?.masterViewUrl && (
                  <a
                    href={data.masterViewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-500 hover:text-amber-600 underline decoration-dotted underline-offset-2"
                    title="Notion's master by-talk page (where all synced blocks aggregate)"
                  >
                    ↗ master view in Notion
                  </a>
                )}
                {data?.hubUrl && (
                  <a
                    href={data.hubUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-500 hover:text-amber-600 underline decoration-dotted underline-offset-2"
                    title="The v5 hub — parent of all attendee notebooks"
                  >
                    ↗ hub
                  </a>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 text-[12px] font-mono">
              <button
                onClick={() => setView('by-talk')}
                className={[
                  'px-2.5 py-1 rounded',
                  view === 'by-talk' ? 'bg-ink-900 text-ink-50' : 'text-ink-500 hover:text-ink-900',
                ].join(' ')}
              >
                by talk
              </button>
              <button
                onClick={() => setView('by-attendee')}
                className={[
                  'px-2.5 py-1 rounded',
                  view === 'by-attendee' ? 'bg-ink-900 text-ink-50' : 'text-ink-500 hover:text-ink-900',
                ].join(' ')}
              >
                by attendee
              </button>
            </div>
          </div>
          {data?.mode === 'notion' && <AddAttendeeBar />}
          {data?.roster?.length > 0 && (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] font-mono">
              <span className="text-ink-500 uppercase tracking-wider mr-1">roster:</span>
              {data.roster.map((r, i) => {
                const hasReactions = !!data.reactions && Object.values(data.reactions).some((byA) => byA[r.name] && byA[r.name].trim());
                return (
                  <React.Fragment key={r.name}>
                    {i > 0 && <span className="text-ink-300">·</span>}
                    <a
                      href={r.url || '#'}
                      target="_blank"
                      rel="noreferrer"
                      className={[
                        'hover:text-amber-600 transition-colors',
                        hasReactions ? 'text-ink-900 font-semibold' : 'text-ink-500',
                      ].join(' ')}
                      title={hasReactions ? 'has reactions — click to open in Notion' : 'no reactions yet — click to open in Notion'}
                    >
                      {r.name}
                      {hasReactions && <span className="ml-0.5 text-amber-500">●</span>}
                    </a>
                  </React.Fragment>
                );
              })}
              <span className="text-ink-300 ml-1">
                {data.roster.length === 1 ? '(1 notebook)' : `(${data.roster.length} notebooks)`}
              </span>
            </div>
          )}
          <div className="mt-3">
            <PresentingPicker teams={teamsForView} current={data?.currentlyPresenting ?? null} onChange={setPresenting} />
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {!data ? (
          <div className="text-center py-24 text-ink-500 italic font-serif text-xl">loading…</div>
        ) : view === 'by-talk' ? (
          <>
            {teamsWithContent === 0 && data?.mode === 'notion' && (
              <div className="card p-5 mb-8 text-[14px] text-ink-700">
                <div className="font-serif text-[18px] text-ink-900 mb-1">Waiting for the first reaction.</div>
                <p className="text-ink-500 leading-relaxed">
                  {data?.roster?.length || 0} notebook{data?.roster?.length === 1 ? '' : 's'} discovered.
                  Seed text (<code className="px-1 bg-ink-100 rounded">(your reactions here)</code>) is filtered
                  out — so this view stays empty until an attendee types real content into a synced block.
                  Reactions appear here within ~5s of being typed in Notion.
                </p>
              </div>
            )}
            {teamsForView.map((team) => (
              <TeamBlock
                key={team.num}
                team={team}
                byAttendee={data.reactions?.[team.num]}
                notebookUrls={data.notebookUrls}
                isFlashing={isFlashing}
                isCurrent={data.currentlyPresenting === team.num}
              />
            ))}
            <MockAdder data={data} />
          </>
        ) : (
          <ByAttendeeView data={data} isFlashing={isFlashing} />
        )}

        {data?.errors?.length > 0 && (
          <details className="mt-8 text-[12px] text-red-700 font-mono">
            <summary>Notion errors ({data.errors.length})</summary>
            <pre className="whitespace-pre-wrap mt-2">{JSON.stringify(data.errors, null, 2)}</pre>
          </details>
        )}

        <footer className="mt-12 pb-12 text-center text-[11px] text-ink-500 font-mono">
          Reading from {data?.mode === 'notion' ? 'Notion' : 'mock data'} · polls every 3s · empty teams hidden
        </footer>
      </main>
    </div>
  );
}
