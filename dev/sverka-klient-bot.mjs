/* Сверка расчётов КЛИЕНТА и БОТА на живой поездке.
   Запуск:  node dev/sverka-klient-bot.mjs [tripId]
   Зачем: клиент (docs/app.js) и бот (worker/telegram.js) считают одними правилами
   в двух разных местах — любая правка расчёта обязана давать одинаковый результат.
   Скрипт тянет журнал операций с сервера, считает обеими реализациями и сравнивает.
   По умолчанию берёт поездку «Ташкен» (UZS) — на ней ловился баг с копейками. */
import fs from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const TRIP = process.argv[2] || 'M6wWkQmLPtJpn3dnNV1Gpt';

const app = fs.readFileSync(ROOT + 'docs/app.js', 'utf8');
const tg  = fs.readFileSync(ROOT + 'worker/telegram.js', 'utf8');
const i18n = fs.readFileSync(ROOT + 'docs/i18n.js', 'utf8');

function grab(src, names) {
  let code = '';
  for (const n of names) {
    const re = new RegExp(String.raw`\r?\nfunction ${n}\([\s\S]*?\r?\n}\r?\n`);
    const m = src.match(re);
    if (m) code += m[0]; else throw new Error('не найдена: ' + n);
  }
  return code;
}

const ops = await fetch(`https://trip-split.ecochelovechik.workers.dev/api/trip/${TRIP}`)
  .then(r => r.json()).then(d => d.ops);

// ---- бот ----
const NO_DEC = JSON.parse('{' + tg.match(/const NO_DEC = \{([\s\S]*?)\};/)[1]
  .replace(/(\w+):/g, '"$1":').replace(/,\s*$/, '') + '}');
const botCode = grab(tg, ['reduceOps','rateOf','toCents','expenseRate','expenseCents',
                          'isValidShares','expenseShares','computeBalances','computeTransfers']);
const bot = new Function('NO_DEC', botCode + '\nreturn {reduceOps, computeBalances, computeTransfers};')(NO_DEC);
const stBot = bot.reduceOps(ops);
const cBot = bot.computeBalances(stBot);
const tBot = bot.computeTransfers(stBot);

// ---- клиент ----
const consts = [
  app.match(/var NO_DEC = \{[\s\S]*?\};/)[0],
  app.match(/var XLSX_CRC = \(function\(\)\{[\s\S]*?\}\)\(\);/)[0],
  app.match(/var CATS = .*/)[0],
].join('\n');
const cliFns = grab(app, [
  'baseCode','baseStepCents','rateOf','expenseRate','expenseCents','toCents',
  'normalizeCategory','normalizeShares','expenseFromPayload','paymentFromPayload','applyOp',
  'shareCentsForExpense','compute','noiseFloorCents','pairItems','transfers','personById','nameOf',
]);
const cli = new Function('window','OPS', `
  ${i18n}
  var S = {trip:{name:"", base:"USD"}, currencies:[{code:"USD",rate:1}], people:[], expenses:[], payments:[]};
  ${consts}
  ${cliFns}
  OPS.forEach(op => applyOp(S, op));
  return {S, compute, transfers};
`)({}, ops);
const cCli = cli.compute();
const tCli = cli.transfers(cCli.rows);

console.log('поездка:', cli.S.trip.name, '| валюта:', cli.S.trip.base);
console.log('\n%-12s %14s %14s %14s   копейки?', 'участник', 'заплатил', 'доля', 'баланс');
let drob = 0, sovpalo = true;
cCli.rows.forEach((r, i) => {
  const b = cBot.rows[i];
  const est = (r.paid % 100) || (r.share % 100) || (r.balance % 100);
  if (est) drob++;
  if (b.paid !== r.paid || b.share !== r.share || b.balance !== r.balance) sovpalo = false;
  console.log(
    r.name.padEnd(12),
    (r.paid/100).toLocaleString('ru').padStart(14),
    (r.share/100).toLocaleString('ru').padStart(14),
    (r.balance/100).toLocaleString('ru').padStart(14),
    est ? '  ← ЕСТЬ' : '  нет'
  );
});
console.log('\nсумма балансов =', cCli.rows.reduce((s,r)=>s+r.balance,0), '(должно быть 0)');
console.log('сумма долей = сумме трат:', cCli.rows.reduce((s,r)=>s+r.share,0) === cCli.total);
console.log('всего потрачено:', (cCli.total/100).toLocaleString('ru'), cli.S.trip.base);
console.log('строк с копейками:', drob);
console.log('клиент и бот совпали:', sovpalo);
console.log('\nпереводы (клиент / бот):');
tCli.forEach((t, i) => {
  const name = id => (cCli.rows.find(r => r.id === id) || {}).name;
  const b = tBot[i];
  console.log(`  ${name(t.from)} → ${name(t.to)}: ${(t.cents/100).toLocaleString('ru')}`
    + (b && b.cents === t.cents ? '  ✓ совпало' : `  ✗ у бота ${b ? (b.cents/100) : '—'}`));
});
