/* AI 마켓 스캐너 — 카테고리별 시세 출처
 *  코인      업비트 공개 시세(키 없음). 브라우저 직접 요청은 10초 1회 제한 → 스크립트 연결 시 스크립트 경유. 업비트에 없거나 실패하면 빗썸(같은 모양의 공개 API)
 *  코인선물  바이낸스 USDⓈ-M 무기한 선물 → 막히면 OKX → 바이비트 (모두 공개 시세, 키 없음)
 *  해외주식  Alpha Vantage — 키는 Apps Script 속성 ALPHAVANTAGE_API_KEY에만(스크립트 경유). 무료 키: 일봉 최근 100개·하루 25회.
 *            한도에 걸리거나 실패하면 OKX → 바이비트의 같은 종목 무기한 선물 봉(24시간 거래라 장 밖 시간 값이 섞임)으로 대신. 현재가도 이 선물 값으로 빠르게 보여 줌
 *  국내주식  한국투자증권 Open API — 키는 Apps Script 속성 KIS_APP_KEY·KIS_APP_SECRET에만(스크립트 경유)
 *  해외선물  한국투자증권 Open API — 위와 같음
 * 모든 출처는 '시세 조회'만 쓴다. 주문·계좌 기능은 없다.
 * 캔들 형식(오래된 것부터): [{t, o, h, l, c, v}]
 */
'use strict';

