// entrypoints/sidebar.content/components/SaveSkillBar.tsx
// After a task finishes: offer to keep it, as a skill (instructions the agent
// follows next time) and/or a workflow (its exact steps, replayed without a
// model). After a replay the agent had to rescue: offer to update the workflow.
import { useState } from 'react';
import { BookmarkPlus, Repeat, Zap } from 'lucide-react';

interface Props {
  /** Offer "Save as skill" (not after a replay). */
  skill: boolean;
  /** Offer the workflow button, and what it says; null = not replayable. */
  workflow: 'save' | 'update' | null;
  /** Why it can't be a workflow, shown instead of the button. */
  unrecordable?: string;
  onSaveSkill: () => Promise<void>;
  onSaveWorkflow: () => Promise<void>;
  /** Save the task's wording as a /shortcut. */
  onSaveShortcut: () => Promise<void>;
  onDismiss: () => void;
}

export default function SaveSkillBar({ skill, workflow, unrecordable, onSaveSkill, onSaveWorkflow, onSaveShortcut, onDismiss }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const text = busy
    ? `${busy}...`
    : workflow === 'update'
      ? 'The saved steps no longer fit, and the agent finished the task. Update the workflow with what worked?'
      : 'Done. Keep this for next time?';

  return (
    <div className="px-3 py-2 bg-[#161920] border-t border-[#242933] flex flex-wrap items-center gap-2">
      <span className="flex-1 min-w-[140px] text-[11px] text-slate-400" title={unrecordable}>{text}</span>
      {skill && (
        <button
          onClick={() => run('Writing a skill', onSaveSkill)}
          disabled={!!busy}
          title="Instructions the agent follows on similar tasks"
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 text-white text-[11px] hover:bg-blue-500 transition-colors disabled:opacity-50"
        >
          <BookmarkPlus size={12} /> Save as skill
        </button>
      )}
      {workflow && (
        <button
          onClick={() => run(workflow === 'update' ? 'Updating the workflow' : 'Saving the workflow', onSaveWorkflow)}
          disabled={!!busy}
          title="The exact steps, replayed without a model: instant and free"
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-violet-600 text-white text-[11px] hover:bg-violet-500 transition-colors disabled:opacity-50"
        >
          <Repeat size={12} /> {workflow === 'update' ? 'Update workflow' : 'Save as workflow'}
        </button>
      )}
      {skill && (
        <button
          onClick={() => run('Saving the shortcut', onSaveShortcut)}
          disabled={!!busy}
          title="Save how you asked for this, to run again with /name"
          className="flex items-center gap-1 px-2.5 py-1 rounded border border-[#242933] text-slate-300 text-[11px] hover:border-amber-500/50 hover:text-amber-300 transition-colors disabled:opacity-50"
        >
          <Zap size={12} /> Save as shortcut
        </button>
      )}
      {!busy && (
        <button onClick={onDismiss} className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300">
          No thanks
        </button>
      )}
    </div>
  );
}
