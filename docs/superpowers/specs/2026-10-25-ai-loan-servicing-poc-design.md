# AI Loan Servicing PoC — Design

**Date:** 2026-10-25
**Context:** Take-home for Blue Machines (Sr. EM, Forward Deployed Engineering). Brief: `docs/brief/challenge.pdf` (JD: `docs/brief/job-description.pdf`). Decisions and rationale are logged in `/DECISIONS.md`.

**Required deliverables (from the brief):** (1) a working UI with real journeys in text and voice; (2) a functional backend (integrations, query intelligence, actions); (3) a reusable component shown across two workflows; (4) performance evidence (conversational + backend latency); (5) a concise technical write-up (architecture, decisions, trade-offs); (6) a source repo with run instructions. Submission is by email reply with the repo link. No video is required.

---

## 1. Intent

A large Indian lender (2M customers, 100k support interactions a day) wants an AI "employee" that can:

- give **precise, customer-specific, explainable** answers, not generic RAG,
- talk naturally over **live voice** (interruptions, topic changes, stays responsive while backends are slow),
- **act** across five backend systems that are slow and sometimes fail,
- be a **platform**, so the next use case (collections, cards, insurance) reuses the intelligence, integrations, context and execution layers instead of being another hardcoded bot.

The audience is the Blue Machines engineering panel, who will judge it as if it were an enterprise pitch. They will:
- watch a live demo (text and voice),
- review architecture, latency and the path to production,
- **give a new customer requirement during the interview and ask for a live code change.**

That last point drives a design rule: **the code must be easy to change live**. Small modules, clear seams, workflows defined declaratively, and no clever metaprogramming.

### Success looks like
- Four journeys work end to end in both text and voice on the hosted app.
- Every number the assistant states can be traced to a backend record, a policy clause or a deterministic calculation, and the UI shows that trace.
- Measured latency numbers (per stage, p50/p95) are in the write-up, produced by a repeatable script.
- The second workflow (collections) runs on the same platform with mostly configuration and no rebuilt plumbing.
- A reviewer can toggle backend chaos (slow or failing) live and watch the assistant degrade gracefully.

### Anti-goals (failure even if it "works")
- An LLM doing arithmetic, or inventing policy terms.
- A voice mode that is a separate, dumber code path from text.
- A demo that freezes silently while a backend call is slow.
- The LLM choosing which customer's data to read (data-access bugs that come from prompt injection).
- Monolithic "loan bot" code where collections is a copy-paste fork.

### Non-goals
Real authentication, real telephony or PSTN, a persistent database (in-memory synthetic data), multilingual/Hindi support (a discussion point only), a mobile app, an admin console.

---

## 2. Constraints

- **Language:** TypeScript end to end (Node 22 backend, React frontend).
- **Models:** Google Gemini for reasoning and function calling. ElevenLabs for streaming STT (Scribe realtime) and streaming TTS. API keys come from env vars and are never sent to the browser.
- **Transport:** one WebSocket per conversation, carrying both text and voice.
- **Runs locally with one command** (`npm install && npm run dev`) as well as hosted.
- **Ships a Dockerfile** for the backend (the production path is containerised and stateless).
- **Scale story:** the architecture must credibly evolve to 1,000 concurrent conversations (in-memory now, behind interfaces that swap to Redis).

---

## 3. Architecture overview

```
Browser (React)
  ├─ REST: /api/login, /api/me/dashboard, /api/workflows
  └─ WebSocket /ws?token=…  (one per conversation)
        ├─ up:   user_text | audio_chunk (PCM16 16kHz) | barge_in | confirm_action | set_mode
        └─ down: transcript_partial/final | assistant_delta | assistant_done | audio_chunk
                 | progress | action_proposal | action_result | trace | error

Node backend (Fastify + ws)
  ├─ Gateway        auth (HMAC token), session bind, WS protocol, mode switch text⇄voice
  ├─ Voice layer    STT adapter → turn manager (barge-in, endpointing) → TTS adapter, filler speech
  ├─ Engine         workflow-aware agent loop over Gemini: plan → tools (parallel) → compose
  │    ├─ Tool registry  (read tools, calculators, action tools)  ← supplied by workflow packs
  │    ├─ Context        session memory + prefetched customer snapshot + entity memory
  │    ├─ Grounding      sources attached to every tool result; numeric-grounding check
  │    └─ Actions        propose → customer confirm → execute (idempotent) → audit
  ├─ Connectors     resilient HTTP clients per backend system (timeouts, retries, breaker, cache)
  ├─ Domain libs    calculators (EMI, amortisation, prepayment, foreclosure, late fee)
  │                 policy engine (structured rules + clause text, evaluated in code)
  ├─ Telemetry      spans per turn → WS trace events + in-memory metrics (p50/p95)
  └─ Workflow packs loan-servicing/, collections/   (declarative definitions)

Mock enterprise systems (separate Fastify app, own port, reached over real HTTP)
  CRM · Loan Management · Payments · Policy Knowledge · Service Operations
  each with a latency profile + failure rate, adjustable at runtime (chaos controls)
```

