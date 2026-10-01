# Genesis — AI Browser Automation Assistant

[![CI](https://github.com/Adityatex/Genesis/actions/workflows/ci.yml/badge.svg)](https://github.com/Adityatex/Genesis/actions/workflows/ci.yml)

Open-source Brave/Chrome extension (Manifest V3) that injects a floating AI-powered sidebar into every webpage. Built with **WXT + React + TypeScript**. BYOK-only — no bundled keys.

![Genesis Extension](public/icons/icon128.png)

## ✨ Features (v1: Agent + Autofill)

| Feature | Description |
|---|---|
| 🤖 **Autonomous Agent** | DOM snapshot → LLM planner → action executor with real (trusted) mouse and keyboard input, resumes across navigations. Keeps a visible plan and sends several actions per model call (a whole form in one call instead of one call per field). Collects data from lists, tables and each item's own page in one step with `extract`, without the model writing code. For what that can't reach, an opt-in setting lets the model run its own read-only code: in an isolated context, with the network functions removed and risky code refused. No step limit: it checks in every 50 steps (configurable) and pauses if it gets stuck |
| 📝 **Text Extraction** | Extract all visible text from any webpage using TreeWalker API |
| 🔍 **Element Detection** | Detect all interactive elements (inputs, buttons, dropdowns, etc.) |
| ✏️ **Trustworthy Form Auto-Fill** | Fill forms with *your own* profile data (React/Angular compatible). Edit it in the popup — stored only in `chrome.storage.local`. No exam auto-solving. |
| 📊 **Page Summarization** | AI-generated summaries of page content |
| 💡 **Text Explanation** | Select text and get AI-powered explanations |
| 💬 **Copilot Chat** | Free-form chat about the current page |

## 🛠️ Tech Stack

- **Framework:** [WXT](https://wxt.dev/) (Vite-powered browser extension framework)
- **UI:** React + TypeScript
- **Styling:** Tailwind CSS v4 with a dark glassmorphic theme
- **Testing:** Vitest + happy-dom, GitHub Actions CI (typecheck → test → build)
- **AI:** any OpenAI-compatible provider: Groq (default, `qwen/qwen3.8-27b`), Google AI Studio (Gemini), Mistral, DeepSeek, OpenAI, OpenRouter, Kilo AI Gateway, OpenCode Zen, local Ollama, or a custom server. Bring your own key. Optional backup providers take over mid-task when the main one hits a rate limit (the plan and progress carry over), and an optional fast model can take routine steps while the main model plans and checks. Optional screenshots (off by default, since they cost tokens) let vision models see the page with every element's number drawn on it
- **Architecture:** Manifest V3, Shadow DOM isolation. Permissions: `activeTab`, `scripting`, `storage`, and `debugger`, which is used only while the agent runs, for real mouse and keyboard input, and can be turned off in the popup

## 🚀 Getting Started

### Prerequisites
- Node.js 20.19+ (22 recommended)
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

### Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit tests (Vitest + happy-dom)
npm run test:watch  # re-run on change
```

CI runs typecheck, tests and a production build on every push and pull request, and uploads the unpacked extension as a build artifact.

### Benchmark

`eval/` is an end-to-end harness. It loads the built extension into Chromium, gives the agent tasks on local test pages through the real sidebar, and grades them by the requests that actually reached the server.

```bash
npm run build
npm run eval:mock   # scripted planner, no API key (runs in CI)
npm run eval        # live against a real provider (Groq by default, --provider to change), reports success rate / LLM calls / tokens / time
```

The suite has 10 standard tasks (forms, dropdowns, radios, multi-page flows, slow backends, JS apps, extraction) and 9 hard ones that are hard for agents to see or act on: long pages, custom widgets, iframes, open and closed Shadow DOM, rich-text editors, and sites that only accept real (trusted) input. 8 expert tasks test planning and judgment: long multi-page flows, comparing across pages, vague goals, and recovering from errors. See [eval/README.md](eval/README.md).

**Results** (2026-09-25 to 27, live runs, [full results](eval/BASELINE.md)):

| Hard tasks | Before the fixes | After the fixes |
|---|---|---|
| Original five (long page, custom dropdown, iframe form, Shadow DOM button, rich-text editor) | **0/5** | **15/15** |
| Closed shadow root (new) | n/a | 3/3 |
| Sites that ignore scripted input: bot-protected button, keystroke-only editor (new) | 0/2 with scripted input | 6/6 with trusted input |
| Cross-origin iframe, Stripe-style (new) | 0/3 | 3/3 |
| Standard tasks (regression check) | 30/30 | 60/60 |

"Before" is Qwen on Groq; "after" is `deepseek-flash`, since Qwen ran out of free daily quota mid-run. Its after-fix runs that got a response were also 9/9. The hard-task failures were never about the model: before the fixes, the elements weren't even in what the model received. All 9 hard tasks now pass. The fixes changed how the agent sees and acts on the page: it now reaches into Shadow DOM, iframes (including cross-origin ones, through a helper script in each frame) and ARIA widgets, types into rich-text editors, fits long pages into a size budget with a `find` action, checks that each action actually worked, and clicks and types through Chrome's DevTools Protocol, so pages see real input. That last part shows Chrome's "debugging this browser" banner while the agent works, and can be turned off in the popup.

**Expert tier, by model** (before → after adding memory across pages and fixing reasoning-model token limits):

| Model | Expert tasks |
|---|---|
| `deepseek-v4-pro` | 4/8 → **8/8** |
| `openai/gpt-oss-120b` (Groq) | 5/8 → **7/8** |
| `deepseek-flash` | 15/24 → **21/24** (3 trials) |
| `qwen/qwen3.8-27b` (Groq) | 5/8 → **6/8** |

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
│   └── background.ts      # Service worker: runs the agent loop, LLM API proxy (BYOK-only)
├── lib/
│   ├── api/                # Provider presets + OpenAI-compatible LLM client (BYOK)
│   ├── agent/              # runner (background loop), DOM snapshot, action executor, frames, trusted input, parser
│   ├── automation/         # Trustworthy form autofill
│   ├── dom/                # DOM extraction & element detection
│   └── utils/              # Messaging, error handling, markdown
├── eval/                   # End-to-end benchmark (Playwright + fixture pages)
└── tests/                  # Vitest unit tests
```

## 🔐 AI provider and API key (BYOK)

Open the extension popup and pick a provider under **AI model**:

| Provider | Key | Notes |
|---|---|---|
| Groq (default) | [console.groq.com](https://console.groq.com/keys) | Free tier; default model `qwen/qwen3.8-27b` (see [baseline](eval/BASELINE.md)) |
| Google AI Studio (Gemini) | [aistudio.google.com](https://aistudio.google.com/apikey) | Free key, no billing. On the free tier use a Flash-Lite model (~500 requests/day); other Flash models allow 20/day. Free-tier prompts may be used by Google |
| Mistral | [console.mistral.ai](https://console.mistral.ai/api-keys) | Free Experiment plan, about 1 request/second; free-plan prompts may be used for training |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | |
| OpenRouter | [openrouter.ai](https://openrouter.ai/keys) | Many models behind one key |
| Kilo AI Gateway | [app.kilo.ai](https://app.kilo.ai) | Hundreds of models; free ones are listed first and cost nothing with a free account key. Some free models may train on your prompts, which include page content; **Load models** flags them |
| OpenCode Zen | [opencode.ai](https://opencode.ai/auth) | Needs a key with credit. Zen's free models only work inside the OpenCode app (they return 403 elsewhere), and its Claude/GPT/Gemini/Grok models use APIs Genesis doesn't speak yet, so those are hidden |
| Ollama (local) | none | Runs on your machine. Start Ollama with `OLLAMA_ORIGINS=chrome-extension://*` |
| Custom | optional | Any OpenAI-compatible `/chat/completions` server |

Paste your key, click **Load models** to list the models your key can actually use, pick one, and **Save**. Model names aren't hardcoded because providers retire them; Groq retired this project's original default. The client adapts to provider differences: if a server rejects JSON mode, `max_tokens` or `temperature`, it adjusts the request and retries.

Keys are stored per provider in `chrome.storage.local` and read only by the background service worker. They are never exposed to content scripts, never shown back in full, and never committed. Keys and page content are only sent over HTTPS, except to servers on localhost. See [PRIVACY.md](PRIVACY.md).

## 🧠 Skills

A skill is a `SKILL.md` file (the open Agent Skills format) with instructions for a task you repeat:

```markdown
---
name: order-status
description: Check the delivery status of an order on shop.example.com
sites: [shop.example.com]
---
1. Open "My account" (top right), then "Orders".
2. Find the order by its number; the status is in the right-hand column.

Pitfalls:
- Accept the cookie banner first: it covers the "Orders" link.
```

The agent gets the skills that fit the current site and task in full, and can load any other by name. When a task finishes, the sidebar offers **Save as skill**: the model writes one from what just happened, naming buttons by their labels and noting what went wrong and how it was fixed. Anything typed during the task, passwords included, is replaced by a placeholder, and skills record how to do a task, not this time's answer (prices and stock go stale). Skills are listed, edited, pasted in and deleted in the popup. Only add skills you trust: the agent follows them.

## 🔁 Workflows: record once, replay for free

When a task finishes, **Save as workflow** keeps its exact steps. Type `/name` in the sidebar (or press Run in the popup) to replay them: no model calls, so it's instant and costs nothing, even on free tiers. Each step remembers its element by what it is (`<button> "Sign in"`), not by position, so small layout changes don't break it. If the site has changed and a step no longer fits, the agent takes over from there and finishes the task, then offers to update the workflow. Workflows are stored on this device only; one that types a password is marked 🔒.

## ⚡ Shortcuts

Type `/` in the sidebar for a picker of your workflows (🔁, replayed with no model) and shortcuts (⚡, saved prompts the agent runs). Arrow keys and Enter run one, Tab completes its name. A shortcut can have blanks in braces: save "Find the price of {product} on this site" as `price-check`, then type `/price-check running shoes`. Save one with **Save as shortcut** after a task, or write them in the popup.

## 🤝 Use it from Claude Code, Claude Desktop or Codex (MCP)

`genesis-mcp` lets an AI app you already use drive your real browser through Genesis. The model runs inside that app, on your plan with it, so Genesis needs no API key for this. Genesis supplies what it's good at: page snapshots with numbered elements (including iframes and Shadow DOM), real mouse and keyboard input, and screenshots with those numbers drawn on.

```bash
npm run build:mcp                 # once: installs and builds mcp/
node mcp/dist/server.js token     # prints your pairing token and the setup commands
claude mcp add genesis -- node "<path to repo>/mcp/dist/server.js"   # Claude Code; Codex: codex mcp add ...
```

Then, in the Genesis popup under **AI apps (MCP)**, turn on **Let AI apps control this browser** and paste the token. The toolbar icon shows **MCP** while an app is connected.

| Tool | What it does |
|---|---|
| `browser_tabs`, `browser_open`, `browser_select_tab` | List, open and switch tabs |
| `browser_snapshot` | The page as text, every interactive element numbered |
| `browser_act` | Up to 10 actions in order (click, type, select, navigate, keys, scroll, find, ...), stopping early if the page changes or one fails |
| `browser_screenshot` | The visible page with each element's number drawn on |
| `browser_run_task` | Hand a whole task to Genesis's own agent (uses the model set up in Genesis) |

**Security.** The bridge is off until you turn it on. `genesis-mcp` listens on `127.0.0.1` only and refuses connections from web pages. Before any command, the extension and the server prove to each other that they hold the same pairing token (HMAC challenge and response, so the token never travels), which stops another program on the port from taking over the browser. Only `http(s)` URLs can be opened. `npm run eval:mcp` checks the whole chain end to end in CI.

## 🧰 Maintaining

Repository setup that lives in GitHub settings (secrets, description, branch protection) and how CI is organised: [docs/MAINTAINING.md](docs/MAINTAINING.md).

## 📄 License

MIT
