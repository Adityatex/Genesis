# Baseline results

The "before" numbers that later changes to the agent are measured against. Measured on 2026-09-25 at commit `f1a7ebc` (plus a `--model` override), with Groq's free tier and the harness pacing calls under 7,000 tokens/min. There were zero rate-limit hits across all 70 runs.

- **Standard tasks:** 10 tasks × 3 trials per model.
- **Hard tasks:** 5 tasks × 1 trial per model. Each one targets a known limitation, so the agent is expected to fail them. Failing runs can use all 20 steps, so extra trials would mostly burn quota.

## Summary

| Model | Standard | Hard | Avg LLM calls* | Avg tokens* | Avg time* |
|---|---|---|---|---|---|
| `qwen/qwen3.8-27b` (default) | 30/30 | 0/5 | 3.5 | 2,412 | 22.3s |
| `openai/gpt-oss-120b` | 30/30 | 0/5 | 3.7 | 3,141 | 29.2s |

\* Averages are over the standard tasks. Time includes the agent's built-in delays and the pacing waits.

Both models passed every standard run, so accuracy doesn't separate them. `qwen3.8-27b` is the default because it used about 23% fewer tokens and was about 24% faster. `openai/gpt-oss-20b` passed 9/10 in a 1-trial screening and was dropped.

## Per task

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

## Reproduce

```bash
npm run build
npm run eval -- --model qwen/qwen3.8-27b --task <standard task ids> --trials 3
npm run eval -- --model qwen/qwen3.8-27b --task <hard task ids> --trials 1
```