**Why the mocks are a separate HTTP service, not function calls:** connectors then exercise real network behaviour (timeouts, retries, partial failure), and the latency we measure is honest. Swapping a mock for a real client API is a config change in the connector's base URL.

---

## 4. Repository layout

npm workspaces monorepo:

```
/apps/web            React + Vite + TS + Tailwind
/apps/server         Fastify + ws; engine, voice, platform, workflow packs
/apps/mock-systems   Fastify; five mock systems + synthetic data + chaos controls
/packages/shared     WS protocol types, DTOs, shared enums (no runtime deps)
/scripts             bench (latency), eval (accuracy golden set), load (concurrency)
/docs                write-up (ARCHITECTURE.md), latency report, specs
DECISIONS.md, README.md, Dockerfile, .env.example
```

Server internal layout (seams the reviewers may ask us to change):

```
apps/server/src/
  platform/
    engine/        orchestrator.ts, llm/gemini.ts (adapter behind LlmClient interface), prompts.ts
    tools/         registry.ts, types.ts (Tool, ToolContext, ToolResult{data, sources})
    actions/       actionService.ts (propose/confirm/execute), audit.ts
    context/       sessionStore.ts (interface + InMemory impl), customerSnapshot.ts
    connectors/    resilientClient.ts, crm.ts, loans.ts, payments.ts, policy.ts, serviceOps.ts
    grounding/     numericCheck.ts
    telemetry/     tracer.ts, metrics.ts
    voice/         stt/elevenlabs.ts, tts/elevenlabs.ts, turnManager.ts, fillers.ts
    workflows/     types.ts (WorkflowDefinition), registry.ts
  domain/
    finance/       emi.ts, amortisation.ts, prepayment.ts, foreclosure.ts, lateFee.ts
    policy/        rules.ts (evaluators keyed by clause id)
  workflows/
    loan-servicing/  index.ts (definition), tools.ts, prompt.md
    collections/     index.ts (definition), tools.ts, prompt.md
  gateway/         http.ts, ws.ts, auth.ts
```

---

## 5. Key components

### 5.1 Workflow pack: the reusable platform capability

```ts
interface WorkflowDefinition {
  id: 'loan-servicing' | 'collections' | string;
  name: string;
  systemPrompt: string;            // persona, goals, guardrails specific to this workflow
  tools: ToolName[];               // subset of the registry this workflow may use
  actions: ActionName[];           // actions it may propose (each needs confirmation)
  policyScopes: string[];          // which policy clause groups are relevant
  opener?: (snapshot) => string;   // agent-initiated first line (collections uses this)
  voice?: { voiceId?: string; fillers?: Record<ToolName, string> };
}
```

The engine, connectors, context, actions, telemetry and voice layers know nothing about loans or collections. A workflow is a definition plus (optionally) a few workflow-specific tools registered in the shared registry.

**Demo claim to make true:** collections = one definition file + a prompt + 1 read tool (`get_overdue_summary`) + 2 actions (`propose_promise_to_pay`, `propose_payment_link`, both going through the standard confirmation-gated action flow in 5.4) + 1–2 new endpoints on the Service Ops mock. Everything else is reused. The write-up will show the actual line count.

### 5.2 Engine (agent loop)

