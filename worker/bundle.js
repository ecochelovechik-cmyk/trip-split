/* СОБРАННЫЙ ФАЙЛ — не редактировать вручную.
 * Собран из worker/telegram.js + worker/worker.js командой: node dev/build-worker.mjs
 * Правки вносить в исходные файлы и пересобирать, иначе они потеряются.
 */

// ==================== worker/telegram.js ====================
// worker/telegram.js
// Telegram-слой проекта «Кто кому должен»: проверка подписи Mini App,
// обработка вебхука бота, вечерняя сводка по cron.
// Исполняется в Cloudflare Worker — никаких Node-модулей, только Web API (fetch, crypto.subtle).
// Экспортирует ровно три функции: verifyInitData, handleTelegramWebhook, sendDailyDigest.
// Токен бота НИГДЕ не хардкодится — берём только из env.BOT_TOKEN.

// ---------------------------------------------------------------------------
// Адрес фронта на GitHub Pages. Можно переопределить через env.PAGES_URL
// (например, если Рашид заведёт свой домен) — тогда трогать этот файл не нужно.
// ---------------------------------------------------------------------------
const DEFAULT_PAGES_URL = "https://ecochelovechik-cmyk.github.io/trip-split/";

// Максимальный возраст подписи initData (Telegram Mini App), секунд.
// Дольше суток — подозрительно, отклоняем.
const INIT_DATA_MAX_AGE_SEC = 86400;

// Валюты, которые выводим без копеек/центов (совпадает со списком в SPEC.md и в прототипе).
const NO_DEC = {
  UZS: 1, JPY: 1, KRW: 1, VND: 1, IDR: 1, CLP: 1, ISK: 1, HUF: 1, KZT: 1, KGS: 1,
  TJS: 1, LAK: 1, MMK: 1, KHR: 1, PYG: 1, RWF: 1, XOF: 1, XAF: 1, COP: 1, IRR: 1, AMD: 1
};

// =============================================================================
// 1. Проверка подписи Telegram Mini App (initData)
// =============================================================================

/**
 * Проверяет подпись initData из Telegram Mini App.
 * Алгоритм из официальной документации Telegram:
 *   secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
 *   hash_check = HMAC_SHA256(key=secret_key, data=data_check_string)
 * data_check_string — все поля initData (кроме hash), отсортированные по ключу,
 * склеенные как "key=value" через "\n".
 *
 * @param {string} initData — сырая строка initData от Telegram.WebApp
 * @param {string} botToken — токен бота (env.BOT_TOKEN)
 * @returns {Promise<{ok:boolean, user:{id:number, name:string}|null}>}
 */
async function verifyInitData(initData, botToken) {
  const fail = { ok: false, user: null };
  if (!initData || typeof initData !== "string" || !botToken) return fail;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return fail;
  }

  const receivedHash = params.get("hash");
  if (!receivedHash) return fail;
  params.delete("hash");

  // проверка свежести подписи
  const authDate = Number(params.get("auth_date"));
  if (!authDate || !isFinite(authDate)) return fail;
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec < 0 || ageSec > INIT_DATA_MAX_AGE_SEC) return fail;

  // data-check-string: пары key=value, отсортированные по ключу, через \n
  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  try {
    const enc = new TextEncoder();
    // secret_key = HMAC_SHA256(key="WebAppData", data=botToken)
    const webAppDataKey = await crypto.subtle.importKey(
      "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppDataKey, enc.encode(botToken));

    // hash = HMAC_SHA256(key=secret_key, data=dataCheckString)
    const signKey = await crypto.subtle.importKey(
      "raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBytes = await crypto.subtle.sign("HMAC", signKey, enc.encode(dataCheckString));
    const computedHash = bytesToHex(new Uint8Array(sigBytes));

    if (!timingSafeEqual(computedHash, receivedHash)) return fail;
  } catch (e) {
    return fail;
  }

  // подпись верна — достаём проверенного пользователя
  let user = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      const u = JSON.parse(userRaw);
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username || String(u.id);
      user = { id: u.id, name };
    } catch (e) {
      return fail;
    }
  }
  if (!user) return fail;

  return { ok: true, user };
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// =============================================================================
// 2. Свёртка операций и расчёт долгов — ЧИСТЫЕ функции (без побочных эффектов),
//    ровно те же правила, что в SPEC.md ("Свёртка" и "Деньги"). Логика взята
//    1:1 из compute()/transfers() рабочего прототипа, чтобы бот и клиент считали
//    одинаково.
// =============================================================================

