// entrypoints/sidebar.content/components/SidebarHeader.tsx
import { X } from 'lucide-react';
import GenesisLogo from './GenesisLogo';

export default function SidebarHeader({ status, onClose }: { status: string; onClose: () => void }) {
  return (
    <header className="px-4 py-3 bg-[#161920] border-b border-[#242933] flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 flex items-center justify-center">
          <GenesisLogo size={32} />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-white tracking-tight">Genesis Copilot</h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className={`w-1.5 h-1.5 rounded-full ${status === 'WORKING' ? 'bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)]' : 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.5)]'}`} />
            <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{status}</span>
          </div>
        </div>
      </div>
      <button
        onClick={onClose}
        className="p-1.5 hover:bg-white/10 rounded transition-colors text-slate-500 hover:text-white"
        title="Close sidebar"
      >
        <X size={16} />
      </button>
    </header>
  );
}