Per user turn:
1. Load session context: rolling history (last N turns, older turns summarised) + **customer snapshot** (profile, active loans summary, next EMI, last payment), prefetched in parallel at session start and refreshed after any action. Simple questions ("what's my next EMI?") answer in **one LLM call with zero tool calls**.
2. Call Gemini with the workflow's tool schemas, streaming.
3. If it requests tools, run them **in parallel** with per-tool timeouts. Emit a `progress` event per tool (voice speaks a filler if a call exceeds ~700 ms). Feed the results back. Cap at 4 iterations.
4. Stream the final answer as `assistant_delta`. On `assistant_done`, attach the **sources** gathered from the tool results.
5. Run the **numeric-grounding check**: every ₹ amount, % and date in the answer must appear in, or be derivable by rounding from, a tool result or the snapshot. Unverified numbers are flagged in the trace (and in a dev "strict" mode, the answer is regenerated once). This is cheap, deterministic, and a strong talking point on accuracy.
6. Cancellation: each turn holds an `AbortController`. Barge-in or a new user message aborts the LLM stream, any pending TTS, and ignores late tool results. Tool calls already in flight to backends are allowed to finish (read results are cached for the next turn), so they aren't wasted.

**Entity memory:** the session keeps resolved references (`activeLoanId`, last discussed amount, last proposed action) so "and what if I pay 20k instead?" works without restating anything. This lives in the prompt context as a short structured block, not just raw history.

**Customer scoping (security):** `ToolContext.customerId` comes from the authenticated session. **No tool schema has a customerId parameter.** Loan IDs passed by the LLM are checked against the customer's loans before any call.

### 5.3 Tools (loan-servicing)

Read tools (each returns `{data, sources[]}`, where a source is `{system, recordId|clauseId, label}`):
- `get_loan_details(loanId?)`: terms, outstanding principal, rate type, rate history, EMI history (LMS)
- `get_repayment_schedule(loanId?, from?, months?)` (LMS)
- `get_payment_history(loanId?, months?, status?)`: includes failure reasons and bounce charges (Payments)
- `get_policy(clauseIds | topic)`: structured clause lookup by id/topic, not vector search (Policy)
- `get_service_requests()` (Service Ops)

Calculator tools (pure functions, no I/O, sources = formula and inputs):
- `simulate_prepayment(loanId, amount, mode: 'reduce_tenure'|'reduce_emi'|'both')` → new EMI/tenure, interest saved, applicable charge (from policy rules), net benefit
- `explain_emi_change(loanId)` → diff between the last two EMIs, attributed to cause (rate reset / tenure change / partial prepayment), with before/after figures
- `check_foreclosure(loanId)` → eligibility, lock-in status, charge %, total payable today
- `list_options(loanId)` → aggregates the above into the customer's options (prepay, foreclose, EMI-date change, …)

Action tools (two-phase, see 5.4):
- `propose_prepayment_request(loanId, amount, mode)`
- `propose_payment_dispute(paymentId, reason)`
- `propose_statement_request(loanId, period)` (generates a downloadable statement, as a simple HTML/CSV mock)
- `propose_service_ticket(category, description)`

### 5.4 Actions: propose → confirm → execute

- The LLM can only **propose**. The proposal is validated in code (ownership, amounts within limits, policy eligibility) and returned to the UI as an `action_proposal` card with a human-readable summary and computed figures.
- The customer confirms by tapping the card **or by saying "yes, go ahead"** in voice. Voice confirmation is handled by the engine recognising affirmation while a proposal is pending; it never auto-executes.
- Execute calls Service Ops with an **idempotency key** (`proposalId`), so retries on timeout can't create duplicates. The result (reference number, status) goes back to the conversation and the snapshot refreshes.
- Every proposal, confirmation and result is written to an **audit log** (in memory, exposed at `/api/audit` for the demo) with PII masked.

### 5.5 Connectors: resilient clients

`ResilientClient` wraps every backend system:
- per-system timeout (e.g. CRM 800 ms, Payments 1500 ms),
- retries with jittered exponential backoff **for idempotent reads only**, and for writes **only** when an idempotency key is present,
- a circuit breaker per system (opens after N consecutive failures and fails fast),
- a short TTL cache per session for reads (cleared on a related action),
- a telemetry span per call (latency, attempt count, outcome).

