/-!
# AgentPay v2 — Treasury Agent policy engine: Lean 4 model + proofs

Self-contained (core library only, Lean 4.34.1). Compile with:

    ~/.elan/bin/lean Policy.lean

## What is modelled

The deterministic policy stage of `TreasuryAgent` in
`src/lib/treasury/agent.ts`:

* `applyPolicy`  — `agent.ts` lines 214–272. A first-match-wins chain:
  1. service policy `BLOCKED`            → `DENY`  (`AUTO_DENY_BLOCKED`)
  2. `amount > balance`                  → `DENY`  (`AUTO_DENY_BALANCE`)
  3. `hourlySpend + amount > hourlyBudget` → `DENY` (`AUTO_DENY_BUDGET`)
  4. policy `AUTO_APPROVE_UNDER` ∧ `amount ≤ maxPerPayment` ∧ `trust ≥ 70`
                                         → `APPROVE` (`AUTO_APPROVE_POLICY`)
  5. otherwise `null` (fall through to LLM review)

* `evaluate`     — `agent.ts` lines 188–206. If `applyPolicy` returns a
  decision it is final (persisted and returned); the LLM is consulted
  only on `null`. The LLM stage (GLM-4.6, nondeterministic) is modelled
  as an *arbitrary* oracle function `llm : Ctx → Int → Decision`, so the
  end-to-end theorems below hold for **every** possible LLM behaviour —
  including a malicious or confused one. That is exactly the protection
  the short-circuit in `evaluate` buys: the guardrails the policy stage
  enforces can never be overridden downstream.

## Abstractions (see NOTES.md for the concrete consequences)

* Money is `Int` (motes), mirroring the TypeScript `bigint` arithmetic,
  which is exact. The CSPR→motes conversion of the *thresholds*
  (`csprToMotes`, `src/lib/utils/units.ts`) goes through float64 in the
  code; here the thresholds are taken as already-converted `Int` fields
  of `Ctx`, i.e. the model verifies the pipeline given the thresholds it
  is actually handed.
* `servicePolicy` is a string in the code, compared by exact equality
  against `'BLOCKED'` and `'AUTO_APPROVE_UNDER'`. Every other string
  (`'LLM_REVIEW'`, `'ALWAYS_REVIEW'`, typos, …) behaves identically —
  fall-through — so it is modelled by the single case `other`.
* The trust score is a JS `number` in the code; it is modelled as `Int`.
  The only comparison the code performs is `trust ≥ 70`, whose meaning
  is unchanged for integer scores.
* Audit persistence (`persistDecision`) and the PRISM/Langfuse tracing
  wrappers have no decision content and are not modelled.
-/

namespace AgentPay

/-- The service policy (`X402Service.policy` in the DB), quotiented by
behaviour: only the exact strings `'BLOCKED'` and `'AUTO_APPROVE_UNDER'`
are distinguished by `applyPolicy`; everything else falls through. -/
inductive ServicePolicy where
  | blocked
  | autoApproveUnder
  | other
  deriving DecidableEq, Repr

/-- `DecisionVerdict` (`agent.ts` line 31). -/
inductive Verdict where
  | approve
  | deny
  | defer
  | counter
  deriving DecidableEq, Repr

/-- `DecisionSource` (`agent.ts` lines 33–41). -/
inductive Source where
  | autoApprovePolicy
  | autoDenyBlocked
  | autoDenyBalance
  | autoDenyBudget
  | llmReview
  | llmParseError
  deriving DecidableEq, Repr

/-- A `TreasuryDecision`, reduced to its decision-relevant fields
(verdict, source, approved amount in motes). -/
structure Decision where
  verdict : Verdict
  source : Source
  approved : Int
  deriving DecidableEq, Repr

/-- The slice of `TreasuryContext` + budget configuration that
`applyPolicy` reads (all amounts in motes). `hourlyBudget` and
`maxPerPayment` are the *converted* thresholds: in the code they are
computed inside `applyPolicy` from the per-agent budget override or the
env defaults (`agent.ts` lines 243–245 and 258–260). -/
structure Ctx where
  policy : ServicePolicy
  balance : Int
  hourlySpend : Int
  hourlyBudget : Int
  maxPerPayment : Int
  trust : Int

/-- `agent.ts` lines 220–229. -/
abbrev autoDenyBlocked : Decision := ⟨.deny, .autoDenyBlocked, 0⟩

