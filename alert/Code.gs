/**
 * 가격 위치 앱 — 알림·시세 중계 스크립트 (Google Apps Script 웹 앱 + 10분 자동 확인)
 *
 * 1) 앱이 계산한 '검토 구간'을 저장해 두고, 현재가가 구간에 '들어올 때' 텔레그램·디스코드로 알린다.
 * 2) 키가 필요한 시세(해외주식 Alpha Vantage, 국내주식·해외선물 한국투자증권)를 앱 대신 받아 준다(키는 여기만 보관).
 * 3) 업비트는 브라우저 직접 요청이 10초 1회로 막혀 있어 앱 대신 받아 준다.
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
 *
 * 처음 한 번: 편집기에서 '알림켜기' 실행 → 10분마다 '가격확인'이 돌도록 트리거가 만들어진다.
 */

const VERSION = 4;
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
        av: !!P.getProperty('ALPHAVANTAGE_API_KEY'), kis: !!(P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET')), trigger: hasTrigger_(), watching: watch_().length });
    }
    if (d.action === 'upbit') return json_(upbitRelay_(String(d.path || '')));
    if (d.action === 'av') return json_(avRelay_(d));
    if (d.action === 'kis') return json_(kisRelay_(d));
    if (d.action === 'test') { const r = send_('✅ 가격 위치 알림 테스트입니다. 이 메시지가 보이면 연결이 잘 된 것입니다.'); return json_({ ok: true, sent: r }); }
    if (d.action === 'saveWatch') {
      const items = (d.items || []).slice(0, 40).map((x) => ({
        cat: CATS_.indexOf(x.cat) >= 0 ? x.cat : 'coin',
        sym: String(x.sym || x.market || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 24),
        ex: String(x.ex || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8),
        name: String(x.name || '').slice(0, 40), tf: String(x.tf || '').slice(0, 10),
        zones: (x.zones || []).slice(0, 5).map((z) => ({ low: Number(z.low), high: Number(z.high), score: Number(z.score) || 0, labels: (z.labels || []).slice(0, 8).map(String) })).filter((z) => z.low > 0 && z.high >= z.low),
      })).filter((x) => x.sym && (x.cat !== 'coin' || /^KRW-[A-Z0-9]+$/.test(x.sym)));
      P.setProperty('WATCH', JSON.stringify({ at: new Date().toISOString(), items: items }));
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
  // 국내주식·해외선물: 한국투자증권
  if (P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET')) {
    items.filter((x) => x.cat === 'kr').forEach((x) => { try { const o = kisGet_('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: x.sym }); const p = Number(o.output && o.output.stck_prpr); if (p) price['kr:' + x.sym] = p; } catch (e) { /* 다음에 */ } });
    items.filter((x) => x.cat === 'ffut').forEach((x) => { try { const cs = ffCandles_(x.sym, x.ex, 1); if (cs.length) price['ffut:' + x.sym] = cs[cs.length - 1].c; } catch (e) { /* 다음에 */ } });
  }
  const zid = (x, z) => x.cat + ':' + x.sym + '|' + z.low.toPrecision(8) + '|' + z.high.toPrecision(8);
  const state = JSON.parse(P.getProperty('STATE') || '{}');
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
          '근거: ' + z.labels.join(', ') + '\n\n' +
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
  P.setProperty('STATE', JSON.stringify(state));
}

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
  Logger.log('Alpha Vantage 키: ' + (P.getProperty('ALPHAVANTAGE_API_KEY') ? '있음' : '없음') + ' / 한국투자증권 키: ' + (P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET') ? '있음' : '없음') + ' (' + (P.getProperty('KIS_ENV') || 'real') + ')');
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
    const items = (JSON.parse(PropertiesService.getScriptProperties().getProperty('WATCH') || '{}').items) || [];
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