/**
 * Сворачивает список операций (в порядке возрастания seq) в состояние поездки.
 * @param {Array<{seq:number, id:string, kind:string, ts:number, author:string, payload:object}>} ops
 * @returns {{trip:{name:string,base:string}, currencies:Array, people:Array, expenses:Array, payments:Array}}
 */
function reduceOps(ops) {
  const state = {
    trip: { name: "Поездка", base: "USD" },
    currencies: [{ code: "USD", rate: 1 }],
    people: [],
    expenses: [],
    payments: []
  };

  for (const op of Array.isArray(ops) ? ops : []) {
    const p = op && op.payload ? op.payload : {};
    switch (op.kind) {
      case "trip.meta":
        if (p.name != null) state.trip.name = String(p.name);
        if (p.base != null) state.trip.base = String(p.base).toUpperCase();
        break;

      case "person.add":
        // повторное person.add с тем же pid — игнор
        if (!state.people.some((x) => x.id === p.pid)) {
          state.people.push({ id: p.pid, name: p.name });
        }
        break;

      case "person.rename": {
        const person = state.people.find((x) => x.id === p.pid);
        if (person) person.name = p.name;
        break;
      }

      case "person.del":
        state.people = state.people.filter((x) => x.id !== p.pid);
        break;

      case "cur.set": {
        const code = String(p.code || "").toUpperCase();
        if (!code) break;
        const existing = state.currencies.find((c) => c.code === code);
        if (existing) existing.rate = Number(p.rate) || 0;
        else state.currencies.push({ code, rate: Number(p.rate) || 0 });
        break;
      }

      case "cur.del": {
        const code = String(p.code || "").toUpperCase();
        if (code !== state.trip.base) {
          state.currencies = state.currencies.filter((c) => c.code !== code);
        }
        break;
      }

      case "expense.add":
        state.expenses.push({
          id: p.eid, title: p.title, amount: p.amount, cur: p.cur,
          payer: p.payer, parts: Array.isArray(p.parts) ? p.parts.slice() : [],
          date: p.date, note: p.note,
          category: p.category, shares: p.shares && typeof p.shares === "object" ? Object.assign({}, p.shares) : p.shares
        });
        break;

      case "expense.edit": {
        // expense.edit для несуществующей траты — игнор (её удалили).
        // При последовательной обработке по seq последняя правка естественно побеждает.
        const idx = state.expenses.findIndex((x) => x.id === p.eid);
        if (idx >= 0) {
          state.expenses[idx] = {
            id: p.eid, title: p.title, amount: p.amount, cur: p.cur,
            payer: p.payer, parts: Array.isArray(p.parts) ? p.parts.slice() : [],
            date: p.date, note: p.note,
            category: p.category, shares: p.shares && typeof p.shares === "object" ? Object.assign({}, p.shares) : p.shares
          };
        }
        break;
      }

      case "expense.del":
        state.expenses = state.expenses.filter((x) => x.id !== p.eid);
        break;

      case "payment.add":
        state.payments.push({
          id: p.payid, from: p.from, to: p.to, amount: p.amount, date: p.date, note: p.note
        });
        break;

      case "payment.del":
        state.payments = state.payments.filter((x) => x.id !== p.payid);
        break;

      default:
        // неизвестный kind — игнорируем, не роняем свёртку
        break;
    }
  }

  // базовая валюта всегда присутствует и всегда rate = 1
  if (!state.currencies.some((c) => c.code === state.trip.base)) {
    state.currencies.unshift({ code: state.trip.base, rate: 1 });
  }
  state.currencies.forEach((c) => { if (c.code === state.trip.base) c.rate = 1; });

  return state;
}

function rateOf(state, code) {
  const c = state.currencies.find((x) => x.code === code);
  return c ? Number(c.rate) || 0 : 0;
}

