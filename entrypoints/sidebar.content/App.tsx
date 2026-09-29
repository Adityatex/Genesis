// entrypoints/sidebar.content/App.tsx
// Thin composition shell — logic lives in hooks/, lib/agent/, components/.
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  FileText,
  ScanEye,
  TextCursorInput,
  AlignLeft,
  Lightbulb,
  Trash2,
} from 'lucide-react';
import { useChatMessages } from './hooks/useChatMessages';
import { useAgentRun } from './hooks/useAgentRun';
import { useWorkspaceTools } from './hooks/useWorkspaceTools';
import FloatingFab from './components/FloatingFab';
import SidebarHeader from './components/SidebarHeader';
import ToolsGrid, { type ToolDef } from './components/ToolsGrid';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import AgentControls from './components/AgentControls';
import SaveSkillBar from './components/SaveSkillBar';
import type { RunStatus } from '@/lib/agent/runner';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [status, setStatus] = useState('ACTIVE');
  const [chatInput, setChatInput] = useState('');

  const chat = useChatMessages();

  // Sidebar resize state
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const isResizing = useRef(false);

  // FAB drag state
  const [fabPos, setFabPos] = useState({ x: window.innerWidth - 72, y: window.innerHeight - 72 });
  const fabDragRef = useRef({ dragging: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0, moved: false });

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startX - ev.clientX;
      const newWidth = Math.min(800, Math.max(320, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  const handleFabPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    fabDragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startPosX: fabPos.x,
      startPosY: fabPos.y,
      moved: false,
    };
  }, [fabPos]);

  const handleFabPointerMove = useCallback((e: React.PointerEvent) => {
    const d = fabDragRef.current;
    if (!d.dragging) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    const newX = Math.min(window.innerWidth - 48, Math.max(0, d.startPosX + dx));
    const newY = Math.min(window.innerHeight - 48, Math.max(0, d.startPosY + dy));
    setFabPos({ x: newX, y: newY });
  }, []);

  const handleFabPointerUp = useCallback(() => {
    const d = fabDragRef.current;
    if (!d.moved) {
      setSidebarOpen(true);
    }
    fabDragRef.current = { ...d, dragging: false, moved: false };
  }, []);

  // The agent runs in the background and survives page loads. Show its state
  // in one chat message per run; after a navigation the new page picks it up.
  const agentMessageId = useRef<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<RunStatus | null>(null);
  // The finished run offered as a skill (by its last update time), and the ones already handled
  const [skillOffer, setSkillOffer] = useState<number | null>(null);
  const skillHandled = useRef(new Set<number>());
  const agent = useAgentRun((view) => {
    setSidebarOpen(true);
    setAgentStatus(view.status);
    setSkillOffer(view.status === 'done' && !skillHandled.current.has(view.updatedAt) ? view.updatedAt : null);
    setStatus(view.status === 'running' ? 'WORKING' : 'ACTIVE');
    const text = view.message || '🤖 **Agent Mode**: starting...';
    if (agentMessageId.current) chat.updateBotMessage(agentMessageId.current, text, view.loading);
    else agentMessageId.current = chat.addBotMessage(text, view.loading);
  });

  const closeSkillOffer = () => {
    if (skillOffer !== null) skillHandled.current.add(skillOffer);
    setSkillOffer(null);
  };

  const saveAsSkill = async () => {
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_SKILL_FROM_RUN' }).catch((err: Error) => ({ error: err.message }));
    closeSkillOffer();
    if (!res?.success) {
      chat.addBotMessage(`**Couldn't save a skill:** ${res?.error || 'unknown error'}`);
      return;
    }
    const { skill, markdown } = res.data;
    const fence = '```';
    chat.addBotMessage(
      `## 🧠 Skill saved: ${skill.name}\n\n${skill.description}\n\n`
      + `The agent will use it for similar tasks. You can edit or delete it in the Genesis popup.\n\n${fence}markdown\n${markdown}${fence}`,
    );
  };

  const startAgent = async (goal: string) => {
    setSkillOffer(null);
    agentMessageId.current = chat.addBotMessage('🤖 **Agent Mode**: starting...', true);
    await agent.start(goal);
  };

  const toolsApi = useWorkspaceTools({
    pageText: chat.pageText,
    setPageText: chat.setPageText,
    setMessages: chat.setMessages,
    addBotMessage: chat.addBotMessage,
    updateBotMessage: chat.updateBotMessage,
    pushUserMessage: chat.pushUserMessage,
    setStatus,
    chatInput,
    setChatInput,
    startAgent,
    stopAgent: (forget) => {
      agent.stop(forget);
      if (forget) {
        agentMessageId.current = null;
        setAgentStatus(null);
      }
    },
  });

  const tools: ToolDef[] = [
    { id: 'text', label: 'Extract Text', icon: <FileText size={16} />, short: 'Text', onClick: toolsApi.handleExtractText },
    { id: 'scan', label: 'Detect Inputs', icon: <ScanEye size={16} />, short: 'Scan', onClick: toolsApi.handleDetectElements },
    { id: 'fill', label: 'Auto Fill', icon: <TextCursorInput size={16} />, short: 'Fill', onClick: toolsApi.handleAutoFill },
    { id: 'sum', label: 'Summarize', icon: <AlignLeft size={16} />, short: 'Sum', onClick: toolsApi.handleSummarize },
    { id: 'idea', label: 'Explain', icon: <Lightbulb size={16} />, short: 'Idea', onClick: toolsApi.handleExplainSelection },
    { id: 'clear', label: 'Clear All', icon: <Trash2 size={16} />, short: 'Clear', onClick: toolsApi.handleClear },
  ];

  if (!sidebarOpen) {
    return (
      <FloatingFab
        fabPos={fabPos}
        isHovered={isHovered}
        onPointerDown={handleFabPointerDown}
        onPointerMove={handleFabPointerMove}
        onPointerUp={handleFabPointerUp}
        onHover={setIsHovered}
      />
    );
  }

  return (
    <div
      className="flex flex-col h-screen bg-[#0d0f14] text-slate-300 font-sans border-l border-[#242933] shadow-xl overflow-hidden selection:bg-blue-500/30 relative"
      style={{ width: sidebarWidth, minWidth: 320, maxWidth: 800 }}
    >
      <div
        onMouseDown={handleResizeStart}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 group flex items-center justify-center hover:bg-blue-500/20 transition-colors"
        title="Drag to resize"
      >
        <div className="w-0.5 h-8 rounded-full bg-slate-700 group-hover:bg-blue-500 transition-colors" />
      </div>

      <SidebarHeader status={status} onClose={() => setSidebarOpen(false)} />
      <ToolsGrid tools={tools} status={status} />
      <MessageList
        messages={chat.messages}
        messagesEndRef={chat.messagesEndRef}
        onDetectElements={toolsApi.handleDetectElements}
        onSummarize={toolsApi.handleSummarize}
      />
      {skillOffer !== null && <SaveSkillBar onSave={saveAsSkill} onDismiss={closeSkillOffer} />}
      {(agentStatus === 'running' || agentStatus === 'paused') && (
        <AgentControls paused={agentStatus === 'paused'} onContinue={agent.resume} onStop={() => agent.stop()} />
      )}
      <ChatInput
        value={chatInput}
        onChange={setChatInput}
        onSubmit={toolsApi.handleSendMessage}
        disabled={status === 'WORKING'}
      />

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #242933;
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3a4150;
        }
      `}</style>
    </div>
  );
}
