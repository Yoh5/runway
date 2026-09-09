# Runway

**A keeper that decides who keeps getting paid when a Superfluid treasury runs short — and executes that decision through KeeperHub under a mandate it cannot exceed.**

A treasury pays people with Superfluid streams. Money leaves the account every second, and
Superfluid announces nothing while it drains: no event, no log to index, no threshold
crossing. When the available balance hits zero, anyone may liquidate the sender and take
the locked buffer. Every stream from that treasury collapses in the same block. Payroll
stops for everyone at once, with no warning.

The real problem is not "top up" — often there is nothing to top up with. It is:

> **When there is not enough for everyone, who keeps being paid at the full rate?**

That has a deterministic answer once someone writes the policy down. Getting to it means
reading chain state, ranking recipients, computing rates that fit a budget, and posting N
exact on-chain calls. Runway does the first three. KeeperHub does the fourth.

## The agent holds a mandate, not the keys

Runway never holds the treasury's private key and cannot be given it. It operates through
Superfluid's own access-control list, which the treasury grants in one transaction and
revokes in one transaction:

```
updateFlowOperatorPermissions(token, flowOperator, permissions = 6, flowRateAllowance)
```

Everything the agent may do is in that one call, and it is enforced by the CFA contract,
not by Runway's own code:

| Bound | How it is enforced |
| --- | --- |
| **Update and delete only, never create** (`permissions = 6`, deliberately not `7`) | The CFA reverts a `createFlow` from this operator. The agent can throttle or close a stream; it can never open one to an address of its own choosing. |
| **A total flow-rate allowance** | Set to the sum of the committed rates. The agent can restore what was agreed and cannot exceed it. |
| **One token, one operator address** | The grant names both. It confers nothing on any other token or any other key. |
| **Revocable at any time, without Runway's cooperation** | The treasury calls the same function with `permissions = 0`. |

Inside those bounds the policy narrows things further, in a YAML document the treasury
owns: a tier per recipient (`critical`, `standard`, `discretionary`), a **floor** below
which each stream is never taken, and the runway thresholds that decide when to act. When
the floors together still exceed the budget, Runway does not choose for you — it stops at
the floors and escalates the remainder to a human.

## What one tick does

1. **Read** — balance, deposit, and every stream's live rate off the chain. If any read
   fails, the tick fails; it never decides on partial facts.
2. **Decide** — a pure function of those facts and the policy. `hold`, `reduce` (shed
   discretionary first, then standard, then critical, each stopping at its floor), or
   `restore` once the runway has recovered past a hysteresis band.
3. **Execute** — one `superfluid/update-flow` per adjusted stream through KeeperHub's
   direct-execution API, every parameter literal, each carrying an idempotency key derived
   from the work rather than the attempt.
4. **Verify** — read every adjusted stream back off the chain. A mined receipt proves a
   transaction landed; only a read proves the stream changed rate.
5. **Escalate** — on incomplete reads, a rejected mandate, an unknown write outcome, or a
   budget the floors cannot meet. Silence is never the answer to a case the policy does not
   cover.

The run is recorded as JSON and rendered to a self-contained HTML report (no scripts, no
remote resources, everything escaped).

## It has actually run

One live demonstration on Ethereum Sepolia, 2026-09-08. The treasury was unwrapped down
until the runway fell from 214 hours to 23, crossing the breach threshold. Runway shed all
three streams to their floors in three transactions:

