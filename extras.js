/* 매매 도구 묶음(AI 마켓·선물·코인 스캐너 공통): 🎯 가격 도달 알림 · 🧭 여러 봉 판단표 · 🔥 청산 지도 · 🐋 고래 흐름 · 🏦 코인 ETF 입출금 · 📅 경제 일정
 * 필요한 전역: KV, relay, relayOn, esc, pct. 실패해도 다른 화면은 그대로. 공부용 참고이며 예측·권유가 아님. */
const xNum = (p) => (p == null || !Number.isFinite(p) ? '-' : Math.abs(p) >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : Math.abs(p) >= 1 ? p.toFixed(2) : p.toPrecision(4));
const xUsd = (v) => (v == null || !Number.isFinite(v) ? '-' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toFixed(0));
// 지표 직접 계산(앱마다 scan.js가 달라서): EMA20·EMA50·RSI14·MACD 히스토그램
function xInd(cs) {
  const c = cs.map((k) => k.c), n = c.length;
  const ema = (p) => { const k = 2 / (p + 1), o = Array(n).fill(null); let e = null; for (let i = 0; i < n; i++) { e = e == null ? c[i] : c[i] * k + e * (1 - k); if (i >= p - 1) o[i] = e; } return o; };
  const e12 = ema(12), e26 = ema(26), macd = c.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const sig = Array(n).fill(null); { let e = null; const k = 2 / 10; let cnt = 0; for (let i = 0; i < n; i++) { if (macd[i] == null) continue; cnt++; e = e == null ? macd[i] : macd[i] * k + e * (1 - k); if (cnt >= 9) sig[i] = e; } }
  const rsi = Array(n).fill(null); if (n > 15) { let g = 0, l = 0; for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } g /= 14; l /= 14; rsi[14] = l ? 100 - 100 / (1 + g / l) : 100; for (let i = 15; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; rsi[i] = l ? 100 - 100 / (1 + g / l) : 100; } }
  return { ema20: ema(20), ema50: ema(50), rsi, hist: macd.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null)) };
}
async function xJson(url) { const r = await fetch(url); if (!r.ok) throw new Error('응답 ' + r.status); return r.json(); }

