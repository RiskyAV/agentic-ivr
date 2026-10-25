# AI Loan Servicing PoC

A voice and text assistant for loan servicing. It answers from mock enterprise systems (CRM, LMS, payments, policy, ops) and proposes actions that the customer must explicitly confirm. The repo has a Node server, mock backends and a React web app.

## Run

```
npm install
cp .env.example .env   # fill in API keys (or set LLM_PROVIDER=stub)
npm run dev
```

Web: http://localhost:5173, server: :4000, mock systems: :4100.

## Layout

- `packages/shared` wire protocol and view types
- `packages/domain` pure finance, formatting and policy logic
- `apps/mock-systems` mock enterprise backends
- `apps/server` agent platform and gateway
- `apps/web` React UI

See `DECISIONS.md` for technical decisions.
