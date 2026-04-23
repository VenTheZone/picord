# DECISIONS.md

## Technical Decisions Log - Picord

---

## Decision 1: Fix setTimeout leak in prompt timeout handler

### Context
Picord (Discord bot "Luxia") died after ~2-5 chats from the agent. Process disappeared without OOM kill, SIGTERM, or dmesg evidence. Node.js event loop gradually choked.

### Root Cause
`pi-session.ts` line 888-909: every `prompt()` call created a `setTimeout` that was never `clearTimeout`'d. Each chat leaked a dangling 60-second timeout plus a hanging SDK prompt promise. After several chats, accumulated dead promises blocked the event loop. Process appeared "killed" but actually starved.

### Alternatives Considered
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Restructure entire prompt flow with AbortController | Clean cancellation | Requires SDK-level changes | Rejected — too invasive |
| Add `clearTimeout` in `finally` block | Minimal change, zero behavior change | Still uses Promise.race pattern | Accepted |

### Decision
Added `let timeoutId` with `ReturnType<typeof setTimeout>` type, stored timeout ID, and cleared it in a `finally` block. Also added catch block for "Prompt timeout" with stuck-session auto-disposal.

### Code Location
```
src/pi-session.ts:887-915
```

### Consequences
- ✅ No more timeout leaks
- ✅ Prompt timeout still fires correctly when model hangs
- ⚠️ Underlying SDK prompt promise may still hang in background (harmless after timeout fires)

---

## Decision 2: Add Discord shard resilience handlers

### Context
Picord had zero handling for Discord websocket drops. A transient disconnect could orphan the bot.

### Root Cause
No `ShardDisconnect`, `ShardReconnecting`, or `ShardResume` event listeners registered.

### Decision
Added three event handlers in `src/index.ts` near existing `Events.Error` handler. Logs via `ctx.ui.notify` so issues are visible in Discord host channel.

### Code Location
```
src/index.ts:1527-1542
```

### Consequences
- ✅ Discord disconnects now logged and auto-recovered by discord.js
- ⚠️ Only observability added — discord.js handles reconnection internally

---

## Decision 3: Always abort DM conversations before responding

### Context
DM conversations could get stuck if previous respond() was still running.

### Root Cause
`discord-bot.ts` only aborted when `isStreaming()` returned true. If a session was deadlocked but not streaming, new messages would pile up.

### Decision
Removed the `isStreaming()` guard. Always seal, clear, abort, and wait before starting new respond().

### Code Location
```
src/discord-port/discord-bot.ts:180-200
```

### Consequences
- ✅ New DMs always start from clean state
- ⚠️ Adds ~50-200ms latency per DM (abort wait)

---

## Decision 4: Disable NVIDIA NIM provider (z-ai/glm-5.1 endpoint dead)

### Context
After fixing the timeout leak, sessions still timed out every chat. Root cause traced to model, not code.

### Root Cause
`z-ai/glm-5.1` on NVIDIA NIM `https://integrate.api.nvidia.com/v1` hangs indefinitely — curl returns HTTP 000 (connection timeout) after 25s. Other NVIDIA models (e.g. `meta/llama-3.3-70b-instruct`) return 200 OK instantly. Model-specific failure on NVIDIA's side.

### Alternatives Considered
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Hardcode model to `llama-3.3-70b` in picord config | Fast fix | Couples bot to specific model | Rejected |
| Disable nvidia-nim provider entirely | Uses working providers only (OpenRouter, Cline, Kilo, OpenCode) | Loses NVIDIA-specific models | Accepted |
| Wait for NVIDIA to fix | Zero code change | Bot unusable until then | Rejected |

### Decision
Set `nvidia-nim.enabled = false` in `~/.pi/agent/dynamic-model-providers.json`. Picord now auto-selects from OpenRouter/Cline/Kilo/OpenCode. Model scope updated from 134 NVIDIA models to working providers.

### Consequences
- ✅ Picord responds immediately instead of hanging
- ✅ No more "Prompt timeout - session may be deadlocked" in logs
- ❌ NVIDIA NIM models unavailable until endpoint fixed

### Validation
1. `curl` to `z-ai/glm-5.1` → HTTP 000, timeout
2. `curl` to `meta/llama-3.3-70b-instruct` → HTTP 200, instant
3. After disabling nvidia-nim, picord startup banner shows `(opencode) big-pickle`
4. No timeout errors in `~/.picord/picord-run.log` after restart

---

*Document version: 2026-04-23*
