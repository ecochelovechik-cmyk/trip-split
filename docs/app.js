/* Дележка расходов в поездке — вся логика клиента.
   Свёртка операций в состояние, расчёты (в целых центах), взаимозачёт,
   синхронизация с Worker по SPEC.md, офлайн-очередь, Telegram Mini App.
   Никаких хардкод-строк на русском — все тексты идут через window.T(key, vars). */
(function(){
"use strict";

var T = window.T;

/* ========== константы ========== */
var LS_TRIPS = "ts.trips";
var LS_QUEUE_PREFIX = "ts.queue.";
var LS_ME_PREFIX = "ts.me.";
var LS_LANG = "ts.lang";
var POLL_MS = 8000;
var APP_VERSION_DATE = "23.08.2026";
var NO_DEC = {UZS:1,JPY:1,KRW:1,VND:1,IDR:1,CLP:1,ISK:1,HUF:1,KZT:1,KGS:1,TJS:1,LAK:1,MMK:1,KHR:1,PYG:1,RWF:1,XOF:1,XAF:1,COP:1,IRR:1,AMD:1};
// UZS/KGS без общепринятого юникод-символа — показываем код валюты (не зависит от языка интерфейса)
var SYM = {USD:"$",EUR:"€",RUB:"₽",GBP:"£",JPY:"¥",CNY:"¥",TRY:"₺",KZT:"₸",THB:"฿",AED:"AED",GEL:"₾",INR:"₹",VND:"₫",KRW:"₩",AZN:"₼",AMD:"֏",PLN:"zł",ILS:"₪",EGP:"E£",MYR:"RM",IDR:"Rp"};
var POPULAR = ["USD","EUR","RUB","UZS","KZT","KGS","TRY","AED","THB","CNY","GEL","GBP","JPY","VND","EGP","AZN","AMD","INR","MYR","IDR","PLN","ILS"];

var app = document.getElementById("app");

/* ========== состояние модуля ========== */
var TRIP_ID = null;     // id открытой сейчас поездки
var TRIP_META = null;   // запись из ts.trips для этой поездки (lastSeq, localOnly, appliedIds, state...)
var S = null;            // TRIP_META.state — свёрнутое состояние поездки (см. SPEC "Итоговое состояние")
var ME = null;           // participant id "кто я" на этом телефоне
var filterText = "";
var pollTimer = null;
var syncBusy = false;
var lastSyncError = null;

/* ========== Telegram Mini App ========== */
var TG = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
var TG_USER = null;

function initTelegram(){
  if(!TG) return;
  try{ TG.ready(); }catch(e){}
  try{ TG.expand(); }catch(e){}
  if(TG.initDataUnsafe && TG.initDataUnsafe.user){
    var u = TG.initDataUnsafe.user;
    TG_USER = ((u.first_name||"") + " " + (u.last_name||"")).trim() || u.username || null;
  }
  applyTelegramTheme();
  if(typeof TG.onEvent === "function"){
    try{ TG.onEvent("themeChanged", applyTelegramTheme); }catch(e){}
  }
}
function applyTelegramTheme(){
  if(!TG || !TG.themeParams) return;
  var tp = TG.themeParams;
  var root = document.documentElement.style;
  if(tp.bg_color){ root.setProperty("--bg", tp.bg_color); root.setProperty("--surface", tp.bg_color); }
  if(tp.secondary_bg_color) root.setProperty("--surface-2", tp.secondary_bg_color);
  if(tp.text_color) root.setProperty("--ink", tp.text_color);
  if(tp.hint_color) root.setProperty("--muted", tp.hint_color);
  if(tp.button_color) root.setProperty("--accent", tp.button_color);
  else if(tp.link_color) root.setProperty("--accent", tp.link_color);
}
function tgInitData(){ return (TG && TG.initData) ? TG.initData : null; }

/* ========== мелкие утилиты ========== */
function uid(){ return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,7); }
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function todayISO(){ var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
function parseAmount(str){
  var v = String(str||"").replace(/[\s ]/g,"").replace(",", ".").replace(/[^\d.]/g,"");
  var n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}

/* ========== хранилище (localStorage) ========== */
function loadTrips(){
  try{ var v = JSON.parse(localStorage.getItem(LS_TRIPS) || "[]"); return Array.isArray(v) ? v : []; }
  catch(e){ return []; }
}
function saveTrips(list){
  try{ localStorage.setItem(LS_TRIPS, JSON.stringify(list)); }
  catch(e){ toast(T("error.storageFailed")); }
}
function loadQueue(tripId){
  try{ var v = JSON.parse(localStorage.getItem(LS_QUEUE_PREFIX+tripId) || "[]"); return Array.isArray(v) ? v : []; }
  catch(e){ return []; }
}
function saveQueue(tripId, arr){
  try{ localStorage.setItem(LS_QUEUE_PREFIX+tripId, JSON.stringify(arr)); }
  catch(e){ toast(T("error.storageFailed")); }
}
function enqueueOp(tripId, op){
  var q = loadQueue(tripId);
  q.push(op);
  saveQueue(tripId, q);
}
function queueLen(){ return TRIP_ID ? loadQueue(TRIP_ID).length : 0; }
function loadMe(tripId){ try{ return localStorage.getItem(LS_ME_PREFIX+tripId) || null; }catch(e){ return null; } }
function saveMe(tripId, id){
  try{
    if(id) localStorage.setItem(LS_ME_PREFIX+tripId, id);
    else localStorage.removeItem(LS_ME_PREFIX+tripId);
  }catch(e){}
}
function loadLang(){ try{ return localStorage.getItem(LS_LANG) || "ru"; }catch(e){ return "ru"; } }
function saveLang(v){ try{ localStorage.setItem(LS_LANG, v); }catch(e){} }

function persistState(){
  if(!TRIP_ID || !TRIP_META) return;
  TRIP_META.state = S;
  TRIP_META.name = S.trip.name;
  TRIP_META.base = S.trip.base;
  TRIP_META.touched = Date.now();
  var list = loadTrips();
  var idx = -1;
  for(var i=0;i<list.length;i++){ if(list[i].id === TRIP_ID){ idx = i; break; } }
  if(idx >= 0) list[idx] = TRIP_META; else list.push(TRIP_META);
  saveTrips(list);
}
function markApplied(opId){
  TRIP_META.appliedIds.push(opId);
  if(TRIP_META.appliedIds.length > 6000){ TRIP_META.appliedIds = TRIP_META.appliedIds.slice(-5500); }
}

/* ========== свёртка операций в состояние (см. SPEC.md) ========== */
function freshState(){
  return {
    trip: {name:"", base:"USD"},
    currencies: [{code:"USD", rate:1}],
    people: [],
    expenses: [],
    payments: []
  };
}
function expenseFromPayload(p){
  return {
    id: p.eid, title: p.title || "", amount: Number(p.amount)||0,
    cur: (p.cur||"USD").toUpperCase(), payer: p.payer,
    parts: Array.isArray(p.parts) ? p.parts.slice() : [],
    date: p.date || "", note: p.note || ""
  };
}
function paymentFromPayload(p){
  return { id: p.payid, from: p.from, to: p.to, amount: Number(p.amount)||0, date: p.date || "", note: p.note || "" };
}
function applyOp(state, op){
  var p = op.payload || {};
  switch(op.kind){
    case "trip.meta":
      if(typeof p.name === "string" && p.name.trim()) state.trip.name = p.name.trim();
      if(typeof p.base === "string" && p.base.trim()){
        state.trip.base = p.base.trim().toUpperCase();
        var has = false;
        for(var i=0;i<state.currencies.length;i++){ if(state.currencies[i].code === state.trip.base) has = true; }
        if(!has) state.currencies.push({code: state.trip.base, rate:1});
      }
      state.currencies.forEach(function(c){ if(c.code === state.trip.base) c.rate = 1; });
      break;
    case "person.add":
      if(p.pid && !state.people.some(function(x){return x.id===p.pid;})) state.people.push({id:p.pid, name:p.name || "?"});
      break;
    case "person.rename":
      var per = state.people.filter(function(x){return x.id===p.pid;})[0];
      if(per && p.name) per.name = p.name;
      break;
    case "person.del":
      state.people = state.people.filter(function(x){return x.id !== p.pid;});
      break;
    case "cur.set":
      if(p.code){
        var code = p.code.toUpperCase();
        if(code === state.trip.base) break; // база всегда rate=1, редактированию не подлежит
        var rate = Number(p.rate);
        if(!isFinite(rate) || rate <= 0) break;
        var cur = state.currencies.filter(function(c){return c.code===code;})[0];
        if(cur) cur.rate = rate; else state.currencies.push({code:code, rate:rate});
      }
      break;
    case "cur.del":
      if(p.code){
        var delCode = p.code.toUpperCase();
        if(delCode !== state.trip.base) state.currencies = state.currencies.filter(function(c){return c.code!==delCode;});
      }
      break;
    case "expense.add":
      if(p.eid && !state.expenses.some(function(x){return x.id===p.eid;})) state.expenses.push(expenseFromPayload(p));
      break;
    case "expense.edit":
      var idx = -1;
      for(var j=0;j<state.expenses.length;j++){ if(state.expenses[j].id === p.eid){ idx = j; break; } }
      if(idx >= 0) state.expenses[idx] = expenseFromPayload(p);
      break;
    case "expense.del":
      state.expenses = state.expenses.filter(function(x){return x.id !== p.eid;});
      break;
    case "payment.add":
      if(p.payid && !state.payments.some(function(x){return x.id===p.payid;})) state.payments.push(paymentFromPayload(p));
      break;
    case "payment.del":
      state.payments = state.payments.filter(function(x){return x.id !== p.payid;});
      break;
  }
  return state;
}

/* ========== деньги — расчёты в целых центах (см. SPEC.md "Деньги") ========== */
function personById(id){ return S.people.filter(function(p){return p.id===id;})[0]; }
function nameOf(id){ var p = personById(id); return p ? p.name : "—"; }
function baseCode(){ return S.trip.base; }
function rateOf(code){
  var c = S.currencies.filter(function(x){return x.code===code;})[0];
  return c ? Number(c.rate) || 0 : 0;
}
function toCents(amount, code){ return Math.round((Number(amount)||0) * rateOf(code) * 100); }
function fmtNum(value, code){
  var dec = NO_DEC[code] ? 0 : 2;
  var abs = Math.abs(value);
  var s = abs.toFixed(dec);
  var parts = s.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (value < 0 ? "−" : "") + parts.join(",");
}
function money(cents, code){
  code = code || baseCode();
  var sym = SYM[code] || code;
  return fmtNum(cents/100, code) + " " + sym;
}
function moneyRaw(amount, code){
  var sym = SYM[code] || code;
  return fmtNum(amount, code) + " " + sym;
}

function compute(){
  var paid = {}, share = {}, order = {};
  S.people.forEach(function(p,i){ paid[p.id]=0; share[p.id]=0; order[p.id]=i; });
  var totalCents = 0;
  S.expenses.forEach(function(e){
    var cents = toCents(e.amount, e.cur);
    var parts = (e.parts||[]).filter(function(id){ return paid.hasOwnProperty(id); });
    if(!parts.length || !cents) return;
    totalCents += cents;
    if(paid.hasOwnProperty(e.payer)) paid[e.payer] += cents;
    parts.sort(function(a,b){ return order[a]-order[b]; });
    var per = Math.floor(cents/parts.length);
    var rem = cents - per*parts.length;
    parts.forEach(function(id,i){ share[id] += per + (i<rem?1:0); });
  });
  var settled = {};
  S.people.forEach(function(p){ settled[p.id]=0; });
  S.payments.forEach(function(pay){
    var c = Math.round((Number(pay.amount)||0)*100);
    if(settled.hasOwnProperty(pay.from)) settled[pay.from] += c;
    if(settled.hasOwnProperty(pay.to)) settled[pay.to] -= c;
  });
  var rows = S.people.map(function(p){
    return { id:p.id, name:p.name, paid:paid[p.id], share:share[p.id], settled:settled[p.id], balance: paid[p.id]-share[p.id]+settled[p.id] };
  });
  return { rows: rows, total: totalCents };
}
/* Порог «шума округления» в центах базовой валюты.
   При смене базовой валюты доли и возвраты пересчитываются по курсу, и на каждой
   трате остаётся копеечный хвост. Без порога это превращается в фантомные долги
   вроде «Аня → Вика 0,02 ฿», которых никто никому не должен.
   Для валют без копеек (сум, вон, донг) порог — одна целая единица. */
function noiseFloorCents(){ return NO_DEC[baseCode()] ? 100 : 5; }
function withoutNoise(cents){ return Math.abs(cents) <= noiseFloorCents() ? 0 : cents; }

function transfers(rows){
  var floor = noiseFloorCents();
  var debt = rows.filter(function(r){return r.balance < -floor;}).map(function(r){return {id:r.id, v:-r.balance};}).sort(function(a,b){return b.v-a.v;});
  var cred = rows.filter(function(r){return r.balance > floor;}).map(function(r){return {id:r.id, v:r.balance};}).sort(function(a,b){return b.v-a.v;});
  var out = [], i=0, j=0;
  while(i<debt.length && j<cred.length){
    var m = Math.min(debt[i].v, cred[j].v);
    if(m > floor) out.push({from:debt[i].id, to:cred[j].id, cents:m});
    debt[i].v -= m; cred[j].v -= m;
    if(debt[i].v<=0) i++;
    if(cred[j].v<=0) j++;
  }
  return out;
}

/* ========== автор операций ========== */
function authorName(){
  if(TG_USER) return TG_USER;
  if(TRIP_ID && ME){ var p = personById(ME); if(p) return p.name; }
  return T("author.guest");
}
function tryAutoMe(){
  if(!TG_USER || ME || !TRIP_ID || !S) return;
  var target = TG_USER.trim().toLowerCase();
  var match = S.people.filter(function(p){ return (p.name||"").trim().toLowerCase() === target; })[0];
  if(match){ ME = match.id; saveMe(TRIP_ID, ME); }
}

/* ========== применение локального действия: применить + поставить в очередь + отправить ========== */
function commit(kind, payload){
  var op = { id: uid(), kind: kind, ts: Date.now(), author: authorName(), payload: payload };
  applyOp(S, op);
  markApplied(op.id);
  persistState();
  enqueueOp(TRIP_ID, op);
  renderTrip();
  syncNow();
}

/* ========== синхронизация с Worker (см. SPEC.md "API" и "Клиент: хранение и синхронизация") ========== */
function apiUrl(path){ return window.TRIP_API.replace(/\/+$/,"") + path; }
function makeApiError(status, json){
  var e = new Error((json && json.message) || ("HTTP " + status));
  e.status = status;
  e.code = json && json.error;
  e.message = (json && json.message) || T("error.sendFailed");
  return e;
}
function reportSyncError(err){
  var key = (err && err.code) || (err && err.status) || "network";
  if(TRIP_META && TRIP_META._lastErrKey !== key){
    TRIP_META._lastErrKey = key;
    toast((err && err.message) || T("error.sendFailed"));
  }
}

function flushQueue(){
  var queue = loadQueue(TRIP_ID);
  if(!queue.length) return Promise.resolve();
  var batch = queue.slice(0, 50);
  var body = { ops: batch, author: authorName() };
  var initData = tgInitData();
  if(initData) body.initData = initData;
  return fetch(apiUrl("/api/trip/" + encodeURIComponent(TRIP_ID) + "/ops"), {
    method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body)
  }).then(function(r){
    if(!r.ok) return r.json().catch(function(){return null;}).then(function(j){ throw makeApiError(r.status, j); });
    return r.json().catch(function(){ return {}; });
  }).then(function(){
    var sentIds = {};
    batch.forEach(function(o){ sentIds[o.id] = true; });
    var rest = loadQueue(TRIP_ID).filter(function(o){ return !sentIds[o.id]; });
    saveQueue(TRIP_ID, rest);
    if(rest.length) return flushQueue();
  });
}

function pollServer(){
  var appliedCount = 0;
  var since = TRIP_META.pendingInitialSync ? 0 : TRIP_META.lastSeq;
  function page(sinceSeq){
    return fetch(apiUrl("/api/trip/" + encodeURIComponent(TRIP_ID) + "?since=" + sinceSeq), {cache:"no-store"})
      .then(function(r){
        if(!r.ok) return r.json().catch(function(){return null;}).then(function(j){ throw makeApiError(r.status, j); });
        return r.json();
      })
      .then(function(res){
        var ops = (res.ops || []).slice().sort(function(a,b){ return a.seq - b.seq; });
        ops.forEach(function(op){
          if(TRIP_META.appliedIds.indexOf(op.id) === -1){
            applyOp(S, op);
            TRIP_META.appliedIds.push(op.id);
            appliedCount++;
          }
          if(op.seq > TRIP_META.lastSeq) TRIP_META.lastSeq = op.seq;
        });
        if(typeof res.seq === "number" && res.seq > TRIP_META.lastSeq) TRIP_META.lastSeq = res.seq;
        if(res.more){
          var maxSeq = ops.length ? ops[ops.length-1].seq : sinceSeq;
          return page(maxSeq);
        }
      });
  }
  return page(since).then(function(){
    TRIP_META.pendingInitialSync = false;
    TRIP_META.localOnly = false;
    TRIP_META.notFoundOnServer = false;
    persistState();
    return appliedCount;
  });
}

function syncNow(){
  if(!TRIP_ID || !TRIP_META) return;
  if(!window.TRIP_API){ updateStatus(); return; }
  if(TRIP_META.localOnly && !TRIP_META.pendingInitialSync){ updateStatus(); return; }
  var wasPendingInitial = TRIP_META.pendingInitialSync;
  var qBefore = queueLen();
  syncBusy = true; updateStatus();
  flushQueue()
    .then(function(){ return pollServer(); })
    .then(function(appliedCount){
      syncBusy = false; lastSyncError = null;
      if(TRIP_META) TRIP_META._lastErrKey = null;
      updateStatus();
      if(wasPendingInitial || appliedCount > 0 || qBefore !== queueLen()) renderTrip();
    })
    .catch(function(err){
      syncBusy = false; lastSyncError = err;
      if(TRIP_META && err && err.code === "not_found"){ TRIP_META.notFoundOnServer = true; persistState(); }
      reportSyncError(err);
      updateStatus();
      if(wasPendingInitial) renderTrip();
    });
}

function startPolling(){
  stopPolling();
  pollTimer = setInterval(function(){ if(document.visibilityState === "visible") syncNow(); }, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
}
function stopPolling(){
  if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onFocus);
}
function onVisible(){ if(document.visibilityState === "visible") syncNow(); }
function onFocus(){ syncNow(); }

function updateStatus(){
  var el = document.getElementById("status");
  var textEl = document.getElementById("statusText");
  if(!el || !textEl) return;
  if(!TRIP_ID){ el.setAttribute("data-s","idle"); textEl.textContent = ""; return; }
  var qn = queueLen();
  if(!window.TRIP_API || (TRIP_META && TRIP_META.localOnly && !TRIP_META.pendingInitialSync)){
    el.setAttribute("data-s","local");
    textEl.textContent = qn>0 ? T("status.offlineQueue",{n:qn}) : T("status.local");
    return;
  }
  if(lastSyncError){
    el.setAttribute("data-s","error");
    textEl.textContent = qn>0 ? T("status.offlineQueue",{n:qn}) : T("status.syncError");
    return;
  }
  if(syncBusy){ el.setAttribute("data-s","saving"); textEl.textContent = T("status.saving"); return; }
  if(qn>0){ el.setAttribute("data-s","saving"); textEl.textContent = T("status.offlineQueue",{n:qn}); return; }
  el.setAttribute("data-s","saved"); textEl.textContent = T("status.saved");
}

/* ========== маршрутизация: список поездок <-> поездка ========== */
function route(){
  stopPolling();
  var h = location.hash || "";
  var m = h.match(/^#t=([^&]*)/);
  if(m && m[1]){
    openTrip(decodeURIComponent(m[1]));
  } else {
    TRIP_ID = null; TRIP_META = null; S = null; ME = null;
    lastSyncError = null;
    setScreenList();
    renderTripList();
    updateStatus();
  }
}

function openTrip(id){
  var list = loadTrips();
  var rec = list.filter(function(x){return x.id===id;})[0];
  if(!rec){
    rec = { id:id, name:"", base:"USD", lastSeq:0, state: freshState(),
      localOnly: !window.TRIP_API, pendingInitialSync: !!window.TRIP_API, appliedIds: [] };
    list.push(rec);
    saveTrips(list);
  }
  TRIP_ID = id;
  TRIP_META = rec;
  S = rec.state;
  ME = loadMe(id);
  if(ME && !personById(ME)) ME = null;
  filterText = "";
  lastSyncError = null;
  setScreenTrip();
  renderTrip();
  startPolling();
  syncNow();
}

function tripLinkFor(id){ return location.origin + location.pathname + "#t=" + encodeURIComponent(id); }

function createTrip(name, base){
  name = (name||"").trim() || T("trips.untitled");
  base = (base||"USD").toUpperCase();
  function finish(id, localOnly, showFailToast){
    var rec = { id:id, name:name, base:base, lastSeq:0, state: freshState(), localOnly: localOnly, pendingInitialSync:false, appliedIds:[] };
    var list = loadTrips();
    list.push(rec);
    saveTrips(list);
    openTrip(id);
    commit("trip.meta", {name:name, base:base});
    location.hash = "#t=" + encodeURIComponent(id);
    if(showFailToast) toast(T("trips.createFailed"));
    else toast(T("trips.created"));
  }
  if(window.TRIP_API){
    fetch(apiUrl("/api/trip"), {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({name:name, base:base})})
      .then(function(r){ if(!r.ok) throw new Error("bad status"); return r.json(); })
      .then(function(res){ if(!res || !res.tripId) throw new Error("no tripId"); finish(res.tripId, false, false); })
      .catch(function(){ finish("local-"+uid(), true, true); });
  } else {
    finish("local-"+uid(), true, false);
  }
}

function copyTripLink(id){
  var link = tripLinkFor(id);
  function fallback(){
    var m = modal(T("trips.copyLink"), '<textarea class="inp" style="height:80px">'+esc(link)+'</textarea>', '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("modal.close"))+'</button>');
    var ta = m.querySelector("textarea"); ta.focus(); ta.select();
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(function(){ toast(T("trips.linkCopied")); }, fallback);
  } else fallback();
}

function confirmDeleteTrip(id){
  var list = loadTrips();
  var rec = list.filter(function(x){return x.id===id;})[0];
  var name = rec ? (rec.name || T("trips.untitled")) : id;
  var m = modal(T("trips.deleteConfirm.title"), "<div>"+esc(T("trips.deleteConfirm.body",{name:name}))+"</div>",
    '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("trips.deleteConfirm.cancel"))+'</button><button class="btn btn-danger" id="yes">'+esc(T("trips.deleteConfirm.ok"))+'</button>');
  m.querySelector("#yes").addEventListener("click", function(){
    var list2 = loadTrips().filter(function(x){return x.id!==id;});
    saveTrips(list2);
    try{ localStorage.removeItem(LS_QUEUE_PREFIX+id); localStorage.removeItem(LS_ME_PREFIX+id); }catch(e){}
    m.close();
    renderTripList();
  });
}

function openNewTripModal(){
  var body = '<div class="field"><label for="ntName">'+esc(T("trips.new.name"))+'</label><input class="inp" id="ntName" placeholder="'+esc(T("trips.new.namePlaceholder"))+'" autocomplete="off"></div>'+
    '<div class="field"><label for="ntBase">'+esc(T("trips.new.base"))+'</label><select class="inp" id="ntBase">'+
    POPULAR.map(function(c){ return '<option value="'+esc(c)+'"'+(c==="USD"?" selected":"")+'>'+esc(c)+'</option>'; }).join("")+
    '</select></div>';
  var foot = '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("trips.new.cancel"))+'</button><button class="btn btn-primary" id="ntOk">'+esc(T("trips.new.create"))+'</button>';
  var m = modal(T("trips.new.title"), body, foot);
  m.querySelector("#ntOk").addEventListener("click", function(){
    var name = m.querySelector("#ntName").value.trim();
    if(!name){ toast(T("trips.new.nameRequired")); m.querySelector("#ntName").focus(); return; }
    var base = m.querySelector("#ntBase").value;
    m.close();
    createTrip(name, base);
  });
  setTimeout(function(){ var n=m.querySelector("#ntName"); if(n) n.focus(); }, 60);
}

/* ========== экран: шапка ========== */
function setScreenTrip(){
  document.getElementById("btnBack").hidden = false;
  document.getElementById("brandMark").hidden = true;
  var tn = document.getElementById("tripName");
  tn.hidden = false;
  tn.value = S.trip.name;
}
function setScreenList(){
  document.getElementById("btnBack").hidden = true;
  document.getElementById("tripName").hidden = true;
  var bm = document.getElementById("brandMark");
  bm.hidden = !!TG; // Телеграм уже показывает свой заголовок
  bm.textContent = T("app.brand");
  document.getElementById("fab").hidden = true;
}
function renderAll(){
  document.title = T("app.brand");
  if(TRIP_ID){ setScreenTrip(); renderTrip(); }
  else { setScreenList(); renderTripList(); }
  updateStatus();
}

/* ========== экран: список поездок ========== */
function renderTripList(){
  var list = loadTrips();
  var h = [];
  if(!window.TRIP_API) h.push('<div class="banner">'+esc(T("banner.noApi"))+'</div>');
  h.push('<section><div class="eyebrow">'+esc(T("trips.title"))+'<span class="sp"></span><button class="btn btn-primary btn-sm" id="btnNewTrip">'+esc(T("trips.add"))+'</button></div>');
  if(!list.length){
    h.push('<div class="card"><div class="empty"><b>'+esc(T("trips.empty.title"))+'</b>'+esc(T("trips.empty.hint"))+'</div></div>');
  } else {
    h.push('<div class="card">');
    list.slice().sort(function(a,b){ return (b.touched||0)-(a.touched||0); }).forEach(function(rec){
      var n = (rec.state && rec.state.expenses) ? rec.state.expenses.length : 0;
      h.push('<div class="tripcard">');
      h.push('<div class="tripcard-name">'+esc(rec.name||T("trips.untitled"))+(rec.localOnly?'<span class="badge">'+esc(T("trips.card.localBadge"))+'</span>':'')+'</div>');
      h.push('<div class="tripcard-meta">'+esc(TP("trips.card.expensesCount", n))+' · '+esc(T("trips.card.base",{code:rec.base}))+'</div>');
      h.push('<div class="tripcard-acts">');
      h.push('<button class="btn btn-sm" data-act="open" data-id="'+esc(rec.id)+'">'+esc(T("trips.open"))+'</button>');
      h.push('<button class="btn btn-sm" data-act="copylink" data-id="'+esc(rec.id)+'">'+esc(T("trips.copyLink"))+'</button>');
      h.push('<button class="btn-ghost" data-act="deltrip" data-id="'+esc(rec.id)+'">'+esc(T("trips.delete"))+'</button>');
      h.push('</div></div>');
    });
    h.push('</div>');
  }
  h.push('</section>');
  h.push('<div class="footnote">'+esc(T("footer.version",{date:APP_VERSION_DATE}))+'</div>');
  app.innerHTML = h.join("");
  var btn = document.getElementById("btnNewTrip");
  if(btn) btn.addEventListener("click", openNewTripModal);
}

/* ========== экран: поездка ========== */
function chipHTML(kind, name, id, value, checked, label, cls, extraAttrs){
  return '<span class="chipwrap"><input type="'+kind+'" name="'+esc(name)+'" id="'+esc(id)+'" value="'+esc(value)+'"'+(checked?" checked":"")+(extraAttrs||"")+'>'+
    '<label class="chip'+(cls?" "+cls:"")+'" for="'+esc(id)+'">'+esc(label)+'</label></span>';
}

function dayLabel(iso){
  if(!iso) return T("expenses.noDate");
  var p = iso.split("-");
  var d = parseInt(p[2],10), mo = parseInt(p[1],10)-1;
  if(isNaN(d) || isNaN(mo)) return iso;
  var out = d + " " + T("date.month."+mo);
  var now = new Date();
  if(String(now.getFullYear()) !== p[0]) out += " " + p[0];
  if(iso === todayISO()) out += T("date.todaySuffix");
  return out;
}

function peopleFormHTML(){
  var h = [];
  S.people.forEach(function(p){
    var used = S.expenses.some(function(e){return e.payer===p.id || (e.parts||[]).indexOf(p.id)>=0;}) ||
               S.payments.some(function(x){return x.from===p.id || x.to===p.id;});
    h.push('<div class="list-line"><input class="inp" data-act="rename" data-id="'+esc(p.id)+'" value="'+esc(p.name)+'" style="flex:1">'+
           '<button class="btn-ghost" data-act="delperson" data-id="'+esc(p.id)+'"'+(used?' title="'+esc(T("settings.people.usedHint"))+'"':'')+'>'+esc(T("settings.people.delete"))+'</button></div>');
  });
  h.push('<div class="inline-form"><input class="inp" id="newPerson" placeholder="'+esc(T("settings.people.namePlaceholder"))+'" autocomplete="off"><button class="btn btn-primary btn-sm" data-act="addperson">'+esc(T("settings.people.add"))+'</button></div>');
  return h.join("");
}

function howtoHTML(){
  return '<div class="howto"><b>'+esc(T("howto.ios.title"))+'</b><ol><li>'+esc(T("howto.ios.1"))+'</li><li>'+esc(T("howto.ios.2"))+'</li><li>'+esc(T("howto.ios.3"))+'</li></ol></div>'+
    '<div class="howto"><b>'+esc(T("howto.android.title"))+'</b><ol><li>'+esc(T("howto.android.1"))+'</li><li>'+esc(T("howto.android.2"))+'</li><li>'+esc(T("howto.android.3"))+'</li></ol></div>';
}

function renderTrip(){
  tryAutoMe();
  var c = compute();
  var rows = c.rows;
  var tr = transfers(rows);
  var maxAbs = rows.reduce(function(m,r){return Math.max(m, Math.abs(r.balance));}, 1);
  var h = [];

  if(!window.TRIP_API) h.push('<div class="banner">'+esc(T("banner.noApi"))+'</div>');
  else if(TRIP_META.notFoundOnServer) h.push('<div class="banner warn">'+esc(T("banner.tripNotFound"))+'</div>');
  else if(TRIP_META.localOnly) h.push('<div class="banner">'+esc(T("banner.localOnlyTrip"))+'</div>');
  else if(lastSyncError) h.push('<div class="banner warn">'+esc(T("banner.apiDown"))+'</div>');

  if(!S.people.length){
    h.push('<section><div class="card"><div class="empty"><b>'+esc(T("onboarding.title"))+'</b>'+esc(T("onboarding.hint"))+'</div>'+
      '<div class="pad"><button class="btn btn-primary" data-act="people">'+esc(T("onboarding.addBtn"))+'</button></div></div></section>');
    app.innerHTML = h.join("");
    document.getElementById("fab").hidden = true;
    updateStatus();
    return;
  }
  var fabEl = document.getElementById("fab");
  fabEl.hidden = false;
  fabEl.textContent = T("fab.addExpense");

  var perPerson = S.people.length ? Math.round(c.total/S.people.length) : 0;
  h.push("<section>");
  h.push('<div class="eyebrow">'+esc(T("section.totals.title"))+'<span class="sp"></span><span class="count">'+esc(TP("trips.card.expensesCount", S.expenses.length))+'</span></div>');
  h.push('<div class="card"><div class="totals">');
  h.push('<div class="tot"><div class="lbl">'+esc(T("totals.spent"))+'</div><div class="val num">'+money(c.total)+'</div></div>');
  h.push('<div class="tot"><div class="lbl">'+esc(T("totals.perPerson"))+'</div><div class="val num">'+money(perPerson)+'</div></div>');
  h.push('<div class="tot"><div class="lbl">'+esc(T("totals.people"))+'</div><div class="val num">'+S.people.length+'</div></div>');
  h.push("</div></div></section>");

  h.push("<section>");
  h.push('<div class="eyebrow">'+esc(T("section.transfers.title"))+'<span class="sp"></span>'+(tr.length?'<span class="count">'+tr.length+'</span>':'')+'</div>');
  h.push('<div class="card">');
  if(!tr.length){
    h.push('<div class="all-clear"><div class="big">'+esc(T("transfers.allClear.title"))+'</div><div class="muted small" style="margin-top:4px">'+esc(T("transfers.allClear.hint"))+'</div></div>');
  } else {
    tr.forEach(function(t,i){
      var mine = (ME===t.from || ME===t.to);
      h.push('<div class="transfer'+(mine?' mine':'')+'">');
      h.push('<div class="tr-body"><span class="who">'+esc(nameOf(t.from))+'</span><span class="arrow">→</span><span class="who">'+esc(nameOf(t.to))+'</span></div>');
      h.push('<div class="tr-amt num">'+money(t.cents)+'</div>');
      h.push('<button class="btn btn-sm" data-act="settle" data-i="'+i+'">'+esc(T("transfers.settleBtn"))+'</button>');
      h.push("</div>");
    });
    h.push('<div class="tear"></div><div class="settled-note">'+esc(T("transfers.settledNote"))+'</div>');
  }
  h.push("</div></section>");

  h.push('<section><div class="eyebrow">'+esc(T("section.balances.title"))+'<span class="sp"></span><button class="btn" data-act="people">'+esc(T("balances.addPerson"))+'</button></div><div class="card">');
  rows.forEach(function(r){
    var shown = withoutNoise(r.balance);   // копеечный хвост от смены валюты — не долг
    var pos = shown>0, zero = shown===0;
    var w = Math.round(Math.abs(shown)/maxAbs*100);
    h.push('<div class="bal'+(ME===r.id?' mine':'')+'">');
    h.push('<div class="bal-name">'+esc(r.name)+(ME===r.id?'<span class="you-tag">'+esc(T("balances.you"))+'</span>':'')+'</div>');
    h.push('<div class="bal-sum num '+(zero?'muted':(pos?'pos':'neg'))+'">'+(zero?money(0):(pos?'+':'')+money(shown))+'</div>');
    var detail = r.settled ? T("balances.detailSettled",{paid:money(r.paid),share:money(r.share),settled:(r.settled>0?'+':'')+money(r.settled)}) : T("balances.detail",{paid:money(r.paid),share:money(r.share)});
    h.push('<div class="bal-sub num">'+esc(detail)+'</div>');
    h.push('<div class="bal-bar"><i class="'+(pos?'bar-pos':'bar-neg')+'" style="width:'+w+'%;'+(pos?'left:0':'right:0')+'"></i></div>');
    h.push("</div>");
  });
  h.push('</div><div class="hint" style="margin-top:8px">'+esc(T("balances.hint"))+'</div></section>');

  h.push('<section><div class="eyebrow">'+esc(T("section.expenses.title"))+'<span class="sp"></span></div><div class="card">');
  h.push('<div class="filterbar"><input class="inp" id="filter" placeholder="'+esc(T("expenses.filterPlaceholder"))+'" value="'+esc(filterText)+'">'+
         '<button class="btn btn-sm" data-act="copy">'+esc(T("expenses.copySummary"))+'</button></div>');
  var list = S.expenses.slice().sort(function(a,b){ if(a.date===b.date) return (b.ts||0)-(a.ts||0); return (a.date<b.date)?1:-1; });
  if(filterText){
    var q = filterText.toLowerCase();
    list = list.filter(function(e){ return (e.title||"").toLowerCase().indexOf(q)>=0 || nameOf(e.payer).toLowerCase().indexOf(q)>=0; });
  }
  if(!list.length){
    h.push('<div class="empty"><b>'+esc(filterText?T("expenses.emptyFiltered.title"):T("expenses.empty.title"))+'</b>'+esc(filterText?T("expenses.emptyFiltered.hint"):T("expenses.empty.hint"))+'</div>');
  } else {
    var lastDay = null;
    list.forEach(function(e){
      if(e.date !== lastDay){ lastDay = e.date; h.push('<div class="daygroup">'+esc(dayLabel(e.date))+'</div>'); }
      var cents = toCents(e.amount, e.cur);
      var parts = (e.parts||[]).filter(function(id){return personById(id);});
      var forWho = parts.length === S.people.length ? T("expenses.for.all") : parts.map(function(id){return nameOf(id);}).join(", ");
      var perShareTxt = money(parts.length ? Math.round(cents/parts.length) : 0);
      var metaKey = e.note ? "expenses.metaNote" : "expenses.meta";
      h.push('<div class="exp">');
      h.push('<div class="exp-main"><div class="exp-title">'+esc(e.title || T("expenses.noTitle"))+'</div>');
      h.push('<div class="exp-meta">'+esc(T(metaKey, {payer: nameOf(e.payer), forWhom: forWho, perShare: perShareTxt, note: e.note||""}))+'</div></div>');
      h.push('<div class="exp-right"><div class="exp-amt num">'+moneyRaw(e.amount, e.cur)+'</div>');
      if(e.cur !== baseCode()) h.push('<div class="exp-conv num">'+money(cents)+'</div>');
      h.push('<div class="exp-acts"><button class="btn-ghost" data-act="edit" data-id="'+esc(e.id)+'">'+esc(T("expenses.edit"))+'</button><button class="btn-ghost" data-act="del" data-id="'+esc(e.id)+'">'+esc(T("expenses.delete"))+'</button></div>');
      h.push("</div></div>");
    });
  }
  h.push("</div></section>");

  if(S.payments.length){
    h.push('<section><div class="eyebrow">'+esc(T("section.payments.title"))+'<span class="sp"></span><span class="count">'+S.payments.length+'</span></div><div class="card">');
    S.payments.slice().reverse().forEach(function(p){
      h.push('<div class="list-line"><div style="flex:1"><b>'+esc(nameOf(p.from))+'</b> → <b>'+esc(nameOf(p.to))+'</b><div class="tiny muted">'+esc(dayLabel(p.date))+(p.note?' · '+esc(p.note):'')+'</div></div>'+
             '<div class="num" style="font-weight:600">'+money(Math.round(p.amount*100))+'</div>'+
             '<button class="btn-ghost" data-act="delpay" data-id="'+esc(p.id)+'">'+esc(T("payments.delete"))+'</button></div>');
    });
    h.push("</div></section>");
  }

  h.push('<section><div class="eyebrow">'+esc(T("section.settings.title"))+'<span class="sp"></span></div><div class="card">');
  h.push('<details class="setup"><summary>'+esc(T("settings.people.summary",{n:S.people.length}))+'</summary>'+peopleFormHTML()+'</details>');

  h.push('<details class="setup"><summary>'+esc(T("settings.currencies.summary",{code:baseCode()}))+'</summary>');
  h.push('<div class="pad hint">'+esc(T("settings.currencies.hint",{base:baseCode()}))+'</div>');
  S.currencies.forEach(function(cur){
    var isBase = cur.code === baseCode();
    h.push('<div class="list-line"><div style="width:64px; font-weight:600" class="num">'+esc(cur.code)+'</div>');
    if(isBase){
      h.push('<div class="hint" style="flex:1">'+esc(T("settings.currencies.baseNote"))+'</div>');
      h.push('<button class="btn btn-sm" data-act="delcur" data-code="'+esc(cur.code)+'" disabled>—</button>');
    } else {
      h.push('<div style="flex:1" class="row"><span class="hint">1 '+esc(cur.code)+' =</span><input class="inp num" style="width:120px; padding:6px 9px" data-act="rate" data-code="'+esc(cur.code)+'" value="'+esc(cur.rate)+'" inputmode="decimal"><span class="hint">'+esc(baseCode())+'</span></div>');
      h.push('<button class="btn-ghost" data-act="delcur" data-code="'+esc(cur.code)+'">'+esc(T("settings.currencies.delete"))+'</button>');
    }
    h.push("</div>");
  });
  h.push('<div class="inline-form"><input class="inp" id="newCur" placeholder="'+esc(T("settings.currencies.codePlaceholder"))+'" maxlength="6" style="max-width:190px"><input class="inp num" id="newRate" placeholder="'+esc(T("settings.currencies.ratePlaceholder",{base:baseCode()}))+'" inputmode="decimal" style="max-width:190px"><button class="btn btn-sm" data-act="addcur">'+esc(T("settings.currencies.add"))+'</button></div>');
  h.push('<div class="inline-form"><div class="row" style="flex:1; flex-wrap:wrap"><span class="hint">'+esc(T("settings.currencies.baseLabel"))+'</span><select class="inp" id="baseSel" style="max-width:150px">'+
         S.currencies.map(function(c){return '<option value="'+esc(c.code)+'"'+(c.code===baseCode()?' selected':'')+'>'+esc(c.code)+'</option>';}).join("")+
         '</select></div></div>');
  h.push("</details>");

  h.push('<details class="setup"><summary>'+esc(T("settings.howto.summary"))+'</summary>'+howtoHTML()+'</details>');

  h.push('<details class="setup"><summary>'+esc(T("settings.me.summary"))+'</summary><div class="pad"><div class="chips">');
  h.push(chipHTML("radio","me","me-none","", !ME, T("settings.me.clear"), "soft", ' data-act="me"'));
  S.people.forEach(function(p){
    h.push(chipHTML("radio","me","me-"+p.id, p.id, ME===p.id, p.name, "soft", ' data-act="me"'));
  });
  h.push('</div><div class="hint" style="margin-top:8px">'+esc(T("settings.me.hint"))+'</div></div></details>');

  h.push("</div></section>");

  h.push('<div class="footnote">'+esc(T("howto.invite"))+'<br>'+esc(T("footer.note",{base:baseCode()}))+'</div>');
  h.push('<div class="footnote">'+esc(T("footer.version",{date:APP_VERSION_DATE}))+'</div>');

  app.innerHTML = h.join("");
  bindTripEvents();
  updateStatus();
}

function bindTripEvents(){
  var f = document.getElementById("filter");
  if(f){
    f.addEventListener("input", function(){
      filterText = f.value;
      var pos = f.selectionStart;
      renderTrip();
      var nf = document.getElementById("filter");
      if(nf){ nf.focus(); try{ nf.setSelectionRange(pos,pos); }catch(e){} }
    });
  }
  var np = document.getElementById("newPerson");
  if(np) np.addEventListener("keydown", function(e){ if(e.key === "Enter") addPersonInline(); });
  var bs = document.getElementById("baseSel");
  if(bs) bs.addEventListener("change", function(){ setBaseCurrency(bs.value); });
}

/* ========== действия: участники ========== */
function addPersonInline(){
  var el = document.getElementById("newPerson");
  var name = (el.value||"").trim();
  if(!name){ el.focus(); return; }
  commit("person.add", {pid: uid(), name: name});
  var n = document.getElementById("newPerson");
  if(n) n.focus();
}
function removePerson(id){
  var used = S.expenses.some(function(e){return e.payer===id || (e.parts||[]).indexOf(id)>=0;}) ||
             S.payments.some(function(x){return x.from===id || x.to===id;});
  if(used){ toast(T("peopleModal.deleteBlocked")); return; }
  commit("person.del", {pid:id});
  if(ME === id){ ME = null; saveMe(TRIP_ID, null); }
}
function setMe(id){
  ME = id || null;
  saveMe(TRIP_ID, ME);
  renderTrip();
}

/* ========== действия: валюты ========== */
function addCurrencyInline(){
  var codeEl = document.getElementById("newCur");
  var rateEl = document.getElementById("newRate");
  var code = (codeEl.value||"").trim().toUpperCase().replace(/[^A-ZА-Я]/g,"");
  var rate = parseAmount(rateEl.value);
  if(!code){ toast(T("settings.currencies.codeRequired")); return; }
  if(S.currencies.some(function(c){return c.code===code;})){ toast(T("settings.currencies.alreadyExists")); return; }
  if(!isFinite(rate) || rate<=0){ toast(T("settings.currencies.rateRequired",{base:baseCode(), code:code})); return; }
  commit("cur.set", {code:code, rate:rate});
}
function removeCurrencyInline(code){
  if(S.expenses.some(function(e){return e.cur===code;})){ toast(T("settings.currencies.usedInExpenses")); return; }
  commit("cur.del", {code:code});
}
function setBaseCurrency(code){
  if(code === baseCode()) return;
  var newBase = S.currencies.filter(function(c){return c.code===code;})[0];
  if(!newBase) return;
  var k = Number(newBase.rate) || 1;
  var snapshot = S.currencies.map(function(c){ return {code:c.code, rate:Number(c.rate)||0}; });
  // Возвраты долгов записаны в СТАРОЙ базовой валюте — их суммы нужно пересчитать,
  // иначе после смены базы старые погашения молча превратятся в другие деньги.
  // Формат журнала не знает операции «изменить платёж», поэтому переписываем парой
  // удаление + добавление с новой суммой (id платежа сохраняем, чтобы не плодить записи).
  var oldPayments = S.payments.map(function(p){
    return {id:p.id, from:p.from, to:p.to, amount:Number(p.amount)||0, date:p.date, note:p.note||""};
  });

  commit("trip.meta", {base: code});
  snapshot.forEach(function(c){
    if(c.code === code) return;
    commit("cur.set", {code:c.code, rate: c.rate / k});
  });
  oldPayments.forEach(function(p){
    var converted = Math.round((p.amount / k) * 100) / 100;
    commit("payment.del", {payid: p.id});
    commit("payment.add", {payid: p.id, from: p.from, to: p.to, amount: converted, date: p.date, note: p.note});
  });
  toast(T("settings.currencies.rescaled", {code:code}));
}

/* ========== действия: платежи ========== */
function deletePayment(id){ commit("payment.del", {payid:id}); }

/* ========== делегированные обработчики на #app (общие для обоих экранов) ========== */
app.addEventListener("click", function(ev){
  var t = ev.target.closest("[data-act]");
  if(!t) return;
  var act = t.getAttribute("data-act");
  var id = t.getAttribute("data-id");
  switch(act){
    case "open": location.hash = "#t=" + encodeURIComponent(id); break;
    case "copylink": copyTripLink(id); break;
    case "deltrip": confirmDeleteTrip(id); break;
    case "people": openPeople(); break;
    case "addperson": addPersonInline(); break;
    case "delperson": removePerson(id); break;
    case "edit": openExpense(id); break;
    case "del": confirmDeleteExpense(id); break;
    case "delpay": deletePayment(id); break;
    case "settle": openSettle(parseInt(t.getAttribute("data-i"),10)); break;
    case "addcur": addCurrencyInline(); break;
    case "delcur": removeCurrencyInline(t.getAttribute("data-code")); break;
    case "copy": copySummary(); break;
  }
});
app.addEventListener("change", function(ev){
  var t = ev.target.closest("[data-act]");
  if(!t) return;
  var act = t.getAttribute("data-act");
  if(act === "rename"){
    var pid = t.getAttribute("data-id");
    var name = t.value.trim();
    if(name) commit("person.rename", {pid:pid, name:name});
    else t.value = nameOf(pid);
  } else if(act === "rate"){
    var code = t.getAttribute("data-code");
    var r = parseAmount(t.value);
    if(isFinite(r) && r>0) commit("cur.set", {code:code, rate:r});
    else { toast(T("settings.currencies.rateInvalid")); renderTrip(); }
  } else if(act === "me"){
    setMe(t.value || null);
  }
});

/* ========== модалки ========== */
function modal(title, bodyHTML, footHTML){
  var scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>'+esc(title)+'</h3><button class="x" data-close aria-label="'+esc(T("modal.close"))+'">×</button></div>'+
                    '<div class="modal-body">'+bodyHTML+'</div><div class="modal-foot">'+footHTML+'</div></div>';
  document.body.appendChild(scrim);
  scrim.addEventListener("click", function(e){ if(e.target === scrim || e.target.hasAttribute("data-close")) close(); });
  function onKey(e){ if(e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  function close(){ document.removeEventListener("keydown", onKey); scrim.remove(); }
  scrim.close = close;
  return scrim;
}

function openPeople(){
  var m = modal(T("peopleModal.title"), '<div id="pplList"></div>',
    '<div style="flex:1"></div><button class="btn btn-primary" data-close>'+esc(T("peopleModal.done"))+'</button>');
  function addNew(){
    var inp = m.querySelector("#pplNew");
    var name = (inp.value||"").trim();
    if(!name){ inp.focus(); return; }
    commit("person.add", {pid: uid(), name: name});
    draw();
    var n = m.querySelector("#pplNew"); if(n) n.focus();
  }
  function draw(){
    var h = [];
    S.people.forEach(function(pp){
      h.push('<div class="row" style="gap:8px"><input class="inp" data-ren="'+esc(pp.id)+'" value="'+esc(pp.name)+'">'+
             '<button class="btn-ghost" data-rm="'+esc(pp.id)+'">'+esc(T("settings.people.delete"))+'</button></div>');
    });
    h.push('<div class="row" style="gap:8px"><input class="inp" id="pplNew" placeholder="'+esc(T("peopleModal.newPlaceholder"))+'" autocomplete="off">'+
           '<button class="btn btn-primary btn-sm" id="pplAdd">'+esc(T("peopleModal.add"))+'</button></div>');
    h.push('<div class="hint">'+esc(T("peopleModal.hint"))+'</div>');
    var box = m.querySelector("#pplList");
    box.innerHTML = '<div style="display:flex; flex-direction:column; gap:10px">'+h.join("")+'</div>';
    box.querySelector("#pplAdd").addEventListener("click", addNew);
    box.querySelector("#pplNew").addEventListener("keydown", function(e){ if(e.key === "Enter") addNew(); });
    Array.prototype.forEach.call(box.querySelectorAll("[data-ren]"), function(el){
      el.addEventListener("change", function(){
        var pp = personById(el.getAttribute("data-ren"));
        if(pp){ var name = el.value.trim() || pp.name; commit("person.rename", {pid:pp.id, name:name}); el.value = name; }
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-rm]"), function(el){
      el.addEventListener("click", function(){ removePerson(el.getAttribute("data-rm")); draw(); });
    });
  }
  draw();
  setTimeout(function(){ var n = m.querySelector("#pplNew"); if(n) n.focus(); }, 60);
}

function openExpense(id){
  var existing = id ? S.expenses.filter(function(x){return x.id===id;})[0] : null;
  var isNew = !existing;
  var draft = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: uid(), title:"", amount:"", cur: baseCode(),
    payer: (ME || (S.people[0] && S.people[0].id) || ""),
    parts: S.people.map(function(p){return p.id;}),
    date: todayISO(), note:""
  };
  if(!draft.parts.length) draft.parts = S.people.map(function(p){return p.id;});

  var mu = uid().replace(/[^a-z0-9]/gi,"");
  var body = [];
  body.push('<div class="field"><label for="mAmt-'+mu+'">'+esc(T("expenseModal.amountLabel"))+'</label><div class="amount-row">'+
    '<input class="inp num" id="mAmt-'+mu+'" inputmode="decimal" placeholder="0" value="'+esc(draft.amount)+'">'+
    '<select class="inp" id="mCur-'+mu+'">'+S.currencies.map(function(c){return '<option value="'+esc(c.code)+'"'+(c.code===draft.cur?' selected':'')+'>'+esc(c.code)+'</option>';}).join("")+'</select>'+
    '</div><div class="hint" id="mConv-'+mu+'"></div></div>');
  body.push('<div class="field"><label for="mTitle-'+mu+'">'+esc(T("expenseModal.titleLabel"))+'</label><input class="inp" id="mTitle-'+mu+'" placeholder="'+esc(T("expenseModal.titlePlaceholder"))+'" value="'+esc(draft.title)+'"></div>');
  body.push('<div class="field"><label>'+esc(T("expenseModal.payerLabel"))+'</label><div class="chips" id="mPayer-'+mu+'">'+
    S.people.map(function(p){ return chipHTML("radio","payer-"+mu,"payer-"+mu+"-"+p.id,p.id,draft.payer===p.id,p.name,""); }).join("")+'</div></div>');
  body.push('<div class="field"><label>'+esc(T("expenseModal.partsLabel"))+'</label><div class="chips" id="mParts-'+mu+'">'+
    S.people.map(function(p){ return chipHTML("checkbox","parts-"+mu,"parts-"+mu+"-"+p.id,p.id,draft.parts.indexOf(p.id)>=0,p.name,"soft"); }).join("")+'</div>'+
    '<div class="row" style="margin-top:6px; flex-wrap:wrap"><button type="button" class="btn btn-sm" id="mAll-'+mu+'">'+esc(T("expenseModal.all"))+'</button>'+
    '<button type="button" class="btn btn-sm" id="mNone-'+mu+'">'+esc(T("expenseModal.none"))+'</button>'+
    '<button type="button" class="btn btn-sm" id="mAddP-'+mu+'">'+esc(T("expenseModal.addPerson"))+'</button>'+
    '<span class="hint" id="mPer-'+mu+'"></span></div>'+
    '<div class="row" id="mNewWrap-'+mu+'" style="margin-top:8px; gap:8px" hidden><input class="inp" id="mNewP-'+mu+'" placeholder="'+esc(T("expenseModal.newPersonPlaceholder"))+'" autocomplete="off"><button type="button" class="btn btn-primary btn-sm" id="mNewOk-'+mu+'">'+esc(T("expenseModal.addPersonOk"))+'</button></div></div>');
  body.push('<div class="grid2"><div class="field"><label for="mDate-'+mu+'">'+esc(T("expenseModal.dateLabel"))+'</label><input class="inp" id="mDate-'+mu+'" type="date" value="'+esc(draft.date)+'"></div>'+
    '<div class="field"><label for="mNote-'+mu+'">'+esc(T("expenseModal.noteLabel"))+'</label><input class="inp" id="mNote-'+mu+'" placeholder="'+esc(T("expenseModal.notePlaceholder"))+'" value="'+esc(draft.note||"")+'"></div></div>');

  var foot = (isNew ? "" : '<button class="btn btn-danger" id="mDel-'+mu+'">'+esc(T("expenseModal.delete"))+'</button>') +
             '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("modal.cancel"))+'</button>'+
             '<button class="btn btn-primary" id="mSave-'+mu+'">'+esc(isNew ? T("expenseModal.add") : T("expenseModal.save"))+'</button>';

  var m = modal(isNew ? T("expenseModal.new.title") : T("expenseModal.edit.title"), body.join(""), foot);
  var amt = m.querySelector("#mAmt-"+mu);
  var cur = m.querySelector("#mCur-"+mu);

  function refresh(){
    var a = parseAmount(amt.value);
    var code = cur.value;
    var conv = m.querySelector("#mConv-"+mu);
    if(isFinite(a) && code !== baseCode()) conv.textContent = T("expenseModal.convApprox", {amount: money(toCents(a,code)), rate: rateOf(code)});
    else conv.textContent = code === baseCode() ? T("expenseModal.convBase") : "";
    var n = m.querySelectorAll("#mParts-"+mu+" input:checked").length;
    m.querySelector("#mPer-"+mu).textContent = (isFinite(a) && n) ? T("expenseModal.perShare", {amount: money(Math.round(toCents(a,code)/n))}) : "";
  }
  amt.addEventListener("input", refresh);
  cur.addEventListener("change", refresh);
  m.querySelector("#mParts-"+mu).addEventListener("change", refresh);

  function addChip(person){
    var tmp = document.createElement("div");
    tmp.innerHTML = chipHTML("radio","payer-"+mu,"payer-"+mu+"-"+person.id,person.id,false,person.name,"");
    m.querySelector("#mPayer-"+mu).appendChild(tmp.firstElementChild);
    tmp = document.createElement("div");
    tmp.innerHTML = chipHTML("checkbox","parts-"+mu,"parts-"+mu+"-"+person.id,person.id,true,person.name,"soft");
    m.querySelector("#mParts-"+mu).appendChild(tmp.firstElementChild);
  }
  function commitNewPerson(){
    var inp = m.querySelector("#mNewP-"+mu);
    var name = (inp.value||"").trim();
    if(!name){ inp.focus(); return; }
    var person = {id: uid(), name: name};
    commit("person.add", {pid: person.id, name: person.name});
    addChip(person);
    inp.value = "";
    m.querySelector("#mNewWrap-"+mu).hidden = true;
    refresh();
    toast(T("expenseModal.personAdded", {name: name}));
  }
  m.querySelector("#mAddP-"+mu).addEventListener("click", function(){
    var wrap = m.querySelector("#mNewWrap-"+mu);
    wrap.hidden = false;
    m.querySelector("#mNewP-"+mu).focus();
  });
  m.querySelector("#mNewOk-"+mu).addEventListener("click", commitNewPerson);
  m.querySelector("#mNewP-"+mu).addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); commitNewPerson(); } });
  m.querySelector("#mAll-"+mu).addEventListener("click", function(){ m.querySelectorAll("#mParts-"+mu+" input").forEach(function(x){x.checked=true;}); refresh(); });
  m.querySelector("#mNone-"+mu).addEventListener("click", function(){ m.querySelectorAll("#mParts-"+mu+" input").forEach(function(x){x.checked=false;}); refresh(); });
  if(!isNew) m.querySelector("#mDel-"+mu).addEventListener("click", function(){ m.close(); confirmDeleteExpense(draft.id); });
  m.querySelector("#mSave-"+mu).addEventListener("click", function(){
    var a = parseAmount(amt.value);
    if(!isFinite(a) || a<=0){ toast(T("expenseModal.amountRequired")); amt.focus(); return; }
    var payerEl = m.querySelector("#mPayer-"+mu+" input:checked");
    if(!payerEl){ toast(T("expenseModal.payerRequired")); return; }
    var parts = Array.prototype.map.call(m.querySelectorAll("#mParts-"+mu+" input:checked"), function(x){return x.value;});
    if(!parts.length){ toast(T("expenseModal.partsRequired")); return; }
    var payload = {
      eid: draft.id, title: m.querySelector("#mTitle-"+mu).value.trim(),
      amount: a, cur: cur.value, payer: payerEl.value, parts: parts,
      date: m.querySelector("#mDate-"+mu).value || todayISO(),
      note: m.querySelector("#mNote-"+mu).value.trim()
    };
    commit(isNew ? "expense.add" : "expense.edit", payload);
    m.close();
  });
  refresh();
  setTimeout(function(){ amt.focus(); }, 60);
}

function confirmDeleteExpense(id){
  var e = S.expenses.filter(function(x){return x.id===id;})[0];
  if(!e) return;
  var m = modal(T("deleteExpense.title"), "<div>"+esc(T("deleteExpense.body", {title: e.title||T("expenses.noTitle"), amount: moneyRaw(e.amount,e.cur)}))+"</div>",
    '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("modal.cancel"))+'</button><button class="btn btn-danger" id="yes">'+esc(T("deleteExpense.ok"))+'</button>');
  m.querySelector("#yes").addEventListener("click", function(){ commit("expense.del", {eid:id}); m.close(); });
}

function openSettle(i){
  var c = compute();
  var tlist = transfers(c.rows);
  var tr = tlist[i];
  if(!tr) return;
  var dec = NO_DEC[baseCode()] ? 0 : 2;
  var m = modal(T("settleModal.title"),
    "<div>"+esc(nameOf(tr.from))+" → "+esc(nameOf(tr.to))+"</div>"+
    '<div class="field"><label for="sAmt">'+esc(T("settleModal.amountLabel",{base:baseCode()}))+'</label><input class="inp num" id="sAmt" inputmode="decimal" value="'+(tr.cents/100).toFixed(dec)+'"></div>'+
    '<div class="hint">'+esc(T("settleModal.hint"))+'</div>',
    '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("modal.cancel"))+'</button><button class="btn btn-primary" id="ok">'+esc(T("settleModal.ok"))+'</button>');
  m.querySelector("#ok").addEventListener("click", function(){
    var a = parseAmount(m.querySelector("#sAmt").value);
    if(!isFinite(a) || a<=0){ toast(T("settleModal.amountRequired")); return; }
    commit("payment.add", {payid: uid(), from: tr.from, to: tr.to, amount: a, date: todayISO(), note:""});
    m.close();
  });
}

/* ========== итог текстом ========== */
function summaryText(){
  var c = compute();
  var tr = transfers(c.rows);
  var L = [];
  L.push(T("summary.header", {name: S.trip.name}));
  L.push(T("summary.totalSpent", {amount: money(c.total)}));
  L.push("");
  c.rows.forEach(function(r){
    var shownBal = withoutNoise(r.balance);
    L.push(T("summary.personLine", {name:r.name, paid:money(r.paid), share:money(r.share), sign:(shownBal>0?"+":""), balance: money(shownBal)}));
  });
  L.push("");
  if(!tr.length) L.push(T("summary.allClear"));
  else {
    L.push(T("summary.transfersHeader"));
    tr.forEach(function(t){ L.push("• " + T("summary.transferLine", {from:nameOf(t.from), to:nameOf(t.to), amount:money(t.cents)})); });
  }
  return L.join("\n");
}
function copySummary(){
  var text = summaryText();
  function fallback(){
    var m = modal(T("summaryModal.title"), '<textarea class="inp" style="height:240px; font-family:JetBrains Mono, monospace; font-size:13px">'+esc(text)+'</textarea><div class="hint">'+esc(T("summaryModal.hint"))+'</div>', '<div style="flex:1"></div><button class="btn" data-close>'+esc(T("summaryModal.close"))+'</button>');
    var ta = m.querySelector("textarea"); ta.focus(); ta.select();
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ toast(T("summary.copied")); }, fallback);
  } else fallback();
}

/* ========== toast ========== */
var toastTimer = null;
function toast(msg){
  var old = document.querySelector(".toast");
  if(old) old.remove();
  var t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.remove(); }, 2600);
}

