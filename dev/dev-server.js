// dev/dev-server.js
// Локальная копия API «Дележка расходов в поездке» для разработки фронта без
// Cloudflare: тот же роутинг и те же ответы, что в worker/worker.js, только
// поверх встроенного node:sqlite (Node 24, без npm-зависимостей) и node:http.
// Дополнительно раздаёт статику из ../docs по /, чтобы открыть приложение
// в двух вкладках и проверить синхронизацию.
//
// Запуск: node dev/dev-server.js  (слушает http://localhost:8787)

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const SCHEMA_PATH = path.join(__dirname, '..', 'worker', 'schema.sql');

// ---- лимиты — те же, что в worker/worker.js (раздел «API» в SPEC.md) ----
const MAX_OPS_PER_REQUEST = 50;
const MAX_PAYLOAD_BYTES = 4 * 1024;
const MAX_OPS_PER_TRIP = 5000;
const MAX_OPS_PER_GET = 500;
const MAX_BODY_BYTES = 256 * 1024;

const TRIP_ID_LEN = 22;
const TRIP_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const KNOWN_KINDS = new Set([
  'trip.meta',
  'person.add', 'person.rename', 'person.del',
  'cur.set', 'cur.del',
  'expense.add', 'expense.edit', 'expense.del',
  'payment.add', 'payment.del',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// ---- простой лимит частоты по IP — в памяти процесса, без внешних служб ----
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 40;
const rateBuckets = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let arr = rateBuckets.get(ip);
  if (!arr) {
    arr = [];
    rateBuckets.set(ip, arr);
  }
  while (arr.length && now - arr[0] > RATE_LIMIT_WINDOW_MS) arr.shift();
  if (arr.length >= RATE_LIMIT_MAX) return false;
  arr.push(now);
  return true;
}

// ---- verifyInitData: пишет другой человек в worker/telegram.js -----------
// Локальный сервер не обязан уметь проверять телеграм-подпись, но если файл
// уже появился — подхватываем его, чтобы поведение совпадало с воркером.
// Если файла нет (ещё не написан) — initData просто не проверяется.
let verifyInitData = null;
try {
  const mod = await import('../worker/telegram.js');
  if (typeof mod.verifyInitData === 'function') verifyInitData = mod.verifyInitData;
} catch {
  verifyInitData = null;
}

// ---- база -------------------------------------------------------------
const db = new DatabaseSync(':memory:');
const schemaSql = await readFile(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);

// ---- утилиты ------------------------------------------------------------

function makeTripId() {
  const bytes = new Uint8Array(TRIP_ID_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < TRIP_ID_LEN; i++) out += TRIP_ID_ALPHABET[bytes[i] % TRIP_ID_ALPHABET.length];
  return out;
}

function makeOpId() {
  return 'srv-' + crypto.randomUUID();
}

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

function isNonEmptyString(v, maxLen = 4000) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendError(res, code, message, status) {
  sendJson(res, status, { error: code, message });
}

const ERRORS = {
  not_found: (res, msg) => sendError(res, 'not_found', msg, 404),
  too_large: (res, msg) => sendError(res, 'too_large', msg, 413),
  too_many: (res, msg) => sendError(res, 'too_many', msg, 400),
  bad_request: (res, msg) => sendError(res, 'bad_request', msg, 400),
  rate_limited: (res, msg) => sendError(res, 'rate_limited', msg, 429),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        // не обрываем сокет — просто перестаём копить, дочитаем и ответим сами
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooBig, buffer: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}

// ---- обработчики маршрутов ----------------------------------------------

async function handleCreateTrip(req, res) {
  const { tooBig, buffer } = await readBody(req);
  if (tooBig) return ERRORS.too_large(res, 'Тело запроса слишком большое');

  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    return ERRORS.bad_request(res, 'Не удалось разобрать JSON');
  }
  if (!body || typeof body !== 'object') return ERRORS.bad_request(res, 'Ожидался объект {name, base}');

  const name = isNonEmptyString(body.name, 200) ? body.name.trim() : 'Поездка';
  const base = isNonEmptyString(body.base, 10) ? body.base.trim().toUpperCase() : null;
  if (!base || !/^[A-Z]{3,6}$/.test(base)) {
    return ERRORS.bad_request(res, 'Поле base должно быть кодом валюты, например USD или UZS');
  }

  const tripId = makeTripId();
  const now = Date.now();

  db.prepare('INSERT INTO trips (id, created, touched, chat_id, title) VALUES (?, ?, ?, NULL, ?)')
    .run(tripId, now, now, name);

  db.prepare('INSERT INTO ops (op_id, trip_id, kind, payload, author, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(makeOpId(), tripId, 'trip.meta', JSON.stringify({ name, base }), null, now);

  sendJson(res, 200, { tripId });
}

function handleGetTrip(req, res, tripId, url) {
  const trip = db.prepare('SELECT id, title FROM trips WHERE id = ?').get(tripId);
  if (!trip) return ERRORS.not_found(res, 'Поездка не найдена');

  const sinceRaw = url.searchParams.get('since');
  let since = 0;
  if (sinceRaw !== null && sinceRaw !== '') {
    since = Number(sinceRaw);
    if (!Number.isFinite(since) || since < 0 || !Number.isInteger(since)) {
      return ERRORS.bad_request(res, 'Параметр since должен быть целым числом');
    }
  }

  const rows = db.prepare(
    'SELECT seq, op_id, kind, payload, author, ts FROM ops WHERE trip_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).all(tripId, since, MAX_OPS_PER_GET + 1);

  const more = rows.length > MAX_OPS_PER_GET;
  const page = more ? rows.slice(0, MAX_OPS_PER_GET) : rows;

  const ops = page.map((r) => ({
    seq: r.seq,
    id: r.op_id,
    kind: r.kind,
    ts: r.ts,
    author: r.author,
    payload: JSON.parse(r.payload),
  }));

  const seq = ops.length ? ops[ops.length - 1].seq : since;

  sendJson(res, 200, { tripId, title: trip.title, seq, ops, more });
}

async function handlePostOps(req, res, tripId) {
  const trip = db.prepare('SELECT id, title FROM trips WHERE id = ?').get(tripId);
  if (!trip) return ERRORS.not_found(res, 'Поездка не найдена');

  const { tooBig, buffer } = await readBody(req);
  if (tooBig) return ERRORS.too_large(res, 'Тело запроса слишком большое');

  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    return ERRORS.bad_request(res, 'Не удалось разобрать JSON');
  }
  if (!body || typeof body !== 'object') return ERRORS.bad_request(res, 'Ожидался объект {ops, author}');

  const { ops, initData } = body;
  if (!Array.isArray(ops) || ops.length === 0) return ERRORS.bad_request(res, 'Поле ops должно быть непустым массивом');
  if (ops.length > MAX_OPS_PER_REQUEST) {
    return ERRORS.too_many(res, `Слишком много операций в одном запросе (максимум ${MAX_OPS_PER_REQUEST})`);
  }

  let author = isNonEmptyString(body.author, 200) ? body.author.trim() : null;
  if (isNonEmptyString(initData, 8000)) {
    if (!verifyInitData) {
      // telegram.js ещё не написан — локально не можем проверить подпись,
      // доверяем присланному имени, как будто initData не передавали
    } else {
      let verifiedName;
      try {
        verifiedName = await verifyInitData(initData, process.env.BOT_TOKEN);
      } catch {
        verifiedName = null;
      }
      if (!verifiedName) return ERRORS.bad_request(res, 'Подпись Telegram (initData) не прошла проверку');
      author = verifiedName;
    }
  }
  if (!author) return ERRORS.bad_request(res, 'Не указан автор операций');

  const { n: existing } = db.prepare('SELECT COUNT(*) AS n FROM ops WHERE trip_id = ?').get(tripId);
  if (existing + ops.length > MAX_OPS_PER_TRIP) {
    return ERRORS.too_many(res, 'Достигнут потолок операций для этой поездки');
  }

  for (const op of ops) {
    if (!op || typeof op !== 'object') return ERRORS.bad_request(res, 'Каждая операция должна быть объектом');
    if (!isNonEmptyString(op.id, 200)) return ERRORS.bad_request(res, 'У операции должен быть непустой id');
    if (typeof op.kind !== 'string' || !KNOWN_KINDS.has(op.kind)) {
      return ERRORS.bad_request(res, `Неизвестный вид операции: ${String(op.kind)}`);
    }
    if (typeof op.ts !== 'number' || !Number.isFinite(op.ts)) {
      return ERRORS.bad_request(res, 'У операции должно быть числовое поле ts');
    }
    if (op.payload === undefined || typeof op.payload !== 'object' || op.payload === null) {
      return ERRORS.bad_request(res, 'У операции должен быть payload-объект');
    }
    const payloadJson = JSON.stringify(op.payload);
    if (byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
      return ERRORS.too_large(res, `Payload операции ${op.id} превышает ${MAX_PAYLOAD_BYTES} байт`);
    }
  }

  const now = Date.now();
  const applied = [];
  let newTitle = null;
  let lastSeq = null;

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO ops (op_id, trip_id, kind, payload, author, ts)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`
  );

  for (const op of ops) {
    const payloadJson = JSON.stringify(op.payload);
    const row = insertStmt.get(op.id, tripId, op.kind, payloadJson, author, now);
    if (row) {
      applied.push(op.id);
      lastSeq = row.seq;
      if (op.kind === 'trip.meta' && isNonEmptyString(op.payload.name, 200)) {
        newTitle = op.payload.name.trim();
      }
    }
  }

  if (lastSeq === null) {
    const maxRow = db.prepare('SELECT MAX(seq) AS m FROM ops WHERE trip_id = ?').get(tripId);
    lastSeq = (maxRow && maxRow.m) || 0;
  } else if (newTitle !== null) {
    db.prepare('UPDATE trips SET touched = ?, title = ? WHERE id = ?').run(now, newTitle, tripId);
  } else {
    db.prepare('UPDATE trips SET touched = ? WHERE id = ?').run(now, tripId);
  }

  sendJson(res, 200, { seq: lastSeq, applied });
}

function handleHealth(res) {
  sendJson(res, 200, { ok: true, ts: Date.now() });
}

// ---- статика из ../docs -------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\/+$/, '') || '/index.html';
  const filePath = path.normalize(path.join(DOCS_DIR, rel));
  // защита от выхода за пределы docs/ через ../
  if (!filePath.startsWith(DOCS_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Файл не найден: приложение (docs/) ещё не собрано');
  }
}

// ---- сервер ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (!pathname.startsWith('/api/')) {
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);
    return sendError(res, 'not_found', 'Неизвестный путь', 404);
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return ERRORS.rate_limited(res, 'Слишком много запросов, попробуйте чуть позже');
  }

  try {
    if (pathname === '/api/health' && method === 'GET') return handleHealth(res);

    if (pathname === '/api/trip' && method === 'POST') return await handleCreateTrip(req, res);

    let m = pathname.match(/^\/api\/trip\/([^/]+)$/);
    if (m && method === 'GET') return handleGetTrip(req, res, decodeURIComponent(m[1]), url);

    m = pathname.match(/^\/api\/trip\/([^/]+)\/ops$/);
    if (m && method === 'POST') return await handlePostOps(req, res, decodeURIComponent(m[1]));

    m = pathname.match(/^\/api\/tg\/webhook\/([^/]+)$/);
    if (m && method === 'POST') {
      // worker/telegram.js — файл другого разработчика; локально просто
      // подтверждаем приём, не выполняя логику бота.
      await readBody(req);
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 'not_found', 'Неизвестный маршрут', 404);
  } catch (err) {
    console.error('Необработанная ошибка в dev-сервере:', err && err.stack ? err.stack : err);
    return sendError(res, 'bad_request', 'Внутренняя ошибка сервера', 500);
  }
});

server.listen(PORT, () => {
  console.log(`trip-split dev-server слушает http://localhost:${PORT}`);
});
