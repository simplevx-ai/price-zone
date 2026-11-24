/**
 * 가격 위치 앱 — 알림·시세 중계 스크립트 (Google Apps Script 웹 앱 + 10분 자동 확인)
 *
 * 1) 앱이 계산한 '검토 구간'을 저장해 두고, 현재가가 구간에 '들어올 때' 텔레그램·디스코드로 알린다.
 * 2) 키가 필요한 시세(해외주식 Alpha Vantage, 국내주식·해외선물 한국투자증권)를 앱 대신 받아 준다(키는 여기만 보관).
 * 3) 업비트는 브라우저 직접 요청이 10초 1회로 막혀 있어 앱 대신 받아 준다.
 * 4) 매일 14시(한국 시간) 이후 한 번, 앱을 열지 않아도 알림 종목의 검토 구간을 스스로 다시 계산한다(앱과 같은 계산식).
 * 모두 '시세 조회'만 한다. 주문·계좌 기능은 없다.
 *
 * ── 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 직접 넣을 값 ──
 *   APP_KEY              앱과 이 스크립트만 아는 암호(아무 긴 문자열). 앱 설정에도 같은 값   ← 꼭 필요
 *   TELEGRAM_BOT_TOKEN   텔레그램 봇 토큰           ┐ 텔레그램 알림을 쓸 때
 *   TELEGRAM_CHAT_ID     알림 받을 채팅 ID(숫자)    ┘
 *   DISCORD_WEBHOOK_URL  디스코드 채널 웹훅 주소     — 디스코드 알림을 쓸 때
 *   ALPHAVANTAGE_API_KEY Alpha Vantage 키           — 해외주식을 볼 때
 *   KIS_APP_KEY          한국투자증권 앱키          ┐ 국내주식·해외선물을 볼 때
 *   KIS_APP_SECRET       한국투자증권 앱시크릿      ┘
 *   KIS_ENV              real(실전, 기본) 또는 demo(모의투자)
 *   DATA_GO_KR_KEY       공공데이터포털 '금융위원회_주식시세정보' 서비스키 — 국내주식(한투 없이, 하루 1번 갱신)
 *
 * 처음 한 번: 편집기에서 '알림켜기' 실행 → 10분마다 '가격확인'이 돌도록 트리거가 만들어진다.
 */

const VERSION = 6;
const RECALC_HOUR = 14;     // 한국 시간 14시 이후 하루 한 번 구간 재계산(국내주식 공공데이터가 13시 이후 갱신되므로)
const RECALC_BUDGET_MS = 240e3; // 한 번에 4분까지만 계산하고 남은 종목은 10분 뒤 이어서
const COOLDOWN_H = 6;       // 같은 구간 알림은 6시간에 한 번
const US_CHECK_H = 3;       // 해외주식은 Alpha Vantage 무료 한도 때문에 3시간마다 확인
const CATS_ = ['kr', 'us', 'coin', 'cfut', 'ffut'];
const CAT_LABEL_ = { kr: '국내주식', us: '해외주식', coin: '코인', cfut: '코인선물', ffut: '해외선물' };

