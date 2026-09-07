# Sepolia setup — the human's runbook

This is the runbook for the one real Sepolia run Runway needs: fund the treasury, open
three streams, grant KeeperHub's Turnkey EOA a bounded mandate over them, and confirm the
keeper reads `hold`. **Every signature in this document is signed by a human, in their own
wallet.** No script here asks for a password, a seed phrase or a private key, and none of
them holds one. `scripts/check-config.ts` prints presence booleans only.

All figures below were read live from Ethereum Sepolia (chain id `11155111`) on
**2026-09-07**, and every one of them is asserted by a script before it is printed — see
"Chain resolution" and "Sizing the streams". If you re-run these scripts later and a
number differs from what's printed here, trust the live run, not this document: the chain
moved.

## 0. Prerequisites

```bash
# from the repository root
node --version   # tested on Node 22+
pnpm install
```

Export the four Sepolia setup variables (from `.env`, not committed) into your shell, then
confirm they're present without ever printing them:

```bash
set -a && source .env && set +a
pnpm tsx scripts/check-config.ts
```

Expected:

```
KEEPERHUB_API_KEY: present
KEEPERHUB_BASE_URL: present
SEPOLIA_RPC_URL: present
KEEPERHUB_FLOW_OPERATOR_ADDRESS: present
```

If any line reads `MISSING`, stop here — nothing past this point works without it.

**Dead public RPCs.** Superfluid's own network metadata lists two public Sepolia RPCs
that are both dead as of 2026-09-07, confirmed with a direct `eth_blockNumber` POST to
each: `https://ethereum-sepolia.blockpi.network/v1/rpc/public` answers HTTP 521, and
`https://rpc.sepolia.org` answers HTTP 404. Don't spend time debugging either — `.env`'s
`SEPOLIA_RPC_URL` already points at a live one
(`https://ethereum-sepolia-rpc.publicnode.com`).

## 1. Confirm Sepolia is enabled for the organisation

```bash
curl -sS -H "Authorization: Bearer $KEEPERHUB_API_KEY" "$KEEPERHUB_BASE_URL/api/chains"
```

Confirmed on 2026-09-07: the response's `chainId: 11155111` entry (`"name":"Ethereum
Sepolia"`) carries `"isTestnet":true` and `"isEnabled":true`. If it is absent or
`isEnabled` is `false`, enable it in the KeeperHub UI before continuing — nothing below
will execute without it.

## 2. Resolve the chain

```bash
pnpm tsx scripts/resolve-sepolia.ts
```

This reads and **asserts** every fact the rest of this runbook depends on; it stops with a
named error on a zero address, a revert or a mismatch rather than printing a value nothing
checked. Actual output, **block 11656087, read 2026-09-07T19:05:04.627Z**:

```
Ethereum Sepolia (chainId 11155111), block 11656087, read at 2026-09-07T19:05:04.627Z

ETHx.getUnderlyingToken() = 0x0000000000000000000000000000000000000000
ETHx.getHost() = 0x109412E3C84f0539b43d39dB691B08c90f58dC7c
CFAv1Forwarder.getFlowInfo(ETHx, treasury, treasury) = lastUpdated 0, flowRate 0, deposit 0, owedDeposit 0
CFAv1Forwarder.getAccountFlowrate(ETHx, treasury) = 0 wei/sec

Governance.superTokenMinimumDeposit(ETHx) = 0 wei
Governance.PPPConfiguration(ETHx) = liquidationPeriod 3600s, patricianPeriod 720s

treasury (0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776) ETH balance = 601000000000000000 wei
treasury ETHx realtimeBalanceOf = available 0 wei, deposit 0 wei, owedDeposit 0 wei

resolve-sepolia: all assertions passed at block 11656087
```

What this confirms, and why each check exists:

