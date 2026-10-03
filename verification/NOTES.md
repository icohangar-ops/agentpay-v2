# AgentPay v2 — policy engine verification notes

Model: `Policy.lean` (Lean 4.34.1, core library only; compiles with
`~/.elan/bin/lean Policy.lean`, exit 0, no warnings). No `sorry`/`admit`;
`#print axioms` on the main theorems shows only `propext` and
`Quot.sound`. No source files were modified.

All line references are to `src/lib/treasury/agent.ts` unless noted.

## What was modelled

`TreasuryAgent.evaluate` runs a deterministic policy stage
(`applyPolicy`) and, only if that returns `null`, an LLM review stage
(GLM-4.6). The Lean model transcribes `applyPolicy` rung by rung and
models the LLM as an **arbitrary oracle** `llm : Ctx → Int → Decision`,
so the end-to-end theorems quantify over every possible LLM behaviour.
That is precisely the guarantee the code's short-circuit provides —
and, as finding 4 below shows, it is also *all* it provides.

Abstractions: money is `Int` (the code's `bigint` arithmetic is exact,
so this is faithful); the service-policy string is quotiented to the
three behaviours the code distinguishes (`'BLOCKED'`,
`'AUTO_APPROVE_UNDER'`, everything else); budget thresholds enter the
model as already-converted mote values (see finding 8); the trust
score is modelled as `Int` (only the `≥ 70` comparison matters).

## Theorem → source mapping

| Lean declaration | Property | Source |
|---|---|---|
| `applyPolicy` (def) | First-match-wins chain: blocklist → balance → hourly budget → auto-approve → fall through | agent.ts:214–272 (rungs 220–229, 231–241, 245–254, 256–269; `return null` 271) |
| `evaluate` (def) | Policy decision short-circuits; LLM consulted only on `null` | agent.ts:188–206 (short-circuit 195–200, LLM call 203) |
| `blocked_denies` | Policy = BLOCKED ⇒ DENY / `AUTO_DENY_BLOCKED` / 0 motes, unconditionally (blocklist has top precedence) | agent.ts:220–229 |
| `balance_denies` | Not blocked ∧ amount > balance ⇒ DENY / `AUTO_DENY_BALANCE` (no budget hypothesis needed: balance precedes budget) | agent.ts:231–241 |
| `budget_denies` | Not blocked ∧ amount ≤ balance ∧ hourlySpend + amount > hourlyBudget ⇒ DENY / `AUTO_DENY_BUDGET` | agent.ts:242–254 |
| `approve_iff` | Policy stage approves (for exactly the requested amount) **iff** policy = AUTO_APPROVE_UNDER ∧ amount ≤ maxPerPayment ∧ trust ≥ 70 ∧ amount ≤ balance ∧ hourlySpend + amount ≤ hourlyBudget | agent.ts:256–269, against the negative space of 220–254 |
| `policy_stage_binary` | The policy stage can only APPROVE or DENY — DEFER/COUNTER are LLM-stage-only verdicts | agent.ts:214–272 with verdict type at 31 |
| `policy_deny_zero` | Every policy-stage DENY carries `approvedAmountMotes = 0` | `approvedAmountMotes: 0n` in each deny return, agent.ts:220–254 |
| `policy_decision_final` | If the policy stage decides, `evaluate` returns that decision verbatim, for every LLM oracle | agent.ts:195–203 |
| `blocked_never_approved` | End-to-end: blocklisted service ⇒ final verdict DENY, source `AUTO_DENY_BLOCKED`, LLM never consulted | agent.ts:195–203 + 220–229 |
| `over_balance_never_approved` | End-to-end: amount > balance ⇒ final verdict DENY for every LLM behaviour | agent.ts:195–203 + 231–241 |
| `over_budget_never_approved` | End-to-end: hourlySpend + amount > hourlyBudget ⇒ final verdict DENY for every LLM behaviour | agent.ts:195–203 + 242–254 |
| `llm_only_after_checks` | The LLM is only ever shown requests that passed blocklist, balance, and hourly-budget checks (`applyPolicy = none` implies all three) | agent.ts:271 + 195–203 |
| `auto_approve_at_trust_boundary` | Trust exactly 70 auto-approves — threshold is inclusive (`>= 70`) | agent.ts:260 |
| `auto_approve_at_amount_boundary` | Amount exactly at the per-payment cap auto-approves — cap is inclusive (`<=`) | agent.ts:260 |

## Discrepancies and risks found in the code

1. **README says "under threshold"; the code approves *at* the
   threshold.** README: "auto-approve for trusted services under
   threshold". `agent.ts:260` uses `amountRequired <= maxPerPayment`
   and `serviceTrustScore >= 70` — both boundaries inclusive (proved as
   the two boundary corollaries). A payment of exactly the cap, to a
   service scored exactly 70, is auto-approved with no human/LLM look.

2. **The daily budget is never enforced by the deterministic layer.**
   `getContext` fetches daily spend and a daily budget
   (agent.ts:138–145, and `dailyBudgetCspr` at 162, defaulted to
   hourly × 24), and both are shown to the LLM in the prompt
   (agent.ts:408, 413) — but `applyPolicy` checks only the *hourly*
   budget. The README's pipeline description and the LLM system
   prompt's "budget discipline — respect hourly and daily spend
   windows" are, for the deterministic stage, hourly-only. A caller
   that keeps each hour under the hourly cap can spend 24× that cap in
   a day without any policy-stage objection.

