# VittaGems Contracts

Smart contracts for the VittaGems platform:

- **Phase 1 — Asset Registry & Proof of Reserve:** company assets as NFTs, DAO verification, reserve allocation
  from asset valuations, and a public Proof of Reserve.
- **Phase 2 — Stablecoin & Treasury Operations:** a reserve-backed stablecoin, DAO-controlled minting, and
  treasury-controlled redemption to USDC via the Settlement API.

## Phase 1 contracts

| Contract | Purpose |
| --- | --- |
| `src/registry/AssetRegistry.sol` | ERC-721 registry (`VGA`). Each asset NFT holds class, unique external ref (certificate no.), document hash, USD valuation and status. |
| `src/governance/AssetApprovalDAO.sol` | Council DAO, one member one vote. Approves, rejects, suspends, reinstates, retires and revalues assets; adds and removes members. |
| `src/reserve/ReserveManager.sol` | Allocates Approved assets into reserve pools by basis points. Pool values follow registry valuations automatically. |
| `src/reserve/ProofOfReserve.sol` | Live reserve summary, per-pool values, reserve ratio vs. stablecoin supply, rate-limited on-chain snapshots. |

### Phase 1 flow

```
Registrar ──registerAsset──▶ AssetRegistry (NFT minted, Pending)
DAO member ──proposeAssetAction(Approve)──▶ AssetApprovalDAO
Members ──castVote──▶ quorum + threshold met ──execute──▶ AssetRegistry.setStatus(Approved)
Allocator ──allocate(asset, pool, bps)──▶ ReserveManager (value = valuation × bps)
Anyone ──recordSnapshot──▶ ProofOfReserve (history for charts)
```

- **Asset lifecycle:** Pending → Approved / Rejected; Rejected → Pending (resubmitted by registrar);
  Approved ↔ Suspended; Approved / Suspended → Retired. Only the DAO can change status or revalue.
- **Locked NFTs:** Approved and Suspended assets back the reserves and cannot be transferred.
- **Duplicate protection:** `externalRef` (e.g. gem certificate number) must be unique.
- **Automatic sync:** every status change or revaluation calls `ReserveManager.onAssetUpdated`, so a suspended
  or retired asset drops out of reserves in the same transaction, and a revaluation flows into pool values.
- **DAO rules:** a proposal passes when votes cast ≥ quorum and For / (For + Against) ≥ threshold. It can execute
  early once For alone meets the threshold of all members. One open proposal per asset; members added after a
  proposal was created cannot vote on it.
- `ReserveManager.totalReserveValue()` is what the Phase 2 `CollateralController` reads to cap minting.

## Phase 2 contracts

| Contract | Purpose |
| --- | --- |
| `src/VittaStablecoin.sol` | ERC-20 (`VGUSD`, 18 decimals) with permit and pause. Mint only by the controller, burn only by the redemption module. |
| `src/CollateralController.sol` | Mint requests, DAO mint approvals, collateral ratio, debt ceiling, reserve-ratio monitoring. |
| `src/RedemptionModule.sol` | Redemption requests, DAO approval, oracle pricing, discount, treasury liquidity check, burn and USDC payout. |
| `src/oracle/ChainlinkPriceOracle.sol` | Chainlink feed adapter with staleness checks and a time-boxed DAO fallback price. |
| `src/interfaces/IReserveManager.sol`, `ITreasury.sol` | The parts of Phase 1 contracts this phase depends on. |

## Flows

**Mint**

1. Treasury ops (`MINT_REQUESTER_ROLE`) call `requestMint(to, amount)`.
2. The DAO Timelock (`GOVERNOR_ROLE`) calls `approveMint(id)`. It re-checks against live reserves:
   `supply + amount <= debtCeiling` and `reserveValue / (supply + amount) >= minCollateralRatio`, then mints.

**Redeem**

1. Holder calls `requestRedemption(amount)`; tokens are locked in the module.
2. DAO calls `approveRedemption(id)`: price = `min(oracle, $1)`, minus the discount; treasury USDC is reserved.
3. The Settlement API signer (`SETTLER_ROLE`) calls `settle(id, settlementRef)`: tokens are burned and the Treasury
   pays USDC. `settlementRef` is the off-chain settlement id, emitted for reconciliation.
4. Pending requests can be cancelled by the holder; pending or approved requests can be rejected by the DAO.
   Both return the locked tokens.

**Emergency**: the Safe multisig (`PAUSER_ROLE`) can pause the token, controller and redemption module.
Only the DAO (`DEFAULT_ADMIN_ROLE`) can unpause.

## Roles

