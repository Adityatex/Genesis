// entrypoints/sidebar.content/components/ChatInput.tsx
import { useEffect, useRef, useState } from 'react';
import { Send, Repeat, Zap, SquareStack } from 'lucide-react';
import { matchItems, type PickerItem } from '@/lib/shortcuts/shortcut';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  disabled: boolean;
  /** Workflows and shortcuts for the / picker. */
  pickerItems: PickerItem[];
  /** Reload them (typing / starts a fresh look). */
  onRefreshPicker: () => void;
  /** Run what's typed in a new background tab instead of this one. */
  onBackground: () => void;
}

export default function ChatInput({ value, onChange, onSubmit, disabled, pickerItems, onRefreshPicker, onBackground }: Props) {
  // The / picker shows while the name is being typed ("/pri"), not its words ("/price-check shoes")
  const typingName = /^\/\S*$/.test(value);
  const matches = typingName ? matchItems(value.slice(1), pickerItems) : [];
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // The sidebar is in a Shadow DOM, where document.activeElement is its host: reach the form directly
  const formRef = useRef<HTMLFormElement>(null);
  const open = matches.length > 0 && !dismissed;

  useEffect(() => { setHighlight(0); }, [value]);
  useEffect(() => {
    if (value === '/') {
      setDismissed(false);
      onRefreshPicker();
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (item: PickerItem, run: boolean) => {
    onChange(`/${item.name}${run ? '' : ' '}`);
    // Run on the next tick, once the input holds the name
    if (run) setTimeout(() => formRef.current?.requestSubmit(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        pick(matches[highlight], false); // complete the name, to add words after it
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && value.slice(1) !== matches[highlight].name) {
        e.preventDefault();
        pick(matches[highlight], true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as any);
    }
  };

  return (
    <footer className="p-3 bg-[#161920] border-t border-[#242933] relative">
      {open && (
        <ul
          role="listbox"
          aria-label="Workflows and shortcuts"
          className="absolute left-3 right-3 bottom-full mb-1 max-h-60 overflow-y-auto rounded border border-[#242933] bg-[#0d0f14] shadow-xl z-10"
        >
          {matches.map((item, i) => (
            <li
              key={`${item.kind}:${item.name}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => { e.preventDefault(); pick(item, true); }}
              onMouseEnter={() => setHighlight(i)}
              className={`px-3 py-1.5 cursor-pointer flex items-start gap-2 ${i === highlight ? 'bg-[#1c212b]' : ''}`}
            >
              {item.kind === 'workflow'
                ? <Repeat size={12} className="mt-0.5 text-violet-400 shrink-0" />
                : <Zap size={12} className="mt-0.5 text-amber-400 shrink-0" />}
              <span className="min-w-0">
                <span className="block text-[11px] text-slate-200">/{item.name}</span>
                <span className="block text-[10px] text-slate-500 truncate">
                  {item.kind === 'workflow' ? 'Replay, no model: ' : ''}{item.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="relative flex flex-col bg-[#0d0f14] border border-[#242933] rounded focus-within:border-blue-500/50 transition-all overflow-hidden"
      >
        <textarea
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="Describe action or ask question... (/ for workflows and shortcuts)"
          className="w-full bg-transparent p-3 pr-20 text-xs text-slate-200 outline-none placeholder:text-slate-600 resize-none min-h-[44px] disabled:opacity-50"
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          <button
            type="button"
            onClick={onBackground}
            title="Run in a new background tab (you stay here)"
            aria-label="Run in background"
            className="p-1.5 rounded border border-[#242933] text-slate-400 hover:text-violet-300 hover:border-violet-500/50 transition-colors disabled:opacity-30"
            disabled={!value.trim()}
          >
            <SquareStack size={14} />
          </button>
          <button
            type="submit"
            className="p-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-30 disabled:grayscale"
            disabled={!value.trim() || disabled}
          >
            <Send size={14} />
          </button>
        </div>
      </form>
      <div className="mt-2 flex items-center justify-end px-1">
        <div className="flex items-center gap-2">
          <button className="text-[10px] text-slate-500 hover:text-blue-400 font-medium transition-colors">Documentation</button>
        </div>
      </div>
    </footer>
  );
}
