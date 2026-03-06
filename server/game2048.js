import { createHash } from 'node:crypto';

export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(seedInput) {
  const s = String(seedInput ?? 'default-seed');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sha256Hex(input) {
  return createHash('sha256').update(String(input ?? '')).digest('hex');
}

export function hashAttestation(attestation) {
  return `0x${sha256Hex(attestation)}`;
}

function emptyBoard() {
  return Array.from({ length: 4 }, () => [0, 0, 0, 0]);
}

function availableCells(board) {
  const cells = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (board[r][c] === 0) cells.push([r, c]);
  return cells;
}

function spawnTile(board, rng) {
  const cells = availableCells(board);
  if (!cells.length) return;
  const [r, c] = cells[Math.floor(rng() * cells.length)];
  board[r][c] = rng() < 0.9 ? 2 : 4;
}

function slideAndMerge(line) {
  const compact = line.filter((x) => x !== 0);
  let scoreAdd = 0;
  for (let i = 0; i < compact.length - 1; i++) {
    if (compact[i] !== 0 && compact[i] === compact[i + 1]) {
      compact[i] *= 2;
      scoreAdd += compact[i];
      compact[i + 1] = 0;
    }
  }
  const merged = compact.filter((x) => x !== 0);
  while (merged.length < 4) merged.push(0);
  return { line: merged, scoreAdd };
}

function transpose(board) {
  return board[0].map((_, c) => board.map((row) => row[c]));
}

function reverseRows(board) {
  return board.map((row) => [...row].reverse());
}

function moveBoard(board, dir) {
  let work = board.map((row) => [...row]);
  let transformedBack = (x) => x;

  if (dir === 'up') {
    work = transpose(work);
    transformedBack = (x) => transpose(x);
  } else if (dir === 'down') {
    work = reverseRows(transpose(work));
    transformedBack = (x) => transpose(reverseRows(x));
  } else if (dir === 'right') {
    work = reverseRows(work);
    transformedBack = (x) => reverseRows(x);
  }

  let moved = false;
  let scoreAdd = 0;
  const movedRows = work.map((row) => {
    const { line, scoreAdd: s } = slideAndMerge(row);
    if (line.some((v, i) => v !== row[i])) moved = true;
    scoreAdd += s;
    return line;
  });

  return {
    board: transformedBack(movedRows),
    moved,
    scoreAdd
  };
}

export function replayRun({ seed, moves }) {
  const rng = mulberry32(hashSeed(seed));
  const board = emptyBoard();
  let score = 0;

  spawnTile(board, rng);
  spawnTile(board, rng);

  for (const move of moves || []) {
    if (!['up', 'down', 'left', 'right'].includes(move)) continue;
    const { board: next, moved, scoreAdd } = moveBoard(board, move);
    if (!moved) continue;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) board[r][c] = next[r][c];
    score += scoreAdd;
    spawnTile(board, rng);
  }

  return { score, board };
}

export function makeMockAttestation(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = Buffer.from(`mock-sig:${b64}`).toString('base64url').slice(0, 42);
  return `ALPH_MOCK_ATTESTATION.${b64}.${sig}`;
}
