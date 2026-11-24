/* 가격 위치 — 코인(업비트) 매수 검토 구간 공부용 앱
 * - 시세: 업비트 공개 시세 API(키 없음, 조회만). 주문 기능 없음.
 * - 구간 계산: zones.js(앱 안에서 계산)
 * - 알림: 구간을 내 구글 Apps Script에 저장 → 스크립트가 10분마다 현재가를 보고 구간에 들어오면 텔레그램·디스코드로 알림.
 *   봇 토큰·디스코드 웹훅 주소는 스크립트 속성에만 있고 폰에는 없다.
 * 매수 추천이 아니라 가격 위치를 공부하기 위한 도구다.
 */
'use strict';

const APP_VERSION = '1.1.0';
const UPBIT = 'https://api.upbit.com/v1';
const TFS = { day: { unit: 'days', label: '일봉', name: '일' }, h4: { unit: 'minutes/240', label: '4시간봉', name: '4시간' }, h1: { unit: 'minutes/60', label: '1시간봉', name: '1시간' } };
const DEFAULT_WATCH = [{ market: 'KRW-BTC', name: '비트코인' }, { market: 'KRW-ETH', name: '이더리움' }, { market: 'KRW-XRP', name: '리플' }];

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
// 코인 가격 표시: 100원 이상은 정수, 그 아래는 소수 자리
const fmt = (p) => { if (p == null || !Number.isFinite(p)) return '-'; const a = Math.abs(p); const d = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6; return p.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }); };
const pct = (x, sign = true) => (x == null || !Number.isFinite(x) ? '-' : `${sign && x > 0 ? '+' : ''}${x.toFixed(2)}%`);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2400); }
function setTitle(t, back) { $('#title').textContent = t; $('#backBtn').hidden = !back; }
const nowISO = () => new Date().toISOString();

/* ───────── 업비트 공개 시세 ───────── */
const cache = new Map();
async function upbit(path) {
  let r;
  try { r = await fetch(UPBIT + path); } catch { throw new Error('업비트에 연결하지 못했습니다(인터넷 확인)'); }
  if (r.status === 429) { await new Promise((s) => setTimeout(s, 600)); return upbit(path); }
  if (!r.ok) throw new Error('업비트 응답 오류 ' + r.status);
  return r.json();
}
async function markets() {
  if (cache.has('markets')) return cache.get('markets');
  const all = (await upbit('/market/all?isDetails=false')).filter((m) => m.market.startsWith('KRW-'));
  cache.set('markets', all); return all;
}
async function candles(market, tf, total = 400) {
  const key = `c:${market}:${tf}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  let out = [], to = '';
  while (out.length < total) {
    const r = await upbit(`/candles/${TFS[tf].unit}?market=${market}&count=200${to ? '&to=' + encodeURIComponent(to) : ''}`);
    if (!r.length) break;
    out = out.concat(r);
    if (r.length < 200) break;
    to = r[r.length - 1].candle_date_time_utc + 'Z';
  }
  const data = out.reverse().map((k) => ({ t: k.timestamp, d: k.candle_date_time_kst, o: k.opening_price, h: k.high_price, l: k.low_price, c: k.trade_price, v: k.candle_acc_trade_volume }));
  cache.set(key, { at: Date.now(), data });
  return data;
}
const tickers = (ms) => upbit('/ticker?markets=' + ms.join(','));

/* ───────── 알림 중계(구글 Apps Script) ───────── */
async function relay(action, extra) {
  const cfg = await KV.get('relay', {});
  if (!cfg.url || !cfg.key) throw new Error('설정에서 알림 스크립트 주소와 앱 키를 먼저 넣어 주세요');
  let r;
  try { r = await fetch(cfg.url, { method: 'POST', body: JSON.stringify({ key: cfg.key, action, ...extra }) }); } catch { throw new Error('인터넷 연결이나 스크립트 주소를 확인하세요'); }
  let d; try { d = JSON.parse(await r.text()); } catch { throw new Error('스크립트 응답을 읽지 못했습니다(주소·배포 확인)'); }
  if (d.ok === false) throw new Error(d.error === 'denied' ? '앱 키가 스크립트의 APP_KEY와 다릅니다' : d.error || '오류');
  return d;
}
// 알림 켠 코인들의 구간을 다시 계산해 스크립트에 저장
async function syncAlerts(silent) {
  const watch = await KV.get('watch', DEFAULT_WATCH);
  const on = watch.filter((w) => w.alert);
  const items = [];
  for (const w of on) {
    const tf = w.tf || 'day';
    const r = ZoneMath.analyze(await candles(w.market, tf));
    if (r.error) continue;
    items.push({ market: w.market, name: w.name, tf: TFS[tf].label, price: r.price, zones: r.zones.map((z) => ({ low: z.low, high: z.high, score: z.score, labels: [...new Set(z.items.map((x) => x.label))] })) });
  }
  const d = await relay('saveWatch', { items });
  await KV.set('lastSync', nowISO());
  if (!silent) toast(`알림 구간 저장: 코인 ${items.length}개 · 구간 ${d.zones}개`);
  return d;
}

/* ───────── 라우터 ───────── */
const routes = [
  [/^#?\/?$/, 'list', viewList],
  [/^#\/c\/(KRW-[\w]+)$/, 'list', (m) => viewCoin(m[1])],
  [/^#\/add$/, 'list', viewAdd],
  [/^#\/learn$/, 'learn', viewLearn],
  [/^#\/settings$/, 'settings', viewSettings],
];
async function render() {
  const h = (location.hash || '#/').split('?')[0];
  for (const [re, tab, fn] of routes) {
    const m = h.match(re);
    if (m) {
      document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
      try { await fn(m); } catch (e) { console.error(e); view().innerHTML = `<div class="card errbox">오류: ${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
$('#backBtn').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));

