# ALPH 2048 Arena Beta — Complete UX Recommendations

## 0) Product context and UX goals
ALPH 2048 Arena combines a familiar puzzle loop with a high-friction trust flow (wallet, on-chain start, verifier, on-chain submit, anti-assist, timer pressure). The UX should optimize for:

1. **Clarity under pressure** (5-minute run + submit)
2. **Trust transparency** (what is local vs on-chain)
3. **Fast task completion** (start run, play, submit with minimal confusion)
4. **Mobile ergonomics** (thumb-friendly, low scroll, safe-area aware)
5. **Error recovery** (wallet mismatch, stale fee, verify rejects, chain failures)

---

## 1) Prioritized improvements (15 total), grouped by impact/effort

### A. High impact / Low effort (do first)
1. **Replace generic run text with stage-based status labels**  
   - Use explicit states: `Not started`, `Starting on-chain`, `Run live`, `Time up`, `Verifying`, `Submitting`, `Submitted`, `Submit failed`.
2. **Add "what to do next" line under every blocking state**  
   - Example: wallet mismatch should always show one-step fix.
3. **Promote remaining time to a persistent timer chip while run is live**  
   - Not only banner at low TTL; keep always visible to reduce surprise expiration.
4. **Turn Verify result panel into collapsible "Technical details"**  
   - Default collapsed for regular players; expandable for power users and support.
5. **Add submit eligibility helper text**  
   - "Submit unlocks when game ends or time expires" (removes ambiguity during live run).

### B. High impact / Medium effort
6. **Introduce a visible run journey strip (Step 1→5)**  
   - `Connect → Start tx → Play → Verify → Submit tx`; highlight current step.
7. **Create a deterministic CTA hierarchy (single primary action at all times)**  
   - Never show users two competing primary actions.
8. **Improve fee volatility handling with proactive copy + refresh affordance**  
   - If start fails due to fee update, show refreshed fee + one-tap retry explanation.
9. **Implement dedicated error state cards by errorCode family**  
   - `WALLET_COOLDOWN_ACTIVE`, `RUN_NOT_OWNED_BY_CALLER`, `RUN_ALREADY_SUBMITTED`, verifier timing/chunk errors.
10. **Add post-submit summary card with tx links + rank movement**  
   - Immediate confirmation: score, rank, tx id, and “start next run” CTA.

### C. Medium impact / Low effort
11. **Standardize chip tones and iconography**  
   - Same semantic mapping everywhere: neutral/info/success/warn/error.
12. **Improve wallet identity readability**  
   - Show shortened address consistently and provide copy action in details.
13. **Refine leaderboard row density and timestamp formatting**  
   - Use relative time (`2m ago`) on mobile; full timestamp in details.

### D. Medium impact / Medium effort
14. **Add inline recovery actions in failure states**  
   - e.g., buttons: `Reconnect wallet`, `Retry verify`, `Retry submit`, `Start new run`.
15. **Create a "Continue previous run" restore check on reload/tab return**  
   - If run is active and not submitted, restore context and show precise next action.

---

## 2) Wire-level interaction recommendations by phase

## A) Pre-connect (before wallet is connected)
**Primary objective:** Convert user from visitor to connected wallet with confidence.

**Layout (top→bottom):**
- Hero + short value proposition
- Rules (collapsed by default on mobile; first 2 rules visible)
- Status chips (`Wallet: disconnected`, `Contract: syncing/ready`)
- Score row (disabled state)
- Board with overlay CTA: `Connect Wallet`
- Optional “How ranked runs work (3 steps)”

**Interaction rules:**
- Any move input should show non-blocking toast: “Connect wallet + start run to play ranked.”
- CTA click triggers connection flow and visual state `Connecting…` with timeout fallback.
- If no extension detected, show clear fallback state and link/help text.

---

## B) Pre-start (wallet connected, no active run)
**Primary objective:** Start ranked run on-chain without confusion.

**Layout adjustments:**
- Wallet chip becomes success tone with shortened address
- Contract chip must explicitly show environment (`Testnet Beta`)
- Primary board overlay CTA: `Start Ranked Run`
- Subcopy under CTA: live entry fee + “can change if another run starts first”

**Interaction rules:**
- On click: lock CTA, show `Starting on-chain…`
- If success: transition immediately to `Run live` state and hide non-essential instructions
- If stale-fee error: keep user in same screen with updated fee and one-tap retry
- If cooldown active: show countdown + disable start until eligible

---

## C) In-run (active gameplay)
**Primary objective:** Keep play fast, status obvious, and submit readiness clear.

**Layout behavior:**
- Always-on timer chip: `Time left 04:31`
- Run chip: `Run live`
- Guard chip: `Tracking`
- Start overlay hidden; board fully interactive
- Sticky mini status row on mobile (timer + score + run state)

**Interaction rules:**
- Moves are immediate; no status panel shifts during play
- TTL warning ladder:
  - >60s: neutral
  - 20–60s: warning tone
  - <20s: critical tone + concise urgency copy
- `Verify + Submit` remains unavailable until terminal condition (game over or timeout)

---

## D) Timeout state (TTL reached)
**Primary objective:** Prevent panic; explain that moves are locked but submit remains available.

**Layout behavior:**
- Board dims or input-lock overlay appears
- Primary CTA switches to `Verify + Submit`
- Warning card: “Time is up. Your board is locked. You can still submit this score.”

**Interaction rules:**
- Arrow keys/swipes should no-op with clear inline feedback (not silent failure)
- One primary action only: verify + submit
- Secondary action (if needed): “Start new run (discard)” with confirmation

---

