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
import TasksChip from './components/TasksChip';
import type { RunStatus, RunView } from '@/lib/agent/runner';
import type { PickerItem } from '@/lib/shortcuts/shortcut';

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
  // The finished run offered to keep (as a skill or workflow), and the ones already handled (by update time)
  const [skillOffer, setSkillOffer] = useState<RunView | null>(null);
  const skillHandled = useRef(new Set<number>());
  const agent = useAgentRun((view) => {
    setSidebarOpen(true);
    setAgentStatus(view.status);
    // A workflow that replayed cleanly is already saved: nothing to offer
    const offer = view.status === 'done' && view.replay !== 'replayed' && !skillHandled.current.has(view.updatedAt);
    setSkillOffer(offer ? view : null);
    setStatus(view.status === 'running' ? 'WORKING' : 'ACTIVE');
    const text = view.message || '🤖 **Agent Mode**: starting...';
    if (agentMessageId.current) chat.updateBotMessage(agentMessageId.current, text, view.loading);
    else agentMessageId.current = chat.addBotMessage(text, view.loading);
  });

  const closeSkillOffer = () => {
    if (skillOffer !== null) skillHandled.current.add(skillOffer.updatedAt);
    setSkillOffer(null);
  };

  const saveAsShortcut = async () => {
    const goal = skillOffer?.goal ?? '';
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_SHORTCUT', payload: { prompt: goal } }).catch((err: Error) => ({ error: err.message }));
    closeSkillOffer();
    if (!res?.success) {
      chat.addBotMessage(`**Couldn't save a shortcut:** ${res?.error || 'unknown error'}`);
      return;
    }
    const saved = (res.data as { name: string; prompt: string }[]).find((s) => s.prompt === goal.trim());
    refreshPicker();
    chat.addBotMessage(`## ⚡ Shortcut saved: /${saved?.name}

Type **/${saved?.name}** to ask for this again. To make part of it fill-in, edit it in the Genesis popup and write that part as a blank in braces, like {product}.`);
  };

  const saveAsWorkflow = async () => {
    // After a rescued replay, update that workflow rather than making a new one
    const name = skillOffer?.replay === 'healed' ? skillOffer.workflowName : undefined;
    const res: any = await browser.runtime.sendMessage({ action: 'SAVE_WORKFLOW_FROM_RUN', payload: { name } })
      .catch((err: Error) => ({ error: err.message }));
    closeSkillOffer();
    if (!res?.success) {
      chat.addBotMessage(`**Couldn't save a workflow:** ${res?.error || 'unknown error'}`);
      return;
    }
    const w = res.data;
    chat.addBotMessage(
      `## 🔁 Workflow ${name ? 'updated' : 'saved'}: ${w.name}\n\n${w.steps.length} steps. Run it again any time with **/${w.name}** here, `
      + 'or from the Genesis popup: it replays these exact steps with no model calls, and the agent takes over if the site has changed.'
      + (w.hasPassword ? '\n\n🔒 It includes a password you typed, saved on this device only, like your API keys.' : ''),
    );
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

  // Workflows and shortcuts for the / picker, loaded when the sidebar opens and when / is typed
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([]);
  const loadPicker = useCallback(async (): Promise<PickerItem[]> => {
    const res: any = await browser.runtime.sendMessage({ action: 'PICKER_ITEMS' }).catch(() => null);
    const items: PickerItem[] = res?.success ? res.data : [];
    setPickerItems(items);
    return items;
  }, []);
  const refreshPicker = useCallback(() => { loadPicker(); }, [loadPicker]);
  useEffect(() => { if (sidebarOpen) refreshPicker(); }, [sidebarOpen, refreshPicker]);

  /** Replay a saved workflow in this tab (typed as /name). */
  const runWorkflow = async (name: string) => {
    setSkillOffer(null);
    agentMessageId.current = chat.addBotMessage(`🔁 **Workflow** ${name}: starting...`, true);
    const res: any = await browser.runtime.sendMessage({ action: 'RUN_WORKFLOW', payload: { name } }).catch((err: Error) => ({ error: err.message }));
    if (!res?.success) throw new Error(res?.error || 'Could not run the workflow');
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
    runWorkflow,
    // Workflows first: a workflow and a shortcut can share a name
    findPickerItem: async (name: string) => {
      const find = (items: PickerItem[]) => items.find((i) => i.kind === 'workflow' && i.name === name) ?? items.find((i) => i.name === name);
      // Not in the list yet (it loads as the sidebar opens): ask again before giving up
      return find(pickerItems) ?? find(await loadPicker());
    },
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
      {skillOffer !== null && (
        <SaveSkillBar
          skill={skillOffer.replay !== 'healed'}
          workflow={skillOffer.unrecordable ? null : skillOffer.replay === 'healed' ? 'update' : 'save'}
          unrecordable={skillOffer.unrecordable}
          onSaveSkill={saveAsSkill}
          onSaveWorkflow={saveAsWorkflow}
          onSaveShortcut={saveAsShortcut}
          onDismiss={closeSkillOffer}
        />
      )}
      <TasksChip />
      {(agentStatus === 'running' || agentStatus === 'paused' || agentStatus === 'queued') && (
        <AgentControls paused={agentStatus === 'paused'} queued={agentStatus === 'queued'} onContinue={agent.resume} onStop={() => agent.stop()} />
      )}
      <ChatInput
        value={chatInput}
        onChange={setChatInput}
        onSubmit={toolsApi.handleSendMessage}
        disabled={status === 'WORKING'}
        pickerItems={pickerItems}
        onRefreshPicker={refreshPicker}
        onBackground={toolsApi.handleBackground}
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