function toCents(state, amount, code) {
  return Math.round((Number(amount) || 0) * rateOf(state, code) * 100);
}

/**
 * Проверяет валидность shares по правилам SPEC.md:
 * - ключи shares обязаны быть подмножеством parts;
 * - сумма значений shares обязана равняться amount с точностью до наименьшей
 *   единицы валюты траты (для валют без копеек — до целого).
 * Проверка ведётся в валюте траты (e.cur), без конвертации по курсу.
 * @param {{amount:number, cur:string, parts:Array, shares:object}} e
 * @returns {boolean}
 */
function isValidShares(e) {
  const shares = e && e.shares;
  if (!shares || typeof shares !== "object") return false;
  const keys = Object.keys(shares);
  if (!keys.length) return false;
  const parts = Array.isArray(e.parts) ? e.parts : [];
  for (const k of keys) {
    if (!parts.includes(k)) return false;
  }
  const dec = NO_DEC[String(e.cur || "").toUpperCase()] ? 0 : 2;
  const mult = Math.pow(10, dec);
  let sum = 0;
  for (const k of keys) sum += Math.round((Number(shares[k]) || 0) * mult);
  const amt = Math.round((Number(e.amount) || 0) * mult);
  return sum === amt;
}

/**
 * Считает по состоянию: сколько кто заплатил, чья доля, баланс.
 * Все деньги — в целых центах базовой валюты.
 * @returns {{rows: Array<{id,name,paid,share,settled,balance}>, totalCents:number}}
 */
function computeBalances(state) {
  const paid = {}, share = {}, order = {};
  state.people.forEach((p, i) => { paid[p.id] = 0; share[p.id] = 0; order[p.id] = i; });

  let totalCents = 0;
  for (const e of state.expenses) {
    const cents = toCents(state, e.amount, e.cur);
    const parts = (e.parts || []).filter((id) => Object.prototype.hasOwnProperty.call(paid, id));
    if (!parts.length || !cents) continue;
    totalCents += cents;
    if (Object.prototype.hasOwnProperty.call(paid, e.payer)) paid[e.payer] += cents;

    // порядок участников — по порядку списка людей, детерминированно
    parts.sort((a, b) => order[a] - order[b]);

    if (isValidShares(e)) {
      // валидный shares: каждая доля переводится в центы базовой валюты тем же
      // курсом, что и вся трата; участники из parts без записи в shares — 0.
      const rate = rateOf(state, e.cur);
      const converted = {};
      parts.forEach((id) => {
        const v = Object.prototype.hasOwnProperty.call(e.shares, id) ? Number(e.shares[id]) || 0 : 0;
        converted[id] = Math.round(v * rate * 100);
      });
      const sumConverted = parts.reduce((s, id) => s + converted[id], 0);
      const remainder = cents - sumConverted;
      // остаток из-за отдельного округления долей — по одной копейке первым
      // участникам с ненулевой долей (в порядке списка людей); если таких нет —
      // всем участникам parts в порядке списка.
      const nonZero = parts.filter((id) => converted[id] !== 0);
      const targets = nonZero.length ? nonZero : parts;
      if (targets.length) {
        const step = remainder >= 0 ? 1 : -1;
        const n = Math.abs(remainder);
        for (let i = 0; i < n; i++) {
          converted[targets[i % targets.length]] += step;
        }
      }
      parts.forEach((id) => { share[id] += converted[id]; });
    } else {
      // остаток раздаётся по копейке первым rem участникам в порядке списка людей — детерминированно
      const per = Math.floor(cents / parts.length);
      const rem = cents - per * parts.length;
      parts.forEach((id, i) => { share[id] += per + (i < rem ? 1 : 0); });
    }
  }

  const settled = {};
  state.people.forEach((p) => { settled[p.id] = 0; });
  for (const pay of state.payments) {
    // payment.amount — в базовой валюте, без конвертации
    const c = Math.round((Number(pay.amount) || 0) * 100);
    if (Object.prototype.hasOwnProperty.call(settled, pay.from)) settled[pay.from] += c;
    if (Object.prototype.hasOwnProperty.call(settled, pay.to)) settled[pay.to] -= c;
  }

  const rows = state.people.map((p) => ({
    id: p.id,
    name: p.name,
    paid: paid[p.id],
    share: share[p.id],
    settled: settled[p.id],
    balance: paid[p.id] - share[p.id] + settled[p.id]
  }));

  return { rows, totalCents };
}

