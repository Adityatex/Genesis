# Genesis — AI Browser Automation Assistant

Open-source Brave/Chrome extension (Manifest V3) that injects a floating AI-powered sidebar into every webpage. Built with **WXT + React + TypeScript**. BYOK-only — no bundled keys.

![Genesis Extension](public/icons/icon128.png)

## ✨ Features (v1: Agent + Autofill)

| Feature | Description |
|---|---|
| 🤖 **Autonomous Agent** | DOM snapshot → LLM planner → 10-action executor, resumes across navigations (20-step budget) |
| 📝 **Text Extraction** | Extract all visible text from any webpage using TreeWalker API |
| 🔍 **Element Detection** | Detect all interactive elements (inputs, buttons, dropdowns, etc.) |
| ✏️ **Trustworthy Form Auto-Fill** | Fill forms with *your own* profile data (React/Angular compatible). Edit it in the popup — stored only in `chrome.storage.local`. No exam auto-solving. |
| 📊 **Page Summarization** | AI-generated summaries of page content |
| 💡 **Text Explanation** | Select text and get AI-powered explanations |
| 💬 **Copilot Chat** | Free-form chat about the current page |

## 🛠️ Tech Stack

- **Framework:** [WXT](https://wxt.dev/) (Vite-powered browser extension framework)
- **UI:** React + TypeScript
- **Styling:** Vanilla CSS with dark glassmorphic theme
- **AI:** Groq API (`llama-3.1-8b-instant`, BYOK)
- **Architecture:** Manifest V3, Shadow DOM isolation, minimal permissions (`activeTab`, `scripting`, `storage`)

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- Brave or Chrome browser

### Development

```bash
# Install dependencies
npm install

# Start development mode (auto-opens browser with extension)
npm run dev

# Build for production
npm run build

# Package as ZIP for store submission
npm run zip
```

### Loading in Browser

1. Run `npm run build`
2. Open `brave://extensions/` (or `chrome://extensions/`)
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `.output/chrome-mv3` folder

## 📁 Project Structure

```
├── entrypoints/
│   ├── popup/              # Extension popup (API key management)
│   ├── sidebar.content/    # Content script with Shadow DOM sidebar
│   │   ├── App.tsx         # Thin composition shell (~180 lines)
│   │   ├── hooks/          # useChatMessages, useAgentLoop, useWorkspaceTools
│   │   ├── components/     # GenesisLogo, FloatingFab, Header, ToolsGrid, MessageList, ChatInput
│   │   └── sidebar.css     # Dark glassmorphic theme
│   └── background.ts      # Service worker (Groq API proxy, BYOK-only)
├── lib/
│   ├── api/                # Groq API client (BYOK)
│   ├── agent/              # DOM snapshot + action executor + shared loop core
│   ├── automation/         # Trustworthy form autofill
│   ├── dom/                # DOM extraction & element detection
│   └── utils/              # Messaging, error handling, markdown
```

## 🔐 API Key (BYOK)

The extension uses the Groq API with your own key. Get one at https://console.groq.com, paste it in the popup. Your key is stored in `chrome.storage.local` and only accessed by the background service worker — never exposed to content scripts, never committed. See `.env.example`.

## 📄 License

MIT
