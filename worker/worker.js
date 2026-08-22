// worker/worker.js
// Cloudflare Worker: API «Дележка расходов в поездке».
// Хранит журнал операций в D1, состояние (кто кому должен) собирают клиенты сами —
// сервер лишь присваивает операциям seq и раздаёт их по порядку. Подробности — в SPEC.md.

import { handleTelegramWebhook, sendDailyDigest, verifyInitData } from './telegram.js';

// ---- лимиты защиты от мусора (раздел «API» в SPEC.md) --------------------
const MAX_OPS_PER_REQUEST = 50;      // операций в одном POST /ops
const MAX_PAYLOAD_BYTES = 4 * 1024;  // payload одной операции
const MAX_OPS_PER_TRIP = 5000;       // операций на поездку суммарно
const MAX_OPS_PER_GET = 500;         // операций за один GET
const MAX_BODY_BYTES = 256 * 1024;   // тело запроса целиком (грубая защита от гигантских POST)

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

// ---- простой лимит частоты по IP: в памяти изолята, без KV ---------------
// Хватает, чтобы отсечь случайный/скриптовый залп запросов с одного адреса;
// изолят живёт недолго и не делится памятью между воркерами — для честной
// защиты от целенаправленной атаки этого мало, но по SPEC достаточно.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 40; // запросов на IP за окно
const rateBuckets = new Map(); // ip -> [timestamps]

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
  // периодическая уборка старых бакетов, чтобы Map не рос бесконечно
  if (rateBuckets.size > 5000) {
    for (const [key, times] of rateBuckets) {
      if (!times.length || now - times[times.length - 1] > RATE_LIMIT_WINDOW_MS * 5) {
        rateBuckets.delete(key);
      }
    }
  }
  return true;
}

// ---- утилиты -------------------------------------------------------------

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders },
  });
}

function errorResponse(code, message, status) {
  return jsonResponse({ error: code, message }, status);
}

const ERRORS = {
  not_found: (msg) => errorResponse('not_found', msg, 404),
  too_large: (msg) => errorResponse('too_large', msg, 413),
  too_many: (msg) => errorResponse('too_many', msg, 400),
  bad_request: (msg) => errorResponse('bad_request', msg, 400),
  rate_limited: (msg) => errorResponse('rate_limited', msg, 429),
};

function makeTripId() {
  const bytes = new Uint8Array(TRIP_ID_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < TRIP_ID_LEN; i++) out += TRIP_ID_ALPHABET[bytes[i] % TRIP_ID_ALPHABET.length];
  return out;
}

