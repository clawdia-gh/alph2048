const DEFAULTS = {
  baseEntryFee: 1,
  entryGrowth: 1.1,
  inactivityResetMs: 86_400_000,
  payoutRatio: 0.5,
  carryRatio: 0.5
};

export function createTournamentState(overrides = {}) {
  const econ = { ...DEFAULTS, ...overrides };
  return {
    ...econ,
    currentEntryFee: econ.baseEntryFee,
    pot: 0,
    roundIndex: 0,
    lastActivityAt: 0,
    totalRuns: 0,
    totalSubmissions: 0,
    leaderboardTopScore: 0,
    leaderboardTopPlayer: null,
    runs: new Map()
  };
}

function maybeReset(state, now) {
  if (state.lastActivityAt > 0 && now >= state.lastActivityAt + state.inactivityResetMs) {
    state.roundIndex = 0;
    state.currentEntryFee = state.baseEntryFee;
    state.leaderboardTopScore = 0;
    state.leaderboardTopPlayer = null;
  }
}

export function startRun(state, { runIdHash, seedHash, player, now = Date.now(), payment }) {
  maybeReset(state, now);
  if (typeof payment === 'number' && Math.abs(payment - state.currentEntryFee) > 1e-9) {
    throw new Error('InvalidEntryPayment');
  }
  if (state.runs.has(runIdHash)) {
    throw new Error('RunAlreadyStarted');
  }

  state.totalRuns += 1;
  state.roundIndex += 1;
  state.pot += state.currentEntryFee;
  state.currentEntryFee = Number((state.currentEntryFee * state.entryGrowth).toFixed(8));
  state.lastActivityAt = now;

  state.runs.set(runIdHash, {
    runIdHash,
    seedHash,
    player,
    startedAt: now,
    submitted: false,
    submittedScore: 0,
    attestationHash: null
  });

  return state;
}

export function getRunState(state, { runIdHash }) {
  const receipt = state.runs.get(runIdHash);
  const found = Boolean(receipt);
  return {
    found,
    player: found ? receipt.player : null,
    seedHash: found ? receipt.seedHash : null,
    startedAt: found ? receipt.startedAt : 0,
    submitted: found ? receipt.submitted : false,
    submittedScore: found ? receipt.submittedScore : 0,
    attestationHash: found ? receipt.attestationHash : null
  };
}

export function submitScore(state, { runIdHash, score, attestationHash, player, now = Date.now() }) {
  const receipt = state.runs.get(runIdHash);
  if (!receipt) throw new Error('RunIdMismatch');
  if (player !== receipt.player) throw new Error('RunNotOwnedByCaller');
  if (receipt.submitted) throw new Error('RunAlreadySubmitted');

  receipt.submitted = true;
  receipt.submittedScore = score;
  receipt.attestationHash = attestationHash;
  state.totalSubmissions += 1;
  state.lastActivityAt = now;

  let payout = 0;
  if (score > state.leaderboardTopScore) {
    payout = state.pot * state.payoutRatio;
    state.pot = state.pot - payout;
    state.leaderboardTopScore = score;
    state.leaderboardTopPlayer = player;
    state.currentEntryFee = Math.max(state.baseEntryFee, Number((state.currentEntryFee / 2).toFixed(8)));
  }

  return { state, payout, carry: state.pot };
}