On failure, the tool returns a typed `unavailable` result. The engine is prompted to tell the customer honestly what it couldn't check, answer the rest, and offer a ticket or callback. It never invents data.

### 5.6 Domain: calculators and policy engine

- **Finance calculators**: plain functions with unit tests. Reducing-balance EMI, amortisation schedule, prepayment simulation (reduce-tenure vs reduce-EMI), foreclosure amount, late fee/penal charge. Money is held in **integer paise**, and rounding is defined once.
- **Policy**: about 15–25 synthetic clauses modelled on Indian lending norms (e.g. no foreclosure/prepayment charge on floating-rate loans to individuals; fixed-rate personal loans have a 12-month lock-in and a 4%/2% foreclosure charge by loan age; bounce charge ₹500 + GST; penal charges on overdue; rate reset on repo-rate change with a choice between keeping the EMI and extending the tenure, or raising the EMI). Each clause has an `id`, `title`, `text` (shown to the user as a citation) and, where it applies, an **evaluator function** used by the calculators. Clause text and the evaluator live side by side, so a policy change is a one-file edit, which is a likely live-change request.

### 5.7 Voice layer

- **Browser:** captures mic audio via an AudioWorklet → 16 kHz PCM16 → 20–40 ms chunks over WS. Plays TTS audio chunks through a jitter buffer and can stop instantly.
- **STT:** the server holds an ElevenLabs Scribe realtime WebSocket per voice session and forwards partial and final transcripts to the browser (live captions).
- **Turn-taking:** end of turn comes from the STT's VAD/commit signal plus a short silence threshold. **Barge-in:** if the user produces speech (a partial transcript with real words, not just noise) while the assistant is speaking, the server aborts the turn (LLM + TTS), sends `barge_in` to the browser (which flushes playback), and treats the new utterance as the next turn. The history records the assistant's reply as *interrupted at "…"*, so the model knows what the user actually heard.
- **Streaming principle (D-014):** no hop waits for a complete payload except the user's transcript. Audio flows browser → server → Scribe as chunks. Partial transcripts drive the live captions only. The LLM starts on the **committed** transcript, and the STT end-of-turn silence threshold is tuned short (about 400–500 ms, configurable). A speculative start on partials was considered and rejected (see D-014). It's a future optimisation, only if measurements justify it.
- **Pre-warmed sockets:** the STT and TTS sockets are opened when voice mode starts, not per turn.
- **TTS:** the LLM token stream is cut at clause boundaries, with the first chunk sent at the first clause or about 40 characters. Each chunk is pushed into the ElevenLabs streaming-input TTS socket immediately. Audio chunks are forwarded to the browser as they arrive. First audio is targeted at **under 1 s** after end of user speech for no-tool turns.
- **Fillers / progress speech:** if a tool call is still pending after ~700 ms, a short workflow-specific filler is spoken ("Let me pull up your payment history…"). That keeps voice responsive while backends are slow, which the brief explicitly asks for.
- **Same engine:** voice turns call exactly the same `engine.runTurn()` as text. The only difference is a `channel: 'voice'` flag that asks the prompt for shorter, speakable answers (no tables; numbers phrased for speech), while the UI still renders the full sources card.
- **Mode switch:** a user can type and speak in the same session, sharing history.
- **Demo environment: online video call from the presenter's laptop.** The design has to hold up there:
  - The mic is captured with browser `echoCancellation`, `noiseSuppression` and `autoGainControl` on.
  - Barge-in triggers only on **real speech**: a partial transcript with at least 2 words, or about 400 ms of sustained speech. A cough, or a reviewer's voice leaking from the call, then doesn't cut the assistant off. The thresholds are configurable.
  - A **push-to-talk fallback** (hold Space / hold button) can be switched on if open-mic misbehaves live.
  - The presenter uses headphones.
  - The README has a "demoing over a video call" note: share the browser tab with **tab audio** so reviewers hear the assistant, with headphones on.

### 5.8 Telemetry and the trace panel

Each turn produces a trace: stage spans (`stt_final`, `llm_first_token`, each tool call with attempts/outcome, `llm_done`, `tts_first_audio`, `grounding_check`) plus derived metrics:
- **Text:** time-to-first-token, total turn time.
- **Voice:** *end-of-user-speech → first assistant audio* (the number that matters for how it feels), plus the stage breakdown.
- **Backend:** per-system latency, retries, failures, breaker state.