| Role | Holder | Contracts |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE`, `GOVERNOR_ROLE` | DAO Timelock (Phase 1) | all |
| `MINTER_ROLE` | CollateralController | VittaStablecoin |
| `BURNER_ROLE` | RedemptionModule | VittaStablecoin |
| `MINT_REQUESTER_ROLE` | Treasury ops wallet | CollateralController |
| `SETTLER_ROLE` | Settlement API signer | RedemptionModule |
| `PAUSER_ROLE` | Emergency Safe multisig | all pausable contracts |

## Phase 1 ↔ Phase 2 integration

Phase 2 unit tests use mocks in `test/mocks/`; `test/integration/AssetToStablecoin.t.sol` runs the real Phase 1
contracts against the Phase 2 controller. Phase 2 needs:

- `ReserveManager.totalReserveValue()` — USD value of allocated reserves, 18 decimals (implemented in Phase 1).
- `Treasury.usdc()`, `Treasury.availableUSDC()` and `Treasury.releaseUSDC(to, amount)`, with the
  RedemptionModule authorised to call `releaseUSDC`. **The Treasury contract is not built yet** (Phase 1, Week 4).


## Getting started

Requires [Foundry](https://book.getfoundry.sh/).

```bash
git submodule update --init --recursive
forge build
forge test
```

Other commands (see `Makefile`):

```bash
make fuzz       # 10k fuzz runs, deeper invariants (CI profile)
make coverage
make slither    # needs slither installed locally
```

## Deploy (Polygon Amoy testnet)

```bash
cp .env.example .env   # fill in addresses and keys
forge script script/DeployPhase1.s.sol --rpc-url polygon_amoy --broadcast --verify
make deploy-amoy        # Phase 2
```

The Phase 2 script deploys all four contracts, wires roles, hands admin to the Timelock and renounces the deployer's roles.
Afterwards, authorise the RedemptionModule on the Phase 1 Treasury.

## Demo test console (local)

`frontend/` is a no-build web console for exercising the full Phase 1 + Phase 2 flow against a local anvil node.
It uses anvil's unlocked accounts, so no wallet is needed. Requires Node 18+.

```bash
anvil                 # terminal 1
make demo-deploy      # terminal 2: deploys everything with mocks, writes frontend/contracts.js
make demo             # serves http://localhost:5173
```

`script/DeployLocal.s.sol` deploys all contracts plus `MockUSDC`, `MockTreasury` (funded with 1M USDC) and
`MockPriceFeed`. Each role goes to its own anvil account so the console can act as each one:

| Account | Role |
| --- | --- |
| #0 | Admin / DAO Timelock (admin + governor everywhere) |
| #1 | Registrar |
| #2 | Allocator |
| #3–#5 | DAO members (quorum 2, threshold 60%, 1-day voting) |
| #6 | Treasury ops (mint requester) |
| #7 | Settlement operator |
| #8 | Pauser multisig |
| #9 | Holder (no role) |

- **Scenarios**: one-click runs of the happy path (asset → DAO → reserves → mint → redeem), asset suspension,
  reinstatement and revaluation, emergency pause, access control, and oracle depeg/staleness/fallback.
  Expected reverts are asserted and shown as passes.
- **Manual testing**: every contract action has a form or a row button. With *Auto-pick role account* on, each
  call is sent from the account holding the required role. Turn it off to send from the acting account and check
  access control.
- **Time controls** move anvil's clock (voting deadlines, snapshot interval, oracle staleness).
- Custom errors are decoded in the activity log, including errors raised in a nested contract call.

After restarting anvil, run `make demo-deploy` again.

## Tests

- `test/unit/` — per-contract behaviour, access control, pause, edge cases, fuzz tests (Phase 1 and 2).
- `test/integration/` — asset NFT → DAO approval → reserve allocation → Proof of Reserve → stablecoin mint → suspension.
- `test/invariant/` — random mint/redeem/approve/settle/reject sequences checking:
  supply ≤ debt ceiling, collateral ratio ≥ minimum, locked tokens accounted, reserved USDC covered.

## Sprint status (Phase 2)

| Sprint | Scope | Status |
| --- | --- | --- |
| S9 | Stablecoin core, mint/burn, pause, project setup | Initial version in this repo |
| S10 | Collateral ratio, reserve ratio, debt ceiling, DAO mint approvals, fuzz tests | Initial version in this repo |
| S11 | Redemption module, oracle, discount, liquidity validation | Initial version in this repo |
| S12 | Settlement API adapter (off-chain), reconciliation, supply analytics UI | Not started |
| S13 | Hardening, coverage to 95%, audit package, UAT | Not started |