/* ───────── 관심 코인 목록 ───────── */
async function viewList() {
  setTitle('가격 위치');
  const watch = await KV.get('watch', DEFAULT_WATCH);
  view().innerHTML = `<div class="card warnlist" style="margin-top:0;font-size:13px">📘 공부용 도구입니다. 여러 근거가 겹치는 가격대를 보여 줄 뿐 <b>매수 추천이 아니며</b>, 결정과 책임은 본인에게 있습니다.</div>
    <div id="ls">${watch.map((w) => `<a class="coin" href="#/c/${w.market}" data-m="${w.market}"><div class="row spread"><span class="nm">${esc(w.name)} <span class="muted" style="font-size:12px">${esc(w.market.slice(4))}</span>${w.alert ? ' 🔔' : ''}</span><span class="px muted">불러오는 중…</span></div><div class="row spread muted info" style="font-size:13px;margin-top:4px"><span>${TFS[w.tf || 'day'].label}</span><span></span></div></a>`).join('') || '<div class="empty">관심 코인이 없습니다.</div>'}</div>
    <a class="btn block" href="#/add">+ 코인 추가</a>
    <div class="disc">시세: 업비트 공개 API · v${APP_VERSION}</div>`;
  if (!watch.length) return;
  try {
    const tk = await tickers(watch.map((w) => w.market));
    for (const t of tk) {
      const el = view().querySelector(`[data-m="${t.market}"]`); if (!el) continue;
      const ch = t.signed_change_rate * 100;
      el.querySelector('.px').className = 'px ' + (ch > 0 ? 'up' : ch < 0 ? 'down' : '');
      el.querySelector('.px').innerHTML = `<b>${fmt(t.trade_price)}</b> ${pct(ch)}`;
    }
  } catch (e) { toast(e.message); }
  // 구간 요약(코인마다 차례로)
  for (const w of watch) {
    const el = view().querySelector(`[data-m="${w.market}"] .info span:last-child`); if (!el) continue;
    try {
      const r = ZoneMath.analyze(await candles(w.market, w.tf || 'day'));
      if (r.error) { el.textContent = r.error; continue; }
      const inside = r.zones.find((z) => r.price >= z.low && r.price <= z.high);
      const near = r.zones[0];
      el.innerHTML = inside ? '<b style="color:#E8A317">검토 구간 안</b>' : near ? `가까운 구간 ${pct(((near.high - r.price) / r.price) * 100)}` : '아래 겹치는 구간 없음';
      el.innerHTML += ` · RSI ${r.rsi != null ? r.rsi.toFixed(0) : '-'}`;
    } catch (e) { el.textContent = e.message; }
  }
  // 알림 켠 코인이 있으면 6시간마다 구간을 다시 저장
  const last = await KV.get('lastSync', null), cfg = await KV.get('relay', {});
  if (cfg.url && watch.some((w) => w.alert) && (!last || Date.now() - Date.parse(last) > 6 * 3600e3)) syncAlerts(true).catch(() => {});
}