/* ── 🎯 가격 도달 알림 ── a = { app:'pz'|'nf'|'cs', kind:'okx'|'coin'|'cfut'|'us'|'kr', sym, name, last } */
async function paCard(host, a) {
  if (!host) return;
  const key = 'pa:' + a.app;
  let L = await KV.get(key, []);
  const on = await relayOn();
  if (on) { try { const d = await relay('getPriceAlerts', { app: a.app }); if (d.items) { const f = {}; d.items.forEach((x) => { f[x.id] = x.fired; }); L.forEach((x) => { if (f[x.id] !== undefined) x.fired = f[x.id]; }); await KV.set(key, L); } } catch { /* 저장된 것으로 */ } }
  const mine = L.filter((x) => x.kind === a.kind && x.sym === a.sym);
  const draw = () => {
    host.innerHTML = `<div class="card"><h2>🎯 가격 도달 알림 <span class="muted">(디스코드, 10분마다 확인)</span></h2>
      ${on ? '' : '<div class="warnlist" style="font-size:12px">설정(계산기) 탭에서 알림 스크립트를 연결해야 알림이 갑니다.</div>'}
      <div class="row" style="gap:6px;align-items:flex-end;flex-wrap:wrap"><div style="flex:1;min-width:120px"><label for="paP">가격</label><input id="paP" type="number" inputmode="decimal" value="${a.last ? +xNum(a.last).replace(/,/g, '') : ''}"></div>
        <div><label for="paD">조건</label><select id="paD"><option value="up">이 가격 이상</option><option value="down">이 가격 이하</option></select></div></div>
      <input id="paN" placeholder="메모(선택) — 예: 1차 매수 자리, 손절" style="margin-top:6px">
      <button class="btn primary block" id="paAdd" type="button" style="margin-top:6px">+ 알림 추가</button>
      <div style="margin-top:8px">${mine.length ? mine.map((x) => `<div class="row spread" style="font-size:13px;padding:4px 0;border-bottom:1px solid var(--line)"><span>${x.dir === 'up' ? '⬆️ 이상' : '⬇️ 이하'} <b>${xNum(x.price)}</b>${x.note ? ' · ' + esc(x.note) : ''}${x.fired ? ` <span style="color:var(--green)">✅ 보냄 ${new Date(x.fired).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>` : ''}</span><span>${x.fired ? `<button class="btn small" type="button" data-par="${x.id}">다시 켜기</button>` : ''}<button class="btn small danger" type="button" data-pad="${x.id}">삭제</button></span></div>`).join('') : '<div class="muted" style="font-size:12px">이 종목에 걸린 알림이 없습니다.</div>'}</div>
      <div class="muted" style="font-size:11px;margin-top:4px">이 앱 전체 알림 ${L.length}/30개 · 닿으면 한 번 보내고 멈춥니다(다시 켜기 가능)</div></div>`;
    const save = async () => { await KV.set(key, L); if (on) { try { await relay('savePriceAlerts', { app: a.app, items: L }); } catch (e) { alert('알림 저장 실패: ' + e.message); } } draw(); };
    host.querySelector('#paAdd').onclick = async () => {
      const p = parseFloat(host.querySelector('#paP').value); if (!(p > 0)) { alert('가격을 넣으세요'); return; }
      if (L.length >= 30) { alert('알림은 30개까지입니다'); return; }
      const dir = host.querySelector('#paD').value;
      L.push({ id: Date.now().toString(36), kind: a.kind, sym: a.sym, name: a.name || a.sym, price: p, dir, note: host.querySelector('#paN').value.trim().slice(0, 60), fired: null });
      mine.push(L[L.length - 1]); await save();
    };
    host.querySelectorAll('[data-pad]').forEach((b) => { b.onclick = async () => { const i = L.findIndex((x) => x.id === b.dataset.pad); if (i >= 0) L.splice(i, 1); const j = mine.findIndex((x) => x.id === b.dataset.pad); if (j >= 0) mine.splice(j, 1); await save(); }; });
    host.querySelectorAll('[data-par]').forEach((b) => { b.onclick = async () => { const x = L.find((y) => y.id === b.dataset.par); if (x) { x.fired = null; x.id = Date.now().toString(36); } await save(); }; });
    // 현재가로 기본 방향
    const pin = host.querySelector('#paP'), dsel = host.querySelector('#paD'); pin.oninput = () => { const p = parseFloat(pin.value); if (a.last && p > 0) dsel.value = p >= a.last ? 'up' : 'down'; };
  };
  draw();
}

/* ── 🧭 여러 봉 판단표 ── getCs(tf) → 봉 배열(오래된 것부터). tfs = [[키, 이름], …] */
async function mtfCard(host, tfs, getCs) {
  if (!host) return;
  host.innerHTML = '<div class="card"><h2>🧭 여러 봉 한눈에</h2><div class="muted">봉 단위별로 계산 중…</div></div>';
  const rows = await Promise.all(tfs.map(async ([k, nm]) => {
    try {
      const cs = await getCs(k); if (!cs || cs.length < 60) return { nm, err: '봉 부족' };
      const I = xInd(cs), i = cs.length - 1, p = cs[i].c, e20 = I.ema20[i], e50 = I.ema50[i], r = I.rsi[i], h = I.hist[i], h1 = I.hist[i - 1];
      let sc = 0; if (p > e20) sc++; else sc--; if (e20 > e50) sc++; else sc--; if (h > 0) sc++; else sc--; if (h > h1) sc += 0.5; else sc -= 0.5; if (r >= 55) sc += 0.5; else if (r <= 45) sc -= 0.5;
      return { nm, sc, r, p, e20, e50, h };
    } catch (e) { return { nm, err: e.message }; }
  }));
  if (!host.isConnected) return;
  const ok = rows.filter((x) => !x.err), up = ok.filter((x) => x.sc >= 2).length, dn = ok.filter((x) => x.sc <= -2).length;
  const verdict = !ok.length ? ['⚠️', '봉을 받지 못했습니다'] : ok.length && up === ok.length ? ['🟢', '모든 봉이 상승 쪽 — 방향이 맞음(눌림 때 롱 쪽이 유리)'] : ok.length && dn === ok.length ? ['🔴', '모든 봉이 하락 쪽 — 방향이 맞음(반등 때 숏 쪽이 유리)'] : up > dn ? ['🟡', '큰 봉 위주로 상승, 일부 엇갈림 — 짧은 봉 신호는 조심'] : dn > up ? ['🟠', '큰 봉 위주로 하락, 일부 엇갈림 — 역추세 진입 조심'] : ['⚪', '봉마다 방향이 엇갈림 — 관망 구간'];
  const arrow = (sc) => (sc >= 2 ? '<b class="up">▲ 상승</b>' : sc <= -2 ? '<b class="down">▼ 하락</b>' : sc > 0 ? '<span class="up">↗ 약한 상승</span>' : sc < 0 ? '<span class="down">↘ 약한 하락</span>' : '— 횡보');
  host.innerHTML = `<div class="card"><h2>🧭 여러 봉 한눈에</h2>
    <div class="tblwrap"><table class="md" style="font-size:13px"><thead><tr><th>봉</th><th>방향</th><th>RSI</th><th>EMA20/50</th><th>MACD</th></tr></thead><tbody>
    ${rows.map((x) => (x.err ? `<tr><td>${x.nm}</td><td colspan="4" class="muted">${esc(x.err)}</td></tr>` : `<tr><td><b>${x.nm}</b></td><td>${arrow(x.sc)}</td><td>${x.r != null ? x.r.toFixed(0) : '-'}</td><td>${x.p > x.e20 ? '위' : '아래'} · ${x.e20 > x.e50 ? '정배열' : '역배열'}</td><td class="${x.h > 0 ? 'up' : 'down'}">${x.h > 0 ? '+' : '−'}</td></tr>`)).join('')}</tbody></table></div>
    <div style="font-size:14px;margin-top:6px">${verdict[0]} <b>${verdict[1]}</b></div>
    <div class="muted" style="font-size:11px">방향 점수: 종가>EMA20·EMA20>EMA50·MACD 히스토그램 양수·증가·RSI 55/45 — 공부용 참고</div></div>`;
}

