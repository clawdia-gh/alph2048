# ALPH 2048 Arena — UI/Graphics Plan v2 (Research Loop #2, Implementation-Ready)

> Scope: UX/UI + graphics + interaction specifications only. No code changes in this document.
> Product intent: make the game feel competitive, trustworthy, and mobile-native while preserving low latency and chain trust.

---

## 1) Design Principles (Decision Filters)

1. **Board first**: the board, score, and run state must be visible immediately on mobile.
2. **Trust without overload**: chain/anti-assist confidence should be obvious in plain language, with technical details available on demand.
3. **Fast by default**: visuals must not degrade move latency or frame stability.
4. **Accessible parity**: keyboard/touch/screen-reader paths are first-class, not fallback.
5. **Progressive richness**: baseline works without motion; enhancements layer on capable devices.

---

## 2) Prioritized Backlog (MoSCoW + Effort)

Effort scale:
- **S** = ~0.5–1.5 dev days
- **M** = ~2–4 dev days
- **L** = ~5–8 dev days

### Must (ship in core redesign)

| ID | Item | Why | Effort |
|---|---|---|---|
| M1 | Board-first responsive layout (sticky top status + visible board/score/CTA above fold on 360–430px) | Core usability and conversion to play | M |
| M2 | Componentized status chips (wallet, contract/network, run state, anti-assist state) with semantic color+icon+text | Trust clarity + reduced cognitive load | M |
| M3 | Tile system spec implementation (distinct 2→4096+, spacing, typography by tile digits/value) | Core gameplay readability | M |
| M4 | Action controls state machine (Start/Submit/Reset disabled + loading + success/error feedback) | Prevent mis-clicks and confusion | M |
| M5 | Motion baseline with exact timings/easing + reduced-motion alternative | Perceived quality + accessibility compliance | S |
| M6 | Accessibility baseline checklist pass (contrast, focus, ARIA live, labels, keyboard parity) | Legal/quality baseline | M |
| M7 | Performance budget instrumentation (LCP/JS/FPS/memory) + CI/manual guardrails | Prevent regressions from visual work | M |
| M8 | Wallet-connect instability risk handling UX (retry/reconnect/cached intent) | High-frequency failure path | M |

### Should (next release after core)

| ID | Item | Why | Effort |
|---|---|---|---|
| S1 | Collapsible “Technical details” with copy tx hash/payload | Advanced users/support workflows | S |
| S2 | TTL urgency visual ladder (>60 normal, 20–60 warning, <20 critical) | Submission success rate | S |
| S3 | Sticky mobile bottom action strip with safe-area handling | Better one-hand operation | S |
| S4 | High-contrast theme toggle | Accessibility enhancement | M |
| S5 | Onboarding microcopy (“How ranked runs work” 3 steps) | New-user activation | S |

### Could (if capacity remains)

| ID | Item | Why | Effort |
|---|---|---|---|
| C1 | Lightweight haptic hints (mobile, optional) on merge/submit success | Delight/feedback | S |
| C2 | Session-best and percentile badge | Competitive engagement | S |
| C3 | Theme accents by network (beta/mainnet) | Environment clarity | S |
| C4 | Skeleton placeholders for chain stats on load | Perceived responsiveness | S |

### Won’t now (explicitly deferred)

| ID | Item | Reason for deferral |
|---|---|---|
| W1 | 3D tile rendering / WebGL effects | Too costly for budget + FPS risk |
| W2 | Heavy particle/confetti systems | Performance and distraction risk |
| W3 | Full redesign of game rules/economy UI flows | Out of graphics/styling scope |
| W4 | Multi-language localization framework | Valuable but not blocking MVP polish |

---

## 3) Component-Level Design Specs

## 3.1 Board + Tile System

### Board container
- Grid: **4×4**
- Corner radius: **14px** desktop/tablet, **12px** mobile
- Board padding:
  - Mobile: **10px**
  - Tablet/Desktop: **12px**
- Cell gap:
  - Mobile: **8px**
  - Tablet/Desktop: **10px**
