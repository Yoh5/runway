# Sepolia setup — the human's runbook

This is the runbook for the one real Sepolia run Runway needs: fund the treasury, top up
KeeperHub's Turnkey EOA so it can pay for its own writes, open three streams, grant that
EOA a bounded mandate over them, and confirm the keeper reads `hold`. **Every signature in
this document is signed by a human, in their own wallet.** No script here asks for a
password, a seed phrase or a private key, and none of them holds one.
`scripts/check-config.ts` prints presence booleans only.

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

Fill in `.env` (copy `.env.example`; it is not committed), then confirm the four Sepolia
setup variables are present without ever printing them:

```bash
pnpm check-config
```

Every command in this runbook that touches the chain or KeeperHub is a `package.json`
script that runs `node --env-file=.env`, so `.env` is loaded for you and the same command
works in bash and in PowerShell. Calling the underlying file directly (`pnpm tsx
scripts/check-config.ts`) does **not** load it: `tsx` reads no `.env`, so every variable
reports `MISSING` even when the file is correct, which reads as a broken setup rather than
a wrong command. Use the script names.

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
pnpm resolve
```

This reads and **asserts** every fact the rest of this runbook depends on; it stops with a
named error on a zero address, a revert or a mismatch rather than printing a value nothing
checked. Actual output, **block 11656172, read 2026-09-07T19:23:08.086Z**:

```
Ethereum Sepolia (chainId 11155111), block 11656172, read at 2026-09-07T19:23:08.086Z

ETHx.getUnderlyingToken() = 0x0000000000000000000000000000000000000000
ETHx.getHost() = 0x109412E3C84f0539b43d39dB691B08c90f58dC7c
CFAv1Forwarder.getFlowInfo(ETHx, treasury, treasury) = lastUpdated 0, flowRate 0, deposit 0, owedDeposit 0
CFAv1Forwarder.getAccountFlowrate(ETHx, treasury) = 0 wei/sec

Governance.superTokenMinimumDeposit(ETHx) = 0 wei
Governance.PPPConfiguration(ETHx) = liquidationPeriod 3600s, patricianPeriod 720s

treasury (0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776) ETH balance = 601000000000000000 wei
treasury ETHx realtimeBalanceOf = available 0 wei, deposit 0 wei, owedDeposit 0 wei

resolve-sepolia: all assertions passed at block 11656172
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
pnpm plan-streams
```

Pure arithmetic, in `scripts/lib/plan.ts` (unit-tested — see "Testing evidence" below),
wrapped by `scripts/plan-streams.ts` which reads the treasury's live balance and the live
liquidation period, then prints every step. Actual output, same treasury balance
(0.601 ETH had not moved), read at **block 11656171, 2026-09-07T19:23:00.038Z**, with the
standard-tier floor fix applied (`tierFloorPercents` corrected from `[60, 0, 20]` to
`[60, 25, 20]` the same day — see "Floor correction" below the block):

```
Ethereum Sepolia, block 11656171, read at 2026-09-07T19:23:00.038Z
treasury (0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776) ETH balance = 601000000000000000 wei
governance liquidation period (ETHx) = 3600s

--- inputs ---
treasuryEthWei        = 601000000000000000
gasReserveWei         = 350000000000000000  (kept unwrapped: treasury gas for the six setup signatures + 0.05 ETH forwarded to the operator EOA)
targetRunwaySec       = 604800  (168h)
hysteresisSec         = 86400  (24h)
liquidationPeriodSec  = 3600  (from governance PPPConfiguration, live)
marginPercent         = 25%  (above targetRunwaySec + hysteresisSec)
tierWeights           = [5, 3, 2]  (critical, standard, discretionary)
tierFloorPercents     = [60, 25, 20]%

--- arithmetic ---
desiredRunwaySec = (targetRunwaySec + hysteresisSec) * (100 + marginPercent) / 100 = (604800 + 86400) * 125 / 100 = 864000 (240h)
wrapAmountWei = treasuryEthWei - gasReserveWei = 601000000000000000 - 350000000000000000 = 251000000000000000
totalCommittedRateWeiPerSec = wrapAmountWei / (desiredRunwaySec + liquidationPeriodSec) = 251000000000000000 / (864000 + 3600) = 289303826648 wei/sec
  critical      committedRate = 144651913324 wei/sec  floor = 86791147994 wei/sec  buffer = rate * 3600 = 520746887966400 wei
  standard      committedRate = 86791147994 wei/sec  floor = 21697786998 wei/sec  buffer = rate * 3600 = 312448132778400 wei
  discretionary committedRate = 57860765330 wei/sec  floor = 11572153066 wei/sec  buffer = rate * 3600 = 208298755188000 wei