Traces stream to the UI's side panel live. `/api/metrics` returns p50/p95 per metric over a rolling window. Client-side marks (mic stop → first audio played) are reported back over the WS so the true perceived latency is captured.

**Chaos controls** in the UI (and `/mock/admin/chaos` on the mock service): per system, set extra latency and failure rate, e.g. "Payments: +2.5 s, 30% fail". These are used live in the demo to show retries, the breaker, fillers and honest degradation.

---

## 6. Synthetic data and journeys

Four demo customers, each built for a story (the data must make every number in these journeys exact and reproducible):

| Customer | Products | Story |
|---|---|---|
| **Rahul Mehta** | Home loan, floating (repo-linked) | Rate reset 8.50% → 9.10% last month, so the EMI rose. Prepayment has no charge (floating, individual). **Journeys 1 & 2.** |
| **Priya Sharma** | Personal loan, fixed 13.5% | Two failed NACH debits in 6 months: one for insufficient funds (bounce charge valid), one caused by a bank-side technical failure where a bounce charge was **wrongly** levied. Foreclosure: past lock-in, 4% charge. **Journey 3.** |
| **Arjun Verma** | Personal loan | 2 EMIs overdue (≈38 DPD), penal charges accrued. **Journey 4 (collections).** |
| **Neha Kapoor** | Personal loan + two-wheeler loan | Multiple loans: shows disambiguation ("which loan?") and entity memory. |

**Journeys:**
1. **"Why did my EMI go up?"** → `explain_emi_change` + rate-reset clause → before/after EMI, cause, and the clause that allows it. Follow-up: "can I keep the old EMI instead?" → option to extend the tenure, with the figures.
2. **"If I prepay ₹50,000 today, how much interest do I save?"** → both modes compared, zero charge cited → "do the reduce-tenure one" → proposal card → confirm → prepayment request with reference ID. Voice variant: *"What's my next EMI?" → "actually, check my last payment first" → "okay, would paying ₹20,000 extra reduce my tenure?"* (taken straight from the brief).
3. **"Show my failed payments in the last six months and explain."** → table + reasons + bounce-charge clause → the assistant spots that charge #2 contradicts the policy (technical failure) → proposes a dispute → confirm → dispute ticket.
4. **Collections:** the customer starts an **"incoming call from the bank" simulation** (agent-initiated opener). The assistant states the overdue amount and penal charges (computed), explains the consequences per policy, offers options (pay now via link, part payment, promise-to-pay within the allowed window), and records a promise-to-pay through `propose_promise_to_pay` (confirmation-gated like every action). "Pay now" generates a mock payment link via `propose_payment_link`. It must stay respectful, never threaten, and follow fair-practice clauses (these are in the policy pack and cited).

**Login:** a picker of the four customers + mock OTP (fixed `123456`) → the server issues an HMAC-signed session token bound to the `customerId`.

---

## 7. UI

Three-pane desktop layout, responsive down to tablet:
- **Left: account panel.** Loan cards (outstanding, rate, next EMI and date), recent payments, open requests. Updates after actions.
- **Centre: conversation.** Messages with streaming text, **source chips** (click to see the system record or clause text), inline tables (payments, schedules), action proposal cards with Confirm/Cancel, and suggested next prompts. A voice control with a mic toggle, live captions, a speaking indicator, and an interrupt affordance.
- **Right (collapsible): "Under the hood".** A live per-turn trace (waterfall of stages and tool calls with timings), rolling p50/p95, and chaos controls.
- **Header:** workflow switcher (Loan Servicing / Collections call) and customer identity.

The aim is to look like a product a lender's CX head would recognise: clean and calm, with the bank's (fictional) branding.

---

## 8. Performance evidence