/-- `agent.ts` lines 231–241. -/
abbrev autoDenyBalance : Decision := ⟨.deny, .autoDenyBalance, 0⟩

/-- `agent.ts` lines 245–254. -/
abbrev autoDenyBudget : Decision := ⟨.deny, .autoDenyBudget, 0⟩

/-- `applyPolicy` (`agent.ts` lines 214–272), transcribed rung by rung.
`none` is the TypeScript `null`: fall through to LLM review. -/
def applyPolicy (ctx : Ctx) (amount : Int) : Option Decision :=
  if ctx.policy = .blocked then
    some autoDenyBlocked
  else if amount > ctx.balance then
    some autoDenyBalance
  else if ctx.hourlySpend + amount > ctx.hourlyBudget then
    some autoDenyBudget
  else if ctx.policy = .autoApproveUnder ∧ amount ≤ ctx.maxPerPayment ∧ 70 ≤ ctx.trust then
    some ⟨.approve, .autoApprovePolicy, amount⟩
  else
    none

/-- `evaluate` (`agent.ts` lines 188–206): a policy decision short-
circuits; the LLM oracle is consulted only when the policy is silent. -/
def evaluate (llm : Ctx → Int → Decision) (ctx : Ctx) (amount : Int) : Decision :=
  match applyPolicy ctx amount with
  | some d => d
  | none => llm ctx amount

/-! ## The rungs of the chain -/

/-- Rung 1: a blocklisted service is denied by the policy stage, with
the blocked source, approving 0 — regardless of balance, budget, trust,
or amount. (This also pins precedence: blocklist beats balance/budget,
which are never even consulted.) -/
theorem blocked_denies (ctx : Ctx) (amount : Int) (h : ctx.policy = .blocked) :
    applyPolicy ctx amount = some autoDenyBlocked := by
  unfold applyPolicy
  rw [ite_eq_left h]

/-- Rung 2: an over-balance request is denied by the policy stage.
Needs no budget hypothesis: balance precedes budget in the chain. -/
theorem balance_denies (ctx : Ctx) (amount : Int)
    (hpol : ctx.policy ≠ .blocked) (hbal : amount > ctx.balance) :
    applyPolicy ctx amount = some autoDenyBalance := by
  unfold applyPolicy
  rw [ite_eq_right hpol, ite_eq_left hbal]

/-- Rung 3: a request that would exceed the hourly budget is denied by
the policy stage. The `amount ≤ balance` hypothesis is precisely the
statement that rung 2 did not fire — the chain order made formal. -/
theorem budget_denies (ctx : Ctx) (amount : Int)
    (hpol : ctx.policy ≠ .blocked) (hbal : amount ≤ ctx.balance)
    (hbud : ctx.hourlySpend + amount > ctx.hourlyBudget) :
    applyPolicy ctx amount = some autoDenyBudget := by
  unfold applyPolicy
  rw [ite_eq_right hpol, ite_eq_right (by omega : ¬ amount > ctx.balance), ite_eq_left hbud]

/-- Rung 4, characterised exactly: the policy stage approves **iff**
the service is auto-approve-enabled, the amount is at most the
per-payment cap, the trust score is at least 70, *and* the earlier
rungs passed (amount within balance, hourly spend + amount within
budget). The approved amount is exactly the requested amount. Both
thresholds are inclusive, matching the code (`≤`, `≥`). -/
theorem approve_iff (ctx : Ctx) (amount : Int) :
    applyPolicy ctx amount = some ⟨.approve, .autoApprovePolicy, amount⟩ ↔
    ctx.policy = .autoApproveUnder ∧ amount ≤ ctx.maxPerPayment ∧ 70 ≤ ctx.trust ∧
    amount ≤ ctx.balance ∧ ctx.hourlySpend + amount ≤ ctx.hourlyBudget := by
  constructor
  · intro h
    unfold applyPolicy at h
    by_cases h1 : ctx.policy = .blocked
    · rw [ite_eq_left h1] at h
      simp [autoDenyBlocked] at h
    · rw [ite_eq_right h1] at h
      by_cases h2 : amount > ctx.balance
      · rw [ite_eq_left h2] at h
        simp [autoDenyBalance] at h
      · rw [ite_eq_right h2] at h
        by_cases h3 : ctx.hourlySpend + amount > ctx.hourlyBudget
        · rw [ite_eq_left h3] at h
          simp [autoDenyBudget] at h
        · rw [ite_eq_right h3] at h
          by_cases h4 : ctx.policy = .autoApproveUnder ∧ amount ≤ ctx.maxPerPayment ∧ 70 ≤ ctx.trust
          · rw [ite_eq_left h4] at h
            obtain ⟨hp, hamt, htr⟩ := h4
            exact ⟨hp, hamt, htr, by omega, by omega⟩
          · rw [ite_eq_right h4] at h
            simp at h
  · rintro ⟨hp, hamt, htr, hbal, hbud⟩
    unfold applyPolicy
    rw [ite_eq_right (by simp [hp]), ite_eq_right (by omega), ite_eq_right (by omega),
      ite_eq_left ⟨hp, hamt, htr⟩]

