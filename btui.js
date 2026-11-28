/* AI 마켓 스캐너 — 🧪 백테스트 화면 (거래소 공개 봉으로 과거 가상 체결 · 실제 주문 없음)
 * 데이터: OKX(최근 300봉 + 과거 페이지)·바이낸스(최대 1500봉)·바이비트(1000봉씩 이어 받기)·게이트(최대 2000봉) 무기한 선물. 끝난 봉만.
 * 거래소 무기한 선물 가격이며 미국 상장 ETF 실제 가격이 아니다(24시간 거래, 펀딩비 있음). 둘을 섞지 않는다.
 * 상품 정보(계약 크기·최소 수량·호가 단위)를 거래소에서 확인하고, 확인이 안 되는 상품은 실행하지 않는다.
 */
'use strict';

const BT_PRODUCTS = [
  { id: 'QQQ', name: 'QQQ 나스닥100' }, { id: 'TQQQ', name: 'TQQQ 나스닥100 3배' }, { id: 'SQQQ', name: 'SQQQ 나스닥100 인버스 3배' },
  { id: 'SOXL', name: 'SOXL 반도체 3배' }, { id: 'NVDA', name: 'NVDA 엔비디아' }, { id: 'SKHYNIX', name: 'SKHYNIX SK하이닉스' }, { id: 'SNDK', name: 'SNDK 샌디스크' },
  { id: 'BTC', name: 'BTC 비트코인' }, { id: 'ETH', name: 'ETH 이더리움' }, { id: 'SOL', name: 'SOL 솔라나' },
];
const BT_TF = {
  '15m': { label: '15분봉', ms: 15 * 60e3, okx: '15m', bn: '15m', hi: '1H' }, '30m': { label: '30분봉', ms: 30 * 60e3, okx: '30m', bn: '30m', hi: '4H' },
  '1H': { label: '1시간봉', ms: 3600e3, okx: '1H', bn: '1h', hi: '4H' }, '4H': { label: '4시간봉', ms: 4 * 3600e3, okx: '4H', bn: '4h', hi: '1D' },
  '1D': { label: '일봉', ms: 86400e3, okx: '1Dutc', bn: '1d', hi: null },
};
const BT_EX = { okx: 'OKX', bn: '바이낸스', by: '바이비트', gate: '게이트', krx: '🇰🇷 국내주식(네이버 일봉)' };
// 거래소별 수수료(한쪽, %, 일반 등급 공개 요율 기준 — 등급·쿠폰에 따라 다름)
// 국내주식: 수수료 0.015%(한쪽) + 매도 때 세금 0.20% → 한쪽 평균 0.115%로 계산(펀딩비 없음)
const BT_FEES = { okx: { taker: 0.05, maker: 0.02 }, bn: { taker: 0.05, maker: 0.02 }, by: { taker: 0.055, maker: 0.02 }, gate: { taker: 0.05, maker: 0.02 }, krx: { taker: 0.115, maker: 0.115 } };
// '다른 종목' 입력값 → 거래소 기호(국내는 6자리 코드)
const btNorm = (ex, v) => { v = String(v || '').trim(); if (ex === 'krx') { const m = v.match(/\d{6}/); return m ? m[0] : ''; } return v.toUpperCase().split(/[\s·]/)[0].replace(/[-_]?USDT(-SWAP)?$/, '').replace(/^KRW-/, '').replace(/[^A-Z0-9]/g, ''); };
const BT_BY_IV = { '15m': '15', '30m': '30', '1H': '60', '4H': '240', '1D': 'D' }, BT_GATE_IV = { '15m': '15m', '30m': '30m', '1H': '1h', '4H': '4h', '1D': '1d' };
// '살펴볼 기간': 봉 개수를 날짜로 바꿔 보여 줌
const btSpan = (n, tf) => { const d = (n * BT_TF[tf].ms) / 86400e3; return d >= 60 ? `약 ${(d / 30).toFixed(d >= 300 ? 0 : 1)}개월` : d >= 2 ? `약 ${Math.round(d)}일` : `약 ${Math.round(d * 24)}시간`; };
const BT_BARS = [300, 500, 1000, 1500, 2000];
const BT_STRATS = () => Object.keys(STRATS.LIST).filter((k) => /^[A-K]$/.test(k));

