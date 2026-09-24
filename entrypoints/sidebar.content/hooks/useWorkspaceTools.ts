// entrypoints/sidebar.content/hooks/useWorkspaceTools.ts
import { useCallback } from 'react';
import { extractVisibleText } from '@/lib/dom/extractVisibleText';
import { detectInteractiveElements } from '@/lib/dom/detectInteractiveElements';
import { fillForm, fillDropdowns } from '@/lib/automation/formAutofill';
import { loadStoredProfile, isProfileEmpty } from '@/lib/automation/profile';
import { isAgentCommand } from '@/lib/agent/loop';
import type { Message } from './useChatMessages';

interface Deps {
  pageText: string;
  setPageText: (t: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  addBotMessage: (t: string, loading?: boolean) => string;
  updateBotMessage: (id: string, t: string, loading?: boolean) => void;
  pushUserMessage: (t: string) => void;
  setStatus: (s: string) => void;
  chatInput: string;
  setChatInput: (s: string) => void;
  stopAgent: () => void;
  runFreshLoop: (goal: string, msgId: string, update: (t: string, l: boolean) => void) => Promise<void>;
}

export function useWorkspaceTools(d: Deps) {
  const handleExtractText = useCallback(() => {
    d.setStatus('WORKING');
    const msgId = d.addBotMessage('*Extracting page text...*', true);
    try {
      const text = extractVisibleText();
      d.setPageText(text);
      d.updateBotMessage(msgId, `## Extracted Text\n\n\`\`\`\n${text.substring(0, 3000)}${text.length > 3000 ? '\n\n[... truncated for display]' : ''}\n\`\`\`\n\n**Total characters:** ${text.length.toLocaleString()}`);
    } catch (err: any) {
      d.updateBotMessage(msgId, `**Error:** ${err.message}`);
    } finally {
      d.setStatus('ACTIVE');
    }
  }, [d]);

  const handleDetectElements = useCallback(() => {
    d.setStatus('WORKING');
    const msgId = d.addBotMessage('*Scanning for interactive elements...*', true);
    try {
      const elements = detectInteractiveElements();
      let result = `## Interactive Elements\n\n**${elements.summary}**\n\n`;
      if (elements.inputs.length > 0) {
        result += `### Inputs\n`;
        elements.inputs.forEach((inp) => { result += `**${inp.label || inp.name || inp.id || 'unnamed'}** - type: \`${inp.type}\`${inp.placeholder ? ` (${inp.placeholder})` : ''}\n`; });
      }
      if (elements.textareas.length > 0) {
        result += `### Textareas\n`;
        elements.textareas.forEach((ta) => { result += `**${ta.label || ta.name || ta.id || 'unnamed'}**${ta.placeholder ? ` (${ta.placeholder})` : ''}\n`; });
      }
      if (elements.buttons.length > 0) {
        result += `### Buttons\n`;
        elements.buttons.forEach((btn) => { result += `**${btn.text || 'unnamed'}** - type: \`${btn.type}\`\n`; });
      }
      if (elements.dropdowns.length > 0) {
        result += `### Dropdowns\n`;
        elements.dropdowns.forEach((dd) => { result += `**${dd.name || dd.id || 'unnamed'}** - ${dd.options.length} options\n`; });
      }
      d.updateBotMessage(msgId, result);
    } catch (err: any) {
      d.updateBotMessage(msgId, `**Error:** ${err.message}`);
    } finally {
      d.setStatus('ACTIVE');
    }
  }, [d]);

  const handleAutoFill = useCallback(async () => {
    d.setStatus('WORKING');
    const msgId = d.addBotMessage('*Auto-filling form fields...*', true);
    try {
      const profile = await loadStoredProfile();
      if (isProfileEmpty(profile)) {
        d.updateBotMessage(msgId, '## Form Auto-Fill\n\nYour autofill profile is empty. Open the Genesis popup and save your name, email, and address first — nothing was filled.');
        return;
      }
      const { filled, skipped } = fillForm(profile);
      const ddFilled = fillDropdowns(profile);
      const total = filled + ddFilled;
      const owner = profile.fullname ? ` for **${profile.fullname}**` : '';
      d.updateBotMessage(msgId, `## Form Auto-Fill Results${owner}\n\n- **Fields filled:** ${filled}\n- **Dropdowns filled:** ${ddFilled}\n- **Fields skipped:** ${skipped}\n\n${total > 0 ? 'Auto-fill completed with your saved profile.' : 'No matching fields were found.'}`);
    } catch (err: any) {
      d.updateBotMessage(msgId, `**Error:** ${err.message}`);
    } finally {
      d.setStatus('ACTIVE');
    }
  }, [d]);

  const handleSummarize = useCallback(async () => {
    d.setStatus('WORKING');
    const msgId = d.addBotMessage('*Processing page content for summary...*', true);
    try {
      const text = d.pageText || extractVisibleText();
      d.setPageText(text);
      if (text.length < 50) {
        d.updateBotMessage(msgId, '## Page Summary\n\nNot enough text content on this page to summarize.');
        return;
      }
      const response = await browser.runtime.sendMessage({ action: 'SUMMARIZE', payload: { text } });
      if (!response?.success) throw new Error(response?.error || 'Summarization failed');
      d.updateBotMessage(msgId, `## Page Summary\n\n${response.data.result}`);
    } catch (err: any) {
      d.updateBotMessage(msgId, `**Summary Error:** ${err.message}`);
    } finally {
      d.setStatus('ACTIVE');
    }
  }, [d]);

  const handleExplainSelection = useCallback(async () => {
    const selectedText = window.getSelection()?.toString()?.trim();
    if (!selectedText) {
      d.addBotMessage('## Explain Selection\n\nNo text selected. Please highlight some text on the page first, then click this button.');
      return;
    }
    d.setStatus('WORKING');
    const msgId = d.addBotMessage(`*Explaining selected text...*\n\n> "${selectedText.substring(0, 50)}..."`, true);
    try {
      const response = await browser.runtime.sendMessage({ action: 'EXPLAIN', payload: { text: selectedText } });
      if (!response?.success) throw new Error(response?.error || 'Explanation failed');
      d.updateBotMessage(msgId, `## Explanation\n\n> "${selectedText.substring(0, 100)}..."\n\n---\n\n${response.data.result}`);
    } catch (err: any) {
      d.updateBotMessage(msgId, `**Error:** ${err.message}`);
    } finally {
      d.setStatus('ACTIVE');
    }
  }, [d]);

  const handleClear = useCallback(() => {
    d.stopAgent();
    browser.runtime.sendMessage({ action: 'CLEAR_AGENT_SESSION', payload: {} }).catch(() => {});
    d.setMessages([]);
    d.setPageText('');
    d.setStatus('ACTIVE');
  }, [d]);

  const handleSendMessage = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const message = d.chatInput.trim();
    if (!message) return;

    d.pushUserMessage(message);
    d.setChatInput('');
    d.setStatus('WORKING');

    if (isAgentCommand(message)) {
      const msgId = d.addBotMessage('🤖 **Agent Mode** — Analyzing your request...', true);
      try {
        await d.runFreshLoop(message, msgId, (t, l) => d.updateBotMessage(msgId, t, l));
      } finally {
        d.setStatus('ACTIVE');
      }
    } else {
      const msgId = d.addBotMessage('*Genesis is thinking...*', true);
      try {
        const context = d.pageText || extractVisibleText();
        d.setPageText(context);
        const response = await browser.runtime.sendMessage({ action: 'CHAT', payload: { message, pageContext: context } });
        if (!response?.success) throw new Error(response?.error || 'Chat failed');
        d.updateBotMessage(msgId, response.data.result);
      } catch (err: any) {
        d.updateBotMessage(msgId, `**Error:** ${err.message}`);
      } finally {
        d.setStatus('ACTIVE');
      }
    }
  }, [d]);

  return { handleExtractText, handleDetectElements, handleAutoFill, handleSummarize, handleExplainSelection, handleClear, handleSendMessage };
}