async function viewAdd() {
  setTitle('코인 추가', true);
  const watch = await KV.get('watch', DEFAULT_WATCH);
  view().innerHTML = `<div class="card"><input id="q" placeholder="코인 이름이나 기호 (예: 솔라나, SOL)" autocomplete="off"><div class="pick" id="pk"><div class="muted" style="padding:10px">불러오는 중…</div></div></div>`;
  const all = await markets();
  const draw = () => {
    const q = $('#q').value.trim().toUpperCase();
    const L = all.filter((m) => !q || m.korean_name.toUpperCase().includes(q) || m.market.slice(4).includes(q) || m.english_name.toUpperCase().includes(q)).slice(0, 60);
    $('#pk').innerHTML = L.map((m) => { const has = watch.some((w) => w.market === m.market); return `<button type="button" data-m="${m.market}" data-n="${esc(m.korean_name)}" ${has ? 'disabled' : ''}><span>${esc(m.korean_name)} <span class="muted">${esc(m.market.slice(4))}</span></span><span>${has ? '추가됨' : '+'}</span></button>`; }).join('') || '<div class="muted" style="padding:10px">찾는 코인이 없습니다.</div>';
    $('#pk').querySelectorAll('[data-m]').forEach((b) => { b.onclick = async () => { watch.push({ market: b.dataset.m, name: b.dataset.n, tf: 'day' }); await KV.set('watch', watch); toast(`${b.dataset.n} 추가`); location.hash = '#/c/' + b.dataset.m; }; });
  };
  $('#q').oninput = draw; draw(); $('#q').focus();
}

