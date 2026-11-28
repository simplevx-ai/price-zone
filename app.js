/* AI 마켓 스캐너(옛 이름 가격 위치) — 국내주식·해외주식·코인·코인선물·해외선물 매수 검토 구간 공부용 앱
 * - 시세 출처: sources.js (모두 '조회'만, 주문·계좌 기능 없음)
 * - 구간 계산: zones.js (앱 안에서 계산)
 * - 알림: 구간을 내 구글 Apps Script에 저장 → 스크립트가 현재가를 보고 구간에 들어오면 텔레그램·디스코드로 알림.
 *   봇 토큰·웹훅·Alpha Vantage·한국투자증권 키는 스크립트 속성에만 있고 폰에는 없다.
 * 매수 추천이 아니라 가격 위치를 공부하기 위한 도구다.
 */
'use strict';

const APP_VERSION = '3.2.0';
// 기본 관심 종목: 비트코인 · 비트코인 선물 · 나스닥 선물 · 테더(원화 시세 ≈ 원/달러 체감 환율)
const DEFAULT_WATCH = [
  { cat: 'coin', sym: 'KRW-BTC', name: '비트코인', tf: 'day' },
  { cat: 'cfut', sym: 'BTCUSDT', name: '비트코인 선물', tf: 'day' },
  { cat: 'cfut', sym: 'QQQUSDT', name: '나스닥 선물(QQQ 무기한)', tf: 'day' },
  { cat: 'coin', sym: 'KRW-USDT', name: '테더', tf: 'day' },
];
// 24시간 거래대금이 이보다 적으면 관심 종목에서 자동으로 뺌(기본 4종목은 빼지 않음)
const LOW_VOL = { coin: 1e9, cfut: 1e6 }; // 코인 10억 원, 코인선물 100만 USDT
const LOW_VOL_TXT = { coin: '하루 거래 10억 원 미만', cfut: '하루 거래 100만 USDT 미만' };

/* ───────── 저장(IndexedDB 키-값) ───────── */
const KV = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('pricezone', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return { get: async (k, def) => { const v = await tx('readonly', (s) => s.get(k)); return v === undefined ? def : v; }, set: (k, v) => tx('readwrite', (s) => s.put(v, k)) };
})();

