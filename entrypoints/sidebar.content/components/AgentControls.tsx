// entrypoints/sidebar.content/components/AgentControls.tsx
// Stop a running agent; continue or stop a paused one.
import { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';

interface Props {
  paused: boolean;
  /** Waiting for a free slot (too many tasks running at once). */
  queued?: boolean;
  onContinue: () => void;
  onStop: () => void;
}

export default function AgentControls({ paused, queued, onContinue, onStop }: Props) {
  // A running agent stops after its current step, which can take a few seconds
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [paused]);

  const stop = () => {
    setStopping(true);
    onStop();
  };

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
