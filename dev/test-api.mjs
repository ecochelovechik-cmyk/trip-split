// dev/test-api.mjs
// Автотесты API поверх dev-server.js. Поднимают сервер отдельным процессом,
// гоняют запросы через fetch, печатают ОК/ПРОВАЛ по каждому пункту.
// Запуск: node dev/test-api.mjs
// Код возврата: 0 — всё прошло, 1 — есть провалы.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799; // отдельный порт, чтобы не мешать ручному dev-server на 8787
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`ОК   — ${name}`);
}

function fail(name, detail) {
  failed++;
  console.log(`ПРОВАЛ — ${name}`);
  if (detail !== undefined) console.log('       ' + String(detail).split('\n').join('\n       '));
}

async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err && err.stack ? err.stack : err);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: ожидали ${JSON.stringify(expected)}, получили ${JSON.stringify(actual)}`);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // сервер ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('dev-server не поднялся за 10 секунд');
}

function makeOp(kind, payload, overrides = {}) {
  return {
    id: overrides.id || `op-${Math.random().toString(36).slice(2)}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind,
    ts: overrides.ts ?? Date.now(),
    author: overrides.author ?? 'Тест',
    payload,
  };
}

async function createTrip(name = 'Тестовая поездка', base = 'USD') {
  const r = await fetch(`${BASE}/api/trip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, base }),
  });
  const data = await r.json();
  return { status: r.status, data };
}

async function postOps(tripId, ops, extra = {}) {
  const r = await fetch(`${BASE}/api/trip/${tripId}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops, author: 'Тест', ...extra }),
  });
  const data = await r.json();
  return { status: r.status, data };
}

async function getTrip(tripId, since) {
  const url = since === undefined ? `${BASE}/api/trip/${tripId}` : `${BASE}/api/trip/${tripId}?since=${since}`;
  const r = await fetch(url);
  const data = await r.json();
  return { status: r.status, data, headers: r.headers };
}