3. **Spend windows are read but never written — the budget check is
   effectively per-request.** `db.treasurySpend` is only ever *read*
   (agent.ts:133, 138); nothing in `src/`, `scripts/`, or `tests/`
   creates or updates `TreasurySpend` rows (model defined at
   `prisma/schema.prisma:62`). Unless an external writer exists
   outside this repo, `hourlySpendMotes` is permanently 0 and the
   hourly budget check (agent.ts:245) degenerates to "single request ≤
   full hourly budget" — repeated requests never accumulate. Related:
   the context is a snapshot taken at `evaluate` time (agent.ts:188)
   with no reservation or locking, so two concurrent `evaluate` calls
   can both pass the balance/budget checks against the same snapshot
   and together exceed them (check-to-execution race).

4. **Once the policy stage is silent, the approved amount is
   unbounded.** `parseLLMResponse` takes `approved_amount_motes`
   verbatim (agent.ts:472–474) — it is never clamped to the requested
   amount, the balance, or any budget — and `counter_amount_motes`
   likewise (agent.ts:475). `executePayment` (agent.ts:529) checks
   only `verdict === 'APPROVE'` (agent.ts:537) and transfers
   `decision.approvedAmountMotes` without re-running policy or
   re-checking the balance. So the proved end-to-end guarantees are
   verdict-level and pre-LLM only: blocked / over-balance /
   over-hourly-budget requests never reach the LLM, but a request the
   policy passes to the LLM can come back approved for *more than was
   requested* and be executed as-is. The LLM is prompted with budget
   context, but nothing deterministic enforces it on that path.

5. **Parse paths can throw instead of DEFERring, skipping the audit
   log.** The DEFER-on-failure behaviour is real for LLM call errors
   and unparseable text (agent.ts:337–346, 447–455, 457–467), but
   `BigInt(parsed.approved_amount_motes)` (agent.ts:473) throws on a
   non-integer string (e.g. `"10.5"`, `"1e9"`), and `parseLLMResponse`
   is invoked at agent.ts:348 *outside* the try/catch that guards the
   LLM call. The exception propagates out of `evaluate`, and because
   `persistDecision` runs only after `callLLM` returns
   (agent.ts:203–204), that decision is never written to the audit
   log. Same pattern at the front door: `BigInt(req.challenge.
   requirements.amount || '0')` (agent.ts:192) throws on a
   non-integer amount string (e.g. a CSPR-denominated `"0.05"`) before
   any policy check runs.

6. **No positivity check on the amount.** A negative challenge amount
   parses fine as a `bigint`, passes the balance check
   (`amount > balance` is false) and the budget check, and — for an
   `AUTO_APPROVE_UNDER` service with trust ≥ 70 — is auto-approved
   with a negative `approvedAmountMotes`. Nothing in the pipeline
   requires `amount > 0`; the failure only surfaces downstream when
   the negative value reaches the U512 bincode encoder at execution.
   (The Lean model uses `Int` and its theorems remain true, but they
   deliberately mirror the code in not assuming positivity.)

7. **Balance check allows draining the treasury to exactly zero.**
   Only `amount > balance` denies (agent.ts:231); `amount == balance`
   passes. There is no reserve floor in the deterministic layer,
   despite the LLM system prompt's rule 1 ("never approve a payment
   that would drain the treasury below a safe reserve") — that rule is
   advisory to the LLM only. (Transfers currently set
   `gasPaymentMotes: 0n`, so no fee is hidden from the check today;
   the check as written would not account for one if that changed.)

8. **Thresholds pass through float64 before becoming motes.**
   Budgets and the per-payment cap are CSPR floats — `parseFloat` env
   defaults of 10 / 50 CSPR (`src/lib/env.ts:40–41`) or per-agent DB
   numbers — converted by `csprToMotes = BigInt(Math.round(cspr *
   1e9))` (`src/lib/utils/units.ts:9–11`). All comparisons inside
   `applyPolicy` are exact bigint, but the converted threshold can
   differ from the configured value: `Math.round` absorbs sub-mote
   error at typical magnitudes, while above 2^53 motes
   (≈ 9.007×10^15 motes ≈ 9,007,199 CSPR) float64 cannot represent
   every mote and the enforced cap drifts from the configured one.
   The Lean model takes the converted thresholds as given, so this
   sits outside the proved envelope.

9. **"Block list" is an exact, case-sensitive string in the service
   registry — and unregistered services bypass it entirely.** The
   check is `servicePolicy === 'BLOCKED'` (agent.ts:220) against the
   DB-stored policy string. `getContext` defaults an unknown service
   to policy `'LLM_REVIEW'` and trust score 50 (agent.ts:156–157), and
   any other string — including `'ALWAYS_REVIEW'` (documented in
   `prisma/schema.prisma:83–84`) or a lowercase `'blocked'` typo —
   falls through to LLM review identically. The blocklist only bites
   for services explicitly registered with the exact string `BLOCKED`.

10. **Window boundaries are wall-clock-aligned.** `getContext`
    floors the current time to the hour/day (agent.ts:131–132), so
    the "hourly" window is the clock hour, not a rolling 60 minutes:
    spend at 10:59 and 11:01 lands in different windows. Combined with
    finding 3, window discipline depends entirely on machinery that
    isn't in this repo.

11. **Audit-source precedence is observable but safety-neutral.**
    Because blocklist is checked before balance and balance before
    budget, a blocked service that would also fail the budget reports
    `AUTO_DENY_BLOCKED`. The proofs pin this order (`balance_denies`
    needs no budget hypothesis, `budget_denies` needs the balance
    hypothesis) — worth knowing when reading `decisionSource` in the
    audit log, harmless for safety since all three rungs deny.

12. **The policy engine has no unit tests.** `tests/core.test.ts`
    (36 tests) covers account hashes, bincode, deploy construction,
    x402 parsing, and unit conversion — nothing exercises
    `TreasuryAgent` or `applyPolicy`. The demo script
    (`scripts/demo-treasury.ts`) is the only executable check of the
    decision pipeline.