// 상품 정보(거래소에서 직접) — 없으면 null
async function btMeta(ex, base) {
  const key = `btmeta:${ex}:${base}`, hit = await KV.get(key, null);
  if (hit && Date.now() - hit.at < 86400e3) return hit.data;
  let data = null;
  if (ex === 'krx') { // 국내주식: 네이버(스크립트 v15 중계)로 이름·지금가 확인
    if (!/^\d{6}$/.test(base)) return null;
    try { const d = await relay('naver', { kind: 'info', code: base }); if (d.name) return { sym: `${base} ${d.name}`, kind: '국내주식 현물(네이버 일봉 — 공식 API 아님)', settle: 'KRW', tickSz: '호가 단위 가격대별' }; } catch { return null; }
    return null;
  }
  if (ex === 'okx') {
    const r = (await okxGet(`/public/instruments?instType=SWAP&instId=${encodeURIComponent(base)}-USDT-SWAP`))[0];
    if (r && r.state === 'live') data = { sym: r.instId, kind: r.instCategory === '3' ? '주식·ETF 무기한 선물(OKX 분류 3)' : '코인 무기한 선물', ctVal: r.ctVal + ' ' + r.ctValCcy, ctMult: r.ctMult, lotSz: r.lotSz, minSz: r.minSz, tickSz: r.tickSz, ctType: r.ctType, settle: r.settleCcy, listed: +r.listTime || null };
  } else if (ex === 'by') {
    const r = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(base)}USDT`).then((x) => x.json()).catch(() => null);
    const it = r && r.retCode === 0 && r.result.list && r.result.list[0];
    if (it && it.status === 'Trading') data = { sym: it.symbol, kind: (it.contractType || '') + ' 무기한', lotSz: it.lotSizeFilter.qtyStep, minSz: it.lotSizeFilter.minOrderQty, tickSz: it.priceFilter.tickSize, settle: it.settleCoin, listed: +it.launchTime || null };
  } else if (ex === 'gate') {
    const it = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(base)}_USDT`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (it && it.name && !it.in_delisting) data = { sym: it.name, kind: '무기한 선물(USDT)', ctVal: it.quanto_multiplier + ' ' + base, lotSz: '1계약', minSz: it.order_size_min, tickSz: it.order_price_round, settle: 'USDT', listed: it.create_time ? it.create_time * 1000 : null };
  } else {
    let ei = await KV.get('btBnInfo', null);
    if (!ei || Date.now() - ei.at > 86400e3) { ei = { at: Date.now(), data: (await binance('/exchangeInfo')).symbols.map((s) => ({ symbol: s.symbol, status: s.status, contractType: s.contractType, underlyingType: s.underlyingType, quoteAsset: s.quoteAsset, onboardDate: s.onboardDate, filters: s.filters })) }; KV.set('btBnInfo', ei).catch(() => {}); }
    const s = ei.data.find((x) => x.symbol === base + 'USDT');
    if (s && s.status === 'TRADING') { const F = (t) => s.filters.find((x) => x.filterType === t) || {}; data = { sym: s.symbol, kind: `${s.contractType}/${s.underlyingType}`, lotSz: F('LOT_SIZE').stepSize, minSz: F('LOT_SIZE').minQty, tickSz: F('PRICE_FILTER').tickSize, minNotional: F('MIN_NOTIONAL').notional, settle: s.quoteAsset, listed: s.onboardDate || null }; }
  }
  KV.set(key, { at: Date.now(), data }).catch(() => {});
  return data;
}
// 봉 받기(끝난 봉만, 오래된 것부터)
async function btCandles(ex, base, tf, want, onProg) {
  const f = BT_TF[tf];
  if (ex === 'krx') {
    if (tf !== '1D') throw new Error('국내주식은 일봉만 됩니다(봉을 일봉으로 바꾸세요)');
    const d = await relay('naver', { kind: 'candles', code: base, days: Math.min(1500, Math.ceil(want * 1.5) + 30) });
    return (d.candles || []).slice(-want);
  }
  if (ex === 'by') { // 1000봉씩, 최신부터 거꾸로 이어 받기
    let out = [], end = '';
    while (out.length < want) {
      const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(base)}USDT&interval=${BT_BY_IV[tf]}&limit=1000${end ? '&end=' + end : ''}`).then((x) => x.json());
      if (r.retCode !== 0) throw new Error('바이비트 응답 오류: ' + (r.retMsg || r.retCode));
      const L = r.result.list || []; if (!L.length) break;
      out = out.concat(L); end = String(+L[L.length - 1][0] - 1);
      if (onProg) onProg(out.length);
      if (L.length < 1000) break; await sleep(150);
    }
    const seen = new Set();
    return out.filter((k) => +k[0] + f.ms <= Date.now() && !seen.has(k[0]) && seen.add(k[0])).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).sort((a, b) => a.t - b.t).slice(-want);
  }
  if (ex === 'gate') {
    const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(base)}_USDT&interval=${BT_GATE_IV[tf]}&limit=${Math.min(2000, want + 1)}`).then((x) => x.json());
    if (!Array.isArray(r)) throw new Error('게이트 응답 오류: ' + ((r && (r.message || r.label)) || ''));
    return r.filter((k) => k.t * 1000 + f.ms <= Date.now()).map((k) => ({ t: k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v })).slice(-want);
  }
  if (ex === 'bn') {
    const r = await binance(`/klines?symbol=${encodeURIComponent(base)}USDT&interval=${f.bn}&limit=${Math.min(1500, want)}`);
    return r.filter((k) => +k[6] < Date.now()).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }
  const id = `${base}-USDT-SWAP`;
  let rows = await okxGet(`/market/candles?instId=${id}&bar=${f.okx}&limit=300`);
  let after = rows.length ? rows[rows.length - 1][0] : '';
  while (rows.length < want && after) {
    await sleep(150);
    const r = await okxGet(`/market/history-candles?instId=${id}&bar=${f.okx}&limit=100&after=${after}`);
    if (!r.length) break;
    rows = rows.concat(r); after = r[r.length - 1][0];
    if (onProg) onProg(rows.length);
  }
  return rows.filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse().slice(-want);
}

