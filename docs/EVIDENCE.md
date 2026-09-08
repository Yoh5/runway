# Evidence: the verified Sepolia execution

This document records the one live demonstration run required by the main track: the
treasury's budget tightened until Runway's policy engine decided to shed, KeeperHub
broadcast the resulting `update-flow` writes, and each write was confirmed two ways --
once by the mined receipt, once by an independent chain read afterwards.

Every value below is asserted against `docs/evidence/run.json` by
`tests/docs/evidence.test.ts` (run with `pnpm test:evidence`, not part of the default
`pnpm test`). That file is not written by hand: `scripts/capture-evidence.ts` produces it
from the run record the live tick emitted, and the test parses every hash, link, block
number, rate and gas figure back out of it. A number typed into this document that the
captured run never produced turns the test red -- that is the whole point of the gate, and
it is why nothing here should be edited without re-running it.

To reproduce: run the live tick (`pnpm tick policies/treasury.sepolia.yaml`),
then `pnpm capture-evidence <path-to-the-run-record>` to produce
`docs/evidence/run.json` and `docs/evidence/report.html`, then `pnpm test:evidence`.

## The run

| Field | Value |
| --- | --- |
| Chain | Ethereum Sepolia |
| Started at | `2026-09-08T22:39:55.519Z` |
| Decision | `reduce` |
| Runway at decision time | `84450` seconds (~23.5 hours) |
| Breach | `true` |
| Escalation raised | `floors-exceed-budget` -- `79664745201 wei/sec above budget after every floor was reached` |
| Streams adjusted | 3 (one write each) |

The escalation is not a failure. It is the honest half of the decision: after every stream
had been shed to its floor, the treasury was still paying out 79664745201 wei/sec more than
its budget allows. The keeper's mandate stops at the floors, so it says so and hands the
remainder to a human rather than breaching a floor it was never authorised to breach. The
run record shows `"delivered": false` for it, because the webhook URL in this run's policy
points at `example.invalid` -- an undeliverable escalation is recorded as undelivered, not
quietly dropped.

## The transactions

Three writes, one per adjusted stream, in the order the shed produced them (least critical
first).

### 1. Discretionary stream -- `0x0000000000000000000000000000deaddeaddead`

| Field | Value |
| --- | --- |
| Transaction hash | `0xc58483cd49462cb70e92859ce3518d10d2e6a2a7e39aaddf6f9c04af0a200d5a` |
| Explorer link | https://sepolia.etherscan.io/tx/0xc58483cd49462cb70e92859ce3518d10d2e6a2a7e39aaddf6f9c04af0a200d5a |
| Block number | `11663965` |
| KeeperHub execution id | `jfh65mb9b66lvr29e4x8n` |
| Gas paid (wei, `gasUsed x effectiveGasPrice`) | not reported |
| Sponsored | not stated |
| Response contract observed (`outcome.contract`) | `status` |

### 2. Standard stream -- `0x00000000000000000000000000000000deaddead`

| Field | Value |
| --- | --- |
| Transaction hash | `0x39c9773b806775cf2a6597258b10463117eec1a03fcb854817fbe3d4661e9f99` |
| Explorer link | https://sepolia.etherscan.io/tx/0x39c9773b806775cf2a6597258b10463117eec1a03fcb854817fbe3d4661e9f99 |
| Block number | `11663967` (read off chain, see the note below) |
| KeeperHub execution id | `lxpc3ldr7uytz59iifrtv` |
| Gas paid (wei, `gasUsed x effectiveGasPrice`) | not reported |
| Sponsored | not stated |
| Response contract observed (`outcome.contract`) | `status` |

### 3. Critical stream -- `0x000000000000000000000000000000000000dead`

| Field | Value |
| --- | --- |
| Transaction hash | `0xfe79cb4a00f8a98030e89e4183d598876f2413934aab495115a056cabd99da66` |
| Explorer link | https://sepolia.etherscan.io/tx/0xfe79cb4a00f8a98030e89e4183d598876f2413934aab495115a056cabd99da66 |
| Block number | `11663968` (read off chain, see the note below) |
| KeeperHub execution id | `szjissksuwurvg3ert7f1` |
| Gas paid (wei, `gasUsed x effectiveGasPrice`) | not reported |
| Sponsored | not stated |
| Response contract observed (`outcome.contract`) | `status` |

**On the block numbers:** the captured record carries one block number, `11663965`, the block
the first write landed in -- that is the figure `pnpm test:evidence` checks. The two blocks
quoted for writes 2 and 3 were read afterwards from their own receipts with
`eth_getTransactionReceipt`; they are marked as such rather than left to look gated, because
this document's rule is that a reader can tell where each number came from. All three receipts
report `status: success`.