const CATS = {
  kr: { label: '국내주식', icon: '🇰🇷', tfs: ['day', 'week'], unit: '원', needs: 'krx|kis', hint: '종목 이름이나 코드(예: 삼성전자, 005930)' },
  us: { label: '해외주식', icon: '🇺🇸', tfs: ['day', 'week'], unit: '$', needs: 'av', hint: '티커(예: AAPL, NVDA)' },
  coin: { label: '코인', icon: '🪙', tfs: ['day', 'h4', 'h1'], unit: '원' },
  cfut: { label: '코인선물', icon: '⚡', tfs: ['day', 'h4', 'h1'], unit: 'USDT' },
  ffut: { label: '해외선물', icon: '🌐', tfs: ['day'], unit: '', needs: 'kis', hint: '종목코드+거래소(예: NQZ25, CME)' },
};
const TFS = {
  day: { label: '일봉', name: '일' }, week: { label: '주봉', name: '주' },
  h4: { label: '4시간봉', name: '4시간' }, h1: { label: '1시간봉', name: '1시간' },
};
const FRESH = { day: 30 * 60e3, week: 6 * 3600e3, h4: 10 * 60e3, h1: 5 * 60e3 };
const NEED_LABEL = { kis: '한국투자증권 키', av: 'Alpha Vantage 키', 'krx|kis': '공공데이터 서비스키(또는 한국투자증권 키)' };
// 국내주식 출처: 한투 키가 있으면 한투(장중 시세), 없으면 공공데이터(전 영업일까지)
async function krSource() { const st = await KV.get('relayStatus', {}); return st.kis ? 'kis' : 'krx'; }
// 일봉 → 주봉(월요일 시작 주로 묶기)
function toWeekly(cs) {
  const out = [];
  for (const k of cs) {
    const d = new Date(k.t + 9 * 3600e3), wk = Math.floor((d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3) / (7 * 86400e3));
    const last = out[out.length - 1];
    if (last && last.wk === wk) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v; }
    else out.push({ wk, t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
  }
  return out.map(({ wk, ...k }) => k);
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const num = (x) => (x == null || x === '' ? NaN : Number(String(x).replace(/,/g, '')));

/* ───────── 업비트(코인) ───────── */
const UPBIT = 'https://api.upbit.com/v1';
let upQ = Promise.resolve(), upLast = 0;
try { upLast = +localStorage.getItem('pz_lastDirect') || 0; } catch { /* 무시 */ }
async function upbitDirect(path, tries = 0) {
  const wait = Math.max(0, upLast + 10500 - Date.now());
  if (wait) { busy(`업비트 제한 때문에 ${Math.ceil(wait / 1000)}초 기다리는 중… (설정에서 스크립트를 연결하면 빨라집니다)`); await sleep(wait); }
  upLast = Date.now();
  try { localStorage.setItem('pz_lastDirect', String(upLast)); } catch { /* 무시 */ }
  let r;
  try { r = await fetch(UPBIT + path); } catch { throw new Error('업비트에 연결하지 못했습니다(인터넷 확인)'); }
  if (r.status === 429 && tries < 2) return upbitDirect(path, tries + 1);
  if (!r.ok) throw new Error('업비트 응답 오류 ' + r.status);
  return r.json();
}
async function upbit(path) {
  if (await relayOn()) {
    try { return (await relay('upbit', { path })).data; } catch (e) { if (/APP_KEY/.test(e.message)) throw e; }
  }
  const job = upQ.then(() => upbitDirect(path));
  upQ = job.catch(() => {});
  try { return await job; } finally { busy(''); }
}

/* ───────── 빗썸(코인 예비) — 업비트와 같은 모양의 공개 API, 브라우저 직접 가능 ───────── */
const BITHUMB = 'https://api.bithumb.com/v1';
async function bithumb(path) {
  let r; try { r = await fetch(BITHUMB + path); } catch { throw new Error('빗썸에 연결하지 못했습니다(인터넷 확인)'); }
  if (!r.ok) throw new Error('빗썸 응답 오류 ' + r.status);
  return r.json();
}
// 업비트 원화 마켓 목록(하루 한 번) — 없는 종목은 빗썸으로 보냄
async function upbitMarkets() {
  let all = await KV.get('upbitMarkets', null);
  if (!all || Date.now() - all.at > 86400e3) { all = { at: Date.now(), data: (await upbit('/market/all?isDetails=false')).filter((m) => m.market.startsWith('KRW-')) }; KV.set('upbitMarkets', all).catch(() => {}); }
  return all.data;
}
async function bithumbMarkets() {
  let all = await KV.get('bithumbMarkets', null);
  if (!all || Date.now() - all.at > 86400e3) { all = { at: Date.now(), data: (await bithumb('/market/all?isDetails=false')).filter((m) => m.market.startsWith('KRW-')) }; KV.set('bithumbMarkets', all).catch(() => {}); }
  return all.data;
}

/* ───────── OKX·바이비트 무기한 선물(코인선물 예비, 해외주식 예비·현재가) ───────── */
// OKX 요청은 nqui.js의 okxGet(path)를 같이 씀(같은 함수를 두 번 만들지 않게)
async function bybitGet(path) {
  let r; try { r = await fetch('https://api.bybit.com' + path); } catch { throw new Error('바이비트에 연결하지 못했습니다'); }
  const j = await r.json().catch(() => ({})); if (j.retCode !== 0) throw new Error('바이비트: ' + (j.retMsg || r.status)); return j.result;
}
const PERP_BAR = { day: ['1Dutc', 'D', 86400e3], h4: ['4H', '240', 4 * 3600e3], h1: ['1H', '60', 3600e3] };
// 기초 이름(BTC, NVDA 등)으로 OKX → 바이비트 무기한 선물 봉(끝난 봉만, 오래된 것부터)
async function perpCandles(base, tf) {
  const [ob, bb, ms] = PERP_BAR[tf] || PERP_BAR.day;
  try {
    const d = await okxGet(`/market/candles?instId=${encodeURIComponent(base)}-USDT-SWAP&bar=${ob}&limit=300`);
    const cs = d.filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
    if (cs.length >= 30) { cs.src = 'OKX 선물'; return cs; }
  } catch { /* 바이비트로 */ }
  const r = await bybitGet(`/v5/market/kline?category=linear&symbol=${encodeURIComponent(base)}USDT&interval=${bb}&limit=300`);
  const cs = (r.list || []).filter((k) => +k[0] + ms <= Date.now()).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  if (!cs.length) throw new Error(base + ': OKX·바이비트 선물 봉이 없습니다');
  cs.src = '바이비트 선물'; return cs;
}

/* ───────── 바이낸스 선물(코인선물) ───────── */
const FAPI = 'https://fapi.binance.com/fapi/v1';
async function binance(path) {
  let r;
  try { r = await fetch(FAPI + path); } catch { throw new Error('바이낸스에 연결하지 못했습니다(인터넷 확인)'); }
  if (r.status === 451 || r.status === 403) throw new Error('지금 위치에서 바이낸스 시세를 받을 수 없습니다');
  if (!r.ok) throw new Error('바이낸스 응답 오류 ' + r.status);
  return r.json();
}

/* ───────── 출처별 캔들 ───────── */
async function fetchCandles(a, tf) {
  if (a.cat === 'coin') {
    const unit = { day: 'days', h4: 'minutes/240', h1: 'minutes/60' }[tf];
    const pull = async (get, total) => {
      let out = [], to = '';
      while (out.length < total) {
        const r = await get(`/candles/${unit}?market=${a.sym}&count=200${to ? '&to=' + encodeURIComponent(to) : ''}`);
        if (!Array.isArray(r) || !r.length) break;
        out = out.concat(r);
        if (r.length < 200) break;
        to = r[r.length - 1].candle_date_time_utc + 'Z';
      }
      // 같은 시각 봉이 겹쳐 오면 하나만
      const seen = new Set();
      return out.reverse().filter((k) => !seen.has(k.candle_date_time_utc) && seen.add(k.candle_date_time_utc)).map((k) => ({ t: Date.parse(k.candle_date_time_utc + 'Z'), o: k.opening_price, h: k.high_price, l: k.low_price, c: k.trade_price, v: k.candle_acc_trade_volume }));
    };
    let cs = [];
    // 업비트 목록에 없는 종목(빗썸만)은 업비트를 건너뜀(업비트 직접 받기는 10초 제한이라 헛걸음이 길어짐)
    const known = await KV.get('upbitMarkets', null), onUpbit = !known || known.data.some((m) => m.market === a.sym);
    if (onUpbit) { try { cs = await pull(upbit, (await relayOn()) ? 400 : 200); } catch { cs = []; } }
    if (cs.length) { cs.src = '업비트'; return cs; }
    cs = await pull(bithumb, 400); // 업비트에 없거나 막히면 빗썸
    if (!cs.length) throw new Error(a.sym + ': 업비트·빗썸 둘 다 봉이 없습니다');
    cs.src = '빗썸'; return cs;
  }
  if (a.cat === 'cfut') {
    const iv = { day: '1d', h4: '4h', h1: '1h' }[tf];
    try {
      const r = await binance(`/klines?symbol=${encodeURIComponent(a.sym)}&interval=${iv}&limit=500`);
      const cs = r.filter((k) => +k[6] < Date.now()).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })); // 끝난 봉만
      if (cs.length >= 30) { cs.src = '바이낸스'; return cs; }
    } catch { /* OKX·바이비트로 */ }
    return perpCandles(a.sym.replace(/USDT$/, ''), tf);
  }
  if (a.cat === 'us') {
    let avErr = null;
    try {
      const d = await relay('av', { fn: tf === 'week' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY', symbol: a.sym });
      const j = d.data || {};
      const key = Object.keys(j).find((k) => /Time Series/i.test(k));
      if (!key) throw new Error(j.Note || j.Information || j['Error Message'] || 'Alpha Vantage 응답에 시세가 없습니다');
      const cs = Object.entries(j[key]).map(([day, v]) => ({ t: Date.parse(day + 'T00:00:00Z'), o: num(v['1. open']), h: num(v['2. high']), l: num(v['3. low']), c: num(v['4. close']), v: num(v['5. volume']) })).sort((x, y) => x.t - y.t);
      cs.src = 'Alpha Vantage'; return cs;
    } catch (e) { avErr = e; }
    // 알파밴티지 한도·오류 → 같은 종목 무기한 선물 봉으로 대신(OKX → 바이비트)
    try { const cs = await perpCandles(a.sym, 'day'); const out = tf === 'week' ? toWeekly(cs) : cs; out.src = cs.src + '(Alpha Vantage 대신)'; return out; } catch { throw avErr; }
  }
  if (a.cat === 'kr' && (await krSource()) === 'krx') {
    const d = await relay('krx', { kind: 'candles', code: a.sym });
    const cs = d.candles || [];
    return tf === 'week' ? toWeekly(cs) : cs;
  }
  if (a.cat === 'kr' || a.cat === 'ffut') {
    const d = await relay('kis', a.cat === 'kr' ? { kind: 'krCandles', code: a.sym, period: tf === 'week' ? 'W' : 'D' } : { kind: 'ffCandles', code: a.sym, exch: a.ex || '' });
    return d.candles || [];
  }
  throw new Error('알 수 없는 카테고리');
}

/* ───────── 종목 찾기 ───────── */
async function searchAssets(cat, q) {
  q = q.trim();
  if (cat === 'coin') {
    const [u, b] = await Promise.all([upbitMarkets().catch(() => []), bithumbMarkets().catch(() => [])]);
    const inU = new Set(u.map((m) => m.market));
    const all = u.map((m) => ({ ...m, ex: '' })).concat(b.filter((m) => !inU.has(m.market)).map((m) => ({ ...m, ex: '빗썸' }))); // 같은 종목은 업비트 하나만(중복 없음)
    if (!all.length) throw new Error('업비트·빗썸 종목 목록을 받지 못했습니다');
    const Q = q.toUpperCase();
    return all.filter((m) => !Q || m.korean_name.toUpperCase().includes(Q) || m.market.slice(4).includes(Q) || String(m.english_name || '').toUpperCase().includes(Q)).slice(0, 60).map((m) => ({ sym: m.market, name: m.korean_name, sub: m.market.slice(4) + (m.ex ? ' · ' + m.ex + '만' : '') }));
  }
  if (cat === 'cfut') {
    let all = await KV.get('binanceSyms', null);
    if (!all || Date.now() - all.at > 86400e3) {
      let list;
      try { list = (await binance('/ticker/price')).map((x) => x.symbol); } catch { list = ((await bybitGet('/v5/market/instruments-info?category=linear&limit=1000')).list || []).filter((x) => x.status === 'Trading').map((x) => x.symbol); }
      all = { at: Date.now(), data: [...new Set(list.filter((s) => /USDT$/.test(s)))].sort() }; KV.set('binanceSyms', all).catch(() => {});
    }
    const Q = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rank = (s) => (s === Q + 'USDT' ? 0 : s.startsWith(Q) ? 1 : 2);
    return all.data.filter((s) => !Q || s.includes(Q)).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y)).slice(0, 60).map((s) => ({ sym: s, name: s.replace(/USDT$/, '') + ' 무기한', sub: s }));
  }
  if (cat === 'us') {
    if (!q) return [];
    const d = await relay('av', { fn: 'SYMBOL_SEARCH', keywords: q });
    const m = (d.data && d.data.bestMatches) || [];
    if (!m.length && d.data && (d.data.Note || d.data.Information)) throw new Error(d.data.Note || d.data.Information);
    return m.slice(0, 15).map((x) => ({ sym: x['1. symbol'], name: x['2. name'], sub: `${x['1. symbol']} · ${x['4. region']} · ${x['8. currency']}` }));
  }
  if (cat === 'kr') {
    if (!q) return [];
    return (await relay('krx', { kind: 'search', q })).items || [];
  }
  return [];
}