totalBufferWei = sum(buffers) = 1041493775932800 wei (0.001041 ETH -- affordable against a 0.251 ETH wrap)
runwayAtCommittedSec = (wrapAmountWei - totalBufferWei) / totalCommittedRateWeiPerSec = (251000000000000000 - 1041493775932800) / 289303826648 = 864000 (240h)
check: runwayAtCommittedSec (864000) > targetRunwaySec + hysteresisSec (691200) -> true

--- result ---
wrap 251000000000000000 wei ETHx via upgradeByETH() (0.251 ETH)
critical: committedRateWeiPerSec = "144651913324", floorRateWeiPerSec = "86791147994"
standard: committedRateWeiPerSec = "86791147994", floorRateWeiPerSec = "21697786998"
discretionary: committedRateWeiPerSec = "57860765330", floorRateWeiPerSec = "11572153066"
flowRateAllowance for the mandate (sum of the three committed rates) = 289303826648
```

**Reading the arithmetic.** `desiredRunwaySec` is set to 25% above
`targetRunwayHours + hysteresisHours` (168h + 24h = 192h → 240h) precisely so the first
dry run (step 7) lands unambiguously in `hold`, not on the boundary where integer-division
rounding could tip it into `restore`. The three committed rates split
`totalCommittedRateWeiPerSec` 5:3:2 (critical : standard : discretionary) — distinct rates
that a future budget squeeze sheds in that order (`TIER_ORDER` in
`src/policy/types.ts`: discretionary, then standard, then critical). Each tier keeps a
floor sized as a percentage of its own committed rate — 60% / 25% / 20% for critical /
standard / discretionary — every one non-zero, because on Superfluid a rate-zero stream
doesn't exist: restoring one would require a `createFlow` the mandate's `permissions: 6`
(`update | delete`, never `create`) withholds, so a stream a shed can reach must stay
restorable. Critical keeps the most headroom (60%); discretionary gives up the most (20%);
standard sits between the two (25%) so a shed reaching it still has real room to cut
before critical is touched. Each stream's buffer (`rate × 3600s`) is a small fraction of
the wrap — negligible next to the 0.251 ETH wrapped, and the whole plan leaves 0.35 ETH of
the treasury's 0.601 ETH **unwrapped**, as plain ETH: 0.30 ETH of gas cushion for the six
signatures below (see "Worst-case gas arithmetic" in section 5) plus the 0.05 ETH that
section 5.1 forwards to the KeeperHub Turnkey EOA.

These numbers are exactly what `policies/treasury.sepolia.yaml` carries.
`tests/scripts/treasury-policy.test.ts` reads the committed file back and re-derives it
from these same recorded inputs through the same pure `planStreams` function, so a hand
edit that drifted from this arithmetic would fail `pnpm test`, not surface later as a
reverted `createFlow`.

**Floor correction (2026-09-07, same day as the block-11656171 read).** Task 9's original
brief named only the discretionary tier for the non-zero-floor rule in spec section 5, so
`TIER_FLOOR_PERCENTS` shipped as `[60, 0, 20]` — a zero floor on standard. A zero floor is
a one-way door: the shed may take that stream to zero, and this mandate can never reopen
it, so every later restore tick would raise a permanent `stream-closed-cannot-restore`
escalation for it. Corrected to `[60, 25, 20]`; only `floorRateWeiPerSec` for the standard
recipient changed (`0` → `21697786998`) — `totalCommittedRateWeiPerSec` and all three
`committedRateWeiPerSec` values are untouched, since floors are computed from a committed
rate and never feed back into it (`scripts/lib/plan.ts`). The three `createFlow`
transactions signed against those committed rates, and the mandate's `flowRateAllowance`
(their sum), remain valid.

Budget it takes to reach standard: the shed only reaches a tier once every tier before it
in `TIER_ORDER` is already at its own floor, so standard is touched once
`need = totalCommittedRateWeiPerSec - budget` exceeds discretionary's reducible range
(`57860765330 - 11572153066 = 46288612264` wei/sec) — i.e. once
`budget < 289303826648 - 46288612264 = 243015214384` wei/sec, which at this policy's
`targetRunwaySec` (604800s) means `availableBalanceWei` below roughly `0.147` ETH, about
59% of the 0.251 ETH this policy wraps. In practice the bound that matters is tighter
still: `decide()` only sheds at all once `runwaySec < minRunwaySec` (72h), which for this
policy's `totalCommittedRateWeiPerSec` requires `availableBalanceWei` below roughly
`0.075` ETH (about 30% of the wrap) — comfortably under the 0.147 ETH standard-reaching
threshold, so any tick that sheds at all already reaches standard. Confirmed directly
against `decide()` and the committed policy in
`tests/scripts/treasury-policy.test.ts` ("a plausible budget squeeze sheds the standard
tier down to its floor, never to zero"), using `availableBalanceWei = 0.0502` ETH — 20% of
the wrap.

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

## 5. The six signatures

All six transactions below are sent from the **treasury wallet**
(`0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776`) directly — signed in the treasury's own
wallet (e.g. MetaMask), not through KeeperHub. Sepolia gas measured 40–105 gwei during
KeeperHub's own testing (`docs/superpowers/specs/2026-09-06-runway-design.md`, §14); the
per-call costs noted below are conservative estimates at the high end of that range, not
guarantees — check the real estimate your wallet shows before every signature. See
"Worst-case gas arithmetic" just below for the number the 0.35 ETH reserve (section 3) is
actually sized against — if gas is running unusually hot when you get here, top the
treasury up with a little more Sepolia ETH from a faucet before signing, rather than
relying on the reserve exactly covering the worst case.

You can sign each of these through Sepolia Etherscan's "Write Contract" tab (connect the
treasury wallet) or with `cast send` if you have Foundry installed. Both are shown. Cast
commands use `$SEPOLIA_RPC_URL` (already exported in step 0) and `--account
<your-imported-account>` (or `--private-key $YOUR_OWN_ENV_VAR`, an environment variable
**you** set — never paste a key into this document, a script, or a conversation with the
agent that wrote this runbook).

### Worst-case gas arithmetic

Two wallets pay gas on this run, and each must hold enough to survive the worst case
Sepolia has actually shown, not the average case.

**105 gwei is not a guess.** KeeperHub's own testing measured Sepolia gas between 40 and
105 gwei on 2026-07-02, and moved their own CI off live Sepolia because of it
(`docs/superpowers/specs/2026-09-06-runway-design.md`, section 14, "Known risks"). 105
gwei is that measured ceiling.

**The treasury wallet** signs all six transactions below: the 0.05 ETH transfer (5.1),
the wrap (5.2), three `createFlow` calls (5.3–5.5) and the mandate grant (5.6). Budgeting
a conservative flat 250,000 gas per transaction (real storage writes, not a bare transfer)
against the 105 gwei ceiling:

```
6 transactions × 250,000 gas × 105 gwei/gas = 6 × 0.02625 ETH = 0.1575 ETH
```

against the 0.30 ETH of the 0.35 ETH reserve (section 3) earmarked for treasury gas — the
reserve's other 0.05 ETH is the transfer's own value in 5.1, not gas. 0.30 ETH covers
about eleven transactions' worth of headroom at the same rate, roughly double what the six
calls actually cost.

**The KeeperHub Turnkey EOA** (`0x8060E46C92D65084Ee141A0DEc12C42366cbC050`,
`$KEEPERHUB_FLOW_OPERATOR_ADDRESS`) pays for its own writes on any route KeeperHub does
not sponsor — see "Why" in 5.1 below. Up to three `update-flow` calls can land in a single
tick (one per stream). At the same 250,000 gas / 105 gwei worst case:

```
3 transactions × 250,000 gas × 105 gwei/gas = 3 × 0.02625 ETH = 0.07875 ETH (≈0.079 ETH)
```

Before 5.1 that EOA holds `0.05 ETH` on chain (confirmed live at block 11656176) — less
than the 0.079 ETH worst case, so a hot-gas tick before funding could leave the keeper
unable to broadcast mid-demonstration. After 5.1's 0.05 ETH transfer it holds `0.10 ETH`,
clearing the worst case with about 0.021 ETH (roughly 27%) to spare.

### 5.1 Send 0.05 ETH to the KeeperHub Turnkey EOA

- **What**: a plain ETH transfer — **not** a contract call — from the treasury wallet to
  `0x8060E46C92D65084Ee141A0DEc12C42366cbC050` (`$KEEPERHUB_FLOW_OPERATOR_ADDRESS`), value
  `0.05` ETH, empty calldata.
- **Why**: on an unsponsored route, that EOA itself signs, broadcasts and pays for the
  write — KeeperHub's own documentation calls sponsorship "a condition rather than a
  guarantee," not something this run can rely on. See "Worst-case gas arithmetic" above:
  three `update-flow` calls in one tick can cost about 0.079 ETH at 105 gwei, more than
  the 0.05 ETH the EOA already holds. This transfer brings it to 0.10 ETH before the
  keeper ever needs it, rather than topping it up after it stalls mid-demonstration.
- **Costs**: 0.05 ETH (the transfer itself) + gas (a bare transfer, ~21,000 gas — a small
  fraction of a cent even at 105 gwei).

Etherscan: from the treasury wallet (e.g. MetaMask), send `0.05` ETH directly to
`0x8060E46C92D65084Ee141A0DEc12C42366cbC050` — no contract, no calldata.

```bash
cast send 0x8060E46C92D65084Ee141A0DEc12C42366cbC050 \
  --value 50000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --account <your-treasury-account>