## E) End-of-run submit (manual game-over or timeout)
**Primary objective:** Move through verify + chain submit with zero ambiguity.

**Layout behavior:**
- Step strip highlights `Verifying` then `Submitting`
- Primary CTA disabled during async operations
- Details accordion contains payload hashes/tx data for advanced users

**Interaction rules:**
- On verify request start: label `Verifying run…`
- On verify success + submit start: `Verified. Submitting on-chain…`
- Prevent duplicate submits via hard lock until completion/failure

---

## F) Submit success
**Primary objective:** Reward + trust confirmation + re-engagement.

**Layout behavior:**
- Success card with:
  - Submitted score
  - Rank result (`#1`, `#7`, etc.)
  - Tx link/button
  - Next CTA: `Start New Ranked Run`
- Optional celebration style only if new high score

**Interaction rules:**
- Auto-refresh leaderboard and highlight user row briefly
- Preserve technical details in expandable section (do not flood default UI)

---

## G) Submit failure
**Primary objective:** Explain cause, offer immediate recovery path.

**Layout behavior:**
- Error card with severity icon, plain-language diagnosis, and exact next action
- Recovery buttons mapped to failure type

**Interaction rules (examples):**
- Wallet mismatch → `Reconnect original wallet`
- Duplicate submit → `This run already finalized` + `Start new run`
- Verify reject (timing/chunk) → `Run could not be verified` + `Start new run`
- RPC/network issue → `Retry submit`

---

## 3) Concrete microcopy suggestions

## Core CTAs
- `Connect Wallet`
- `Starting on-chain…`
- `Start Ranked Run`
- `Verify + Submit`
- `Verifying run…`
- `Submitting on-chain…`
- `Start New Ranked Run`

## Chip/status copy
- Wallet disconnected: `Wallet: disconnected`
- Wallet connected: `Wallet: 23ab…9f1c`
- Contract ready: `Contract: Testnet ready`
- Contract syncing: `Contract: syncing`
- Run idle: `Run: not started`
- Run live: `Run: live`
- Run expired: `Run: time up`
- Guard idle: `Guard: idle`
- Guard tracking: `Guard: tracking`

## Helper and urgency copy
- Pre-start fee note: `Entry fee is live and may change before confirmation.`
- Submit eligibility: `Submit unlocks when your run ends or the timer expires.`
- 60s warning: `Less than 1 minute left.`
- 20s warning: `Final seconds — finish and submit now.`
- Timeout: `Time is up. Your board is locked, but this score can still be submitted.`

## Failure copy by case
- Cooldown: `You recently started a run. Try again in {N}s.`
- Fee changed: `Entry fee updated before confirmation. Review the new fee and retry.`
- Wallet mismatch: `This run was started with a different wallet. Reconnect that wallet to submit.`
- Run not found/mismatch: `Run receipt not found for this wallet/session. Start a new ranked run.`
- Already submitted: `This run has already been submitted.`
- Verify rejected: `Run verification failed. This score can’t be submitted.`
- Network/RPC: `Network issue while submitting. You can retry now.`

## Success copy
- Standard: `Score submitted on-chain.`
- Rank update: `Submitted! Your current rank is #{rank}.`
- New top: `🏆 New top score! You’re now #1.`

---

## 4) Mobile-specific UX notes
1. **Board-first viewport contract:** on 360×800, keep score + timer + board + primary CTA visible above fold.
2. **Sticky compact top bar during run:** wallet condensed, timer prominent, run state badge.
3. **Primary action in thumb zone:** fixed or sticky near bottom with safe-area padding.
4. **Touch target minimums:** 48×48 for directional controls and key actions.
5. **Reduce vertical clutter:** collapse technical/read-only metrics behind accordion on mobile.
6. **Prevent accidental page scroll while swiping board:** maintain controlled touch-action behavior.
7. **Low-latency feedback:** tactile visual response on tap/swipe; avoid heavy animation.
8. **Typography resilience:** no overflow for long hashes/addresses; wrap only in details panel.
9. **Connection-return resilience:** after wallet app switch, restore pending action context.
10. **Battery/perf mode:** reduce motion automatically on low-power signals if available.

---

## 5) <2-hour quick-win patch list

These are tactical patches with high immediate UX return and minimal engineering risk.

1. **Collapse `#verifyResult` behind a “Technical details” disclosure** (default closed).  
   _ETA: 20–30 min_
2. **Add persistent timer text to run chip during live runs** (not only low-time banner).  
   _ETA: 15–25 min_
3. **Standardize runStatus copy into fixed stage phrases** for start/verify/submit/fail.  
   _ETA: 30–45 min_
4. **Show one-line submit eligibility hint under score row** when run is active.  
   _ETA: 15–20 min_
5. **Add inline wallet mismatch recovery button label near submit failure state** (even if it routes to existing connect).  
   _ETA: 20–30 min_
6. **Use relative times in recent submissions list on mobile** (e.g., `2m ago`).  
   _ETA: 20–30 min_
7. **Add explicit disabled reason text near primary CTA** (connect/network/cooldown/pending).  
   _ETA: 30–45 min_
8. **Unify error headline format**: `Action failed: {plain reason}` for all async failures.  
   _ETA: 20–30 min_

If only one mini-batch is possible, ship patches **1 + 2 + 3 + 4** first.

---

## Final implementation order recommendation
1. Ship quick wins (<2h patch list, first 4 items)
2. Build the phase wire-state flow and step strip
3. Add structured error cards + recovery actions
4. Optimize mobile sticky action/status behavior
5. Tune celebratory/post-submit UX and retention loops
