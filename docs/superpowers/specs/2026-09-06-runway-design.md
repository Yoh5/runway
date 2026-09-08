# Runway — design

Date: 2026-09-06
Status: approved, ready for implementation planning
Target: KeeperHub "The Agent Economy Hackathon", main track (Best Integration into a Live Project)

## 1. The problem

A treasury pays several people with Superfluid streams. Money leaves the account every
second. Superfluid emits no event while it drains: `realtimeBalanceOf` simply returns a
smaller number on every block. There is no log to index, no notification, no threshold
crossing that anything on chain announces.

When the available balance reaches zero, anyone may liquidate the sender's streams and
take the locked buffer deposit. Every stream from that sender collapses at the same
moment. Payroll stops for everyone, simultaneously, with no warning.

The treasury's real problem is not "top up" — often there is nothing to top up with. It
is: **when there is not enough for everyone, who keeps being paid at the full rate?**
That is a policy question with a deterministic answer once the policy is written, but
answering it requires reading chain state, ranking recipients, computing rates that fit
a budget, and posting N exact on-chain calls.

Runway splits that in two. The agent reads, computes and decides. KeeperHub executes,
with every parameter literal and nothing inferred at execution time, under an on-chain
mandate that is bounded and revocable.

**The agent holds a mandate, not the keys.**

## 2. What this is not

- Not a liquidation bot. Runway acts before liquidation is possible, on the sender's
  behalf, never against a third party.
- Not a yield or investment product. It moves no funds into or out of any position.
- Not a general Superfluid dashboard. It answers one question and executes one class of
  response.
- Not a replacement for a human treasurer. When the policy cannot be satisfied it
  escalates rather than choosing silently.

## 3. Verified ground

Everything below was read in the KeeperHub repository, not recalled.