```

**Check afterwards**: the EOA's ETH balance (Etherscan, or `cast balance
0x8060E46C92D65084Ee141A0DEc12C42366cbC050 --rpc-url "$SEPOLIA_RPC_URL"`) shows
`100000000000000000` wei (0.10 ETH).

### 5.2 Wrap 0.251 ETH into ETHx

- **What**: `upgradeByETH()` on the ETHx SuperToken (`0x30a6933Ca9230361972E413a15dC8114c952414e`), payable, no arguments.
- **Costs**: 0.251 ETH (the wrap itself) + gas (a native-asset wrap is a light call, well under 0.01 ETH even at 105 gwei).
- **Not through KeeperHub**: ETHx has no underlying ERC-20 for KeeperHub's `wrap` action to pull from; this is the direct, payable call.

Etherscan: open the ETHx contract's **Write Contract** tab (if `upgradeByETH` isn't
listed, use **Write as Proxy** — ETHx is a UUPS proxy). Set `payableAmount` to `0.251`,
click **Write**, confirm in your wallet.

```bash
cast send 0x30a6933Ca9230361972E413a15dC8114c952414e \
  "upgradeByETH()" \
  --value 251000000000000000 \
  --rpc-url "$SEPOLIA_RPC_URL" --account <your-treasury-account>
