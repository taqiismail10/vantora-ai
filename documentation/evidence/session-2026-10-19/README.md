# Execution evidence — sandbox session, 2026-10-19

**Deliverable 06** (simulated-account / sandbox operation logs). Frozen copy, recorded with the app's ordinary
audit logger; tests can never write here (`vitest.global-setup.ts` fails the run if this folder changes).

| File | What it is |
|---|---|
| `sandbox_operation_logs.jsonl` | 24-entry SHA-256 hash chain, genesis-linked, produced by the running app |
| `screens/01-viewer-dashboard-1440.png` | Signed in as VIEWER: verdict bar, progress rail, write controls disabled |
| `screens/02-owner-approval-dialog.png` | OWNER approving the 3-action plan: per-action effects, cash vs modelled risk, plan version, typed confirmation |
| `screens/03-owner-after-decline-revised-plan.png` | After the simulated Zara decline: the re-solved plan, settled cash shown apart from forecasts |
| `screens/04-owner-mobile-375.png` | 375 px layout with all four workspace tabs visible |

Verify it yourself:

```bash
npm run verify-evidence -- docs/evidence/session-2026-10-19/sandbox_operation_logs.jsonl
# … {"valid":true,"length":24,"brokenAtSeq":null,"reason":null}
```

## How this was produced — read this before relying on it

- **Real application, real accounts, real timestamps.** The app ran locally (`next dev`, Python HiGHS engine
  connected) against a throwaway evidence database. Three accounts were provisioned with
  `npm run users` (OWNER, ANALYST, VIEWER), each signed in through the real login form, and every entry below
  carries the server clock at the moment the request was handled. No timestamp was written by hand.
- **The browser was operated by an automated agent, not by a person.** Entries 1–20 were produced by
  Playwright driving Chromium on behalf of the project team, signed in as those accounts; entries 21–24 by
  `curl` with a real session cookie. `actorType: "human"` means *a signed-in human account made the request*,
  which is what the server can know — not that a person's hands were on the keyboard. The team's own
  recording (see `docs/VANTORA_IMPLEMENTATION_STATUS.md`, owner checklist) is the place for that.
- **No AI model ran in this session.** `GEMINI_API_KEY` was not configured, so every copilot answer was the
  deterministic synthesiser, labelled as such in the UI. The `agent` entries 13–18 are the red-team harness
  (scripted attacks run through the gate), not model tool calls. Live Gemini evidence is pending the key.
- **Everything is sandboxed.** No buyer, supplier or lender was contacted; counterparty responses were recorded
  with the explicit "Simulate counterparty" controls and are labelled `SANDBOX SIMULATION` in the chain.
- **The evidence accounts no longer exist.** The evidence database was deleted after the session, so none of
  its credentials can sign in anywhere.

## The session, entry by entry

| seq | actor | what happened | decision |
|---:|---|---|---|
| 1 | ANALYST | drafted the clerk-signed 3-way reconciliation request to Kenneth Cole (Tier 1) | DRAFTED |
| 2–3 | OWNER | approved the full 3-action plan, confirming the **$868.88 cash cost**, and submitted it | ALLOWED |
| 4–5 | OWNER (simulated lender) | Meridian accepted, then funded: **$2,345 settled** in the sandbox account | ALLOWED |
| 6 | OWNER (simulated supplier) | Midland accepted the deferral to day 31 | ALLOWED |
| 7 | OWNER (simulated buyer) | **Zara declined** the early-pay offer → plan re-solved, outstanding approvals revoked | ALLOWED |
| 8–9 | OWNER | approved and submitted the revised plan (Urban Retail 2.5%, Northside 3%, second Meridian draw: $1,150.44 cash) | ALLOWED |
| 10–11 | OWNER | approved and submitted the Heritage SBA draw for the newly surfaced **day-22** shortfall | ALLOWED |
| 12 | OWNER | the same approval presented a second time, concurrently — **refused** | DENIED |
| 13–18 | red-team harness | 5 attacks refused (no token, forged token, invented figures, injected memo, Tier 3 with a valid token) + 1 allowed control | 5 DENIED, 1 ALLOWED |
| 19–20 | OWNER | under the **workforce-150 stress scenario**, approved and submitted that scenario's 4-action plan ($1,762.82 cash) | ALLOWED |
| 21 | OWNER | tried to approve $10,000,000 from Granite — **refused: credit score 672 below minimum 700** | DENIED |
| 22 | OWNER | tried to approve $90,000 from QuickFloat — **refused: not part of the current plan** | DENIED |
| 23 | OWNER | tried a facility that does not exist, negative amount — **refused** | DENIED |
| 24 | OWNER | tried to execute the plan with no approval token and nothing left to execute — **refused** | DENIED |

Not in the chain by design: requests that never reached an authenticated actor (anonymous calls answered 401,
VIEWER/ANALYST approval attempts answered 403, forged `role`/`actorId` bodies answered 400). Those were observed
in the same session and are covered by `src/lib/server/__tests__/authorization.test.ts`.

## Relation to `logs/sandbox_operation_logs.jsonl`

That older 17-entry file is **left untouched** and is *not* this evidence: it was generated by an automated test
run (all 17 timestamps within one millisecond) before tests were isolated from the application log. It is kept
so no history is rewritten, and it should not be presented as a human session.
