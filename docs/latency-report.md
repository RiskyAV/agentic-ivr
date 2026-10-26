# Latency and load report

Produced by `npm run bench`, `npm run load` and `scripts/voice-smoke.ts` against the running stack (see each section for the command and conditions). Times are milliseconds. p50 and p95 use nearest-rank.

## Default









Model `gemini-3.5-flash-lite` (guard `gemini-3.5-flash-lite`). Default mock latencies, no chaos. Command: `npm run bench -- --runs 20`.

20 runs of each journey (140 turns).

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| llm_first_token (round 1) | 140 | 1059 | 1562 | 2043 |
| first_delta (first text out) | 140 | 3178 | 5518 | 7846 |
| turn_total (server) | 140 | 3444 | 5654 | 8016 |
| turn, client-measured send to trace | 140 | 3471 | 5677 | 8042 |
| guard verdict | 140 | 861 | 1101 | 1853 |
| confirm_action round trip | 60 | 1890 | 2813 | 3297 |
| tool:explain_emi_change | 20 | 492 | 654 | 756 |
| tool:get_overdue_summary | 24 | 1282 | 2212 | 2335 |
| tool:get_payment_history | 37 | 1782 | 2186 | 2251 |
| tool:propose_dispute | 20 | 789 | 1839 | 1953 |
| tool:propose_prepayment | 20 | 818 | 976 | 1044 |
| tool:propose_promise_to_pay | 20 | 1686 | 2364 | 2862 |
| tool:simulate_prepayment | 20 | 851 | 1089 | 1110 |
| backend:lms | 298 | 274 | 393 | 403 |
| backend:ops | 46 | 758 | 1156 | 1188 |
| backend:payments | 146 | 584 | 892 | 1270 |
| backend:policy | 169 | 58 | 81 | 84 |

**Resilience counters**

- Backend calls: 659; hedged: 0 (0.0%); failed or timed out: 10; stale-served: 0.
- Guard timeouts (no verdict within the wait): 0; turns that ended degraded: 0 of 140.

**turn_total by journey (server, per turn)**

| Journey | turns | p50 | p95 |
|---|---|---|---|
| J1 | 20 | 2847 | 3894 |
| J2 | 40 | 3182 | 4025 |
| J3 | 40 | 4911 | 6949 |
| J4 | 40 | 3425 | 4471 |

## Chaos










Model `gemini-3.5-flash-lite` (guard `gemini-3.5-flash-lite`). Chaos `--chaos payments:2500:0.3` (payments +2500 ms, 30% failures). Command: `npm run bench -- --runs 20 --chaos payments:2500:0.3`.

20 runs of each journey (140 turns).

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| llm_first_token (round 1) | 140 | 1271 | 2397 | 7558 |
| first_delta (first text out) | 140 | 3088 | 5610 | 9005 |
| turn_total (server) | 140 | 3335 | 6058 | 9257 |
| turn, client-measured send to trace | 140 | 3358 | 6087 | 9287 |
| guard verdict | 140 | 1164 | 1477 | 9256 |
| confirm_action round trip | 29 | 1561 | 2002 | 3337 |
| tool:explain_emi_change | 20 | 566 | 723 | 742 |
| tool:get_overdue_summary | 34 | 1674 | 1893 | 1903 |
| tool:get_payment_history | 25 | 268 | 392 | 393 |
| tool:get_policy | 8 | 268 | 403 | 403 |
| tool:get_service_requests | 7 | 922 | 1178 | 1178 |
| tool:propose_prepayment | 20 | 760 | 955 | 991 |
| tool:propose_promise_to_pay | 15 | 226 | 397 | 397 |
| tool:propose_ticket | 9 | 0 | 0 | 0 |
| tool:simulate_prepayment | 21 | 818 | 1047 | 1071 |
| backend:lms | 244 | 273 | 389 | 404 |
| backend:ops | 40 | 824 | 1163 | 1176 |
| backend:payments | 73 | 0 | 1503 | 1503 |
| backend:policy | 196 | 57 | 81 | 84 |

**Resilience counters**

- Backend calls: 553; hedged: 0 (0.0%); failed or timed out: 74; stale-served: 0.
- Guard timeouts (no verdict within the wait): 3; turns that ended degraded: 4 of 140.

**turn_total by journey (server, per turn)**

| Journey | turns | p50 | p95 |
|---|---|---|---|
| J1 | 20 | 3049 | 4035 |
| J2 | 40 | 3220 | 4254 |
| J3 | 40 | 3457 | 9005 |
| J4 | 40 | 4925 | 6058 |

Runner errors (31): J3 step 3: no proposal to confirm; J4 step 3: no proposal to confirm

## Model comparison




Same four journeys (5 runs each, real Gemini, default backend latencies); the guard model is gemini-3.5-flash-lite for all rows. Accuracy is from the final iteration of the golden and red-team evals (docs/eval-report.md).