**On `sponsored`:** KeeperHub's protocol-write response carries a `sponsored` field only on
the Turnkey Gas Station path -- an ordinary, unsponsored write never includes it at all. So
an absent field means **"not stated"**, not **"not sponsored"**; this run's record either
quotes `true`, quotes `false`, or quotes `not stated`, and it never silently treats a missing
field as a "no". If this run *was* sponsored, do not read that as a sign anything went wrong:
the explorer will show a sender that is not our wallet and a value of `0`, because a relayer
paid for it. That is what a sponsored write looks like on-chain, not evidence of a failed one.

That is what these three receipts show. The sending address is
`0x809d8252aa4f9b8f7d9be7213855b289fe7d0444`, which is not the flow operator this treasury
authorised (`0x8060E46C92D65084Ee141A0DEc12C42366cbC050`): KeeperHub broadcast through its own
relayer. The mandate still held, because the mandate is enforced by the Superfluid ACL on the
operator address, not by whoever pays for the gas.

**On "Gas paid":** the same "absence means not stated" rule applies here, and it matters more
on this row than most, because it is no longer the edge case. KeeperHub's original
(`success`-boolean) response always carried `gasUsed` and `effectiveGasPrice`; the newer
(`status`-bearing) response `origin/staging` now sends carries **neither** -- so on that
contract, every landed write reports no gas figures at all, which is exactly what all three
rows above show. `gasUsedWei` and `effectiveGasPriceWei` are therefore optional on a landed
outcome, and this row quotes **"not reported"** whenever either is absent, never `0`: `0`
claims the write cost nothing, which is a specific and false statement, not the honest "the
response did not say".

## The flow rate, read back off chain

For each stream the shed adjusted, the rate before and after the write -- read independently
with `CFAv1Forwarder.getFlowInfo` against the live chain, **not** taken from KeeperHub's
response (the response carries no rate field at all; only a hash, a link, and -- on the
original response contract, though not the newer one -- gas figures).

| Receiver | Tier | Rate before (wei/sec) | Rate after (wei/sec) |
| --- | --- | --- | --- |
| `0x0000000000000000000000000000deaddeaddead` | discretionary | `57860765330` | `11572153066` |
| `0x00000000000000000000000000000000deaddead` | standard | `86791147994` | `21697786998` |
| `0x000000000000000000000000000000000000dead` | critical | `144651913324` | `86791147994` |

Every "rate after" above is that tier's floor, to the wei. That is the mandate's shape made
visible: the keeper shed the discretionary stream first, then the standard one, then the
critical one, and stopped dead at each floor instead of taking any stream to zero -- which is
what leaves 79664745201 wei/sec of the gap unclosed and the escalation raised.
`pnpm verify-rates` re-reads these rates from the chain at any time and
reports, per stream, whether the live rate sits at its committed rate, at its floor, or below
it.

**Why a chain read and not just the mined receipt:** a mined receipt proves a transaction
landed on chain. It does not, by itself, prove the stream it targeted actually changed rate --
that requires reading the stream's state back off the contract afterwards and comparing it to
what the decision asked for. KeeperHub's own `completeExecution` already re-verifies the
receipt before answering, which is why a landed outcome -- `success: true` with a
`transactionHash` on the contract this executor was first built against, or `status:
"completed"` with a `transactionHash` on the response contract KeeperHub's `staging` branch
now answers with instead -- is a strong signal the write landed; the table above is the second,
independent proof that it changed what it was supposed to change, obtained the same way
KeeperHub's own test suite draws that distinction. The two sets of rows therefore answer two
different questions: the transaction tables answer "did a write reach the chain and get
confirmed", and this table answers "did the stream's rate actually change" -- and both are
reported because a reader should not have to infer one from the other.

**Which response contract this run saw:** the executor recognises both of KeeperHub's
protocol-write response contracts and states, on every outcome from either one, which one
actually answered (`outcome.contract`: `"success"` for the original boolean-`success` body,
`"status"` for the newer `status: "completed" \| "failed" \| "unconfirmed"` body
`origin/staging` now sends). This is stated outright in the rows above, not left for a reader
to infer from whether a field is present -- an absent field on this response has, historically,
meant "not stated" (see `sponsored` above), so a *missing* contract row would be read the same
way and would say nothing. `docs/evidence/run.json` carries whichever contract this run
actually got; that is what makes this run's evidence trustworthy even though which contract
`app.keeperhub.com` serves was, at run time, unverified without spending a live transaction.

All three writes came back on the **`status`** contract. That settles the open question the
dual-contract work existed for: the live deployment answers with the newer body, so an
executor that only read the original `success` boolean would have found no `success` field at
all on a write that had, in fact, landed -- and would have reported a failure that never
happened.