- Surface: neutral dark with subtle inset for contrast against tiles.

### Sizing model (board scales by viewport)
- Use `--board-size = clamp(280px, 82vw, 520px)`
- Tile side calculation: `(board-size - board-padding*2 - gap*3) / 4`
- Target effective tile side:
  - 360px viewport: ~60–64px
  - 390px viewport: ~67–71px
  - 768px viewport: ~110–118px

### Tile palette (value-distinct)
- 2: `#eee4da`
- 4: `#ede0c8`
- 8: `#f2b179`
- 16: `#f59563`
- 32: `#f67c5f`
- 64: `#f65e3b`
- 128: `#edcf72`
- 256: `#edcc61`
- 512: `#edc850`
- 1024: `#edc53f`
- 2048: `#edc22e`
- 4096+: shift hue slightly cooler/gold-violet accent (distinct from 2048) to preserve scanability.

### Typography rules by value/digits
- Font weight: **700** for all tile numerals
- Use tabular numerals where available
- Font size by digit count (adjust with board size multiplier):
  - 1–2 digits (2..64): **0.42 × tile-side**
  - 3 digits (128..512): **0.34 × tile-side**
  - 4 digits (1024..4096): **0.28 × tile-side**
  - 5+ digits: **0.23 × tile-side** (with letter-spacing `-0.02em`)
- Minimum readable size floor: **16px**
- Text color switch:
  - Light tiles (2,4): dark text `#776e65`
  - Mid/high luminance drop: near-white text `#f9f6f2`

### Tile elevation
- Rest: subtle outer shadow (1 layer)
- Merge emphasis: temporary shadow increase for 120ms
- Avoid multi-layer heavy blurs.

## 3.2 HUD / Status Chips

Chip baseline:
- Height: **32px** (mobile), **34px** (desktop)
- Padding: `0 10px`
- Radius: `999px`
- Icon: 14–16px + text 12–13px medium
- Gap between chips: 8px

Required chips:
1. **Wallet chip**
   - States: `Disconnected` / `Connecting…` / `Connected 0x12…89ab` / `Mismatch`
   - Colors: neutral / info / success / danger
   - Action affordance on mismatch/disconnected (tap -> connect flow)

2. **Contract/Network chip**
   - States: `Contract ready` / `Network wrong` / `Syncing`
   - Include network name (Beta/Testnet/Mainnet)

3. **Run state chip**
   - States: `Not started` / `Running` / `Expired` / `Verified` / `Submitted` / `Rejected`
   - Most prominent chip in HUD row

4. **Anti-assist chip**
   - States: `Guard idle` / `Tracking` / `Attested` / `Verification failed`
   - Includes short hint on failure with link to details

Behavior:
- Status text must be plain-language first; technical IDs only in expanded details.

## 3.3 Action Controls (Start / Submit / Reset)

### Layout
- Mobile: full-width primary button + secondary below or adjacent if width allows
- Desktop: inline row with consistent heights
- Button min size: **48px height**, min touch width **48px**

### Control states
1. **Start Ranked Run**
   - Enabled when wallet connected + correct network + no active run
   - Disabled label variants:
     - `Connect wallet to start`
     - `Switch network to start`
     - `Run already active`
   - Loading: `Starting…` with spinner
   - Success microcopy: `Run started. Timer active.`

2. **Verify & Submit**
   - Disabled until run eligible + attestation ready
   - Disabled label examples:
     - `Finish run to submit`
     - `Attestation in progress`
     - `Run expired`
   - Loading: `Submitting…`
   - Success: `Submitted on-chain`

3. **Reset / New Run**
   - Disabled during pending tx or active submission
   - Confirmation required only if active run data will be lost

### Error treatment
- Inline actionable errors under button group, max 2 lines visible
- Provide `Try again` and `View details` for chain-related failures.

---

## 4) Motion Specification

