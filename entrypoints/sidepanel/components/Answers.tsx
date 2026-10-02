// entrypoints/sidepanel/components/Answers.tsx
// Questions about the page and their answers, and the page commands
// (summarize, explain, autofill). Answering only reads the page: it never
// clicks, and says so.
import { useEffect, useRef } from 'react';
import { MessageCircle, Zap } from 'lucide-react';
import TabiMark from '@/components/TabiMark';
import { renderMarkdown } from '@/lib/utils/markdown';

export interface Answer {
  id: string;
  /** What the user asked or chose, e.g. "Summarize this page". */
  question: string;
  answer?: string;
  error?: string;
  /** A question that could be done instead of answered. */
  canDo?: boolean;
  /** Not from the page: autofill fills it in, so it doesn't say "nothing clicked". */
  acted?: boolean;
}

interface Props {
  answers: Answer[];
  onDoInstead: (question: string) => void;
}

export default function Answers({ answers, onDoInstead }: Props) {
  const end = useRef<HTMLDivElement>(null);
  const last = answers[answers.length - 1];
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [answers.length, last?.answer, last?.error]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin pt-4 px-[14px] pb-[10px] flex flex-col gap-[14px]" data-testid="answers">
      <div className="flex-1" />
      {answers.map((a) => (
        <div key={a.id} className="flex flex-col gap-[10px]">
          <div className="self-end max-w-[85%] px-3 py-2 rounded-ctl bg-surface border border-border [overflow-wrap:anywhere] whitespace-pre-wrap">{a.question}</div>
          {a.answer === undefined && !a.error && (
            <div className="flex items-center gap-2 text-muted text-[12px]" role="status"><TabiMark state="reading" size={14} label="" />Reading the page…</div>
          )}
          {a.error && <div className="text-red text-[13px] [overflow-wrap:anywhere]" role="alert">{a.error}</div>}
          {a.answer !== undefined && (
            <>
              <div className="flex items-center gap-2 text-[12px] text-muted flex-wrap">
                <span className="flex items-center gap-[5px] h-[22px] px-2 rounded-full bg-accent-soft text-accent font-semibold text-[11.5px]">
                  {a.acted ? <Zap size={12} aria-hidden /> : <MessageCircle size={12} aria-hidden />}{a.acted ? 'Done' : 'Answered'}
                </span>
                {!a.acted && 'Read this page only · nothing clicked'}
                <div className="flex-1" />
                {a.canDo && <button type="button" className="font-medium text-accent" onClick={() => onDoInstead(a.question)}>Do it instead</button>}
              </div>
              <div className="answer text-[14px] leading-[1.55] [text-wrap:pretty] [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.answer) }} />
            </>
          )}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
