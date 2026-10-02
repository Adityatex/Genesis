// entrypoints/sidebar.content/hooks/useWorkspaceTools.ts
import { useCallback } from 'react';
import { extractVisibleText } from '@/lib/dom/extractVisibleText';
import { detectInteractiveElements } from '@/lib/dom/detectInteractiveElements';
import { fillForm, fillDropdowns } from '@/lib/automation/formAutofill';
import { loadStoredProfile, isProfileEmpty } from '@/lib/automation/profile';
import { isAgentCommand } from '@/lib/agent/history';
import { fillPrompt, blanks, type PickerItem } from '@/lib/shortcuts/shortcut';
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
  /** Start a background agent run; progress arrives through useAgentRun. */
  startAgent: (goal: string) => Promise<void>;
  /** Replay a saved workflow (/name). */
  runWorkflow: (name: string) => Promise<void>;
  /** A workflow or shortcut by its /name. */
  findPickerItem: (name: string) => Promise<PickerItem | undefined>;
  stopAgent: (forget?: boolean) => void;
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
        d.updateBotMessage(msgId, '## Form Auto-Fill\n\nYour autofill profile is empty. Open the Tabi popup and save your name, email, and address first — nothing was filled.');
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
    d.stopAgent(true);
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

    if (message.startsWith('/')) {
      // /name [words]: replay a workflow, or run a shortcut's prompt with its blanks filled
      const [, name = '', args = ''] = /^\/(\S*)\s*([\s\S]*)$/.exec(message) ?? [];
      const item = await d.findPickerItem(name);
      try {
        if (!item) throw new Error(`There is no workflow or shortcut named "/${name}". Type / to see them.`);
        if (item.kind === 'workflow') {
          await d.runWorkflow(item.name);
        } else {
          const { text, complete } = fillPrompt(item.detail, args);
          if (complete) {
            await d.startAgent(text);
          } else {
            // Blanks left: put the prompt in the box to finish
            d.setChatInput(text);
            d.addBotMessage(`⚡ **/${item.name}**: fill in the ${blanks(text).map((b) => `{${b}}`).join(', ')} in the box, then press Enter.`);
            d.setStatus('ACTIVE');
          }
        }
      } catch (err: any) {
        d.addBotMessage(`**Couldn't run it:** ${err.message}`);
        d.setStatus('ACTIVE');
      }
    } else if (isAgentCommand(message)) {
      // Runs in the background; status and messages follow its updates
      try {
        await d.startAgent(message);
      } catch (err: any) {
        d.addBotMessage(`## ❌ Agent Error\n\n${err.message}`);
        d.setStatus('ACTIVE');
      }
    } else {
      const msgId = d.addBotMessage('*Tabi is thinking...*', true);
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

  /** Run what's typed in a new background tab (Tabi group), leaving this page alone. */
  const handleBackground = useCallback(async () => {
    const message = d.chatInput.trim();
    if (!message) return;
    // Clear the box now, not when the background answers: by then the user may be
    // typing the next task, and clearing late would wipe it
    d.setChatInput('');
    let payload: { goal?: string; workflow?: string };
    try {
      if (message.startsWith('/')) {
        const [, name = '', args = ''] = /^\/(\S*)\s*([\s\S]*)$/.exec(message) ?? [];
        const item = await d.findPickerItem(name);
        if (!item) throw new Error(`There is no workflow or shortcut named "/${name}". Type / to see them.`);
        if (item.kind === 'workflow') payload = { workflow: item.name };
        else {
          const { text, complete } = fillPrompt(item.detail, args);
          if (!complete) throw new Error(`Fill in ${blanks(text).map((b) => `{${b}}`).join(', ')} first: type /${item.name} followed by the words`);
          payload = { goal: text };
        }
      } else {
        payload = { goal: message };
      }
      const res: any = await browser.runtime.sendMessage({ action: 'START_BACKGROUND_TASK', payload });
      if (!res?.success) throw new Error(res?.error || 'Could not start it');
      d.pushUserMessage(`⧉ ${message}`);
      d.addBotMessage('Started in a **background tab** (in the blue *Tabi* group). Carry on here; you\'ll get a notification when it\'s done, and the task list above shows how it\'s going.');
    } catch (err: any) {
      d.setChatInput(message); // give it back to fix and retry
      d.addBotMessage(`**Couldn't start it:** ${err.message}`);
    }
  }, [d]);

  return { handleBackground, handleExtractText, handleDetectElements, handleAutoFill, handleSummarize, handleExplainSelection, handleClear, handleSendMessage };
}
