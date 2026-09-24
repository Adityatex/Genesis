// entrypoints/sidebar.content/components/MessageList.tsx
import { Sparkles, ChevronRight } from 'lucide-react';
import { renderMarkdown } from '@/lib/utils/markdown';
import type { Message } from '../hooks/useChatMessages';

interface Props {
  messages: Message[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onDetectElements: () => void;
  onSummarize: () => void;
}

export default function MessageList({ messages, messagesEndRef, onDetectElements, onSummarize }: Props) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col bg-[#090a0f] border-t border-[#242933] overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-10 h-10 rounded-full bg-blue-500/5 flex items-center justify-center mb-3 border border-blue-500/10">
            <Sparkles className="text-blue-500/40" size={20} />
          </div>
          <h3 className="text-sm font-medium text-slate-200 mb-2">Ready for Automation</h3>
          <p className="text-xs text-slate-500 leading-relaxed max-w-[220px]">
            Select a tool above to begin scanning the current tab or ask a question.
          </p>

          <div className="mt-6 w-full space-y-2">
            <button
              onClick={onDetectElements}
              className="w-full text-left px-3 py-2 rounded border border-[#242933] bg-[#161920] hover:bg-[#1c212b] text-[11px] text-slate-400 flex items-center justify-between group"
            >
              <span>Find all input fields</span>
              <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-400" />
            </button>
            <button
              onClick={onSummarize}
              className="w-full text-left px-3 py-2 rounded border border-[#242933] bg-[#161920] hover:bg-[#1c212b] text-[11px] text-slate-400 flex items-center justify-between group"
            >
              <span>Summarize technical docs</span>
              <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-400" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#090a0f] border-t border-[#242933] overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-[radial-gradient(circle_at_top_right,_#1a1f2b_0%,_transparent_20%)]">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.type === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[90%] px-3 py-2 rounded shadow-sm text-xs leading-relaxed ${
              m.type === 'user'
              ? 'bg-blue-600 text-white border border-blue-500'
              : 'bg-[#161920] text-slate-300 border border-[#242933]'
            } ${m.isLoading ? 'opacity-80 animate-pulse' : ''}`}>
              {m.type === 'bot' ? (
                <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              ) : (
                m.text
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
