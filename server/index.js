import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replayRun, makeMockAttestation, hashAttestation, sha256Hex } from './game2048.js';
import { addressFromContractId } from '@alephium/web3';
import { ANTI_ASSIST_DEFAULTS, createWalletCooldownGate, validateChunkCommits, validateTimingEnvelope } from './antiAssist.js';

const app = express();
const PORT = process.env.PORT || 8787;
const CHANNEL = process.env.GAME_CHANNEL || 'prod';
const CONTRACT_ID = process.env.CONTRACT_ID || 'unassigned';
const VERIFIER_KEY_VERSION = process.env.VERIFIER_KEY_VERSION || 'mvp-v1';
const IS_BETA = CHANNEL === 'beta';

function envFlag(name, betaDefault = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return betaDefault && IS_BETA;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const FLAGS = {
  lockLeaderboardRecord: envFlag('BETA_LOCK_LEADERBOARD_RECORD', true),
  strictVerify: envFlag('BETA_STRICT_VERIFY', true),
  rateLimit: envFlag('BETA_RATE_LIMIT', true),
  recordRequireTxOnChain: envFlag('BETA_RECORD_REQUIRE_TX_ONCHAIN', true),
  requireWriteSession: envFlag('BETA_REQUIRE_WRITE_SESSION', true)
};

const walletCooldownGate = createWalletCooldownGate(ANTI_ASSIST_DEFAULTS.walletCooldownMs);

const leaderboardPath = process.env.LEADERBOARD_PATH || path.join(process.cwd(), 'server', 'leaderboard.json');
let leaderboardWriteChain = Promise.resolve();
const metrics = {
  startRunErrors: {},
  verifyErrors: {},
  submitRecords: 0,
  recordRejected: {},
  strictVerifyRejected: {},
  rateLimit: { hits: 0, blocked: 0, byRoute: {} }
};

const verifyTicketStore = new Map();
const writeSessionStore = new Map();
const VERIFY_TICKET_TTL_MS = Number(process.env.VERIFY_TICKET_TTL_MS || 5 * 60 * 1000);
const WRITE_SESSION_TTL_MS = Number(process.env.WRITE_SESSION_TTL_MS || 15 * 60 * 1000);
const VERIFY_TICKET_SECRET = process.env.VERIFY_TICKET_SECRET || `${CONTRACT_ID}:${CHANNEL}:verify-ticket-secret`;
const WRITE_SESSION_SECRET = process.env.WRITE_SESSION_SECRET || `${CONTRACT_ID}:${CHANNEL}:write-session-secret`;
const NODE_API_URL = process.env.NODE_API_URL || process.env.TESTNET_NODE_URL || 'https://node.testnet.alephium.org';
const TRUST_XFF = envFlag('TRUST_X_FORWARDED_FOR', false);
const MAX_VERIFY_TICKETS = Number(process.env.MAX_VERIFY_TICKETS || 5000);
const MAX_WRITE_SESSIONS = Number(process.env.MAX_WRITE_SESSIONS || 5000);
const MAX_RATE_LIMIT_ENTRIES = Number(process.env.MAX_RATE_LIMIT_ENTRIES || 20000);

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = Number(process.env.BETA_RATE_LIMIT_WINDOW_MS || 10_000);
const RATE_LIMIT_MAX = {
  '/api/verify': Number(process.env.BETA_RATE_LIMIT_VERIFY_MAX || 12),
  '/api/leaderboard/record': Number(process.env.BETA_RATE_LIMIT_RECORD_MAX || 8),
  '/api/run/start': Number(process.env.BETA_RATE_LIMIT_RUN_START_MAX || 10)
};

function metricInc(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function shortWallet(wallet) {
  if (!wallet || wallet.length < 12) return wallet || 'unknown';
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function loadLeaderboard() {
  try {
    const raw = fs.readFileSync(leaderboardPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return parsed;
  } catch {
    // use default
  }
  return { entries: [] };
}

function saveLeaderboard(board) {
  fs.mkdirSync(path.dirname(leaderboardPath), { recursive: true });
  fs.writeFileSync(leaderboardPath, JSON.stringify(board, null, 2) + '\n');
}

function entriesForCurrentContract(board) {
  return (board?.entries || []).filter((e) => String(e?.contractId || '') === String(CONTRACT_ID));
}

function pruneCurrentPartition(board, maxPerPartition = 1000) {
  const all = Array.isArray(board?.entries) ? board.entries : [];
  const current = all
    .filter((e) => String(e?.contractId || '') === String(CONTRACT_ID))
    .sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)
    .slice(0, maxPerPartition);
  const others = all.filter((e) => String(e?.contractId || '') !== String(CONTRACT_ID));
  board.entries = [...others, ...current];
}

function withLeaderboardWriteLock(fn) {
  leaderboardWriteChain = leaderboardWriteChain.then(fn, fn);
  return leaderboardWriteChain;
}

async function getTxDetailsFromNode(txId) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(`${NODE_API_URL.replace(/\/$/, '')}/transactions/details/${txId}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.status === 404) return { found: false };
    if (!res.ok) return { found: null };
    const details = await res.json();
    return { found: true, details };
  } catch {
    return { found: null }; // unknown (node temporarily unavailable)
  }
}

function txMatchesCurrentContract(details) {
  try {
    const expected = addressFromContractId(CONTRACT_ID);
    const outs = Array.isArray(details?.generatedOutputs) ? details.generatedOutputs : [];
    return outs.some((o) => String(o?.address || '') === String(expected));
  } catch {
    return false;
  }
}

function cleanupVerifyTickets(now = Date.now()) {
  for (const [token, rec] of verifyTicketStore.entries()) {
    if (rec.expiresAt <= now) verifyTicketStore.delete(token);
  }
  if (verifyTicketStore.size > MAX_VERIFY_TICKETS) {
    const overflow = verifyTicketStore.size - MAX_VERIFY_TICKETS;
    let i = 0;
    for (const key of verifyTicketStore.keys()) {
      verifyTicketStore.delete(key);
      i += 1;
      if (i >= overflow) break;
    }
  }
}

function cleanupWriteSessions(now = Date.now()) {
  for (const [token, rec] of writeSessionStore.entries()) {
    if (rec.expiresAt <= now) writeSessionStore.delete(token);
  }
  if (writeSessionStore.size > MAX_WRITE_SESSIONS) {
    const overflow = writeSessionStore.size - MAX_WRITE_SESSIONS;
    let i = 0;
    for (const key of writeSessionStore.keys()) {
      writeSessionStore.delete(key);
      i += 1;
      if (i >= overflow) break;
    }
  }
}

function signWriteSessionPayload(payload) {
  return crypto.createHmac('sha256', WRITE_SESSION_SECRET).update(payload).digest('base64url');
}

function encodeWriteSession(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = signWriteSessionPayload(payload);
  return `${payload}.${sig}`;
}

function decodeWriteSession(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = signWriteSessionPayload(payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = parseB64urlJson(payload);
    if (!data || Number(data.expiresAt || 0) <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function mintWriteSession(wallet) {
  const now = Date.now();
  cleanupWriteSessions(now);
  const payload = {
    wallet: String(wallet || ''),
    createdAt: now,
    expiresAt: now + WRITE_SESSION_TTL_MS,
    channel: CHANNEL,
    contractId: CONTRACT_ID
  };
  const token = encodeWriteSession(payload);
  writeSessionStore.set(token, payload);
  return token;
}

function getWriteSession(token) {
  cleanupWriteSessions();
  const rec = writeSessionStore.get(String(token || ''));
  if (rec) return rec;
  return decodeWriteSession(token);
}

const b64url = (v) => Buffer.from(v).toString('base64url');
const parseB64urlJson = (v) => JSON.parse(Buffer.from(String(v || ''), 'base64url').toString('utf8'));

function signTicketPayload(payload) {
  return crypto.createHmac('sha256', VERIFY_TICKET_SECRET).update(payload).digest('base64url');
}

function encodeVerifyTicket(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = signTicketPayload(payload);
  return `${payload}.${sig}`;
}

function decodeVerifyTicket(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = signTicketPayload(payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = parseB64urlJson(payload);
    if (!data || Number(data.expiresAt || 0) <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function mintVerifyTicket({ runIdHash, wallet, score, attestationHash }) {
  const now = Date.now();
  cleanupVerifyTickets(now);
  const payload = {
    runIdHash,
    wallet: String(wallet || ''),
    score: Number(score),
    attestationHash,
    createdAt: now,
    expiresAt: now + VERIFY_TICKET_TTL_MS,
    channel: CHANNEL,
    contractId: CONTRACT_ID
  };
  const token = encodeVerifyTicket(payload);
  verifyTicketStore.set(token, { ...payload, used: false });
  return token;
}

function getVerifyTicket(token) {
  cleanupVerifyTickets();
  const rec = verifyTicketStore.get(token);
  if (rec) {
    if (rec.used) return { ok: false, code: 'VERIFY_TICKET_ALREADY_USED', message: 'verify ticket already used' };
    return { ok: true, ticket: rec };
  }

  // restart-safe fallback: validate signed stateless ticket payload
  const decoded = decodeVerifyTicket(token);
  if (!decoded) return { ok: false, code: 'VERIFY_TICKET_REQUIRED', message: 'verify ticket is missing or expired' };
  return { ok: true, ticket: decoded };
}

function markVerifyTicketUsed(token) {
  const now = Date.now();
  const rec = verifyTicketStore.get(token);
  if (rec) rec.used = true;
  else {
    const decoded = decodeVerifyTicket(token);
    if (decoded) verifyTicketStore.set(token, { ...decoded, used: true, expiresAt: decoded.expiresAt || now + VERIFY_TICKET_TTL_MS });
  }
}

function getClientIp(req) {
  if (TRUST_XFF) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function cleanupRateLimitStore(now = Date.now()) {
  for (const [k, rec] of rateLimitStore.entries()) {
    if (!rec || now >= Number(rec.resetAt || 0)) rateLimitStore.delete(k);
  }
  if (rateLimitStore.size > MAX_RATE_LIMIT_ENTRIES) {
    const overflow = rateLimitStore.size - MAX_RATE_LIMIT_ENTRIES;
    let i = 0;
    for (const key of rateLimitStore.keys()) {
      rateLimitStore.delete(key);
      i += 1;
      if (i >= overflow) break;
    }
  }
}

function rateLimitMiddleware(req, res, next) {
  if (!FLAGS.rateLimit) return next();
  const route = req.path;
  const max = RATE_LIMIT_MAX[route];
  if (!max) return next();

  metrics.rateLimit.hits += 1;
  metricInc(metrics.rateLimit.byRoute, `${route}:hits`);

  const now = Date.now();
  cleanupRateLimitStore(now);
  const ip = getClientIp(req);
  const key = `${route}|${ip}`;
  const rec = rateLimitStore.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now >= rec.resetAt) {
    rec.count = 0;
    rec.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  rec.count += 1;
  rateLimitStore.set(key, rec);

  const remaining = Math.max(0, max - rec.count);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rec.resetAt / 1000)));

  if (rec.count > max) {
    metrics.rateLimit.blocked += 1;
    metricInc(metrics.rateLimit.byRoute, `${route}:blocked`);
    return res.status(429).json({
      ok: false,
      errorCode: 'RATE_LIMITED',
      error: 'Too many requests; slow down and retry',
      retryAfterMs: Math.max(0, rec.resetAt - now)
    });
  }
  return next();
}

function strictVerifyValidate(body) {
  const { runId, runIdHash, wallet, seed, seedHash, moves, score, runStartedAt, moveTimingsMs, moveChunks } = body || {};

  if (typeof runId !== 'string' || runId.length < 4 || runId.length > 128) {
    return { ok: false, code: 'RUN_ID_INVALID', message: 'runId must be a string between 4 and 128 chars' };
  }
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 256) {
    return { ok: false, code: 'SEED_INVALID', message: 'seed must be a non-empty string up to 256 chars' };
  }
  if (!Array.isArray(moves) || moves.length > 4096 || moves.some((m) => !['up', 'down', 'left', 'right'].includes(m))) {
    return { ok: false, code: 'MOVES_INVALID', message: 'moves[] must contain only up/down/left/right and be <= 4096' };
  }
  if (!Number.isInteger(score) || score < 0 || score > 100_000_000) {
    return { ok: false, code: 'SCORE_INVALID', message: 'score must be an integer between 0 and 100000000' };
  }
  if (wallet != null && (typeof wallet !== 'string' || wallet.length < 8 || wallet.length > 128)) {
    return { ok: false, code: 'WALLET_INVALID', message: 'wallet must be a string between 8 and 128 chars' };
  }

  const hex64 = /^0x[a-f0-9]{64}$/i;
  if (runIdHash != null && (typeof runIdHash !== 'string' || !hex64.test(runIdHash))) {
    return { ok: false, code: 'RUN_ID_HASH_INVALID', message: 'runIdHash must be 0x-prefixed 32-byte hex' };
  }
  if (seedHash != null && (typeof seedHash !== 'string' || !hex64.test(seedHash))) {
    return { ok: false, code: 'SEED_HASH_INVALID', message: 'seedHash must be 0x-prefixed 32-byte hex' };
  }

  if (typeof runStartedAt !== 'string' || !Number.isFinite(Date.parse(runStartedAt))) {
    return { ok: false, code: 'RUN_STARTED_AT_INVALID', message: 'runStartedAt must be ISO timestamp' };
  }
  if (!Array.isArray(moveTimingsMs) || moveTimingsMs.length !== moves.length) {
    return { ok: false, code: 'MOVE_TIMINGS_REQUIRED', message: 'moveTimingsMs[] length must match moves[]' };
  }
  if (!Array.isArray(moveChunks) || moveChunks.length > Math.ceil((moves.length || 1) / Math.max(1, ANTI_ASSIST_DEFAULTS.moveChunkSize))) {
    return { ok: false, code: 'MOVE_CHUNKS_INVALID', message: 'moveChunks[] malformed' };
  }
  return { ok: true };
}

const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Non-browser requests (no origin) are allowed.
    if (!origin) return cb(null, true);

    // On beta, default to strict known game origins unless overridden by env list.
    const betaDefaults = [
      'https://alph2048daily.aigames.alehpium.org',
      'https://alph2048.aigames.alehpium.org',
      // wallet/explorer embedded browser contexts seen during signing flows
      'https://testnet.alephium.org',
      'https://explorer.alephium.org'
    ];
    const allowList = CORS_ALLOWED_ORIGINS.length ? CORS_ALLOWED_ORIGINS : (IS_BETA ? betaDefaults : []);

    if (!allowList.length) return cb(null, true);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  }
}));
app.use(express.json({ limit: '300kb' }));
app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  next();
});
app.use(rateLimitMiddleware);

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    service: '2048-verifier-mvp',
    channel: CHANNEL,
    contractId: CONTRACT_ID,
    verifierKeyVersion: VERIFIER_KEY_VERSION,
    flags: FLAGS,
    antiAssist: {
      runTtlMs: ANTI_ASSIST_DEFAULTS.runTtlMs,
      moveChunkSize: ANTI_ASSIST_DEFAULTS.moveChunkSize,
      walletCooldownMs: ANTI_ASSIST_DEFAULTS.walletCooldownMs,
      minRunDurationMs: ANTI_ASSIST_DEFAULTS.minRunDurationMs,
      minAverageMoveMs: ANTI_ASSIST_DEFAULTS.minAverageMoveMs,
      uniformCheckMinMoves: ANTI_ASSIST_DEFAULTS.uniformCheckMinMoves,
      minTimingVarianceMs: ANTI_ASSIST_DEFAULTS.minTimingVarianceMs
    }
  });
});

const leaderboardHandler = (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
  const board = loadLeaderboard();
  const scoped = entriesForCurrentContract(board);

  const wonByWallet = new Map();
  for (const e of scoped) {
    const w = String(e?.wallet || '').toLowerCase();
    if (!w) continue;
    let won = 0n;
    try { won = BigInt(e?.amountWonAtto || 0); } catch { won = 0n; }
    wonByWallet.set(w, (wonByWallet.get(w) || 0n) + won);
  }

  // Leaderboard is rank-based by score across all submissions (no winner-only filter).
  const sorted = [...scoped].sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);

  const top = sorted.slice(0, limit).map((entry, idx) => ({
    ...entry,
    rank: idx + 1,
    walletTotalWonAtto: String(wonByWallet.get(String(entry.wallet || '').toLowerCase()) || 0n)
  }));
  res.json({ ok: true, total: sorted.length, entries: top });
};

const leaderboardRecentHandler = (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const board = loadLeaderboard();
  const scoped = entriesForCurrentContract(board);
  const recent = [...scoped]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
  res.json({ ok: true, total: scoped.length, entries: recent });
};

const leaderboardWalletHandler = (req, res) => {
  const wallet = String(req.params.wallet || '');
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const board = loadLeaderboard();
  const scoped = entriesForCurrentContract(board);
  const normalizedWallet = wallet.toLowerCase();

  const sortedGlobal = [...scoped].sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);
  const rankByTx = new Map();
  sortedGlobal.forEach((e, idx) => {
    if (e?.txId) rankByTx.set(String(e.txId), idx + 1);
  });

  const rows = scoped
    .filter((e) => String(e.wallet || '').toLowerCase() === normalizedWallet)
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .map((e) => ({ ...e, rank: rankByTx.get(String(e.txId)) || null }))
    .slice(0, limit);

  const bestRank = rows.reduce((best, e) => {
    const r = Number(e?.rank || 0);
    if (!r) return best;
    return best ? Math.min(best, r) : r;
  }, null);

  res.json({ ok: true, wallet, total: rows.length, bestRank, entries: rows });
};

const economyHandler = (_, res) => {
  const board = loadLeaderboard();
  const scoped = entriesForCurrentContract(board);
  const top = [...scoped].sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)[0] || null;
  const last = [...scoped].sort((a, b) => b.timestamp - a.timestamp)[0] || null;
  res.json({
    ok: true,
    channel: CHANNEL,
    contractId: CONTRACT_ID,
    topScore: top?.score || 0,
    topHolder: top?.wallet || null,
    submissionsTotal: scoped.length,
    lastSubmissionAt: last?.timestamp || null,
    metrics
  });
};

const leaderboardRecordHandler = async (req, res) => {
  const { wallet, score, txId, runIdHash, entryFeePaidAtto, amountWonAtto, payoutEstimateAtto, verifyTicket, attestationHash, writeSessionToken } = req.body || {};
  console.info('[record]', { requestId: req.requestId, channel: CHANNEL, contractId: CONTRACT_ID, wallet: shortWallet(wallet), score, txId: String(txId || '').slice(0, 12) });
  if (!wallet || typeof score !== 'number' || !txId) {
    metricInc(metrics.recordRejected, 'RECORD_FIELDS_REQUIRED');
    return res.status(400).json({ ok: false, errorCode: 'RECORD_FIELDS_REQUIRED', error: 'wallet, score, txId are required', requestId: req.requestId });
  }
  if (!/^[a-fA-F0-9]{64}$/.test(String(txId))) {
    metricInc(metrics.recordRejected, 'TXID_INVALID');
    return res.status(400).json({ ok: false, errorCode: 'TXID_INVALID', error: 'txId must be 64 hex chars', requestId: req.requestId });
  }

  if (FLAGS.requireWriteSession) {
    const ws = getWriteSession(writeSessionToken);
    if (!ws) {
      metricInc(metrics.recordRejected, 'WRITE_SESSION_REQUIRED');
      return res.status(403).json({ ok: false, errorCode: 'WRITE_SESSION_REQUIRED', error: 'start a ranked run first (missing/expired write session)', requestId: req.requestId });
    }
    if (String(ws.wallet || '') !== String(wallet || '')) {
      metricInc(metrics.recordRejected, 'WRITE_SESSION_WALLET_MISMATCH');
      return res.status(403).json({ ok: false, errorCode: 'WRITE_SESSION_WALLET_MISMATCH', error: 'write session wallet mismatch', requestId: req.requestId });
    }
  }

  if (FLAGS.recordRequireTxOnChain) {
    let txProbe = await getTxDetailsFromNode(String(txId));
    // node index can lag right after submit; retry briefly before failing
    if (txProbe.found === false) {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 700));
        txProbe = await getTxDetailsFromNode(String(txId));
        if (txProbe.found !== false) break;
      }
    }

    if (txProbe.found === false) {
      metricInc(metrics.recordRejected, 'TXID_NOT_FOUND_ON_NODE');
      return res.status(400).json({ ok: false, errorCode: 'TXID_NOT_FOUND_ON_NODE', error: 'txId not found on node', requestId: req.requestId });
    }
    if (txProbe.found === true) {
      if (txProbe.details?.scriptExecutionOk === false) {
        metricInc(metrics.recordRejected, 'TX_SCRIPT_EXECUTION_FAILED');
        return res.status(400).json({ ok: false, errorCode: 'TX_SCRIPT_EXECUTION_FAILED', error: 'tx script execution failed', requestId: req.requestId });
      }
      // NOTE: Skip strict contract-address matching here for script txs; node details do not
      // always expose a direct contract output address for submit flows.
      // Keep tx existence + scriptExecutionOk checks as the current safe baseline.

    }
  }

  if (FLAGS.lockLeaderboardRecord) {
    const token = String(verifyTicket || '');
    const ticketResult = getVerifyTicket(token);
    if (!ticketResult.ok) {
      metricInc(metrics.recordRejected, ticketResult.code);
      return res.status(403).json({ ok: false, errorCode: ticketResult.code, error: ticketResult.message, requestId: req.requestId });
    }
    const t = ticketResult.ticket;
    if (
      t.runIdHash !== String(runIdHash || '') ||
      t.wallet !== String(wallet || '') ||
      t.score !== Number(score) ||
      t.attestationHash !== String(attestationHash || '')
    ) {
      metricInc(metrics.recordRejected, 'VERIFY_TICKET_MISMATCH');
      return res.status(403).json({ ok: false, errorCode: 'VERIFY_TICKET_MISMATCH', error: 'ticket does not match record payload', requestId: req.requestId });
    }
    // mark used only after payload match succeeds
    markVerifyTicketUsed(token);
  }

  return withLeaderboardWriteLock(() => {
    const board = loadLeaderboard();
    const scoped = entriesForCurrentContract(board);
    const existingIndex = board.entries.findIndex((e) => e.txId === txId && String(e?.contractId || '') === String(CONTRACT_ID));
    if (existingIndex >= 0) {
      const sortedExisting = [...scoped].sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);
      const rankExisting = sortedExisting.findIndex((e) => e.txId === txId) + 1;
      return res.json({ ok: true, deduped: true, entry: board.entries[existingIndex], rank: rankExisting, newHighScore: false, topScore: sortedExisting[0]?.score || 0, requestId: req.requestId });
    }

    const beforeTop = scoped.length ? Math.max(...scoped.map((e) => e.score || 0)) : 0;
    const newHighScore = score > beforeTop;

    let payoutAtto = 0n;
    try {
      if (newHighScore) {
        // beta hardening: ignore raw amountWonAtto from client; accept only payout estimate lane.
        payoutAtto = BigInt(payoutEstimateAtto || 0);
        if (payoutAtto < 0n) payoutAtto = 0n;
      }
    } catch {
      payoutAtto = 0n;
    }

    const entry = {
      wallet,
      walletShort: shortWallet(wallet),
      score,
      txId,
      runIdHash: runIdHash || null,
      entryFeePaidAtto: entryFeePaidAtto != null ? String(entryFeePaidAtto) : null,
      amountWonAtto: String(payoutAtto),
      payoutSource: newHighScore ? 'client-estimate' : 'none',
      timestamp: Date.now(),
      channel: CHANNEL,
      contractId: CONTRACT_ID
    };

    board.entries.push(entry);
    pruneCurrentPartition(board, 1000);
    saveLeaderboard(board);

    metrics.submitRecords += 1;
    const sorted = entriesForCurrentContract(board).sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);
    const rank = sorted.findIndex((e) => e.txId === txId) + 1;

    return res.json({ ok: true, entry, rank, newHighScore, topScore: sorted[0]?.score || score, requestId: req.requestId });
  });
};

app.get('/api/leaderboard', leaderboardHandler);
app.get('/leaderboard', leaderboardHandler);
app.get('/api/leaderboard/recent', leaderboardRecentHandler);
app.get('/leaderboard/recent', leaderboardRecentHandler);
app.get('/api/leaderboard/wallet/:wallet', leaderboardWalletHandler);
app.get('/leaderboard/wallet/:wallet', leaderboardWalletHandler);
app.get('/api/economy', economyHandler);
app.get('/economy', economyHandler);
app.post('/api/leaderboard/record', leaderboardRecordHandler);
app.post('/leaderboard/record', leaderboardRecordHandler);

const startRunGateHandler = (req, res) => {
  const { wallet } = req.body || {};
  console.info('[run.start]', { requestId: req.requestId, wallet: shortWallet(wallet), channel: CHANNEL, contractId: CONTRACT_ID });
  if (!wallet) {
    metrics.startRunErrors.WALLET_REQUIRED = (metrics.startRunErrors.WALLET_REQUIRED || 0) + 1;
    return res.status(400).json({ ok: false, errorCode: 'WALLET_REQUIRED', error: 'wallet is required', requestId: req.requestId });
  }

  const now = Date.now();
  const gate = walletCooldownGate.checkAndTouch(wallet, now);
  if (!gate.ok) {
    metrics.startRunErrors[gate.code] = (metrics.startRunErrors[gate.code] || 0) + 1;
    return res.status(429).json({
      ok: false,
      errorCode: gate.code,
      error: 'Please wait before starting another ranked run',
      retryAfterMs: gate.retryAfterMs,
      cooldownMs: gate.cooldownMs,
      requestId: req.requestId
    });
  }

  const writeSessionToken = FLAGS.requireWriteSession ? mintWriteSession(wallet) : null;
  return res.json({ ok: true, cooldownMs: gate.cooldownMs, startedAt: new Date(now).toISOString(), writeSessionToken, requestId: req.requestId });
};

app.post('/api/run/start', startRunGateHandler);
app.post('/run/start', startRunGateHandler);

const refreshWriteSessionHandler = (req, res) => {
  const { wallet } = req.body || {};
  if (!wallet) {
    return res.status(400).json({ ok: false, errorCode: 'WALLET_REQUIRED', error: 'wallet is required', requestId: req.requestId });
  }
  const writeSessionToken = mintWriteSession(wallet);
  return res.json({ ok: true, writeSessionToken, requestId: req.requestId });
};

app.post('/api/run/session', refreshWriteSessionHandler);
app.post('/run/session', refreshWriteSessionHandler);

const verifyHandler = (req, res) => {
  const { runId, runIdHash, wallet, seed, seedHash, moves, score, runStartedAt, moveTimingsMs, moveChunks, writeSessionToken } = req.body || {};
  console.info('[verify]', { requestId: req.requestId, wallet: shortWallet(wallet), moves: Array.isArray(moves) ? moves.length : 0, score, channel: CHANNEL, contractId: CONTRACT_ID });
  if (!runId || !seed || !Array.isArray(moves) || typeof score !== 'number') {
    metrics.verifyErrors.VERIFY_FIELDS_REQUIRED = (metrics.verifyErrors.VERIFY_FIELDS_REQUIRED || 0) + 1;
    return res.status(400).json({ ok: false, errorCode: 'VERIFY_FIELDS_REQUIRED', error: 'Missing required fields: runId, seed, moves[], score', requestId: req.requestId });
  }

  if (FLAGS.requireWriteSession) {
    const ws = getWriteSession(writeSessionToken);
    if (!ws) {
      metricInc(metrics.verifyErrors, 'WRITE_SESSION_REQUIRED');
      return res.status(403).json({ ok: false, errorCode: 'WRITE_SESSION_REQUIRED', error: 'start a ranked run first (missing/expired write session)', requestId: req.requestId });
    }
    if (String(ws.wallet || '') !== String(wallet || '')) {
      metricInc(metrics.verifyErrors, 'WRITE_SESSION_WALLET_MISMATCH');
      return res.status(403).json({ ok: false, errorCode: 'WRITE_SESSION_WALLET_MISMATCH', error: 'write session wallet mismatch', requestId: req.requestId });
    }
  }

  if (FLAGS.strictVerify) {
    const strict = strictVerifyValidate(req.body || {});
    if (!strict.ok) {
      metricInc(metrics.strictVerifyRejected, strict.code);
      return res.status(400).json({ ok: false, errorCode: strict.code, error: strict.message, requestId: req.requestId });
    }
  }

  const timingCheck = validateTimingEnvelope({ runStartedAt, moves, moveTimingsMs }, Date.now(), ANTI_ASSIST_DEFAULTS);
  if (!timingCheck.ok) {
    metrics.verifyErrors[timingCheck.code] = (metrics.verifyErrors[timingCheck.code] || 0) + 1;
    return res.status(422).json({ ok: false, errorCode: timingCheck.code, error: timingCheck.message, requestId: req.requestId });
  }

  const chunkCheck = validateChunkCommits({ moves, moveTimingsMs, chunks: moveChunks }, ANTI_ASSIST_DEFAULTS);
  if (!chunkCheck.ok) {
    metrics.verifyErrors[chunkCheck.code] = (metrics.verifyErrors[chunkCheck.code] || 0) + 1;
    return res.status(422).json({ ok: false, errorCode: chunkCheck.code, error: chunkCheck.message, requestId: req.requestId });
  }

  const replay = replayRun({ seed, moves });
  const valid = replay.score === score;

  const attestationPayload = {
    runId,
    runIdHash: runIdHash || `0x${sha256Hex(runId)}`,
    wallet: wallet || 'unknown-wallet',
    channel: CHANNEL,
    contractId: CONTRACT_ID,
    seedHash: seedHash || `0x${sha256Hex(seed)}`,
    antiAssist: {
      runTtlMs: ANTI_ASSIST_DEFAULTS.runTtlMs,
      chunkSize: ANTI_ASSIST_DEFAULTS.moveChunkSize,
      elapsedMs: timingCheck.elapsedMs,
      avgMoveMs: timingCheck.avgMoveMs,
      ttlExpired: Boolean(timingCheck.ttlExpired)
    },
    valid,
    expectedScore: replay.score,
    providedScore: score,
    verifierKeyVersion: VERIFIER_KEY_VERSION,
    ts: new Date().toISOString()
  };

  const attestation = makeMockAttestation(attestationPayload);
  const attestationHash = hashAttestation(attestation);
  const verifyTicket = (FLAGS.lockLeaderboardRecord && valid)
    ? mintVerifyTicket({ runIdHash: attestationPayload.runIdHash, wallet: attestationPayload.wallet, score, attestationHash })
    : null;

  res.json({
    ok: true,
    valid,
    expectedScore: replay.score,
    providedScore: score,
    finalBoard: replay.board,
    attestation,
    attestationHash,
    verifyTicket,
    requestId: req.requestId,
    verifierKeyVersion: VERIFIER_KEY_VERSION,
    channel: CHANNEL,
    contractId: CONTRACT_ID,
    antiAssist: attestationPayload.antiAssist,
    submitPayload: {
      runIdHash: runIdHash || `0x${sha256Hex(runId)}`,
      score,
      attestationHash,
      verifyTicket
    },
    submitContext: {
      contractId: CONTRACT_ID,
      channel: CHANNEL
    }
  });
};

app.post('/api/verify', verifyHandler);
app.post('/verify', verifyHandler);

app.listen(PORT, () => {
  console.log(`Verifier API listening on http://localhost:${PORT}`);
});
