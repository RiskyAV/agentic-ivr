# Decision Log

Running log of technical decisions for the Blue Machines FDE assignment (AI loan-servicing PoC).
Newest decisions at the bottom. Each entry: what we decided, why, and what we gave up.

Status: `Accepted` = agreed, `Proposed` = suggested but not yet confirmed, `Superseded` = replaced by a later entry.

---

## D-001 — Language: TypeScript end to end
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** Backend (Node) and frontend (React) both in TypeScript.
- **Why:** The live review includes modifying code on the spot, and TypeScript is the stack I'm most fluent in. One language across client, server and shared types (tool schemas, events) avoids drift between them.
- **Trade-off:** Python has a richer ML/voice ecosystem, but we don't need it because all model work goes through hosted APIs.

## D-002 — Models and voice vendors: Gemini + ElevenLabs
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** Gemini for reasoning and tool calling. ElevenLabs for streaming speech-to-text (Scribe realtime) and streaming text-to-speech.
- **Why:** These are the keys I already have, and both support the streaming we need for low-latency voice.
- **Trade-off:** We're tied to two vendors. They sit behind thin adapter interfaces so either can be swapped.

## D-003 — Voice architecture: our own STT → engine → TTS pipeline (not speech-to-speech)
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** Build the pipeline ourselves: ElevenLabs STT → our query engine → ElevenLabs TTS. We are not using Gemini Live's native speech-to-speech.
- **Why:** Voice and text go through the **same engine**, so the same accuracy, tools, policies and audit apply on both channels. We control interruptions (barge-in) and filler or progress speech during slow backend calls. Each stage can be measured separately, and the reviewers said they'll judge the real interaction and latency.
- **Trade-off:** There are more moving parts, and latency could be slightly higher than an end-to-end speech model. We offset that by streaming at every stage.

## D-004 — Transport: one WebSocket per conversation, shared by text and voice
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** The browser and backend talk over a single WebSocket per session. It carries mic audio up, TTS audio down, transcripts, progress events and barge-in/cancel signals. Text chat uses the same socket. Plain REST is used only for login and dashboard data.
- **Why:** Voice needs low-latency signalling in both directions to handle interruptions. Using one socket for both channels means a customer can switch from typing to talking mid-conversation with the context kept, which supports the "one engine, many channels" story.
- **Trade-off:** It's stateful, so scaling needs sticky sessions plus an external session store (see D-007).

## D-005 — Scale path: in-memory for the PoC, Redis-backed sessions in production
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** The PoC keeps session context in process memory. The design keeps socket servers stateless apart from that store, so they can scale horizontally to 1,000 concurrent conversations by moving sessions to Redis/Memorystore and adding sticky load balancing.
- **Why:** This answers the brief's scale constraint without paying the setup cost now. The backend ships as a container (Dockerfile), so it can run unchanged on Cloud Run or GKE.

## D-006 — Second workflow (platform demo): Collections
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** The second use case is collections: the assistant helps an overdue customer understand their dues and options, then records a promise-to-pay.
- **Why:** Collections is a core Blue Machines use case. It's a genuinely different business goal (recovery rather than service) on the same customer and loan data, which shows the platform carries over while letting us reuse the most and spend time on polish. It's added mostly as configuration (tools, policies, prompt, allowed actions) on the shared engine, connectors, action/audit and telemetry layers.
- **Alternative considered:** Credit-card servicing. It's a different product, but needs a new mock system for less extra proof.

## D-007 — Accuracy approach: calculations in code, answers cite sources
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** The LLM plans and explains, and deterministic code does the maths (EMI, amortisation, prepayment savings, charges) and evaluates policy rules. Every answer carries its sources: which system, which policy clause, which formula.
- **Why:** The brief explicitly asks for precise, verifiable, customer-specific answers and "not an LLM connected to a vector database."

## D-008 — Customer journeys
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:**
  1. "Why did my EMI change?" (floating-rate reset, policy clause, before/after calculation)
  2. "What if I prepay ₹50,000?" (options and savings, prepayment-charge rules, then confirm and raise a prepayment request)
  3. "Show my failed payments and explain them" (Payments data plus bounce-charge policy, then raise a dispute)
  4. Collections: overdue dues explained, options offered, promise-to-pay recorded