/**
 * Жадный взаимозачёт: крупнейший должник -> крупнейшему кредитору, пока не сойдётся.
 * @param {Array<{id,balance}>} rows
 * @returns {Array<{from,to,cents}>}
 */
function computeTransfers(rows) {
  const debt = rows.filter((r) => r.balance < 0)
    .map((r) => ({ id: r.id, v: -r.balance }))
    .sort((a, b) => b.v - a.v);
  const cred = rows.filter((r) => r.balance > 0)
    .map((r) => ({ id: r.id, v: r.balance }))
    .sort((a, b) => b.v - a.v);

  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const m = Math.min(debt[i].v, cred[j].v);
    if (m > 0) out.push({ from: debt[i].id, to: cred[j].id, cents: m });
    debt[i].v -= m; cred[j].v -= m;
    if (debt[i].v <= 0) i++;
    if (cred[j].v <= 0) j++;
  }
  return out;
}

// =============================================================================
// 3. Вспомогательное: форматирование денег, доступ к D1, вызовы Telegram Bot API
// =============================================================================

function fmtCents(cents, code) {
  const dec = NO_DEC[code] ? 0 : 2;
  const neg = cents < 0;
  const abs = Math.abs(cents) / 100;
  let s = abs.toFixed(dec);
  const parts = s.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (neg ? "−" : "") + parts.join(",") + " " + code;
}

async function dbGetTripById(env, tripId) {
  const row = await env.DB.prepare("SELECT id, title, chat_id FROM trips WHERE id = ?").bind(tripId).first();
  return row || null;
}

async function dbGetTripByChatId(env, chatId) {
  const row = await env.DB.prepare("SELECT id, title, chat_id FROM trips WHERE chat_id = ?").bind(String(chatId)).first();
  return row || null;
}

async function dbGetAllOps(env, tripId) {
  const { results } = await env.DB
    .prepare("SELECT seq, op_id AS id, kind, payload, author, ts FROM ops WHERE trip_id = ? ORDER BY seq ASC")
    .bind(tripId)
    .all();
  return (results || []).map((r) => ({
    seq: r.seq, id: r.id, kind: r.kind, author: r.author, ts: r.ts,
    payload: safeParseJSON(r.payload)
  }));
}

function safeParseJSON(text) {
  try { return JSON.parse(text); } catch (e) { return {}; }
}

async function tgApi(botToken, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  // Telegram отвечает JSON даже при ошибке — не роняем вызывающего, просто возвращаем результат
  try { return await res.json(); } catch (e) { return { ok: false }; }
}