/-- The policy stage is binary: it can only ever approve or deny —
`DEFER` and `COUNTER` exist solely in the LLM stage's vocabulary. -/
theorem policy_stage_binary (ctx : Ctx) (amount : Int) (d : Decision)
    (h : applyPolicy ctx amount = some d) :
    d.verdict = .approve ∨ d.verdict = .deny := by
  unfold applyPolicy at h
  by_cases h1 : ctx.policy = .blocked
  · rw [ite_eq_left h1] at h
    rw [← Option.some.inj h]
    exact Or.inr rfl
  · rw [ite_eq_right h1] at h
    by_cases h2 : amount > ctx.balance
    · rw [ite_eq_left h2] at h
      rw [← Option.some.inj h]
      exact Or.inr rfl
    · rw [ite_eq_right h2] at h
      by_cases h3 : ctx.hourlySpend + amount > ctx.hourlyBudget
      · rw [ite_eq_left h3] at h
        rw [← Option.some.inj h]
        exact Or.inr rfl
      · rw [ite_eq_right h3] at h
        by_cases h4 : ctx.policy = .autoApproveUnder ∧ amount ≤ ctx.maxPerPayment ∧ 70 ≤ ctx.trust
        · rw [ite_eq_left h4] at h
          rw [← Option.some.inj h]
          exact Or.inl rfl
        · rw [ite_eq_right h4] at h
          simp at h

/-- Every policy-stage denial approves exactly 0 motes: a denied
request can never carry a payable amount into `executePayment`. -/
theorem policy_deny_zero (ctx : Ctx) (amount : Int) (d : Decision)
    (h : applyPolicy ctx amount = some d) (hv : d.verdict = .deny) :
    d.approved = 0 := by
  unfold applyPolicy at h
  by_cases h1 : ctx.policy = .blocked
  · rw [ite_eq_left h1] at h
    rw [← Option.some.inj h]
  · rw [ite_eq_right h1] at h
    by_cases h2 : amount > ctx.balance
    · rw [ite_eq_left h2] at h
      rw [← Option.some.inj h]
    · rw [ite_eq_right h2] at h
      by_cases h3 : ctx.hourlySpend + amount > ctx.hourlyBudget
      · rw [ite_eq_left h3] at h
        rw [← Option.some.inj h]
      · rw [ite_eq_right h3] at h
        by_cases h4 : ctx.policy = .autoApproveUnder ∧ amount ≤ ctx.maxPerPayment ∧ 70 ≤ ctx.trust
        · rw [ite_eq_left h4] at h
          rw [← Option.some.inj h] at hv
          simp at hv
        · rw [ite_eq_right h4] at h
          simp at h

/-! ## Composition: the policy stage bounds the whole pipeline -/

/-- Finality: when the policy stage decides, `evaluate` returns that
decision verbatim, for **every** LLM oracle. No downstream stage can
override, soften, or re-open a policy decision. -/
theorem policy_decision_final (llm : Ctx → Int → Decision) (ctx : Ctx) (amount : Int)
    (d : Decision) (h : applyPolicy ctx amount = some d) :
    evaluate llm ctx amount = d := by
  simp [evaluate, h]

/-- End-to-end: a blocklisted service is never approved — the final
verdict is `DENY` with source `AUTO_DENY_BLOCKED`, no matter what the
LLM would have said (it is never asked). -/
theorem blocked_never_approved (llm : Ctx → Int → Decision) (ctx : Ctx) (amount : Int)
    (h : ctx.policy = .blocked) :
    (evaluate llm ctx amount).verdict = .deny ∧
    (evaluate llm ctx amount).source = .autoDenyBlocked := by
  rw [policy_decision_final llm ctx amount _ (blocked_denies ctx amount h)]
  exact ⟨rfl, rfl⟩

