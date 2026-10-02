// entrypoints/content.ts
// Tabi in the page: eyes and hands, and the cue while a task runs here. The
// agent runner in the background reads the page (AGENT_SNAPSHOT) and acts on
// it (AGENT_EXECUTE) through this script, and the side panel asks it for the
// page's text, the selection, or an autofill. Cross-origin frames have their
// own script (frame.content.ts).

import { createPageSnapshot } from '@/lib/agent/frames';
import { executeAction } from '@/lib/agent/actionExecutor';
import { viewportMarks, describeElement, resolveElement, commitTarget, getElementById } from '@/lib/agent/domSnapshot';
import { extractVisibleText } from '@/lib/dom/extractVisibleText';
import { highlightText } from '@/lib/dom/highlightText';
import { fillForm, fillDropdowns } from '@/lib/automation/formAutofill';
import { loadStoredProfile, isProfileEmpty } from '@/lib/automation/profile';
import { reportColorScheme } from '@/lib/utils/toolbarIcon';
import { createPageCue, cueOf } from '@/lib/dom/pageCue';

/** How long the cue steps aside while the background takes a screenshot for the model. */
const SCREENSHOT_MS = 1500;

export default defineContentScript({
  matches: ['<all_urls>'],

  main() {
    // The toolbar icon's ink follows the browser's light or dark theme
    reportColorScheme();

    // The cue (glow, pill, outline) while a task runs in this tab; a page
    // loaded mid-task asks what is going on
    const cue = createPageCue({
      onStop: () => { browser.runtime.sendMessage({ action: 'STOP_AGENT' }).catch(() => {}); },
      onReview: () => { browser.runtime.sendMessage({ action: 'OPEN_PANEL' }).catch(() => {}); },
      find: (id) => getElementById(id),
    });
    browser.runtime.sendMessage({ action: 'GET_AGENT_STATE' })
      .then((res: any) => cue.set(cueOf(res?.data)))
      .catch(() => {});

    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      switch (message?.action) {
        case 'AGENT_PING':
          sendResponse({ ok: true });
          return;
        case 'TABI_CUE':
          cue.set(message.state ?? null);
          sendResponse({ ok: true });
          return;
        case 'AGENT_SNAPSHOT':
          // A screenshot follows: the model sees the page, not the cue
          if (message.visual) cue.hideFor(SCREENSHOT_MS);
          // visual: also say where the numbered elements are, for a screenshot
          createPageSnapshot()
            .then(snapshot => sendResponse({
              text: snapshot.text,
              ...(message.visual ? {
                visual: {
                  marks: viewportMarks(),
                  viewport: { width: window.innerWidth, height: window.innerHeight },
                  // The side panel is outside the page, so there is nothing to crop
                  cropRight: null,
                },
              } : {}),
            }))
            .catch(err => sendResponse({ text: `(could not read the page: ${err?.message ?? err})` }));
          return true; // async response
        case 'AGENT_EXECUTE':
          // The pill never sits on what the agent is about to click
          if (typeof message.payload?.elementId === 'number') cue.avoid(getElementById(message.payload.elementId));
          executeAction(message.payload)
            .then(result => sendResponse(result))
            .catch(err => sendResponse(`❌ ${err?.message ?? err}`));
          return true;
        case 'AGENT_DESCRIBE':
          // Workflows: an element's lasting description, recorded before acting on it
          sendResponse(describeElement(Number(message.id)));
          return;
        case 'AGENT_COMMIT_TARGET':
          // What a click or Enter would set off, to ask the user first if it can't be undone
          sendResponse(commitTarget(message.payload ?? {}));
          return;
        case 'AGENT_RESOLVE':
          // Workflows: find a recorded element again (after AGENT_SNAPSHOT)
          sendResponse({ id: resolveElement(message.target) });
          return;
        case 'PAGE_TEXT':
          // Answers and summaries in the side panel
          sendResponse({ text: extractVisibleText(), title: document.title });
          return;
        case 'HIGHLIGHT_TEXT':
          // A source of an answer, clicked in the side panel
          sendResponse({ found: highlightText(String(message.text ?? '')) });
          return;
        case 'PAGE_SELECTION':
          sendResponse({ text: window.getSelection()?.toString().trim() ?? '' });
          return;
        case 'AUTOFILL':
          // Fill the page's form from the user's saved profile
          loadStoredProfile()
            .then(profile => {
              if (isProfileEmpty(profile)) return sendResponse({ empty: true });
              const { filled, skipped } = fillForm(profile);
              sendResponse({ filled: filled + fillDropdowns(profile), skipped });
            })
            .catch(err => sendResponse({ error: err?.message ?? String(err) }));
          return true;
      }
    });
  },
});