| Fact | Where |
| --- | --- |
| Superfluid is deployed on Sepolia; both forwarders share one address across all 8 supported chains | `protocols/superfluid.ts:225-240` |
| `update-flow` takes `token, sender, receiver, flowRate` — `sender` is an explicit input, so an authorised operator can modify another account's stream | `protocols/superfluid.ts:498-509` |
| `grant-flow-operator` exposes `flowOperator`, a `permissions` bitmap and a `flowRateAllowance` | `protocols/superfluid.ts:556-570` |
| Permissions bitmap: `1 = create, 2 = update, 4 = delete` | `protocols/superfluid.ts:565` |
| `flowOperator == msg.sender` reverts with a CFA forwarder ACL custom error | `protocols/superfluid.ts:158-161` |
| The SuperToken contract is `userSpecifiedAddress: true` — any SuperToken address works, no address map to extend | `protocols/superfluid.ts:668-671` |
| Governance sets a per-token CFA minimum deposit; a `create-flow` at any rate locks it. This locked deposit is what a liquidator takes | `protocols/superfluid.ts:21-24` |
| A Superfluid Sepolia fixture existed before the suite was re-homed to a mainnet fork ("the sepolia sizing") | `protocols/superfluid.ts:22-25` |
| Sepolia moved to fork mode for CI cost reasons — repeated runs on ephemeral CI, not a functional failure | `lib/test-data/chain-test-data.ts:28-37` |
| Sepolia is a supported chain | `lib/rpc/rpc-config.ts:128` |
| Direct execution endpoint, API-key authenticated, with idempotency, spending caps, rate and concurrency limits | `app/api/execute/[...slug]/route.ts` |
| Action type format is `<protocol>/<action-slug>`, e.g. `superfluid/update-flow` | `plugins/protocol/steps/resolve-protocol-meta.ts:14-35` |
| A protocol write is **synchronous**: the route broadcasts, waits, and re-verifies the receipt against the chain before answering — a `202` here still means the write reached the broadcast path, never a queued job. **Two response contracts now exist, and which one a given call gets is conditional, not fixed.** The original: `success: true` with a `transactionHash` already carries a checked receipt, no `executionId`, nothing to poll. `origin/staging` has since replaced it: the body carries `executionId` always, `status: "completed" \| "failed" \| "unconfirmed"` instead of `success`, and `transactionHash` whenever a broadcast hash exists (including on a `"failed"` status — a hash there still means a transaction reached the chain, and `"unconfirmed"` is poll-only and must never be read as a refusal, straight from KeeperHub's own comment on the field). Whether the live deployment at `app.keeperhub.com` has caught up with `staging` was, at last check, unverified — checking costs a real transaction — so the executor recognises both shapes at runtime and records which one answered rather than assuming | `app/api/execute/[...slug]/route.ts` on `origin/staging`, `completeExecution` (KEEP-966); executor handling in `src/keeperhub/execute.ts` |
| KeeperHub's `simulate` flag is implemented only on `/transfer`, `/contract-call` and `/check-and-execute`. The protocol route ignores it, so sending it would broadcast for real. Simulation is therefore **local**, with viem, before any POST | `app/api/execute/_lib/simulate-flag.ts` and the absence of any `simulate` in the catch-all route |

### Resolved by reading the chain, never hardcoded from memory

- The fDAIx (or equivalent) SuperToken address on Sepolia, and its underlying ERC-20.
- The CFA minimum deposit for that token on Sepolia, read from governance at setup.
- Whether Sepolia is enabled for our organisation: `GET /api/chains`, expecting
  `isEnabled` and `isTestnet` both true for `11155111`.

Implementation reads each of these and asserts on the value. None is written into code
or into this document as a literal.

## 4. Architecture

Four units. Each has one purpose, a stated interface, and can be tested without the
others.

### `reader`

Given a chain, a SuperToken, a sender and the receiver set, returns raw facts:

```
Facts = {
  nowSec: number
  availableBalanceWei: bigint
  depositWei: bigint
  streams: { receiver: Address, flowRateWeiPerSec: bigint }[]
}
```

Reads go over plain RPC (viem), not through KeeperHub. Reads need no execution, no
signature and no spend; routing them through an execution API would cost quota and add
latency for nothing. KeeperHub is the execution layer, and the split is deliberate.

`realtimeBalanceOf(account, timestamp)` is the canonical read: it returns available
balance and deposit together, which `balanceOf` does not.

`availableBalanceWei` already excludes the locked deposit, so it is the correct
numerator for runway. `depositWei` is read anyway because it is the amount a liquidator
would take, and the escalation message is worth nothing if it cannot say what is at
stake. It is reported, never used in arithmetic.

Depends on: an RPC endpoint. Contains no policy.

### `policy`

A pure function. No network, no filesystem, no clock — `nowSec` arrives in `Facts`.

```
decide(facts: Facts, policy: Policy) -> Decision

Decision = {
  kind: "hold" | "reduce" | "restore"
  runwaySec: bigint | null        // null when net outflow is zero
  breach: boolean
  adjustments: { receiver, fromRateWeiPerSec, toRateWeiPerSec, reason }[]
  escalation: { kind, detail } | null
}

reason          = "budget-shed" | "restore-to-committed"
escalation.kind = "floors-exceed-budget" | "stream-closed-cannot-restore"
```

Both escalations the policy raises follow from the facts alone, which is why it can raise
them. `stream-closed-cannot-restore` names a stream an earlier shed took to zero: on
Superfluid a rate-zero stream does not exist, so raising it again is a `create`, and the
mandate deliberately withholds that permission. Runway reports the recipient it cannot
resume paying rather than emitting a call it knows will be refused. `read-incomplete`,
`mandate-rejected` and `write-outcome-unknown` are run-level escalations raised by the
runner and the executor respectively; a pure function has no way to know that an RPC
timed out, that a mandate was revoked, or that a write landed on chain despite a
failure response.

A decision has exactly one `kind`. It never reduces some streams and restores others in
the same tick: reducing and restoring answer opposite questions about the same balance,
and mixing them is how a keeper starts fighting itself. `hold` carries no adjustments.

This is where the judgment lives, and where the bulk of the tests go. Same facts plus
same policy always yields the same decision.

Depends on: nothing.

### `executor`

Takes adjustments and posts each one to
`POST /api/execute/superfluid/update-flow` with an idempotency key, and reads the
terminal response. There is no polling *of this call*: the route answers only once the
receipt has been re-verified against the chain. What the executor does with that answer is
now conditional on which response contract it got (§3): the original body carries no
`executionId` to poll with at all; the newer one always carries an `executionId`, which is
what makes a *separate*, later `GET /api/execute/{executionId}/status` call reachable —
useful to a human or reconciler after the fact, not something this call itself waits on. The
executor recognises both shapes without guessing between them and records which one
answered on the outcome, so a run record says what it was actually talking to.

Depends on: the KeeperHub API and a `kh_` key held in the environment. Contains no
policy — it cannot decide to skip, reorder or alter an adjustment.

### `runner`

Wires the three on a cadence and writes one run record per tick: the facts, the
decision, and the outcome of every attempted execution with its transaction hash.

## 5. The policy document

One document per (sender, token) pair. `committedRate` is stated, never inferred from
chain state: it is what the treasury agreed to pay, which is exactly the thing a
degraded on-chain rate no longer tells you.

```yaml
version: 1
chainId: 11155111
token: "<SuperToken address>"
sender: "<treasury address>"
minRunwayHours: 72          # below this, act
targetRunwayHours: 168      # restore to this
hysteresisHours: 24         # restore only above target + hysteresis
recipients:
  - address: "<address>"
    label: "Lead engineer"
    tier: critical
    committedRateWeiPerSec: "..."
    floorRateWeiPerSec: "..."
  - address: "<address>"
    label: "Design contractor"
    tier: standard
    committedRateWeiPerSec: "..."
    floorRateWeiPerSec: "..."
  - address: "<address>"
    label: "Community grants"
    tier: discretionary
    committedRateWeiPerSec: "..."
    # A floor of zero means this stream may be closed for good. The shed can take
    # it to zero, and Runway cannot reopen it: a rate-zero stream does not exist,
    # so restoring it would be a `create`, which the mandate withholds. Give a
    # non-zero floor to any stream that must stay restorable.
    floorRateWeiPerSec: "0"
escalation:
  webhook: "<url>"
```

Tier reduction order is fixed: `discretionary`, then `standard`, then `critical`.

## 6. The algorithm

Hours in the policy become seconds once, at load: `minRunwaySec`, `targetRunwaySec`,
`hysteresisSec`. The engine works in seconds and wei only, and never sees an hour.

```
netOutflow = sum(flowRateWeiPerSec over streams)
runwaySec  = netOutflow > 0 ? availableBalanceWei / netOutflow : null
budget     = availableBalanceWei / targetRunwaySec        // max sustainable wei/sec

if runwaySec is null or runwaySec >= minRunwaySec:
    consider restoration (below); otherwise no adjustments

else:
    breach = true
    need = netOutflow - budget                            // wei/sec to shed
    for tier in [discretionary, standard, critical]:
        for stream in tier, ordered by descending rate then by address:
            reducible = currentRate - floorRate
            take      = min(reducible, need)
            if take > 0: emit adjustment currentRate -> currentRate - take
            need -= take
            if need <= 0: stop
    if need > 0:
        escalate("floors exceed budget")   // adjustments are still applied
```

When even the sum of all floors exceeds the budget, Runway applies the reductions it
can **and** escalates. The reductions buy a human time to act; suppressing them would
cut nothing and still end in liquidation. Applying them silently would be worse. Both
happen, and the run record says so.

**Restoration.** When the runway computed at committed rates reaches
`targetRunwayHours + hysteresisHours`, rates are restored toward `committedRate` in
reverse tier order — critical first. The hysteresis band exists so a balance oscillating
around the threshold cannot produce a stream of alternating writes.

## 7. Invariants

The property tests assert these directly.

1. `toRate >= floorRate` for every adjustment.
2. `toRate <= committedRate` for every adjustment — Runway never pays more than agreed.
3. After a `reduce` decision, the **resulting total outflow** — every stream's rate after
   the adjustments are applied, not merely the adjusted ones — is at most `budget`, or an
   escalation is present. Summing only the adjustments would let an untouched stream
   blow the budget while every invariant still read as green.
4. A stream is reduced only when every stream in a lower tier is already at its floor.
5. Determinism: identical facts and policy yield an identical decision, ordering
   included.
6. Stability: when every stream's current rate already equals the rate this decision
   would set, `adjustments` is empty. A no-op run writes nothing on chain and costs no gas.
   The `kind` is `hold` when there was nothing to do, and `reduce` with an empty adjustment
   list when there was something to do and every stream was already at its floor — that
   second case says "I decided to cut and could not", which is more truthful than reporting
   a hold, and it always carries the `floors-exceed-budget` escalation.

## 8. Safety — the mandate

The treasury signs one `grant-flow-operator` transaction:

- `flowOperator` — the KeeperHub Turnkey EOA
- `permissions` — **6** (`update | delete`). Deliberately not 7: the agent can throttle
  and close, and can never open a stream to an address of its own choosing.
- `flowRateAllowance` — the total rate already committed, so the agent can restore what
  was agreed and cannot exceed it.

What follows is verifiable on chain by anyone: the agent cannot create a stream, cannot
raise total outflow above what the treasury already committed, and touches no other
token. The KeeperHub organisation spending cap is a second, independent belt.
Revocation is one transaction, and it does not depend on Runway being reachable or
cooperative.

## 9. Error handling — closed by default

- **RPC read fails or returns partial data.** No decision, no write. Log and retry on the
  next tick. Acting on partially-read state is the failure class fixed in KeeperHub issue
  #2325, and the same rule applies here: a loader that cannot see everything must not
  pretend it saw enough.
- **Partial batch.** Three adjustments of five land. The resulting on-chain state is
  still valid, because every adjustment only reduces or restores toward a stated
  committed rate, and each is independently safe. Record what landed; the next tick
  recomputes from facts and finishes.
- **Execution accepted but never completes.** The run is recorded unresolved. The
  idempotency key prevents a duplicate write when the next tick reaches the same
  conclusion. When the unresolved response carries a transaction hash, the run also
  raises a `write-outcome-unknown` escalation carrying that hash and the receiver: this
  is the only error state in which the treasury may already have paid and Runway cannot
  confirm it, so unlike an ordinary unknown (a socket error before anything was sent,
  which carries no hash and stays quiet) it is treated with the same urgency as a
  refusal, not silently deferred to the next tick's reconciliation.
- **Mandate revoked or allowance exhausted.** The write reverts. Escalate; do not retry
  in a loop.
- **Escalation itself fails.** Recorded as a run-level failure. A silent breach is the
  one outcome the design refuses.

## 10. Testing

- `policy` — table-driven unit tests plus property tests over invariants 1 to 6. Pure,
  so this can cover a large scenario space with no network.
- `reader` — recorded fixtures from real Sepolia reads, plus one live read asserted
  against the fixture shape.
- `executor` — a stub KeeperHub HTTP server covering: accepted then completed, accepted
  then failed, non-terminating, revert, and duplicate idempotency key.
- **One live run on Sepolia**, three streams, a tightening budget, producing the real
  transaction that the main track requires.

No count produced by a run is written into any document unless a test reads it back off
the source. This defect class has bitten this workspace before.

## 11. KeeperHub integration surface

- `POST /api/execute/superfluid/update-flow` — every write.
- Verification arrives in the write's own response, which KeeperHub answers only after
  re-checking the receipt on chain. Independent confirmation is a `getFlowInfo` read: a
  mined receipt proves a transaction landed, only a read proves the stream changed.
- `GET /api/chains` — confirm Sepolia is enabled for the org before the first run.
- A **scheduled KeeperHub workflow** that calls the runner, so the integration is visible
  inside their product and not only through their API.
- Escalation through a KeeperHub notification action rather than a private channel, so
  the whole loop is observable in one place.

## 12. Delivery

**Phase 1 — the submission.** The four units, the policy engine with its tests, the
scheduled workflow, a read-only page showing runway per stream and every executed
transaction with its hash, and one verified Sepolia transaction. This is what earns the
score; nothing in phase 2 starts until phase 1 is done and demonstrated.

**Phase 2 — the product surface.** A policy editor and a rich run history on top of the
same engine. Deliberately after phase 1: starting here produces a handsome dashboard
with nothing inside it.

Submission artefacts: a public repository, the verified transaction link, the DoraHacks
BUIDL, and a demo video. The bounty BUIDL for issue #2325 stays separate — a BUIDL can
be applied to one track only.

## 13. Stack

TypeScript on Node 22, viem for chain reads, Vitest, Biome, pnpm. This matches
KeeperHub's own toolchain, which keeps the code legible to the people judging it.

## 14. Known risks

- **Sepolia gas spikes.** KeeperHub measured 40 to 105 gwei on 2026-07-02 and moved
  their CI off live Sepolia because of it. One demo run is unaffected; a keeper on a
  tight cadence is not. The cadence lives in the scheduled KeeperHub workflow rather
  than in the policy document — it is an operational decision about how often to look,
  not a rule about what to do — and the run record carries the gas paid, so the cost of
  a given cadence is stated rather than discovered.
- **No seeded Superfluid test data on Sepolia.** Fixtures are built here rather than
  reused. Extra work, no blocker.
- **Superfluid is not on Base Sepolia**, so there is no near-zero-gas fallback chain.