| Stream | Rate before | Rate after | Transaction |
| --- | --- | --- | --- |
| Discretionary | 57860765330 | 11572153066 | [`0xc58483cd…a0200d5a`](https://sepolia.etherscan.io/tx/0xc58483cd49462cb70e92859ce3518d10d2e6a2a7e39aaddf6f9c04af0a200d5a) |
| Standard | 86791147994 | 21697786998 | [`0x39c9773b…661e9f99`](https://sepolia.etherscan.io/tx/0x39c9773b806775cf2a6597258b10463117eec1a03fcb854817fbe3d4661e9f99) |
| Critical | 144651913324 | 86791147994 | [`0xfe79cb4a…bd99da66`](https://sepolia.etherscan.io/tx/0xfe79cb4a00f8a98030e89e4183d598876f2413934aab495115a056cabd99da66) |

All three landed, all three rates were read back off the chain at their floors, and the
`floors-exceed-budget` escalation was raised for the 79664745201 wei/sec the floors could
not close. Wei per second, so the numbers are exact rather than rounded.

The figures live in **[docs/EVIDENCE.md](docs/EVIDENCE.md)**, and they are not typed by
hand: `pnpm test:evidence` parses every hash, link, block number and rate back out of the
captured run record and fails if the document disagrees. That gate shipped red — the
document carried a sentinel no real value could equal — so no number could be written into
it before a real run produced one.

## Design decisions worth knowing about

- **Reads fail closed.** A partial read raises `ReadIncompleteError` listing every failure.
  A treasury keeper that guesses when the chain is unreachable is worse than one that stops.
- **A floor of zero is a trap, and the policy says so.** A rate-zero stream does not exist
  on Superfluid, so reopening it needs `createFlow` — which this mandate deliberately
  withholds. Any stream that must stay restorable needs a non-zero floor. Runway can never
  reopen what it closed, and the policy comments say that at the exact line where someone
  would otherwise write `"0"`.
- **KeeperHub serves two response contracts, and which one you get is conditional.** The
  original body carries `success: true` with a receipt already re-verified; the newer one
  carries `executionId` and `status: "completed" | "failed" | "unconfirmed"` and no
  `success` field at all. The executor recognises both, records which one answered, and
  treats `unconfirmed` as poll-only rather than as a refusal — a hash on a failing body
  still means a transaction reached the chain. The live run came back on the newer
  contract, so a keeper reading only `success` would have reported three failures on three
  writes that had landed.
- **An absent field is not a `false` and not a zero.** A missing `sponsored` reads as "not
  stated"; missing gas figures read as "not reported", never as "this write cost nothing".
- **No number in the documentation is trusted unless a test reads it off its source.**

## Running it

Requires Node 22+, pnpm 10, an RPC endpoint, a KeeperHub organisation API key with
`mcp:write`, and a treasury that has granted the mandate above.
[docs/SETUP.md](docs/SETUP.md) is the full runbook, including every signature the treasury
must produce and how to verify each one landed.

```bash
pnpm install
cp .env.example .env    # then fill it in; nothing is read from anywhere else

pnpm check-config       # env presence and policy sanity, prints no secret values
pnpm resolve            # resolves token, host and deposit off chain
pnpm verify-rates       # live rate vs committed rate vs floor, per stream

pnpm tick policies/treasury.sepolia.yaml --dry-run   # decide, execute nothing
pnpm tick policies/treasury.sepolia.yaml             # decide and write
```

`--dry-run` reads the chain and prints the decision it would act on. It posts nothing.

### On a schedule

A keeper that only runs when someone types a command is a calculator. `pnpm serve` starts
an HTTP trigger with two routes -- `GET /health` and `POST /tick`, the latter behind a
shared-secret header -- so a KeeperHub scheduled workflow can drive the tick with nobody
at the keyboard: a Schedule trigger, an HTTP Request node, and the keeper does the rest.

It refuses before it acts: an unknown path, an unknown method, a missing or wrong token
and a tick already in flight are each rejected before the runner is reachable, and the
policy comes from the environment rather than from the request, so holding the token does
not let anyone point the keeper at a different treasury. Every response states its outcome
in the body as well as the status code, because KeeperHub's HTTP Request step returns the
parsed body and never looks at the status -- so a failed tick is only visible to the
workflow that triggered it if the failure is written inside the body.

[docs/SCHEDULING.md](docs/SCHEDULING.md) has the setup, the workflow configuration and
what to expect from a hosted instance.

```bash
pnpm test           # 197 tests, including the invariant properties
pnpm test:evidence  # the documentation gate, run separately on purpose
pnpm typecheck && pnpm check
```

The evidence gate is excluded from `pnpm test` deliberately: a red test living inside the
main suite teaches people to ignore red.

## What this is not

- Not a liquidation bot. It acts before liquidation is possible, on the treasury's behalf,
  never against a third party.
- Not a yield product. It moves no funds into or out of any position.
- Not a Superfluid dashboard. It answers one question and executes one class of response.
- Not a replacement for a treasurer. When the policy cannot be satisfied, it escalates
  instead of choosing quietly.

## Layout

`src/policy` is the decision engine and is pure — no I/O, no clock, no network, which is
why the invariants can be property-tested. `src/chain` reads. `src/keeperhub` writes.
`src/runner` sequences a tick and raises escalations. `src/report` renders. `scripts/` holds
the operational tools: configuration checks, stream planning, rate verification, evidence
capture. The design document behind all of it is
[docs/superpowers/specs/2026-09-06-runway-design.md](docs/superpowers/specs/2026-09-06-runway-design.md),
and it is the authority: where the code and the spec disagreed during the build, one of the
two was amended on purpose and the reason recorded.

## How this was built

Spec first, then a task-by-task plan, then test-driven implementation with a review pass
per task and a whole-branch review at the end. The design document, the plan and the
progress ledger are all in the repository, including the rulings where reality contradicted
the plan — a decision engine that returned `hold` on zero outflow and so could never
restore, two fixtures that were arithmetically unsatisfiable, a property test measured at
0.1% assertion reach, and a `main()` at module scope that would have broadcast real
transactions on import.

Development was AI-assisted, with Claude Code. Every on-chain action was decided and signed
by a human: the six setup signatures in [docs/SETUP.md](docs/SETUP.md), the mandate grant,
and the funding. The agent's authority on chain is exactly the `permissions = 6` grant
described at the top of this file and nothing else — which is, in the end, the same claim
this project makes about any keeper.

Two of the bugs fixed here were found by a KeeperHub maintainer reviewing our documentation
of *their* API, not our code: an executor that turned a missing `sponsored` field into a
positive claim that a write was unsponsored, and one that classified `success: false` as a
refusal when it can accompany a transaction that is on chain. Both are in
[docs/EVIDENCE.md](docs/EVIDENCE.md), stated rather than quietly corrected.