| Assertion | Result | Why it matters |
| --- | --- | --- |
| `getUnderlyingToken()` is the zero address | ✅ `0x0…0` | ETHx is a native-asset super token — wrap with the payable `upgradeByETH()`, never `upgrade(uint256)` (there is no underlying ERC-20 to pull) |
| `getHost()` matches the published Sepolia host | ✅ `0x1094…8dC7c` | Confirms this ETHx deployment is wired to the Superfluid protocol instance the rest of this doc assumes |
| `getFlowInfo` / `getAccountFlowrate` answer with the arities `src/chain/abi.ts` declares | ✅ 4 fields / 1 field | Proves the CFAv1Forwarder ABI Runway's reader uses is live and correct, before any real stream exists |
| Governance minimum deposit | `0` wei | No governance floor on Sepolia (unlike mainnet DAIx's 69 DAI) — what binds is the liquidation period below |
| Governance liquidation period | `3600` s (1 hour) | Every stream locks `flowRate × 3600` as its buffer deposit; this is also the project's headline — the protocol's own safety margin is 1 hour, against Runway's default 72-hour warning threshold |
| Governance patrician period | `720` s | Recorded for completeness; Runway's policy does not act on it |
| Treasury ETH balance | `601000000000000000` wei (0.601 ETH) | Input to the sizing step below |
| Treasury ETHx balance | `0` (available), `0` (deposit) | Confirms nothing has been wrapped yet — this run starts from zero |

No contradiction with the ground stated in the task brief: the addresses, the liquidation
period (3600s) and the patrician period (720s) all matched exactly.

## 3. Size the streams

```bash
pnpm tsx scripts/plan-streams.ts
```

Pure arithmetic, in `scripts/lib/plan.ts` (unit-tested — see "Testing evidence" below),
wrapped by `scripts/plan-streams.ts` which reads the treasury's live balance and the live
liquidation period, then prints every step. Actual output, same treasury balance
(0.601 ETH had not moved), read again at **block 11656065, 2026-09-07T19:00:44.037Z**:

```
Ethereum Sepolia, block 11656065, read at 2026-09-07T19:00:44.037Z
treasury (0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776) ETH balance = 601000000000000000 wei
governance liquidation period (ETHx) = 3600s

--- inputs ---
treasuryEthWei        = 601000000000000000
gasReserveWei         = 100000000000000000  (kept unwrapped, for the five setup signatures)
targetRunwaySec       = 604800  (168h)
hysteresisSec         = 86400  (24h)
liquidationPeriodSec  = 3600  (from governance PPPConfiguration, live)
marginPercent         = 25%  (above targetRunwaySec + hysteresisSec)
tierWeights           = [5, 3, 2]  (critical, standard, discretionary)
tierFloorPercents     = [60, 0, 20]%

--- arithmetic ---
desiredRunwaySec = (targetRunwaySec + hysteresisSec) * (100 + marginPercent) / 100 = (604800 + 86400) * 125 / 100 = 864000 (240h)
wrapAmountWei = treasuryEthWei - gasReserveWei = 601000000000000000 - 100000000000000000 = 501000000000000000
totalCommittedRateWeiPerSec = wrapAmountWei / (desiredRunwaySec + liquidationPeriodSec) = 501000000000000000 / (864000 + 3600) = 577455048409 wei/sec
  critical      committedRate = 288727524204 wei/sec  floor = 173236514522 wei/sec  buffer = rate * 3600 = 1039419087134400 wei
  standard      committedRate = 173236514522 wei/sec  floor = 0 wei/sec  buffer = rate * 3600 = 623651452279200 wei
  discretionary committedRate = 115491009683 wei/sec  floor = 23098201936 wei/sec  buffer = rate * 3600 = 415767634858800 wei
totalBufferWei = sum(buffers) = 2078838174272400 wei (0.002079 ETH -- affordable against a 0.501 ETH wrap)
runwayAtCommittedSec = (wrapAmountWei - totalBufferWei) / totalCommittedRateWeiPerSec = (501000000000000000 - 2078838174272400) / 577455048409 = 864000 (240h)
check: runwayAtCommittedSec (864000) > targetRunwaySec + hysteresisSec (691200) -> true

--- result ---
wrap 501000000000000000 wei ETHx via upgradeByETH() (0.501 ETH)
critical: committedRateWeiPerSec = "288727524204", floorRateWeiPerSec = "173236514522"
standard: committedRateWeiPerSec = "173236514522", floorRateWeiPerSec = "0"
discretionary: committedRateWeiPerSec = "115491009683", floorRateWeiPerSec = "23098201936"
flowRateAllowance for the mandate (sum of the three committed rates) = 577455048409
```

**Reading the arithmetic.** `desiredRunwaySec` is set to 25% above
`targetRunwayHours + hysteresisHours` (168h + 24h = 192h → 240h) precisely so the first
dry run (step 7) lands unambiguously in `hold`, not on the boundary where integer-division
rounding could tip it into `restore`. The three committed rates split
`totalCommittedRateWeiPerSec` 5:3:2 (critical : standard : discretionary) — distinct
enough that a future shed would visibly touch discretionary first, then standard, and
would very likely never reach critical (critical's floor is 60% of its own committed
rate). Each stream's buffer (`rate × 3600s`) is a few thousandths of an ETH — negligible
next to the 0.501 ETH wrapped, and the whole plan leaves 0.1 ETH of the treasury's 0.601
ETH **unwrapped**, as plain ETH, purely for gas across the five signatures below.

These numbers are exactly what `policies/treasury.sepolia.yaml` carries.
`tests/scripts/treasury-policy.test.ts` reads the committed file back and re-derives it
from these same recorded inputs through the same pure `planStreams` function, so a hand
edit that drifted from this arithmetic would fail `pnpm test`, not surface later as a
reverted `createFlow`.

## 4. Sink addresses

`policies/treasury.sepolia.yaml`'s three recipients are not people and not placeholders —
they are addresses nobody holds a private key for, chosen so the ETHx this demo streams
is unrecoverable **by design**, not because it was accidentally sent somewhere real:

| Tier | Address |
| --- | --- |
| critical | `0x000000000000000000000000000000000000dEaD` |
| standard | `0x00000000000000000000000000000000dEaDdEaD` |
| discretionary | `0x0000000000000000000000000000dEaDdEaDdEaD` |

The first is Ethereum's own well-known "burn" address (`…dEaD`, spelling "dead" entirely
in valid hex digits — d, E, a, D). The other two repeat the same obviously-synthetic
pattern rather than reusing any address that has ever been observed active on chain, so
none of the three can plausibly collide with a real, spendable account.

