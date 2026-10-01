# Privacy Policy — Genesis AI Browser Assistant

- No analytics, no tracking, no remote servers operated by us.
- You choose the AI provider (Groq, Google AI Studio, Mistral, DeepSeek, OpenAI, OpenRouter, Kilo AI Gateway, OpenCode Zen, a local Ollama, or a custom OpenAI-compatible server) and bring your own API key.
- API keys are stored only in `chrome.storage.local` on your device and are read only by the extension's background service worker. They are never shown back in full, and are sent only to the provider they belong to.
- Page text / DOM snapshots are sent only to the provider you selected, and only when you trigger Summarize, Explain, Chat, or Agent actions. With Ollama they never leave your machine. Some free models on gateways such as Kilo may be used for training by their provider; the popup marks those models.
- Keys and page content are only ever sent over HTTPS, except to servers on your own machine (localhost).
- The `debugger` permission is used only while the agent is working on a task in that tab (Chrome shows a banner while it is active): to send real mouse and keyboard input, which can be turned off in the popup; to take the screenshots, if you turn screenshots on; and, only if you turn on "Let the agent run its own code", to run the agent's read-only code on the page. It never records your browsing.
- A small helper script runs inside each frame of a page so the agent can work in embedded forms (e.g. payment iframes). It stays idle and reads nothing unless the agent is working on that tab.
- **AI apps (MCP), off by default.** If you turn on "Let AI apps control this browser" and run the `genesis-mcp` helper, an AI app on your computer (e.g. Claude Code, Claude Desktop, Codex) can read pages and act in your browser through Genesis. Page snapshots and screenshots then go to that app, and on to the AI provider it uses under that provider's policy. The connection stays on your machine (127.0.0.1) and requires the pairing token you set. The `alarms` permission keeps this connection alive, and runs your schedules.
- **Schedules**, only ones you create: a workflow or shortcut runs at the times you choose, in a background tab of your browser, and the `notifications` permission shows you how it went. A scheduled shortcut sends that page to your AI provider like any other task.
- **Background tasks**: the `tabGroups` permission puts the tabs of tasks you run in the background into a group named Genesis. It doesn't read your other tabs or groups.
- We never sell, share, or retain your browsing data. Your provider's own privacy policy applies to what you send it.
- Contact: open a GitHub issue at https://github.com/Adityatex/Genesis/issues
