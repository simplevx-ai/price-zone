/* 가격 위치 — 📊 ETF 선물 스캐너 화면 (OKX·바이낸스 공개 시세, 자동 주문 없음) */
'use strict';

const SC_TF = { '15m': { okx: '15m', bn: '15m', label: '15분봉', ttl: 2 * 60e3 }, '1H': { okx: '1H', bn: '1h', label: '1시간봉', ttl: 5 * 60e3 }, '4H': { okx: '4H', bn: '4h', label: '4시간봉', ttl: 10 * 60e3 }, '1D': { okx: '1Dutc', bn: '1d', label: '일봉', ttl: 30 * 60e3 } };
const SC_SORT = { up: '🔼 반등 관심', dn: '🔽 하락 전환 관심', vol: '💰 거래대금', atr: '🌊 변동성' };
const SC_SET = { core: '핵심(나스닥·S&P·반도체)', top: '전체 ETF 상위 20', nasdaq: '나스닥100', sp500: 'S&P500', semi: '반도체', other: '기타 ETF' };

async function scTickers() {
  const hit = await KV.get('sc:tickers', null);
  if (hit && Date.now() - hit.at < 60e3) return hit.data;
  const out = {};
  const [o, b] = await Promise.allSettled([okxGet('/market/tickers?instType=SWAP'), fetch('https://fapi.binance.com/fapi/v1/ticker/24hr').then((r) => r.json())]);
  for (const s of Object.keys(SCAN.META)) {
    const x = o.status === 'fulfilled' ? o.value.find((t) => t.instId === s + '-USDT-SWAP') : null;
    const y = b.status === 'fulfilled' && Array.isArray(b.value) ? b.value.find((t) => t.symbol === s + 'USDT') : null;
    if (!x && !y) continue;
    out[s] = {
      okx: x ? { last: +x.last, chg: ((+x.last / +x.open24h) - 1) * 100, vol: +x.volCcy24h * +x.last } : null,
      bn: y ? { last: +y.lastPrice, chg: +y.priceChangePercent, vol: +y.quoteVolume } : null,
    };
    out[s].vol = (out[s].okx ? out[s].okx.vol : 0) + (out[s].bn ? out[s].bn.vol : 0);
  }
  const data = { t: out, okxOk: o.status === 'fulfilled', bnOk: b.status === 'fulfilled' && Array.isArray(b.value) };
  KV.set('sc:tickers', { at: Date.now(), data }).catch(() => {});
  return data;
}
async function scCandles(sym, src, tf) {
  const key = `sc:${src}:${sym}:${tf}`, hit = await KV.get(key, null);
  if (hit && Date.now() - hit.at < SC_TF[tf].ttl) return hit.data;
  let data;
  if (src === 'okx') data = SCAN.fromOkx(await okxGet(`/market/candles?instId=${sym}-USDT-SWAP&bar=${SC_TF[tf].okx}&limit=300`));
  else { const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=${SC_TF[tf].bn}&limit=300`); data = SCAN.fromBinance(await r.json()); }
  KV.set(key, { at: Date.now(), data }).catch(() => {});
  return data;
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch((e) => ({ error: e.message })); } })); return out; }

const scFmt = (p) => (p == null ? '-' : p >= 1000 ? p.toFixed(0) : p >= 100 ? p.toFixed(1) : p.toFixed(2));
const scMoney = (v) => (v >= 1e8 ? (v / 1e8).toFixed(v >= 1e10 ? 0 : 1) + '억 달러' : v >= 1e4 ? Math.round(v / 1e4).toLocaleString('ko-KR') + '만 달러' : Math.round(v) + '달러');
const scChip = (label, s) => `<span class="scchip s${Math.min(s, 4)}">${label} ${s}/5 ${SCAN.strength(s)}</span>`;

async function viewScan() {
  setTitle('📊 ETF 스캐너');
  const prefs = await KV.get('scPrefs', { set: 'core', tf: '4H', sort: 'up' });
  const draw = async () => {
    view().innerHTML = `${nqSwitch('scan')}
      <div class="card warnlist" style="margin-top:0;font-size:13px">📘 정해진 조건의 개수로 매긴 점수입니다. 매수·매도 추천이 아니며 <b>자동 주문은 하지 않습니다</b>. 3배 레버리지 상품을 선물로 거래하면 손실이 원금보다 커질 수 있습니다.</div>
      <div class="chips">${Object.entries(SC_SET).map(([k, v]) => `<button class="chip${prefs.set === k ? ' on' : ''}" data-set="${k}" type="button">${v}</button>`).join('')}</div>
      <div class="seg" role="radiogroup" aria-label="봉 단위">${Object.entries(SC_TF).map(([k, v]) => `<label><input type="radio" name="sctf" value="${k}"${prefs.tf === k ? ' checked' : ''}><span>${v.label}</span></label>`).join('')}</div>
      <div class="chips" role="tablist" aria-label="정렬" style="margin-top:8px">${Object.entries(SC_SORT).map(([k, v]) => `<button class="chip${prefs.sort === k ? ' on' : ''}" data-sort="${k}" type="button">${v}</button>`).join('')}</div>
      <div id="scMkt" class="card" style="margin-top:10px"><div class="muted">시장 방향 계산 중…</div></div>
      <div id="scList"><div class="card"><div class="muted">OKX·바이낸스 시세를 받는 중… (처음엔 10~20초)</div></div></div>
      <div id="scAlert"></div>
      <div class="card"><details><summary><b>점수 기준 자세히</b></summary><div class="muted" style="font-size:13px;margin-top:6px">
        <b>🔼 반등 포착(0~5)</b>: ① RSI가 최근 10봉 안에 40 이하까지 내려갔다가 3봉 전보다 오름 ② MACD 히스토그램 음→양 전환 또는 2봉 연속 좋아짐 ③ 종가가 5봉 지수평균 위 ④ 거래량이 20봉 평균의 1.3배 이상이면서 양봉 ⑤ 최근 3봉 저점이 그 전 저점보다 높음(직전 저점 지킴).<br>
        <b>🔽 하락 전환 포착(0~5)</b>: ① RSI가 최근 60 이상까지 올랐다가 3봉 전보다 내림 ② MACD 히스토그램 양→음 전환 또는 2봉 연속 나빠짐 ③ 종가가 5봉 지수평균 아래 ④ 거래량 1.3배 이상 음봉 ⑤ 최근 3봉 고점이 그 전 고점보다 낮음.<br>
        4~5개 '강', 3개 '보통', 2개 '약'. 하락 추세 속 반등 점수는 '추세 역행'이라 더 조심해야 합니다(일봉 추세를 함께 표시).<br>
        <b>변동성</b>: 일봉 ATR(14)÷가격. 10% 이상 초고변동, 5~10% 고변동, 2~5% 중간, 2% 미만 낮음. ATR이 20봉 전의 1.5배 이상이면 '변동성 확대' 경고.<br>
        <b>VWAP</b>: 그날(UTC 0시, 한국 9시)부터의 거래량 가중 평균 가격(일봉은 최근 20봉). 데이터는 OKX에 있으면 OKX(직접 거래하시는 곳), 없으면 바이낸스.</div></details></div>
      <div class="disc">시세: OKX·바이낸스 공개 API · 자동 주문 없음 · UPRO·SPXU·SPDN은 두 거래소에 없음 · 바이낸스 'SPX'는 S&P500이 아닌 밈 코인</div>`;
    view().querySelectorAll('[data-set]').forEach((b) => { b.onclick = async () => { prefs.set = b.dataset.set; await KV.set('scPrefs', prefs); draw(); }; });
    view().querySelectorAll('[name=sctf]').forEach((r) => { r.onchange = async () => { prefs.tf = r.value; await KV.set('scPrefs', prefs); draw(); }; });
    view().querySelectorAll('[data-sort]').forEach((b) => { b.onclick = async () => { prefs.sort = b.dataset.sort; await KV.set('scPrefs', prefs); view().querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('on', x === b)); render2(); }; });
    scAlertCard();

    let T; try { T = await scTickers(); } catch (e) { $('#scList').innerHTML = `<div class="card errbox">${esc(e.message)}</div>`; return; }
    let syms = Object.keys(T.t);
    if (prefs.set === 'core') syms = SCAN.CORE.filter((s) => T.t[s]);
    else if (prefs.set === 'top') syms = syms.sort((a, b) => T.t[b].vol - T.t[a].vol).slice(0, 20);
    else syms = syms.filter((s) => SCAN.META[s].g === prefs.set);
    const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    let done = 0;
    const R = await pool(syms, 4, async (s) => {
      // OKX(직접 거래하는 곳) 우선, 봉이 모자라면(최근 상장) 바이낸스
      const get = async (tf) => { let src = T.t[s].okx ? 'okx' : 'bn', cs = await scCandles(s, src, tf); if (cs.length < 40 && src === 'okx' && T.t[s].bn) { src = 'bn'; cs = await scCandles(s, 'bn', tf); } return { src, cs }; };
      const A = await get(prefs.tf), src = A.src, a = SCAN.analyze(A.cs, { dayStart, daily: prefs.tf === '1D' });
      const d = prefs.tf === '1D' ? a : SCAN.analyze((await get('1D')).cs, { daily: true });
      done++; const el = $('#scList .muted'); if (el) el.textContent = `분석 중… ${done}/${syms.length}`;
      return { s, src, a, d, tk: T.t[s] };
    });
    window._scR = R.filter((x) => x && !x.error && x.a && !x.a.error);
    render2();
    // 시장 방향(QQQ·SPY 일봉)
    const mk = await pool(['QQQ', 'SPY'], 2, async (s) => ({ s, d: SCAN.analyze(await scCandles(s, T.t[s] && T.t[s].okx ? 'okx' : 'bn', '1D'), { daily: true }) }));
    $('#scMkt').innerHTML = `<h2>시장 방향 <span class="muted">(일봉)</span></h2>${mk.map((x) => x.d && !x.d.error ? `<div style="font-size:14px;margin:4px 0"><b>${x.s}</b> ${scFmt(x.d.price)} · RSI ${x.d.rsi.toFixed(1)} · <span class="${x.d.trend === 'up' ? 'up' : x.d.trend === 'down' ? 'down' : ''}">${esc(SCAN.dayTrend(x.d))}</span></div>` : '').join('')}
      <div class="muted" style="font-size:12px">${!T.okxOk ? '⚠️ OKX 시세를 못 받음 · ' : ''}${!T.bnOk ? '⚠️ 바이낸스 시세를 못 받음 · ' : ''}${SC_TF[prefs.tf].label} 기준 점수 · ${new Date().toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>`;
  };
  const render2 = () => {
    const R = (window._scR || []).slice();
    const key = { up: (x) => x.a.upScore * 10 - x.a.dnScore, dn: (x) => x.a.dnScore * 10 - x.a.upScore, vol: (x) => x.tk.vol, atr: (x) => (x.d && x.d.atrPct) || 0 }[prefs.sort];
    R.sort((p, q) => key(q) - key(p));
    $('#scList').innerHTML = `<div class="card"><h2>${SC_SORT[prefs.sort]} <span class="muted">(${R.length}종목 · ${SC_TF[prefs.tf].label})</span></h2>${R.map((x, i) => scRow(x, i)).join('') || '<div class="muted">종목이 없습니다.</div>'}</div>`;
  };
  await draw();
}
function scRow(x, i) {
  const m = SCAN.META[x.s], a = x.a, d = x.d && !x.d.error ? x.d : null, tk = x.tk, px = (tk.okx || tk.bn);
  const lev = m.lev < 0 ? '<span class="levtag inv">인버스</span>' : '';
  const ex = [tk.okx ? `OKX ${scMoney(tk.okx.vol)}` : '', tk.bn ? `바이낸스 ${scMoney(tk.bn.vol)}` : ''].filter(Boolean).join(' · ');
  const warn = [d && d.atrJump >= 1.5 ? `⚠️ 변동성 확대(ATR ${d.atrJump.toFixed(1)}배)` : '', a.volRatio >= 2 ? `📢 거래량 급증 ${a.volRatio.toFixed(1)}배` : ''].filter(Boolean).join(' · ');
  const ck = (L) => `<ul class="checks">${L.map((c) => `<li>${c.ok ? '✅' : '⬜'} ${esc(c.name)}</li>`).join('')}</ul>`;
  const pos = (v, ref, label) => (ref == null ? '' : `<span class="${v > ref ? 'up' : 'down'}">${label} ${v > ref ? '위' : '아래'}</span>`);
  return `<details class="scrow"><summary>
      <div class="row spread"><span><b>${i + 1}. ${x.s}</b> <span class="muted" style="font-size:12px">${esc(m.name)}</span> ${lev}</span><span class="${px.chg > 0 ? 'up' : px.chg < 0 ? 'down' : ''}" style="font-size:13px">${scFmt(px.last)} ${pct(px.chg)}</span></div>
      <div class="row wrap" style="gap:4px;margin-top:4px">${scChip('🔼반등', a.upScore)}${scChip('🔽하락전환', a.dnScore)}<span class="scchip">${SCAN.volClass(d && d.atrPct)} ${d && d.atrPct ? d.atrPct.toFixed(1) + '%' : ''}</span>${d ? `<span class="scchip ${d.trend === 'up' ? 'tup' : d.trend === 'down' ? 'tdn' : ''}">일봉 ${d.trend === 'up' ? '상승' : d.trend === 'down' ? '하락' : '횡보'}</span>` : ''}</div>
      ${warn ? `<div style="font-size:12px;margin-top:3px;color:#B26B00">${warn}</div>` : ''}
      <div class="muted" style="font-size:11px;margin-top:3px">${ex}</div></summary>
    <div class="grid2" style="font-size:13px;margin-top:8px">
      <div>RSI(14) <b>${a.rsi != null ? a.rsi.toFixed(1) : '-'}</b></div><div>MACD 히스토그램 <b>${a.hist != null ? a.hist.toFixed(3) : '-'}</b></div>
      <div>ADX <b>${a.adx != null ? a.adx.toFixed(0) : '-'}</b> <span class="muted">(+DI ${a.pdi != null ? a.pdi.toFixed(0) : '-'} / −DI ${a.mdi != null ? a.mdi.toFixed(0) : '-'})</span></div><div>VWAP 대비 <b class="${a.vwapGap > 0 ? 'up' : 'down'}">${pct(a.vwapGap)}</b></div>
      <div>거래량 <b>${a.volRatio != null ? a.volRatio.toFixed(2) + '배' : '-'}</b> <span class="muted">(20봉 평균 대비)</span></div><div>ATR(봉) <b>${a.atrPct != null ? a.atrPct.toFixed(2) + '%' : '-'}</b></div></div>
    <div style="font-size:13px;margin-top:6px">${pos(a.price, a.ema5, 'EMA5')} · ${pos(a.price, a.ema20, 'EMA20')} · ${pos(a.price, a.ema50, 'EMA50')}${a.ema200 != null ? ' · ' + pos(a.price, a.ema200, 'EMA200') : ''}</div>
    ${d ? `<div class="muted" style="font-size:12px;margin-top:4px">일봉: ${esc(SCAN.dayTrend(d))} · RSI ${d.rsi.toFixed(1)}</div>` : ''}
    <h4>🔼 반등 조건 ${a.upScore}/5</h4>${ck(a.up)}<h4>🔽 하락 전환 조건 ${a.dnScore}/5</h4>${ck(a.dn)}
    ${d && d.trend === 'down' && a.upScore >= 3 ? '<div class="warnlist" style="font-size:12px">일봉은 하락 추세입니다. 지금 반등 점수는 추세를 거스르는 단기 반등 신호라 실패할 가능성도 큽니다.</div>' : ''}
    ${d && d.trend === 'up' && a.dnScore >= 3 ? '<div class="warnlist" style="font-size:12px">일봉은 상승 추세입니다. 지금 하락 전환 점수는 눌림일 수도 있습니다.</div>' : ''}
    ${m.pair ? `<div class="muted" style="font-size:12px;margin-top:4px">반대 상품: ${m.pair} (이 종목이 반등이면 ${m.pair}는 보통 하락 쪽)</div>` : ''}
    <div class="muted" style="font-size:11px;margin-top:4px">데이터: ${x.src === 'okx' ? 'OKX' : '바이낸스'} ${a.bars}봉 · 마지막 끝난 봉 ${new Date(a.t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 시작</div>
  </details>`;
}
async function scAlertCard() {
  const cfg = await KV.get('scAlert', { enabled: false }), rs = await KV.get('relayStatus', {});
  const el = $('#scAlert'); if (!el) return;
  el.innerHTML = `<div class="card"><div class="row spread"><b>🔔 디스코드 아침 정리</b><label class="row" style="margin:0;color:var(--ink)"><input type="checkbox" id="scAl" ${cfg.enabled ? 'checked' : ''} style="width:22px;min-height:22px"> 켜기</label></div>
    <div class="muted" style="font-size:13px;margin-top:4px">매일 한국 시간 9시 10분쯤(일봉이 끝난 뒤) 스크립트가 OKX 종목으로 시장 방향, 반등·하락 전환 상위, 거래대금, 변동성 순위를 디스코드로 보냅니다. 구글 서버에서는 바이낸스가 막혀 있어 아침 정리는 OKX 기준입니다.</div>
    ${rs.checkedAt && (rs.version || 0) < 9 ? '<div class="warnlist">스크립트를 새 버전(v9)으로 바꿔야 동작합니다</div>' : ''}</div>`;
  $('#scAl').onchange = async (e) => {
    if (e.target.checked && !(await relayOn())) { e.target.checked = false; alert('설정에서 알림 스크립트를 먼저 연결해 주세요'); return; }
    try { await relay('saveScan', { enabled: e.target.checked }); await KV.set('scAlert', { enabled: e.target.checked }); toast(e.target.checked ? '아침 정리를 켰습니다' : '아침 정리를 껐습니다'); }
    catch (err) { e.target.checked = !e.target.checked; alert('저장 실패: ' + err.message); }
  };
  if (await relayOn()) relay('ping').then(async (d) => { if (!d.scan) return; const cb = $('#scAl'); if (cb) cb.checked = !!d.scan.enabled; await KV.set('scAlert', { enabled: !!d.scan.enabled }); }).catch(() => {});
}
// 📡 화면 위쪽 전환 버튼(스캐너 ↔ QQQ 규칙 신호)
function nqSwitch(on) {
  return `<div class="chips" style="margin-bottom:8px"><a class="chip${on === 'scan' ? ' on' : ''}" href="#/scan">📊 ETF 스캐너</a><a class="chip${on === 'nq' ? ' on' : ''}" href="#/nq">🔔 QQQ 규칙 신호</a></div>`;
}
