// entrypoints/sidebar.content/components/ToolsGrid.tsx
import { Activity } from 'lucide-react';

export interface ToolDef {
  id: string;
  label: string;
  short: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export default function ToolsGrid({ tools, status }: { tools: ToolDef[]; status: string }) {
  return (
    <section className="p-3 bg-[#0d0f14]">
      <div className="flex items-center justify-between mb-2 px-1">
        <h2 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Workspace Tools</h2>
        <Activity size={12} className={`text-slate-600 ${status === 'WORKING' ? 'animate-pulse text-amber-500' : ''}`} />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {tools.map((tool) => (
          <button
            key={tool.id}
            title={tool.label}
            onClick={tool.onClick}
            disabled={status === 'WORKING' && tool.id !== 'clear'}
            className="group flex flex-col items-center justify-center py-2 px-1 rounded bg-[#161920] border border-[#242933] hover:border-blue-500/50 hover:bg-[#1c212b] transition-all active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100"
          >
            <div className="text-slate-400 group-hover:text-blue-400 transition-colors mb-1">
              {tool.icon}
            </div>
            <span className="text-[9px] font-medium text-slate-500 group-hover:text-slate-300 transition-colors">
              {tool.short}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
