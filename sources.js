/* 가격 위치 — 카테고리별 시세 출처
 *  코인      업비트 공개 시세(키 없음). 브라우저 직접 요청은 10초 1회 제한 → 스크립트 연결 시 스크립트 경유
 *  코인선물  바이낸스 USDⓈ-M 무기한 선물 공개 시세(키 없음, 브라우저에서 직접)
 *  해외주식  Alpha Vantage — 키는 Apps Script 속성 ALPHAVANTAGE_API_KEY에만(스크립트 경유). 무료 키: 일봉 최근 100개·하루 25회
 *  국내주식  한국투자증권 Open API — 키는 Apps Script 속성 KIS_APP_KEY·KIS_APP_SECRET에만(스크립트 경유)
 *  해외선물  한국투자증권 Open API — 위와 같음
 * 모든 출처는 '시세 조회'만 쓴다. 주문·계좌 기능은 없다.
 * 캔들 형식(오래된 것부터): [{t, o, h, l, c, v}]
 */
'use strict';

const CATS = {
  kr: { label: '국내주식', icon: '🇰🇷', tfs: ['day', 'week'], unit: '원', needs: 'kis', hint: '종목코드 6자리(예: 005930)' },
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
const NEED_LABEL = { kis: '한국투자증권 키', av: 'Alpha Vantage 키' };

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
    const total = (await relayOn()) ? 400 : 200;
    let out = [], to = '';
    while (out.length < total) {
      const r = await upbit(`/candles/${unit}?market=${a.sym}&count=200${to ? '&to=' + encodeURIComponent(to) : ''}`);
      if (!r.length) break;
      out = out.concat(r);
      if (r.length < 200) break;
      to = r[r.length - 1].candle_date_time_utc + 'Z';
    }
    return out.reverse().map((k) => ({ t: k.timestamp, o: k.opening_price, h: k.high_price, l: k.low_price, c: k.trade_price, v: k.candle_acc_trade_volume }));
  }
  if (a.cat === 'cfut') {
    const iv = { day: '1d', h4: '4h', h1: '1h' }[tf];
    const r = await binance(`/klines?symbol=${encodeURIComponent(a.sym)}&interval=${iv}&limit=500`);
    return r.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }
  if (a.cat === 'us') {
    const d = await relay('av', { fn: tf === 'week' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY', symbol: a.sym });
    const j = d.data || {};
    const key = Object.keys(j).find((k) => /Time Series/i.test(k));
    if (!key) throw new Error(j.Note || j.Information || j['Error Message'] || 'Alpha Vantage 응답에 시세가 없습니다');
    return Object.entries(j[key]).map(([day, v]) => ({ t: Date.parse(day + 'T00:00:00Z'), o: num(v['1. open']), h: num(v['2. high']), l: num(v['3. low']), c: num(v['4. close']), v: num(v['5. volume']) })).sort((x, y) => x.t - y.t);
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
    let all = await KV.get('upbitMarkets', null);
    if (!all || Date.now() - all.at > 86400e3) { all = { at: Date.now(), data: (await upbit('/market/all?isDetails=false')).filter((m) => m.market.startsWith('KRW-')) }; KV.set('upbitMarkets', all).catch(() => {}); }
    const Q = q.toUpperCase();
    return all.data.filter((m) => !Q || m.korean_name.toUpperCase().includes(Q) || m.market.slice(4).includes(Q) || m.english_name.toUpperCase().includes(Q)).slice(0, 60).map((m) => ({ sym: m.market, name: m.korean_name, sub: m.market.slice(4) }));
  }
  if (cat === 'cfut') {
    let all = await KV.get('binanceSyms', null);
    if (!all || Date.now() - all.at > 86400e3) { all = { at: Date.now(), data: (await binance('/ticker/price')).map((x) => x.symbol).filter((s) => /USDT$/.test(s)).sort() }; KV.set('binanceSyms', all).catch(() => {}); }
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
  return [];
}

/* ───────── 현재가(목록용) ───────── */
async function quotes(list) {
  const out = {};
  const coins = list.filter((a) => a.cat === 'coin');
  const futs = list.filter((a) => a.cat === 'cfut');
  await Promise.all([
    coins.length ? upbit('/ticker?markets=' + coins.map((a) => a.sym).join(',')).then((r) => { for (const t of r) out['coin:' + t.market] = { price: t.trade_price, chg: t.signed_change_rate * 100 }; }).catch(() => {}) : null,
    ...futs.map((a) => binance('/ticker/24hr?symbol=' + encodeURIComponent(a.sym)).then((t) => { out['cfut:' + a.sym] = { price: +t.lastPrice, chg: +t.priceChangePercent }; }).catch(() => {})),
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