## 5. The five signatures

All five transactions below are sent from the **treasury wallet**
(`0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776`) directly — signed in the treasury's own
wallet (e.g. MetaMask), not through KeeperHub. Sepolia gas measured 40–105 gwei during
KeeperHub's own testing (`docs/superpowers/specs/2026-09-06-runway-design.md`, §14); the
costs below are conservative per-call estimates at the high end of that range, not
guarantees — check the real estimate your wallet shows before every signature. Summed at
the very worst case (105 gwei sustained across all five calls: ~0.008 ETH wrap +
~0.026 ETH × 3 createFlow + ~0.011 ETH mandate ≈ 0.098 ETH) they come close to exhausting
the 0.1 ETH gas reserve section 3 set aside — if gas is running hot when you get here, top
the treasury up with a little more Sepolia ETH from a faucet before signing, rather than
relying on the reserve exactly covering the worst case.

You can sign each of these through Sepolia Etherscan's "Write Contract" tab (connect the
treasury wallet) or with `cast send` if you have Foundry installed. Both are shown. Cast
commands use `$SEPOLIA_RPC_URL` (already exported in step 0) and `--account
<your-imported-account>` (or `--private-key $YOUR_OWN_ENV_VAR`, an environment variable
**you** set — never paste a key into this document, a script, or a conversation with the
agent that wrote this runbook).

### 5.1 Wrap 0.501 ETH into ETHx

- **What**: `upgradeByETH()` on the ETHx SuperToken (`0x30a6933Ca9230361972E413a15dC8114c952414e`), payable, no arguments.
- **Costs**: 0.501 ETH (the wrap itself) + gas (a native-asset wrap is a light call, well under 0.01 ETH even at 105 gwei).
- **Not through KeeperHub**: ETHx has no underlying ERC-20 for KeeperHub's `wrap` action to pull from; this is the direct, payable call.