| Model | Golden (3 runs) | Red team (required 15 + extras) | llm_first_token p50 / p95 | turn_total p50 / p95 | J1 p50 / p95 | J2 p50 / p95 | J3 p50 / p95 | J4 p50 / p95 | degraded turns |
|---|---|---|---|---|---|---|---|---|---|
| gemini-2.5-flash | 25/28, 23/28, 23/28 | 15/15, 15/15, 15/15 | 1176 / 1404 | 3638 / 5416 | 3359 / 3906 | 3390 / 3700 | 3987 / 5416 | 3663 / 5575 | 0/35 |
| gemini-3.5-flash-lite | 27/28, 27/28, 27/28 | 15/15, 15/15, 15/15 | 1065 / 1709 | 3419 / 5813 | 2884 / 3151 | 3205 / 3886 | 4968 / 7234 | 3502 / 3960 | 0/35 |
| gemini-3.8-flash | 25/28, 22/28, 22/28 | 15/15, 15/15, 15/15 | 2154 / 3075 | 5821 / 8531 | 6314 / 8531 | 5693 / 6174 | 6126 / 8549 | 5809 / 7806 | 0/35 |

## Where the time goes



Median share of a turn's server time (default run, 140 turns, flash-lite): LLM rounds about 67%, tool execution about 32%, everything else (prompt build, rendering, numeric check) under 1%. The guard classifier (median 861 ms, p95 1.1 s) runs in parallel with the turn and is never on the critical path in these runs: the 2 s wait for its verdict was only reached 0 times of 140 in the default run (3 times of 140 under chaos).