/* ── 🔥 청산 지도(추정) — 바이낸스 1시간봉 + 미결제약정 증가분으로 레버리지별 청산 가격을 쌓아 추정. 실제 청산 주문 위치가 아님 ── */
async function liqMapCard(host, base) {
  if (!host) return;
  host.innerHTML = '<div class="card"><h2>🔥 청산 지도(추정)</h2><div class="muted">계산 중…</div></div>';
  try {
    const sym = base.toUpperCase() + 'USDT';
    const [K, OI] = await Promise.all([xJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=500`), xJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=500`)]);
    const cs = K.map((k) => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4] })), oi = {}; OI.forEach((x) => { oi[x.timestamp] = +x.sumOpenInterestValue; });
    const p = cs[cs.length - 1].c, lo = p * 0.85, hi = p * 1.15, N = 60, step = (hi - lo) / N, longB = Array(N).fill(0), shortB = Array(N).fill(0);
    const LEV = [[10, 0.3], [25, 0.3], [50, 0.25], [100, 0.15]];
    for (let i = 1; i < cs.length; i++) {
      const a = oi[cs[i].t], b = oi[cs[i - 1].t]; if (!(a && b) || a <= b) continue;
      const add = a - b, entry = (cs[i].h + cs[i].l + cs[i].c) / 3;
      let minL = Infinity, maxH = -Infinity; for (let j = i + 1; j < cs.length; j++) { minL = Math.min(minL, cs[j].l); maxH = Math.max(maxH, cs[j].h); }
      LEV.forEach(([L, w]) => {
        const ll = entry * (1 - 1 / L + 0.005), sl = entry * (1 + 1 / L - 0.005), v = add * w * 0.5;
        if (ll > lo && ll < p && !(minL <= ll)) longB[Math.floor((ll - lo) / step)] += v;
        if (sl < hi && sl > p && !(maxH >= sl)) shortB[Math.floor((sl - lo) / step)] += v;
      });
    }
    const top = (B, side) => B.map((v, j) => ({ v, px: lo + step * (j + 0.5), side })).filter((x) => x.v > 0).sort((x, y) => y.v - x.v).slice(0, 3).sort((x, y) => (side === 'long' ? y.px - x.px : x.px - y.px));
    const TL = top(longB, 'long'), TS = top(shortB, 'short'), mx = Math.max(...longB, ...shortB, 1);
    if (!host.isConnected) return;
    const bars = [];
    for (let j = N - 1; j >= 0; j--) { const v = longB[j] + shortB[j]; if (!v) continue; const px = lo + step * (j + 0.5); bars.push(`<div style="display:flex;align-items:center;gap:6px;font-size:11px;height:12px"><span style="width:64px;text-align:right" class="muted">${xNum(px)}</span><span style="height:9px;width:${Math.max(2, (v / mx) * 100)}%;background:${shortB[j] ? '#D64545' : '#1F9D63'};border-radius:2px"></span></div>`); }
    host.innerHTML = `<div class="card"><h2>🔥 청산 지도 <span class="muted">(추정 · 바이낸스 ${base})</span></h2>
      <div class="grid2" style="font-size:13px"><div><b class="down">위쪽 숏 청산 몰린 곳</b>${TS.map((x) => `<div>${xNum(x.px)} <span class="muted">(+${(((x.px / p) - 1) * 100).toFixed(1)}%, 약 $${xUsd(x.v)})</span></div>`).join('') || '<div class="muted">없음</div>'}</div>
        <div><b class="up">아래쪽 롱 청산 몰린 곳</b>${TL.map((x) => `<div>${xNum(x.px)} <span class="muted">(${(((x.px / p) - 1) * 100).toFixed(1)}%, 약 $${xUsd(x.v)})</span></div>`).join('') || '<div class="muted">없음</div>'}</div></div>
      <details style="margin-top:6px"><summary class="muted" style="font-size:12px">가격대별 막대 보기(현재가 ${xNum(p)})</summary><div style="margin-top:4px">${bars.join('')}</div></details>
      <div class="muted" style="font-size:11px;margin-top:4px">최근 500시간 동안 미결제약정이 늘어난 시간마다 10·25·50·100배로 들어왔다고 가정해 청산 가격을 쌓고, 그 뒤 가격이 이미 지나간 곳은 지웠습니다. 청산이 몰린 가격대는 가격을 끌어당기기도 하지만 <b>추정치</b>입니다.</div></div>`;
  } catch (e) { if (host.isConnected) host.innerHTML = `<div class="card muted" style="font-size:12px">🔥 청산 지도: 바이낸스 선물에 ${esc(base)}가 없거나 받지 못했습니다(${esc(e.message)}).</div>`; }
}