Etherscan: open the ETHx contract's **Write Contract** tab (if `upgradeByETH` isn't
listed, use **Write as Proxy** — ETHx is a UUPS proxy). Set `payableAmount` to `0.501`,
click **Write**, confirm in your wallet.

```bash
cast send 0x30a6933Ca9230361972E413a15dC8114c952414e \
  "upgradeByETH()" \
  --value 501000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --account <your-treasury-account>
```

**Check afterwards**: `realtimeBalanceOf(treasury, now)` on ETHx (Read Contract tab, or
re-run `pnpm tsx scripts/resolve-sepolia.ts`) shows `available ≈ 501000000000000000`
(minus a negligible few seconds of any flow already running — none should be, yet).

### 5.2–5.4 Three `createFlow` calls on the CFAv1Forwarder

- **What**: `createFlow(token, sender, receiver, flowrate, userData)` on the CFAv1Forwarder
  (`0xcfA132E353cB4E398080B9700609bb008eceB125`), once per recipient below.
  `sender == msg.sender` (the treasury calling for itself), so this is a direct create —
  no operator permission is needed yet.
- **Costs**: no ETH value; gas only (`createFlow` does more work than a simple transfer —
  budget up to ~0.03 ETH at 105 gwei per call, refundable estimate only).
- **Check afterwards, each time**: `getFlowInfo(token, treasury, receiver)` (Read Contract,
  or the resolver script) shows the new `flowRate` and a non-zero `deposit` equal to
  `flowRate × 3600`.

| Call | `token` | `sender` | `receiver` | `flowrate` | `userData` |
| --- | --- | --- | --- | --- | --- |
| critical | `0x30a6933Ca9230361972E413a15dC8114c952414e` | `0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776` | `0x000000000000000000000000000000000000dEaD` | `288727524204` | `0x` |
| standard | `0x30a6933Ca9230361972E413a15dC8114c952414e` | `0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776` | `0x00000000000000000000000000000000dEaDdEaD` | `173236514522` | `0x` |
| discretionary | `0x30a6933Ca9230361972E413a15dC8114c952414e` | `0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776` | `0x0000000000000000000000000000dEaDdEaDdEaD` | `115491009683` | `0x` |

```bash
cast send 0xcfA132E353cB4E398080B9700609bb008eceB125 \
  "createFlow(address,address,address,int96,bytes)" \
  0x30a6933Ca9230361972E413a15dC8114c952414e \
  0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776 \
  0x000000000000000000000000000000000000dEaD \
  288727524204 0x \
  --rpc-url "$SEPOLIA_RPC_URL" --account <your-treasury-account>
# repeat for standard (173236514522, receiver …dEaDdEaD) and
# discretionary (115491009683, receiver …dEaDdEaDdEaD)
```

If any of these three reverts with `CFA_INSUFFICIENT_BALANCE`, the wrap in 5.1 didn't
land yet, or landed for less than expected — re-check the ETHx balance before retrying;
do not lower a rate to make it fit without re-running `scripts/plan-streams.ts`, or
`policies/treasury.sepolia.yaml` will no longer match what's actually on chain.

### 5.5 Grant the mandate

