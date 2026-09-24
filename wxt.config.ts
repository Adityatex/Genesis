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
    name: 'Genesis - AI Browser Automation',
    version: '1.0.0',
    description: 'AI-powered browser automation assistant for text extraction, trustworthy form filling, and intelligent page summarization.',
    permissions: ['activeTab', 'scripting', 'storage'],
    host_permissions: ['<all_urls>', 'https://api.groq.com/*'],
    icons: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
});