/* ── 🐋 고래 흐름 — 바이낸스 상위 트레이더 롱 비율 + 큰 체결(최근 1000건 중 큰 주문) + 테이커 매수·매도 ── */
async function whaleCard(host, base) {
  if (!host) return;
  host.innerHTML = '<div class="card"><h2>🐋 고래 흐름</h2><div class="muted">받는 중…</div></div>';
  try {
    const sym = base.toUpperCase() + 'USDT';
    const [top, acc, tk, tr] = await Promise.all([
      xJson(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=24`),
      xJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=24`),
      xJson(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${sym}&period=1h&limit=24`),
      xJson(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${sym}&limit=1000`)]);
    const last = (L, k) => +L[L.length - 1][k], first = (L, k) => +L[0][k];
    const topL = last(top, 'longAccount') * 100, topL0 = first(top, 'longAccount') * 100, allL = last(acc, 'longAccount') * 100;
    const tb = tk.reduce((a, x) => a + +x.buyVol, 0), ts = tk.reduce((a, x) => a + +x.sellVol, 0);
    const notional = tr.map((x) => ({ usd: +x.p * +x.q, buy: !x.m })), sorted = notional.map((x) => x.usd).sort((a, b) => b - a), cut = Math.max(sorted[Math.floor(sorted.length * 0.02)] || 0, 50000);
    const big = notional.filter((x) => x.usd >= cut), bb = big.filter((x) => x.buy).reduce((a, x) => a + x.usd, 0), bs = big.filter((x) => !x.buy).reduce((a, x) => a + x.usd, 0);
    const gap = topL - allL;
    if (!host.isConnected) return;
    host.innerHTML = `<div class="card"><h2>🐋 고래 흐름 <span class="muted">(바이낸스 ${base} 선물)</span></h2>
      <div class="grid2" style="font-size:14px">
        <div>상위 트레이더 롱 비율<br><b>${topL.toFixed(1)}%</b> <span class="muted">(24시간 전 ${topL0.toFixed(1)}%)</span></div>
        <div>전체 계정 롱 비율<br><b>${allL.toFixed(1)}%</b></div>
        <div>큰 체결(최근 1000건 중 $${xUsd(cut)} 이상)<br><b class="up">매수 $${xUsd(bb)}</b> · <b class="down">매도 $${xUsd(bs)}</b></div>
        <div>24시간 시장가 매수÷매도<br><b class="${tb >= ts ? 'up' : 'down'}">${(tb / ts).toFixed(2)}</b></div></div>
      <div style="font-size:13px;margin-top:6px">${gap >= 5 ? '🟢 고래(상위 트레이더)가 개인보다 롱 쪽으로 더 실림' : gap <= -5 ? '🟠 고래가 개인보다 숏 쪽 — 개인만 롱이 많으면 하락 때 청산 위험' : '🟡 고래와 개인 방향이 비슷함'}${bb > bs * 1.5 ? ' · 큰 주문은 사는 쪽이 우세' : bs > bb * 1.5 ? ' · 큰 주문은 파는 쪽이 우세' : ''}</div>
      <div class="muted" style="font-size:11px;margin-top:4px">거래소 입출금(지갑 이동)은 유료 온체인 데이터가 필요해 넣지 않았고, 대신 거래소 안의 큰 체결과 상위 트레이더 포지션으로 고래 방향을 봅니다 · 공부용</div></div>`;
  } catch (e) { if (host.isConnected) host.innerHTML = `<div class="card muted" style="font-size:12px">🐋 고래 흐름: 바이낸스 선물에 ${esc(base)}가 없거나 받지 못했습니다(${esc(e.message)}).</div>`; }
}