- **What**: `updateFlowOperatorPermissions(token, flowOperator, permissions, flowrateAllowance)`
  on the CFAv1Forwarder, called by the treasury (so the permission is granted "on behalf of
  msg.sender" — no explicit `sender` argument).
- **Costs**: no ETH value; gas only (a single storage write — budget up to ~0.01 ETH at
  105 gwei).
- **`permissions = 6`** (`update | delete`, i.e. `2 + 4`) — **deliberately not 7**: the
  agent can throttle and close a stream, and can never create one to an address of its own
  choosing.
- **`flowrateAllowance = 577455048409`** — the sum of the three committed rates above, so
  the agent can restore what was agreed and never exceed it.

| Argument | Value |
| --- | --- |
| `token` | `0x30a6933Ca9230361972E413a15dC8114c952414e` |
| `flowOperator` | `0x8060E46C92D65084Ee141A0DEc12C42366cbC050` (the KeeperHub Turnkey EOA — `$KEEPERHUB_FLOW_OPERATOR_ADDRESS`) |
| `permissions` | `6` |
| `flowrateAllowance` | `577455048409` |

```bash
cast send 0xcfA132E353cB4E398080B9700609bb008eceB125 \
  "updateFlowOperatorPermissions(address,address,uint8,int96)" \
  0x30a6933Ca9230361972E413a15dC8114c952414e \
  0x8060E46C92D65084Ee141A0DEc12C42366cbC050 \
  6 577455048409 \
  --rpc-url "$SEPOLIA_RPC_URL" --account <your-treasury-account>
```

**Record the transaction hash here once sent:**

```
grant-flow-operator tx hash: <fill in after signing>
```

**Verify the mandate landed before continuing** — a mandate that silently failed produces
a revert at the first write several steps later, somewhere much harder to read than here:

```bash
cast call 0xcfA132E353cB4E398080B9700609bb008eceB125 \
  "getFlowOperatorPermissions(address,address,address)(uint8,int96)" \
  0x30a6933Ca9230361972E413a15dC8114c952414e \
  0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776 \
  0x8060E46C92D65084Ee141A0DEc12C42366cbC050 \
  --rpc-url "$SEPOLIA_RPC_URL"
```

Expected: `6, 577455048409`. Or on Etherscan: Read Contract → `getFlowOperatorPermissions`
with `token` = ETHx, `sender` = the treasury, `flowOperator` = the Turnkey EOA.

## 6. Dry run

```bash
pnpm tsx src/cli.ts policies/treasury.sepolia.yaml --dry-run
```

**Before funding** (i.e. before section 5), this trivially prints `decision: hold`,
`runwaySec: n/a` — every listed stream and the account flowrate both read zero, so
`netOutflow` is zero and `decide()` takes the `runwaySec === null` branch straight into
`considerRestore`, which holds because `availableBalanceWei` is also zero. That is a
real result (the CLI, the reader and the policy file all wire together end to end against
the live chain) but not the meaningful demonstration.

**After section 5** is complete, the same command reads the three real streams at their
committed rates and an available ETHx balance of roughly
`501000000000000000 − 2078838174272400 ≈ 498921161825727600` wei (the wrap, minus the
three buffers, minus whatever few seconds of outflow elapsed between wrapping and
opening the streams). Expected:

```
decision: hold
runwaySec: <close to 864000, i.e. ~240h -- comfortably above targetRunwayHours + hysteresisHours = 192h>
breach: false
adjustments: none
```

`runwaySec` will be non-null and just under the planned 864000s (a few seconds shaved off
by the wrap-to-createFlow gap on chain), landing well clear of the 691200s (192h)
threshold — exactly the "first dry run reports hold" the sizing in section 3 was built to
guarantee. No write is attempted: the dry-run branch in `src/cli.ts` never constructs an
executor.

## Testing evidence

- `scripts/lib/plan.ts` is pure (no network, no filesystem, no clock) and carries its own
  regression test against this exact scenario plus five fast-check property suites (1000
  runs each) in `tests/scripts/plan-streams.test.ts`, asserting: the runway inequality this
  whole plan exists to satisfy, buffer affordability, strictly-decreasing tier rates, a
  strictly-positive discretionary floor, and no floor exceeding its own committed rate.
- `tests/scripts/treasury-policy.test.ts` reads `policies/treasury.sepolia.yaml` back and
  checks it against `planStreams` called with the exact inputs recorded in this document —
  the committed file cannot silently drift from the arithmetic above.
- `scripts/resolve-sepolia.ts` and `scripts/check-config.ts` talk to the chain and the
  environment respectively, so neither is unit-tested against a mocked chain; their
  correctness is the live output captured verbatim in sections 1–3 above, run against real
  Sepolia RPC and the real KeeperHub API on 2026-09-07.
- `pnpm test`, `pnpm typecheck` and `pnpm check` are clean with these scripts in the tree.