/* ───────── 코인 상세: 차트·구간·근거 ───────── */
async function viewCoin(market) {
  const watch = await KV.get('watch', DEFAULT_WATCH);
  const w = watch.find((x) => x.market === market) || { market, name: market.slice(4), tf: 'day' };
  setTitle(w.name, true);
  const tf = w.tf || 'day';
  view().innerHTML = `<div class="seg" role="radiogroup" aria-label="봉 단위">${Object.entries(TFS).map(([k, v]) => `<label><input type="radio" name="tf" value="${k}"${k === tf ? ' checked' : ''}><span>${v.label}</span></label>`).join('')}</div>
    <div class="card" style="margin-top:10px;padding:8px"><canvas class="chart" id="cv" aria-label="가격 차트와 검토 구간"></canvas>
      <div class="muted" style="font-size:11px;margin-top:4px">빨강 상승·파랑 하락 봉 · 선: <span style="color:#E8A317">60</span>/<span style="color:#8E5CF0">120</span>/<span style="color:#1F9D63">200</span>봉 평균 · 칠한 띠: 검토 구간(진할수록 근거 많음)</div></div>
    <div id="sum" class="card"><div class="muted">계산 중…</div></div>
    <div id="zs"></div>
    <div class="card"><div class="row spread"><b>🔔 알림 (텔레그램·디스코드)</b><label class="row" style="margin:0;color:var(--ink)"><input type="checkbox" id="al" ${w.alert ? 'checked' : ''} style="width:22px;min-height:22px"> 켜기</label></div>
      <div class="muted" style="font-size:13px;margin-top:4px">가격이 위 검토 구간에 들어오면 알려 줍니다(10분마다 확인). 구간은 앱을 열 때 6시간마다 새로 계산해 저장합니다.</div></div>
    ${watch.some((x) => x.market === market) ? '<button class="btn block danger" id="del" type="button">관심 코인에서 빼기</button>' : `<button class="btn block primary" id="addw" type="button">관심 코인에 추가</button>`}
    <div class="disc">공부용 · 매수 추천 아님 · 시세: 업비트</div>`;
  const save = async (patch) => { const ws = await KV.get('watch', DEFAULT_WATCH); const i = ws.findIndex((x) => x.market === market); if (i >= 0) { ws[i] = { ...ws[i], ...patch }; await KV.set('watch', ws); } };
  view().querySelectorAll('[name=tf]').forEach((el) => { el.onchange = async () => { await save({ tf: el.value }); render(); }; });
  if ($('#del')) $('#del').onclick = async () => { if (!confirm(`${w.name}을(를) 관심 코인에서 뺄까요?`)) return; await KV.set('watch', (await KV.get('watch', DEFAULT_WATCH)).filter((x) => x.market !== market)); location.hash = '#/'; };
  if ($('#addw')) $('#addw').onclick = async () => { const ws = await KV.get('watch', DEFAULT_WATCH); ws.push({ market, name: w.name, tf }); await KV.set('watch', ws); render(); };
  $('#al').onchange = async (e) => {
    if (!watch.some((x) => x.market === market)) { e.target.checked = false; toast('관심 코인에 먼저 추가하세요'); return; }
    const cfg = await KV.get('relay', {});
    if (e.target.checked && !cfg.url) { e.target.checked = false; alert('설정에서 알림 스크립트를 먼저 연결해 주세요'); location.hash = '#/settings'; return; }
    await save({ alert: e.target.checked });
    try { await syncAlerts(); } catch (err) { alert('알림 저장 실패: ' + err.message); }
  };

  const cs = await candles(market, tf);
  const r = ZoneMath.analyze(cs);
  if (r.error) { $('#sum').innerHTML = `<div class="errbox" style="margin-top:0">${esc(r.error)}</div>`; return; }
  drawChart($('#cv'), cs, r);
  const inside = r.zones.find((z) => r.price >= z.low && r.price <= z.high);
  $('#sum').innerHTML = `<div class="row spread"><span>현재가</span><b style="font-size:20px">${fmt(r.price)}원</b></div>
    <div class="muted" style="font-size:13px;margin-top:6px">최근 ${r.range.bars}${TFS[tf].name}봉 범위 안 위치 (저점 ${fmt(r.range.low)} ~ 고점 ${fmt(r.range.high)})</div>
    <div class="posbar"><i style="left:${Math.max(0, Math.min(100, r.range.pos || 0))}%"></i></div><div class="row spread muted" style="font-size:12px"><span>저점</span><b>${r.range.pos != null ? r.range.pos.toFixed(0) + '%' : '-'}</b><span>고점</span></div>
    <div class="grid2" style="margin-top:8px;font-size:14px"><div>RSI(14) <b>${r.rsi != null ? r.rsi.toFixed(1) : '-'}</b> <span class="muted">${r.rsi < 30 ? '과매도' : r.rsi > 70 ? '과매수' : '보통'}</span></div><div>${esc(r.trend)}</div></div>
    ${inside ? `<div class="okbox" style="border-color:#E8A317;color:#B26B00">현재가가 검토 구간 안에 있습니다 (근거 ${inside.kinds}개)</div>` : ''}`;
  const zh = r.zones.map((z, i) => `<div class="zone ${z.score >= 3 ? 's3' : ''} ${r.price >= z.low && r.price <= z.high ? 'in' : ''}">
      <div class="row spread"><span class="rng">${fmt(z.low)} ~ ${fmt(z.high)}</span><span>${'★'.repeat(Math.min(5, Math.round(z.score)))} <span class="muted" style="font-size:12px">${z.score}</span></span></div>
      <div class="muted" style="font-size:13px">구간 ${i + 1} · 현재가 대비 ${pct(((z.high - r.price) / r.price) * 100)} · 근거 ${z.kinds}가지</div>
      <ul>${z.items.map((x) => `<li><b>${esc(x.label)}</b> ${fmt(x.p)}${x.touches > 1 ? ` <span class="muted">(${x.touches}번 반등)</span>` : ''}</li>`).join('')}</ul></div>`).join('');
  const singles = r.candidates.filter((x) => x.p < r.price && !r.zones.some((z) => x.p >= z.low && x.p <= z.high)).sort((a, b) => b.p - a.p).slice(0, 5);
  $('#zs').innerHTML = `<div class="card"><h2>검토 구간 <span class="muted">(근거 2가지 이상 겹침)</span></h2>
      ${zh || '<div class="muted">현재가 아래에 근거가 2가지 이상 겹치는 구간이 없습니다. 최근 범위의 바닥 근처이거나 근거가 흩어져 있다는 뜻입니다.</div>'}
      ${singles.length ? `<div style="margin-top:10px"><b style="font-size:14px">근거 하나뿐인 아래 가격</b><ul style="font-size:13px;margin:6px 0 0;padding-left:18px">${singles.map((x) => `<li>${esc(x.label)} ${fmt(x.p)} <span class="muted">(${pct(((x.p - r.price) / r.price) * 100)})</span></li>`).join('')}</ul></div>` : ''}
      <a href="#/learn" style="font-size:13px;display:inline-block;margin-top:8px">각 근거가 무슨 뜻인지 보기 ›</a></div>`;
}