/* ── 🏦 코인 현물 ETF 입출금(알림 스크립트 v18 + SoSoValue 무료 키) ── */
async function etfCard(host) {
  if (!host) return;
  if (!(await relayOn())) { host.innerHTML = '<div class="card muted" style="font-size:12px">🏦 비트코인·이더리움 ETF 입출금: 알림 스크립트를 연결하면 볼 수 있습니다.</div>'; return; }
  host.innerHTML = '<div class="card"><h2>🏦 비트코인·이더리움 현물 ETF 입출금</h2><div class="muted">받는 중…</div></div>';
  let d; try { const h = await KV.get('etfFlow', null); d = h && Date.now() - h.at < 60 * 60e3 ? h.data : await relay('etf'); if (d.ok) KV.set('etfFlow', { at: Date.now(), data: d }).catch(() => {}); } catch (e) { d = { ok: false, error: e.message }; }
  if (!host.isConnected) return;
  if (!d.ok) { host.innerHTML = `<div class="card"><h2>🏦 코인 현물 ETF 입출금</h2><div class="muted" style="font-size:13px">${d.needKey ? 'SoSoValue 무료 API 키가 필요합니다: sosovalue.com 가입 → API 키 발급 → 구글 Apps Script 프로젝트 설정 → 스크립트 속성에 <b>SOSO_API_KEY</b>로 직접 넣기(키는 앱에 넣지 않음).' : esc(d.error || '받지 못했습니다')}</div></div>`; return; }
  const tbl = (L, nm) => { const mx = Math.max(...L.slice(0, 10).map((x) => Math.abs(x.net)), 1), s5 = L.slice(0, 5).reduce((a, x) => a + x.net, 0); return `<h4>${nm} <span class="${s5 >= 0 ? 'up' : 'down'}" style="font-size:13px">최근 5일 ${s5 >= 0 ? '+' : ''}$${xUsd(s5)}</span></h4>${L.slice(0, 10).map((x) => `<div style="display:flex;align-items:center;gap:6px;font-size:12px;height:16px"><span style="width:44px" class="muted">${String(x.date).slice(5)}</span><span style="height:10px;width:${Math.max(2, (Math.abs(x.net) / mx) * 60)}%;background:${x.net >= 0 ? '#1F9D63' : '#D64545'};border-radius:2px"></span><span>${x.net >= 0 ? '+' : ''}$${xUsd(x.net)}</span></div>`).join('')}`; };
  host.innerHTML = `<div class="card"><h2>🏦 코인 현물 ETF 입출금 <span class="muted">(미국, 하루 순유입)</span></h2>${tbl(d.btc || [], '비트코인')}${tbl(d.eth || [], '이더리움')}
    <div class="muted" style="font-size:11px;margin-top:4px">초록 = 기관 자금 유입(매수 압력), 빨강 = 유출 · 출처 SoSoValue · 하루 한 번 갱신(미국 장 마감 뒤)</div></div>`;
}

