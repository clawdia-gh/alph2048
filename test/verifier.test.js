import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRun, hashAttestation } from '../server/game2048.js';
import { createTournamentState, startRun, submitScore } from '../server/contractModel.js';
import { buildChunkCommits, createWalletCooldownGate, validateChunkCommits, validateTimingEnvelope } from '../server/antiAssist.js';

test('replayRun is deterministic for same seed and moves', () => {
  const input = { seed: 'seed-123', moves: ['up', 'left', 'left', 'down', 'right'] };
  const a = replayRun(input);
  const b = replayRun(input);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.board, b.board);
});

test('replayRun changes with different move sequence', () => {
  const a = replayRun({ seed: 'seed-123', moves: ['up', 'left'] });
  const b = replayRun({ seed: 'seed-123', moves: ['up', 'right'] });
  assert.notDeepEqual(a.board, b.board);
});

test('hashAttestation returns stable 0x-prefixed sha256', () => {
  const attestation = 'ALPH_MOCK_ATTESTATION.demo.payload';
  const a = hashAttestation(attestation);
  const b = hashAttestation(attestation);
  assert.equal(a, b);
  assert.equal(a.startsWith('0x'), true);
  assert.equal(a.length, 66);
});

test('duplicate submit guard blocks same run', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0xrun1', seedHash: '0xseed1', player: 'walletA', payment: 1 });
  submitScore(state, { runIdHash: '0xrun1', score: 1024, attestationHash: '0xatt1', player: 'walletA' });

  assert.throws(() => {
    submitScore(state, { runIdHash: '0xrun1', score: 2048, attestationHash: '0xatt2', player: 'walletA' });
  }, /RunAlreadySubmitted/);
});

test('concurrent starts create isolated run receipts', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0xrunA', seedHash: '0xseedA', player: 'walletA', payment: 1 });
  startRun(state, { runIdHash: '0xrunB', seedHash: '0xseedB', player: 'walletB', payment: 1.1 });

  const runA = state.runs.get('0xrunA');
  const runB = state.runs.get('0xrunB');
  assert.equal(Boolean(runA), true);
  assert.equal(Boolean(runB), true);
  assert.equal(runA.player, 'walletA');
  assert.equal(runB.player, 'walletB');
  assert.equal(runA.submitted, false);
  assert.equal(runB.submitted, false);
});

test('concurrent submit ownership and one-submit are enforced per run', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0xrunA', seedHash: '0xseedA', player: 'walletA', payment: 1 });
  startRun(state, { runIdHash: '0xrunB', seedHash: '0xseedB', player: 'walletB', payment: 1.1 });

  assert.throws(() => {
    submitScore(state, { runIdHash: '0xrunA', score: 100, attestationHash: '0xattA-bad', player: 'walletB' });
  }, /RunNotOwnedByCaller/);

  submitScore(state, { runIdHash: '0xrunA', score: 100, attestationHash: '0xattA', player: 'walletA' });
  submitScore(state, { runIdHash: '0xrunB', score: 200, attestationHash: '0xattB', player: 'walletB' });

  assert.throws(() => {
    submitScore(state, { runIdHash: '0xrunA', score: 300, attestationHash: '0xattA2', player: 'walletA' });
  }, /RunAlreadySubmitted/);
});

test('reset logic triggers at 24h inactivity boundary', () => {
  const state = createTournamentState();
  const t0 = 1_000;
  startRun(state, { runIdHash: '0xa', seedHash: '0xs', player: 'walletA', payment: 1, now: t0 });
  submitScore(state, { runIdHash: '0xa', score: 512, attestationHash: '0xatt', player: 'walletA', now: t0 + 5_000 });

  const tBoundary = t0 + 5_000 + 86_400_000;
  startRun(state, { runIdHash: '0xb', seedHash: '0xs2', player: 'walletA', payment: 1, now: tBoundary });

  assert.equal(state.roundIndex, 1);
  assert.equal(state.leaderboardTopScore, 0);
  assert.equal(state.currentEntryFee, 1.1);
});

