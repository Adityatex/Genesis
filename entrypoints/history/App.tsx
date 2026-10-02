// entrypoints/history/App.tsx
// The History page: past agent runs, and each one's timeline (lib/agent/timeline.ts).
// Opened from the side panel, and from a finished background or scheduled task's notification.
import { useCallback, useEffect, useState } from 'react';
import { formatDuration, formatRunLog, MAX_RUNS, type EntryKind, type RunLog, type TimelineEntry } from '@/lib/agent/timeline';

type RunHeader = Omit<RunLog, 'entries'> & { entryCount: number };

const STATUS_ICON: Record<string, string> = { running: '⏳', queued: '🕒', paused: '⏸️', done: '✅', error: '❌', stopped: '⏹️' };
const KIND: Record<EntryKind, { icon: string; label: string }> = {
  step: { icon: '▸', label: 'Step' },
  note: { icon: 'ℹ', label: 'Note' },
  model: { icon: '◆', label: 'Model' },
  check: { icon: '🛡', label: 'Safety check' },
  ask: { icon: '✋', label: 'Asked you' },
  pause: { icon: '⏸', label: 'Paused' },
  end: { icon: '■', label: 'End' },
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const host = (url?: string) => { try { return url ? new URL(url).host : ''; } catch { return ''; } };

/** "2 min ago", "yesterday 14:05", "3 Oct 09:12" */
function when(at: number): string {
  const ago = Date.now() - at;
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date().toDateString() === d.toDateString()) return `today ${time}`;
  if (new Date(Date.now() - 86_400_000).toDateString() === d.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

const send = (action: string, payload?: unknown) => browser.runtime.sendMessage({ action, payload }) as Promise<any>;

export default function App() {
  const [runs, setRuns] = useState<RunHeader[] | null>(null);
  const [selected, setSelected] = useState<string>(() => decodeURIComponent(location.hash.slice(1)));
  const [run, setRun] = useState<RunLog | null>(null);

  const loadRuns = useCallback(() => send('LIST_RUNS').then((res) => { if (res?.success) setRuns(res.data); }).catch(() => {}), []);
  const loadRun = useCallback((id: string) => {
    if (!id) return setRun(null);
    send('GET_RUN', { id }).then((res) => { if (res?.success) setRun(res.data); }).catch(() => {});
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  // Open the newest run if none was asked for
  useEffect(() => { if (!selected && runs?.length) setSelected(runs[0].id); }, [runs, selected]);
  useEffect(() => {
    loadRun(selected);
    if (selected && location.hash.slice(1) !== selected) history.replaceState(null, '', `#${selected}`);
  }, [selected, loadRun]);
  useEffect(() => {
    const onHash = () => setSelected(decodeURIComponent(location.hash.slice(1)));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Runs still going: follow them
  const live = !!runs?.some((r) => !r.ended);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { loadRuns(); loadRun(selected); }, 3000);
    return () => clearInterval(timer);
  }, [live, selected, loadRuns, loadRun]);

  const remove = async (id?: string) => {
    if (!id && !confirm('Delete every saved run?')) return;
    await send('DELETE_RUNS', id ? { id } : {});
    if (!id || id === selected) setSelected('');
    loadRuns();
  };

  const exportRun = () => {
    if (!run) return;
    const blob = new Blob([formatRunLog(run)], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `tabi-run-${new Date(run.started).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Run history</h1>
          <p className="muted">
            What the agent did, step by step: the last {MAX_RUNS} runs, kept only in this browser. Typed passwords and card numbers are masked.
          </p>
        </div>
        {runs && runs.length > 0 && <button className="ghost" onClick={() => remove()}>Delete all</button>}
      </header>

      {runs === null ? null : runs.length === 0 ? (
        <div className="empty">
          <p><strong>No runs yet.</strong></p>
          <p className="muted">Every task the agent runs shows up here: from the side panel, in the background, on a schedule, or from an AI app through MCP.</p>
        </div>
      ) : (
        <div className="columns">
          <nav className="runs">
            {runs.map((r) => (
              <button key={r.id} className={`run-item${r.id === selected ? ' selected' : ''}`} onClick={() => setSelected(r.id)}>
                <span className="run-goal"><span className="status">{r.ended ? STATUS_ICON[r.status] ?? '•' : '⏳'}</span>{r.goal}</span>
                <span className="muted small">
                  {when(r.started)} · {r.ended ? formatDuration(r.ended - r.started) : 'running'} · {r.calls} call{r.calls === 1 ? '' : 's'}
                  {r.workflow ? ` · /${r.workflow}` : ''}
                </span>
              </button>
            ))}
          </nav>

          <main className="detail">
            {!run ? <p className="muted">Pick a run.</p> : (
              <>
                <div className="detail-head">
                  <div>
                    <h2>{run.goal}</h2>
                    <p className="muted small">
                      {STATUS_ICON[run.status]} {run.ended ? run.status : 'running'} · {new Date(run.started).toLocaleString()}
                      {run.ended ? ` · took ${formatDuration(run.ended - run.started)}` : ''} · {run.calls} model call{run.calls === 1 ? '' : 's'}
                      {run.tokens ? ` · ${run.tokens.toLocaleString()} tokens` : ''}
                      {run.checks ? ` · ${run.checks} safety check${run.checks === 1 ? '' : 's'}` : ''}
                      {run.workflow ? ` · workflow /${run.workflow}` : ''}
                    </p>
                    {run.summary && <p className="summary">{run.summary}</p>}
                  </div>
                  <div className="actions">
                    <button className="ghost" onClick={exportRun}>Export</button>
                    <button className="ghost" onClick={() => remove(run.id)}>Delete</button>
                  </div>
                </div>
                <ol className="timeline">
                  {run.entries.map((e, i) => <Entry key={i} entry={e} newSite={host(e.url) !== host(run.entries[i - 1]?.url)} />)}
                </ol>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/** One timeline entry; the site shows only where it changes. */
function Entry({ entry: e, newSite }: { entry: TimelineEntry; newSite: boolean }) {
  const kind = KIND[e.kind];
  // "click [3] → ✅ Clicked ...": the action, then what came of it
  const [action, ...rest] = e.kind === 'step' ? e.text.split(' → ') : [e.text];
  const result = rest.join(' → ');
  const meta = [e.target ? `on "${e.target}"` : '', e.model, e.ms !== undefined ? formatDuration(e.ms) : '', e.tokens ? `${e.tokens.toLocaleString()} tokens` : '', newSite ? host(e.url) : ''].filter(Boolean);
  const failed = /^(❌|⛔)/.test(result) || (e.kind === 'check' && e.text.startsWith("Doesn't"));
  return (
    <li className={`entry kind-${e.kind}${failed ? ' failed' : ''}`}>
      <span className="time">{clock(e.at)}</span>
      <span className="icon" title={kind.label}>{kind.icon}</span>
      <div className="body">
        <div className="text">
          {e.kind === 'step' ? <><strong>{action}</strong>{result && <span className="result"> → {result}</span>}</> : e.text}
        </div>
        {meta.length > 0 && <div className="muted small">{meta.join(' · ')}</div>}
        {e.detail && (
          e.kind === 'model'
            ? <details><summary className="muted small">What it saw</summary><pre>{e.detail}</pre></details>
            : <div className="detail-text small">{e.detail}</div>
        )}
      </div>
    </li>
  );
}