/* ========== переключатель языка (родные radio, грабля №2) ========== */
function initLangSwitch(){
  var lang = loadLang();
  ["ru","uz","en"].forEach(function(code){
    var el = document.getElementById("lang-"+code);
    if(el) el.checked = (code === lang);
  });
  var sw = document.getElementById("langSwitch");
  sw.setAttribute("aria-label", T("lang.switchLabel"));
  sw.addEventListener("change", function(ev){
    var t = ev.target;
    if(t && t.name === "lang"){ saveLang(t.value); renderAll(); }
  });
}

/* ========== постоянные элементы шапки, привязываются один раз ========== */
function wireGlobalEvents(){
  document.getElementById("btnBack").addEventListener("click", function(){ location.hash = ""; });
  document.getElementById("fab").addEventListener("click", function(){
    if(!S || !S.people.length){ toast(T("onboarding.needPeople")); return; }
    openExpense(null);
  });
  var tripNameInput = document.getElementById("tripName");
  tripNameInput.addEventListener("change", function(){
    if(!S) return;
    var name = tripNameInput.value.trim() || T("trips.untitled");
    tripNameInput.value = name;
    commit("trip.meta", {name:name});
  });
}

/* ========== старт ========== */
function boot(){
  initTelegram();
  initLangSwitch();
  wireGlobalEvents();
  document.title = T("app.brand");
  window.addEventListener("hashchange", route);
  route();
}

boot();
})();