test('payout split is 50/50 on new top score', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0x1', seedHash: '0xs1', player: 'walletA', payment: 1 });
  const r = submitScore(state, { runIdHash: '0x1', score: 2048, attestationHash: '0xatt', player: 'walletA' });

  assert.equal(r.payout, 0.5);
  assert.equal(r.carry, 0.5);
});

test('wrong-wallet submit is rejected', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0xrw', seedHash: '0xseed', player: 'walletA', payment: 1 });
  assert.throws(() => {
    submitScore(state, { runIdHash: '0xrw', score: 256, attestationHash: '0xatt', player: 'walletB' });
  }, /RunNotOwnedByCaller/);
});

test('entry fee is halved on new top score, then growth resumes on next starts', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0xg1', seedHash: '0xs1', player: 'walletA', payment: 1 });
  assert.equal(state.currentEntryFee, 1.1);

  // New top score triggers half-drop, clamped to base entry.
  submitScore(state, { runIdHash: '0xg1', score: 10, attestationHash: '0xatt', player: 'walletA' });
  assert.equal(state.currentEntryFee, 1);

  // Growth still applies normally from the new lowered fee.
  startRun(state, { runIdHash: '0xg2', seedHash: '0xs2', player: 'walletA', payment: 1 });
  assert.equal(state.currentEntryFee, 1.1);
});

test('seed/run receipt consistency persisted across start/submit', () => {
  const state = createTournamentState();
  startRun(state, { runIdHash: '0xrun-z', seedHash: '0xseed-z', player: 'walletA', payment: 1 });
  const run = state.runs.get('0xrun-z');
  assert.equal(run.runIdHash, '0xrun-z');
  assert.equal(run.seedHash, '0xseed-z');
  submitScore(state, { runIdHash: '0xrun-z', score: 128, attestationHash: '0xatt-z', player: 'walletA' });
  assert.equal(state.runs.get('0xrun-z').attestationHash, '0xatt-z');
});

test('TTL expiry locks gameplay but still allows verification envelope', () => {
  const now = Date.parse('2026-03-05T12:05:01.000Z');
  const check = validateTimingEnvelope({ runStartedAt: '2026-03-05T12:00:00.000Z', moves: ['up'], moveTimingsMs: [200] }, now);
  assert.equal(check.ok, true);
  assert.equal(check.ttlExpired, true);
});

test('invalid chunk chain rejection', () => {
  const moves = ['up', 'left', 'right', 'down', 'up', 'left'];
  const moveTimingsMs = [100, 120, 140, 160, 180, 200];
  const chunks = buildChunkCommits(moves, moveTimingsMs);
  chunks[1].prevChunkHash = '0xbad';
  const check = validateChunkCommits({ moves, moveTimingsMs, chunks });
  assert.equal(check.ok, false);
  assert.equal(check.code, 'CHUNK_CHAIN_BROKEN');
});

test('timing-envelope rejection for suspiciously uniform timings', () => {
  const moves = Array.from({ length: 25 }, () => 'left');
  const moveTimingsMs = Array.from({ length: 25 }, () => 100);
  const startedAt = '2026-03-05T12:00:00.000Z';
  const now = Date.parse('2026-03-05T12:00:10.000Z');
  const check = validateTimingEnvelope({ runStartedAt: startedAt, moves, moveTimingsMs }, now);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'TIMING_TOO_UNIFORM');
});

test('cooldown rejection', () => {
  const gate = createWalletCooldownGate(20_000);
  const t0 = 1_000;
  assert.equal(gate.checkAndTouch('walletA', t0).ok, true);
  const second = gate.checkAndTouch('walletA', t0 + 10_000);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'WALLET_COOLDOWN_ACTIVE');
  assert.equal(second.retryAfterMs, 10_000);
});