### Core timings and easing
- Tile move: **110ms** `cubic-bezier(0.2, 0.8, 0.2, 1)`
- Tile merge pop: **140ms** `cubic-bezier(0.34, 1.56, 0.64, 1)`
- New tile spawn: **120ms** `cubic-bezier(0.2, 0.9, 0.3, 1)`
- Chip/status transition: **160ms** `ease-out`
- Button hover/press: **90ms** `ease-out`
- Panel expand/collapse: **180ms** `ease-in-out`

### Rules
- Animate only transform/opacity where possible.
- Max concurrent animated properties per frame per tile: 2 (transform + opacity).
- No layout-driven animation of width/height for frequently changing game elements.

### Reduced motion (`prefers-reduced-motion: reduce`)
- Disable translate/scale animations on tiles.
- Replace with instant position updates + **80ms opacity fade** for spawn/merge feedback.
- Remove pulsing urgency effects; use static icon/text emphasis.

---

## 5) Responsive Breakpoints + Mobile Interaction

### Breakpoints
- **xs:** 320–359
- **sm:** 360–479 (primary mobile target)
- **md:** 480–767 (large mobile / small tablet)
- **lg:** 768–1023 (tablet)
- **xl:** 1024+ (desktop)

### Layout behavior by range
- xs/sm:
  - Sticky top HUD
  - Board centered, CTA near thumb zone bottom
  - Secondary stats collapsed by default
- md:
  - Board + compact side stats if space allows
- lg/xl:
  - Two-column: board primary, status/details secondary

### Thumb-zone and touch spec
- Primary interaction targets placed in lower-middle/lower-right reachable zone on right-hand use.
- Minimum touch target: **48×48px** (hard minimum 44×44)
- Vertical spacing between tappables: **>=8px**
- Swipe dead-zone top reserved for page scroll prevention around board edges:
  - 12px internal padding before gesture capture
- Keep essential controls within **safe-area insets** (`env(safe-area-inset-*)`).

---

## 6) Accessibility Checklist (Ship Gate)

### Visual & contrast
- [ ] Body text contrast >= **4.5:1**
- [ ] Large text/UI text >= **3:1** where allowed
- [ ] Tile numeral contrast passes AA for each tile color pairing
- [ ] State is never color-only (icon/text included)

### Focus & keyboard
- [ ] Visible focus ring on all interactive controls (minimum 2px outline, contrast >=3:1)
- [ ] Logical tab order: header chips/actions -> board controls -> details
- [ ] Keyboard equivalents for movement and actions remain functional

### Semantics & ARIA
- [ ] Score announced via polite live region (non-spammy throttling)
- [ ] Run status updates via `aria-live="polite"`; errors via assertive region if blocking
- [ ] Directional controls have explicit labels (`Move up/down/left/right`)
- [ ] Buttons expose disabled reasons via `aria-describedby`

### Screen-reader copy (recommended strings)
- Run start success: “Ranked run started. Timer is active.”
- Submit ready: “Run verified. Submit is now available.”
- Submit success: “Score submitted on chain.”
- Wallet mismatch: “Connected wallet differs from run wallet. Reconnect original wallet to submit.”

### Motion and cognitive load
- [ ] Reduced-motion path implemented and verified
- [ ] Technical payload hidden by default behind disclosure

---

## 7) Performance Budget + Monitoring

### Budgets (mid-tier mobile baseline)
- **LCP**: <= **2.0s** p75 on 4G (target 1.8s)
- **INP** (interaction responsiveness): <= **200ms** p75 (move input target visual <=50ms median)
- **JS payload** (initial, gzip): <= **170KB** app JS; visual redesign increment <= **60KB**
- **CSS payload** (gzip): <= **45KB** total
- **Animation FPS**: >= **55 FPS** during active moves (95th percentile frames)
- **Main-thread long tasks**: < **2** tasks >50ms during first interaction window
- **Memory cap**: <= **120MB** tab resident on mid-tier mobile during 10-minute session

### Monitoring hints
- Use Lighthouse CI or Web Vitals logging for LCP/INP/CLS trend checks.
- Add lightweight runtime counters for:
  - move-to-render latency
  - dropped frame bursts during merges
  - wallet-connect retries/failures