function doPost(e) {
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const P = PropertiesService.getScriptProperties();
    const appKey = (P.getProperty('APP_KEY') || '').trim();
    if (!appKey || d.key !== appKey) return json_({ ok: false, error: 'denied' });
    if (d.action === 'ping') {
      return json_({ ok: true, version: VERSION, telegram: !!(P.getProperty('TELEGRAM_BOT_TOKEN') && P.getProperty('TELEGRAM_CHAT_ID')), discord: !!discordUrl_(),
        av: !!P.getProperty('ALPHAVANTAGE_API_KEY'), kis: !!(P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET')), krx: !!P.getProperty('DATA_GO_KR_KEY'), trigger: hasTrigger_(), watching: watch_().length, recalc: watchMeta_().recalc || null });
    }
    if (d.action === 'upbit') return json_(upbitRelay_(String(d.path || '')));
    if (d.action === 'av') return json_(avRelay_(d));
    if (d.action === 'kis') return json_(kisRelay_(d));
    if (d.action === 'krx') return json_(krxRelay_(d));
    if (d.action === 'test') { const r = send_('✅ 가격 위치 알림 테스트입니다. 이 메시지가 보이면 연결이 잘 된 것입니다.'); return json_({ ok: true, sent: r }); }
    if (d.action === 'saveWatch') {
      const items = (d.items || []).slice(0, 40).map((x) => ({
        cat: CATS_.indexOf(x.cat) >= 0 ? x.cat : 'coin',
        sym: String(x.sym || x.market || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 24),
        ex: String(x.ex || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8),
        name: String(x.name || '').slice(0, 40), tf: String(x.tf || '').slice(0, 10),
        tfk: TFK_[x.tfk] ? x.tfk : TFK_LABEL_[x.tf] || 'day', calcAt: new Date().toISOString(),
        zones: (x.zones || []).slice(0, 5).map((z) => ({ low: Number(z.low), high: Number(z.high), score: Number(z.score) || 0, labels: (z.labels || []).slice(0, 8).map(String) })).filter((z) => z.low > 0 && z.high >= z.low),
      })).filter((x) => x.sym && (x.cat !== 'coin' || /^KRW-[A-Z0-9]+$/.test(x.sym)));
      const lock = LockService.getScriptLock(); lock.waitLock(20000); // 재계산과 겹치지 않게
      try { writeWatch_({ at: new Date().toISOString(), items: items, recalc: watchMeta_().recalc || null }); } finally { lock.releaseLock(); }
      return json_({ ok: true, coins: items.length, zones: items.reduce((s, x) => s + x.zones.length, 0) });
    }
    return json_({ ok: false, error: '알 수 없는 요청' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}
function doGet() { return ContentService.createTextOutput('price-zone alert v' + VERSION); }

/** 10분마다 실행: 현재가가 구간에 새로 들어오면 알림 */
function 가격확인() {
  const items = watch_();
  if (!items.length) return;
  const P = PropertiesService.getScriptProperties();
  const now = Date.now();
  const price = {};
  // 코인: 업비트 한 번에
  const coins = items.filter((x) => x.cat === 'coin');
  if (coins.length) {
    const r = UrlFetchApp.fetch('https://api.upbit.com/v1/ticker?markets=' + coins.map((x) => x.sym).join(','), { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) JSON.parse(r.getContentText()).forEach((t) => { price['coin:' + t.market] = t.trade_price; });
  }
  // 코인선물: 바이낸스 → 막히면 OKX
  items.filter((x) => x.cat === 'cfut').forEach((x) => { const p = cfutPrice_(x.sym); if (p) price['cfut:' + x.sym] = p; });
  // 해외주식: 3시간마다만(무료 한도)
  const lastUs = Number(P.getProperty('LAST_US') || 0);
  if (items.some((x) => x.cat === 'us') && now - lastUs > US_CHECK_H * 3600e3 && P.getProperty('ALPHAVANTAGE_API_KEY')) {
    items.filter((x) => x.cat === 'us').slice(0, 5).forEach((x) => {
      try { const q = avFetch_({ function: 'GLOBAL_QUOTE', symbol: x.sym }, 0); const p = Number(q && q['Global Quote'] && q['Global Quote']['05. price']); if (p) price['us:' + x.sym] = p; } catch (e) { /* 다음에 */ }
    });
    P.setProperty('LAST_US', String(now));
  }
  // 국내주식: 공공데이터(전 영업일 종가, 한투 키가 없을 때)
  if (P.getProperty('DATA_GO_KR_KEY') && !(P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET'))) {
    items.filter((x) => x.cat === 'kr').forEach((x) => { try { const cs = krxCandlesCached_(x.sym); if (cs.length) price['kr:' + x.sym] = cs[cs.length - 1].c; } catch (e) { /* 다음에 */ } });
  }
  // 국내주식·해외선물: 한국투자증권
  if (P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET')) {
    items.filter((x) => x.cat === 'kr').forEach((x) => { try { const o = kisGet_('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: x.sym }); const p = Number(o.output && o.output.stck_prpr); if (p) price['kr:' + x.sym] = p; } catch (e) { /* 다음에 */ } });
    items.filter((x) => x.cat === 'ffut').forEach((x) => { try { const cs = ffCandles_(x.sym, x.ex, 1); if (cs.length) price['ffut:' + x.sym] = cs[cs.length - 1].c; } catch (e) { /* 다음에 */ } });
  }
  const zid = (x, z) => x.cat + ':' + x.sym + '|' + z.low.toPrecision(8) + '|' + z.high.toPrecision(8);
  const state = JSON.parse(readWatchRaw_('STATE'));
  items.forEach((x) => {
    const p = price[x.cat + ':' + x.sym];
    if (!p) return;
    x.zones.forEach((z, i) => {
      const id = zid(x, z);
      const s = state[id] || { inside: false, last: 0 };
      const inside = p >= z.low && p <= z.high;
      if (inside && !s.inside && now - s.last > COOLDOWN_H * 3600e3) {
        const unit = x.cat === 'coin' || x.cat === 'kr' ? '원' : x.cat === 'us' ? ' 달러' : x.cat === 'cfut' ? ' USDT' : '';
        send_('🔔 [' + CAT_LABEL_[x.cat] + '] ' + x.name + ' (' + (x.cat === 'coin' ? x.sym.slice(4) : x.sym) + ') 검토 구간 진입\n' +
          '현재가 ' + fmt_(p) + unit + '\n' +
          '구간 ' + (i + 1) + ': ' + fmt_(z.low) + ' ~ ' + fmt_(z.high) + ' (' + x.tf + ', 근거 점수 ' + z.score + ')\n' +
          '근거: ' + z.labels.join(', ') + (x.calcAt ? '\n구간 계산: ' + Utilities.formatDate(new Date(x.calcAt), 'Asia/Seoul', 'M/d HH:mm') + (x.rc ? ' (자동)' : ' (앱)') : '') + '\n\n' +
          '※ 공부용 알림입니다. 매수 추천이 아니며 결정과 책임은 본인에게 있습니다.' + (x.cat === 'cfut' || x.cat === 'ffut' ? ' 선물은 손실이 원금보다 커질 수 있습니다.' : ''));
        s.last = now;
      }
      s.inside = inside;
      state[id] = s;
    });
  });
  const live = {};
  items.forEach((x) => x.zones.forEach((z) => { live[zid(x, z)] = 1; }));
  Object.keys(state).forEach((k) => { if (!live[k]) delete state[k]; });
  writeWatch_(state, 'STATE');
  // 하루 한 번(14시 이후) 구간 다시 계산 — 앱을 안 열어도 구간이 오래되지 않게
  if (recalcDue_()) { try { 구간재계산_(false); } catch (e) { /* 다음 10분에 다시 */ } }
}

/* ───────── 구간 자동 재계산: 앱(zones.js)과 같은 계산식으로 스크립트가 직접 계산 ───────── */
const TFK_ = { day: '일봉', week: '주봉', h4: '4시간봉', h1: '1시간봉' };
const TFK_LABEL_ = { '일봉': 'day', '주봉': 'week', '4시간봉': 'h4', '1시간봉': 'h1' };
const kstDay_ = (t) => Utilities.formatDate(new Date(t), 'Asia/Seoul', 'yyyy-MM-dd');
function watchMeta_() { try { return JSON.parse(readWatchRaw_()); } catch (e) { return {}; } }
// 알림 종목(WATCH)·알림 상태(STATE) 저장: 속성 하나는 9KB까지라 2,500자씩 나눠 WATCH_0, WATCH_1 …에 저장(WATCH에는 '#chunks:N' 표시)
const WATCH_CHUNK_ = 2500;
function readWatchRaw_(name) {
  name = name || 'WATCH';
  const P = PropertiesService.getScriptProperties(), v = P.getProperty(name) || '';
  const m = /^#chunks:(\d+)$/.exec(v);
  if (!m) return v || '{}'; // 예전 한 칸 저장분
  let s = '';
  for (let i = 0; i < Number(m[1]); i++) s += P.getProperty(name + '_' + i) || '';
  return s || '{}';
}
function writeWatch_(obj, name) {
  name = name || 'WATCH';
  const P = PropertiesService.getScriptProperties(), s = JSON.stringify(obj);
  const n = Math.max(1, Math.ceil(s.length / WATCH_CHUNK_)), o = {};
  for (let i = 0; i < n; i++) o[name + '_' + i] = s.slice(i * WATCH_CHUNK_, (i + 1) * WATCH_CHUNK_);
  o[name] = '#chunks:' + n;
  P.setProperties(o);
  for (let i = n; P.getProperty(name + '_' + i) != null; i++) P.deleteProperty(name + '_' + i);
}
function recalcDue_() {
  if (Number(Utilities.formatDate(new Date(), 'Asia/Seoul', 'H')) < RECALC_HOUR) return false;
  const today = kstDay_(Date.now());
  return watch_().some((x) => x.rcDay !== today);
}
// force=true면 오늘 이미 했어도 모두 다시 계산(편집기 '구간재계산지금')
function 구간재계산_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { busy: true };
  try {
    const P = PropertiesService.getScriptProperties();
    const meta = watchMeta_(), items = watch_();
    const start = Date.now(), today = kstDay_(start);
    const res = { at: new Date().toISOString(), done: 0, fail: [], left: 0, total: items.length };
    items.forEach((x) => {
      if (!force && x.rcDay === today) return;
      if (Date.now() - start > RECALC_BUDGET_MS) { res.left++; return; }
      try {
        const r = ZoneMath.analyze(serverCandles_(x));
        if (r.error) throw new Error(r.error);
        x.zones = r.zones.slice(0, 5).map((z) => ({ low: z.low, high: z.high, score: z.score, labels: Array.from(new Set(z.items.map((i) => i.label))).slice(0, 8) }));
        x.calcAt = new Date().toISOString(); x.rc = 1; delete x.rcErr;
        res.done++;
      } catch (e) {
        x.rcErr = String(e && e.message || e).slice(0, 100); // 예전 구간은 그대로 두고 내일 다시
        res.fail.push(x.name + ': ' + x.rcErr);
      }
      x.rcDay = today;
    });
    res.fail = res.fail.slice(0, 5);
    writeWatch_({ at: meta.at || res.at, items: items, recalc: res });
    return res;
  } finally { lock.releaseLock(); }
}
/** 편집기에서 실행: 지금 바로 모든 알림 종목의 구간을 다시 계산하고 결과를 로그로 보여 줌 */
function 구간재계산지금() {
  const before = {};
  watch_().forEach((x) => { before[x.cat + ':' + x.sym] = x.zones.map((z) => fmt_(z.low) + '~' + fmt_(z.high)).join(' / '); });
  const r = 구간재계산_(true);
  if (r.busy) { Logger.log('다른 작업이 실행 중입니다. 잠시 뒤 다시 실행하세요.'); return; }
  Logger.log('재계산: ' + r.done + '개 성공 / 실패 ' + r.fail.length + (r.left ? ' / 시간 부족으로 남음 ' + r.left : '') + ' (전체 ' + r.total + ')');
  watch_().forEach((x) => Logger.log('[' + CAT_LABEL_[x.cat] + '] ' + x.name + ' ' + x.tf + (x.rcErr ? ' ❌ ' + x.rcErr : '') + '\n  전: ' + (before[x.cat + ':' + x.sym] || '-') + '\n  후: ' + (x.zones.map((z) => fmt_(z.low) + '~' + fmt_(z.high)).join(' / ') || '아래 겹치는 구간 없음')));
}
// 종목별 봉 데이터를 스크립트가 직접 받음(앱의 sources.js fetchCandles와 같은 출처·개수)
function serverCandles_(x) {
  const tf = TFK_[x.tfk] ? x.tfk : TFK_LABEL_[x.tf] || 'day';
  if (x.cat === 'coin') {
    const unit = { day: 'days', h4: 'minutes/240', h1: 'minutes/60' }[tf] || 'days';
    let out = [], to = '';
    for (let k = 0; k < 2; k++) {
      const r = upbitRelay_('/candles/' + unit + '?market=' + x.sym + '&count=200' + (to ? '&to=' + encodeURIComponent(to) : ''));
      if (!r.ok) throw new Error(r.error);
      out = out.concat(r.data);
      if (r.data.length < 200) break;
      to = r.data[r.data.length - 1].candle_date_time_utc + 'Z';
      Utilities.sleep(150);
    }
    return out.reverse().map((k) => ({ t: k.timestamp, o: k.opening_price, h: k.high_price, l: k.low_price, c: k.trade_price, v: k.candle_acc_trade_volume }));
  }
  if (x.cat === 'cfut') {
    const iv = { day: '1d', h4: '4h', h1: '1h' }[tf] || '1d';
    try {
      const r = UrlFetchApp.fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + encodeURIComponent(x.sym) + '&interval=' + iv + '&limit=500', { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) return JSON.parse(r.getContentText()).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } catch (e) { /* OKX로 */ }
    const bar = { day: '1Dutc', h4: '4H', h1: '1H' }[tf] || '1Dutc';
    const r = UrlFetchApp.fetch('https://www.okx.com/api/v5/market/candles?instId=' + encodeURIComponent(x.sym.replace(/USDT$/, '') + '-USDT-SWAP') + '&bar=' + bar + '&limit=300', { muteHttpExceptions: true });
    const j = JSON.parse(r.getContentText() || '{}');
    if (r.getResponseCode() !== 200 || j.code !== '0') throw new Error('코인선물 봉 데이터 오류(바이낸스·OKX) ' + r.getResponseCode());
    return (j.data || []).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  }
  if (x.cat === 'us') {
    if (!PropertiesService.getScriptProperties().getProperty('ALPHAVANTAGE_API_KEY')) throw new Error('ALPHAVANTAGE_API_KEY 없음');
    const fn = tf === 'week' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY';
    const j = avFetch_({ function: fn, symbol: x.sym }, AV_FN_[fn]);
    const key = Object.keys(j).find((k) => /Time Series/i.test(k));
    if (!key) throw new Error(j.Note || j.Information || j['Error Message'] || 'Alpha Vantage 응답에 시세가 없음');
    return Object.keys(j[key]).map((day) => { const v = j[key][day]; return { t: Date.parse(day + 'T00:00:00Z'), o: +v['1. open'], h: +v['2. high'], l: +v['3. low'], c: +v['4. close'], v: +v['5. volume'] }; }).sort((a, b) => a.t - b.t);
  }
  const P = PropertiesService.getScriptProperties(), kis = !!(P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET'));
  if (x.cat === 'kr') {
    if (kis) return krCandles_(x.sym, tf === 'week' ? 'W' : 'D');
    if (!P.getProperty('DATA_GO_KR_KEY')) throw new Error('DATA_GO_KR_KEY 없음');
    const cs = krxCandlesCached_(x.sym);
    return tf === 'week' ? toWeekly_(cs) : cs;
  }
  if (x.cat === 'ffut') { if (!kis) throw new Error('한국투자증권 키 없음'); return ffCandles_(x.sym, x.ex, 3); }
  throw new Error('알 수 없는 카테고리');
}
// 일봉 → 주봉(월요일 시작, 한국 시간) — 앱 sources.js toWeekly와 같음
function toWeekly_(cs) {
  const out = [];
  cs.forEach((k) => {
    const d = new Date(k.t + 9 * 3600e3), wk = Math.floor((d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3) / (7 * 86400e3));
    const last = out[out.length - 1];
    if (last && last.wk === wk) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v; }
    else out.push({ wk: wk, t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
  });
  return out.map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }));
}

/* ==== zones.js 시작 (앱과 같은 계산식 — alert/build.mjs가 ../zones.js에서 그대로 복사, 직접 고치지 말 것) ==== */
/* 가격 위치 — 매수 검토 구간 계산(공부용)
   여러 근거(지지선·매물대·이동평균·볼린저·피보나치·RSI 과매도·ATR)가 겹치는 가격대를 찾아 점수를 매긴다.
   매수 추천이 아니라 '가격이 어느 위치에 있는지' 공부하기 위한 계산이다.
   입력 candles: 오래된 것부터 [{t, o, h, l, c, v}] */

const ZoneMath = (() => {
  const sma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
  function rsiSeries(c, n = 14) {
    const out = Array(c.length).fill(null);
    if (c.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function atr(cs, n = 14) {
    if (cs.length < n + 1) return null;
    const tr = cs.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1].c), Math.abs(k.l - cs[i - 1].c)) : k.h - k.l));
    let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
    for (let i = n + 1; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
    return a;
  }
  // 좌우 w개보다 낮은 저점(스윙 저점)
  function swingLows(cs, w = 5) {
    const out = [];
    for (let i = w; i < cs.length - w; i++) {
      let ok = true;
      for (let k = i - w; k <= i + w && ok; k++) if (k !== i && cs[k].l < cs[i].l) ok = false;
      if (ok) out.push({ i, p: cs[i].l });
    }
    return out;
  }
  // 거래량 프로파일: 가격대별 거래량 → POC(가장 많이 거래된 가격), VAL(거래 70%가 몰린 구간의 아래 끝)
  function volumeProfile(cs, bins = 40) {
    const lo = Math.min(...cs.map((k) => k.l)), hi = Math.max(...cs.map((k) => k.h));
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins, vol = Array(bins).fill(0);
    for (const k of cs) {
      const a = Math.max(0, Math.floor((k.l - lo) / step)), b = Math.min(bins - 1, Math.floor((k.h - lo) / step));
      const share = k.v / (b - a + 1);
      for (let j = a; j <= b; j++) vol[j] += share;
    }
    const poc = vol.indexOf(Math.max(...vol));
    const total = vol.reduce((x, y) => x + y, 0);
    let inside = vol[poc], down = poc, up = poc;
    while (inside < total * 0.7 && (down > 0 || up < bins - 1)) {
      const nd = down > 0 ? vol[down - 1] : -1, nu = up < bins - 1 ? vol[up + 1] : -1;
      if (nd >= nu) { down--; inside += vol[down]; } else { up++; inside += vol[up]; }
    }
    const mid = (j) => lo + step * (j + 0.5);
    return { poc: mid(poc), val: lo + step * down, vah: lo + step * (up + 1), bins: vol, lo, step };
  }

  const LABEL = {
    swing: '지지선', poc: '매물대 중심(POC)', val: '매물대 하단(VAL)', ma60: '60봉 이동평균', ma120: '120봉 이동평균', ma200: '200봉 이동평균',
    bb: '볼린저 밴드 하단', fib382: '피보나치 38.2%', fib500: '피보나치 50%', fib618: '피보나치 61.8%', rsi: 'RSI 과매도 때 가격',
  };
  const WHY = {
    swing: '과거에 여러 번 떨어지다 멈추고 반등한 가격입니다. 같은 가격에서 사려는 사람이 많았다는 뜻이라 다시 멈출 수 있습니다.',
    poc: '최근 기간에 거래가 가장 많이 일어난 가격입니다. 많은 사람의 평균 매수가에 가까워 지지·저항이 되기 쉽습니다.',
    val: '거래의 70%가 몰린 가격 범위의 아래쪽 끝입니다. 이 아래로 내려가면 거래가 적은 가격대라 빠르게 움직이기 쉽습니다.',
    ma60: '최근 60개 봉의 평균 가격입니다. 중기 추세의 기준선으로 많이 봅니다.',
    ma120: '최근 120개 봉의 평균 가격입니다. 경기·중장기 추세선으로 봅니다.',
    ma200: '최근 200개 봉의 평균 가격입니다. 장기 추세의 기준이라 이 위·아래 여부를 많이 봅니다.',
    bb: '20봉 평균에서 표준편차 2배만큼 아래 가격입니다. 평소 움직임보다 많이 내려온 위치라는 뜻입니다.',
    fib382: '직전 상승폭의 38.2%만큼 되돌린 가격입니다. 얕은 조정 때 자주 멈추는 자리로 봅니다.',
    fib500: '직전 상승폭의 절반을 되돌린 가격입니다.',
    fib618: '직전 상승폭의 61.8%만큼 되돌린 가격입니다. 깊은 조정의 마지노선으로 많이 봅니다.',
    rsi: 'RSI(14)가 30 아래(과매도)였던 때의 종가 중간값입니다. 과거에 많이 팔렸던 가격대입니다.',
  };

  function analyze(cs) {
    const n = cs.length;
    if (n < 60) return { error: '데이터가 60개 봉보다 적어 계산할 수 없습니다' };
    const c = cs.map((k) => k.c), price = c[n - 1];
    const A = atr(cs) || price * 0.02;
    const rsi = rsiSeries(c);
    const cand = [];
    const add = (key, p, extra) => { if (Number.isFinite(p) && p > 0) cand.push({ key, p, label: LABEL[key], why: WHY[key], ...(extra || {}) }); };
    // 1) 지지선: 최근 200봉 스윙 저점을 ATR 절반 안에서 묶음
    const recent = cs.slice(-200), off = n - recent.length;
    const lows = swingLows(recent).map((s) => ({ ...s, i: s.i + off }));
    const groups = [];
    for (const s of lows.sort((a, b) => a.p - b.p)) {
      const g = groups.find((x) => Math.abs(x.p - s.p) <= A * 0.5);
      if (g) { g.list.push(s); g.p = g.list.reduce((x, y) => x + y.p, 0) / g.list.length; } else groups.push({ p: s.p, list: [s] });
    }
    for (const g of groups) add('swing', g.p, { touches: g.list.length });
    // 2) 매물대
    const vp = volumeProfile(cs.slice(-120));
    if (vp) { add('poc', vp.poc); add('val', vp.val); }
    // 3) 이동평균
    for (const m of [60, 120, 200]) { const v = sma(c, m, n - 1); if (v) add('ma' + m, v); }
    // 4) 볼린저 하단(20, 2)
    const m20 = sma(c, 20, n - 1);
    if (m20) { const sd = Math.sqrt(c.slice(-20).reduce((s, x) => s + (x - m20) ** 2, 0) / 20); add('bb', m20 - 2 * sd); }
    // 5) 피보나치: 최근 120봉의 최저점 다음에 나온 최고점 기준 되돌림
    const w = cs.slice(-120), wo = n - w.length;
    let li = 0; w.forEach((k, i) => { if (k.l < w[li].l) li = i; });
    let hi = li; for (let i = li; i < w.length; i++) if (w[i].h > w[hi].h) hi = i;
    let fib = null;
    if (hi > li && w[hi].h > w[li].l * 1.05) {
      const H = w[hi].h, L = w[li].l, R = H - L;
      fib = { high: H, low: L, hiI: hi + wo, loI: li + wo };
      add('fib382', H - R * 0.382); add('fib500', H - R * 0.5); add('fib618', H - R * 0.618);
    }
    // 6) RSI 과매도 때 종가 중간값(최근 200봉)
    const os = []; for (let i = Math.max(0, n - 200); i < n; i++) if (rsi[i] != null && rsi[i] < 30) os.push(c[i]);
    if (os.length >= 2) { os.sort((a, b) => a - b); add('rsi', os[Math.floor(os.length / 2)], { count: os.length }); }

    // 현재가 아래(+1% 위까지) 근거만 → ATR 0.6배 안의 근거끼리 묶어 구간을 만든다
    const below = cand.filter((x) => x.p <= price * 1.01).sort((a, b) => b.p - a.p);
    const zones = [];
    for (const x of below) {
      const z = zones.find((q) => x.p >= q.min - A * 0.6 && x.p <= q.max + A * 0.6);
      if (z) { z.items.push(x); z.min = Math.min(z.min, x.p); z.max = Math.max(z.max, x.p); } else zones.push({ min: x.p, max: x.p, items: [x] });
    }
    const out = zones.map((z) => {
      const kinds = new Set(z.items.map((x) => (x.key.startsWith('fib') ? 'fib' : x.key.startsWith('ma') ? 'ma' : x.key)));
      const touchBonus = Math.min(1, z.items.filter((x) => x.key === 'swing').reduce((s, x) => s + Math.max(0, x.touches - 1), 0) * 0.5);
      const score = kinds.size + touchBonus;
      const low = z.min - A * 0.25, high = Math.min(z.max + A * 0.25, price * 1.01);
      return { low, high, mid: (low + high) / 2, score: Math.round(score * 10) / 10, kinds: kinds.size, items: z.items.sort((a, b) => b.p - a.p), distPct: ((z.max - price) / price) * 100 };
    }).filter((z) => z.kinds >= 2).sort((a, b) => b.score - a.score || b.high - a.high).slice(0, 4).sort((a, b) => b.high - a.high);

    const H52 = Math.max(...cs.slice(-365).map((k) => k.h)), L52 = Math.min(...cs.slice(-365).map((k) => k.l));
    const ma200 = sma(c, 200, n - 1), ma60 = sma(c, 60, n - 1);
    return {
      price, atr: A, rsi: rsi[n - 1], zones: out, candidates: cand, vp, fib,
      ma: { 20: c.map((_, i) => sma(c, 20, i)), 60: c.map((_, i) => sma(c, 60, i)), 120: c.map((_, i) => sma(c, 120, i)), 200: c.map((_, i) => sma(c, 200, i)) },
      range: { high: H52, low: L52, pos: H52 > L52 ? ((price - L52) / (H52 - L52)) * 100 : null, bars: Math.min(365, n) },
      trend: ma200 ? (price > ma200 ? '200봉 평균 위(장기 상승 쪽)' : '200봉 평균 아래(장기 하락 쪽)') : ma60 ? (price > ma60 ? '60봉 평균 위' : '60봉 평균 아래') : '',
    };
  }
  return { analyze, rsiSeries, atr, swingLows, volumeProfile, LABEL, WHY };
})();
/* ==== zones.js 끝 ==== */

/* ───────── 코인선물 현재가: 바이낸스(구글 서버 위치에서 막힐 수 있음) → OKX ───────── */
function cfutPrice_(sym) {
  try {
    const r = UrlFetchApp.fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + encodeURIComponent(sym), { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) { const p = Number(JSON.parse(r.getContentText()).price); if (p) return p; }
  } catch (e) { /* 다음 */ }
  try {
    const inst = sym.replace(/USDT$/, '') + '-USDT-SWAP';
    const r = UrlFetchApp.fetch('https://www.okx.com/api/v5/market/ticker?instId=' + encodeURIComponent(inst), { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) { const j = JSON.parse(r.getContentText()); const p = Number(j.data && j.data[0] && j.data[0].last); if (p) return p; }
  } catch (e) { /* 없음 */ }
  return 0;
}

/* ───────── Alpha Vantage(해외주식): 키는 여기만, 결과는 캐시(무료 하루 25회) ───────── */
const AV_FN_ = { TIME_SERIES_DAILY: 6 * 3600, TIME_SERIES_WEEKLY: 24 * 3600, SYMBOL_SEARCH: 7 * 86400, GLOBAL_QUOTE: 1800 };
function avRelay_(d) {
  const fn = String(d.fn || '');
  if (!AV_FN_[fn]) return { ok: false, error: '허용하지 않는 Alpha Vantage 기능입니다' };
  if (!PropertiesService.getScriptProperties().getProperty('ALPHAVANTAGE_API_KEY')) return { ok: false, error: '스크립트 속성에 ALPHAVANTAGE_API_KEY가 없습니다' };
  const q = { function: fn };
  if (fn === 'SYMBOL_SEARCH') q.keywords = String(d.keywords || '').slice(0, 40);
  else q.symbol = String(d.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 16);
  if (!(q.symbol || q.keywords)) return { ok: false, error: '종목을 넣어 주세요' };
  return { ok: true, data: avFetch_(q, AV_FN_[fn]) };
}
function avFetch_(q, ttl) {
  const cache = CacheService.getScriptCache();
  const ck = 'av_' + Utilities.base64EncodeWebSafe(JSON.stringify(q)).slice(0, 200);
  const hit = ttl ? cache.get(ck) : null;
  if (hit) return JSON.parse(hit);
  const key = PropertiesService.getScriptProperties().getProperty('ALPHAVANTAGE_API_KEY');
  const url = 'https://www.alphavantage.co/query?' + Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&') + '&apikey=' + encodeURIComponent(key);
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Alpha Vantage 응답 오류 ' + r.getResponseCode());
  const t = r.getContentText();
  const j = JSON.parse(t);
  if (ttl && !j.Note && !j.Information && !j['Error Message'] && t.length < 95000) cache.put(ck, t, Math.min(ttl, 21600));
  return j;
}

/* ───────── 한국투자증권(국내주식·해외선물): 토큰은 하루 한 번 발급해 속성에 보관 ───────── */
function kisBase_() { return String(PropertiesService.getScriptProperties().getProperty('KIS_ENV') || 'real').toLowerCase() === 'demo' ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443'; }
function kisToken_() {
  const P = PropertiesService.getScriptProperties();
  const saved = JSON.parse(P.getProperty('KIS_TOKEN') || '{}');
  if (saved.token && saved.base === kisBase_() && saved.exp > Date.now() + 600e3) return saved.token;
  const r = UrlFetchApp.fetch(kisBase_() + '/oauth2/tokenP', { method: 'post', contentType: 'application/json; charset=utf-8', muteHttpExceptions: true,
    payload: JSON.stringify({ grant_type: 'client_credentials', appkey: P.getProperty('KIS_APP_KEY'), appsecret: P.getProperty('KIS_APP_SECRET') }) });
  const j = JSON.parse(r.getContentText() || '{}');
  if (!j.access_token) throw new Error('한국투자증권 토큰 발급 실패: ' + (j.error_description || j.msg1 || r.getResponseCode()) + ' (토큰은 1분에 한 번만 발급됩니다)');
  P.setProperty('KIS_TOKEN', JSON.stringify({ token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000, base: kisBase_() }));
  return j.access_token;
}
function kisGet_(path, trId, params) {
  const P = PropertiesService.getScriptProperties();
  const url = kisBase_() + path + '?' + Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + kisToken_(), appkey: P.getProperty('KIS_APP_KEY'), appsecret: P.getProperty('KIS_APP_SECRET'), tr_id: trId, custtype: 'P' } });
  const j = JSON.parse(r.getContentText() || '{}');
  if (j.rt_cd && j.rt_cd !== '0') throw new Error('한국투자증권: ' + (j.msg1 || j.msg_cd));
  if (r.getResponseCode() !== 200) throw new Error('한국투자증권 응답 오류 ' + r.getResponseCode());
  return j;
}
const ymd_ = (dt) => Utilities.formatDate(dt, 'Asia/Seoul', 'yyyyMMdd');
function krCandles_(code, period) {
  // 한 번에 최대 100개 → 일봉은 두 번 받아 최대 200개
  const out = {};
  let end = new Date();
  const span = period === 'W' ? 800 : 150; // 조회 기간(일)
  for (let k = 0; k < (period === 'W' ? 1 : 2); k++) {
    const start = new Date(end.getTime() - span * 86400e3);
    const j = kisGet_('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd_(start), FID_INPUT_DATE_2: ymd_(end), FID_PERIOD_DIV_CODE: period, FID_ORG_ADJ_PRC: '0' });
    (j.output2 || []).forEach((x) => { if (x.stck_bsop_date && Number(x.stck_clpr)) out[x.stck_bsop_date] = { t: Date.parse(x.stck_bsop_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00+09:00'), o: Number(x.stck_oprc), h: Number(x.stck_hgpr), l: Number(x.stck_lwpr), c: Number(x.stck_clpr), v: Number(x.acml_vol) }; });
    end = new Date(start.getTime() - 86400e3);
    if (k === 0) Utilities.sleep(80);
  }
  return Object.keys(out).sort().map((k) => out[k]);
}
// 해외선물 일봉: 응답 칸 이름이 문서마다 달라 후보를 차례로 찾는다(처음 연결 때 실제 응답으로 확인 필요)
function pick_(o, names) { for (let i = 0; i < names.length; i++) { const v = o[names[i]]; if (v != null && v !== '') return v; } return null; }
function ffCandles_(code, exch, pages) {
  const out = {};
  let key = '';
  for (let k = 0; k < (pages || 3); k++) {
    const j = kisGet_('/uapi/overseas-futureoption/v1/quotations/daily-ccnl', 'HHDFC55020100', { SRS_CD: code, EXCH_CD: exch, START_DATE_TIME: '', CLOSE_DATE_TIME: ymd_(new Date()), QRY_TP: key ? 'P' : 'Q', QRY_CNT: '40', QRY_GAP: '', INDEX_KEY: key });
    const rows = j.output2 || [];
    if (!rows.length) break;
    rows.forEach((x) => {
      const dt = String(pick_(x, ['data_date', 'bass_dt', 'trd_dt', 'stck_bsop_date', 'xymd']) || '');
      const c = Number(pick_(x, ['last_price', 'clos_pric', 'clpr', 'ovrs_nmix_prpr', 'close_price']));
      if (!/^\d{8}$/.test(dt) || !c) return;
      out[dt] = { t: Date.parse(dt.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00Z'), o: Number(pick_(x, ['open_price', 'oprc', 'open_pric'])) || c, h: Number(pick_(x, ['high_price', 'hgpr', 'high_pric'])) || c, l: Number(pick_(x, ['low_price', 'lwpr', 'low_pric'])) || c, c: c, v: Number(pick_(x, ['vol', 'tot_vol', 'acml_vol', 'cntg_vol'])) || 0 };
    });
    if (!Object.keys(out).length) throw new Error('해외선물 응답 칸 이름을 알 수 없습니다: ' + Object.keys(rows[0]).slice(0, 12).join(', '));
    key = (j.output1 && (j.output1.index_key || j.output1.INDEX_KEY)) || '';
    if (!key) break;
    Utilities.sleep(80);
  }
  return Object.keys(out).sort().map((k) => out[k]);
}
function kisRelay_(d) {
  const P = PropertiesService.getScriptProperties();
  if (!(P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET'))) return { ok: false, error: '스크립트 속성에 KIS_APP_KEY·KIS_APP_SECRET이 없습니다' };
  const cache = CacheService.getScriptCache();
  if (d.kind === 'krCandles') {
    const code = String(d.code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return { ok: false, error: '종목코드는 숫자 6자리입니다' };
    const period = d.period === 'W' ? 'W' : 'D';
    const ck = 'kr_' + code + '_' + period, hit = cache.get(ck);
    if (hit) return { ok: true, candles: JSON.parse(hit), cached: true };
    const cs = krCandles_(code, period);
    const t = JSON.stringify(cs); if (t.length < 95000) cache.put(ck, t, 1800);
    return { ok: true, candles: cs };
  }
  if (d.kind === 'ffCandles') {
    const code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), exch = String(d.exch || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!code || !exch) return { ok: false, error: '종목코드와 거래소가 필요합니다' };
    const ck = 'ff_' + code + '_' + exch, hit = cache.get(ck);
    if (hit) return { ok: true, candles: JSON.parse(hit), cached: true };
    const cs = ffCandles_(code, exch, 3);
    const t = JSON.stringify(cs); if (t.length < 95000) cache.put(ck, t, 1800);
    return { ok: true, candles: cs };
  }
  return { ok: false, error: '알 수 없는 요청' };
}

/* ───────── 공공데이터포털 '금융위원회_주식시세정보'(국내주식): 계좌 없이, 하루 1번(다음 영업일 13시 이후) 갱신 ─────────
   출처: 금융위원회(공공데이터포털, 공공누리 4유형 — 출처표시·상업적 이용 금지·변경 금지). 개인 공부용으로만. */
const KRX_URL_ = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
function krxKey_() {
  const k = String(PropertiesService.getScriptProperties().getProperty('DATA_GO_KR_KEY') || '').trim();
  return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k); // '인코딩' 키를 넣어도, '디코딩' 키를 넣어도 됨
}
function krxGet_(params) {
  const url = KRX_URL_ + '?serviceKey=' + krxKey_() + '&resultType=json&' + Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const t = r.getContentText();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error('공공데이터 응답을 읽지 못함(' + r.getResponseCode() + '): ' + t.slice(0, 120)); }
  const err = j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader;
  if (err) throw new Error('공공데이터: ' + (err.returnAuthMsg || err.errMsg) + ' (서비스키·활용신청 승인 확인)');
  const h = j.response && j.response.header;
  if (h && h.resultCode !== '00') throw new Error('공공데이터: ' + h.resultMsg);
  const it = j.response && j.response.body && j.response.body.items && j.response.body.items.item;
  return Array.isArray(it) ? it : it ? [it] : [];
}
function krxCandles_(code) {
  const begin = Utilities.formatDate(new Date(Date.now() - 800 * 86400e3), 'Asia/Seoul', 'yyyyMMdd');
  const rows = krxGet_({ likeSrtnCd: code, beginBasDt: begin, numOfRows: 700, pageNo: 1 }).filter((x) => String(x.srtnCd) === code);
  const out = {};
  rows.forEach((x) => { const c = Number(x.clpr); if (!/^\d{8}$/.test(String(x.basDt)) || !c) return; out[x.basDt] = { t: Date.parse(String(x.basDt).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00+09:00'), o: Number(x.mkp) || c, h: Number(x.hipr) || c, l: Number(x.lopr) || c, c: c, v: Number(x.trqu) || 0 }; });
  return Object.keys(out).sort().map((k) => out[k]);
}
function krxCandlesCached_(code) {
  const cache = CacheService.getScriptCache(), ck = 'krx_' + code, hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const cs = krxCandles_(code);
  const t = JSON.stringify(cs); if (t.length < 95000) cache.put(ck, t, 3 * 3600);
  return cs;
}
function krxRelay_(d) {
  if (!PropertiesService.getScriptProperties().getProperty('DATA_GO_KR_KEY')) return { ok: false, error: '스크립트 속성에 DATA_GO_KR_KEY가 없습니다' };
  if (d.kind === 'candles') {
    const code = String(d.code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return { ok: false, error: '종목코드는 숫자 6자리입니다' };
    return { ok: true, candles: krxCandlesCached_(code) };
  }
  if (d.kind === 'search') {
    const q = String(d.q || '').trim().slice(0, 20);
    if (!q) return { ok: true, items: [] };
    const cache = CacheService.getScriptCache(), ck = 'krxs_' + Utilities.base64EncodeWebSafe(q).slice(0, 100), hit = cache.get(ck);
    if (hit) return { ok: true, items: JSON.parse(hit) };
    const begin = Utilities.formatDate(new Date(Date.now() - 10 * 86400e3), 'Asia/Seoul', 'yyyyMMdd');
    const rows = krxGet_(/^\d{1,6}$/.test(q) ? { likeSrtnCd: q, beginBasDt: begin, numOfRows: 200, pageNo: 1 } : { likeItmsNm: q, beginBasDt: begin, numOfRows: 200, pageNo: 1 });
    const seen = {}, items = [];
    rows.forEach((x) => { if (!seen[x.srtnCd]) { seen[x.srtnCd] = 1; items.push({ sym: String(x.srtnCd), name: String(x.itmsNm), sub: x.srtnCd + ' · ' + (x.mrktCtg || '') }); } });
    const out = items.slice(0, 30);
    cache.put(ck, JSON.stringify(out), 6 * 3600);
    return { ok: true, items: out };
  }
  return { ok: false, error: '알 수 없는 요청' };
}

/** DATA_GO_KR_KEY를 넣은 뒤 실행: 삼성전자 일봉을 받아 봄(키 값은 찍지 않음) */
function 국내주식연결확인() {
  const cs = krxCandles_('005930');
  Logger.log('삼성전자 일봉 ' + cs.length + '개 받음. 마지막: ' + (cs.length ? new Date(cs[cs.length - 1].t + 9 * 3600e3).toISOString().slice(0, 10) + ' 종가 ' + cs[cs.length - 1].c : '없음'));
  const s = krxRelay_({ kind: 'search', q: '삼성' });
  Logger.log('이름 검색 "삼성": ' + (s.items || []).slice(0, 5).map((x) => x.name + '(' + x.sym + ')').join(', '));
}

/** 처음 한 번 실행: 10분마다 가격확인 트리거 만들기 */
function 알림켜기() {
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === '가격확인') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('가격확인').timeBased().everyMinutes(10).create();
  Logger.log('10분마다 가격확인을 켰습니다.');
}
/** 알림 끄기 */
function 알림끄기() {
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === '가격확인') ScriptApp.deleteTrigger(t); });
  Logger.log('가격확인을 껐습니다.');
}
/** 편집기에서 실행해 설정 확인(키·토큰 값은 찍지 않음) */
function 설정확인() {
  const P = PropertiesService.getScriptProperties();
  Logger.log('텔레그램 봇 토큰: ' + (P.getProperty('TELEGRAM_BOT_TOKEN') ? '있음' : '없음') + ' / 채팅 ID: ' + (P.getProperty('TELEGRAM_CHAT_ID') ? '있음' : '없음') + ' / 디스코드 웹훅: ' + (discordUrl_() ? '있음' : (P.getProperty('DISCORD_WEBHOOK_URL') ? '모양이 틀림' : '없음')) + ' / APP_KEY: ' + (P.getProperty('APP_KEY') ? '있음' : '없음') + ' / 자동 확인: ' + (hasTrigger_() ? '켜짐' : '꺼짐') + ' / 알림 종목: ' + watch_().length);
  Logger.log('Alpha Vantage 키: ' + (P.getProperty('ALPHAVANTAGE_API_KEY') ? '있음' : '없음') + ' / 공공데이터 키: ' + (P.getProperty('DATA_GO_KR_KEY') ? '있음' : '없음') + ' / 한국투자증권 키: ' + (P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET') ? '있음' : '없음') + ' (' + (P.getProperty('KIS_ENV') || 'real') + ')');
  const rc = watchMeta_().recalc;
  Logger.log('구간 자동 재계산(매일 ' + RECALC_HOUR + '시 이후): ' + (rc ? '마지막 ' + Utilities.formatDate(new Date(rc.at), 'Asia/Seoul', 'M/d HH:mm') + ' · 성공 ' + rc.done + ' · 실패 ' + rc.fail.length + (rc.fail.length ? ' (' + rc.fail.join(' / ') + ')' : '') : '아직 실행 전'));
}
/** 한국투자증권 키를 넣은 뒤 한 번 실행: 토큰 발급·삼성전자 일봉 받기가 되는지 확인(값은 찍지 않음) */
function 한투연결확인() {
  const cs = krCandles_('005930', 'D');
  Logger.log('국내주식 일봉 ' + cs.length + '개 받음. 마지막: ' + (cs.length ? new Date(cs[cs.length - 1].t).toISOString().slice(0, 10) + ' 종가 ' + cs[cs.length - 1].c : '없음'));
}

/** 키 없이 실행: 이 스크립트(구글 서버)에서 각 시세 서버에 닿는지 확인(키·토큰 값은 쓰지 않음) */
function 연결점검() {
  const line = (name, fn) => { try { Logger.log('✅ ' + name + ': ' + fn()); } catch (e) { Logger.log('❌ ' + name + ': ' + (e && e.message || e)); } };
  line('업비트(코인)', () => { const r = upbitRelay_('/ticker?markets=KRW-BTC'); if (!r.ok) throw new Error(r.error); return '비트코인 ' + fmt_(r.data[0].trade_price) + '원'; });
  line('바이낸스 선물(코인선물)', () => { const r = UrlFetchApp.fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', { muteHttpExceptions: true }); if (r.getResponseCode() !== 200) throw new Error('응답 ' + r.getResponseCode() + ' (이 서버 위치에서 막힘 → OKX로 대신 확인)'); return 'BTCUSDT ' + JSON.parse(r.getContentText()).price; });
  line('OKX 선물(코인선물 예비)', () => { const r = UrlFetchApp.fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP', { muteHttpExceptions: true }); if (r.getResponseCode() !== 200) throw new Error('응답 ' + r.getResponseCode()); return 'BTC-USDT-SWAP ' + JSON.parse(r.getContentText()).data[0].last; });
  line('코인선물 알림용 가격(바이낸스→OKX)', () => { const p = cfutPrice_('BTCUSDT'); if (!p) throw new Error('둘 다 실패'); return String(p); });
  line('Alpha Vantage(해외주식, 공개 demo 키로 IBM)', () => { const r = UrlFetchApp.fetch('https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=demo', { muteHttpExceptions: true }); const j = JSON.parse(r.getContentText()); if (!j['Global Quote']) throw new Error(j.Note || j.Information || '응답 이상'); return 'IBM $' + j['Global Quote']['05. price']; });
  line('공공데이터포털 주식시세(국내주식, 키 없이)', () => { const r = UrlFetchApp.fetch(KRX_URL_ + '?serviceKey=TEST&resultType=json&numOfRows=1', { muteHttpExceptions: true }); const t = r.getContentText(); if (!/SERVICE_KEY|등록되지/.test(t)) throw new Error('응답 ' + r.getResponseCode() + ': ' + t.slice(0, 80)); return '서버에 닿음(서비스키를 넣으면 시세 받기 가능)'; });
  line('한국투자증권 서버 접속(포트 9443, 키 없이)', () => { const r = UrlFetchApp.fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', { method: 'post', contentType: 'application/json', payload: '{}', muteHttpExceptions: true }); return '응답 ' + r.getResponseCode() + ' — 서버에 닿음(키를 넣으면 토큰 발급 가능)'; });
}
/** 텔레그램·디스코드 값을 넣은 뒤 실행: 테스트 알림 한 통 보내기 */
function 테스트알림() { Logger.log(JSON.stringify(send_('✅ 가격 위치 알림 테스트입니다(편집기에서 실행). 이 메시지가 보이면 연결이 잘 된 것입니다.'))); }
/** ALPHAVANTAGE_API_KEY를 넣은 뒤 실행: 내 키로 AAPL 일봉을 받아 봄(키 값은 찍지 않음) */
function 해외주식연결확인() {
  const j = avFetch_({ function: 'TIME_SERIES_DAILY', symbol: 'AAPL' }, 0);
  const k = Object.keys(j).find((x) => /Time Series/.test(x));
  Logger.log(k ? 'AAPL 일봉 ' + Object.keys(j[k]).length + '개 받음(무료 키는 최근 100개)' : '실패: ' + (j.Note || j.Information || j['Error Message'] || '응답 이상'));
}

/* 업비트 공개 시세 중계: 업비트는 브라우저 직접 요청을 10초에 1번만 허용하므로 앱 대신 받아 준다.
   정해진 시세 주소 모양만 허용(주문·계좌 주소는 거절). 같은 주소는 30초 동안 캐시. */
function upbitRelay_(path) {
  const ok = /^\/candles\/(days|minutes\/240|minutes\/60)\?market=KRW-[A-Z0-9]+&count=\d{1,3}(&to=[0-9A-Za-z%:.-]+)?$/.test(path) ||
    /^\/ticker\?markets=KRW-[A-Z0-9]+(,KRW-[A-Z0-9]+){0,29}$/.test(path) || path === '/market/all?isDetails=false';
  if (!ok) return { ok: false, error: '허용하지 않는 업비트 주소입니다' };
  const cache = CacheService.getScriptCache(), ck = 'ub_' + Utilities.base64EncodeWebSafe(path).slice(0, 200);
  const hit = cache.get(ck);
  if (hit) return { ok: true, data: JSON.parse(hit), cached: true };
  for (let i = 0; i < 3; i++) {
    const r = UrlFetchApp.fetch('https://api.upbit.com/v1' + path, { muteHttpExceptions: true });
    const c = r.getResponseCode();
    if (c === 200) { const t = r.getContentText(); if (t.length < 95000) cache.put(ck, t, 30); return { ok: true, data: JSON.parse(t) }; }
    if (c !== 429) return { ok: false, error: '업비트 응답 오류 ' + c };
    Utilities.sleep(300 * (i + 1));
  }
  return { ok: false, error: '업비트 요청이 많아 잠시 뒤 다시 시도하세요' };
}

function watch_() {
  try {
    const items = (JSON.parse(readWatchRaw_()).items) || [];
    return items.map((x) => (x.cat ? x : { cat: 'coin', sym: x.market, ex: '', name: x.name, tf: x.tf, zones: x.zones })); // 예전(코인만) 저장분도 읽음
  } catch (e) { return []; }
}
function hasTrigger_() { return ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === '가격확인'); }
// 설정된 곳(텔레그램·디스코드) 모두에 보낸다. 한 곳이라도 성공하면 통과, 모두 실패하면 오류
function send_(text) {
  const P = PropertiesService.getScriptProperties();
  const token = (P.getProperty('TELEGRAM_BOT_TOKEN') || '').trim(), chat = (P.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const hook = discordUrl_();
  if (!(token && chat) && !hook) throw new Error('스크립트 속성에 텔레그램(TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID) 또는 디스코드(DISCORD_WEBHOOK_URL)가 없습니다');
  const done = [], fail = [];
  if (token && chat) {
    const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true }), muteHttpExceptions: true });
    (r.getResponseCode() === 200 ? done : fail).push('텔레그램' + (r.getResponseCode() === 200 ? '' : '(' + r.getResponseCode() + ')'));
  }
  if (hook) {
    const r = UrlFetchApp.fetch(hook, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ username: '가격 위치', content: text.slice(0, 1990), allowed_mentions: { parse: [] } }), muteHttpExceptions: true });
    const c = r.getResponseCode();
    (c === 200 || c === 204 ? done : fail).push('디스코드' + (c === 200 || c === 204 ? '' : '(' + c + ')'));
  }
  if (!done.length) throw new Error('알림 전송 실패: ' + fail.join(', '));
  return { done: done, fail: fail };
}
// 디스코드 웹훅 주소는 discord.com/api/webhooks/ 모양만 허용(다른 곳으로 새지 않게)
function discordUrl_() {
  const u = (PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL') || '').trim();
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u) ? u : '';
}
function fmt_(p) { const a = Math.abs(p), d = a >= 100 ? 0 : a >= 1 ? 2 : 4; return Number(p).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