- **LLM first token is about 1.06 s (p95 1.56 s)** and a turn with one tool call needs two LLM rounds, so the model alone is roughly 2 s of a 3.4 s median turn. This is the largest item and the one we can only shrink by prompt size (prefix is cache-friendly and byte-stable), fewer rounds (combined tools such as explain_emi_change, simulate_prepayment, list_options), or a faster model. gemini-3.8-flash doubles it (2.2 s first token, 5.8 s median turn), which is why it is not the default.
- **Tools cost 0.5 to 1.8 s** because they fan out to several backends: get_payment_history (p50 1.78 s) reads the payment list, the policy clause, and the customer's failed payments across loans; get_overdue_summary (1.28 s) reads pending instalments, three policy clauses and the service requests. J3 (failed payments, p50 4.9 s) and J4 (collections, p50 3.4 s) are the slowest journeys for that reason. The Ops write for a confirmed action takes about 0.76 s (backend:ops p50) and a confirm round trip 1.9 s p50 including the snapshot refresh.
- **Backends are not the bottleneck**: lms 274 ms, payments 584 ms, policy 58 ms at p50; hedging never fired (0 of 659 calls) because the 10% hedge budget needs slow outliers that default latencies do not produce.
- **Under chaos (payments +2.5 s, 30% failures)** every turn still ended inside the 9 s budget (max 9.26 s, p95 6.1 s). The payment calls that fail or time out cost up to 1.5 s each (the per-call timeout) and are retried; a slow payments system raises J3's p95 to 9.0 s, the budget, where the answer is an honest 'I could not check that' rather than a hang. 4 of 140 turns ended degraded and 3 guard verdicts timed out (the answer stood, nothing actionable was offered).
- **Voice adds two more costs**: end-of-speech to final transcript is about 1.0 s (the STT silence window is 0.45 s plus vendor commit), and TTS first audio follows the first sentence. In the voice runs, first audio at the client is p50 3.5 s and p95 6.3 s after the user stops speaking, dominated by the LLM first token (p50 2.3 s in voice, p95 5.1 s, because the voice channel prompts and the tool round are longer than the text journeys' first token). This is above the 2 s target; levers are a filler line while tools run (already spoken after 700 ms), a faster first-sentence path, and speculative tool calls on the partial transcript.

## Voice











`npx tsx scripts/voice-smoke.ts` run 5 times (real Gemini, real ElevenLabs STT and TTS, in-process mocks; macOS `say` fixtures of "What's my next EMI?" and "Actually, check my last payment first."). Scenario 1 gives the first five rows; the barge-in row comes from scenario 2. The first-audio row at the test client is the end-of-speech to first audio frame as the WebSocket client sees it; browser playback adds the audio output buffer on top, and a browser-measured end-to-end figure from the Task 19 run is not repeated here.

| Stage | n | p50 | p95 |
|---|---|---|---|
| STT commit (end of speech to final transcript) | 5 | 983 | 1014 |
| LLM first token (engine, after turn start) | 5 | 2297 | 5085 |
| First TTS audio, server (commit to first audio frame sent) | 5 | 2507 | 5347 |
| First TTS audio at the test client (end of speech to first audio frame) | 5 | 3510 | 6318 |
| turn_total (engine) | 5 | 2363 | 5161 |
| Barge-in (interruption begins to barge_in event) | 5 | 1265 | 1274 |

## Concurrency





Run with `npm run load -- --sessions N --turns 5`: the server (stub LLM, real gateway, engine, guard rules, connectors and mock systems) and the load generator run on the same Mac, so the generator competes for CPU; treat the numbers as a floor for server overhead.


Run with `npm run load -- --sessions N --turns 5`: the server (stub LLM, real gateway, engine, guard rules, connectors and mock systems) and the load generator run on the same Mac, so the generator competes for CPU; treat the numbers as a floor for server overhead.


Run with `npm run load -- --sessions N --turns 5`: the server (stub LLM, real gateway, engine, guard rules, connectors and mock systems) and the load generator run on the same Mac, so the generator competes for CPU; treat the numbers as a floor for server overhead.


Run with `npm run load -- --sessions N --turns 5`: the server (stub LLM, real gateway, engine, guard rules, connectors and mock systems) and the load generator run on the same Mac, so the generator competes for CPU; treat the numbers as a floor for server overhead.

**200 sessions x 5 turns, LLM concurrency 50 (default)**

- Setup: 200 sessions x 5 turns over WebSocket, stub LLM with 600 ms per chunk-step (an ideal turn is about 1800 ms: three chunk-steps), LLM concurrency limit 50, think time 0 to 2x the configured mean between turns. 200/200 sessions connected.
- Turns: 1000 completed, 0 failed, 0 answered with the "very high demand" message (limiter queue timeout). Wall time 37.9 s.
- Turn latency, client send to answer: p50 5555 ms, p95 6003 ms, max n/a ms. Server turn_total: p50 5551 ms, p95 6001 ms.
- llm_first_token (includes limiter wait): p50 2241 ms, p95 2459 ms.
- Limiter: peak active 50, peak queued 114.
- Event-loop lag p99 (cumulative histogram of the server process): peak 22.7 ms, at the end 22.7 ms.
- Server RSS: 108 MB idle, 179 MB with all sessions connected (364 KB per idle session), 194 MB peak under load.

**200 sessions x 5 turns, LLM concurrency raised to 400 (isolates server overhead)**

- Setup: 200 sessions x 5 turns over WebSocket, stub LLM with 600 ms per chunk-step (an ideal turn is about 1800 ms: three chunk-steps), LLM concurrency limit 400, think time 0 to 2x the configured mean between turns. 200/200 sessions connected.
- Turns: 1000 completed, 0 failed, 0 answered with the "very high demand" message (limiter queue timeout). Wall time 23.7 s.
- Turn latency, client send to answer: p50 2316 ms, p95 2515 ms, max 2595 ms. Server turn_total: p50 2312 ms, p95 2510 ms.
- llm_first_token (includes limiter wait): p50 600 ms, p95 602 ms.
- Limiter: peak active 127, peak queued 0.
- Event-loop lag p99 (cumulative histogram of the server process): peak 23.0 ms, at the end 22.6 ms.
- Server RSS: 108 MB idle, 178 MB with all sessions connected (358 KB per idle session), 266 MB peak under load.

**500 sessions x 5 turns, LLM concurrency 50 (default)**

- Setup: 500 sessions x 5 turns over WebSocket, stub LLM with 600 ms per chunk-step (an ideal turn is about 1800 ms: three chunk-steps), LLM concurrency limit 50, think time 0 to 2x the configured mean between turns. 500/500 sessions connected.
- Turns: 2500 completed, 0 failed, 221 answered with the "very high demand" message (limiter queue timeout). Wall time 54.9 s.
- Turn latency, client send to answer: p50 9005 ms, p95 9008 ms, max 9016 ms. Server turn_total: p50 9001 ms, p95 9002 ms.
- llm_first_token (includes limiter wait): p50 4310 ms, p95 4532 ms.
- Limiter: peak active 50, peak queued 432.
- Event-loop lag p99 (cumulative histogram of the server process): peak 22.6 ms, at the end 22.5 ms.
- Server RSS: 108 MB idle, 222 MB with all sessions connected (233 KB per idle session), 301 MB peak under load.

**500 sessions x 5 turns, LLM concurrency raised to 1000**

- Setup: 500 sessions x 5 turns over WebSocket, stub LLM with 600 ms per chunk-step (an ideal turn is about 1800 ms: three chunk-steps), LLM concurrency limit 1000, think time 0 to 2x the configured mean between turns. 500/500 sessions connected.
- Turns: 2500 completed, 0 failed, 0 answered with the "very high demand" message (limiter queue timeout). Wall time 24.8 s.
- Turn latency, client send to answer: p50 2312 ms, p95 2525 ms, max 2596 ms. Server turn_total: p50 2308 ms, p95 2521 ms.
- llm_first_token (includes limiter wait): p50 600 ms, p95 601 ms.
- Limiter: peak active 307, peak queued 0.
- Event-loop lag p99 (cumulative histogram of the server process): peak 22.7 ms, at the end 22.6 ms.
- Server RSS: 108 MB idle, 222 MB with all sessions connected (233 KB per idle session), 326 MB peak under load.

## Path to 1,000 concurrent


What the load test shows (stub LLM, 600 ms per chunk-step, one Node process on the same Mac as the load generator):

- Server overhead is small. 500 sessions with the LLM limiter lifted: p50 2.31 s and p95 2.53 s for a turn whose ideal time is 1.8 s plus about 0.4 s of real tool and backend work; event-loop lag p99 stays at the 20 ms resolution floor; no failures. Memory is about 230 to 360 KB per idle session (RSS 108 MB empty, 222 MB with 500 sessions, 326 MB peak under load), so 1,000 sessions is roughly 400 MB.
- **What breaks first is the LLM concurrency limit, by design.** At the default 50 concurrent model calls and a 4 s queue timeout, 200 sessions still all complete (queue up to 114, p50 5.6 s), but 500 sessions queue 432 deep, p50 reaches the 9 s turn budget and 221 of 2,500 turns answer 'very high demand'. The shed load is correct behaviour, but it means 1,000 users on a 50-wide limit is not usable.
- **Next to break, in this order:** (1) the provider's own rate limits (requests and tokens per minute on the Gemini key) before our limiter matters: 1,000 active users at one turn per 10 s is about 200 model calls a second including the guard; (2) the single event loop: synchronous JSONL appends in the event log (appendFileSync per event), JSON serialisation of every delta and trace, and the per-session snapshot loads all run on one thread; the lag is invisible at 500 but is the first CPU limit; (3) mock/real backend fan-out (each cold turn makes 3 to 7 backend calls) and the per-process connector caches; (4) in-memory sessions and the in-memory action/audit stores tie a user to one process.
- **What to change:** raise LLM_MAX_CONCURRENCY to the provider quota and add a second API key or a provisioned-throughput tier, with the guard on its own limiter so it cannot starve answers; replace appendFileSync with a buffered async writer (or ship events to a log pipeline); run N Node processes behind a load balancer with sticky routing by session id (WebSocket affinity) and move sessions, proposals and the audit log to Redis or a database so a reconnect can land anywhere; put a shared cache (Redis) in front of the read endpoints and keep hedging on; shed load before the model call (admission control by queue depth rather than timeout) and keep voice on a separately capped pool (MAX_VOICE_SESSIONS) since each voice session also holds an STT and a TTS websocket to the vendor. The cost to model is tokens, not CPU: the engine is sub-millisecond per turn in these runs.

## Deterministic replay

`npm run replay -- <sessionId> [--turn n] [--live-llm]` rebuilds the engine with the logged backend responses (served by method and path, in order), the logged LLM output and the logged guard verdicts. A recorded voice-journey session (text channel, flash-lite; "What's my next EMI?", "Actually, check my last payment first.", "Okay, would paying ₹20,000 extra reduce my tenure?"):

```
$ npm run replay -- 5a49c37f-0cf7-481d-8d24-f59a8d8592e0
session 5a49c37f-...: 3 turn(s), LLM recorded, backend recorded
--- turn 1: "What's my next EMI?"  [completed]
ORIGINAL: Your next EMI is ₹27,045, due on 5 Nov 2026.
REPLAYED: Your next EMI is ₹27,045, due on 5 Nov 2026.
IDENTICAL
--- turn 2 ... IDENTICAL      --- turn 3 ... IDENTICAL
All shown turns are identical.
```

With `--live-llm` the same session is replayed through live Gemini against the same recorded backend. Turn 1 is identical; turn 3 differs only in wording (figures identical: 3 months, 195 months, ₹68,474, 0.00%):

```
ORIGINAL: Yes, paying ₹20,000 extra toward your loan would reduce your tenure by 3 months ... Under our prepayment policy (PRE-01), there are no prepayment charges (0.00%). You would save ₹68,474 in interest. ...
REPLAYED: Yes, paying ₹20,000 extra will reduce your tenure by 3 months ... You will save ₹68,474 in interest, and there is no prepayment charge (0.00% fee, total charge ₹0). ...
```

Turn 2 shows the limit of the approach: the live model asked the payment system for a different window (`months=1` instead of the recorded call), the log has no response for that request, so the replay served a 404 and the model answered 'the payment system is currently unavailable'. The script lists such unrecorded requests. Replay also reproduces model faults exactly: a gemini-2.5-flash session whose answer carried an [unverified] marker replays with the same marker, which is how the numeric-check failures above were debugged. Not replayed: confirm_action (execution) steps, and sessions recorded before the snapshot load was logged.
