# Benchmark results

All runs are live: real model, real extension, real Chromium. A run passes only if the right requests reached the test server **and** the agent finished cleanly.

## Cross-origin iframes (2026-09-26)

Since `c837ca4` a small content script runs in every frame, so the agent can see and act inside iframes from another origin, like Stripe-style payment forms, which the top page can't read. Their elements join the snapshot labeled `(in frame "...")`, and actions on them are forwarded to the frame.

| Hard task | Before | After (deepseek-flash) |
|---|---|---|
| `iframe-cross-origin` | 0/3 (known issue) | **3/3** |

Regression check: **18/18** on every other task (10 standard + 8 hard, 1 trial each). **With this, all 9 hard tasks pass.**

## Trusted input (2026-09-26)

Clicks and typing used to be script-generated DOM events (`isTrusted === false`), which many sites ignore. Since `d968e9a` the agent sends real mouse and keyboard input through the Chrome DevTools Protocol, and falls back to scripted events when that's unavailable. Two new hard tasks model sites that only accept real input:

| Hard task | What it tests | Scripted input | Trusted input (deepseek-flash) |
|---|---|---|---|
| `trusted-click` | bot-protected button that ignores untrusted clicks | fails | **3/3** |
| `trusted-typing` | keystroke-driven editor (not an input), like Google Docs or a terminal | fails | **3/3** |

"Scripted input" was checked in real Chromium with `--scripted-input` (mock planner, the same actions): both fail, because the page ignores the events. Regression check with trusted input on: **16/16** on the other tasks the agent can reach (10 standard + 6 hard, 1 trial each); `iframe-cross-origin` is still the known issue.

---

## After the fixes (2026-09-25)

The hard tasks, before and after the snapshot and executor fixes (`ca4023c`–`9cecd24`):

| Hard task | What it tests | Before: Qwen | After: Qwen† | After: DeepSeek |
|---|---|---|---|---|
| `long-page-link` | link beyond the old 6,000-char snapshot cut | 0/1 | 3/3 | **3/3** |
| `custom-dropdown` | ARIA combobox / `role=option` widget | 0/1 | 3/3 | **3/3** |
| `iframe-payment` | form inside a same-origin iframe | 0/1 | 3/3 | **3/3** |
| `shadow-dom-button` | button in an open shadow root | 0/1 | not run† | **3/3** |
| `contenteditable-message` | rich-text editor (Slack/Gmail style) | 0/1 | not run† | **3/3** |
| `shadow-dom-closed` (new) | button in a *closed* shadow root | n/a | not run† | **3/3** |
| `iframe-cross-origin` (new) | Stripe-style cross-origin payment frame | n/a | not run† | 0/3 (known issue at the time; 3/3 since `c837ca4`, see above) |

**The original five: 0/5 → 15/15.** Counting the new tasks, the agent now passes 6 of 7, i.e. 18/18 runs on the tasks it can reach. The cross-origin frame is a documented limitation: reaching it needs a content script in every frame.

Standard tasks with the fixes: **deepseek-flash 40/40** (30 runs at `78e1881`, 10 at `9cecd24`), averaging 3.5 LLM calls, about 3.1k tokens and 12.2s per task. Hard-task runs averaged 3.4 calls and 10.9s.

**About the model change:** the "before" column used Qwen on Groq's free tier. The "after" run switched to `deepseek-flash` because Qwen hit Groq's 200k-tokens/day limit partway through (†: Qwen's after-fix runs that got a response all passed, 9/9). The comparison is still fair on the hard tasks, because the baseline failures weren't about the model. Mock runs showed the target elements were simply missing from what any model received, and both baseline models failed identically.

DeepSeek also caught a bug that Qwen missed. On the first DeepSeek run (`78e1881`), `iframe-payment` and `shadow-dom-button` went 0/3. DeepSeek did the task correctly, then couldn't see the confirmation, which rendered inside the iframe or shadow root and so was missing from the page text. It kept checking until it ran out of steps. Qwen had passed by declaring done without checking. `9cecd24` adds that text to the page text, and both went 3/3.

Reproduce:

```bash
npm run build
npm run eval -- --provider deepseek --model deepseek-flash --task <hard task ids> --trials 3
```

---

## Baseline (before the fixes)

The "before" numbers. Measured on 2026-09-25 at commit `f1a7ebc` (plus a `--model` override), with Groq's free tier and the harness pacing calls under 7,000 tokens/min. There were zero rate-limit hits across all 70 runs.

- **Standard tasks:** 10 tasks × 3 trials per model.
- **Hard tasks:** 5 tasks × 1 trial per model. Each one targets a known limitation, so the agent is expected to fail them. Failing runs can use all 20 steps, so extra trials would mostly burn quota.

### Summary

| Model | Standard | Hard | Avg LLM calls* | Avg tokens* | Avg time* |
|---|---|---|---|---|---|
| `qwen/qwen3.8-27b` (default) | 30/30 | 0/5 | 3.5 | 2,412 | 22.3s |
| `openai/gpt-oss-120b` | 30/30 | 0/5 | 3.7 | 3,141 | 29.2s |

\* Averages are over the standard tasks. Time includes the agent's built-in delays and the pacing waits.

Both models passed every standard run, so accuracy doesn't separate them. `qwen3.8-27b` is the default because it used about 23% fewer tokens and was about 24% faster. `openai/gpt-oss-20b` passed 9/10 in a 1-trial screening and was dropped.

### Per task

| Task | Category | `qwen3.8-27b` | `gpt-oss-120b` | How the hard tasks failed |
|---|---|---|---|---|
| `search-button` | forms | 3/3 | 3/3 |  |
| `search-enter` | forms | 3/3 | 3/3 |  |
| `signup-checkbox` | forms | 3/3 | 3/3 |  |
| `shipping-dropdowns` | forms | 3/3 | 3/3 |  |
| `login` | forms | 3/3 | 3/3 |  |
| `feedback-radio` | forms | 3/3 | 3/3 |  |
| `slow-submit` | navigation | 3/3 | 3/3 |  |
| `store-add-to-cart` | navigation | 3/3 | 3/3 |  |
| `todo-enter` | js-app | 3/3 | 3/3 |  |
| `order-status` | extraction | 3/3 | 3/3 |  |
| `long-page-link` | hard | 0/1 | 0/1 | Snapshot cut off at 6,000 characters, so the link was never visible. The agent scrolled and guessed URLs until it ran out of steps. |
| `custom-dropdown` | hard | 0/1 | 0/1 | The div/`role=option` widget isn't in the snapshot. The agent gave up, or clicked Continue without choosing a plan. |
| `iframe-payment` | hard | 0/1 | 0/1 | Iframes are skipped, so the agent read the page repeatedly until it ran out of steps. |
| `shadow-dom-button` | hard | 0/1 | 0/1 | The Shadow DOM button isn't in the snapshot. The agent reported that no interactive elements were found. |
| `contenteditable-message` | hard | 0/1 | 0/1 | **False success:** the executor reported "✅ Typed" but nothing was typed. The agent said it had sent the message, and the server received an empty one. |

### Reproduce

```bash
npm run build
npm run eval -- --model qwen/qwen3.8-27b --task <standard task ids> --trials 3
npm run eval -- --model qwen/qwen3.8-27b --task <hard task ids> --trials 1
```