/* ───────── 현재가(목록용) ───────── */
async function quotes(list) {
  const out = {};
  const coins = [...new Set(list.filter((a) => a.cat === 'coin').map((a) => a.sym))];
  const futs = list.filter((a) => a.cat === 'cfut'), uss = list.filter((a) => a.cat === 'us');
  const put = (t) => { out['coin:' + t.market] = { price: t.trade_price, chg: t.signed_change_rate * 100 }; };
  // 업비트에 있는 코인은 업비트, 없는 코인(빗썸만)·업비트 실패는 빗썸 — 업비트는 모르는 종목이 하나라도 섞이면 전체를 거절함
  const coinQ = async () => {
    if (!coins.length) return;
    let inU = null; try { inU = new Set((await upbitMarkets()).map((m) => m.market)); } catch { /* 모름 */ }
    const onU = inU ? coins.filter((c) => inU.has(c)) : coins, rest = inU ? coins.filter((c) => !inU.has(c)) : [];
    if (onU.length) { try { (await upbit('/ticker?markets=' + onU.join(','))).forEach(put); } catch { rest.push(...onU); } }
    if (rest.length) { try { (await bithumb('/ticker?markets=' + rest.join(','))).forEach(put); } catch { /* 없음 */ } }
  };
  // 해외주식 현재가: OKX 무기한 선물(24시간 거래) 한 번에, 없으면 바이비트
  const usQ = async () => {
    if (!uss.length) return;
    try { const m = {}; (await okxGet('/market/tickers?instType=SWAP')).forEach((t) => { m[t.instId] = t; }); for (const a of uss) { const t = m[a.sym + '-USDT-SWAP']; if (t && +t.last) out['us:' + a.sym] = { price: +t.last, chg: +t.open24h ? (+t.last / +t.open24h - 1) * 100 : 0, src: 'OKX 선물' }; } } catch { /* 바이비트로 */ }
    await Promise.all(uss.filter((a) => !out['us:' + a.sym]).map((a) => bybitGet('/v5/market/tickers?category=linear&symbol=' + encodeURIComponent(a.sym) + 'USDT').then((r) => { const t = r.list && r.list[0]; if (t && +t.lastPrice) out['us:' + a.sym] = { price: +t.lastPrice, chg: +t.price24hPcnt * 100, src: '바이비트 선물' }; }).catch(() => {})));
  };
  await Promise.all([
    coinQ().catch(() => {}),
    usQ().catch(() => {}),
    ...futs.map((a) => binance('/ticker/24hr?symbol=' + encodeURIComponent(a.sym)).then((t) => { out['cfut:' + a.sym] = { price: +t.lastPrice, chg: +t.priceChangePercent }; })
      .catch(() => bybitGet('/v5/market/tickers?category=linear&symbol=' + encodeURIComponent(a.sym)).then((r) => { const t = r.list && r.list[0]; if (t) out['cfut:' + a.sym] = { price: +t.lastPrice, chg: +t.price24hPcnt * 100 }; }))
      .catch(() => {})),
  ]);
  return out;
}

/* ───────── 표시 ───────── */
function fmtP(p, cat) {
  if (p == null || !Number.isFinite(p)) return '-';
  const a = Math.abs(p);
  const d = cat === 'us' || cat === 'cfut' || cat === 'ffut' ? (a >= 1000 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6) : (a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
  const s = p.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  return cat === 'us' ? '$' + s : s;
}
const unitOf = (cat) => (cat === 'us' ? '' : CATS[cat].unit);