function makeOpId() {
  // для служебной операции trip.meta, которую сервер создаёт сам при создании поездки
  return 'srv-' + crypto.randomUUID();
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function isNonEmptyString(v, maxLen = 4000) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

// ---- обработчики маршрутов -------------------------------------------------

async function handleCreateTrip(request, env) {
  let body;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return ERRORS.too_large('Тело запроса слишком большое');
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return ERRORS.bad_request('Не удалось разобрать JSON');
  }
  if (!body || typeof body !== 'object') return ERRORS.bad_request('Ожидался объект {name, base}');

  const name = isNonEmptyString(body.name, 200) ? body.name.trim() : 'Поездка';
  const base = isNonEmptyString(body.base, 10) ? body.base.trim().toUpperCase() : null;
  if (!base || !/^[A-Z]{3,6}$/.test(base)) {
    return ERRORS.bad_request('Поле base должно быть кодом валюты, например USD или UZS');
  }

  const tripId = makeTripId();
  const now = Date.now();

  await env.DB.prepare(
    'INSERT INTO trips (id, created, touched, chat_id, title) VALUES (?, ?, ?, NULL, ?)'
  ).bind(tripId, now, now, name).run();

  // Состояние поездки — целиком свёртка операций, поэтому даже стартовые
  // name/base должны попасть в журнал как обычная операция trip.meta.
  await env.DB.prepare(
    'INSERT INTO ops (op_id, trip_id, kind, payload, author, ts) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(makeOpId(), tripId, 'trip.meta', JSON.stringify({ name, base }), null, now).run();

  return jsonResponse({ tripId });
}

async function handleGetTrip(request, env, tripId, url) {
  const trip = await env.DB.prepare('SELECT id, title FROM trips WHERE id = ?').bind(tripId).first();
  if (!trip) return ERRORS.not_found('Поездка не найдена');

  const sinceRaw = url.searchParams.get('since');
  let since = 0;
  if (sinceRaw !== null && sinceRaw !== '') {
    since = Number(sinceRaw);
    if (!Number.isFinite(since) || since < 0 || !Number.isInteger(since)) {
      return ERRORS.bad_request('Параметр since должен быть целым числом');
    }
  }

  const rows = await env.DB.prepare(
    'SELECT seq, op_id, kind, payload, author, ts FROM ops WHERE trip_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).bind(tripId, since, MAX_OPS_PER_GET + 1).all();

  const results = rows.results || [];
  const more = results.length > MAX_OPS_PER_GET;
  const page = more ? results.slice(0, MAX_OPS_PER_GET) : results;

  const ops = page.map((r) => ({
    seq: r.seq,
    id: r.op_id,
    kind: r.kind,
    ts: r.ts,
    author: r.author,
    payload: JSON.parse(r.payload),
  }));

  const seq = ops.length ? ops[ops.length - 1].seq : since;

  return jsonResponse({ tripId, title: trip.title, seq, ops, more });
}

async function handlePostOps(request, env, tripId) {
  const trip = await env.DB.prepare('SELECT id, title FROM trips WHERE id = ?').bind(tripId).first();
  if (!trip) return ERRORS.not_found('Поездка не найдена');

  let body;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return ERRORS.too_large('Тело запроса слишком большое');
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return ERRORS.bad_request('Не удалось разобрать JSON');
  }
  if (!body || typeof body !== 'object') return ERRORS.bad_request('Ожидался объект {ops, author}');

  const { ops, initData } = body;
  if (!Array.isArray(ops) || ops.length === 0) return ERRORS.bad_request('Поле ops должно быть непустым массивом');
  if (ops.length > MAX_OPS_PER_REQUEST) return ERRORS.too_many(`Слишком много операций в одном запросе (максимум ${MAX_OPS_PER_REQUEST})`);

  // Автор запроса: по умолчанию — присланное имя, но при валидной подписи
  // Telegram сервер подставляет проверенное имя вместо присланного.
  let author = isNonEmptyString(body.author, 200) ? body.author.trim() : null;
  if (isNonEmptyString(initData, 8000)) {
    // verifyInitData возвращает {ok, user:{id, name}} — см. SPEC.md и worker/telegram.js
    let verified = null;
    try {
      verified = await verifyInitData(initData, env.BOT_TOKEN);
    } catch {
      verified = null;
    }
    if (!verified || !verified.ok || !verified.user || !verified.user.name) {
      return ERRORS.bad_request('Подпись Telegram (initData) не прошла проверку');
    }
    author = String(verified.user.name).slice(0, 200);
  }
  if (!author) return ERRORS.bad_request('Не указан автор операций');

  // потолок операций на поездку — грубая проверка до вставки
  const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM ops WHERE trip_id = ?').bind(tripId).first();
  const existing = countRow ? countRow.n : 0;
  if (existing + ops.length > MAX_OPS_PER_TRIP) {
    return ERRORS.too_many('Достигнут потолок операций для этой поездки');
  }

  // валидация каждой операции до записи — чтобы не вставить половину пачки
  for (const op of ops) {
    if (!op || typeof op !== 'object') return ERRORS.bad_request('Каждая операция должна быть объектом');
    if (!isNonEmptyString(op.id, 200)) return ERRORS.bad_request('У операции должен быть непустой id');
    if (typeof op.kind !== 'string' || !KNOWN_KINDS.has(op.kind)) {
      return ERRORS.bad_request(`Неизвестный вид операции: ${String(op.kind)}`);
    }
    if (typeof op.ts !== 'number' || !Number.isFinite(op.ts)) {
      return ERRORS.bad_request('У операции должно быть числовое поле ts');
    }
    if (op.payload === undefined || typeof op.payload !== 'object' || op.payload === null) {
      return ERRORS.bad_request('У операции должен быть payload-объект');
    }
    const payloadJson = JSON.stringify(op.payload);
    if (byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
      return ERRORS.too_large(`Payload операции ${op.id} превышает ${MAX_PAYLOAD_BYTES} байт`);
    }
  }

  const now = Date.now();
  const applied = [];
  let newTitle = null;
  let lastSeq = null;

  for (const op of ops) {
    const payloadJson = JSON.stringify(op.payload);
    const row = await env.DB.prepare(
      `INSERT OR IGNORE INTO ops (op_id, trip_id, kind, payload, author, ts)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`
    ).bind(op.id, tripId, op.kind, payloadJson, author, now).first();

    if (row) {
      applied.push(op.id);
      lastSeq = row.seq;
      if (op.kind === 'trip.meta' && isNonEmptyString(op.payload.name, 200)) {
        newTitle = op.payload.name.trim();
      }
    }
  }

  if (lastSeq === null) {
    // ничего нового не применилось (все операции — уже известные дубли);
    // сообщаем клиенту текущую вершину журнала, чтобы он не топтался на месте
    const maxRow = await env.DB.prepare('SELECT MAX(seq) AS m FROM ops WHERE trip_id = ?').bind(tripId).first();
    lastSeq = (maxRow && maxRow.m) || 0;
  } else {
    // трата/платёж — тоже запись; touched двигаем при любой применённой операции
    const setTitle = newTitle !== null ? ', title = ?' : '';
    const params = newTitle !== null ? [now, newTitle, tripId] : [now, tripId];
    await env.DB.prepare(`UPDATE trips SET touched = ?${setTitle} WHERE id = ?`).bind(...params).run();
  }

  return jsonResponse({ seq: lastSeq, applied });
}

function handleHealth() {
  return jsonResponse({ ok: true, ts: Date.now() });
}

// ---- маршрутизация --------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!pathname.startsWith('/api/')) {
      return errorResponse('not_found', 'Неизвестный путь', 404);
    }

    // лимит частоты по IP — на все API-запросы разом
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(ip)) {
      return ERRORS.rate_limited('Слишком много запросов, попробуйте чуть позже');
    }

    try {
      if (pathname === '/api/health' && method === 'GET') {
        return handleHealth();
      }

      if (pathname === '/api/trip' && method === 'POST') {
        return await handleCreateTrip(request, env);
      }

      let m = pathname.match(/^\/api\/trip\/([^/]+)$/);
      if (m && method === 'GET') {
        return await handleGetTrip(request, env, decodeURIComponent(m[1]), url);
      }

      m = pathname.match(/^\/api\/trip\/([^/]+)\/ops$/);
      if (m && method === 'POST') {
        return await handlePostOps(request, env, decodeURIComponent(m[1]));
      }

      m = pathname.match(/^\/api\/tg\/webhook\/([^/]+)$/);
      if (m && method === 'POST') {
        return await handleTelegramWebhook(request, env, url);
      }

      return errorResponse('not_found', 'Неизвестный маршрут', 404);
    } catch (err) {
      // Не глотаем ошибки молча (SPEC: «Ошибки записи показывать человеку»),
      // но и внутренности исключения наружу не выдаём.
      console.error('Необработанная ошибка в API:', err && err.stack ? err.stack : err);
      return errorResponse('bad_request', 'Внутренняя ошибка сервера', 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyDigest(env));
  },
};
