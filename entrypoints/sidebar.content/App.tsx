// entrypoints/sidebar.content/App.tsx
// Thin composition shell — logic lives in hooks/, lib/agent/loop.ts, components/.
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
import { useAgentLoop } from './hooks/useAgentLoop';
import { useWorkspaceTools } from './hooks/useWorkspaceTools';
import FloatingFab from './components/FloatingFab';
import SidebarHeader from './components/SidebarHeader';
import ToolsGrid, { type ToolDef } from './components/ToolsGrid';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [status, setStatus] = useState('ACTIVE');
  const [chatInput, setChatInput] = useState('');

  const chat = useChatMessages();
  const agent = useAgentLoop();

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
    stopAgent: agent.stop,
    runFreshLoop: agent.runFreshLoop,
  });

  // Resume saved agent session after navigation (same behavior as before)
  const sessionChecked = useRef(false);
  useEffect(() => {
    agent.checkAndResume({
      onOpened: () => setSidebarOpen(true),
      onWorking: (w) => setStatus(w ? 'WORKING' : 'ACTIVE'),
      onResumeFound: (goal, historyLog) =>
        chat.addBotMessage(
          `🤖 **Agent Resumed** — Continuing task on new page...\n\n**Goal:** ${goal}\n\n**Previous steps:**\n${historyLog}\n\n*Scanning new page...*`,
          true,
        ),
      onProgress: (msgId, text, loading) => chat.updateBotMessage(msgId, text, loading),
    }, sessionChecked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
