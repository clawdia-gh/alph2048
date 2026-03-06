# Alephium 2048 Tournament MVP

Minimal runnable MVP for a **solo 2048 ranked run** concept on Alephium.

## What this includes

1. **Single-player 2048 browser UI** (`ui/`) with keyboard controls.
2. **Wallet connect + Start Ranked Run flow**:
   - Connects to Alephium wallet extension if present, otherwise uses mock wallet id.
   - Creates `runId` locally, computes `runIdHash` + `seedHash` (SHA-256).
   - Stores run receipt metadata in `localStorage`.
3. **Backend verifier API** (`server/`) endpoint:
   - `POST /api/verify` accepts `{ runId, runIdHash?, wallet, seed, seedHash?, moves, score }`.
   - Replays run deterministically from `seed + moves`.
   - Validates score and returns mock attestation + `attestationHash` helper.
4. **Alephium contract schema (Phase 1+)** (`contracts/`):
   - `startRun(runIdHash, seedHash)`
   - `submitScore(runIdHash, score, attestationHash)`
   - Per-run receipt mapping (`mapping[ByteVec, RunReceipt]`) for true concurrent runs.
   - One-submit guard and ownership checks are enforced per receipt.
   - Run started/submitted events.
5. **Tests** for deterministic replay + duplicate submit guard logic.

## Ralph v1 storage/event schema (Phase 1)

`Contract Tournament2048` fields:

- Aggregate stats:
  - `totalRuns: U256`
  - `totalSubmissions: U256`
  - `leaderboardTopScore: U256`
  - `leaderboardTopPlayer: Address`
- Run receipts (concurrent-safe):
  - `mapping[ByteVec, RunReceipt] runs`
  - `RunReceipt { player, seedHash, startedAt, submitted, submittedScore, attestationHash }`

Events:

- `RunStarted(runIdHash, player, seedHash, startedAt, totalRuns)`
- `RunSubmitted(runIdHash, player, score, attestationHash, submittedAt, isNewTop)`

## Data flow (current MVP)

