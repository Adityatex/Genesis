// entrypoints/sidebar.content/components/TasksChip.tsx
// "2 tasks running elsewhere": the agent's tasks in other tabs (background
// tasks, other sidebars, schedules), with Open / Stop / Continue, and Allow /
// Don't when one asks before doing something that can't be undone.
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Layers } from 'lucide-react';

export interface TaskInfo {
  tabId: number;
  goal: string;
  status: string;
  step: number;
  title?: string;
  background?: boolean;
  /** The tab asking: its task shows in its own chat. */
  here?: boolean;
  /** Waiting for the user to allow this (see RunView.asking). */
  asking?: { action: string; risk: string };
}

const ICON: Record<string, string> = { running: '⏳', queued: '🕒', paused: '⏸️', done: '✅', error: '❌', stopped: '⏹️' };

/** Tasks in other tabs, refreshed while the sidebar is open. */
export default function TasksChip() {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => browser.runtime.sendMessage({ action: 'LIST_TASKS' })
      .then((res: any) => { if (alive && res?.success) setTasks(res.data); })
      .catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // This tab's own task shows in the chat; list the others (already sorted, active first)
  const others = tasks.filter((t) => !t.here);
  const active = others.filter((t) => ['running', 'queued', 'paused'].includes(t.status));
  if (others.length === 0) return null;

  const control = (tabId: number, op: 'open' | 'stop' | 'continue' | 'allow' | 'deny') =>
    browser.runtime.sendMessage({ action: 'TASK_CONTROL', payload: { tabId, op } }).catch(() => {});

  return (
    <div className="px-3 py-1.5 bg-[#12141a] border-t border-[#242933] text-[11px]">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-1.5 text-slate-400 hover:text-slate-200">
        <Layers size={12} className="text-violet-400" />
        <span className="flex-1 text-left">
          {active.length ? `${active.length} task${active.length === 1 ? '' : 's'} running elsewhere` : `${others.length} recent task${others.length === 1 ? '' : 's'} elsewhere`}
        </span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 max-h-40 overflow-y-auto">
          {others.map((t) => (
            <li key={t.tabId} className="flex items-center gap-1.5">
              <span title={t.status}>{ICON[t.status] ?? '•'}</span>
              <span className="flex-1 truncate text-slate-300" title={t.goal}>
                {t.goal || t.title}{t.status === 'running' ? ` · step ${t.step}` : t.status === 'queued' ? ' · waiting' : t.asking ? ` · wants to ${t.asking.action}` : ''}
              </span>
              <button onClick={() => control(t.tabId, 'open')} className="text-slate-500 hover:text-blue-400">Open</button>
              {t.status === 'paused' && !t.asking && <button onClick={() => control(t.tabId, 'continue')} className="text-slate-500 hover:text-blue-400">Continue</button>}
              {t.asking && <button onClick={() => control(t.tabId, 'allow')} className="text-amber-400 hover:text-amber-300">Allow</button>}
              {t.asking && <button onClick={() => control(t.tabId, 'deny')} className="text-slate-500 hover:text-red-400">Don't</button>}
              {['running', 'queued', 'paused'].includes(t.status) && (
                <button onClick={() => control(t.tabId, 'stop')} className="text-slate-500 hover:text-red-400">Stop</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