/-- End-to-end: an over-balance request is never approved; the final
verdict is `DENY` for every LLM oracle. -/
theorem over_balance_never_approved (llm : Ctx → Int → Decision) (ctx : Ctx) (amount : Int)
    (h : amount > ctx.balance) :
    (evaluate llm ctx amount).verdict = .deny := by
  by_cases hb : ctx.policy = .blocked
  · rw [policy_decision_final llm ctx amount _ (blocked_denies ctx amount hb)]
  · rw [policy_decision_final llm ctx amount _ (balance_denies ctx amount hb h)]

/-- End-to-end: a request that would exceed the hourly budget is never
approved; the final verdict is `DENY` for every LLM oracle. -/
theorem over_budget_never_approved (llm : Ctx → Int → Decision) (ctx : Ctx) (amount : Int)
    (h : ctx.hourlySpend + amount > ctx.hourlyBudget) :
    (evaluate llm ctx amount).verdict = .deny := by
  by_cases hb : ctx.policy = .blocked
  · rw [policy_decision_final llm ctx amount _ (blocked_denies ctx amount hb)]
  · by_cases hbal : amount > ctx.balance
    · rw [policy_decision_final llm ctx amount _ (balance_denies ctx amount hb hbal)]
    · rw [policy_decision_final llm ctx amount _
        (budget_denies ctx amount hb (by omega) h)]

/-- The LLM's input space is guarded: the oracle is consulted only for
requests that already passed the blocklist, the balance check, and the
hourly budget check. Whatever the LLM stage is trusted to do, it is
never even *shown* a request those guardrails reject. -/
theorem llm_only_after_checks (ctx : Ctx) (amount : Int)
    (h : applyPolicy ctx amount = none) :
    ctx.policy ≠ .blocked ∧ amount ≤ ctx.balance ∧
    ctx.hourlySpend + amount ≤ ctx.hourlyBudget := by
  unfold applyPolicy at h
  by_cases h1 : ctx.policy = .blocked
  · rw [ite_eq_left h1] at h
    simp at h
  · rw [ite_eq_right h1] at h
    by_cases h2 : amount > ctx.balance
    · rw [ite_eq_left h2] at h
      simp at h
    · rw [ite_eq_right h2] at h
      by_cases h3 : ctx.hourlySpend + amount > ctx.hourlyBudget
      · rw [ite_eq_left h3] at h
        simp at h
      · rw [ite_eq_right h3] at h
        exact ⟨h1, by omega, by omega⟩

/-! ## Boundary behaviour (both thresholds are inclusive in the code) -/

/-- Trust exactly 70 auto-approves (the code uses `>= 70`,
`agent.ts` line 260) — despite the README's "trusted services"
phrasing suggesting a vaguer bar, the boundary is sharp and inclusive. -/
theorem auto_approve_at_trust_boundary (ctx : Ctx) (amount : Int)
    (hp : ctx.policy = .autoApproveUnder) (ht : ctx.trust = 70)
    (hamt : amount ≤ ctx.maxPerPayment) (hbal : amount ≤ ctx.balance)
    (hbud : ctx.hourlySpend + amount ≤ ctx.hourlyBudget) :
    applyPolicy ctx amount = some ⟨.approve, .autoApprovePolicy, amount⟩ := by
  rw [approve_iff]
  exact ⟨hp, hamt, by omega, hbal, hbud⟩

/-- Amount exactly at the per-payment cap auto-approves (the code uses
`<=`, `agent.ts` line 260) — so "auto-approve *under* threshold" in the
README is really "at or under". -/
theorem auto_approve_at_amount_boundary (ctx : Ctx) (amount : Int)
    (hp : ctx.policy = .autoApproveUnder) (ht : 70 ≤ ctx.trust)
    (hamt : amount = ctx.maxPerPayment) (hbal : amount ≤ ctx.balance)
    (hbud : ctx.hourlySpend + amount ≤ ctx.hourlyBudget) :
    applyPolicy ctx amount = some ⟨.approve, .autoApprovePolicy, amount⟩ := by
  rw [approve_iff]
  exact ⟨hp, by omega, ht, hbal, hbud⟩

end AgentPay
