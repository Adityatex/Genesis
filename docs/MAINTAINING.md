# Maintaining Genesis

Notes for whoever owns the GitHub repository. None of this affects building or using the extension.

## Pending repository setup

These live in GitHub's settings rather than in the code, so they have to be done by hand. They were lost when the repository was recreated on 2026-09-26.

- [ ] **Description and topics.** On the repo page, click the gear next to **About**.
  - Suggested description: *Open-source AI browser agent for Chrome (MV3). Works with any OpenAI-compatible model (Groq, DeepSeek, OpenAI, OpenRouter, Ollama) and has an end-to-end benchmark.*
  - Suggested topics: `browser-extension`, `chrome-extension`, `manifest-v3`, `ai-agent`, `llm`, `web-automation`, `playwright`, `typescript`
- [ ] **Secrets for the live benchmark** (optional). Only the manual **Live eval** workflow uses them; regular CI needs no secrets. Add them under **Settings → Secrets and variables → Actions → New repository secret**, one per provider you want to benchmark:
  - `GROQ_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `OPENAI_API_KEY`, `OPENROUTER_API_KEY` (if used)
- [ ] **Protect `main`** (optional, recommended once others contribute). Under **Settings → Branches → Add branch ruleset**, require the status checks `check` and `eval-mock` to pass before merging.
- [ ] **Security alerts** (optional). Under **Settings → Code security**, turn on Dependabot alerts and private vulnerability reporting.

## CI

| Workflow | Runs | What it does |
|---|---|---|
| `ci.yml` → `check` | every push and PR | typecheck, unit tests, production build, uploads the unpacked extension |
| `ci.yml` → `eval-mock` | every push and PR | end-to-end benchmark with a scripted planner (no API key); fails if a task regresses or a known issue starts passing |
| `eval-live.yml` | manual (**Actions → Live eval → Run workflow**) | the benchmark against a real provider; needs that provider's secret. Groq's free tier allows about 200k tokens per model per day, which one full run can nearly use up |

## Commits

Commits are authored by the maintainer only. Don't add AI-assistant co-author trailers or "generated with" lines to commits or PR descriptions.