// 캔들 차트 + 이동평균 + 검토 구간 띠 + 현재가 선
function drawChart(cv, cs, r) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const N = Math.min(150, cs.length), s = cs.length - N, show = cs.slice(s);
  let lo = Math.min(...show.map((k) => k.l), ...r.zones.map((z) => z.low)), hi = Math.max(...show.map((k) => k.h));
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const R = 58, cw = (W - R) / N, y = (p) => 8 + (1 - (p - lo) / (hi - lo)) * (H - 24);
  g.fillStyle = dark ? '#182033' : '#FFFFFF'; g.fillRect(0, 0, W, H);
  // 구간 띠
  for (const z of r.zones) {
    const a = z.score >= 3 ? 0.30 : 0.18;
    g.fillStyle = `rgba(232,163,23,${a})`; g.fillRect(0, y(z.high), W - R, Math.max(2, y(z.low) - y(z.high)));
  }
  // 가격 눈금
  g.fillStyle = dark ? '#9AA4BC' : '#66708A'; g.font = '10px sans-serif'; g.textAlign = 'left'; g.strokeStyle = dark ? '#2A3450' : '#EEF1F6'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const p = lo + ((hi - lo) * i) / 4, yy = y(p); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - R, yy); g.stroke(); g.fillText(fmt(p), W - R + 4, yy + 3); }
  // 이동평균
  for (const [m, col] of [[60, '#E8A317'], [120, '#8E5CF0'], [200, '#1F9D63']]) {
    const arr = r.ma[m]; g.strokeStyle = col; g.lineWidth = 1.4; g.beginPath(); let st = false;
    for (let i = 0; i < N; i++) { const v = arr[s + i]; if (v == null) continue; const xx = i * cw + cw / 2; if (!st) { g.moveTo(xx, y(v)); st = true; } else g.lineTo(xx, y(v)); }
    g.stroke();
  }
  // 캔들(한국식: 상승 빨강, 하락 파랑)
  show.forEach((k, i) => {
    const up = k.c >= k.o, col = up ? '#D63B3B' : '#2F6FE0', xx = i * cw + cw / 2;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
    g.beginPath(); g.moveTo(xx, y(k.h)); g.lineTo(xx, y(k.l)); g.stroke();
    const top = y(Math.max(k.o, k.c)), bh = Math.max(1, Math.abs(y(k.o) - y(k.c)));
    g.fillRect(xx - Math.max(1, cw * 0.35), top, Math.max(1, cw * 0.7), bh);
  });
  // 현재가
  g.setLineDash([4, 3]); g.strokeStyle = dark ? '#E8ECF5' : '#15203A'; g.beginPath(); g.moveTo(0, y(r.price)); g.lineTo(W - R, y(r.price)); g.stroke(); g.setLineDash([]);
  g.fillStyle = dark ? '#E8ECF5' : '#15203A'; g.fillRect(W - R, y(r.price) - 8, R, 16); g.fillStyle = dark ? '#15203A' : '#FFFFFF'; g.fillText(fmt(r.price), W - R + 3, y(r.price) + 3);
}