const btPct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '-' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
const btNum = (x, d = 2) => (x == null ? '-' : x === Infinity ? '∞' : Number.isFinite(x) ? x.toFixed(d) : '-');
let BT_LAST = null; // { cs, hiCs, p, ctx } — 워크포워드는 방금 받은 같은 데이터로
const btT = (t) => new Date(t).toLocaleString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function viewBacktest() {
  setTitle('🧪 백테스트');
  const watchOpts = (await getWatch()).map((w) => (w.cat === 'kr' ? { v: 'kr:' + w.sym, t: '🇰🇷 ' + w.name + ' ' + w.sym } : w.cat === 'cfut' ? { v: w.sym.replace(/USDT$/, ''), t: '⚡ ' + w.name } : w.cat === 'coin' ? { v: w.sym.replace(/^KRW-/, ''), t: '🪙 ' + w.name + ' (무기한 선물로)' } : w.cat === 'us' ? { v: w.sym, t: '🇺🇸 ' + w.name + ' (무기한 선물로)' } : null)).filter(Boolean).filter((w, i, a) => a.findIndex((x) => x.v === w.v) === i);
  const P = Object.assign({ ex: 'okx', base: 'QQQ', tf: '1H', bars: 1000, strat: 'B', capital: 1000, riskPct: 1, lev: 1, fee: 0.05, feeKind: 'taker', slip: 0.05, fund8h: 0.01, stopAtr: 2, rr: 2, trailAtr: 0, timeBars: 0, half: false }, await KV.get('btPrefs', {}));
  const runs = await KV.get('bt:runs', []);
  const opt = (v, t, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${t}</option>`;
  const num = (id, label, v, step, hint) => `<div><label for="${id}">${label}</label><input id="${id}" type="number" inputmode="decimal" step="${step}" value="${v}"><div class="muted" style="font-size:11px">${hint}</div></div>`;
  view().innerHTML = `<div class="card" style="margin-top:0;border:2px solid #7A4CD1;background:rgba(122,76,209,.08)"><b>🧪 백테스트 · 과거 데이터로 가상 체결 · 실제 주문 없음</b>
      <div class="muted" style="font-size:12px;margin-top:4px">과거 성과는 미래 수익을 보장하지 않습니다. 전략 A~F는 검증해 보는 예시일 뿐 수익이 입증된 규칙이 아닙니다(공부용).</div></div>
    <div class="card"><h2>설정</h2>
      <div class="grid2">
        <div><label for="bx">거래소</label><select id="bx">${Object.entries(BT_EX).map(([k, v]) => opt(k, v, P.ex)).join('')}</select></div>
        <div><label for="bb">상품</label><select id="bb"><optgroup label="기본 상품(무기한 선물)">${BT_PRODUCTS.map((p) => opt(p.id, p.name, P.base)).join('')}</optgroup>${watchOpts.length ? `<optgroup label="⭐ 내 관심 종목">${watchOpts.map((w) => opt(w.v, w.t, P.ex === 'krx' ? 'kr:' + P.base : P.base)).join('')}</optgroup>` : ''}${BT_PRODUCTS.some((p) => p.id === P.base) || watchOpts.some((w) => w.v === P.base || w.v === 'kr:' + P.base) ? '' : opt(P.base, P.base + ' (직접 입력)', P.base)}</select></div>
        <div style="grid-column:1/-1"><label for="bq">다른 종목 찾기 <span class="muted" style="font-size:11px">(코드나 이름 하나만 — 예: PLTR, 도지, 005930, 삼성전)</span></label><input id="bq" list="bql" autocomplete="off" placeholder="비워 두면 위 상품"><datalist id="bql"></datalist><div class="muted" id="bqm" style="font-size:11px"></div></div>
        <div><label for="btf">봉</label><select id="btf">${Object.entries(BT_TF).map(([k, v]) => opt(k, v.label, P.tf)).join('')}</select></div>
        <div><label for="bn">살펴볼 기간</label><select id="bn"></select><div class="muted" style="font-size:11px">고른 봉으로 거슬러 올라가는 기간(괄호는 봉 수)</div></div>
      </div>
      <label for="bs">전략</label><select id="bs">${BT_STRATS().map((k) => opt(k, STRATS.LIST[k].name, P.strat)).join('')}</select>
      <div class="muted" id="bsd" style="font-size:12px;margin-top:4px"></div>
      <details style="margin-top:8px"><summary><b>비용·위험 설정</b> <span class="muted" style="font-size:12px">(가정값 — 결과에 함께 표시)</span></summary><div class="grid2">
        ${num('bcap', '초기 자본(USDT)', P.capital, 100, '가상 자금')}
        ${num('brisk', '거래당 위험(자산의 %)', P.riskPct, 0.5, '손절에 닿으면 잃는 비율')}
        ${num('blev', '최대 배율', P.lev, 1, '명목가 ≤ 자산 × 배율')}
        <div><label for="bfk">수수료 기준</label><select id="bfk">${opt('taker', '시장가(테이커)', P.feeKind)}${opt('maker', '지정가(메이커)', P.feeKind)}${opt('custom', '직접 입력', P.feeKind)}</select><div class="muted" style="font-size:11px">거래소를 바꾸면 그 거래소 요율로 채움</div></div>
        ${num('bfee', '수수료(한쪽, %)', P.fee, 0.01, '일반 등급 공개 요율 기준')}
        ${num('bslip', '슬리피지(한쪽, %)', P.slip, 0.01, '체결가가 불리하게 밀리는 정도')}
        ${num('bfund', '펀딩비(8시간마다, %)', P.fund8h, 0.005, '롱이 내는 가정값. 실제는 매번 달라짐')}
        ${num('bstop', '손절(ATR 배수)', P.stopAtr, 0.5, '진입가 − ATR × 배수')}
        ${num('brr', '목표(손익비 R)', P.rr, 0.5, '진입가 + 위험 × R')}
        ${num('btrail', '트레일링 손절(ATR 배수, 0=끔)', P.trailAtr, 0.5, '오른 만큼 손절을 따라 올림')}
        ${num('btime', '시간 손절(봉 수, 0=끔)', P.timeBars, 1, '이만큼 들고 있으면 정리')}
        <div><label class="row" style="margin-top:22px;gap:6px"><input type="checkbox" id="bhalf"${P.half ? ' checked' : ''}> 1R 절반 익절 + 본전 손절</label><div class="muted" style="font-size:11px">1R에 절반 팔고 남은 절반 손절을 진입가로</div></div></div></details>
      <div class="row wrap" style="gap:6px;margin-top:10px"><button class="btn primary" id="brun" type="button">▶ 백테스트 실행</button><button class="btn" id="ball" type="button">전략 A~K 전부 비교 + 순위</button></div>
      <div id="bmsg" class="muted" style="font-size:13px;margin-top:6px"></div></div>
    <div id="bout"></div>
    <div class="card"><details><summary><b>체결·비용 규칙</b></summary><ul class="steps" style="font-size:13px;margin-top:6px">
      <li>신호는 봉이 <b>끝난 뒤</b> 종가로 정하고, 진입·신호 청산은 <b>다음 봉 시가</b>에 체결합니다(+슬리피지). 끝나지 않은 봉은 쓰지 않습니다.</li>
      <li>손절·목표는 진입한 봉부터 확인합니다. 한 봉에서 둘 다 닿으면 순서를 알 수 없어 <b>손절로 봅니다</b>(보수적). 시가가 손절가 아래로 갭이면 손절가가 아닌 <b>시가</b>에 체결합니다.</li>
      <li>상위 봉(전략 F)은 그 봉이 끝난 뒤부터만 씁니다. 지표가 생기기 전 앞쪽 60봉은 신호를 내지 않습니다.</li>
      <li>수수료는 진입·청산 명목가에 각각, 펀딩비는 UTC 0·8·16시(한국 9·17·1시)를 지날 때마다 명목가 × 가정 비율. <b>실제 과거 펀딩비가 아닌 가정값</b>입니다.</li>
      <li>트레일링 손절은 봉이 끝난 뒤 최고 종가 − ATR × 배수로 <b>다음 봉부터</b> 올립니다(내리지 않음). 시간 손절은 정한 봉 수를 채운 다음 봉 시가에 정리합니다. 1R 절반 익절은 1R 가격에 절반을 팔고(거래 내역에 따로 한 줄), 남은 절반의 손절을 진입가로 옮깁니다.</li>
      <li>아직 하지 않은 것: 계약 수량·호가 단위 반올림, 숏(매도) 진입, 지정가·부분 체결, 실제 과거 펀딩비. 결과는 이 가정에 따라 달라집니다.</li>
      <li>기간은 시간순으로 개발 60% · 검증 20% · 테스트 20%로 나눠 각각 보여 줍니다. 테스트 구간 결과로 설정을 맞추면 과최적화가 됩니다.</li></ul></details></div>
    ${runs.length ? `<div class="card"><h2>지난 실행 <span class="muted">(${runs.length})</span></h2>${runs.slice(0, 10).map((r, i) => `<div class="logrow row spread" style="gap:6px"><span>${esc(r.when)} · ${esc(r.label)} · <b class="${r.net > 0 ? 'up' : 'down'}">${btPct(r.net)}</b> · MDD ${btPct(r.mdd)} · ${r.n}번 <span class="muted">(전략 v${esc(r.ver)}${r.ver !== STRATS.VERSION ? ' — 지금 버전과 다름' : ''})</span></span>${r.opt ? `<button class="btn small" type="button" data-rerun="${i}">다시 실행</button>` : ''}</div>`).join('')}<div class="muted" style="font-size:11px;margin-top:4px">다시 실행은 같은 설정으로 지금 데이터를 새로 받아 돌립니다(기간이 바뀌어 결과가 다를 수 있음).</div></div>` : ''}
    <div class="disc">공부용 · 실제 주문 없음 · <a href="#/learn">📘 검토 구간 근거 설명</a> · v${APP_VERSION}</div>`;
  const showDesc = () => { $('#bsd').textContent = STRATS.LIST[$('#bs').value].desc; };
  const fillBars = (keep) => { const tf = $('#btf').value, cur = keep || +$('#bn').value || P.bars; $('#bn').innerHTML = BT_BARS.map((n) => opt(n, `최근 ${btSpan(n, tf)} (${n}봉)`, cur)).join(''); if (!BT_BARS.includes(cur)) $('#bn').value = '1000'; };
  fillBars(P.bars); $('#btf').addEventListener('change', () => fillBars());
  const fillFee = () => { const k = $('#bfk').value, f = BT_FEES[$('#bx').value]; if (k !== 'custom' && f) $('#bfee').value = f[k]; };
  $('#bfk').onchange = fillFee; $('#bx').addEventListener('change', fillFee);
  const krMode = () => { if ($('#bx').value === 'krx') { $('#btf').value = '1D'; fillBars(); $('#bfund').value = 0; $('#blev').value = 1; } };
  $('#bx').addEventListener('change', krMode);
  $('#bb').addEventListener('change', () => { const v = $('#bb').value; if (v.startsWith('kr:')) { $('#bx').value = 'krx'; fillFee(); krMode(); } else if ($('#bx').value === 'krx') { $('#bx').value = 'okx'; fillFee(); } $('#bq').value = ''; });
  let bqT;
  $('#bq').addEventListener('input', () => { clearTimeout(bqT); const q = $('#bq').value.trim(); if (q.length < 1) { $('#bqm').textContent = ''; return; } bqT = setTimeout(async () => {
    try {
      const kr = $('#bx').value === 'krx' || /^\d{2,6}$/.test(q) || (/[가-힣]/.test(q) && !(await searchAssets('cfut', q).catch(() => [])).length);
      const L = kr ? await searchAssets('kr', q) : await searchAssets('cfut', q);
      if (kr && $('#bx').value !== 'krx') { $('#bx').value = 'krx'; fillFee(); krMode(); }
      $('#bql').innerHTML = L.slice(0, 20).map((x) => `<option value="${esc(kr ? x.sym + ' ' + x.name : x.sym.replace(/USDT$/, ''))}">${esc(x.name)}</option>`).join('');
      $('#bqm').textContent = L.length ? `${L.length}개 찾음 — 목록에서 고르거나 그대로 실행` : '찾은 종목이 없습니다(정확한 기호·코드를 넣어 보세요)';
    } catch (e) { $('#bqm').textContent = e.message; }
  }, 400); });
  krMode();
  $('#bfee').addEventListener('input', () => { $('#bfk').value = 'custom'; });
  $('#bs').onchange = showDesc; showDesc();
  const pickBase = () => { const q = btNorm($('#bx').value, $('#bq').value); if (q) return q; const v = $('#bb').value; return v.startsWith('kr:') ? v.slice(3) : v; };
  const read = () => ({ ex: $('#bx').value, base: pickBase(), tf: $('#btf').value, bars: +$('#bn').value, strat: $('#bs').value, capital: +$('#bcap').value, riskPct: +$('#brisk').value, lev: +$('#blev').value, fee: +$('#bfee').value, feeKind: $('#bfk').value, slip: +$('#bslip').value, fund8h: +$('#bfund').value, stopAtr: +$('#bstop').value, rr: +$('#brr').value, trailAtr: +$('#btrail').value || 0, timeBars: Math.max(0, Math.round(+$('#btime').value || 0)), half: $('#bhalf').checked });
  const go = async (all) => {
    const p = read(), msg = (t) => { $('#bmsg').innerHTML = t; };
    if (!(p.capital > 0 && p.riskPct > 0 && p.lev > 0 && p.stopAtr > 0 && p.rr > 0 && p.fee >= 0 && p.slip >= 0 && p.fund8h >= 0)) { msg('<span style="color:var(--red)">설정 값을 확인하세요(0보다 커야 하는 값이 있음)</span>'); return; }
    await KV.set('btPrefs', p);
    $('#brun').disabled = $('#ball').disabled = true;
    try {
      msg('상품 정보 확인 중…');
      const meta = await btMeta(p.ex, p.base);
      if (!meta) { msg(`<span style="color:var(--red)">${p.ex === 'krx' ? `국내주식 ${esc(p.base)}을(를) 네이버에서 확인하지 못했습니다(6자리 코드인지, 설정에서 알림 스크립트 v15 이상이 연결됐는지 확인)` : `${esc(BT_EX[p.ex])}에 ${esc(p.base)} USDT 무기한 선물이 없거나 거래 중이 아니라 실행하지 않습니다 — 다른 거래소를 골라 보세요`}.</span>`); return; }
      msg(`${esc(BT_EX[p.ex])} ${esc(p.base)} ${BT_TF[p.tf].label} 최근 ${btSpan(p.bars, p.tf)} 받는 중…`);
      const fetched = new Date();
      const cs = await btCandles(p.ex, p.base, p.tf, p.bars, (k) => msg(`봉 받는 중… ${k}개`));
      const hiTf = BT_TF[p.tf].hi;
      let hiCs = null;
      const keys = all ? BT_STRATS() : [p.strat];
      if (keys.includes('F') && hiTf) { msg('상위 봉 받는 중…'); hiCs = await btCandles(p.ex, p.base, hiTf, Math.min(1500, Math.ceil((p.bars * BT_TF[p.tf].ms) / BT_TF[hiTf].ms) + 120)); }
      const ctx = { meta, fetched, src: `${BT_EX[p.ex]} ${meta.sym} ${BT_TF[p.tf].label}` };
      const res = [];
      for (const k of keys) {
        if (STRATS.LIST[k].needsHigher && !hiCs) { res.push({ strat: k, name: STRATS.LIST[k].name, error: '일봉은 상위 봉이 없어 전략 F를 쓸 수 없습니다' }); continue; }
        try { const r = BT.run(cs, { ...p, strat: k, tfMs: BT_TF[p.tf].ms, hiCs, hiMs: hiTf ? BT_TF[hiTf].ms : null }); r.regimes = BT.byRegime(r, cs); res.push(r); } catch (e) { res.push({ strat: k, name: STRATS.LIST[k].name, error: e.message }); }
      }
      msg('');
      if (all) { msg('순위 계산 중(워크포워드 검증)…'); await sleep(30); res.forEach((r) => { if (r.error) return; try { r.wf = BT.walkForward(cs, { ...p, strat: r.strat, tfMs: BT_TF[p.tf].ms, hiCs, hiMs: hiTf ? BT_TF[hiTf].ms : null }); } catch (e) { r.wfErr = e.message; } }); msg(''); }
      $('#bout').innerHTML = all ? btCompare(res, ctx, p) : btReport(res[0], ctx, p);
      const cv = $('#bcv'); if (cv && res[0] && !res[0].error) btDraw(cv, res[0]);
      BT_LAST = { cs, hiCs, p, ctx, hiTf };
      const wb = $('#bwf'); if (wb) wb.onclick = () => btRunWf(p.strat);
      // 재현용 기록(설정·전략 버전·데이터 범위)
      const ok = res.filter((r) => !r.error), rr = await KV.get('bt:runs', []);
      ok.forEach((r) => rr.unshift({ when: btT(Date.now()), label: `${p.base} ${BT_TF[p.tf].label} ${BT_EX[p.ex]} · ${r.name}`, net: r.stats.netPct, mdd: r.stats.mdd, n: r.stats.n, ver: r.version, opt: { ...p, strat: r.strat }, from: r.from, to: r.to }));
      await KV.set('bt:runs', rr.slice(0, 30));
    } catch (e) { msg(`<span style="color:var(--red)">${esc(e.message)}</span>`); }
    finally { $('#brun').disabled = $('#ball').disabled = false; }
  };
  $('#brun').onclick = () => go(false);
  view().querySelectorAll('[data-rerun]').forEach((b) => { b.onclick = () => { const o = runs[+b.dataset.rerun].opt; const set = (id, v) => { const el = $('#' + id); if (el && v != null) { if (el.tagName === 'SELECT' && ![...el.options].some((x) => x.value === String(v))) el.add(new Option(String(v), String(v))); el.value = String(v); } }; set('bx', o.ex); set('bb', o.ex === 'krx' ? 'kr:' + o.base : o.base); if (![...$('#bb').options].some((x) => x.value === $('#bb').value)) $('#bq').value = o.base; set('btf', o.tf); set('bn', o.bars); set('bs', o.strat); set('bcap', o.capital); set('brisk', o.riskPct); set('blev', o.lev); set('bfee', o.fee); set('bslip', o.slip); set('bfund', o.fund8h); set('bstop', o.stopAtr); set('brr', o.rr); set('btrail', o.trailAtr || 0); set('btime', o.timeBars || 0); if ($('#bhalf')) $('#bhalf').checked = !!o.half; fillBars(o.bars); showDesc(); window.scrollTo(0, 0); go(false); }; });
  $('#ball').onclick = () => go(true);
}

function btAssume(r, ctx, p) {
  const m = ctx.meta, iss = r.issues;
  return `<details style="margin-top:8px"><summary class="muted" style="font-size:13px">가정·데이터·상품 정보</summary><ul class="steps" style="font-size:12px;margin-top:4px">
    <li>데이터: ${esc(ctx.src)} · 최근 ${btSpan(r.bars, p.tf)}(봉 ${r.bars}개, 앞 ${STRATS.warmup}봉은 지표 준비) · ${btT(r.from)} ~ ${btT(r.to)} · 받은 시각 ${btT(ctx.fetched)}</li>
    <li>데이터 검사: 중복 ${iss.dup} · 비정상 봉 ${iss.bad} · 빈 구간 ${iss.gaps}곳(${iss.gapBars}봉)${iss.dup || iss.bad ? ' — 문제 봉은 빼고 계산' : ''}${iss.gaps ? ' — 빈 구간은 채우지 않음(거래 중단·점검 시간일 수 있음)' : ''}</li>
    <li>상품: ${esc(m.sym)} · ${esc(m.kind)}${m.ctVal ? ' · 1계약 = ' + esc(m.ctVal) : ''}${m.lotSz ? ' · 수량 단위 ' + esc(m.lotSz) : ''}${m.minSz ? ' · 최소 ' + esc(m.minSz) : ''}${m.tickSz ? ' · 호가 단위 ' + esc(m.tickSz) : ''}${m.minNotional ? ' · 최소 명목가 ' + esc(m.minNotional) : ''}${m.listed ? ' · 상장 ' + btT(m.listed) : ''}</li>
    <li>${p.ex === 'krx' ? '한국거래소 실제 일봉(네이버 공개 주소)입니다. 장 시간(9:00~15:30)만 거래되고 밤사이 갭이 생길 수 있습니다.' : '거래소 무기한 선물 가격입니다. 미국 상장 ETF·주식의 실제 가격이 아니며(24시간 거래·펀딩비), ETF 자체의 일일 레버리지·복리 효과와 거래소 레버리지는 다릅니다.'}</li>
    <li>비용 가정: ${p.ex === 'krx' ? `수수료 0.015% + 매도 세금 0.20%를 한쪽 평균 ${p.fee}%로 · 슬리피지 한쪽 ${p.slip}% · 펀딩비 없음(현물) · 주 단위 반올림 안 함 · 롱만` : `수수료 한쪽 ${p.fee}% · 슬리피지 한쪽 ${p.slip}% · 펀딩비 8시간마다 ${p.fund8h}%(가정, 롱이 냄) · 계약 단위 반올림 안 함 · 롱만`}</li>
    <li>위험 가정: 초기 ${p.capital} USDT · 거래당 위험 ${p.riskPct}% · 최대 배율 ${p.lev}배 · 손절 ATR×${p.stopAtr} · 목표 ${p.rr}R${p.trailAtr ? ' · 트레일링 ATR×' + p.trailAtr : ''}${p.timeBars ? ' · 시간 손절 ' + p.timeBars + '봉' : ''}${p.half ? ' · 1R 절반 익절' : ''} · 전략 버전 ${esc(r.version)}</li></ul></details>`;
}
function btReport(r, ctx, p) {
  if (r.error) return `<div class="card errbox">${esc(r.name)}: ${esc(r.error)}</div>`;
  const s = r.stats;
  const cell = (k, v, cls) => `<div>${k} <b class="${cls || ''}">${v}</b></div>`;
  return `<div class="card"><h2>${esc(r.name)} <span class="muted">${esc(p.base)} · ${BT_TF[p.tf].label}</span></h2>
      <div class="muted" style="font-size:12px">${esc(r.desc)}</div>
      <canvas id="bcv" class="chart" style="height:200px;margin-top:8px" aria-label="자산 곡선과 낙폭"></canvas>
      <div class="muted" style="font-size:11px">선: 자산(비용·미실현 포함) · 아래 붉은 면: 최고점 대비 낙폭</div>
      <div class="grid2" style="font-size:13px;margin-top:8px">
        ${cell('초기 → 최종', `${btNum(s.capital, 0)} → ${btNum(s.final, 2)}`)}${cell('순수익률(비용 뺌)', btPct(s.netPct), s.netPct > 0 ? 'up' : 'down')}
        ${cell('수수료·펀딩 빼기 전', btPct(s.grossPct))}${cell('최대 낙폭(MDD)', btPct(s.mdd), 'down')}
        ${cell('거래 수', s.n + '번')}${cell('승률', btPct(s.winRate, 1).replace('+', ''))}
        ${cell('평균 이익 / 손실', `${btNum(s.avgWin)} / ${btNum(s.avgLoss)}`)}${cell('손익비', btNum(s.payoff))}
        ${cell('Profit Factor', btNum(s.pf))}${cell('평균 R', btNum(s.avgR))}
        ${cell('Sharpe(연환산)', btNum(s.sharpe))}${cell('Sortino(연환산)', btNum(s.sortino))}
        ${cell('평균 보유', s.avgBars != null ? `${s.avgBars.toFixed(1)}봉` : '-')}${cell('최대 연속 손실', s.maxLossStreak + '번')}
        ${cell('실현 / 미실현 손익', `${btNum(s.realized)} / ${btNum(s.unrealized)}`)}${cell('수수료 합', btNum(s.fee))}
        ${cell('슬리피지 추정', btNum(s.slip))}${cell('펀딩비 합(가정)', btNum(s.fund))}</div>
      ${r.open ? `<div class="warnlist" style="font-size:12px">아직 열린 가상 포지션: ${btT(r.open.entryT)} 진입 ${btNum(r.open.entry, 4)} · 손절 ${btNum(r.open.stop, 4)} · 목표 ${btNum(r.open.target, 4)} · 미실현 ${btNum(r.open.unreal)}</div>` : ''}
      <h4>구간별(시간순, 튜닝에 쓰지 말 것)</h4>
      <div class="tblwrap"><table class="md"><thead><tr><th>구간</th><th>기간</th><th>수익률</th><th>MDD</th><th>거래</th><th>승률</th></tr></thead><tbody>${r.segs.map((g) => `<tr><td>${g.name} ${g.w}%</td><td>${btT(g.from)}~${btT(g.to)}</td><td class="${g.ret > 0 ? 'up' : 'down'}">${btPct(g.ret)}</td><td>${btPct(g.mdd)}</td><td>${g.n}</td><td>${g.win != null ? g.win.toFixed(0) + '%' : '-'}</td></tr>`).join('')}</tbody></table></div>
      <h4>📊 시장 국면별 <span class="muted">(진입 신호가 난 봉 기준)</span></h4>${btRegime(r.regimes)}
      <h4>🔁 워크포워드 검증</h4><div class="muted" style="font-size:12px">앞 구간(학습)에서만 손절·목표 조합 9개 중 하나를 고르고, 바로 다음 구간(시험)의 처음 보는 데이터로 성과를 잽니다. 4번 밀어 가며 반복합니다.</div>
      <button class="btn small" id="bwf" type="button" style="margin-top:6px">🔁 워크포워드 검증 실행</button><div id="bwfOut"></div>
      <details style="margin-top:8px"><summary><b>거래 내역</b> <span class="muted">(${r.trades.length})</span></summary><div class="tblwrap"><table class="md"><thead><tr><th>진입</th><th>진입가</th><th>청산</th><th>청산가</th><th>사유</th><th>손익</th><th>R</th><th>봉</th><th>비용</th></tr></thead><tbody>
        ${r.trades.slice().reverse().map((t) => `<tr><td>${btT(t.entryT)}</td><td>${btNum(t.entry, 4)}</td><td>${btT(t.exitT)}</td><td>${btNum(t.exit, 4)}</td><td>${esc(t.why)}</td><td class="${t.pnl > 0 ? 'up' : 'down'}">${btNum(t.pnl)}</td><td>${btNum(t.R)}</td><td>${t.bars}</td><td>${btNum(t.fee + t.fund)}</td></tr>`).join('')}</tbody></table></div></details>
      ${btAssume(r, ctx, p)}</div>`;
}
// 전략 비교: 큰 글씨 카드 + 규칙 기반 순위(표본 수·최대 낙폭·시험 구간·워크포워드) + 짧은 전문가 코멘트
function btRank(r) {
  const s = r.stats, test = r.segs[2] ? r.segs[2].ret : 0, oos = r.wf ? r.wf.oos.netPct : null;
  const warn = [];
  if (s.n < 10) warn.push(`거래 ${s.n}번뿐(우연일 수 있음)`);
  if (r.wf && r.wf.avgTrain != null && r.wf.avgTest != null && r.wf.avgTrain - r.wf.avgTest > 3) warn.push('학습 ≫ 시험(과최적화 신호)');
  if (s.mdd <= -20) warn.push(`낙폭 ${s.mdd.toFixed(0)}%`);
  // 점수: 처음 보는 데이터 성과(워크포워드·테스트 구간)에 무게, 낙폭은 깎고, 표본이 적으면 크게 깎음
  let score = s.netPct * 0.3 + test * 0.3 + (oos != null ? oos * 0.4 : test * 0.2) + s.mdd * 0.5 + (s.pf != null && s.pf > 1 ? 2 : -2);
  if (s.n < 10) score -= 10;
  return { score, warn, oos, test };
}
function btCompare(res, ctx, p) {
  const ok = res.filter((r) => !r.error);
  ok.forEach((r) => { r.rk = btRank(r); });
  const ranked = ok.slice().sort((x, y) => y.rk.score - x.rk.score);
  const medal = ['🥇', '🥈', '🥉'];
  const big = (v, cls) => `<b class="${cls || ''}" style="font-size:17px">${v}</b>`;
  const card = (r, i) => {
    const s = r.stats, k = r.rk;
    return `<div class="card" style="margin:8px 0 0;padding:10px 12px;${i === 0 && k.score > 0 && s.n >= 10 ? 'border:2px solid #E8A317' : ''}">
      <div class="row spread"><b style="font-size:15px">${medal[i] || (i + 1) + '위'} ${esc(r.name)}</b><span class="muted" style="font-size:12px">점수 ${k.score.toFixed(1)}</span></div>
      <div class="grid2" style="font-size:13px;margin-top:6px;row-gap:4px">
        <div>순수익률<br>${big(btPct(s.netPct), s.netPct > 0 ? 'up' : 'down')}</div><div>최대 낙폭<br>${big(btPct(s.mdd), 'down')}</div>
        <div>거래 · 승률<br>${big(s.n + '번')} · ${s.winRate != null ? s.winRate.toFixed(0) + '%' : '-'}</div><div>PF · 평균 R<br>${big(btNum(s.pf))} · ${btNum(s.avgR)}</div>
        <div>테스트 구간(마지막 20%)<br>${big(btPct(k.test), k.test > 0 ? 'up' : 'down')}</div><div>워크포워드 시험<br>${k.oos != null ? big(btPct(k.oos), k.oos > 0 ? 'up' : 'down') : `<span class="muted">${esc(r.wfErr || '-')}</span>`}</div></div>
      ${k.warn.length ? `<div style="font-size:12px;color:#B26B00;margin-top:4px">⚠️ ${k.warn.map(esc).join(' · ')}</div>` : ''}</div>`;
  };
  // 전문가 코멘트(규칙으로 만든 문장)
  const top = ranked[0], good = ranked.filter((r) => r.stats.n >= 10 && r.stats.netPct > 0 && r.rk.test > 0 && (r.rk.oos == null || r.rk.oos > 0));
  const allBad = ok.length && ok.every((r) => r.stats.netPct <= 0);
  const C = [];
  if (!ok.length) C.push('계산된 전략이 없습니다.');
  else if (allBad) C.push(`모든 전략이 비용을 빼면 손실입니다. 이 상품·${BT_TF[p.tf].label}·기간에서는 <b>쉬는 것(매매하지 않음)</b>이 가장 나은 선택일 수 있습니다. 봉 단위나 상품을 바꿔 다시 비교해 보세요.`);
  else if (good.length) C.push(`<b>${esc(good[0].name)}</b>이(가) 전체 기간·마지막 20%·워크포워드 시험에서 모두 플러스입니다(${good[0].stats.n}번 거래, 최대 낙폭 ${btPct(good[0].stats.mdd)}). 그래도 바로 실전이 아니라 <b>모의매매로 몇 주 더 확인</b>하는 단계가 맞습니다.`);
  else C.push(`1위 <b>${esc(top.name)}</b>도 처음 보는 구간(테스트·워크포워드)에서 안정적이지 않습니다. 순위는 상대 비교일 뿐 '쓸 만하다'는 뜻이 아닙니다.`);
  if (ok.some((r) => r.stats.n < 10)) C.push('거래가 10번 안 되는 전략은 점수에서 크게 깎았습니다 — 표본이 적으면 운이 결과를 좌우합니다.');
  if (ok.some((r) => r.rk.warn.some((w) => w.startsWith('학습')))) C.push('학습 구간만 좋고 시험 구간이 나쁜 전략은 과거에 맞춘 결과(과최적화)일 가능성이 큽니다.');
  C.push(`전략 ${ok.length}개를 한꺼번에 비교했으므로, 1위가 우연히 좋아 보일 확률도 그만큼 큽니다. 손절·목표 설정을 바꿔 가며 1위를 '만드는' 것은 피하세요.`);
  return `<div class="card"><h2>전략 비교 · 순위 <span class="muted">${esc(p.base)} · ${BT_TF[p.tf].label} · 최근 ${btSpan(p.bars, p.tf)}</span></h2>
    <div class="muted" style="font-size:12px">같은 데이터·비용·자본으로 계산했습니다. 점수 = 처음 보는 구간(워크포워드 40%·마지막 20% 30%)과 전체 수익(30%)에 무게, 최대 낙폭은 깎고, 거래 10번 미만은 크게 깎음.</div>
    ${ranked.map(card).join('')}
    ${res.filter((r) => r.error).map((r) => `<div class="muted" style="font-size:12px;margin-top:6px">${esc(r.name)}: ${esc(r.error)}</div>`).join('')}
    <div class="card" style="margin:10px 0 0;background:rgba(122,76,209,.08);border:1px solid #7A4CD1"><b>🧑‍💼 전문가 코멘트</b><ul class="steps" style="font-size:14px;margin-top:6px;line-height:1.6">${C.map((t) => `<li>${t}</li>`).join('')}</ul>
      <div class="muted" style="font-size:11px">규칙으로 만든 문장입니다(AI 아님). 공부용 · 매매 권유 아님.</div></div>
    ${ok[0] ? btAssume(ok[0], ctx, p) : ''}</div>`;
}
// 자산 곡선 + 낙폭
function btDraw(cv, r) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, Hh = cv.clientHeight; cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const eq = r.curve.map((p) => p.eq); if (eq.length < 2) return;
  let peak = eq[0]; const dd = eq.map((v) => { peak = Math.max(peak, v); return (v - peak) / peak; });
  const lo = Math.min(...eq, r.opt.capital), hi = Math.max(...eq, r.opt.capital), mdd = Math.min(...dd) || -0.0001;
  const topH = Hh * 0.72, x = (i) => (i / (eq.length - 1)) * (W - 50), y = (v) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (topH - 12);
  const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue('--muted') || '#888';
  g.font = '10px sans-serif'; g.fillStyle = ink;
  [lo, r.opt.capital, hi].forEach((v) => { g.fillText(v.toFixed(0), W - 46, y(v) + 3); });
  g.strokeStyle = 'rgba(128,128,128,.35)'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, y(r.opt.capital)); g.lineTo(W - 50, y(r.opt.capital)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#7A4CD1'; g.lineWidth = 1.6; g.beginPath(); eq.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
  g.fillStyle = 'rgba(214,69,69,.35)'; g.beginPath(); g.moveTo(0, topH + 4); dd.forEach((d, i) => g.lineTo(x(i), topH + 4 + (d / mdd) * (Hh - topH - 8))); g.lineTo(x(dd.length - 1), topH + 4); g.closePath(); g.fill();
  g.fillStyle = ink; g.fillText(`MDD ${(mdd * 100).toFixed(1)}%`, W - 50, Hh - 4);
}

function btRegime(g) {
  if (!g || !g.length) return '<div class="muted" style="font-size:12px">거래가 없어 나눌 것이 없습니다.</div>';
  const row = (x) => `<tr><td>${esc(x.name)}</td><td>${x.share != null ? x.share.toFixed(0) + '%' : '-'}</td><td>${x.n}</td><td>${x.n ? ((x.win / x.n) * 100).toFixed(0) + '%' : '-'}</td><td>${x.n ? (x.R / x.n).toFixed(2) : '-'}</td><td class="${x.pnl > 0 ? 'up' : x.pnl < 0 ? 'down' : ''}">${x.n ? x.pnl.toFixed(2) : '-'}</td></tr>`;
  const trend = g.filter((x) => ['up', 'side', 'down', 'na_t'].includes(x.key)), vol = g.filter((x) => ['high', 'low', 'na_v'].includes(x.key));
  return `<div class="tblwrap"><table class="md"><thead><tr><th>국면</th><th>기간 비율</th><th>거래</th><th>승률</th><th>평균 R</th><th>손익</th></tr></thead><tbody>${trend.map(row).join('')}${vol.length ? `<tr><td colspan="6" class="muted" style="font-size:11px">변동성</td></tr>${vol.map(row).join('')}` : ''}</tbody></table></div>
    <div class="muted" style="font-size:11px">추세: 종가와 EMA50·EMA50 기울기(10봉) / 변동성: ATR%가 지난 100봉 중간값보다 크면 고변동. 거래 수가 적은 칸은 우연일 수 있습니다.</div>`;
}
function btRunWf(strat) {
  const out = $('#bwfOut'), L = BT_LAST; if (!out || !L) return;
  out.innerHTML = '<div class="muted" style="font-size:12px">계산 중…</div>';
  setTimeout(() => { // 화면이 먼저 그려지게
    try {
      const w = BT.walkForward(L.cs, { ...L.p, strat, tfMs: BT_TF[L.p.tf].ms, hiCs: L.hiCs, hiMs: L.hiTf ? BT_TF[L.hiTf].ms : null });
      const f = (x) => btPct(x);
      out.innerHTML = `<div class="tblwrap"><table class="md" style="margin-top:6px"><thead><tr><th>#</th><th>학습 구간</th><th>고른 설정</th><th>학습 수익</th><th>시험 구간</th><th>시험 수익</th><th>시험 MDD</th><th>기본 설정 시험</th></tr></thead><tbody>
        ${w.folds.map((x, i) => `<tr><td>${i + 1}</td><td>${btT(x.trainFrom)}~${btT(x.trainTo)}</td><td>${x.picked ? `손절 ATR×${x.pick.stopAtr} · 목표 ${x.pick.rr}R` : '<span class="muted">학습 거래 부족 → 기본값</span>'}</td><td>${x.train ? f(x.train.netPct) + ` (${x.train.n}번)` : '-'}</td><td>${btT(x.testFrom)}~${btT(x.testTo)}</td><td class="${x.test.netPct > 0 ? 'up' : 'down'}">${f(x.test.netPct)} (${x.test.n}번)</td><td>${f(x.test.mdd)}</td><td>${f(x.base.netPct)}</td></tr>`).join('')}</tbody></table></div>
        <div class="grid2" style="font-size:13px;margin-top:6px"><div>시험 구간 이어 붙인 수익 <b class="${w.oos.netPct > 0 ? 'up' : 'down'}">${f(w.oos.netPct)}</b> (${w.oos.n}번)</div><div>같은 구간 기본 설정 <b>${f(w.baseOos.netPct)}</b> (${w.baseOos.n}번)</div>
          <div>학습 평균 수익 <b>${f(w.avgTrain)}</b></div><div>시험 평균 수익 <b>${f(w.avgTest)}</b></div></div>
        <div class="warnlist" style="font-size:12px">조합 ${w.combos}개 × ${w.folds.length}구간 = <b>${w.tried}번</b> 시험했습니다.${w.avgTrain != null && w.avgTest != null && w.avgTrain - w.avgTest > 3 ? ' 학습 성과가 시험 성과보다 크게 좋습니다 — <b>과최적화 신호</b>일 수 있습니다.' : ''} 시험 구간 성과(처음 보는 데이터)가 실제에 가깝습니다. 구간마다 ${w.T}봉.</div>`;
    } catch (e) { out.innerHTML = `<div class="errbox" style="margin-top:6px">${esc(e.message)}</div>`; }
  }, 30);
}