- Capture anonymized event funnel:
  - `start_click` -> `run_started`
  - `submit_click` -> `submit_success|submit_error`
- Gate releases when any two core metrics regress >10% vs prior stable.

---

## 8) Rollout Plan (Phased) + Acceptance Tests + Rollback Criteria

## Phase 1 — Structure & State Clarity (Must)
Scope: layout hierarchy, chip system, CTA state model.

Acceptance tests:
1. On 360×800, board + score + primary CTA visible without scroll.
2. Wallet/network/run states readable in <2 seconds by first-time tester.
3. Disabled buttons always show reason text.

Rollback criteria:
- >5% drop in run-start conversion OR repeated user confusion on run state in usability spot checks.

## Phase 2 — Tile System + Motion (Must)
Scope: value-distinct tiles, typography scaling, timing/easing set, reduced-motion.

Acceptance tests:
1. Testers distinguish 128/256/512/1024/2048 in 1-second glance test.
2. No layout shift caused by tile animations.
3. Reduced-motion setting removes translate/scale while preserving clear feedback.

Rollback criteria:
- FPS drops below 50 on target devices OR move latency p95 worsens >15%.

## Phase 3 — Accessibility + Performance Hardening (Must)
Scope: full checklist closure, instrumentation, budget verification.

Acceptance tests:
1. Keyboard-only path can start, play, and submit.
2. Screen reader announces critical states correctly.
3. Performance budgets met on 2 representative mobile devices.

Rollback criteria:
- Accessibility blockers (focus trap, unlabeled controls) OR LCP/INP budget breach in production canary.

## Phase 4 — Trust UX Enhancements (Should)
Scope: technical details disclosure, TTL urgency, microcopy tuning.

Acceptance tests:
1. Users can explain submission failure and next step without dev help.
2. Support tickets for “why submit failed” decrease from prior release baseline.

Rollback criteria:
- Increase in failed submits due to UX confusion OR higher abandonment at submit stage.

---

## 9) Known Risks (Wallet-Connect UX Instability) + Mitigations

### Risk R1: Provider handshake stalls or times out
- Symptoms: endless “Connecting…”, no error surfaced.
- Mitigation:
  - 8–10s timeout with clear fallback message.
  - Show `Retry` + `Switch wallet provider` actions.
  - Preserve intended action (start/submit) and auto-resume after successful connect.

### Risk R2: Account/network changes mid-run
- Symptoms: mismatch between run wallet and active wallet; submit blocked.
- Mitigation:
  - Persistent mismatch chip + plain-language fix.
  - One-tap “Reconnect original wallet” flow when possible.
  - Non-destructive state retention until user confirms reset.

### Risk R3: RPC latency/spikes cause stale status
- Symptoms: user sees outdated run/tx status and retries unnecessarily.
- Mitigation:
  - Surface “last updated Xs ago”.
  - Backoff polling + manual refresh option.
  - Optimistic interim state labels (`Pending confirmation…`).

### Risk R4: Double-submit or duplicate clicks during pending tx
- Symptoms: accidental repeat actions, inconsistent feedback.
- Mitigation:
  - Hard-disable submit while pending.
  - Idempotency guard on UI action path.
  - Single source-of-truth pending banner.

### Risk R5: Mobile deep-link return failures after wallet app switch
- Symptoms: user returns to game with lost context.
- Mitigation:
  - Cache run intent and pre-submit state in session storage.
  - On return, restore context and present “Continue where you left off”.
  - Provide manual reconnect shortcut if auto-reconnect fails.

---

## 10) Final Implementation Priorities (Execution Order)

1. **M1 + M2 + M4** (layout, chips, action states)
2. **M3 + M5** (tile readability + motion/reduced motion)
3. **M6 + M7** (a11y and performance gate)
4. **M8 + Should items** (wallet-resilience polish, trust UX depth)

This order maximizes immediate user-perceived quality while reducing breakage risk on critical play/submit flows.