```

**Check afterwards**: `realtimeBalanceOf(treasury, now)` on ETHx (Read Contract tab, or
re-run `pnpm resolve`) shows `available ≈ 251000000000000000`
(minus a negligible few seconds of any flow already running — none should be, yet).

### 5.3–5.5 Three `createFlow` calls on the CFAv1Forwarder

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
| critical | `0x30a6933Ca9230361972E413a15dC8114c952414e` | `0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776` | `0x000000000000000000000000000000000000dEaD` | `144651913324` | `0x` |
| standard | `0x30a6933Ca9230361972E413a15dC8114c952414e` | `0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776` | `0x00000000000000000000000000000000dEaDdEaD` | `86791147994` | `0x` |
| discretionary | `0x30a6933Ca9230361972E413a15dC8114c952414e` | `0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776` | `0x0000000000000000000000000000dEaDdEaDdEaD` | `57860765330` | `0x` |

```bash
cast send 0xcfA132E353cB4E398080B9700609bb008eceB125 \
  "createFlow(address,address,address,int96,bytes)" \
  0x30a6933Ca9230361972E413a15dC8114c952414e \
  0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776 \
  0x000000000000000000000000000000000000dEaD \
  144651913324 0x \
  --rpc-url "$SEPOLIA_RPC_URL" --account <your-treasury-account>
