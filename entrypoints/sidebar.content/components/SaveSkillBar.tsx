// entrypoints/sidebar.content/components/SaveSkillBar.tsx
// After a task finishes: offer to turn it into a skill for next time.
import { useState } from 'react';
import { BookmarkPlus } from 'lucide-react';

interface Props {
  /** Resolves with a message to show; throws if saving failed. */
  onSave: () => Promise<void>;
  onDismiss: () => void;
}

export default function SaveSkillBar({ onSave, onDismiss }: Props) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-3 py-2 bg-[#161920] border-t border-[#242933] flex items-center gap-2">
      <span className="flex-1 text-[11px] text-slate-400">
        {saving ? 'Writing a skill from this task...' : 'Done. Save it as a skill, so it goes faster next time?'}
      </span>
      <button
        onClick={save}
        disabled={saving}
        className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 text-white text-[11px] hover:bg-blue-500 transition-colors disabled:opacity-50"
      >
        <BookmarkPlus size={12} /> Save as skill
      </button>
      {!saving && (
        <button onClick={onDismiss} className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300">
          No thanks
        </button>
      )}
    </div>
  );
}