1. UI starts run:
   - Generate `runId`.
   - Compute `runIdHash = sha256(runId)`, `seedHash = sha256(seed)`.
   - Prepare contract payload: `{ runIdHash, seedHash }`.
   - Executes real beta `startRun` tx with on-chain required entry fee (base 1 ALPH, growth 1.1x per start, and halved when a new #1 score is submitted).
2. Player completes run and submits:
   - UI sends verify request with moves + score + hashes.
3. Verifier replays and responds:
   - `valid`, `expectedScore`, `attestation`, `attestationHash`, `verifierKeyVersion`.
4. UI maps verifier response into contract payload:
   - `{ runIdHash, score, attestationHash }` for `submitScore`.
   - Contract call still mocked in UI until SDK wiring is added.

## Architecture (MVP)

- **Client (ui/main.js)**
  - Runs local 2048 game state.
  - Captures move log + score + seed.
  - Computes `runIdHash` and `seedHash`.
  - Builds contract-aligned `startRun`/`submitScore` payloads.

- **Verifier (server/index.js + game2048.js)**
  - Reconstructs game using deterministic RNG from `seed`.
  - Applies same move/merge/spawn rules.
  - Compares replayed score vs submitted score.
  - Emits mock attestation token and `attestationHash`.
  - Includes `verifierKeyVersion` with TODO hook for real key rotation.

- **Contract (contracts/Tournament2048.ral)**
  - Stores one active run receipt slot.
  - Enforces one-submit guard (`RunAlreadySubmitted`).
  - Updates top score and emits run lifecycle events.

## Run

```bash
npm install
npm run compile
npm run dev
```

This starts:
- UI: `http://localhost:4173`
- Verifier API: `http://localhost:8787`

Or run separately:

```bash
npm run dev:server
npm run dev:ui
```

## Verify API example

```bash
curl -s http://localhost:8787/api/verify \
  -H 'content-type: application/json' \
  -d '{"runId":"demo","wallet":"mock","seed":"abc","runStartedAt":"2026-03-05T12:00:00.000Z","moves":["left","up"],"moveTimingsMs":[120,180],"moveChunks":[{"index":0,"startMove":0,"endMove":1,"moveCount":2,"movesHash":"0x...","prevChunkHash":"0x0","chunkHash":"0x..."}],"score":0}' | jq
```

## Anti-Assist v1 (beta)

Verifier and client now enforce:

- **Run TTL = 180s** (`RUN_TTL_MS`, default `180000`).
- **Chunked move commits every 5 moves** (`MOVE_CHUNK_SIZE`, default `5`):
  - Client sends `moveChunks[]` with chained hashes.
  - Verifier recomputes and validates chunk continuity + integrity.
  - MVP-only: chunk proofs are verified off-chain (no chunk tx submit yet).
- **Timing envelope checks**:
  - Reject unrealistically fast runs (`MIN_RUN_DURATION_MS=2500`, `MIN_AVG_MOVE_MS=35`).
  - Reject suspiciously uniform move timings (`UNIFORM_CHECK_MIN_MOVES=20`, `MIN_TIMING_VARIANCE_MS=8`).
- **Wallet cooldown before new ranked run**:
  - `POST /api/run/start` gate enforces `WALLET_COOLDOWN_MS` (default `20000`).
  - Returns `WALLET_COOLDOWN_ACTIVE` + `retryAfterMs` on rejection.

## Inspiration & Attribution

This project is inspired by the original **2048** puzzle game by **Gabriele Cirulli**.
ALPH 2048 Arena is an independent adaptation that adds Alephium-based tournament features, including on-chain run submission, pot mechanics, and ranked leaderboard flow.

## Notes / limitations

- On-chain receipt tracking now uses a **per-run map receipt** model (sub-contract backed entries).
- Anti-assist checks are verifier-side; on-chain remains minimal in MVP.
- Mock attestation only (not cryptographic signing).
- Verifier key versioning is scaffolded with TODO hooks.

## Beta economics (locked)

- Base entry: **1 ALPH**
- Entry growth: **1.1x** each new round
- Inactivity reset window: **24h**
- New top-score payout split: **50% payout / 50% carry**
- No hard cap

## Testnet beta deployment (current)

- Contract ID: `8154314aed27b9ed55d44ebd637bc93bc18f05e26a609e9b68d4f71004a8a402`
- Contract address: `23PoAamM7npfobyFLsoDcBaaZ2EvhV8LnKJVU3sdJdj7F`
- Deploy tx: `537d1c7a894a306be55dd0fda92a33ab8bd0a3b0f8c1343dad8f0ff09be33944`
- Smoke startRun tx: `2622215599bac145b485f1d7c834d45b122a31192c9b0cac94caa9b874aaddc1`
- Smoke submitScore tx: `a05b0111a8deee1685e7a72ed1f1a0f21374e276b225d863e6b9b0cc0b773c28`
- Beta URL: `https://alph2048daily.aigames.alehpium.org`
- Beta health: `https://alph2048daily.aigames.alehpium.org/api/health`

## Quick binding safety check (beta)

After deploy/rebind, run:

```bash
npm run check:beta-health
```

This verifies:
- beta API is reachable,
- channel is `beta`,
- `/api/health` and `/api/economy` contractId match `contracts/beta-contract.json`.

## Beta hardening flags (rollback-friendly)

These controls are **beta-only by default** (auto-true when `GAME_CHANNEL=beta`, unless explicitly overridden):

- `BETA_LOCK_LEADERBOARD_RECORD`
  - Default: `true` on beta
  - Enforces one-time verify ticket on `POST /api/leaderboard/record`.
- `BETA_STRICT_VERIFY`
  - Default: `true` on beta
  - Enables strict payload/schema checks on `POST /api/verify`.
- `BETA_RATE_LIMIT`
  - Default: `true` on beta
  - Enables in-memory route throttling + rate-limit headers/metrics.

Optional tuning:

- `BETA_RATE_LIMIT_WINDOW_MS` (default `10000`)
- `BETA_RATE_LIMIT_VERIFY_MAX` (default `12`)
- `BETA_RATE_LIMIT_RECORD_MAX` (default `8`)
- `BETA_RATE_LIMIT_RUN_START_MAX` (default `10`)
- `VERIFY_TICKET_TTL_MS` (default `300000`)

Rollback path (beta only): set any hardening flag to `false` and restart only the beta service.

## Beta smoke checklist (post-deploy)

1. **Normal run flow still works**
   - Connect wallet → Start ranked run → play → Verify + Submit.
   - Expect on-chain submit tx + leaderboard update.
2. **Malformed verify payload is rejected**
   - Example: missing `runId` or invalid `moves` values.
   - Expect `400` with `errorCode` (for example `RUN_ID_INVALID`, `MOVES_INVALID`).
3. **Rapid/replay calls are throttled/rejected**
   - Burst `POST /api/verify` or reuse consumed verify ticket on `/api/leaderboard/record`.
   - Expect `429 RATE_LIMITED` (throttle) and/or `403 VERIFY_TICKET_*` (replay protection).
