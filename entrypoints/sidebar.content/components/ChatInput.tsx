// entrypoints/sidebar.content/components/ChatInput.tsx
import { Send } from 'lucide-react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  disabled: boolean;
}

export default function ChatInput({ value, onChange, onSubmit, disabled }: Props) {
  return (
    <footer className="p-3 bg-[#161920] border-t border-[#242933]">
      <form
        onSubmit={onSubmit}
        className="relative flex flex-col bg-[#0d0f14] border border-[#242933] rounded focus-within:border-blue-500/50 transition-all overflow-hidden"
      >
        <textarea
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="Describe action or ask question..."
          className="w-full bg-transparent p-3 pr-10 text-xs text-slate-200 outline-none placeholder:text-slate-600 resize-none min-h-[44px] disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e as any);
            }
          }}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          <button
            type="submit"
            className="p-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-30 disabled:grayscale"
            disabled={!value.trim() || disabled}
          >
            <Send size={14} />
          </button>
        </div>
      </form>
      <div className="mt-2 flex items-center justify-between px-1">
        <span className="text-[9px] text-slate-600 font-bold uppercase tracking-widest">Instance #8842-A</span>
        <div className="flex items-center gap-2">
          <button className="text-[10px] text-slate-500 hover:text-blue-400 font-medium transition-colors">Documentation</button>
        </div>
      </div>
    </footer>
  );
}