- `scripts/bench`: runs the journey scripts over text N times (e.g. 20) against the live stack and records TTFT, total turn time, tool counts and per-system latency → writes `docs/latency-report.md` with p50/p95 tables. It runs once with default latencies and once under chaos.
- Voice: measured in-app (client marks reported to the server) during scripted voice runs. The report includes p50/p95 of end-of-speech → first audio, with the stage breakdown.
- `scripts/load`: N concurrent simulated conversations (e.g. 50–200) against the WS gateway with a **stub LLM** (fixed latency) to measure server overhead, memory per session and event-loop lag. The aim is to show where the 1,000-concurrency limits actually are, without burning API quota.
- `scripts/eval`: a golden set of about 25 questions across the four customers with expected figures. It checks that answers contain the right numbers and sources and reports accuracy, as evidence for the "precise answers" claim.

---

## 9. Security controls (PoC level, named honestly in the write-up)

- The session token is bound to the customer, and every data access is scoped server-side (no customer id in tool args, loan ownership checked).
- Actions are confirmation-gated, idempotent and audited.
- Logs and traces mask PII (phone, PAN, account numbers). Prompts include only the fields needed.
- Prompt-injection posture: tool outputs are treated as data. The system prompt tells the model to ignore instructions inside data, and **it doesn't matter much anyway**, because the model has no capability beyond its scoped tools and every action needs human confirmation.
- Secrets live in the server env only. The browser never talks to Gemini or ElevenLabs directly.

---

## 10. Production path (write-up section, not built)

Redis/Memorystore for sessions and the breaker/caches. Sticky WS routing at the load balancer. Horizontal pods on Cloud Run/GKE. OpenTelemetry export to a real backend. Real auth (OIDC + step-up OTP for actions). A policy store with versioning and effective dates. Eval in CI. Telephony via SIP/Twilio media streams feeding the same voice layer. Vendor fallback (secondary TTS/STT/LLM). Hindi/Hinglish.

---

## 11. Decided vs left to the builder

**Decided (see DECISIONS.md):** TypeScript; Gemini + ElevenLabs; our own STT→engine→TTS pipeline; one WS per conversation for both channels; in-memory state behind interfaces; collections as workflow 2; calculations in code with cited sources; the four journeys; the security model; the trace panel and chaos controls; the non-goals; the mocks as a separate HTTP service.

**Builder's call (my defaults, can be changed):**
- **Gemini model:** the fastest current Flash-class model with function calling, chosen by checking the available models at build time; configurable via env.
- **ElevenLabs:** Scribe realtime for STT and a Flash/Turbo low-latency TTS model, with a pleasant Indian-English voice; configurable.
- Fastify + `ws`; Vite + React + Tailwind; vitest; zod for tool schemas (converted to Gemini function declarations).
- Exact synthetic numbers (to be tuned so the stories are clear and the maths is checkable by hand).
- Filler timing (≈700 ms) and the history-summarisation threshold.
- Visual design details.

- A frozen demo "today" date (env `DEMO_TODAY`), so the synthetic data, the eval figures and the bench results are reproducible.

**Timeline and cut line:** the deadline has been extended, so the plan targets the full scope. If time gets tight, cut in this order (the first cut goes first), and describe each cut item in the write-up instead: strict-mode answer regeneration → `scripts/load` → statement-generation action → client-side latency marks (fall back to server-side marks) → Neha (multi-loan customer). Never cut: the four journeys in text and voice, barge-in, fillers, actions with confirmation, the trace panel, chaos, collections, bench, eval or the write-up.

**Deployment (operational, not an architecture decision):** the hosted demo runs on an existing GCP VM (Node 22 + nginx already present) as systemd services, with an nginx server block (WebSocket upgrade, long read timeouts) for the API. The frontend is static on Cloudflare Pages. Server and mocks run as two processes on the same host; the mocks bind to localhost only. The Dockerfile builds server + mocks into one image (two processes via a tiny launcher) for the Cloud Run story. **Quota protection:** the hosted app requires a demo access code at login (env `DEMO_ACCESS_CODE`), with a per-IP rate limit and a cap on concurrent voice sessions (e.g. 5). Redeploy is a single `npm run deploy` script (build → rsync → restart), so a live change can be shipped in about a minute.

**Build order (to de-risk the hardest parts first):**
1. Mock systems + data + calculators/policy (with tests)
2. Engine + tools + text chat over WS
3. Voice pipeline + barge-in + fillers
4. Actions + audit
5. UI polish + trace panel + chaos
6. Collections pack
7. bench/eval/load scripts + write-up
8. Deploy
