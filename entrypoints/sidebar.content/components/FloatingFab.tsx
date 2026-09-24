// entrypoints/sidebar.content/components/FloatingFab.tsx
import { MessageSquare } from 'lucide-react';
import GenesisLogo from './GenesisLogo';

interface Props {
  fabPos: { x: number; y: number };
  isHovered: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onHover: (h: boolean) => void;
}

export default function FloatingFab(p: Props) {
  return (
    <>
      <div
        onPointerDown={p.onPointerDown}
        onPointerMove={p.onPointerMove}
        onPointerUp={p.onPointerUp}
        onMouseEnter={() => p.onHover(true)}
        onMouseLeave={() => p.onHover(false)}
        className="fixed z-[2147483647] w-[52px] h-[52px] rounded-full bg-[#0d0f14] text-white flex items-center justify-center shadow-[0_4px_24px_rgba(99,102,241,0.4)] hover:shadow-[0_4px_32px_rgba(99,102,241,0.6)] hover:scale-110 active:scale-95 transition-shadow cursor-grab active:cursor-grabbing border border-indigo-500/30 select-none touch-none"
        style={{ left: p.fabPos.x, top: p.fabPos.y }}
        title="Open Genesis Copilot"
      >
        <div className="relative w-7 h-7 pointer-events-none">
          <div
            className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${p.isHovered ? 'opacity-0 scale-75' : 'opacity-100 scale-100'}`}
          >
            <GenesisLogo size={28} />
          </div>
          <MessageSquare
            size={20}
            className={`absolute inset-0 m-auto transition-all duration-200 ${p.isHovered ? 'opacity-100 scale-100' : 'opacity-0 scale-75'}`}
          />
        </div>
      </div>
      <style>{`
        @keyframes fab-appear {
          from { opacity: 0; transform: scale(0.5) translateY(20px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        div[title="Open Genesis Copilot"] {
          animation: fab-appear 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
      `}</style>
    </>
  );
}