function sendMessage(botToken, chatId, text, extra) {
  return tgApi(botToken, "sendMessage", Object.assign({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  }, extra || {}));
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// =============================================================================
// 4. Сообщения бота
// =============================================================================

function tripLinkFor(env, tripId) {
  const base = (env && env.PAGES_URL) || DEFAULT_PAGES_URL;
  // Доступ к поездке = знание tripId, кладём его в hash (не в query — GitHub Pages
  // может редиректить query на другой путь при 404, hash безопаснее).
  return tripId ? `${base}#${tripId}` : base;
}

function formatSummary(state, trip) {
  const { rows, totalCents } = computeBalances(state);
  const transfers = computeTransfers(rows);
  const base = state.trip.base;

  const lines = [];
  lines.push(`📊 <b>Итог по поездке «${esc(state.trip.name)}»</b>`);
  lines.push(`Всего потрачено: <b>${esc(fmtCents(totalCents, base))}</b>`);
  lines.push("");

  if (!rows.length) {
    lines.push("Участников пока нет.");
    return lines.join("\n");
  }

  lines.push("<b>Заплатили:</b>");
  for (const r of rows) {
    lines.push(`${esc(r.name)}: ${esc(fmtCents(r.paid, base))} (доля ${esc(fmtCents(r.share, base))})`);
  }
  lines.push("");

  if (!transfers.length) {
    lines.push("✅ Все в расчёте — никто никому не должен.");
  } else {
    lines.push("<b>Кто кому переводит:</b>");
    for (const t of transfers) {
      const from = rows.find((r) => r.id === t.from);
      const to = rows.find((r) => r.id === t.to);
      lines.push(`${esc(from ? from.name : "?")} → ${esc(to ? to.name : "?")}: ${esc(fmtCents(t.cents, base))}`);
    }
  }
  return lines.join("\n");
}

function extractTripId(arg) {
  if (!arg) return "";
  let s = String(arg).trim();
  // из ссылки берём последний сегмент после # или / или ?
  const m = s.match(/[#/?]([^#/?]+)\/?$/);
  if (m) s = m[1];
  s = s.replace(/[?#].*$/, "").trim();
  // приложение строит ссылку как …/#t=<id> (см. docs/app.js, tripLinkFor) —
  // отбрасываем имя параметра, иначе id не найдётся. Голый id тоже принимаем.
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
  s = s.split("&")[0].trim();
  try { s = decodeURIComponent(s); } catch (e) { /* оставляем как есть */ }
  return s.trim();
}

// =============================================================================
// 5. Команды бота
// =============================================================================

async function cmdStart(env, chatId) {
  const trip = await dbGetTripByChatId(env, chatId);
  const url = tripLinkFor(env, trip ? trip.id : null);
  const text = [
    "Привет! Я считаю, кто кому должен в поездке.",
    "",
    "Команды:",
    "/itog (или просто «итог» в личке) — кто кому сколько должен прямо сейчас",
    "/privyazat &lt;ссылка или id поездки&gt; — привязать этот чат к поездке",
    "/otvyazat — отвязать чат от поездки",
    "/help — как завести новую поездку и открыть её только своим",
    "",
    "Раз в день вечером, если были новые траты, я сам пришлю сводку.",
    trip ? `Этот чат сейчас привязан к поездке «${esc(trip.title || "")}».` : "Этот чат пока ни к одной поездке не привязан."
  ].join("\n");

  const keyboard = { inline_keyboard: [[{ text: "Открыть поездку", web_app: { url } }]] };
  return sendMessage(env.BOT_TOKEN, chatId, text, { reply_markup: keyboard });
}

async function cmdHelp(env, chatId) {
  const text = [
    "<b>Новая поездка — коротко</b>",
    "",
    `1. Откройте сайт: ${esc(tripLinkFor(env, null))}`,
    "2. Создайте поездку, дайте ей название.",
    "",
    "<b>Чтобы её видели только свои, а не все, у кого есть ссылка:</b>",
    "1. Создайте в Telegram группу с попутчиками.",
    "2. Добавьте туда меня (бота) — Добавить участника → мой username.",
    "3. Скопируйте ссылку на поездку с сайта и отправьте в этой группе:",
    "<code>/privyazat &lt;ссылка&gt;</code>",
    "4. Готово — /itog и кнопка «Открыть поездку» в этой группе теперь ведут на неё. Кто не в группе — у того нет ни бота с привязкой, ни ссылки.",
    "",
    "Сама ссылка всё равно остаётся ключом доступа — если её переслать вне группы, по ней тоже можно зайти."
  ].join("\n");
  return sendMessage(env.BOT_TOKEN, chatId, text);
}

async function cmdItog(env, chatId) {
  const trip = await dbGetTripByChatId(env, chatId);
  if (!trip) {
    return sendMessage(env.BOT_TOKEN, chatId,
      "Этот чат не привязан ни к одной поездке.\nОтправьте /privyazat и ссылку на поездку.");
  }
  const ops = await dbGetAllOps(env, trip.id);
  const state = reduceOps(ops);
  return sendMessage(env.BOT_TOKEN, chatId, formatSummary(state, trip));
}

async function cmdPrivyazat(env, chatId, argText, chatTitle) {
  const tripId = extractTripId(argText);
  if (!tripId) {
    return sendMessage(env.BOT_TOKEN, chatId, "Использование: /privyazat <ссылка на поездку или её id>");
  }
  const trip = await dbGetTripById(env, tripId);
  if (!trip) {
    return sendMessage(env.BOT_TOKEN, chatId, "Поездка с таким id не найдена. Проверьте ссылку.");
  }
  await env.DB.prepare("UPDATE trips SET chat_id = ?, touched = ? WHERE id = ?")
    .bind(String(chatId), Date.now(), trip.id).run();
  return sendMessage(env.BOT_TOKEN, chatId,
    `Готово. Этот чат привязан к поездке «${esc(trip.title || tripId)}».\nКоманда /itog теперь покажет расчёт по ней.`);
}

async function cmdOtvyazat(env, chatId) {
  const trip = await dbGetTripByChatId(env, chatId);
  if (!trip) {
    return sendMessage(env.BOT_TOKEN, chatId, "Этот чат и так ни к одной поездке не привязан.");
  }
  await env.DB.prepare("UPDATE trips SET chat_id = NULL WHERE id = ?").bind(trip.id).run();
  return sendMessage(env.BOT_TOKEN, chatId, `Чат отвязан от поездки «${esc(trip.title || trip.id)}».`);
}

// =============================================================================
// 6. Вебхук Telegram
// =============================================================================

/**
 * Обрабатывает POST /api/tg/webhook/:secret.
 * Секрет в пути сверяется с env.TG_WEBHOOK_SECRET — если не совпал, отдаём 404
 * (не 403), чтобы не подтверждать посторонним существование эндпоинта.
 * @param {Request} request
 * @param {object} env — env.BOT_TOKEN, env.TG_WEBHOOK_SECRET, env.DB (D1), опц. env.PAGES_URL
 * @param {URL} url — уже разобранный URL запроса
 * @returns {Promise<Response>}
 */
async function handleTelegramWebhook(request, env, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  const secretFromPath = segments[segments.length - 1] || "";
  if (!env.TG_WEBHOOK_SECRET || !timingSafeEqual(secretFromPath, env.TG_WEBHOOK_SECRET)) {
    return new Response(null, { status: 404 });
  }
  if (!env.BOT_TOKEN) {
    // сервер сконфигурирован не полностью — отвечаем ok, чтобы Telegram не долбил ретраями,
    // но реально ничего не делаем
    return jsonResponse({ ok: true });
  }

  let update;
  try {
    update = await request.json();
  } catch (e) {
    return jsonResponse({ ok: true });
  }

  const message = update && (update.message || update.edited_message);
  if (!message || typeof message.text !== "string") {
    // не текстовое сообщение / другой тип апдейта — игнорируем молча
    return jsonResponse({ ok: true });
  }

  const chatId = message.chat && message.chat.id;
  const chatTitle = message.chat && (message.chat.title || message.chat.username);
  if (!chatId) return jsonResponse({ ok: true });

  const raw = message.text.trim();
  const lower = raw.toLowerCase();

  try {
    if (lower === "итог" || lower === "/itog" || lower.startsWith("/itog@") || lower.startsWith("/itog ")) {
      await cmdItog(env, chatId);
    } else if (lower === "/start" || lower.startsWith("/start@") || lower.startsWith("/start ")) {
      await cmdStart(env, chatId);
    } else if (lower === "/help" || lower.startsWith("/help@") || lower.startsWith("/help ")) {
      await cmdHelp(env, chatId);
    } else if (lower.startsWith("/privyazat")) {
      const arg = raw.replace(/^\/privyazat(@\S+)?\s*/i, "");
      await cmdPrivyazat(env, chatId, arg, chatTitle);
    } else if (lower === "/otvyazat" || lower.startsWith("/otvyazat@") || lower.startsWith("/otvyazat ")) {
      await cmdOtvyazat(env, chatId);
    }
    // остальные сообщения — молча игнорируем: "на каждую трату бот не пишет"
  } catch (e) {
    // не роняем вебхук из-за ошибки одной команды — Telegram иначе будет ретраить апдейт
    try {
      await sendMessage(env.BOT_TOKEN, chatId, "Что-то пошло не так при обработке команды. Попробуйте ещё раз.");
    } catch (e2) { /* ignore */ }
  }

  return jsonResponse({ ok: true });
}

// jsonResponse — определена в worker.js (те же аргументы: data, status=200) и после
// сборки в один файл видна и здесь благодаря hoisting; дублировать её нельзя —
// в ES-модуле повторное объявление верхнеуровневой функции роняет весь Worker.

// =============================================================================
// 7. Вечерняя сводка (вызывается по Cron Trigger из worker.js)
// =============================================================================

/**
 * Раз в сутки рассылает во все привязанные чаты: сколько потрачено за последние
 * 24 часа и текущий полный расклад "кто кому должен". Если за последние 24 часа
 * по поездке не было ни одной операции — в этот чат вообще ничего не пишем.
 * @param {object} env
 */
async function sendDailyDigest(env) {
  if (!env.BOT_TOKEN || !env.DB) return;

  const { results: trips } = await env.DB
    .prepare("SELECT id, title, chat_id FROM trips WHERE chat_id IS NOT NULL AND chat_id != ''")
    .all();

  const cutoff = Date.now() - 24 * 3600 * 1000;

  for (const trip of trips || []) {
    try {
      const ops = await dbGetAllOps(env, trip.id);
      const recentOps = ops.filter((op) => Number(op.ts) >= cutoff);
      if (!recentOps.length) continue; // ничего не менялось за день — не пишем вообще

      const state = reduceOps(ops);

      // сколько потрачено за последние сутки: сумма новых трат (expense.add) за окно.
      // Правки/удаления в окне намеренно не переигрываем отдельно — итоговые общие
      // балансы всё равно считаются по полному состоянию state ниже.
      let dailyCents = 0;
      for (const op of recentOps) {
        if (op.kind === "expense.add") {
          dailyCents += toCents(state, op.payload.amount, op.payload.cur);
        }
      }

      const { rows } = computeBalances(state);
      const transfers = computeTransfers(rows);
      const base = state.trip.base;

      const lines = [];
      lines.push(`🌙 <b>Вечерняя сводка — «${esc(state.trip.name)}»</b>`);
      lines.push(`За сегодня потрачено: <b>${esc(fmtCents(dailyCents, base))}</b>`);
      lines.push("");
      if (!transfers.length) {
        lines.push("✅ Все в расчёте — никто никому не должен.");
      } else {
        lines.push("<b>Кто кому должен:</b>");
        for (const t of transfers) {
          const from = rows.find((r) => r.id === t.from);
          const to = rows.find((r) => r.id === t.to);
          lines.push(`${esc(from ? from.name : "?")} → ${esc(to ? to.name : "?")}: ${esc(fmtCents(t.cents, base))}`);
        }
      }

      await sendMessage(env.BOT_TOKEN, trip.chat_id, lines.join("\n"));
    } catch (e) {
      // одна сломавшаяся поездка не должна рвать рассылку остальным
      console.error("sendDailyDigest: ошибка по поездке " + trip.id, e);
    }
  }
}

// =============================================================================
// 8. Уведомление в чат о новых операциях (вызывается из worker.js после записи)
// =============================================================================

/** Человекочитаемая строка одной операции. Возвращает null для тех, о которых не пишем. */
function opLine(state, op) {
  const p = op.payload || {};
  const base = state.trip.base;
  const nameOf = (pid) => {
    const person = state.people.find((x) => x.id === pid);
    return person ? person.name : "кто-то";
  };

  if (op.kind === "expense.add" || op.kind === "expense.edit") {
    const e = state.expenses.find((x) => x.id === p.eid);
    if (!e) return null;
    const cents = toCents(state, e.amount, e.cur);
    const own = fmtAmount(e.amount, e.cur);
    // если валюта траты не базовая — показываем и пересчёт, иначе не дублируем одно и то же
    const conv = e.cur === base ? "" : ` (${esc(fmtCents(cents, base))})`;
    const parts = (e.parts || []).filter((id) => state.people.some((x) => x.id === id));
    const forWho = parts.length === state.people.length && parts.length
      ? "на всех"
      : parts.map(nameOf).join(", ") || "ни на кого";
    const icon = op.kind === "expense.add" ? "➕" : "✏️";
    const verb = op.kind === "expense.add" ? "" : " (правка)";
    return `${icon} <b>${esc(e.title || "Без названия")}</b>${verb} — ${esc(own)}${conv}\n` +
           `    платил ${esc(nameOf(e.payer))} · ${esc(forWho)}`;
  }

  if (op.kind === "expense.del") return `🗑 Трата удалена`;

  if (op.kind === "payment.add") {
    const amt = fmtCents(Math.round((Number(p.amount) || 0) * 100), base);
    return `💸 Возврат долга: ${esc(nameOf(p.from))} → ${esc(nameOf(p.to))}: ${esc(amt)}`;
  }
  if (op.kind === "payment.del") return `🗑 Возврат долга отменён`;

  if (op.kind === "person.add") return `👤 Добавлен участник: ${esc(p.name || "")}`;
  if (op.kind === "person.del") return `👤 Участник удалён`;
  if (op.kind === "person.rename") return `👤 Переименован: ${esc(p.name || "")}`;

  return null; // trip.meta, cur.set и прочая настройка — молча
}

function fmtAmount(amount, code) {
  const dec = NO_DEC[String(code || "").toUpperCase()] ? 0 : 2;
  const parts = (Math.abs(Number(amount) || 0)).toFixed(dec).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return parts.join(",") + " " + code;
}

/**
 * Пишет в привязанный чат, что изменилось, и текущий расклад «кто кому должен».
 * Одно сообщение на запрос, даже если операций пришло несколько.
 * @param {object} env
 * @param {{id:string, chat_id:string, title:string}} trip
 * @param {string[]} appliedIds — op_id операций, которые реально записались
 * @param {string} author
 */
async function notifyTripOps(env, trip, appliedIds, author) {
  if (!env.BOT_TOKEN || !trip || !trip.chat_id || !appliedIds || !appliedIds.length) return;
  try {
    const ops = await dbGetAllOps(env, trip.id);
    const state = reduceOps(ops);

    const fresh = ops.filter((o) => appliedIds.indexOf(o.id) >= 0);
    const lines = [];
    for (const op of fresh) {
      const line = opLine(state, op);
      if (line) lines.push(line);
    }
    if (!lines.length) return; // пришла только настройка — молчим

    const { rows } = computeBalances(state);
    const transfers = computeTransfers(rows);
    const base = state.trip.base;

    const out = [];
    if (author) out.push(`<i>${esc(author)}</i>`);
    out.push(...lines);
    out.push("");
    if (!transfers.length) {
      out.push("✅ Все в расчёте.");
    } else {
      out.push("<b>Кто кому должен:</b>");
      for (const t of transfers) {
        const from = rows.find((r) => r.id === t.from);
        const to = rows.find((r) => r.id === t.to);
        out.push(`${esc(from ? from.name : "?")} → ${esc(to ? to.name : "?")}: ${esc(fmtCents(t.cents, base))}`);
      }
    }
    await sendMessage(env.BOT_TOKEN, trip.chat_id, out.join("\n"));
  } catch (e) {
    // уведомление — не критичный путь: операции уже записаны, молча не роняем API
    console.error("notifyTripOps: " + (e && e.message ? e.message : e));
  }
}



// ==================== worker/worker.js ====================
// worker/worker.js
// Cloudflare Worker: API «Дележка расходов в поездке».
// Хранит журнал операций в D1, состояние (кто кому должен) собирают клиенты сами —
// сервер лишь присваивает операциям seq и раздаёт их по порядку. Подробности — в SPEC.md.

// (импорт не нужен: код telegram.js вставлен выше)
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

async function handlePostOps(request, env, tripId, ctx) {
  const trip = await env.DB.prepare('SELECT id, title, chat_id FROM trips WHERE id = ?').bind(tripId).first();
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

    // Дублируем изменения в привязанный чат. Не задерживаем ответ телефону:
    // отправка идёт фоном, её падение не должно ломать запись операций.
    if (trip.chat_id && env.BOT_TOKEN) {
      const job = notifyTripOps(env, { id: tripId, chat_id: trip.chat_id, title: newTitle || trip.title }, applied, author);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      else await job;
    }
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
        return await handlePostOps(request, env, decodeURIComponent(m[1]), ctx);
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

