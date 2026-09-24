// entrypoints/sidebar.content/index.tsx
// Content script entry — injects the Genesis sidebar via Shadow DOM

import ReactDOM from 'react-dom/client';
import App from './App';
import './sidebar.css';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
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
