let chainClient = {
  connectExtensionWallet: async () => null,
  startRunTx: async () => {
    throw new Error('CHAIN_CLIENT_UNAVAILABLE')
  },
  submitScoreTx: async () => {
    throw new Error('CHAIN_CLIENT_UNAVAILABLE')
  },
  readTournamentState: async () => null
}

async function ensureChainClient() {
  try {
    const mod = await import('./chain-client.js')
    if (mod) chainClient = { ...chainClient, ...mod }
  } catch {
    // Keep fallback so game remains playable even if chain module fails to load.
  }
}

function normalizeAccount(raw) {
  if (!raw) return null
  if (typeof raw === 'string') return { address: raw }
  if (Array.isArray(raw)) {
    const first = raw[0]
    if (!first) return null
    if (typeof first === 'string') return { address: first }
    if (first?.address) return { address: first.address }
  }
  if (raw?.address) return { address: raw.address }
  if (raw?.account?.address) return { address: raw.account.address }
  return null
}

async function connectInjectedAlephium() {
  const w = window
  const candidates = [
    w?.alephium,
    w?.alephiumProvider,
    w?.alephiumProviders?.alephium,
    w?.alephiumProviders?.default,
    w?.alephiumProviders?.[0],
    w?.web3?.alephium
  ].filter(Boolean)

  for (const provider of candidates) {
    try {
      if (typeof provider.enableIfConnected === 'function') {
        const account = normalizeAccount(await provider.enableIfConnected())
        if (account?.address) return { wallet: provider, account }
      }

      if (typeof provider.enable === 'function') {
        const account = normalizeAccount(await provider.enable())
        if (account?.address) return { wallet: provider, account }
      }

      if (typeof provider.unsafeEnable === 'function') {
        const account = normalizeAccount(await provider.unsafeEnable())
        if (account?.address) return { wallet: provider, account }
      }

      if (typeof provider.connect === 'function') {
        const account = normalizeAccount(await provider.connect())
        if (account?.address) return { wallet: provider, account }
      }

      if (typeof provider.request === 'function') {
        const methods = ['alph_requestAccounts', 'requestAccounts', 'eth_requestAccounts']
        for (const method of methods) {
          try {
            const account = normalizeAccount(await provider.request({ method }))
            if (account?.address) return { wallet: provider, account }
          } catch {
            // try next method
          }
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

const boardEl = document.getElementById('board');
const scoreEl = document.getElementById('score');
const gameTimerEl = document.getElementById('gameTimer');
const walletStatusEl = document.getElementById('walletStatus');
const runStatusEl = document.getElementById('runStatus');
const walletControlEl = document.getElementById('walletControl');
const walletMenuEl = document.getElementById('walletMenu');
const walletChooserEl = document.getElementById('walletChooser');
const walletChooseExtensionEl = document.getElementById('walletChooseExtension');
const walletChooseDesktopEl = document.getElementById('walletChooseDesktop');
const walletChooseQrEl = document.getElementById('walletChooseQr');
const walletChooseCancelEl = document.getElementById('walletChooseCancel');
const verifyResultEl = document.getElementById('verifyResult');
const entryFeeEl = document.getElementById('entryFee');
const potEl = document.getElementById('pot');
const topScoreEl = document.getElementById('topScore');
const topHolderEl = document.getElementById('topHolder');
const resetCountdownEl = document.getElementById('resetCountdown');
const contractStatusEl = document.getElementById('contractStatus');
const runChipEl = document.getElementById('runChip');
const guardChipEl = document.getElementById('guardChip');
const highScoreBannerEl = document.getElementById('highScoreBanner');
const leaderboardEl = document.getElementById('leaderboard');
const recentSubmissionsEl = document.getElementById('recentSubmissions');
const rankChipEl = document.getElementById('rankChip');
const countdownBannerEl = document.getElementById('countdownBanner');
const startRunOverlayEl = document.getElementById('startRunOverlay');
const overlayReasonEl = document.getElementById('overlayReason');
const submitResultCardEl = document.getElementById('submitResultCard');
const RUN_DRAFT_KEY = 'alph2048:active-run-draft:v1';

const state = {
  board: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
  score: 0,
  seed: String(Date.now()),
  moves: [],
  moveTimingsMs: [],
  wallet: null,
  walletGroup: null,
  walletMenuOpen: false,
  runId: null,
  runIdHash: null,
  seedHash: null,
  runStartedAt: null,
  runStartedAtMs: null,
  lastMoveAtMs: null,
  moveChunks: [],
  antiAssist: { runTtlMs: 300000, moveChunkSize: 5, walletCooldownMs: 20000 },
  lastSubmitPayload: null,
  chainMeta: { channel: 'beta', contractId: 'BETA_CONTRACT_PENDING' },
  lastStartTxId: null,
  lastSubmitTxId: null,
  runOnChain: false,
  runWallet: null,
  chainState: null,
  myRank: null,
  bestRank: null,
  pendingEntryFeeRetry: false,
  startPending: false,
  submitPending: false,
  submitTimerFreezeMs: null,
  postSubmitLockUntilMs: 0,
  endRunRequested: false,
  justSubmitted: false,
  entryFeePaidAtto: null,
  chainDataLoaded: false
};

if (gameTimerEl) {
  const preStartMinutes = Math.floor(state.antiAssist.runTtlMs / 60000);
  const preStartSeconds = String(Math.floor((state.antiAssist.runTtlMs % 60000) / 1000)).padStart(2, '0');
  gameTimerEl.textContent = `${preStartMinutes}:${preStartSeconds}`;
}

function trace(stage, details = {}) {
  const payload = { stage, ts: new Date().toISOString(), ...details };
  try {
    verifyResultEl.textContent = JSON.stringify({ trace: payload }, null, 2);
  } catch {
    verifyResultEl.textContent = `[trace] ${stage}`;
  }
}

function friendlyError(errorCode, fallback = 'unknown error') {
  const map = {
    WALLET_COOLDOWN_ACTIVE: 'Cooldown active. Wait a few seconds, then start a new ranked run.',
    RATE_LIMITED: 'Too many rapid requests. Please slow down and retry.',
    VERIFY_FIELDS_REQUIRED: 'Run proof is incomplete. Reload and retry submit.',
    MOVE_TIMINGS_REQUIRED: 'Timing proof missing. Keep the tab open until submit.',
    TIMING_TOO_FAST: 'Run timing looked impossible. Play a normal-speed run and submit again.',
    TIMING_TOO_UNIFORM: 'Move timings looked bot-like. Vary your pacing and retry.',
    CHUNK_HASH_INVALID: 'Move-proof hash check failed. Restart a fresh ranked run.',
    CHUNK_CHAIN_BROKEN: 'Move-proof chain was broken. Restart and submit again.',
    VERIFY_TICKET_REQUIRED: 'Submission proof expired. Tap Verify + Submit again.',
    VERIFY_TICKET_ALREADY_USED: 'This proof was already used. Start a new run.',
    VERIFY_TICKET_MISMATCH: 'Submission proof did not match this run. Re-verify and retry.',
    RUN_NOT_OWNED_BY_CALLER: 'Use the same wallet that started this run.',
    RUN_NOT_VISIBLE_YET: 'Start tx is still propagating. Wait 3–5s and submit again.',
    RUN_ALREADY_SUBMITTED: 'This run has already been submitted.'
  };
  return map[errorCode] || fallback;
}

function saveRunDraft() {
  try {
    const draft = {
      board: state.board,
      score: state.score,
      seed: state.seed,
      moves: state.moves,
      moveTimingsMs: state.moveTimingsMs,
      moveChunks: state.moveChunks,
      wallet: state.wallet,
      walletGroup: state.walletGroup,
      runId: state.runId,
      runIdHash: state.runIdHash,
      seedHash: state.seedHash,
      runStartedAt: state.runStartedAt,
      runStartedAtMs: state.runStartedAtMs,
      lastMoveAtMs: state.lastMoveAtMs,
      runOnChain: state.runOnChain,
      runWallet: state.runWallet,
      endRunRequested: state.endRunRequested,
      entryFeePaidAtto: state.entryFeePaidAtto
    };
    localStorage.setItem(RUN_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // noop
  }
}

function restoreRunDraft() {
  try {
    const raw = localStorage.getItem(RUN_DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (!draft?.runId || !draft?.runStartedAtMs) return;
    Object.assign(state, {
      board: Array.isArray(draft.board) ? draft.board : state.board,
      score: Number.isFinite(draft.score) ? draft.score : state.score,
      seed: draft.seed || state.seed,
      moves: Array.isArray(draft.moves) ? draft.moves : [],
      moveTimingsMs: Array.isArray(draft.moveTimingsMs) ? draft.moveTimingsMs : [],
      moveChunks: Array.isArray(draft.moveChunks) ? draft.moveChunks : [],
      wallet: draft.wallet || state.wallet,
      walletGroup: Number.isInteger(draft.walletGroup) ? draft.walletGroup : null,
      runId: draft.runId,
      runIdHash: draft.runIdHash,
      seedHash: draft.seedHash,
      runStartedAt: draft.runStartedAt,
      runStartedAtMs: draft.runStartedAtMs,
      lastMoveAtMs: draft.lastMoveAtMs || draft.runStartedAtMs,
      runOnChain: Boolean(draft.runOnChain),
      runWallet: draft.runWallet || null,
      endRunRequested: Boolean(draft.endRunRequested),
      entryFeePaidAtto: draft.entryFeePaidAtto || null
    });
    runStatusEl.textContent = 'Recovered your in-progress run from this browser.';
  } catch {
    // noop
  }
}

function clearRunDraft() {
  try { localStorage.removeItem(RUN_DRAFT_KEY); } catch {}
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatGameTimer(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function ttlRemainingMs() {
  if (!state.runStartedAtMs) return state.antiAssist.runTtlMs;
  return state.antiAssist.runTtlMs - (Date.now() - state.runStartedAtMs);
}

function isRunExpired() {
  return Boolean(state.runId && state.runStartedAtMs && ttlRemainingMs() <= 0);
}

function isGameOver() {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = state.board[r][c];
      if (v === 0) return false;
      if (c < 3 && state.board[r][c + 1] === v) return false;
      if (r < 3 && state.board[r + 1][c] === v) return false;
    }
  }
  return true;
}

function setChip(el, text, tone = 'neutral') {
  if (!el) return;
  el.textContent = text;
  el.className = `chip chip-${tone}`;
}

function updateStatusChips() {
  if (state.wallet) {
    const short = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}`;
    const groupText = Number.isInteger(state.walletGroup) ? ` · g${state.walletGroup}` : ' · group unknown';
    setChip(walletStatusEl, `Wallet: ${short}${groupText}`, 'good');
  } else {
    setChip(walletStatusEl, 'Wallet: disconnected', 'neutral');
  }

  const ready = state.chainMeta.contractId && !state.chainMeta.contractId.includes('PENDING') && state.chainMeta.contractId !== 'unassigned';
  setChip(contractStatusEl, ready ? `Contract: ${state.chainMeta.channel || 'beta'} ready` : 'Contract: syncing', ready ? 'good' : 'warn');

  if (!state.runId) {
    setChip(runChipEl, 'Run: idle', 'neutral');
  } else if (!state.runOnChain) {
    setChip(runChipEl, 'Run: local-only', 'warn');
  } else {
    const ttl = ttlRemainingMs();
    if (ttl <= 0) {
      setChip(runChipEl, 'Run: expired (out of time)', 'bad');
    } else {
      const tone = ttl <= 20_000 ? 'bad' : ttl <= 60_000 ? 'warn' : 'good';
      setChip(runChipEl, `Run: live (${formatCountdown(ttl)})`, tone);
    }
  }

  const guardTone = state.runOnChain ? 'good' : 'neutral';
  const guardLabel = state.runOnChain ? 'Fair-play check: active' : 'Fair-play check: idle';
  setChip(guardChipEl, guardLabel, guardTone);

  if (state.myRank && Number.isFinite(state.myRank)) {
    const tone = state.myRank === 1 ? 'good' : state.myRank <= 10 ? 'warn' : 'neutral';
    setChip(rankChipEl, `Rank: #${state.myRank}`, tone);
  } else if (state.myRank) {
    setChip(rankChipEl, `Rank: ${state.myRank}`, 'neutral');
  } else {
    setChip(rankChipEl, 'Rank: n/a', 'neutral');
  }
}

function shortWallet(v) {
  if (!v) return 'n/a';
  return v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
}

function shortTx(v) {
  if (!v) return 'n/a';
  return v.length > 14 ? `${v.slice(0, 10)}...` : v;
}

function relativeTime(ts) {
  const d = Date.now() - Number(ts || 0);
  if (!Number.isFinite(d) || d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function explorerTxUrl(txId) {
  const base = state.chainMeta?.channel === 'prod' ? 'https://explorer.alephium.org' : 'https://testnet.alephium.org';
  return `${base}/transactions/${txId}`;
}

function formatAlphFromAtto(atto) {
  try {
    const n = typeof atto === 'bigint' ? Number(atto) : Number(atto || 0);
    return (n / 1e18).toFixed(4);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshLeaderboard() {
  try {
    const reqs = [
      fetch('/api/leaderboard?limit=10', { cache: 'no-store' }),
      fetch('/api/leaderboard/recent?limit=20', { cache: 'no-store' })
    ];
    if (state.wallet) reqs.push(fetch(`/api/leaderboard/wallet/${encodeURIComponent(state.wallet)}?limit=1`, { cache: 'no-store' }));

    const [topRes, recentRes, walletRes] = await Promise.all(reqs);
    const topData = await topRes.json();
    const recentData = await recentRes.json();
    const walletData = walletRes ? await walletRes.json() : null;

    if (leaderboardEl) {
      leaderboardEl.innerHTML = '';
      const entries = Array.isArray(topData?.entries) ? topData.entries : [];
      if (topScoreEl && entries.length) {
        const liveTop = Number(entries[0]?.score || 0);
        if (Number.isFinite(liveTop)) topScoreEl.textContent = String(liveTop);
      }
      const myInTop = state.wallet ? entries.find((e) => String(e.wallet || '').toLowerCase() === String(state.wallet).toLowerCase()) : null;
      if (myInTop?.rank) state.myRank = myInTop.rank;
      else if (walletData?.entries?.length) state.myRank = state.myRank || '>10';

      if (walletData && Number.isFinite(Number(walletData.bestRank)) && Number(walletData.bestRank) > 0) {
        state.bestRank = Number(walletData.bestRank);
      }
      if (!entries.length) {
        const li = document.createElement('li');
        li.textContent = 'No scores yet.';
        leaderboardEl.appendChild(li);
      } else {
        for (const e of entries) {
          const li = document.createElement('li');
          const mine = state.wallet && String(e.wallet || '').toLowerCase() === String(state.wallet).toLowerCase();
          if (mine) li.classList.add('me');
          const txLink = document.createElement('a');
          txLink.href = explorerTxUrl(e.txId);
          txLink.target = '_blank';
          txLink.rel = 'noopener noreferrer';

          const payoutAtto = (() => {
            try { return BigInt(e.amountWonAtto || 0); } catch { return 0n; }
          })();

          if (payoutAtto > 0n) {
            const won = formatAlphFromAtto(payoutAtto) || '0.0000';
            txLink.textContent = `${won} ALPH`;
            li.textContent = `${e.score} · ${shortWallet(e.walletShort || e.wallet)}${mine ? ' (you)' : ''} · won `;
            li.appendChild(txLink);
          } else {
            txLink.textContent = 'tx';
            li.textContent = `${e.score} · ${shortWallet(e.walletShort || e.wallet)}${mine ? ' (you)' : ''} · `;
            li.appendChild(txLink);
          }

          leaderboardEl.appendChild(li);
        }
      }
    }

    if (recentSubmissionsEl) {
      recentSubmissionsEl.innerHTML = '';
      const recent = Array.isArray(recentData?.entries) ? recentData.entries : [];
      if (!recent.length) {
        const li = document.createElement('li');
        li.textContent = 'No submissions yet.';
        recentSubmissionsEl.appendChild(li);
      } else {
        for (const e of recent.slice(0, 10)) {
          const li = document.createElement('li');
          const paid = formatAlphFromAtto(e.entryFeePaidAtto) || '?';
          li.textContent = `${e.score} · ${shortWallet(e.walletShort || e.wallet)} · entry ${paid} ALPH · ${relativeTime(e.timestamp)}`;
          recentSubmissionsEl.appendChild(li);
        }
      }
    }
  } catch {
    // leave current leaderboard as-is
  }
}

function openWalletMenu() {
  state.walletMenuOpen = true;
  renderWalletActions();
}

function openWalletChooser() {
  if (!walletChooserEl) return;
  walletChooserEl.style.display = 'grid';
}

function closeWalletChooser() {
  if (!walletChooserEl) return;
  walletChooserEl.style.display = 'none';
}

function renderWalletActions() {
  if (!walletControlEl) return;

  if (!state.wallet) {
    walletControlEl.textContent = 'Connect Wallet';
    walletControlEl.title = 'Choose wallet connection method';
    walletControlEl.onclick = () => void openWalletChooser();

    if (walletMenuEl) {
      walletMenuEl.style.display = 'none';
      walletMenuEl.innerHTML = '';
    }
    return;
  }

  if (walletMenuEl) {
    walletMenuEl.style.display = 'none';
    walletMenuEl.innerHTML = '';
  }

  const short = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}`;
  walletControlEl.textContent = short;
  walletControlEl.title = 'Connected. Tap to disconnect.';
  walletControlEl.onclick = () => void disconnectWallet();
}

function renderChainState() {
  const cs = state.chainState;
  if (!cs) {
    if (entryFeeEl) entryFeeEl.textContent = '1.0000 ALPH (fallback)';
    if (potEl) potEl.textContent = '0.0000 ALPH';
    if (topScoreEl) topScoreEl.textContent = '0';
    if (topHolderEl) topHolderEl.textContent = 'n/a';
    if (resetCountdownEl) resetCountdownEl.textContent = '24:00:00';
    return;
  }
  if (entryFeeEl) entryFeeEl.textContent = `${cs.currentEntryFeeAlph.toFixed(4)} ALPH`;
  if (potEl) potEl.textContent = `${cs.potAlph.toFixed(4)} ALPH`;
  if (topScoreEl) topScoreEl.textContent = String(cs.topScore || 0);
  if (topHolderEl) topHolderEl.textContent = cs.topHolder || 'n/a';
  if (resetCountdownEl) resetCountdownEl.textContent = formatCountdown(cs.resetAtMs - Date.now());
}

async function loadChainMeta() {
  await ensureChainClient();
  let loaded = false;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    if (data?.contractId) {
      state.chainMeta = { channel: data.channel || 'beta', contractId: data.contractId };
    }
    if (data?.antiAssist) {
      state.antiAssist = { ...state.antiAssist, ...data.antiAssist };
    }
    if (state.chainMeta.contractId && !state.chainMeta.contractId.includes('PENDING') && state.chainMeta.contractId !== 'unassigned') {
      state.chainState = await chainClient.readTournamentState(state.chainMeta.contractId);
      loaded = true;
    }
  } catch {
    // keep defaults
  }
  state.chainDataLoaded = loaded;
  renderChainState();
  updateStatusChips();
}
async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `0x${Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function rngFromSeed(seedString) {
  let h = 2166136261;
  for (const ch of String(seedString)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let t = h >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = rngFromSeed(state.seed);

function spawnTile() {
  const empty = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (state.board[r][c] === 0) empty.push([r, c]);
  if (!empty.length) return;
  const [r, c] = empty[Math.floor(rng() * empty.length)];
  state.board[r][c] = rng() < 0.9 ? 2 : 4;
}

function resetGame(newSeed = String(Date.now())) {
  state.board = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  state.score = 0;
  state.moves = [];
  state.moveTimingsMs = [];
  state.moveChunks = [];
  state.seed = newSeed;
  state.runOnChain = false;
  state.runWallet = null;
  state.runId = null;
  state.runIdHash = null;
  state.seedHash = null;
  state.runStartedAt = null;
  state.runStartedAtMs = null;
  state.lastMoveAtMs = null;
  state.lastStartTxId = null;
  state.lastSubmitTxId = null;
  state.pendingEntryFeeRetry = false;
  state.startPending = false;
  state.submitPending = false;
  state.submitTimerFreezeMs = null;
  state.postSubmitLockUntilMs = 0;
  state.endRunRequested = false;
  state.entryFeePaidAtto = null;
  rng = rngFromSeed(newSeed);
  spawnTile(); spawnTile();
  clearRunDraft();
  render();
}

function slideAndMerge(line) {
  const x = line.filter(Boolean);
  let add = 0;
  for (let i = 0; i < x.length - 1; i++) if (x[i] === x[i + 1]) { x[i] *= 2; add += x[i]; x[i + 1] = 0; }
  const out = x.filter(Boolean);
  while (out.length < 4) out.push(0);
  return [out, add];
}

function transpose(b) { return b[0].map((_, c) => b.map(r => r[c])); }
function revRows(b) { return b.map(r => [...r].reverse()); }

async function rebuildMoveChunks() {
  const chunks = [];
  let prevChunkHash = '0x0';
  for (let i = 0; i < state.moves.length; i += state.antiAssist.moveChunkSize) {
    const chunkMoves = state.moves.slice(i, i + state.antiAssist.moveChunkSize);
    const chunkTimings = state.moveTimingsMs.slice(i, i + state.antiAssist.moveChunkSize);
    const moveRecords = chunkMoves.map((move, idx) => `${i + idx}:${move}:${chunkTimings[idx] ?? 0}`);
    const movesHash = await sha256Hex(moveRecords.join('|'));
    const startMove = i;
    const endMove = i + chunkMoves.length - 1;
    const chunkHash = await sha256Hex(`${prevChunkHash}|${startMove}|${endMove}|${movesHash}`);
    chunks.push({ index: chunks.length, startMove, endMove, moveCount: chunkMoves.length, movesHash, prevChunkHash, chunkHash });
    prevChunkHash = chunkHash;
  }
  state.moveChunks = chunks;
}

async function applyMove(dir) {
  if (!state.runOnChain) {
    runStatusEl.textContent = 'Start a new ranked run on-chain before playing.';
    return;
  }

  if (isRunExpired() || state.endRunRequested) {
    runStatusEl.textContent = state.endRunRequested
      ? 'Run ended early. Moves are locked — submit your current score.'
      : '⏱️ You are out of time. Moves are locked — submit your current score.';
    return;
  }

  let work = state.board.map(r => [...r]);
  let back = x => x;
  if (dir === 'up') { work = transpose(work); back = x => transpose(x); }
  if (dir === 'down') { work = revRows(transpose(work)); back = x => transpose(revRows(x)); }
  if (dir === 'right') { work = revRows(work); back = x => revRows(x); }

  let moved = false, add = 0;
  const rows = work.map(row => {
    const [line, sc] = slideAndMerge(row);
    if (line.some((v,i) => v !== row[i])) moved = true;
    add += sc;
    return line;
  });
  if (!moved) return;
  state.board = back(rows);
  state.score += add;

  const now = Date.now();
  const baseTs = state.lastMoveAtMs || state.runStartedAtMs || now;
  state.moveTimingsMs.push(Math.max(1, now - baseTs));
  state.lastMoveAtMs = now;
  state.moves.push(dir);
  await rebuildMoveChunks();

  spawnTile();
  saveRunDraft();
  render();
}

function render() {
  const remaining = ttlRemainingMs();
  const ttlText = state.runStartedAtMs ? ` | expires in ${formatCountdown(remaining)}` : '';

  if (startRunOverlayEl) {
    const canSubmitNow = Boolean(state.runId && (isRunExpired() || isGameOver() || state.endRunRequested));
    const lockMs = Math.max(0, (state.postSubmitLockUntilMs || 0) - Date.now());
    const inPostSubmitLock = lockMs > 0;

    if (!state.chainDataLoaded) {
      startRunOverlayEl.style.display = 'none';
      startRunOverlayEl.dataset.action = 'none';
      if (overlayReasonEl) overlayReasonEl.textContent = '';
    } else {
      const showOverlay = !state.wallet || !state.runOnChain || canSubmitNow || state.startPending || state.submitPending || inPostSubmitLock;
      startRunOverlayEl.style.display = showOverlay ? 'block' : 'none';
      if (overlayReasonEl) overlayReasonEl.textContent = '';
      if (showOverlay) {
        if (inPostSubmitLock) {
        startRunOverlayEl.textContent = `✅ Submitted! Next ranked run in ${Math.ceil(lockMs / 1000)}s`;
        startRunOverlayEl.dataset.action = 'none';
        if (overlayReasonEl) overlayReasonEl.textContent = 'Holding end screen briefly before allowing a new run.';
      } else if (state.startPending) {
        startRunOverlayEl.textContent = 'Starting run…';
        startRunOverlayEl.dataset.action = 'none';
        if (overlayReasonEl) overlayReasonEl.textContent = 'Waiting for wallet signature and chain confirmation.';
      } else if (state.submitPending) {
        startRunOverlayEl.textContent = 'Submitting…';
        startRunOverlayEl.dataset.action = 'none';
        if (overlayReasonEl) overlayReasonEl.textContent = 'Verifying run and broadcasting submit transaction.';
      } else if (!state.wallet) {
        startRunOverlayEl.textContent = 'Connect Wallet';
        startRunOverlayEl.dataset.action = 'connect';
        if (overlayReasonEl) overlayReasonEl.textContent = 'Step 1 of 3: connect your wallet to start a ranked run.';
      } else if (canSubmitNow) {
        const rankText = state.myRank ? `Current rank: ${Number.isFinite(state.myRank) ? `#${state.myRank}` : state.myRank}` : 'Current rank: unranked';
        startRunOverlayEl.innerHTML = `Verify + Submit <span class="sub">Score: ${state.score} · ${rankText}</span>`;
        startRunOverlayEl.dataset.action = 'submit';
        if (overlayReasonEl) {
          if (isRunExpired()) overlayReasonEl.textContent = 'Time is up. You can still submit this locked score.';
          else if (state.endRunRequested) overlayReasonEl.textContent = 'Run ended early. Submit this score now.';
          else overlayReasonEl.textContent = 'Game over. Submit your score to claim leaderboard rank.';
        }
      } else {
        const fee = Number.isFinite(state.chainState?.currentEntryFeeAlph)
          ? `${state.chainState.currentEntryFeeAlph.toFixed(4)} ALPH`
          : '1.0000 ALPH';
        if (state.pendingEntryFeeRetry) {
          startRunOverlayEl.innerHTML = `Retry with updated fee <span class="sub">Current entry fee: ${fee} · may change if other players start first</span>`;
        } else {
          startRunOverlayEl.innerHTML = `Start Ranked Run <span class="sub">Entry fee: ${fee} · may increase if other users play</span>`;
        }
        startRunOverlayEl.dataset.action = 'start';
        if (overlayReasonEl) {
          overlayReasonEl.textContent = state.justSubmitted
            ? 'Score submitted. Start a new ranked run when ready.'
            : 'Step 2 of 3: start your run on-chain (fee can move under high activity).';
        }
      }
    }
  }
}

  if (countdownBannerEl) {
    if (state.runOnChain && state.runId && remaining > 0 && remaining <= 60_000) {
      countdownBannerEl.style.display = 'block';
      const tone = remaining <= 20_000 ? 'danger' : 'warn';
      countdownBannerEl.className = `panel ${tone}`;
      countdownBannerEl.textContent = remaining <= 20_000
        ? `⏱️ Hurry — less than ${formatCountdown(remaining)} left to submit this run.`
        : `⏳ Time left in this run: ${formatCountdown(remaining)}`;
    } else if (state.runId && remaining <= 0) {
      countdownBannerEl.style.display = 'block';
      countdownBannerEl.className = 'panel danger';
      countdownBannerEl.textContent = '⏱️ Time is up — moves are locked. You can still submit your current score.';
    } else {
      countdownBannerEl.style.display = 'none';
    }
  }
  if (!state.chainDataLoaded) {
    runStatusEl.textContent = '';
  } else if (state.runId) {
    const hashPreview = state.runIdHash ? `${state.runIdHash.slice(0, 12)}...` : 'pending-hash';
    if (remaining <= 0) {
      runStatusEl.textContent = `⏱️ Out of time. Run ${state.runId} is locked — submit your current score.`;
    } else {
      runStatusEl.textContent = `Run: ${state.runId} (${hashPreview})${ttlText}${state.lastStartTxId ? ` tx ${state.lastStartTxId.slice(0, 10)}...` : ''}`;
    }
  }

  scoreEl.textContent = state.chainDataLoaded ? state.score : 0;
  if (gameTimerEl) {
    const timerActive = state.chainDataLoaded && state.runOnChain && !!state.runStartedAtMs;
    if (!timerActive) {
      gameTimerEl.textContent = formatGameTimer(state.antiAssist.runTtlMs);
    } else {
      const liveTtl = Math.max(0, ttlRemainingMs());
      const ttl = state.submitPending && state.submitTimerFreezeMs != null
        ? Math.max(0, state.submitTimerFreezeMs)
        : liveTtl;
      gameTimerEl.textContent = formatGameTimer(ttl);
    }
  }

  const endRunBtn = document.getElementById('endRunNow');
  if (endRunBtn) {
    const midGame = state.runOnChain && state.runId && !state.endRunRequested && !isRunExpired() && !isGameOver() && !state.startPending && !state.submitPending;
    endRunBtn.disabled = !midGame;
  }

  renderWalletActions();
  updateStatusChips();
  boardEl.innerHTML = '';
  for (const row of state.board) {
    for (const v of row) {
      const d = document.createElement('div');
      d.className = `tile ${v ? `v${v}` : ''}`;
      d.textContent = v || '';
      boardEl.appendChild(d);
    }
  }
}

async function connectWallet(mode = 'auto') {
  await ensureChainClient();

  let connected = null;
  if (mode === 'extension') {
    connected = await chainClient.connectExtensionWallet();
  } else if (mode === 'desktop' && typeof chainClient.connectDesktopWallet === 'function') {
    connected = await chainClient.connectDesktopWallet();
  } else if (mode === 'walletconnect' && typeof chainClient.connectWalletConnect === 'function') {
    connected = await chainClient.connectWalletConnect();
  } else {
    connected = typeof chainClient.connectWalletAuto === 'function'
      ? await chainClient.connectWalletAuto()
      : await chainClient.connectExtensionWallet();
  }

  if (connected?.account?.address) {
    state.wallet = connected.account.address;
    window.__alphWallet = connected.wallet;
    window.__alphAccount = connected.account;

    const accountGroup = Number.isInteger(connected.account.group)
      ? Number(connected.account.group)
      : null;

    if (accountGroup !== null) {
      state.walletGroup = accountGroup;
    } else if (typeof chainClient.resolveAddressGroup === 'function') {
      state.walletGroup = await chainClient.resolveAddressGroup(state.wallet, connected.wallet);
    } else {
      state.walletGroup = null;
    }

    // ALPH2048 supports only group0 or groupless/unknown-group wallets.
    if (Number.isInteger(state.walletGroup) && state.walletGroup !== 0) {
      try {
        if (typeof chainClient.disconnectExtensionWallet === 'function') {
          await chainClient.disconnectExtensionWallet();
        }
      } catch {}
      state.wallet = null;
      state.walletGroup = null;
      walletStatusEl.textContent = 'Wallet: disconnected';
      verifyResultEl.textContent = `Unsupported wallet group (g${state.walletGroup}). Please connect a group0 or groupless wallet.`;
      render();
      return;
    }

    walletStatusEl.textContent = `Wallet: ${state.wallet} (connected)`;
  } else {
    state.wallet = null;
    state.walletGroup = null;
    walletStatusEl.textContent = 'Wallet: disconnected';
    verifyResultEl.textContent = 'Wallet connection failed. Use extension or WalletConnect QR and try again.';
  }
  render();
}

async function disconnectWallet() {
  await ensureChainClient();
  try {
    if (typeof chainClient.disconnectExtensionWallet === 'function') {
      await chainClient.disconnectExtensionWallet();
    }
  } catch {
    // best effort only
  }

  state.wallet = null;
  state.walletGroup = null;
  if (state.runOnChain && !state.submitPending && !state.startPending) {
    runStatusEl.textContent = 'Wallet disconnected. Reconnect to continue on-chain actions.';
  }
  render();
}

async function startRankedRun() {
  if (!state.wallet) {
    alert('Connect wallet first.');
    return;
  }
  state.pendingEntryFeeRetry = false;
  state.startPending = true;
  state.justSubmitted = false;
  if (submitResultCardEl) submitResultCardEl.style.display = 'none';
  if (highScoreBannerEl) highScoreBannerEl.style.display = 'none';
  render();

  try {
    const gateRes = await fetch('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: state.wallet })
    });
    const gateData = await gateRes.json();
    if (!gateRes.ok) {
      if (gateData?.errorCode === 'WALLET_COOLDOWN_ACTIVE') {
        runStatusEl.textContent = `Cooldown active. Try again in ${Math.ceil((gateData.retryAfterMs || 0) / 1000)}s.`;
      } else {
        runStatusEl.textContent = friendlyError(gateData?.errorCode, `Cannot start run: ${gateData?.error || 'unknown error'}`);
      }
      return;
    }

    state.runId = crypto.randomUUID();
    state.runIdHash = await sha256Hex(state.runId);
    state.seedHash = await sha256Hex(state.seed);
    // Do not start timer yet; start countdown only after signed on-chain start succeeds.
    state.runStartedAt = null;
    state.runStartedAtMs = null;
    state.lastMoveAtMs = null;
    state.endRunRequested = false;

    let entryFeeAtto = state.chainState?.currentEntryFeeAtto || 1000000000000000000n;
    let chainResult = { mode: 'fallback', reason: 'extension missing or contract pending' };
    if (state.chainMeta.contractId && !state.chainMeta.contractId.includes('PENDING')) {
      try {
        // Always refresh fee right before signing to reduce stale-fee failures under concurrency.
        const latest = await chainClient.readTournamentState(state.chainMeta.contractId);
        if (latest?.currentEntryFeeAtto) {
          state.chainState = latest;
          entryFeeAtto = latest.currentEntryFeeAtto;
        }
        state.entryFeePaidAtto = entryFeeAtto;
        const tx = await chainClient.startRunTx({ contractId: state.chainMeta.contractId, runIdHash: state.runIdHash, seedHash: state.seedHash, entryFeeAtto });
        state.lastStartTxId = tx.txId;
        chainResult = { mode: 'extension', txId: tx.txId, wallet: tx.wallet };
      } catch (error) {
        let reason = error?.message || String(error);
        if (reason.includes('Error Code: 3')) {
          reason = 'ENTRY_FEE_UPDATED: another player started a run first. Retry to use the new entry fee.';
          state.pendingEntryFeeRetry = true;
          if (startRunOverlayEl) startRunOverlayEl.textContent = 'Retry with updated fee';
          await loadChainMeta();
        }
        chainResult = { mode: 'fallback', reason };
      }
    }

    if (chainResult.mode === 'extension') {
      state.runOnChain = true;
      state.runWallet = state.wallet;
      state.runStartedAt = new Date().toISOString();
      state.runStartedAtMs = Date.parse(state.runStartedAt);
      state.lastMoveAtMs = state.runStartedAtMs;
      runStatusEl.textContent = `Ranked run started on-chain. tx ${String(chainResult.txId).slice(0, 12)}...`;
    } else {
      state.runOnChain = false;
      state.runWallet = null;
      runStatusEl.textContent = `Ranked run started locally only (on-chain start failed: ${chainResult.reason}).`;
      verifyResultEl.textContent = JSON.stringify({ chainStart: chainResult, contractId: state.chainMeta.contractId }, null, 2);
    }

    const record = {
      runId: state.runId,
      runIdHash: state.runIdHash,
      wallet: state.wallet,
      seed: state.seed,
      seedHash: state.seedHash,
      startedAt: state.runStartedAt,
      chainResult
    };
    localStorage.setItem(`alph2048:${state.runId}`, JSON.stringify(record));
    saveRunDraft();

    render();
    await loadChainMeta();
  } finally {
    state.startPending = false;
    render();
  }
}

if (startRunOverlayEl) {
  startRunOverlayEl.onclick = () => {
    const action = startRunOverlayEl.dataset.action;
    if (action === 'none') return;
    if (action === 'connect') return void openWalletChooser();
    if (action === 'submit') return void submitCurrentScore();
    return void startRankedRun();
  };
}

if (walletChooseExtensionEl) walletChooseExtensionEl.onclick = () => { closeWalletChooser(); void connectWallet('extension'); };
if (walletChooseDesktopEl) walletChooseDesktopEl.onclick = () => { closeWalletChooser(); void connectWallet('desktop'); };
if (walletChooseQrEl) walletChooseQrEl.onclick = () => { closeWalletChooser(); void connectWallet('walletconnect'); };
if (walletChooseCancelEl) walletChooseCancelEl.onclick = () => { closeWalletChooser(); };
if (walletChooserEl) {
  walletChooserEl.onclick = (event) => {
    if (event.target === walletChooserEl) closeWalletChooser();
  };
}

async function submitCurrentScore() {
  state.submitTimerFreezeMs = Math.max(0, ttlRemainingMs());
  state.submitPending = true;
  render();
  try {
    trace('submit:click', { runId: state.runId, runOnChain: state.runOnChain });
    if (!state.runId || !state.runIdHash || !state.seedHash) return;
    if (ttlRemainingMs() <= 0) {
      runStatusEl.textContent = '⏱️ Time is up — gameplay is locked. Submitting your current score...';
    }

    const verifyReq = {
      runId: state.runId,
      runIdHash: state.runIdHash,
      wallet: state.wallet,
      seed: state.seed,
      seedHash: state.seedHash,
      runStartedAt: state.runStartedAt,
      moveTimingsMs: state.moveTimingsMs,
      moveChunks: state.moveChunks,
      moves: state.moves,
      score: state.score
    };

    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyReq)
    });
    const verifyRes = await res.json();
    if (!res.ok) {
      runStatusEl.textContent = `Verify rejected (${verifyRes.errorCode || 'VERIFY_REJECTED'}): ${friendlyError(verifyRes.errorCode, verifyRes.error || 'unknown error')}`;
      verifyResultEl.textContent = JSON.stringify({ verifyRequest: verifyReq, verifyResponse: verifyRes }, null, 2);
      return;
    }

    // Take a fresh on-chain snapshot right before submit so payout/top comparisons are accurate.
    try {
      await loadChainMeta();
    } catch {}
    const preSubmitPotAtto = state.chainState?.potAtto;
    const preSubmitTopScore = Number(state.chainState?.topScore || 0);
    const preSubmitEntryFeeAtto = state.chainState?.currentEntryFeeAtto || null;

    const submitPayload = {
      ...(verifyRes.submitPayload || {
        runIdHash: state.runIdHash,
        score: state.score,
        attestationHash: verifyRes.attestationHash
      }),
      contractId: verifyRes.submitContext?.contractId || verifyRes.contractId,
      channel: verifyRes.submitContext?.channel || verifyRes.channel,
      attestation: verifyRes.attestation,
      verifierKeyVersion: verifyRes.verifierKeyVersion
    };

    let submitTx = { mode: 'fallback', reason: 'extension missing or contract pending' };
    if (!state.runOnChain) {
      submitTx = { mode: 'fallback', reason: 'RUN_NOT_ONCHAIN: start run on-chain before submitting score' };
    } else if (state.runWallet && state.wallet && state.runWallet !== state.wallet) {
      submitTx = { mode: 'fallback', reason: 'RUN_WALLET_MISMATCH: reconnect the wallet that started this run' };
    } else if (submitPayload.contractId && !submitPayload.contractId.includes('PENDING')) {
      try {
        let tx = null;
        let lastError = null;
        for (let i = 0; i < 5; i++) {
          try {
            tx = await chainClient.submitScoreTx({ contractId: submitPayload.contractId, runIdHash: submitPayload.runIdHash, score: submitPayload.score, attestationHash: submitPayload.attestationHash });
            break;
          } catch (err) {
            lastError = err;
            const msg = String(err?.message || err);
            if (msg.includes('Error Code: 1')) {
              // Start tx can lag visibility briefly on shared testnet nodes.
              await sleep(1500);
              continue;
            }
            throw err;
          }
        }
        if (!tx && lastError) throw lastError;
        state.lastSubmitTxId = tx.txId;
        submitTx = { mode: 'extension', txId: tx.txId, wallet: tx.wallet };
      } catch (error) {
        let reason = error?.message || String(error)
        if (reason.includes('Error Code: 0')) {
          reason = 'RUN_NOT_OWNED_BY_CALLER: use the same wallet that started the run'
        } else if (reason.includes('Error Code: 1')) {
          reason = 'RUN_NOT_VISIBLE_YET: run start is still propagating on-chain. Wait 3-5s and tap Verify + Submit again.'
        } else if (reason.includes('Error Code: 2')) {
          reason = 'RUN_ALREADY_SUBMITTED: this run receipt was already finalized'
        }
        submitTx = { mode: 'fallback', reason };
      }
    }

    state.lastSubmitPayload = { ...submitPayload, submitTx };
    verifyResultEl.textContent = JSON.stringify({ verifyRequest: verifyReq, verifyResponse: verifyRes, contractSubmitPayload: submitPayload, submitTx, startTxId: state.lastStartTxId }, null, 2);
    if (submitTx.mode === 'extension') {
      runStatusEl.textContent = `Score submitted on-chain. tx ${String(submitTx.txId).slice(0, 12)}...`;
      let recData = null;
      let submittedRunRank = null;
      try {
        const recRes = await fetch('/api/leaderboard/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet: state.wallet,
            score: submitPayload.score,
            txId: submitTx.txId,
            runIdHash: submitPayload.runIdHash,
            entryFeePaidAtto: state.entryFeePaidAtto ? String(state.entryFeePaidAtto) : null,
            amountWonAtto: (submitPayload.score > preSubmitTopScore && preSubmitPotAtto)
              ? String((typeof preSubmitPotAtto === 'bigint' ? preSubmitPotAtto : BigInt(preSubmitPotAtto)) / 2n)
              : '0',
            attestationHash: submitPayload.attestationHash,
            verifyTicket: verifyRes.verifyTicket || submitPayload.verifyTicket || null
          })
        });
        recData = await recRes.json();
        if (recData?.ok) {
          const runRank = Number(recData.rank || 0) || null;
          submittedRunRank = runRank;
          state.myRank = runRank;
          if (runRank) {
            state.bestRank = state.bestRank ? Math.min(state.bestRank, runRank) : runRank;
          }
        }
        if (highScoreBannerEl) {
          highScoreBannerEl.style.display = 'none';
        }
      } catch {
        // leaderboard record failure should not block gameplay
      }
      await refreshLeaderboard();
      await loadChainMeta();

      // Ensure entry-fee UI catches post-win fee changes after chain propagation.
      if (recData?.ok && recData?.newHighScore) {
        for (let i = 0; i < 5; i++) {
          const before = state.chainState?.currentEntryFeeAtto || null;
          await sleep(900);
          await loadChainMeta();
          const after = state.chainState?.currentEntryFeeAtto || null;
          if (preSubmitEntryFeeAtto != null && after != null && String(after) !== String(preSubmitEntryFeeAtto)) break;
          if (before != null && after != null && String(after) !== String(before)) break;
        }
      }
      if (submitResultCardEl) {
        submitResultCardEl.style.display = 'block';
        const serverSaysTop = Boolean(recData?.ok && (recData?.newHighScore || Number(recData?.rank) === 1));
        const estimatedPayout = serverSaysTop && preSubmitPotAtto ? formatAlphFromAtto((typeof preSubmitPotAtto === 'bigint' ? preSubmitPotAtto : BigInt(preSubmitPotAtto)) / 2n) : null;
        const currentRankText = submittedRunRank ? `#${submittedRunRank}` : 'unranked';
        const bestRankText = state.bestRank ? `#${state.bestRank}` : 'unranked';
        const payoutText = serverSaysTop ? ` You won ${estimatedPayout || '?'} ALPH.` : '';
        submitResultCardEl.innerHTML = `✅ Score submitted on-chain. Current game rank ${currentRankText}. Best game rank ${bestRankText}.${payoutText} <a href="${explorerTxUrl(submitTx.txId)}" target="_blank" rel="noopener noreferrer">View tx</a>`;
      }
      state.postSubmitLockUntilMs = Date.now() + 4000;
      runStatusEl.textContent = '';
      render();
      setTimeout(() => {
        // Only reset if no new run started in between.
        if (Date.now() >= state.postSubmitLockUntilMs) {
          resetGame();
          state.justSubmitted = true;
          runStatusEl.textContent = '';
          render();
        }
      }, 4100);
    } else {
      runStatusEl.textContent = `Score verified, but on-chain submit failed: ${friendlyError(submitTx.reason, submitTx.reason)}`;
      await loadChainMeta();
    }
  } catch (error) {
    const reason = error?.message || String(error);
    runStatusEl.textContent = `Submit flow failed: ${friendlyError(reason, reason)}`;
    trace('submit:catch', { reason });
  } finally {
    state.submitPending = false;
    state.submitTimerFreezeMs = null;
    render();
  }
}

async function handleMove(dir) {
  if (!dir) return;
  await applyMove(dir);
}

window.addEventListener('keydown', (e) => {
  const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  if (map[e.key]) {
    e.preventDefault();
    void handleMove(map[e.key]);
  }
});

document.querySelectorAll('.move[data-dir]').forEach((btn) => {
  btn.addEventListener('click', () => void handleMove(btn.dataset.dir));
});

const endRunBtn = document.getElementById('endRunNow');
if (endRunBtn) {
  endRunBtn.onclick = () => {
    if (!state.runOnChain || !state.runId) {
      runStatusEl.textContent = 'Start a ranked run first.';
      return;
    }
    const ok = window.confirm('Are you sure you want to stop your run early and submit your score?');
    if (!ok) return;
    state.endRunRequested = true;
    saveRunDraft();
    runStatusEl.textContent = 'Stopping run early and submitting score…';
    render();
    void submitCurrentScore();
  };
}

let touchStartX = 0;
let touchStartY = 0;
boardEl.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
}, { passive: true });

boardEl.addEventListener('touchmove', (e) => {
  e.preventDefault();
}, { passive: false });

boardEl.addEventListener('touchend', (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (Math.max(absX, absY) < 24) return;
  if (absX > absY) {
    void handleMove(dx > 0 ? 'right' : 'left');
  } else {
    void handleMove(dy > 0 ? 'down' : 'up');
  }
}, { passive: false });

window.addEventListener('error', (event) => {
  trace('window:error', { message: event?.message || 'unknown error' });
});
window.addEventListener('unhandledrejection', (event) => {
  trace('window:unhandledrejection', { reason: String(event?.reason || 'unknown rejection') });
});

document.addEventListener('click', (event) => {
  if (!state.walletMenuOpen || !walletControlEl || !walletMenuEl) return;
  const t = event.target;
  if (walletControlEl.contains(t) || walletMenuEl.contains(t)) return;
  state.walletMenuOpen = false;
  renderWalletActions();
});

async function bootstrap() {
  await loadChainMeta();
  await refreshLeaderboard();
  restoreRunDraft();
  if (!state.runId) resetGame();
  else render();
}

void bootstrap();
setInterval(() => {
  renderChainState();
  render();
}, 1000);
setInterval(() => {
  void refreshLeaderboard();
}, 15000);
setInterval(() => {
  if (!state.startPending && !state.submitPending) void loadChainMeta();
}, 8000);