# repeat for standard (86791147994, receiver …dEaDdEaD) and
# discretionary (57860765330, receiver …dEaDdEaDdEaD)
```

If any of these three reverts with `CFA_INSUFFICIENT_BALANCE`, the wrap in 5.2 didn't
land yet, or landed for less than expected — re-check the ETHx balance before retrying;
do not lower a rate to make it fit without re-running `scripts/plan-streams.ts`, or
`policies/treasury.sepolia.yaml` will no longer match what's actually on chain.

### 5.6 Grant the mandate

- **What**: `updateFlowOperatorPermissions(token, flowOperator, permissions, flowrateAllowance)`
  on the CFAv1Forwarder, called by the treasury (so the permission is granted "on behalf of
  msg.sender" — no explicit `sender` argument).
- **Costs**: no ETH value; gas only (a single storage write — budget up to ~0.01 ETH at
  105 gwei).
- **`permissions = 6`** (`update | delete`, i.e. `2 + 4`) — **deliberately not 7**: the
  agent can throttle and close a stream, and can never create one to an address of its own
  choosing.
- **`flowrateAllowance = 289303826648`** — the sum of the three committed rates above, so
  the agent can restore what was agreed and never exceed it.

| Argument | Value |
| --- | --- |
| `token` | `0x30a6933Ca9230361972E413a15dC8114c952414e` |
| `flowOperator` | `0x8060E46C92D65084Ee141A0DEc12C42366cbC050` (the KeeperHub Turnkey EOA — `$KEEPERHUB_FLOW_OPERATOR_ADDRESS`) |
| `permissions` | `6` |
| `flowrateAllowance` | `289303826648` |

```bash
cast send 0xcfA132E353cB4E398080B9700609bb008eceB125 \
  "updateFlowOperatorPermissions(address,address,uint8,int96)" \
  0x30a6933Ca9230361972E413a15dC8114c952414e \
  0x8060E46C92D65084Ee141A0DEc12C42366cbC050 \
  6 289303826648 \
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

Expected: `6, 289303826648`. Or on Etherscan: Read Contract → `getFlowOperatorPermissions`
with `token` = ETHx, `sender` = the treasury, `flowOperator` = the Turnkey EOA.

## 6. Dry run

```bash
pnpm tick policies/treasury.sepolia.yaml --dry-run
```

**Before funding** (i.e. before section 5), this trivially prints `decision: hold`,
`runwaySec: n/a` — every listed stream and the account flowrate both read zero, so
`netOutflow` is zero and `decide()` takes the `runwaySec === null` branch straight into
`considerRestore`, which holds because `availableBalanceWei` is also zero. That is a
real result (the CLI, the reader and the policy file all wire together end to end against
the live chain) but not the meaningful demonstration.

**After section 5** is complete, the same command reads the three real streams at their
committed rates and an available ETHx balance of roughly
`251000000000000000 − 1041493775932800 ≈ 249958506224067200` wei (the wrap, minus the
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
  regression test against this exact scenario plus six fast-check property suites (1000
  runs each) in `tests/scripts/plan-streams.test.ts`, asserting: the runway inequality this
  whole plan exists to satisfy, buffer affordability, strictly-decreasing tier rates,
  strictly-positive floors on every tier (not just discretionary), and no floor exceeding
  its own committed rate. `planStreams` itself refuses to produce a plan with a zero floor
  on any tier (`PlanError`, unit-tested for all three), so a future sizing change cannot
  quietly reintroduce the trap this correction fixes.
- `tests/scripts/treasury-policy.test.ts` reads `policies/treasury.sepolia.yaml` back and
  checks it against `planStreams` called with the exact inputs recorded in this document —
  the committed file cannot silently drift from the arithmetic above. It also asserts every
  recipient has a non-zero floor, and that a plausible budget squeeze (`availableBalanceWei`
  at 20% of the 0.251 ETH wrap) drives `decide()` to shed the standard tier down to its
  floor without ever reaching zero.
- `scripts/resolve-sepolia.ts` and `scripts/check-config.ts` talk to the chain and the
  environment respectively, so neither is unit-tested against a mocked chain; their
  correctness is the live output captured verbatim in sections 1–3 above, run against real
  Sepolia RPC and the real KeeperHub API on 2026-09-07.
- `pnpm test`, `pnpm typecheck` and `pnpm check` are clean with these scripts in the tree.