## D-009 — Security model for the PoC
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** Demo login by picking one of about 5 synthetic customers, plus a mock OTP. Every tool call is scoped server-side to the authenticated customer ID, and the LLM never chooses whose data to read. Actions need explicit customer confirmation and are written to an audit log. PII is masked in logs.

## D-010 — Observability built into the product
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** A per-turn trace panel in the UI shows tools called, backend latency, retries and failures, and stage timings (STT, first token, first audio). A "chaos" toggle makes the mock backends slow or failing during the demo, and a benchmark script produces the latency numbers for the write-up.

## D-011 — Non-goals for the PoC
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** No real authentication, no real telephony or phone numbers, no database (in-memory synthetic data), no Hindi (kept as a discussion point).

## D-012 — Barge-in tuned for a video-call demo, with a push-to-talk fallback
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:**
  - Barge-in fires only on real speech: a partial transcript with at least 2 words, or about 400 ms of sustained speech. The thresholds are configurable.
  - The browser mic runs with echo cancellation, noise suppression and auto gain control.
  - A push-to-talk mode is available as a fallback.
- **Why:** The live review happens over a video call from a laptop. Speaker echo, coughs or a reviewer's voice leaking from the call would otherwise make the assistant cut itself off. Open-mic with interruptions is the headline experience, and push-to-talk is the safety net.
- **Trade-off:** A deliberate 1-word interruption ("stop") reacts slightly later. We may add a small keyword list ("stop", "wait", "hold on") that triggers barge-in immediately.

## D-013 — Collections actions use the same confirmation-gated action flow
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** Promise-to-pay and payment-link generation are proposed by the LLM and executed only after the customer confirms, exactly like the loan-servicing actions.
- **Why:** One action model across workflows is part of the platform claim, and it keeps the security guarantee uniform: the LLM never executes anything on its own.

## D-014 — Full-duplex streaming at every hop (no speculative LLM start)
- **Date:** 2026-10-25 · **Status:** Accepted
- **Decision:** Nothing in the voice path waits for a complete payload, except the user's transcript. Every hop is a stream over a persistent socket:
  1. **Browser → server:** mic audio leaves as 20–40 ms PCM chunks over our WebSocket while the user is still speaking.
  2. **Server → ElevenLabs STT:** chunks are forwarded straight to the Scribe realtime socket. Partial transcripts come back continuously and are shown as live captions only.
  3. **STT → LLM:** the LLM turn starts on the **committed (final) transcript**. The STT's end-of-turn silence threshold is tuned short (about 400–500 ms, configurable) to keep that gap small.
  4. **LLM → TTS:** Gemini's token stream is cut at clause boundaries, and each clause goes into the ElevenLabs streaming-input TTS socket immediately. The first chunk is sent early, at the first clause or about 40 characters, and the stream is flushed at the end.
  5. **TTS → browser:** audio chunks are forwarded as they arrive, played through a small jitter buffer, and kept in sync with the on-screen text.
- **Supporting latency tactics:**
  - The customer snapshot is prefetched at session start, so simple questions need no tool calls.
  - Read tools run in parallel.
  - Filler speech plays while slow tools run.
  - The STT and TTS sockets are pre-warmed when voice mode starts.
- **Why:** In a voice conversation, perceived speed is the time from the end of user speech to the first assistant audio. Streaming every hop turns that into the *time to the first token/clause* at each stage, instead of the sum of full completion times.
- **Rejected: speculative LLM start on partial transcripts** (a.k.a. preemptive generation).
  - Gemini's standard API can't take incremental input, so each transcript change means a fresh request that repeats prompt processing.
  - The saving is only about 100–300 ms, which mostly comes for free from tuning the STT silence threshold.
  - Partial transcripts are exactly where amounts change ("fifty" vs "fifteen" thousand). A restart costs more than speculation saves, and a missed restart answers the wrong number, which breaks the accuracy promise.
  - Mid-sentence pauses cause abort churn and extra backend reads.
  - It's kept as a possible future optimisation, to be adopted only if measurements show STT finalisation dominating latency.
- **Trade-off:** We accept STT finalisation time on the critical path in exchange for correctness and simpler cancellation. Clause-level TTS chunks can slightly flatten prosody compared with sending whole sentences.
- **Measured:** the trace records each hop (first partial, STT commit, LLM first token, first TTS chunk sent, first audio played), so the latency report shows where the time goes.
