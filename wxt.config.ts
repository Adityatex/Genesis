import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    css: {
      postcss: {
        plugins: [
          require('@tailwindcss/postcss'),
          require('autoprefixer'),
        ],
      },
    },
  }),
  manifest: {
    name: 'Tabi',
    short_name: 'Tabi',
    version: '1.0.0',
    description: 'Tabi works across your tabs for you: it reads pages, fills in forms and carries out tasks, using your own AI provider key.',
    action: { default_title: 'Tabi' },
    permissions: ['activeTab', 'scripting', 'storage', 'debugger', 'alarms', 'notifications', 'tabGroups'],
    // <all_urls> covers every LLM provider, including a local Ollama
    host_permissions: ['<all_urls>'],
    icons: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
});
