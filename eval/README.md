# Genesis eval harness

End-to-end benchmark for the agent. Each run loads the **built extension** into Chromium with Playwright, opens a local test page, types the task's goal into the real sidebar, and waits for the agent to finish.

Tasks are graded by what actually happened, not by what the agent says. The fixture server records every request under `/api/`, and each task's `check` looks at those records. A task passes only if the right side effects happened **and** the agent finished with "Task Complete". An agent that does the work and then hangs still fails.

```bash
npm run build                 # the harness tests .output/chrome-mv3
npm run eval:mock             # scripted planner, no API key, deterministic
npm run eval                  # live run, Groq by default (GROQ_API_KEY in env or .env)

# options (after --)
npm run eval -- --task login,todo-enter   # subset
npm run eval -- --trials 3                # repeat each task (live results vary)
npm run eval -- --headed --verbose        # watch it, stream [Genesis] logs + timings
npm run eval -- --provider deepseek --model <id>              # other providers: key from DEEPSEEK_API_KEY etc.
npm run eval -- --provider custom --base-url https://host/v1 --model <id>   # key from LLM_API_KEY
```

Results are written to `eval/results/` (gitignored): one JSON file per run, plus `latest-<mode>.md`.

## Quotas (Groq free tier)

Pacing is on by default only for Groq (pass `--tpm` to pace other providers). On Groq's free tier, each model gets about **8k tokens/minute**, **1,000 requests/day** and **200k tokens/day** (a rolling window). The harness paces calls under the per-minute limit. A full live suite (17 tasks × 3 trials) can use most of a model's daily tokens, so run subsets with `--task` when you can. If a daily limit is hit, the run stops early and prints Groq's message saying when tokens free up. Runs that end on a 429 are marked `rate-limited` and left out of success rates.

## Modes

**Live** proxies the extension's real provider calls and records LLM calls, tokens and time per task. This is the benchmark number.

**Mock** answers the extension's provider calls with each task's `mockPlan`. Every step's `target` regex is matched against the same DOM snapshot the model would get, so mock runs exercise the real snapshot, executor and navigation-resume code in a real browser, only without an LLM. If an element isn't in the snapshot, the mock gives up, which is how a real model fails too. CI runs the mock suite on every push.

## Tasks

| Category | Tasks | What they cover |
|---|---|---|
| forms | `search-button`, `search-enter`, `signup-checkbox`, `shipping-dropdowns`, `login`, `feedback-radio` | typing, Enter-to-submit, checkboxes, `<select>`, radios, textareas |
| navigation | `store-add-to-cart`, `slow-submit` | multi-page flows, resuming after navigation, slow backends |
| js-app | `todo-enter` | JS keydown handlers that `preventDefault()` |
| extraction | `order-status` | reading an answer off the page |
| hard | `long-page-link`, `custom-dropdown`, `iframe-payment`, `iframe-cross-origin`, `shadow-dom-button`, `shadow-dom-closed`, `contenteditable-message` | pages that are hard for agents to see or act on. Tasks the agent can't do yet are marked with a `knownIssue` in `tasks.mts` |

Tasks with a `knownIssue` are expected to fail in mock mode. The mock run fails CI if a normal task regresses **or** a known-issue task starts passing. When you fix one, delete its `knownIssue` so it becomes a regression test.

## Adding a task

1. Add a page under `fixtures/`. Make it report success through a request to `/api/...` (a form `action` or a `fetch`).
2. Add an entry to `TASKS` in `tasks.mts` with a `goal`, a `check`, and a `mockPlan`.
3. The goal must be routed to the agent rather than chat. It needs an action verb that `isAgentCommand` recognises (open, click, search, fill, select, type, …). The runner refuses goals that don't match.
