// entrypoints/sidebar.content/index.tsx
// Content script entry — injects the Genesis sidebar via Shadow DOM

import ReactDOM from 'react-dom/client';
import App from './App';
import './sidebar.css';
import { createPageSnapshot } from '@/lib/agent/frames';
import { executeAction } from '@/lib/agent/actionExecutor';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    // Eyes and hands for the agent runner in the background (lib/agent/runner.ts)
    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      switch (message?.action) {
        case 'AGENT_PING':
          sendResponse({ ok: true });
          return;
        case 'AGENT_SNAPSHOT':
          createPageSnapshot()
            .then(snapshot => sendResponse({ text: snapshot.text }))
            .catch(err => sendResponse({ text: `(could not read the page: ${err?.message ?? err})` }));
          return true; // async response
        case 'AGENT_EXECUTE':
          executeAction(message.payload)
            .then(result => sendResponse(result))
            .catch(err => sendResponse(`❌ ${err?.message ?? err}`));
          return true;
      }
    });

    const ui = await createShadowRootUi(ctx, {
      name: 'genesis-sidebar',
      position: 'overlay',
      zIndex: 2147483647,
      onMount: (container) => {
        container.id = 'genesis-sidebar-root';
        const app = document.createElement('div');
        app.id = 'genesis-app';
        container.append(app);
        const root = ReactDOM.createRoot(app);
        root.render(<App />);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
