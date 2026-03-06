import { sha256Hex } from './game2048.js';

export const ANTI_ASSIST_DEFAULTS = {
  runTtlMs: Number(process.env.RUN_TTL_MS || 300_000),
  moveChunkSize: Number(process.env.MOVE_CHUNK_SIZE || 5),
  minRunDurationMs: Number(process.env.MIN_RUN_DURATION_MS || 2_500),
  minAverageMoveMs: Number(process.env.MIN_AVG_MOVE_MS || 35),
  uniformCheckMinMoves: Number(process.env.UNIFORM_CHECK_MIN_MOVES || 20),
  minTimingVarianceMs: Number(process.env.MIN_TIMING_VARIANCE_MS || 8),
  walletCooldownMs: Number(process.env.WALLET_COOLDOWN_MS || 20_000)
};

export function buildChunkCommits(moves = [], moveTimingsMs = [], chunkSize = ANTI_ASSIST_DEFAULTS.moveChunkSize) {
  const chunks = [];
  let prevChunkHash = '0x0';
  for (let i = 0; i < moves.length; i += chunkSize) {
    const chunkMoves = moves.slice(i, i + chunkSize);
    const chunkTimings = moveTimingsMs.slice(i, i + chunkSize);
    const moveRecords = chunkMoves.map((move, idx) => `${i + idx}:${move}:${chunkTimings[idx] ?? 0}`);
    const movesHash = `0x${sha256Hex(moveRecords.join('|'))}`;
    const startMove = i;
    const endMove = i + chunkMoves.length - 1;
    const chunkHash = `0x${sha256Hex(`${prevChunkHash}|${startMove}|${endMove}|${movesHash}`)}`;
    chunks.push({ index: chunks.length, startMove, endMove, moveCount: chunkMoves.length, movesHash, prevChunkHash, chunkHash });
    prevChunkHash = chunkHash;
  }
  return chunks;
}

export function validateChunkCommits({ moves = [], moveTimingsMs = [], chunks = [] }, settings = ANTI_ASSIST_DEFAULTS) {
  const expected = buildChunkCommits(moves, moveTimingsMs, settings.moveChunkSize);
  if (!Array.isArray(chunks) || chunks.length !== expected.length) {
    return { ok: false, code: 'CHUNK_COUNT_MISMATCH', message: `Expected ${expected.length} chunks, got ${Array.isArray(chunks) ? chunks.length : 0}` };
  }

  for (let i = 0; i < expected.length; i++) {
    const got = chunks[i] || {};
    const exp = expected[i];
    if (got.index !== exp.index || got.startMove !== exp.startMove || got.endMove !== exp.endMove || got.moveCount !== exp.moveCount) {
      return { ok: false, code: 'CHUNK_METADATA_INVALID', message: `Chunk ${i} metadata mismatch` };
    }
    if (got.prevChunkHash !== exp.prevChunkHash) {
      return { ok: false, code: 'CHUNK_CHAIN_BROKEN', message: `Chunk ${i} prev hash mismatch` };
    }
    if (got.movesHash !== exp.movesHash || got.chunkHash !== exp.chunkHash) {
      return { ok: false, code: 'CHUNK_HASH_INVALID', message: `Chunk ${i} hash mismatch` };
    }
  }

  return { ok: true };
}

export function createWalletCooldownGate(cooldownMs = ANTI_ASSIST_DEFAULTS.walletCooldownMs) {
  const walletRunCooldown = new Map();
  return {
    checkAndTouch(wallet, nowMs = Date.now()) {
      const cooldownEndsAt = walletRunCooldown.get(wallet) || 0;
      if (nowMs < cooldownEndsAt) {
        return { ok: false, code: 'WALLET_COOLDOWN_ACTIVE', retryAfterMs: cooldownEndsAt - nowMs, cooldownMs };
      }
      walletRunCooldown.set(wallet, nowMs + cooldownMs);
      return { ok: true, cooldownMs };
    }
  };
}

export function validateTimingEnvelope({ runStartedAt, moves = [], moveTimingsMs = [] }, nowMs = Date.now(), settings = ANTI_ASSIST_DEFAULTS) {
  if (!runStartedAt) {
    return { ok: false, code: 'RUN_STARTED_AT_REQUIRED', message: 'runStartedAt is required for anti-assist verification' };
  }
  const startedAtMs = Date.parse(runStartedAt);
  if (!Number.isFinite(startedAtMs)) {
    return { ok: false, code: 'RUN_STARTED_AT_INVALID', message: 'runStartedAt must be an ISO timestamp' };
  }

  const elapsedMs = nowMs - startedAtMs;
  const ttlExpired = elapsedMs > settings.runTtlMs;

  if (!Array.isArray(moveTimingsMs) || moveTimingsMs.length !== moves.length) {
    return { ok: false, code: 'MOVE_TIMINGS_REQUIRED', message: 'moveTimingsMs[] must be provided for every move' };
  }

  if (moveTimingsMs.some((v) => !Number.isFinite(v) || v < 0)) {
    return { ok: false, code: 'MOVE_TIMINGS_INVALID', message: 'moveTimingsMs[] entries must be non-negative numbers' };
  }

  const totalMoves = moves.length;
  const sumMoveMs = moveTimingsMs.reduce((a, b) => a + b, 0);
  const avgMoveMs = totalMoves > 0 ? sumMoveMs / totalMoves : elapsedMs;

  if (totalMoves > 0) {
    if (elapsedMs < settings.minRunDurationMs || avgMoveMs < settings.minAverageMoveMs) {
      return { ok: false, code: 'TIMING_TOO_FAST', message: 'Run timing is unrealistically fast' };
    }

    if (totalMoves >= settings.uniformCheckMinMoves) {
      const mean = avgMoveMs;
      const variance = moveTimingsMs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / totalMoves;
      const std = Math.sqrt(variance);
      if (std < settings.minTimingVarianceMs) {
        return { ok: false, code: 'TIMING_TOO_UNIFORM', message: 'Move timings are suspiciously uniform' };
      }
    }
  }

  return { ok: true, startedAtMs, elapsedMs, avgMoveMs, ttlExpired };
}