/* ── 📅 경제 일정(이번 주 중요 발표 — 알림 스크립트 v18) ── */
async function econCard(host) {
  if (!host) return;
  if (!(await relayOn())) { host.innerHTML = '<div class="card muted" style="font-size:12px">📅 경제 일정: 알림 스크립트를 연결하면 이번 주 FOMC·CPI·고용 등 발표 시간이 나옵니다.</div>'; return; }
  host.innerHTML = '<div class="card"><h2>📅 이번 주 경제 일정</h2><div class="muted">받는 중…</div></div>';
  let d; try { const h = await KV.get('econW', null); d = h && Date.now() - h.at < 60 * 60e3 ? h.data : await relay('econ'); if (d.ok) KV.set('econW', { at: Date.now(), data: d }).catch(() => {}); } catch (e) { d = { ok: false, error: e.message }; }
  if (!host.isConnected) return;
  if (!d.ok) { host.innerHTML = `<div class="card muted" style="font-size:12px">📅 경제 일정: ${esc(d.error || '받지 못했습니다')}${/모르는|action/.test(d.error || '') ? ' — 알림 스크립트를 v18로 바꿔야 합니다' : ''}</div>`; return; }
  const now = Date.now(), fl = { USD: '🇺🇸', KRW: '🇰🇷', CNY: '🇨🇳', EUR: '🇪🇺', JPY: '🇯🇵' };
  const next = d.items.find((x) => x.t > now && x.impact === 'High');
  host.innerHTML = `<div class="card"><h2>📅 이번 주 경제 일정 <span class="muted">(중요 발표, 한국 시간)</span></h2>
    ${next ? `<div class="warnlist" style="font-size:13px">⏰ 다음 큰 발표: <b>${fl[next.country] || ''} ${esc(next.ko || next.title)}</b> — ${new Date(next.t).toLocaleString('ko-KR', { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${Math.max(0, Math.round((next.t - now) / 3600e3))}시간 뒤). 발표 30분 전후는 변동이 커서 새 진입을 피하는 사람이 많습니다.</div>` : ''}
    ${d.items.map((x) => `<div class="row spread" style="font-size:13px;padding:3px 0;border-bottom:1px solid var(--line);${x.t < now ? 'opacity:.5' : ''}"><span>${x.impact === 'High' ? '🔴' : '🟠'} ${fl[x.country] || x.country} ${esc(x.ko || x.title)}${x.ko ? ` <span class="muted" style="font-size:11px">${esc(x.title)}</span>` : ''}</span><span class="muted" style="font-size:12px;white-space:nowrap">${new Date(x.t).toLocaleString('ko-KR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${x.forecast ? ` · 예상 ${esc(x.forecast)}` : ''}</span></div>`).join('') || '<div class="muted">이번 주 중요 발표 없음</div>'}
    <div class="muted" style="font-size:11px;margin-top:4px">🔴 큰 영향 🟠 중간(미국) · 출처 Forex Factory 공개 일정 · 1시간마다 갱신</div></div>`;
}

/* ── 💥 대량 청산 알림 켜기(알림 스크립트 v18) ── */
async function liqAlertCard(host) {
  if (!host) return;
  if (!(await relayOn())) { host.innerHTML = ''; return; }
  let st = { enabled: false, usd: 3e7 }; try { const d = await relay('ping'); if (d.liq) st = d.liq; } catch { /* 기본값 */ }
  host.innerHTML = `<div class="card"><div class="row spread"><b>💥 대량 청산 디스코드 알림</b><label class="row" style="margin:0"><input type="checkbox" id="lqOn"${st.enabled ? ' checked' : ''} style="width:22px;min-height:22px"> 켜기</label></div>
    <div class="row" style="gap:6px;margin-top:6px;align-items:center"><span style="font-size:13px">기준(최근 10분 합계)</span><select id="lqUsd">${[1e7, 3e7, 5e7, 1e8].map((v) => `<option value="${v}"${v === st.usd ? ' selected' : ''}>$${v / 1e6}M</option>`).join('')}</select></div>
    <div class="muted" style="font-size:11px;margin-top:4px">OKX 비트코인·이더리움 청산이 10분에 기준을 넘으면 알림(같은 코인 1시간에 한 번). 롱 청산이 몰리면 급락 끝자락, 숏 청산이 몰리면 급등 끝자락인 경우가 많습니다.</div></div>`;
  const save = async () => { try { await relay('saveLiq', { enabled: host.querySelector('#lqOn').checked, usd: +host.querySelector('#lqUsd').value }); toast && toast('저장했습니다'); } catch (e) { alert('저장 실패: ' + e.message); } };
  host.querySelector('#lqOn').onchange = save; host.querySelector('#lqUsd').onchange = save;
}
