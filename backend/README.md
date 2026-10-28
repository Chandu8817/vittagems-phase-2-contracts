# VittaGems Backend Service (Phase 2)

Production-ready backend service for the VittaGems reserve-backed stablecoin platform. Built with Node.js Express, ethers v6, and SQLite, providing an idempotent settlement engine, persistent on-chain reconciliation, supply/reserve analytics, and secure administrative controls.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites & Installation](#prerequisites--installation)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Local Anvil Setup & Deployment](#local-anvil-setup--deployment)
- [API Reference](#api-reference)
- [API Reference](#api-reference)
  - [System & Health](#system--health)
  - [Contract Information](#contract-information)
  - [RWA Asset API](#rwa-asset-api)
  - [Settlement API](#settlement-api)
  - [Reconciliation API](#reconciliation-api)
  - [Supply & Reserve Analytics](#supply--reserve-analytics)
- [Security & Operational Controls](#security--operational-controls)
- [Persistence & Database Migrations](#persistence--database-migrations)
- [Running Tests](#running-tests)
- [Treasury Contract Limitations & Boundary](#treasury-contract-limitations--boundary)

---

## Architecture Overview

The VittaGems backend serves as the off-chain settlement adapter, reconciliation auditor, and analytics gateway for the VittaGems protocol:

```
                          ┌──────────────────────┐
                          │    Frontend / Ops    │
                          └──────────┬───────────┘
                                     │ HTTP (REST + API Key Auth)
                                     ▼
                    ┌─────────────────────────────────┐
                    │      VittaGems Backend API      │
                    │   (Express + Ethers v6 + DB)    │
                    └───┬─────────────────────────┬───┘
                        │                         │
       SQLite Persistence Layer                   │ Ethers v6 Signer
     (Idempotency, Audit Records)                 │ (SETTLER_ROLE Account #7)
                        │                         ▼
                        │          ┌─────────────────────────────┐
                        │          │   Solidity Smart Contracts  │
                        │          ├─────────────────────────────┤
                        └─────────►│ • AssetRegistry (VGA RWA)   │
           Reconciliation Auditor  │ • ReserveManager            │
            (On-chain Event Sync)  │ • RedemptionModule          │
                                   │ • CollateralController      │
                                   │ • VittaStablecoin (VGUSD)   │
                                   └─────────────────────────────┘
```

- **Runtime**: Node.js (v18+) CommonJS.
- **Web Framework**: Express v5 with centralized error sanitization and CORS control.
- **Web3**: ethers v6 configured with static network mode for stable reconnects.
- **Persistence**: SQLite (via `sqlite3` wrapped in asynchronous transaction-ready `DatabaseClient`).

---

## Prerequisites & Installation

- **Node.js**: v18.0.0 or higher
- **Foundry** (for local Anvil development): `anvil`, `forge`, `cast`

```bash
cd backend
npm install
```

---

## Configuration & Environment Variables

Copy `.env.example` to `.env` and populate with your network parameters:

```bash
cp .env.example .env
```

| Variable | Description | Default / Example |
|---|---|---|
| `PORT` | HTTP server port | `3001` |
| `NODE_ENV` | Application environment (`development`, `production`, `test`) | `development` |
| `RPC_URL` | EVM JSON-RPC URL | `http://127.0.0.1:8545` |
| `CHAIN_ID` | EVM Chain ID | `31337` |
| `SETTLEMENT_SIGNER_KEY` | Private key of account with `SETTLER_ROLE` on `RedemptionModule` | `0x4bbbf...` (Anvil #7) |
| `ASSET_REGISTRY_ADDRESS` | Deployed address of `AssetRegistry` (VGA ERC-721) | `0x5fbdb23...` |
| `VITA_STABLECOIN_ADDRESS` | Deployed address of `VittaStablecoin` (VGUSD) | `0x0b306bf...` |
| `COLLATERAL_CONTROLLER_ADDRESS` | Deployed address of `CollateralController` | `0x959922b...` |
| `REDEMPTION_MODULE_ADDRESS` | Deployed address of `RedemptionModule` | `0x68b1d87...` |
| `RESERVE_MANAGER_ADDRESS` | Deployed address of `ReserveManager` | `0x9fe4673...` |
| `SETTLEMENT_API_KEY` | Secret key required to execute write actions (settle, reconcile) | `vittagems-secret-key` |
| `ALLOWED_ORIGINS` | Permitted CORS origins (comma-separated or `*`) | `http://localhost:5173` |
| `DB_PATH` | Path to SQLite database file | `./data/vittagems.db` |
| `CONFIRMATIONS` | Number of on-chain block confirmations to wait for settlement | `1` |

> **Security Note**: Never commit `.env` or paste real private keys in source control. Startup validation verifies contract bytecode and ensures the settlement signer holds `SETTLER_ROLE`.

---

## Local Anvil Setup & Deployment

1. **Start Anvil** in a separate terminal:
   ```bash
   anvil --chain-id 31337 --port 8545
   ```

2. **Deploy Contracts** from repository root:
   ```bash
   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
   ```
   *Note: `DeployLocal.s.sol` automatically assigns `SETTLER_ROLE` to Anvil Account #7 (`0x14dC79964da2C08b23698B3D3cc7Ca32193d9955`).*

3. **Verify Addresses** in `backend/.env` match the addresses printed during deployment.

4. **Start the Backend**:
   ```bash
   npm start
   # or development auto-reload:
   npm run dev
   ```

---

## API Reference

All successful responses return JSON with `{ success: true, ... }`. Error responses follow standard HTTP codes with `{ success: false, error: "..." }`.

### System & Health

#### `GET /health`
Health check reporting uptime, configuration status, and RPC connectivity.

---

### Contract Information

#### `GET /api/contracts/info`
Returns configured contract addresses (including `assetRegistry`), settler signer address, and deployment network identity.

#### `GET /api/contracts/reserves`
Legacy-compatible endpoint returning live oracle reserve valuation and collateral status.

---

### RWA Asset API

Integrates with `AssetRegistry.sol` (`VGA` ERC-721 token) and `ReserveManager.sol` to inspect and query real-world assets backing the stablecoin reserves.

#### `GET /api/rwa/assets` (or `GET /api/assets`)
Returns paginated list of real-world assets registered on-chain with valuations, DAO status, and reserve allocations.
- **Query Parameters**:
  - `page` (number, default `1`): 1-based page number.
  - `limit` (number, default `20`, max `100`): Items per page.
  - `status` (string/number, optional): Filter by status (`Pending`, `Approved`, `Rejected`, `Suspended`, `Retired`, or `1`–`5`).
  - `assetClass` (string, optional): Filter by asset class name (e.g., `GEMSTONE`, `MINING_OUTPUT`, `GOLD`).
  - `owner` (string, optional): Filter by owner Ethereum address.
  - `sort` (string, default `desc`): Sorting direction (`desc` for newest first, `asc` for oldest first).

- **Sample Response**:
```json
{
  "success": true,
  "total": 1,
  "totalRegistered": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1,
  "statusCounts": {
    "total": 1,
    "pending": 0,
    "approved": 1,
    "rejected": 0,
    "suspended": 0,
    "retired": 0
  },
  "totalApprovedValue": {
    "raw": "1500000000000000000000000",
    "formatted": "1500000.0",
    "unit": "USD"
  },
  "assets": [
    {
      "id": 1,
      "assetClass": {
        "raw": "0x47454d53544f4e45000000000000000000000000000000000000000000000000",
        "name": "GEMSTONE"
      },
      "externalRef": {
        "raw": "0x454d4552414c442d303031000000000000000000000000000000000000000000",
        "code": "EMERALD-001"
      },
      "documentHash": "0x9a8b...",
      "valuation": {
        "raw": "1500000000000000000000000",
        "formatted": "1500000.0",
        "unit": "USD"
      },
      "status": {
        "code": 2,
        "name": "Approved"
      },
      "dates": {
        "valuedAt": 1700000000,
        "valuedAtIso": "2023-11-14T22:13:20.000Z",
        "registeredAt": 1690000000,
        "registeredAtIso": "2023-07-22T21:46:40.000Z",
        "updatedAt": 1700000500,
        "updatedAtIso": "2023-11-14T22:21:40.000Z"
      },
      "registrant": "0x1111111111111111111111111111111111111111",
      "owner": "0x2222222222222222222222222222222222222222",
      "tokenURI": "ipfs://bafybeig...",
      "reserves": {
        "allocatedBps": 5000,
        "allocatedPercent": "50.00%",
        "reserveValue": {
          "raw": "750000000000000000000000",
          "formatted": "750000.0",
          "unit": "USD"
        },
        "pools": [1, 2]
      }
    }
  ]
}
```

#### `GET /api/rwa/assets/:id` (or `GET /api/assets/:id`)
Inspects a specific RWA asset by numeric ID.
- Returns `404 Not Found` if asset ID does not exist or status is `None`.
- Returns `400 Bad Request` if asset ID is not a positive integer.

#### `GET /api/rwa/assets/ref/:ref` (or `GET /api/assets/ref/:ref`)
Query an asset by unique external certificate / reference code.

#### `GET /api/rwa/summary` (or `GET /api/assets/summary`)
Returns aggregated summary metrics: total assets, total approved USD valuation, status breakdown, pause status, and reserve hook.

---

### Settlement API

#### `GET /api/settlement/redemptions`
Lists on-chain redemption requests with pagination.
- **Query Params**: `page` (default 1), `limit` (default 10).

#### `GET /api/settlement/redemptions/:id`
Inspects an on-chain redemption request by ID (1-based), returning holder, token amount, discount, oracle price, status name (`Pending`, `Approved`, `Settled`, `Rejected`, `Cancelled`), and eligibility diagnosis.

#### `GET /api/settlement/redemptions/:id/eligibility`
Pre-flight check before initiating settlement.
- **Response `200 OK`**:
```json
{
  "success": true,
  "requestId": "1",
  "eligible": true,
  "reason": "Redemption request is approved and ready for settlement",
  "status": { "code": 1, "name": "Approved" }
}
```

#### `POST /api/settlement/settle`
Submits `RedemptionModule.settle(requestId, settlementRef)` on-chain.
- **Authentication**: Requires header `x-api-key: <SETTLEMENT_API_KEY>` or `Authorization: Bearer <SETTLEMENT_API_KEY>`.
- **Request Body**:
```json
{
  "requestId": 1,
  "settlementRef": "0x4e65772d536574746c656d656e74000000000000000000000000000000000000",
  "idempotencyKey": "req-uuid-12345"
}
```
*Note: If `settlementRef` is omitted, the service generates a cryptographically secure 32-byte reference. If a plain string is supplied, it is hashed deterministically into `bytes32`.*

- **Response `200 OK`** (or `200 OK` on idempotent retry of already settled request):
```json
{
  "success": true,
  "message": "Redemption request settled successfully",
  "requestId": "1",
  "settlementRef": "0x4e65772d536574746c656d656e74000000000000000000000000000000000000",
  "transactionHash": "0x9a8b...",
  "blockNumber": 45,
  "chainId": 31337,
  "status": "CONFIRMED"
}
```
- **Error Codes**:
  - `400 Bad Request`: Request not in `Approved` state, contract paused, or signer lacking `SETTLER_ROLE`.
  - `404 Not Found`: Request ID does not exist on-chain.
  - `409 Conflict`: Concurrent settlement submission currently in-flight for this request ID.

#### `GET /api/settlement/history`
Query recorded settlement attempts and confirmations from the local database.
- **Query Params**: `status` (`CONFIRMED`, `PENDING`, `FAILED`, `MISMATCHED`), `page`, `limit`.

---

### Reconciliation API

#### `GET /api/reconciliation/status`
Returns reconciliation metrics: total recorded settlements, count of confirmed, pending, failed, and mismatched records, plus latest audited block.

#### `GET /api/reconciliation/records`
Returns detailed paginated settlement audit records.

#### `POST /api/reconciliation/reconcile`
Executes active reconciliation against on-chain transaction receipts and `RedemptionSettled` events.
- **Authentication**: Requires `x-api-key: <SETTLEMENT_API_KEY>`.
- **Request Body** (optional):
```json
{
  "fromBlock": 0,
  "toBlock": 100,
  "requestId": 1
}
```
- **Reconciliation Logic**:
  1. Scans on-chain `RedemptionSettled` events from `RedemptionModule`.
  2. Compares on-chain parameters (`redeemer`, `tokensBurned`, `usdcDisbursed`, `settlementRef`) against database records.
  3. Transitions unconfirmed local records to `CONFIRMED` if matching on-chain event exists.
  4. Flags discrepancies as `MISMATCHED` with detailed audit reason.

---

### Supply & Reserve Analytics

All analytics endpoints use BigInt math and return formatted decimal strings alongside raw base-unit strings. Floating-point math is avoided.

#### `GET /api/analytics/supply`
Returns supply metrics for `VittaStablecoin` (VGUSD, 18 decimals):
- `totalSupply`: Total minted VGUSD.
- `lockedSupply`: VGUSD locked in pending/approved redemption requests.
- `circulatingSupply`: `totalSupply - lockedSupply`.
- `debtCeiling`: Maximum permitted VGUSD debt ceiling from `CollateralController`.
- `maxMintable`: Remaining mintable VGUSD capacity.

#### `GET /api/analytics/reserves`
Returns reserve breakdown from `ReserveManager` and `CollateralController`:
- `totalReserveValue`: Total approved reserve asset value in USD (18 decimals).
- `reservedUSDC`: USDC reserved for approved redemptions (6 decimals).
- `unallocatedReserves`: Total reserve value minus reserved USDC.
- `pools`: Breakdown of approved reserve assets.

#### `GET /api/analytics/overview`
Comprehensive protocol health overview:
- `collateralRatio`: Protocol collateral ratio in basis points and percentage.
- **Zero-Supply Handling**: When `totalSupply == 0`, `CollateralController.collateralRatioBps()` returns `type(uint256).max`. The backend safely translates this to:
  ```json
  "collateralRatio": {
    "ratioBps": null,
    "ratioPercent": "N/A (zero supply)",
    "zeroSupply": true,
    "minRequiredBps": 10000,
    "isHealthy": true
  }
  ```

---

## Security & Operational Controls

1. **Signer Isolation**: The settlement key is exclusively used for `RedemptionModule.settle`. No private key is ever serialized, logged, or returned in API responses.
2. **Access Control**: Administrative write endpoints (`POST /api/settlement/settle`, `POST /api/reconciliation/reconcile`) require API key authentication (`SETTLEMENT_API_KEY`).
3. **No DAO Impersonation**: The backend does NOT expose endpoints to mint tokens, approve mints, or approve redemptions. Those operations remain strictly on-chain via DAO governance.
4. **Rate Limiting**:
   - General API: 300 requests / minute per IP.
   - Settlement and write endpoints: 30 requests / minute per IP.
5. **CORS Whitelisting**: Restricted to origins specified in `ALLOWED_ORIGINS`.
6. **Error Sanitization**: Centralized error middleware intercepts all unhandled errors and redacts 32-byte hex strings to prevent private key or signature leaks.
7. **Graceful Shutdown**: Intercepts `SIGINT` and `SIGTERM`, drains active HTTP connections, and closes SQLite database handles safely.

---

## Persistence & Database Migrations

- The database client (`src/db/database.js`) connects to SQLite at `DB_PATH`.
- On startup, `DatabaseClient.runMigrations()` automatically runs schema migrations tracked in a `schema_migrations` table.
- **Tables**:
  - `settlements`: Stores `id`, `request_id`, `idempotency_key`, `settlement_ref`, `status`, `redeemer`, `tokens_burned`, `usdc_disbursed`, `transaction_hash`, `block_number`, `chain_id`, `error_message`, `reconciled_at`.
- **Idempotency Guarantee**: Submissions are indexed by `request_id`, `settlement_ref`, and `idempotency_key`. Retrying a confirmed request returns the recorded receipt immediately without submitting a duplicate transaction.

---

## Running Tests

The test suite runs using Node.js built-in test runner (`node --test`), covering unit validation, auth guards, service mocks, database idempotency, and live Anvil contract integration:

```bash
# Run all tests
npm test
```

### Test Coverage Highlights:
- `test/unit/config.test.js`: Validates RPC URLs, addresses, private keys, and config sanitization.
- `test/unit/auth.test.js`: Verifies `x-api-key` and Bearer token enforcement.
- `test/unit/analytics.test.js`: Validates 18-decimal VGUSD, 6-decimal USDC, and zero-supply edge cases.
- `test/unit/settlement.test.js`: Tests eligibility logic, pause guards, and bytes32 reference formatting.
- `test/unit/reconciliation.test.js`: Tests mismatch detection against simulated on-chain events.
- `test/unit/services.test.js`: Validates SQLite CRUD, idempotency, and aggregation queries.
- `test/integration/api.test.js`: Validates Express endpoints and HTTP error mappings via Supertest.
- `test/integration/liveChain.test.js`: End-to-end lifecycle test against live Anvil (Mint -> Redeem -> Approve -> Settle -> Reconcile).

---

## Treasury Contract Limitations & Boundary

In the current Phase 2 protocol release:
- `RedemptionModule.settle` calls `ITreasury.releaseUSDC(redeemer, usdcAmount)` on-chain.
- The repository provides mock contracts (`MockTreasury.sol`) for testing, but the production Phase 1 Treasury contract and fiat banking rail integrations are not yet built.
- **Reconciliation Boundary**:
  - The backend successfully reconciles on-chain settlement: VGUSD burn verification, `RedemptionSettled` event emission, and the call to `releaseUSDC`.
  - External banking disbursements (fiat wire / off-chain custodial USDC transfers) **cannot** be reconciled until the production Treasury API / webhook specification is implemented.
