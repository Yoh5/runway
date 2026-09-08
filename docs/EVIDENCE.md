# Evidence: the verified Sepolia execution

This document records the one live demonstration run required by the main track: the
treasury's budget tightened until Runway's policy engine decided to shed, KeeperHub
broadcast the resulting `update-flow` write, and the write was confirmed two ways —
once by the mined receipt, once by an independent chain read afterwards.

Every value below is asserted against `docs/evidence/run.json` by
`tests/docs/evidence.test.ts` (run with `pnpm test:evidence`, not part of the default
`pnpm test`). Every value slot below currently holds an obvious placeholder token that no
real transaction hash, block number, rate or gas figure could ever equal, so this document
fails its own test until every slot is rewritten with the values the live run actually
produced — that is deliberate, not a placeholder left by mistake.

To fill it in: run the live tick (`pnpm tsx src/cli.ts policies/treasury.sepolia.yaml`),
then `pnpm tsx scripts/capture-evidence.ts <path-to-the-run-record>` to produce
`docs/evidence/run.json` and `docs/evidence/report.html`, replace every placeholder value
below with the matching figure the test prints when it fails, and run `pnpm test:evidence`
until it is green.

## The transaction

| Field | Value |
| --- | --- |
| Transaction hash | `SENTINEL-NOT-A-REAL-VALUE` |
| Explorer link | `SENTINEL-NOT-A-REAL-VALUE` |
| Block number | `SENTINEL-NOT-A-REAL-VALUE` |
| Gas paid (wei, `gasUsed × effectiveGasPrice`) | `SENTINEL-NOT-A-REAL-VALUE` |
| Sponsored | `SENTINEL-NOT-A-REAL-VALUE` |
| Response contract observed (`outcome.contract`) | `SENTINEL-NOT-A-REAL-VALUE` |

**On `sponsored`:** KeeperHub's protocol-write response carries a `sponsored` field only on
the Turnkey Gas Station path — an ordinary, unsponsored write never includes it at all. So
an absent field means **"not stated"**, not **"not sponsored"**; this run's record either
quotes `true`, quotes `false`, or quotes `not stated`, and it never silently treats a missing
field as a "no". If this run *was* sponsored, do not read that as a sign anything went wrong:
the explorer will show a sender that is not our wallet and a value of `0`, because a relayer
paid for it. That is what a sponsored write looks like on-chain, not evidence of a failed one.

## The flow rate, read back off chain

For each stream the shed adjusted, the rate before and after the write — read independently
with `CFAv1Forwarder.getFlowInfo` against the live chain, **not** taken from KeeperHub's
response (the response carries no rate field at all; only a hash, a link, and gas figures).

| Receiver | Rate before (wei/sec) | Rate after (wei/sec) |
| --- | --- | --- |
| `SENTINEL-NOT-A-REAL-VALUE` | `SENTINEL-NOT-A-REAL-VALUE` | `SENTINEL-NOT-A-REAL-VALUE` |

**Why a chain read and not just the mined receipt:** a mined receipt proves a transaction
landed on chain. It does not, by itself, prove the stream it targeted actually changed rate —
that requires reading the stream's state back off the contract afterwards and comparing it to
what the decision asked for. KeeperHub's own `completeExecution` already re-verifies the
receipt before answering, which is why a landed outcome — `success: true` with a
`transactionHash` on the contract this executor was first built against, or `status:
"completed"` with a `transactionHash` on the response contract KeeperHub's `staging` branch
now answers with instead — is a strong signal the write landed; the table above is the second,
independent proof that it changed what it was supposed to change, obtained the same way
KeeperHub's own test suite draws that distinction. The two rows above therefore answer two
different questions: the transaction row answers "did a write reach the chain and get
confirmed", and this table answers "did the stream's rate actually change" — and both are
reported because a reader should not have to infer one from the other.

**Which response contract this run saw:** the executor recognises both of KeeperHub's
protocol-write response contracts and states, on every outcome from either one, which one
actually answered (`outcome.contract`: `"success"` for the original boolean-`success` body,
`"status"` for the newer `status: "completed" \| "failed" \| "unconfirmed"` body
`origin/staging` now sends). This is stated outright in the row above, not left for a reader
to infer from whether a field is present — an absent field on this response has, historically,
meant "not stated" (see `sponsored` above), so a *missing* contract row would be read the same
way and would say nothing. `docs/evidence/run.json` carries whichever contract this run
actually got; that is what makes this run's evidence trustworthy even though which contract
`app.keeperhub.com` serves was, at run time, unverified without spending a live transaction.
