# Privacy Policy — Genesis AI Browser Assistant

- No analytics, no tracking, no remote servers operated by us.
- You choose the AI provider (Groq, DeepSeek, OpenAI, OpenRouter, a local Ollama, or a custom OpenAI-compatible server) and bring your own API key.
- API keys are stored only in `chrome.storage.local` on your device and are read only by the extension's background service worker. They are never shown back in full, and are sent only to the provider they belong to.
- Page text / DOM snapshots are sent only to the provider you selected, and only when you trigger Summarize, Explain, Chat, or Agent actions. With Ollama they never leave your machine.
- Keys and page content are only ever sent over HTTPS, except to servers on your own machine (localhost).
- The `debugger` permission is used only while the agent is running a task, to send real mouse and keyboard input to that tab (Chrome shows a banner while it is active). It is not used to read or record your browsing, and can be turned off in the popup.
- A small helper script runs inside each frame of a page so the agent can work in embedded forms (e.g. payment iframes). It stays idle and reads nothing unless the agent is working on that tab.
- We never sell, share, or retain your browsing data. Your provider's own privacy policy applies to what you send it.
- Contact: open a GitHub issue at https://github.com/Adityatex/Genesis/issues