/* ───────── 도우미 ───────── */
const $ = (s, el = document) => el.querySelector(s);
const view = () => $('#view');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => (x == null || !Number.isFinite(x) ? '-' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
function setTitle(t, back) { $('#title').textContent = t; $('#backBtn').hidden = !back; }
const nowISO = () => new Date().toISOString();
const idOf = (a) => `${a.cat}:${a.sym}`;
const enc = encodeURIComponent;
function busy(msg) { let b = $('#busy'); if (!b) { b = document.createElement('div'); b.id = 'busy'; b.className = 'muted'; b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));text-align:center;font-size:12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 8px;z-index:6;box-shadow:0 2px 8px rgba(0,0,0,.15)'; document.body.appendChild(b); } b.textContent = msg; b.hidden = !msg; }

// 예전(코인만) 관심 목록을 새 모양으로 옮긴다
async function getWatch() {
  const w = await KV.get('watch', null);
  if (!w) return DEFAULT_WATCH.map((x) => ({ ...x }));
  if (!(await KV.get('watchV3', false))) { // v3.0.0: 기본 4종목이 없으면 맨 앞에 한 번 넣음
    const have = new Set(w.map((x) => (x.cat ? `${x.cat}:${x.sym}` : `coin:${x.market}`)));
    const add = DEFAULT_WATCH.filter((d) => !have.has(`${d.cat}:${d.sym}`)).map((d) => ({ ...d }));
    await KV.set('watch', add.concat(w)); await KV.set('watchV3', true);
    return getWatch();
  }
  const out = w.map((x) => (x.cat ? x : { cat: 'coin', sym: x.market, name: x.name, tf: x.tf || 'day', alert: x.alert }));
  // 같은 종목이 두 번 들어가 있으면 하나만(알림 켠 쪽을 남김)
  const m = new Map();
  for (const x of out) { const k = idOf(x), p = m.get(k); if (!p || (x.alert && !p.alert)) m.set(k, x); }
  return [...m.values()];
}
// 한 번이라도 저장하면 기본 4종목을 다시 넣지 않음(뺀 기본 종목이 되살아나지 않게)
const setWatch = async (w) => { await KV.set('watchV3', true); return KV.set('watch', w); };
// 관심 종목에서 빼기 — 알림을 켜 둔 종목이면 스크립트 알림 목록에서도 빠지게 다시 저장
async function removeWatch(cat, sym) {
  const ws = await getWatch(), x = ws.find((w) => w.cat === cat && w.sym === sym);
  if (!x) return;
  await setWatch(ws.filter((w) => w !== x));
  const sync = await KV.get('syncItems', {}); delete sync[idOf(x)]; await KV.set('syncItems', sync);
  if (x.alert && (await relayOn())) syncAlerts(true).catch(() => toast('알림 목록 정리는 다음 저장 때 반영됩니다'));
  toast(`${x.name} 뺌`);
}

/* ───────── 중계 스크립트(구글 Apps Script) ───────── */
async function relayOn() { const c = await KV.get('relay', {}); return !!(c.url && c.key); }
async function relay(action, extra) {
  const cfg = await KV.get('relay', {});
  if (!cfg.url || !cfg.key) throw new Error('설정에서 알림 스크립트 주소와 앱 키를 먼저 넣어 주세요');
  let r;
  try { r = await fetch(cfg.url, { method: 'POST', body: JSON.stringify({ key: cfg.key, action, ...extra }) }); } catch { throw new Error('인터넷 연결이나 스크립트 주소를 확인하세요'); }
  let d; try { d = JSON.parse(await r.text()); } catch { throw new Error('스크립트 응답을 읽지 못했습니다(주소·배포 확인)'); }
  if (d.ok === false) throw new Error(d.error === 'denied' ? '앱 키가 스크립트의 APP_KEY와 다릅니다' : d.error || '오류');
  return d;
}

/* ───────── 캔들(폰에 저장해 두고 봉 단위별로 다시 씀) ───────── */
const mem = new Map();
async function candles(a, tf) {
  const key = `c:${idOf(a)}:${tf}`, hit = mem.get(key) || (await KV.get(key, null));
  if (hit && Date.now() - hit.at < FRESH[tf]) { mem.set(key, hit); if (hit.src) hit.data.src = hit.src; return hit.data; }
  const data = await fetchCandles(a, tf);
  const v = { at: Date.now(), data, src: data.src || '' };
  mem.set(key, v); KV.set(key, v).catch(() => {});
  return data;
}
// 이 종목을 보려면 필요한 키가 스크립트에 있는지
async function needMsg(cat) {
  const n = CATS[cat].needs;
  if (!n) return '';
  if (cat === 'us') return ''; // 해외주식은 키가 없어도 OKX·바이비트의 같은 종목 선물 봉으로 볼 수 있음(출처는 화면 아래에 표시)
  if (!(await relayOn())) return `설정에서 스크립트를 연결하고 ${NEED_LABEL[n]}를 넣어야 볼 수 있습니다`;
  const st = await KV.get('relayStatus', {});
  const has = n.split('|').some((k) => st[k]);
  if (st.checkedAt && !has) return `스크립트 속성에 ${NEED_LABEL[n]}가 아직 없습니다`;
  return '';
}

// 알림 켠 종목들의 구간을 다시 계산해 스크립트에 저장
async function syncAlerts(silent) {
  const on = (await getWatch()).filter((w) => w.alert);
  const prev = await KV.get('syncItems', {}), items = [], kept = [];
  for (const w of on) {
    const base = { cat: w.cat, sym: w.sym, ex: w.ex || '', name: w.name, tf: TFS[w.tf || 'day'].label, tfk: w.tf || 'day' };
    try {
      const cs = await candles(w, w.tf || 'day'), r = ZoneMath.analyze(cs, { tf: w.tf || 'day' });
      if (r.error) throw new Error(r.error);
      items.push({ ...base, price: r.price, src: cs.src || '', zones: r.zones.map((z) => ({ low: z.low, high: z.high, score: z.score, kinds: z.kinds, grade: z.grade, prob: z.prob, atrDist: Math.round((Math.abs(z.high - r.price) / r.atr) * 10) / 10, labels: [...new Set(z.items.map((x) => x.label))], react: ZoneMath.reactText(z.react) })), atr: r.atr, rsi: r.rsi, trend: r.trend });
    } catch {
      // 이번에 시세를 못 받아도 알림에서 빠지지 않게: 지난번 구간을 다시 보내고, 그것도 없으면 스크립트가 가진 구간을 유지(keep)
      const p = prev[idOf(w)];
      items.push(p ? { ...p, ...base } : { ...base, zones: [], keep: true });
      kept.push(w.name);
    }
  }
  const d = await relay('saveWatch', { items });
  const keep = {}; items.forEach((x) => { if (x.zones && x.zones.length) keep[idOf(x)] = x; }); await KV.set('syncItems', keep);
  if (kept.length && !silent) toast(`시세를 못 받은 ${kept.length}종목은 지난 구간을 유지합니다: ${kept.join(', ')}`);
  await KV.set('lastSync', nowISO());
  if (!silent) toast(`알림 구간 저장: ${items.length}종목 · 구간 ${d.zones}개`);
  return d;
}

/* ───────── 라우터 ───────── */
const routes = [
  [/^#?\/?$/, 'list', viewList],
  [/^#\/a\/(\w+)\/([^/]+)$/, 'list', (m) => viewAsset(m[1], decodeURIComponent(m[2]))],
  [/^#\/c\/(KRW-[\w]+)$/, 'list', (m) => viewAsset('coin', m[1])], // 예전 주소
  [/^#\/add$/, 'list', viewAdd],
  [/^#\/nq$/, 'nq', viewNq],
  [/^#\/scan$/, 'nq', viewScan],
  [/^#\/ai$/, 'ai', viewAiHome],
  [/^#\/ai\/(\w+)\/([^/]+)$/, 'ai', (m) => viewAiAsset(m[1], decodeURIComponent(m[2]))],
  [/^#\/air\/([^/]+)$/, 'ai', (m) => viewAiReport(decodeURIComponent(m[1]))],
  [/^#\/learn$/, 'bt', viewLearn],
  [/^#\/bt$/, 'bt', viewBacktest],
  [/^#\/settings$/, 'settings', viewSettings],
];
// 화면이 바뀌면 늦게 끝난 이전 화면이 새 화면을 덮지 않게(느린 연결 대비)
let viewGen = 0;
const liveNow = () => { const g = viewGen; return () => g === viewGen; };
async function render() {
  const gen = ++viewGen;
  const h = (location.hash || '#/').split('?')[0];
  for (const [re, tab, fn] of routes) {
    const m = h.match(re);
    if (m) {
      document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
      try { await fn(m); } catch (e) { console.error(e); if (gen !== viewGen) return; view().innerHTML = `<div class="card errbox">오류: ${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
$('#backBtn').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));

/* ───────── 관심 종목 목록(카테고리별) ───────── */
const catChips = (sel, withAll) => `<div class="chips" role="tablist">${withAll ? `<button class="chip${sel === 'all' ? ' on' : ''}" data-cat="all" type="button">전체</button>` : ''}${Object.entries(CATS).map(([k, c]) => `<button class="chip${sel === k ? ' on' : ''}" data-cat="${k}" type="button">${c.icon} ${c.label}</button>`).join('')}</div>`;
async function viewList() {
  setTitle('AI 마켓 스캐너');
  const watch = await getWatch();
  let sel = sessionStorage.getItem('pzCat') || 'all', edit = false;
  const draw = async () => {
    const L = watch.filter((w) => sel === 'all' || w.cat === sel);
    view().innerHTML = `<div class="card warnlist" style="margin-top:0;font-size:13px">📘 공부용 도구입니다. 여러 근거가 겹치는 가격대를 보여 줄 뿐 <b>매수 추천이 아니며</b>, 결정과 책임은 본인에게 있습니다.</div>
      ${catChips(sel, true)}
      <div class="row spread" style="margin:2px 0 6px"><span class="muted" style="font-size:12px">${L.length}종목</span><button class="btn small${edit ? ' primary' : ''}" id="wedit" type="button">${edit ? '✓ 편집 끝' : '✏️ 편집(빼기)'}</button></div>
      <div id="ls">${L.map((w) => edit ? `<div class="coin row spread" data-id="${esc(idOf(w))}"><span class="nm">${CATS[w.cat].icon} ${esc(w.name)}${w.alert ? ' 🔔' : ''}</span><button class="btn small danger" type="button" data-rm="${esc(w.cat)}|${esc(w.sym)}">🗑 빼기</button></div>` : `<a class="coin" href="#/a/${w.cat}/${enc(w.sym)}" data-id="${esc(idOf(w))}"><div class="row spread"><span class="nm">${CATS[w.cat].icon} ${esc(w.name)} <span class="muted" style="font-size:12px">${esc(w.cat === 'coin' ? w.sym.slice(4) : w.sym)}</span>${w.alert ? ' 🔔' : ''}</span><span class="px muted">…</span></div><div class="row spread muted info" style="font-size:13px;margin-top:4px"><span>${CATS[w.cat].label} · ${TFS[w.tf || 'day'].label}</span><span></span></div></a>`).join('') || `<div class="empty">${sel === 'all' ? '관심 종목이 없습니다.' : CATS[sel].label + ' 종목이 없습니다.'}</div>`}</div>
      <a class="btn block" href="#/add">+ 종목 추가</a>
      ${(await KV.get('lowVolGone', [])).length ? `<details class="card" style="margin-top:10px"><summary class="muted" style="font-size:13px">거래가 적어 자동으로 뺀 종목</summary><div class="muted" style="font-size:12px;margin-top:4px">${(await KV.get('lowVolGone', [])).slice(0, 10).map((x) => `${esc(x.name)}(${esc(x.why)}, ${new Date(x.at).toLocaleDateString('ko-KR')})`).join(' · ')}</div></details>` : ''}
      <div class="muted" style="font-size:11px;margin-top:6px">코인은 하루 거래 10억 원, 코인선물은 100만 USDT보다 적으면 관심 종목에서 자동으로 뺍니다(비트코인·비트코인 선물·나스닥 선물·테더는 제외).</div>
      <div class="disc">시세: 업비트·빗썸·바이낸스·OKX·바이비트(공개) · Alpha Vantage · 공공데이터포털 · 한국투자증권 · v${APP_VERSION}</div>`;
    view().querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { sel = b.dataset.cat; sessionStorage.setItem('pzCat', sel); draw(); }; });
    $('#wedit').onclick = () => { edit = !edit; draw(); };
    view().querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { const [c, sy] = b.dataset.rm.split('|'), w = watch.find((x) => x.cat === c && x.sym === sy); if (!w || !confirm(`${w.name}을(를) 관심 종목에서 뺄까요?${w.alert ? ' (켜 둔 알림도 같이 꺼집니다)' : ''}`)) return; await removeWatch(c, sy); watch.splice(watch.indexOf(w), 1); draw(); }; });
    if (edit) return;
    // 현재가(코인·코인선물은 바로, 나머지는 캔들 마지막 값)
    const q = {};
    const showPx = (w, price, chg) => { const el = view().querySelector(`[data-id="${CSS.escape(idOf(w))}"] .px`); if (!el) return; el.className = 'px ' + (chg > 0 ? 'up' : chg < 0 ? 'down' : ''); el.innerHTML = `<b>${fmtP(price, w.cat)}</b> ${pct(chg)}`; };
    // 현재가는 기다리지 않고 따로 채운다(업비트 직접 받기가 10초씩 걸려도 다른 종목은 먼저 보이게)
    quotes(L).then((res) => { Object.assign(q, res); for (const w of L) { const qq = q[idOf(w)]; if (qq) showPx(w, qq.price, qq.chg); } cleanLowVol(res).catch(() => {}); }).catch(() => {});
    // 구간 요약(출처가 다르면 동시에 — 업비트 직접 받기만 안에서 차례로)
    await Promise.all(L.map(async (w) => {
      const el = view().querySelector(`[data-id="${CSS.escape(idOf(w))}"]`); if (!el) return;
      const info = el.querySelector('.info span:last-child');
      const nm = await needMsg(w.cat);
      if (nm) { info.textContent = '🔑 ' + nm.replace(/를 넣어야 볼 수 있습니다|가 아직 없습니다/, ' 필요'); return; }
      try {
        const cs = await candles(w, w.tf || 'day');
        const r = ZoneMath.analyze(cs, { tf: w.tf || 'day' });
        if (!q[idOf(w)] && cs.length > 1) showPx(w, cs[cs.length - 1].c, ((cs[cs.length - 1].c - cs[cs.length - 2].c) / cs[cs.length - 2].c) * 100);
        if (r.error) { info.textContent = r.error; return; }
        const inside = r.zones.find((z) => r.price >= z.low && r.price <= z.high);
        info.innerHTML = (inside ? '<b style="color:#E8A317">검토 구간 안</b>' : r.zones[0] ? `가까운 구간 ${pct(((r.zones[0].high - r.price) / r.price) * 100)}` : '아래 겹치는 구간 없음') + ` · RSI ${r.rsi != null ? r.rsi.toFixed(0) : '-'}`;
      } catch (e) { info.textContent = e.message; }
    }));
  };
  await draw();
  const last = await KV.get('lastSync', null);
  if ((await relayOn()) && watch.some((w) => w.alert) && (!last || Date.now() - Date.parse(last) > 6 * 3600e3)) syncAlerts(true).catch(() => {});
}

// 24시간 거래대금이 기준보다 적은 코인·코인선물은 관심 종목에서 자동으로 뺌(시세를 제대로 받은 경우만, 기본 4종목 제외)
async function cleanLowVol(q) {
  const ws = await getWatch(), isDef = (w) => DEFAULT_WATCH.some((d) => d.cat === w.cat && d.sym === w.sym);
  const gone = ws.filter((w) => LOW_VOL[w.cat] && !isDef(w) && q[idOf(w)] && Number.isFinite(q[idOf(w)].vol) && q[idOf(w)].vol < LOW_VOL[w.cat]);
  if (!gone.length) return;
  await setWatch(ws.filter((w) => !gone.includes(w)));
  const log = await KV.get('lowVolGone', []); gone.forEach((w) => log.unshift({ at: nowISO(), name: w.name, sym: w.sym, cat: w.cat, why: LOW_VOL_TXT[w.cat] })); await KV.set('lowVolGone', log.slice(0, 30));
  toast(`거래가 너무 적어 관심 종목에서 뺐습니다: ${gone.map((w) => w.name).join(', ')}`);
  if (gone.some((w) => w.alert) && (await relayOn())) syncAlerts(true).catch(() => {}); // 알림 목록에서도 빠지게
  if (location.hash === '' || location.hash === '#/') render();
}

/* ───────── 종목 추가 ───────── */
async function viewAdd() {
  setTitle('종목 추가', true);
  const watch = await getWatch();
  let cat = sessionStorage.getItem('pzAddCat') || 'coin';
  const add = async (x) => {
    if (watch.some((w) => idOf(w) === `${cat}:${x.sym}`)) { toast('이미 있는 종목입니다'); return; }
    watch.push({ cat, sym: x.sym, ex: x.ex || '', name: x.name, tf: defTf(cat) });
    await setWatch(watch); toast(`${x.name} 추가`); location.hash = `#/a/${cat}/${enc(x.sym)}`;
  };
  const draw = async () => {
    const c = CATS[cat];
    const nm = await needMsg(cat);
    const remote = cat === 'us' || cat === 'kr'; // 입력해야 찾는(스크립트 경유) 카테고리
    const manual = cat === 'ffut' || (cat === 'kr' && (nm || (await krSource()) === 'kis'));
    view().innerHTML = `${catChips(cat, false)}
      ${nm ? `<div class="card warnlist" style="margin-top:0">🔑 ${esc(nm)}. 종목은 미리 추가해 둘 수 있습니다. <a href="#/settings">설정 ›</a></div>` : ''}
      <div class="card">${manual ? `
        <label for="m_sym">${cat === 'kr' ? '종목코드 6자리' : '종목코드(월물 포함)'}</label><input id="m_sym" placeholder="${cat === 'kr' ? '005930' : nqCme().main.code}" autocomplete="off" ${cat === 'kr' ? 'inputmode="numeric"' : ''}>
        ${cat === 'ffut' ? '<label for="m_ex">거래소</label><input id="m_ex" placeholder="CME" autocomplete="off">' : ''}
        <label for="m_name">이름</label><input id="m_name" placeholder="${cat === 'kr' ? '삼성전자' : '나스닥100 12월물'}">
        <button class="btn primary block" id="m_add" type="button" style="margin-top:10px">추가</button>
        <div class="muted" style="font-size:12px;margin-top:6px">${cat === 'kr' ? (nm ? '스크립트 연결 전이라 코드를 직접 넣습니다. 공공데이터 서비스키를 넣으면 이름으로 찾을 수 있습니다.' : '한국투자증권 API에는 이름 검색이 없어 코드를 직접 넣습니다.') : `해외선물은 월물마다 코드가 바뀝니다(예: 지금 나스닥100 주력 월물 = ${nqCme().main.code}, NQZ25는 2025-12-19 만기로 끝남). 만기가 지나면 다음 월물로 다시 추가하세요.`}</div>`
      : `<input id="q" placeholder="${esc(c.hint || '이름이나 기호')}" autocomplete="off"><div class="pick" id="pk"><div class="muted" style="padding:10px">${remote ? '이름이나 코드를 입력하세요' : '불러오는 중…'}</div></div>`}</div>`;
    view().querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { cat = b.dataset.cat; sessionStorage.setItem('pzAddCat', cat); draw(); }; });
    if (manual) {
      $('#m_add').onclick = () => {
        const sym = $('#m_sym').value.trim().toUpperCase(), name = $('#m_name').value.trim() || sym, ex = $('#m_ex') ? $('#m_ex').value.trim().toUpperCase() : '';
        if (cat === 'kr' && !/^\d{6}$/.test(sym)) { alert('종목코드는 숫자 6자리입니다'); return; }
        if (cat === 'ffut' && (!/^[A-Z0-9]{2,12}$/.test(sym) || !/^[A-Z]{2,8}$/.test(ex))) { alert(`종목코드와 거래소를 확인해 주세요 (예: ${nqCme().main.code} / CME)`); return; }
        add({ sym, name, ex });
      };
      return;
    }
    let tmr;
    const run = async () => {
      const q = $('#q').value;
      if (remote && !q.trim()) return;
      $('#pk').innerHTML = '<div class="muted" style="padding:10px">찾는 중…</div>';
      try {
        const L = await searchAssets(cat, q);
        $('#pk').innerHTML = L.map((x, i) => { const has = watch.some((w) => idOf(w) === `${cat}:${x.sym}`); return `<button type="button" data-i="${i}" ${has ? 'disabled' : ''}><span>${esc(x.name)} <span class="muted">${esc(x.sub)}</span></span><span>${has ? '추가됨' : '+'}</span></button>`; }).join('') || '<div class="muted" style="padding:10px">찾는 종목이 없습니다.</div>';
        $('#pk').querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => add(L[+b.dataset.i]); });
      } catch (e) { $('#pk').innerHTML = `<div class="errbox" style="margin:8px">${esc(e.message)}</div>`; }
    };
    $('#q').oninput = () => { clearTimeout(tmr); tmr = setTimeout(run, remote ? 700 : 150); };
    if (!remote) run();
    $('#q').focus();
  };
  draw();
}

/* ───────── 종목 상세: 차트·구간·근거 ───────── */
async function viewAsset(cat, sym) {
  const live = liveNow();
  if (!CATS[cat]) { location.hash = '#/'; return; }
  const watch = await getWatch();
  const w = watch.find((x) => x.cat === cat && x.sym === sym) || { cat, sym, name: sym, tf: defTf(cat) };
  const inList = watch.some((x) => x.cat === cat && x.sym === sym);
  setTitle(w.name, true);
  const tf = CATS[cat].tfs.includes(w.tf) ? w.tf : defTf(cat);
  view().innerHTML = `${CATS[cat].tfs.length > 1 ? `<div class="seg" role="radiogroup" aria-label="봉 단위">${CATS[cat].tfs.map((k) => `<label><input type="radio" name="tf" value="${k}"${k === tf ? ' checked' : ''}><span>${TFS[k].label}</span></label>`).join('')}</div>` : ''}
    <div class="card" style="margin-top:10px;padding:8px"><canvas class="chart" id="cv" aria-label="가격 차트와 검토 구간"></canvas>
      <div class="muted" style="font-size:11px;margin-top:4px">빨강 상승·파랑 하락 봉 · 선: <span style="color:#E8A317">60</span>/<span style="color:#8E5CF0">120</span>/<span style="color:#1F9D63">200</span>봉 평균 · 칠한 띠: 검토 구간(진할수록 근거 많음)</div></div>
    <div id="sum" class="card"><div class="muted">계산 중…</div></div>
    <div id="zs"></div>
    ${`<a class="card coin" href="#/ai/${cat}/${enc(sym)}" style="display:block"><div class="row spread"><b>🤖 AI 분석</b><span>›</span></div><div class="muted" style="font-size:13px;margin-top:4px">📐 규칙 분석(키 없이 바로) · 📋 Claude·ChatGPT에 붙여 넣을 요청문 복사${cat === 'us' ? ' · 🤖 Claude 자동 분석(키 있을 때)' : ''} — 공부용</div></a>`}
    <div class="card"><div class="row spread"><b>🔔 알림 (텔레그램·디스코드)</b><label class="row" style="margin:0;color:var(--ink)"><input type="checkbox" id="al" ${w.alert ? 'checked' : ''} style="width:22px;min-height:22px"> 켜기</label></div>
      <div class="muted" style="font-size:13px;margin-top:4px">가격이 위 검토 구간에 들어오면 알려 줍니다. ${cat === 'us' ? '해외주식은 무료 키 한도 때문에 3시간마다 확인합니다.' : '10분마다 확인합니다.'} 구간은 앱을 열 때(6시간마다), 그리고 스크립트가 매일 14시 이후 한 번 스스로 다시 계산합니다.</div></div>
    ${inList ? '<button class="btn block danger" id="del" type="button">관심 종목에서 빼기</button>' : '<button class="btn block primary" id="addw" type="button">관심 종목에 추가</button>'}
    <div class="disc" id="srcLine">공부용 · 매수 추천 아님 · ${CATS[cat].label}${cat === 'kr' && (await krSource()) === 'krx' ? '<br>출처: 금융위원회(공공데이터포털) · 전 영업일 종가까지(하루 1번 갱신)' : ''}</div>`;
  const save = async (patch) => { const ws = await getWatch(); const i = ws.findIndex((x) => x.cat === cat && x.sym === sym); if (i >= 0) { ws[i] = { ...ws[i], ...patch }; await setWatch(ws); } };
  view().querySelectorAll('[name=tf]').forEach((el) => { el.onchange = async () => { await save({ tf: el.value }); render(); }; });
  if ($('#del')) $('#del').onclick = async () => { if (!confirm(`${w.name}을(를) 관심 종목에서 뺄까요?`)) return; await removeWatch(cat, sym); location.hash = '#/'; };
  if ($('#addw')) $('#addw').onclick = async () => { const ws = await getWatch(); ws.push({ ...w, tf }); await setWatch(ws); render(); };
  $('#al').onchange = async (e) => {
    if (!inList) { e.target.checked = false; toast('관심 종목에 먼저 추가하세요'); return; }
    if (e.target.checked && !(await relayOn())) { e.target.checked = false; alert('설정에서 알림 스크립트를 먼저 연결해 주세요'); location.hash = '#/settings'; return; }
    await save({ alert: e.target.checked });
    try { await syncAlerts(); } catch (err) { alert('알림 저장 실패: ' + err.message); }
  };

  const nm = await needMsg(cat);
  if (nm) { $('#sum').innerHTML = `<div class="warnlist" style="margin-top:0">🔑 ${esc(nm)}. <a href="#/settings">설정 ›</a></div>`; return; }
  let cs;
  try { cs = await candles(w, tf); } catch (e) { if (!live()) return; $('#sum').innerHTML = `<div class="errbox" style="margin-top:0">${esc(e.message)}</div>`; return; }
  if (!live()) return;
  const r = ZoneMath.analyze(cs, { tf });
  if (r.error) { $('#sum').innerHTML = `<div class="errbox" style="margin-top:0">${esc(r.error)}</div>`; return; }
  const f = (p) => fmtP(p, cat), u = unitOf(cat);
  if (cs.src && $('#srcLine')) $('#srcLine').insertAdjacentHTML('beforeend', `<br>봉 출처: ${esc(cs.src)}`);
  drawChart($('#cv'), cs, r, f);
  const inside = r.zones.find((z) => r.price >= z.low && r.price <= z.high);
  $('#sum').innerHTML = `<div class="row spread"><span>현재가</span><b style="font-size:20px">${f(r.price)}${u ? ' ' + u : ''}</b></div>
    <div class="muted" style="font-size:13px;margin-top:6px">최근 ${r.range.bars}개 ${TFS[tf].label} 범위 안 위치 (저점 ${f(r.range.low)} ~ 고점 ${f(r.range.high)})</div>
    <div class="posbar"><i style="left:${Math.max(0, Math.min(100, r.range.pos || 0))}%"></i></div><div class="row spread muted" style="font-size:12px"><span>저점</span><b>${r.range.pos != null ? r.range.pos.toFixed(0) + '%' : '-'}</b><span>고점</span></div>
    <div class="grid2" style="margin-top:8px;font-size:14px"><div>RSI(14) <b>${r.rsi != null ? r.rsi.toFixed(1) : '-'}</b> <span class="muted">${r.rsi < 30 ? '과매도' : r.rsi > 70 ? '과매수' : '보통'}</span></div><div>${esc(r.trend)}</div></div>
    ${cs.length < 200 ? `<div class="muted" style="font-size:12px;margin-top:6px">봉 ${cs.length}개로 계산했습니다${cat === 'us' && tf === 'day' ? '(무료 키는 일봉 최근 100개까지 — 긴 흐름은 주봉으로 보세요)' : ''}. 120·200봉 평균은 봉이 부족하면 빠집니다.</div>` : ''}
    ${inside ? `<div class="okbox" style="border-color:#E8A317;color:#B26B00">현재가가 검토 구간 안에 있습니다 (근거 ${inside.kinds}개)</div>` : ''}`;
  const zh = r.zones.map((z, i) => `<div class="zone ${z.score >= 3 ? 's3' : ''} ${r.price >= z.low && r.price <= z.high ? 'in' : ''}">
      <div class="row spread"><span class="rng">${f(z.low)} ~ ${f(z.high)}</span><span>${'★'.repeat(Math.min(5, Math.round(z.score)))} <span class="muted" style="font-size:12px">${z.score}</span></span></div>
      <div class="muted" style="font-size:13px">구간 ${i + 1} · 현재가 대비 ${pct(((z.high - r.price) / r.price) * 100)} · 근거 ${z.kinds}가지 · ATR ${(Math.abs(z.high - r.price) / r.atr).toFixed(1)}배 거리</div>
      <div style="font-size:13px;margin-top:2px">신뢰도 <b style="color:${z.grade === '강' ? 'var(--green)' : z.grade === '중' ? '#E8A317' : 'var(--muted)'}">${z.grade}</b> · 과거 반등 확률 <b>${z.prob}%</b> <span class="muted" style="font-size:11px">(닿은 횟수 적으면 50% 쪽으로 보정)</span></div>
      <div style="font-size:12px;margin-top:2px;color:${z.react && z.react.touches >= 2 && z.react.bounces / z.react.touches >= 0.6 ? 'var(--green)' : z.react && z.react.touches >= 2 && z.react.breaks / z.react.touches >= 0.6 ? 'var(--red)' : 'var(--muted)'}">📊 ${esc(ZoneMath.reactText(z.react))} <span class="muted">(10봉 안에 1.5 ATR 반등 / 0.5 ATR 넘게 뚫림)</span></div>
      <ul>${z.items.map((x) => `<li><b>${esc(x.label)}</b> ${f(x.p)}${x.touches > 1 ? ` <span class="muted">(${x.touches}번 반등)</span>` : ''}</li>`).join('')}</ul></div>`).join('');
  const singles = r.candidates.filter((x) => x.p < r.price && !r.zones.some((z) => x.p >= z.low && x.p <= z.high)).sort((a, b) => b.p - a.p).slice(0, 5);
  $('#zs').innerHTML = `<div class="card"><h2>검토 구간 <span class="muted">(근거 2가지 이상 겹침)</span></h2>
      ${zh || '<div class="muted">현재가 아래에 근거가 2가지 이상 겹치는 구간이 없습니다. 최근 범위의 바닥 근처이거나 근거가 흩어져 있다는 뜻입니다.</div>'}
      ${singles.length ? `<div style="margin-top:10px"><b style="font-size:14px">근거 하나뿐인 아래 가격</b><ul style="font-size:13px;margin:6px 0 0;padding-left:18px">${singles.map((x) => `<li>${esc(x.label)} ${f(x.p)} <span class="muted">(${pct(((x.p - r.price) / r.price) * 100)})</span></li>`).join('')}</ul></div>` : ''}
      <a href="#/learn" style="font-size:13px;display:inline-block;margin-top:8px">각 근거가 무슨 뜻인지 보기 ›</a></div>`;
}

// 캔들 차트 + 이동평균 + 검토 구간 띠 + 현재가 선
function drawChart(cv, cs, r, f) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const N = Math.min(150, cs.length), s = cs.length - N, show = cs.slice(s);
  let lo = Math.min(...show.map((k) => k.l), ...r.zones.map((z) => z.low)), hi = Math.max(...show.map((k) => k.h));
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const R = 62, cw = (W - R) / N, y = (p) => 8 + (1 - (p - lo) / (hi - lo)) * (H - 24);
  g.fillStyle = dark ? '#182033' : '#FFFFFF'; g.fillRect(0, 0, W, H);
  for (const z of r.zones) { g.fillStyle = `rgba(232,163,23,${z.score >= 3 ? 0.30 : 0.18})`; g.fillRect(0, y(z.high), W - R, Math.max(2, y(z.low) - y(z.high))); }
  g.fillStyle = dark ? '#9AA4BC' : '#66708A'; g.font = '10px sans-serif'; g.textAlign = 'left'; g.strokeStyle = dark ? '#2A3450' : '#EEF1F6'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const p = lo + ((hi - lo) * i) / 4, yy = y(p); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - R, yy); g.stroke(); g.fillText(f(p), W - R + 4, yy + 3); }
  for (const [m, col] of [[60, '#E8A317'], [120, '#8E5CF0'], [200, '#1F9D63']]) {
    const arr = r.ma[m]; g.strokeStyle = col; g.lineWidth = 1.4; g.beginPath(); let st = false;
    for (let i = 0; i < N; i++) { const v = arr[s + i]; if (v == null) continue; const xx = i * cw + cw / 2; if (!st) { g.moveTo(xx, y(v)); st = true; } else g.lineTo(xx, y(v)); }
    g.stroke();
  }
  show.forEach((k, i) => {
    const col = k.c >= k.o ? '#D63B3B' : '#2F6FE0', xx = i * cw + cw / 2;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
    g.beginPath(); g.moveTo(xx, y(k.h)); g.lineTo(xx, y(k.l)); g.stroke();
    g.fillRect(xx - Math.max(1, cw * 0.35), y(Math.max(k.o, k.c)), Math.max(1, cw * 0.7), Math.max(1, Math.abs(y(k.o) - y(k.c))));
  });
  g.setLineDash([4, 3]); g.strokeStyle = dark ? '#E8ECF5' : '#15203A'; g.beginPath(); g.moveTo(0, y(r.price)); g.lineTo(W - R, y(r.price)); g.stroke(); g.setLineDash([]);
  g.fillStyle = dark ? '#E8ECF5' : '#15203A'; g.fillRect(W - R, y(r.price) - 8, R, 16); g.fillStyle = dark ? '#15203A' : '#FFFFFF'; g.fillText(f(r.price), W - R + 3, y(r.price) + 3);
}

/* ───────── 근거 설명 ───────── */
function viewLearn() {
  setTitle('근거 설명');
  const keys = ['swing', 'flip', 'wk', 'poc', 'val', 'hvn', 'ma60', 'ma120', 'ma200', 'bb', 'fib382', 'fib500', 'fib618', 'rsi'];
  view().innerHTML = `<div class="card"><h2>검토 구간은 이렇게 정합니다</h2><ol class="steps">
      <li>현재가 아래(1% 위까지)에 있는 근거 가격을 모두 구합니다.</li>
      <li>가까운 근거끼리(평균 변동폭 ATR의 0.6배 안) 하나로 묶습니다.</li>
      <li>서로 <b>다른 종류의 근거가 2가지 이상</b> 겹친 묶음만 '검토 구간'으로 보여 줍니다. 이동평균 여러 개, 피보나치 여러 개는 한 종류로 칩니다.</li>
      <li>점수 = 근거 종류 수(+ 지지선·저항→지지가 여러 번 확인되면 최대 1점). 매물대 중심·하단·마디는 한 종류(매물대)로 칩니다. 구간 폭은 ATR의 0.25배씩 넓히고, 한 구간은 ATR 1.5배보다 넓어지지 않게 나눕니다.</li>
      <li><b>과거 반응</b>: 가격이 위에서 내려와 그 구간에 닿은 때마다, 10봉 안에 구간 위로 1.5 ATR 이상 반등했는지 / 구간 아래로 0.5 ATR 넘게 뚫렸는지 셉니다. 2번 이상 닿아 60% 이상 반등이면 점수 +0.5, 60% 이상 뚫렸으면 −0.5. 구간을 만든 저점 자체도 세어지므로 참고용입니다.</li></ol>
      <div class="warnlist">겹치는 근거가 많아도 가격은 더 내려갈 수 있습니다. 구간은 '많은 사람이 보는 자리'일 뿐 바닥 보장이 아닙니다. 선물은 레버리지 때문에 손실이 원금보다 커질 수 있습니다. 손절 기준과 나눠 사기 계획을 따로 정해 두세요.</div></div>
    ${keys.map((k) => `<div class="card"><b>${esc(ZoneMath.LABEL[k])}</b><div class="muted" style="margin-top:4px">${esc(ZoneMath.WHY[k])}</div></div>`).join('')}
    <div class="card"><b>ATR (평균 변동폭)</b><div class="muted" style="margin-top:4px">최근 14개 봉의 평균 움직임 크기입니다. 근거를 묶는 거리와 구간 폭을 정하는 데 씁니다.</div></div>`;
}

/* ───────── 설정 ───────── */
// 스크립트의 구간 자동 재계산 상태 한 줄(설정 화면)
function recalcLine(st) {
  if (!st.checkedAt) return '구간 자동 재계산: 연결 확인 후 표시';
  if ((st.version || 0) < 6) return '구간 자동 재계산: 스크립트 새 버전(v6) 배포 후 사용 가능';
  const r = st.recalc;
  if (!r) return '구간 자동 재계산: 매일 14시 이후 한 번 · 아직 실행 전';
  return `구간 자동 재계산: 매일 14시 이후 한 번 · 마지막 ${new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${r.done}종목 성공${r.fail && r.fail.length ? ` · 실패 ${r.fail.length}(${esc(r.fail[0])})` : ''}${r.left ? ` · 남음 ${r.left}` : ''}`;
}

async function viewSettings() {
  setTitle('설정');
  const cfg = await KV.get('relay', {}), last = await KV.get('lastSync', null), st = await KV.get('relayStatus', {});
  const stRow = (ok, t) => `<div style="font-size:14px">${ok ? '✅' : ok === false ? '⬜' : '❔'} ${t}</div>`;
  view().innerHTML = `<div class="card"><h2>스크립트 연결 (알림·시세 중계)</h2>
      <div class="muted" style="font-size:13px">구글 Apps Script 웹 앱 주소와 스크립트 속성 APP_KEY와 같은 값을 넣으세요. 봇 토큰·웹훅·Alpha Vantage·한국투자증권 키는 스크립트에만 있고 폰에는 저장되지 않습니다. <a href="alert/" target="_blank" rel="noopener">준비 순서 보기</a></div>
      <label for="r_url">스크립트 웹 앱 주소</label><input id="r_url" value="${esc(cfg.url || '')}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
      <label for="r_key">앱 키 (APP_KEY)</label><input id="r_key" type="password" value="${esc(cfg.key || '')}" autocomplete="off">
      <div class="row wrap" style="margin-top:10px"><button class="btn primary" id="r_save" type="button">저장하고 연결 확인</button><button class="btn" id="r_test" type="button">테스트 알림 보내기</button><button class="btn" id="r_sync" type="button">구간 지금 저장</button></div>
      <div id="r_res" style="margin-top:8px"></div>
      <div class="muted" style="font-size:12px">마지막 구간 저장(앱): ${last ? new Date(last).toLocaleString('ko-KR') : '없음'}</div>
      <div class="muted" style="font-size:12px">${recalcLine(st)}</div></div>
    <div class="card"><h2>카테고리별 연결 상태</h2>
      ${stRow(true, '🪙 코인 — 업비트 공개 시세(키 없음)')}
      ${stRow(true, '⚡ 코인선물 — 바이낸스 공개 시세(키 없음)')}
      ${stRow(st.checkedAt ? !!st.av : null, '🇺🇸 해외주식 — Alpha Vantage (속성 ALPHAVANTAGE_API_KEY)')}
      ${stRow(st.checkedAt ? !!(st.krx || st.kis) : null, '🇰🇷 국내주식 — 공공데이터포털 (속성 DATA_GO_KR_KEY, 하루 1번 갱신) 또는 한국투자증권')}
      ${stRow(st.checkedAt ? !!st.kis : null, '🌐 해외선물 — 한국투자증권 (속성 KIS_APP_KEY·KIS_APP_SECRET)')}
      ${stRow(st.checkedAt ? !!st.ai : null, '🤖 AI 분석 — Claude API (속성 ANTHROPIC_API_KEY)' + (st.aiToday && st.aiToday.day ? ` · 오늘 ${st.aiToday.calls}/${st.aiCap || 130}번` : ''))}
      <div class="muted" style="font-size:12px;margin-top:6px">❔는 아직 연결 확인 전입니다. 키는 Apps Script → 프로젝트 설정 → 스크립트 속성에 직접 넣으세요.</div></div>
    <div class="card"><h2>알아 두기</h2><ul class="steps">
      <li>이 앱은 <b>시세 조회</b>만 합니다. 주문·계좌 기능은 없습니다.</li>
      <li>구간과 알림은 공부용입니다. 매수 추천이 아니며 결정과 책임은 본인에게 있습니다.</li>
      <li>Alpha Vantage 무료 키는 하루 25번 정도만 부를 수 있어, 해외주식은 6시간마다 새로 받고 알림은 3시간마다 확인합니다.</li>
      <li>관심 종목과 설정은 이 폰에만 저장됩니다.</li></ul></div>
    <div class="card"><h2>앱 정보</h2><div class="muted">AI 마켓 스캐너 v${APP_VERSION} (옛 이름: 가격 위치)<br>폰 홈 화면에 추가: 크롬 ⋮ → '홈 화면에 추가' 또는 '앱 설치'</div></div>`;
  const res = (html) => { $('#r_res').innerHTML = html; };
  $('#r_save').onclick = async () => {
    const url = $('#r_url').value.trim(), key = $('#r_key').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { alert('주소는 https://script.google.com/macros/s/…/exec 모양이어야 합니다'); return; }
    if (key.length < 8) { alert('앱 키는 8자 이상이어야 합니다'); return; }
    await KV.set('relay', { url, key });
    res('<div class="muted">확인 중…</div>');
    try {
      const d = await relay('ping');
      await KV.set('relayStatus', { checkedAt: nowISO(), av: !!d.av, kis: !!d.kis, krx: !!d.krx, telegram: !!d.telegram, discord: !!d.discord, version: d.version, recalc: d.recalc || null, ai: !!d.ai, aiToday: d.aiToday || null, aiCap: d.aiCap || null, nq: d.nq || null, scan: d.scan || null });
      res(`<div class="${d.telegram || d.discord ? 'okbox' : 'warnlist'}" style="margin-top:0">${d.telegram || d.discord ? '✅' : '⚠️'} 연결됨 · 텔레그램 ${d.telegram ? '✅' : '—'} · 디스코드 ${d.discord ? '✅' : '—'} · 해외주식 키 ${d.av ? '✅' : '—'} · 공공데이터 키 ${d.krx ? '✅' : '—'} · 한투 키 ${d.kis ? '✅' : '—'} · Claude 키 ${d.ai ? '✅' : '—'} · 자동 확인 ${d.trigger ? '켜짐' : '<span style="color:var(--red)">꺼짐</span>'} · 알림 종목 ${d.watching}개${(d.version || 0) < 9 ? '<br><span style="color:var(--red)">스크립트가 옛 버전입니다 — ETF 아침 정리·나스닥 신호 알림·AI 분석·구간 자동 재계산을 쓰려면 새 코드로 바꾸고 새 버전 배포가 필요합니다</span>' : ''}</div>`);
      setTimeout(render, 1500);
    } catch (e) { res(`<div class="errbox" style="margin-top:0">${esc(e.message)}</div>`); }
  };
  $('#r_test').onclick = async () => { try { const d = await relay('test'); const s = d.sent || {}; toast(`테스트 알림 보냄: ${(s.done || []).join('·') || '확인 필요'}${(s.fail || []).length ? ' / 실패: ' + s.fail.join('·') : ''}`); } catch (e) { alert(e.message); } };
  $('#r_sync').onclick = async () => { try { await syncAlerts(); render(); } catch (e) { alert(e.message); } };
}

/* ───────── 시작(자동 업데이트 포함) ───────── */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadSW = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadSW || reloaded) return;
    if (document.querySelector('input:focus')) { toast('새 버전이 나왔습니다. 앱을 다시 열면 바뀝니다'); return; }
    reloaded = true; location.reload();
  });
}
render();