/* ───────── 근거 설명 ───────── */
function viewLearn() {
  setTitle('근거 설명');
  const keys = ['swing', 'poc', 'val', 'ma60', 'ma120', 'ma200', 'bb', 'fib382', 'fib500', 'fib618', 'rsi'];
  view().innerHTML = `<div class="card"><h2>검토 구간은 이렇게 정합니다</h2><ol class="steps">
      <li>현재가 아래(1% 위까지)에 있는 근거 가격을 모두 구합니다.</li>
      <li>가까운 근거끼리(평균 변동폭 ATR의 0.6배 안) 하나로 묶습니다.</li>
      <li>서로 <b>다른 종류의 근거가 2가지 이상</b> 겹친 묶음만 '검토 구간'으로 보여 줍니다. 이동평균 여러 개, 피보나치 여러 개는 한 종류로 칩니다.</li>
      <li>점수 = 근거 종류 수(+ 지지선이 여러 번 확인되면 최대 1점). 구간 폭은 ATR의 0.25배씩 넓힙니다.</li></ol>
      <div class="warnlist">겹치는 근거가 많아도 가격은 더 내려갈 수 있습니다. 구간은 '많은 사람이 보는 자리'일 뿐 바닥 보장이 아닙니다. 손절 기준과 나눠 사기 계획을 따로 정해 두세요.</div></div>
    ${keys.map((k) => `<div class="card"><b>${esc(ZoneMath.LABEL[k])}</b><div class="muted" style="margin-top:4px">${esc(ZoneMath.WHY[k])}</div></div>`).join('')}
    <div class="card"><b>ATR (평균 변동폭)</b><div class="muted" style="margin-top:4px">최근 14개 봉의 평균 움직임 크기입니다. 근거를 묶는 거리와 구간 폭을 정하는 데 씁니다.</div></div>`;
}

/* ───────── 설정 ───────── */
async function viewSettings() {
  setTitle('설정');
  const cfg = await KV.get('relay', {}), last = await KV.get('lastSync', null);
  view().innerHTML = `<div class="card"><h2>알림 연결 (텔레그램·디스코드)</h2>
      <div class="muted" style="font-size:13px">구글 Apps Script에 올린 알림 스크립트의 웹 앱 주소와, 스크립트 속성 APP_KEY와 같은 값을 넣으세요. 텔레그램 봇 토큰·디스코드 웹훅 주소는 스크립트에만 있고 폰에는 저장되지 않습니다. <a href="alert/" target="_blank" rel="noopener">준비 순서 보기</a></div>
      <label for="r_url">알림 스크립트 웹 앱 주소</label><input id="r_url" value="${esc(cfg.url || '')}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
      <label for="r_key">앱 키 (APP_KEY)</label><input id="r_key" type="password" value="${esc(cfg.key || '')}" autocomplete="off">
      <div class="row wrap" style="margin-top:10px"><button class="btn primary" id="r_save" type="button">저장하고 연결 확인</button><button class="btn" id="r_test" type="button">테스트 알림 보내기</button><button class="btn" id="r_sync" type="button">구간 지금 저장</button></div>
      <div id="r_res" style="margin-top:8px"></div>
      <div class="muted" style="font-size:12px">마지막 구간 저장: ${last ? new Date(last).toLocaleString('ko-KR') : '없음'}</div></div>
    <div class="card"><h2>알아 두기</h2><ul class="steps">
      <li>이 앱은 업비트 <b>공개 시세</b>만 읽습니다. 주문·계좌 기능은 없습니다.</li>
      <li>구간과 알림은 공부용입니다. 매수 추천이 아니며 결정과 책임은 본인에게 있습니다.</li>
      <li>관심 코인과 설정은 이 폰에만 저장됩니다.</li></ul></div>
    <div class="card"><h2>앱 정보</h2><div class="muted">가격 위치 v${APP_VERSION}<br>폰 홈 화면에 추가: 크롬 ⋮ → '홈 화면에 추가' 또는 '앱 설치'</div></div>`;
  const res = (html) => { $('#r_res').innerHTML = html; };
  $('#r_save').onclick = async () => {
    const url = $('#r_url').value.trim(), key = $('#r_key').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { alert('주소는 https://script.google.com/macros/s/…/exec 모양이어야 합니다'); return; }
    if (key.length < 8) { alert('앱 키는 8자 이상이어야 합니다'); return; }
    await KV.set('relay', { url, key });
    res('<div class="muted">확인 중…</div>');
    try {
      const d = await relay('ping');
      res(`<div class="${d.telegram || d.discord ? 'okbox' : 'warnlist'}" style="margin-top:0">${d.telegram || d.discord ? '✅' : '⚠️'} 연결됨 · 텔레그램 ${d.telegram ? '✅' : '—'} · 디스코드 ${d.discord ? '✅' : '—'}${d.telegram || d.discord ? '' : ' <span style="color:var(--red)">(받을 곳이 없음)</span>'} · 자동 확인 ${d.trigger ? '켜짐(10분마다)' : '<span style="color:var(--red)">꺼짐 — 스크립트에서 알림켜기 실행</span>'} · 저장된 코인 ${d.watching}개</div>`);
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