// ---------------------------------------------------------------------------

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[dev-server] ${d}`));

  try {
    await waitForServer();

    let tripId;

    await check('создание поездки: POST /api/trip возвращает tripId', async () => {
      const { status, data } = await createTrip('Поездка в Хиву', 'UZS');
      assertEqual(status, 200, 'HTTP статус');
      assert(typeof data.tripId === 'string', 'tripId должен быть строкой');
      assertEqual(data.tripId.length, 22, 'длина tripId');
      assert(/^[A-Za-z0-9]+$/.test(data.tripId), 'tripId должен состоять из [A-Za-z0-9]');
      tripId = data.tripId;
    });

    await check('GET поездки сразу после создания содержит стартовую trip.meta', async () => {
      const { status, data } = await getTrip(tripId);
      assertEqual(status, 200, 'HTTP статус');
      assertEqual(data.tripId, tripId, 'tripId в ответе');
      assert(Array.isArray(data.ops) && data.ops.length === 1, 'должна быть одна стартовая операция');
      assertEqual(data.ops[0].kind, 'trip.meta', 'kind стартовой операции');
      assertEqual(data.ops[0].payload.base, 'UZS', 'валюта в стартовой операции');
      assert(typeof data.ops[0].seq === 'number', 'seq должен быть числом');
    });

    let seqAfterFirstBatch;
    let firstOpIds;

    await check('добавление операций: seq присваивается по возрастанию', async () => {
      const ops = [
        makeOp('person.add', { pid: 'p1', name: 'Аня' }),
        makeOp('person.add', { pid: 'p2', name: 'Боря' }),
        makeOp('expense.add', {
          eid: 'e1', title: 'Такси', amount: 10, cur: 'UZS', payer: 'p1',
          parts: ['p1', 'p2'], date: '2026-08-23', note: '',
        }),
      ];
      firstOpIds = ops.map((o) => o.id);
      const { status, data } = await postOps(tripId, ops);
      assertEqual(status, 200, 'HTTP статус');
      assertEqual(data.applied.length, 3, 'все три операции должны примениться');
      assert(firstOpIds.every((id) => data.applied.includes(id)), 'applied должен содержать все id');
      assert(typeof data.seq === 'number' && data.seq > 0, 'seq должен вернуться числом больше нуля');
      seqAfterFirstBatch = data.seq;

      const check2 = await getTrip(tripId);
      // 1 стартовая + 3 новые
      assertEqual(check2.data.ops.length, 4, 'всего операций после добавления');
      const seqs = check2.data.ops.map((o) => o.seq);
      const sorted = [...seqs].sort((a, b) => a - b);
      assert(JSON.stringify(seqs) === JSON.stringify(sorted), 'seq должны идти по возрастанию');
      assert(new Set(seqs).size === seqs.length, 'seq не должны повторяться');
    });

    await check('повторная отправка тех же операций не создаёт дублей', async () => {
      const before = await getTrip(tripId);
      const beforeCount = before.data.ops.length;

      const ops = [
        makeOp('person.add', { pid: 'p1', name: 'Аня' }, { id: firstOpIds[0] }),
        makeOp('person.add', { pid: 'p2', name: 'Боря' }, { id: firstOpIds[1] }),
        makeOp('expense.add', {
          eid: 'e1', title: 'Такси', amount: 10, cur: 'UZS', payer: 'p1',
          parts: ['p1', 'p2'], date: '2026-08-23', note: '',
        }, { id: firstOpIds[2] }),
      ];
      const { status, data } = await postOps(tripId, ops);
      assertEqual(status, 200, 'HTTP статус (повтор — не ошибка)');
      assertEqual(data.applied.length, 0, 'ни одна операция не должна примениться повторно');

      const after = await getTrip(tripId);
      assertEqual(after.data.ops.length, beforeCount, 'число операций не должно вырасти');
    });

    await check('докачка по ?since= отдаёт только новые операции', async () => {
      const newOp = makeOp('payment.add', { payid: 'pay1', from: 'p2', to: 'p1', amount: 3, date: '2026-08-23', note: '' });
      const post = await postOps(tripId, [newOp]);
      assertEqual(post.status, 200, 'HTTP статус добавления');
      assertEqual(post.data.applied.length, 1, 'новая операция должна примениться');

      const page = await getTrip(tripId, seqAfterFirstBatch);
      assertEqual(page.data.ops.length, 1, 'докачка должна вернуть только одну новую операцию');
      assertEqual(page.data.ops[0].id, newOp.id, 'докачанная операция — именно новая');
      seqAfterFirstBatch = page.data.seq;
    });

    await check('отдача more:true при большом числе операций и докачка до конца', async () => {
      const { data: freshTrip } = await createTrip('Поездка для теста more', 'USD');
      const bigTripId = freshTrip.tripId;

      // стартовая операция уже 1; добьём до 520 операциями пачками по 50
      const target = 520;
      let createdSoFar = 1;
      while (createdSoFar < target) {
        const batchSize = Math.min(50, target - createdSoFar);
        const batch = [];
        for (let i = 0; i < batchSize; i++) {
          batch.push(makeOp('person.add', { pid: `pid-${createdSoFar + i}`, name: `Человек ${createdSoFar + i}` }));
        }
        const r = await postOps(bigTripId, batch);
        assertEqual(r.status, 200, 'HTTP статус при массовой заливке');
        createdSoFar += batchSize;
      }

      const first = await getTrip(bigTripId, 0);
      assertEqual(first.data.ops.length, 500, 'первая страница должна быть ровно 500 операций');
      assertEqual(first.data.more, true, 'more должен быть true, когда операций больше 500');

      const second = await getTrip(bigTripId, first.data.seq);
      assertEqual(second.data.ops.length, target - 500, 'вторая страница должна содержать остаток');
      assertEqual(second.data.more, false, 'more должен быть false на последней странице');
    });

    await check('лимит: больше 50 операций в одном запросе -> too_many', async () => {
      const ops = [];
      for (let i = 0; i < 51; i++) ops.push(makeOp('person.add', { pid: `x${i}`, name: `Ч${i}` }));
      const { status, data } = await postOps(tripId, ops);
      assertEqual(status, 400, 'HTTP статус too_many');
      assertEqual(data.error, 'too_many', 'код ошибки');
      assert(typeof data.message === 'string' && data.message.length > 0, 'сообщение должно быть человеческим текстом');
    });

    await check('лимит: payload больше 4 КБ -> too_large', async () => {
      const op = makeOp('expense.add', {
        eid: 'e-big', title: 'x'.repeat(5000), amount: 1, cur: 'USD', payer: 'p1', parts: ['p1'], date: '2026-08-23', note: '',
      });
      const { status, data } = await postOps(tripId, [op]);
      assertEqual(status, 413, 'HTTP статус too_large');
      assertEqual(data.error, 'too_large', 'код ошибки');
    });

    await check('неизвестный kind операции отклоняется -> bad_request', async () => {
      const op = makeOp('expense.teleport', { foo: 'bar' });
      const { status, data } = await postOps(tripId, [op]);
      assertEqual(status, 400, 'HTTP статус bad_request');
      assertEqual(data.error, 'bad_request', 'код ошибки');
    });

    await check('404 на несуществующую поездку (GET)', async () => {
      const { status, data } = await getTrip('this-trip-does-not-exist-xxx');
      assertEqual(status, 404, 'HTTP статус');
      assertEqual(data.error, 'not_found', 'код ошибки');
    });

    await check('404 на несуществующую поездку (POST /ops)', async () => {
      const { status, data } = await postOps('this-trip-does-not-exist-xxx', [makeOp('person.add', { pid: 'p1', name: 'Аня' })]);
      assertEqual(status, 404, 'HTTP статус');
      assertEqual(data.error, 'not_found', 'код ошибки');
    });

    await check('CORS-заголовки на OPTIONS', async () => {
      const r = await fetch(`${BASE}/api/trip/${tripId}/ops`, { method: 'OPTIONS' });
      assertEqual(r.status, 204, 'HTTP статус preflight');
      assertEqual(r.headers.get('access-control-allow-origin'), '*', 'Access-Control-Allow-Origin');
      const methods = r.headers.get('access-control-allow-methods') || '';
      assert(methods.includes('GET') && methods.includes('POST') && methods.includes('OPTIONS'), 'Access-Control-Allow-Methods');
      const headers = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
      assert(headers.includes('content-type'), 'Access-Control-Allow-Headers должен включать content-type');
    });

    await check('GET /api/health отвечает {ok:true, ts}', async () => {
      const r = await fetch(`${BASE}/api/health`);
      const data = await r.json();
      assertEqual(r.status, 200, 'HTTP статус');
      assertEqual(data.ok, true, 'ok должен быть true');
      assert(typeof data.ts === 'number', 'ts должен быть числом');
    });
  } finally {
    server.kill();
  }

  console.log('');
  console.log(`Итого: ${passed} ОК, ${failed} ПРОВАЛ${failed === 1 ? '' : 'ОВ'}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Тесты упали с необработанной ошибкой:', err);
  process.exit(1);
});
