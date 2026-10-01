// entrypoints/sidebar.content/components/AgentControls.tsx
// Stop a running agent; continue or stop a paused one; allow (or not) an
// action that can't be undone.
import { useEffect, useState } from 'react';
import { Check, Hand, Play, Square, X } from 'lucide-react';
import type { RunView } from '@/lib/agent/runner';

interface Props {
  paused: boolean;
  /** Waiting for a free slot (too many tasks running at once). */
  queued?: boolean;
  /** The agent asks before doing something that can't be undone. */
  asking?: RunView['asking'];
  onContinue: () => void;
  onAnswer: (allow: boolean) => void;
  onStop: () => void;
}

export default function AgentControls({ paused, queued, asking, onContinue, onAnswer, onStop }: Props) {
  // A running agent stops after its current step, which can take a few seconds
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [paused]);

  const stop = () => {
    setStopping(true);
    onStop();
  };

  if (asking) {
    return (
      <div data-asking={asking.action} className="px-3 py-2 bg-amber-500/10 border-t border-amber-500/40 flex flex-col gap-2">
        <span className="flex items-start gap-1.5 text-[11px] text-amber-200">
          <Hand size={13} className="mt-px shrink-0 text-amber-400" />
          <span>
            Allow the agent to <strong>{asking.action}</strong>? It looks like {asking.risk}, which can't be undone.
          </span>
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onAnswer(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500 text-black text-[11px] font-medium hover:bg-amber-400 transition-colors"
          >
            <Check size={12} /> Allow
          </button>
          <button
            onClick={() => onAnswer(false)}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-[#242933] text-slate-200 text-[11px] hover:border-slate-500 transition-colors"
          >
            <X size={12} /> Don't allow
          </button>
          <button
            onClick={stop}
            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded border border-[#242933] text-slate-300 text-[11px] hover:border-red-500/50 hover:text-red-400 transition-colors"
          >
            <Square size={12} /> Stop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 bg-[#161920] border-t border-[#242933] flex items-center gap-2">
      <span className="flex-1 text-[11px] text-slate-400">
        {paused ? 'Agent paused. Keep going?' : queued ? 'Waiting for a free slot...' : stopping ? 'Stopping after this step...' : 'Agent is working...'}
      </span>
      {paused && (
        <button
          onClick={onContinue}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 text-white text-[11px] hover:bg-blue-500 transition-colors"
        >
          <Play size={12} /> Continue
        </button>
      )}
      <button
        onClick={stop}
        disabled={stopping}
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-[#242933] text-slate-300 text-[11px] hover:border-red-500/50 hover:text-red-400 transition-colors disabled:opacity-50"
      >
        <Square size={12} /> Stop
      </button>
    </div>
  );
}
