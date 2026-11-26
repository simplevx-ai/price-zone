/**
 * 가격 위치 앱 — 알림·시세 중계 스크립트 (Google Apps Script 웹 앱 + 10분 자동 확인)
 *
 * 1) 앱이 계산한 '검토 구간'을 저장해 두고, 현재가가 구간에 '들어올 때' 텔레그램·디스코드로 알린다.
 * 2) 키가 필요한 시세(해외주식 Alpha Vantage, 국내주식·해외선물 한국투자증권)를 앱 대신 받아 준다(키는 여기만 보관).
 * 3) 업비트는 브라우저 직접 요청이 10초 1회로 막혀 있어 앱 대신 받아 준다.
 * 4) 매일 14시(한국 시간) 이후 한 번, 앱을 열지 않아도 알림 종목의 검토 구간을 스스로 다시 계산한다(앱과 같은 계산식).
 * 5) 🤖 AI 분석: 앱이 단계별로 보내는 글을 Claude(claude-opus-5-5)에 대신 보내고 답을 돌려준다(키는 여기만, 하루 호출 한도).
 * 6) 📡 나스닥 신호: 10분마다 OKX 공개 시세(QQQ·TQQQ·SQQQ 무기한 선물)로 규칙 신호를 계산해 바뀔 때 알린다(자동 주문 없음).
 * 7) 📊 ETF 아침 정리: 매일 한국 시간 9시 10분쯤 OKX ETF 선물의 반등·하락 전환 점수·거래대금·변동성 순위를 보낸다(자동 주문 없음).
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
 *   ANTHROPIC_API_KEY    Claude API 키 — 🤖 AI 분석(종목 1개에 약 13번 호출, 모델 claude-opus-5-5)
 *   AI_DAILY_CALLS       (선택) 하루 AI 호출 한도, 비우면 130번(약 10종목)
 *
 * 처음 한 번: 편집기에서 '알림켜기' 실행 → 10분마다 '가격확인'이 돌도록 트리거가 만들어진다.
 */

const VERSION = 12;
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
        av: !!P.getProperty('ALPHAVANTAGE_API_KEY'), kis: !!(P.getProperty('KIS_APP_KEY') && P.getProperty('KIS_APP_SECRET')), krx: !!P.getProperty('DATA_GO_KR_KEY'), trigger: hasTrigger_(), watching: watch_().length, recalc: watchMeta_().recalc || null,
        ai: !!P.getProperty('ANTHROPIC_API_KEY'), aiModel: AI_MODEL_, aiToday: aiUsage_(), aiCap: aiCap_(), nq: nqStatus_(), scan: scanStatus_(), strong: strongStatus_(), coinStrong: coinStrongStatus_() });
    }
    if (d.action === 'upbit') return json_(upbitRelay_(String(d.path || '')));
    if (d.action === 'av') return json_(avRelay_(d));
    if (d.action === 'kis') return json_(kisRelay_(d));
    if (d.action === 'krx') return json_(krxRelay_(d));
    if (d.action === 'claude') return json_(claudeRelay_(d));
    if (d.action === 'saveScan') { P.setProperty('SCAN_CFG', JSON.stringify({ enabled: !!d.enabled, at: new Date().toISOString() })); return json_({ ok: true, enabled: !!d.enabled }); }
    if (d.action === 'saveCoinStrong') { P.setProperty('COIN_STRONG_CFG', JSON.stringify({ enabled: !!d.enabled, at: new Date().toISOString() })); return json_({ ok: true, enabled: !!d.enabled }); }
    if (d.action === 'saveStrong') { P.setProperty('STRONG_CFG', JSON.stringify({ enabled: !!d.enabled, at: new Date().toISOString() })); return json_({ ok: true, enabled: !!d.enabled }); }
    if (d.action === 'saveNq') { P.setProperty('NQ_CFG', JSON.stringify({ enabled: !!d.enabled, at: new Date().toISOString() })); if (d.enabled) P.deleteProperty('NQ_STATE'); return json_({ ok: true, enabled: !!d.enabled }); }
    if (d.action === 'test') { const r = send_('✅ 가격 위치 알림 테스트입니다. 이 메시지가 보이면 연결이 잘 된 것입니다.'); return json_({ ok: true, sent: r }); }
    if (d.action === 'saveWatch') {
      const old = {}; watch_().forEach((x) => { old[x.cat + ':' + x.sym] = x; });
      const items0 = (d.items || []).slice(0, 40).map((x) => ({
        cat: CATS_.indexOf(x.cat) >= 0 ? x.cat : 'coin',
        sym: String(x.sym || x.market || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 24),
        ex: String(x.ex || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8),
        name: String(x.name || '').slice(0, 40), tf: String(x.tf || '').slice(0, 10),
        tfk: TFK_[x.tfk] ? x.tfk : TFK_LABEL_[x.tf] || 'day', calcAt: new Date().toISOString(),
        zones: (x.zones || []).slice(0, 5).map((z) => ({ low: Number(z.low), high: Number(z.high), score: Number(z.score) || 0, labels: (z.labels || []).slice(0, 10).map(String), react: String(z.react || '').slice(0, 60) })).filter((z) => z.low > 0 && z.high >= z.low),
        src: String(x.src || '').slice(0, 40), keep: !!x.keep,
      })).filter((x) => x.sym && (x.cat !== 'coin' || /^KRW-[A-Z0-9]+$/.test(x.sym)));
      // 같은 종목은 하나만(뒤에 온 것), 앱이 시세를 못 받아 구간 없이 보낸 종목(keep)은 스크립트가 가진 예전 구간을 그대로 씀
      const seen = {}, items = [];
      items0.forEach((x) => { seen[x.cat + ':' + x.sym] = x; });
      Object.keys(seen).forEach((k) => { const x = seen[k], o = old[k]; if (x.keep && !x.zones.length && o) { x.zones = o.zones || []; x.calcAt = o.calcAt; x.rc = o.rc; } delete x.keep; items.push(x); });
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
  try { nqCheck_(true); } catch (e) { Logger.log('나스닥 신호 확인 실패: ' + (e && e.message || e)); }
  try { scanDaily_(); } catch (e) { Logger.log('ETF 아침 정리 실패: ' + (e && e.message || e)); }
  try { strongCheck_(false); } catch (e) { Logger.log('강한 신호 확인 실패: ' + (e && e.message || e)); }
  try { coinStrongCheck_(false); } catch (e) { Logger.log('코인 강한 신호 확인 실패: ' + (e && e.message || e)); }
  const items = watch_();
  if (!items.length) return;
  const P = PropertiesService.getScriptProperties();
  const now = Date.now();
  const price = {};
  // 코인: 업비트 한 번에
  const coins = items.filter((x) => x.cat === 'coin');
  if (coins.length) {
    const ms = Array.from(new Set(coins.map((x) => x.sym)));
    // 업비트는 모르는 종목이 섞이면 전체를 거절 → 한 번에 시도하고, 못 받은 종목은 빗썸에서
    try { const r = UrlFetchApp.fetch('https://api.upbit.com/v1/ticker?markets=' + ms.join(','), { muteHttpExceptions: true }); if (r.getResponseCode() === 200) JSON.parse(r.getContentText()).forEach((t) => { price['coin:' + t.market] = t.trade_price; }); } catch (e) { /* 빗썸으로 */ }
    const rest = ms.filter((m) => !price['coin:' + m]);
    if (rest.length) { try { const r = UrlFetchApp.fetch('https://api.bithumb.com/v1/ticker?markets=' + rest.join(','), { muteHttpExceptions: true }); if (r.getResponseCode() === 200) JSON.parse(r.getContentText()).forEach((t) => { price['coin:' + t.market] = t.trade_price; }); } catch (e) { /* 다음에 */ } }
  }
  // 코인선물: 바이낸스 → 막히면 OKX
  items.filter((x) => x.cat === 'cfut').forEach((x) => { const p = cfutPrice_(x.sym); if (p) price['cfut:' + x.sym] = p; });
  // 해외주식: OKX·바이비트에 같은 종목 무기한 선물이 있으면 그 가격으로 10분마다(24시간 거래라 장 밖 시간 값도 섞임)
  const usItems = items.filter((x) => x.cat === 'us'), srcOf = {};
  if (usItems.length) {
    try { const m = {}; okx_('/market/tickers?instType=SWAP').forEach((t) => { m[t.instId] = +t.last; }); usItems.forEach((x) => { const p = m[x.sym + '-USDT-SWAP']; if (p) { price['us:' + x.sym] = p; srcOf['us:' + x.sym] = 'OKX 선물가'; } }); } catch (e) { /* 바이비트로 */ }
    usItems.filter((x) => !price['us:' + x.sym]).forEach((x) => { const p = bybitPrice_(x.sym + 'USDT'); if (p) { price['us:' + x.sym] = p; srcOf['us:' + x.sym] = '바이비트 선물가'; } });
  }
  // 선물이 없는 해외주식만 Alpha Vantage로 3시간마다(무료 한도)
  const lastUs = Number(P.getProperty('LAST_US') || 0);
  if (usItems.some((x) => !price['us:' + x.sym]) && now - lastUs > US_CHECK_H * 3600e3 && P.getProperty('ALPHAVANTAGE_API_KEY')) {
    usItems.filter((x) => !price['us:' + x.sym]).slice(0, 5).forEach((x) => {
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
  // 예전 상태 키에서 종목·범위를 읽어 둠(같은 종목에서 범위가 겹치면 같은 구간으로 봄)
  const oldBy = {}; Object.keys(state).forEach((k) => { const p = k.split('|'); if (p.length === 3) (oldBy[p[0]] = oldBy[p[0]] || []).push({ k: k, low: Number(p[1]), high: Number(p[2]) }); });
  const inherit = (x, z) => { const L = oldBy[x.cat + ':' + x.sym] || []; let best = null; L.forEach((o) => { const ov = Math.min(o.high, z.high) - Math.max(o.low, z.low); if (ov > 0 && (!best || ov > best.ov)) best = { ov: ov, s: state[o.k] }; }); return best ? { inside: best.s.inside, last: best.s.last } : null; };
  items.forEach((x) => {
    const p = price[x.cat + ':' + x.sym];
    if (!p) return;
    x.zones.forEach((z, i) => {
      const id = zid(x, z);
      const s = state[id] || inherit(x, z) || { inside: false, last: 0 };
      const inside = p >= z.low && p <= z.high;
      if (inside && !s.inside && now - s.last > COOLDOWN_H * 3600e3) {
        const unit = x.cat === 'coin' || x.cat === 'kr' ? '원' : x.cat === 'us' ? ' 달러' : x.cat === 'cfut' ? ' USDT' : '';
        send_('🔔 [' + CAT_LABEL_[x.cat] + '] ' + x.name + ' (' + (x.cat === 'coin' ? x.sym.slice(4) : x.sym) + ') 검토 구간 진입\n' +
          '현재가 ' + fmt_(p) + unit + '\n' +
          '구간 ' + (i + 1) + ': ' + fmt_(z.low) + ' ~ ' + fmt_(z.high) + ' (' + x.tf + ', 근거 점수 ' + z.score + ')\n' +
          '근거: ' + z.labels.join(', ') + (z.react ? '\n과거 반응: ' + z.react : '') + (srcOf[x.cat + ':' + x.sym] ? '\n가격 출처: ' + srcOf[x.cat + ':' + x.sym] : '') + (x.calcAt ? '\n구간 계산: ' + Utilities.formatDate(new Date(x.calcAt), 'Asia/Seoul', 'M/d HH:mm') + (x.rc ? ' (자동)' : ' (앱)') : '') + '\n\n' +
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
        const cs = serverCandles_(x), r = ZoneMath.analyze(cs, { tf: TFK_[x.tfk] ? x.tfk : 'day' });
        if (r.error) throw new Error(r.error);
        x.zones = r.zones.slice(0, 5).map((z) => ({ low: z.low, high: z.high, score: z.score, labels: Array.from(new Set(z.items.map((i) => i.label))).slice(0, 10), react: ZoneMath.reactText(z.react) }));
        if (cs.src) x.src = cs.src;
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
/** 편집기에서 실행: 알림 종목 없이도 카테고리별 샘플로 '봉 받기 → 구간 계산'이 되는지 확인(저장·알림 없음) */
function 재계산점검() {
  const P = PropertiesService.getScriptProperties();
  const samples = [{ cat: 'coin', sym: 'KRW-BTC', name: '비트코인', tfk: 'day' }, { cat: 'coin', sym: 'KRW-ETH', name: '이더리움', tfk: 'h4' }, { cat: 'cfut', sym: 'BTCUSDT', name: 'BTC 선물', tfk: 'day' }];
  if (P.getProperty('ALPHAVANTAGE_API_KEY')) samples.push({ cat: 'us', sym: 'AAPL', name: '애플', tfk: 'day' });
  if (P.getProperty('DATA_GO_KR_KEY') || P.getProperty('KIS_APP_KEY')) samples.push({ cat: 'kr', sym: '005930', name: '삼성전자', tfk: 'day' });
  samples.forEach((x) => {
    try {
      const cs = serverCandles_(x), r = ZoneMath.analyze(cs, { tf: TFK_[x.tfk] ? x.tfk : 'day' });
      Logger.log('✅ [' + CAT_LABEL_[x.cat] + '] ' + x.name + ' ' + TFK_[x.tfk] + ' — 봉 ' + cs.length + '개, 현재 ' + fmt_(cs[cs.length - 1].c) + (r.error ? ' / ' + r.error : ' / 구간 ' + r.zones.length + '개: ' + (r.zones.map((z) => fmt_(z.low) + '~' + fmt_(z.high)).join(' / ') || '아래 겹치는 구간 없음')));
    } catch (e) { Logger.log('❌ [' + CAT_LABEL_[x.cat] + '] ' + x.name + ' — ' + (e && e.message || e)); }
  });
}
// 종목별 봉 데이터를 스크립트가 직접 받음(앱의 sources.js fetchCandles와 같은 출처·개수)
function serverCandles_(x) {
  const tf = TFK_[x.tfk] ? x.tfk : TFK_LABEL_[x.tf] || 'day';
  if (x.cat === 'coin') {
    const unit = { day: 'days', h4: 'minutes/240', h1: 'minutes/60' }[tf] || 'days';
    let out = [], to = '', src = '업비트';
    for (let k = 0; k < 2; k++) {
      let r = upbitRelay_('/candles/' + unit + '?market=' + x.sym + '&count=200' + (to ? '&to=' + encodeURIComponent(to) : ''));
      if ((!r.ok || !r.data || !r.data.length) && k === 0) { r = bithumbGet_('/candles/' + unit + '?market=' + x.sym + '&count=200'); src = '빗썸'; } // 업비트에 없거나 막히면 빗썸
      else if (src === '빗썸') r = bithumbGet_('/candles/' + unit + '?market=' + x.sym + '&count=200' + (to ? '&to=' + encodeURIComponent(to) : ''));
      if (!r.ok) throw new Error(r.error);
      out = out.concat(r.data);
      if (r.data.length < 200) break;
      to = r.data[r.data.length - 1].candle_date_time_utc + 'Z';
      Utilities.sleep(150);
    }
    // 봉 시각은 봉이 시작한 시각(앱과 같게), 같은 봉이 겹치면 하나만
    const seen = {}, cs = out.reverse().filter((k) => !seen[k.candle_date_time_utc] && (seen[k.candle_date_time_utc] = 1)).map((k) => ({ t: Date.parse(k.candle_date_time_utc + 'Z'), o: k.opening_price, h: k.high_price, l: k.low_price, c: k.trade_price, v: k.candle_acc_trade_volume }));
    cs.src = src; return cs;
  }
  if (x.cat === 'cfut') {
    const iv = { day: '1d', h4: '4h', h1: '1h' }[tf] || '1d';
    try {
      const r = UrlFetchApp.fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + encodeURIComponent(x.sym) + '&interval=' + iv + '&limit=500', { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) return JSON.parse(r.getContentText()).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } catch (e) { /* OKX로 */ }
    return perpCandles_(x.sym.replace(/USDT$/, ''), tf);
  }
  if (x.cat === 'us') {
    if (!PropertiesService.getScriptProperties().getProperty('ALPHAVANTAGE_API_KEY')) throw new Error('ALPHAVANTAGE_API_KEY 없음');
    const fn = tf === 'week' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY';
    try {
      const j = avFetch_({ function: fn, symbol: x.sym }, AV_FN_[fn]);
      const key = Object.keys(j).find((k) => /Time Series/i.test(k));
      if (!key) throw new Error(j.Note || j.Information || j['Error Message'] || 'Alpha Vantage 응답에 시세가 없음');
      const cs = Object.keys(j[key]).map((day) => { const v = j[key][day]; return { t: Date.parse(day + 'T00:00:00Z'), o: +v['1. open'], h: +v['2. high'], l: +v['3. low'], c: +v['4. close'], v: +v['5. volume'] }; }).sort((a, b) => a.t - b.t);
      cs.src = 'Alpha Vantage'; return cs;
    } catch (e) {
      // 무료 한도·오류 → 같은 종목 OKX·바이비트 선물 봉으로 대신
      try { const cs = perpCandles_(x.sym, 'day'); const out = tf === 'week' ? toWeekly_(cs) : cs; out.src = cs.src + '(Alpha Vantage 대신)'; return out; } catch (e2) { throw e; }
    }
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


/* ───────── 📡 나스닥 신호: OKX 공개 시세 → nq.js 규칙(앱과 같은 계산) → 바뀔 때만 알림. 주문 기능 없음 ───────── */
function okx_(path) {
  const r = UrlFetchApp.fetch('https://www.okx.com/api/v5' + path, { muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() !== 200 || j.code !== '0') throw new Error('OKX 응답 오류 ' + r.getResponseCode() + ' ' + (j.msg || ''));
  return j.data || [];
}
function nqData_() {
  const qd = NQ.fromOkx(okx_('/market/candles?instId=' + NQ.SYMS.QQQ + '&bar=1Dutc&limit=300'));
  const T = NQ.fromOkx(okx_('/market/candles?instId=' + NQ.SYMS.TQQQ + '&bar=4H&limit=300'));
  const S = NQ.fromOkx(okx_('/market/candles?instId=' + NQ.SYMS.SQQQ + '&bar=4H&limit=300'));
  const last = {};
  ['TQQQ', 'SQQQ', 'QQQ'].forEach((k) => { try { last[k] = Number(okx_('/market/ticker?instId=' + NQ.SYMS[k])[0].last); } catch (e) { /* 없음 */ } });
  return { qd: qd, T: T, S: S, last: last };
}
function nqStatus_() {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('NQ_CFG') || '{}'), st = JSON.parse(P.getProperty('NQ_STATE') || '{}');
  return { enabled: !!cfg.enabled, regime: st.regime || null, open: st.open || {}, at: st.at || null };
}
const NQ_KO_ = { up: '📈 상승장', down: '📉 하락장', side: '➖ 횡보' };
const NQ_TAIL_ = '\n\n※ 정해진 규칙의 신호입니다(공부용). 매수·매도 추천이 아니며 자동 주문은 하지 않습니다. 3배 레버리지 상품의 선물은 손실이 원금보다 커질 수 있습니다.';
function nqFmt_(x) { return x == null || !isFinite(x) ? '-' : Number(x).toFixed(2); }
// send=false면 계산만(편집기 점검용)
function nqCheck_(send) {
  const P = PropertiesService.getScriptProperties();
  const cfg = JSON.parse(P.getProperty('NQ_CFG') || '{}');
  if (send && !cfg.enabled) return null;
  const D = nqData_(), ev = NQ.evaluate(D.qd, { TQQQ: D.T, SQQQ: D.S });
  const prev = JSON.parse(P.getProperty('NQ_STATE') || '{}'), first = !prev.at, msgs = [];
  const R = ev.regime, rTxt = R ? NQ_KO_[R.state] + ' (점수 ' + (R.score > 0 ? '+' : '') + R.score + ')' : '계산 못 함';
  const open = {}; Object.keys(ev.open).forEach((k) => { const o = ev.open[k]; open[k] = { entryT: o.entryT, entry: o.entry, stop: o.stop, target: o.target, r1: o.r1 }; });
  if (first) {
    msgs.push('📡 나스닥 신호 알림을 시작합니다\n지금 장세: ' + rTxt + '\n' + (Object.keys(open).length ? '규칙상 열린 가상 포지션: ' + Object.keys(open).map((k) => k + ' 진입 ' + nqFmt_(open[k].entry) + ' · 손절 ' + nqFmt_(open[k].stop) + ' · 목표 ' + nqFmt_(open[k].target)).join(' / ') : '규칙상 열린 가상 포지션 없음(관망)') + '\n앞으로 장세가 바뀌거나 4시간봉 마감에 신호가 나오면 알립니다.');
  } else {
    if (R && prev.regime && prev.regime !== R.state) msgs.push('🔄 장세 바뀜: ' + NQ_KO_[prev.regime] + ' → ' + rTxt + '\n' + (R.state === 'up' ? '이제 TQQQ 진입 조건만 봅니다.' : R.state === 'down' ? '이제 SQQQ 진입 조건만 봅니다.' : '횡보라 새 진입 신호를 내지 않습니다.') + '\n확인: ' + R.checks.map((c) => (c.ok ? '✅' : '❌') + c.name).join(' · '));
    ['TQQQ', 'SQQQ'].forEach((k) => {
      const was = prev.open && prev.open[k], now = open[k];
      if (was && (!now || now.entryT !== was.entryT)) {
        const t = ev.bt.trades.filter((x) => x.sym === k && x.entryT === was.entryT)[0];
        msgs.push((t && t.pct > 0 ? '✅ ' : '⛔ ') + k + ' 가상 포지션 청산 — ' + (t ? t.why : '기록 범위 밖') + '\n진입 ' + nqFmt_(was.entry) + ' → 청산 ' + (t ? nqFmt_(t.exit) + ' (' + (t.pct > 0 ? '+' : '') + t.pct.toFixed(2) + '%, ' + t.R.toFixed(2) + 'R)' : '-'));
      }
      if (now && (!was || now.entryT !== was.entryT)) {
        const n = ev.now[k], o = ev.open[k];
        msgs.push('🔔 ' + k + ' 매수 신호 (4시간봉 마감 ' + Utilities.formatDate(new Date(o.entryT), 'Asia/Seoul', 'M/d HH:mm') + ')\n장세 ' + rTxt + '\n진입가 ' + nqFmt_(o.entry) + ' · 손절가 ' + nqFmt_(o.stop) + ' (-' + o.riskPct.toFixed(2) + '%) · 1R ' + nqFmt_(o.r1) + ' · 목표가 ' + nqFmt_(o.target) + ' (+' + o.targetPct.toFixed(2) + '%)\n근거: MACD 히스토그램 음→양 · RSI ' + nqFmt_(n && n.rsi) + ' · 20봉 지수평균 위 · ATR ' + nqFmt_(o.atr));
      }
    });
  }
  // 진행 중인 봉에서 손절가·목표가에 닿았는지(봉 마감 전 미리 알림, 같은 포지션에 한 번씩)
  const warned = (first ? {} : prev.warned) || {};
  Object.keys(open).forEach((k) => {
    const o = open[k], p = D.last[k]; if (!p) return;
    const key = k + o.entryT;
    if (p <= o.stop && !warned[key + 's']) { warned[key + 's'] = 1; if (!first) msgs.push('⚠️ ' + k + ' 현재가 ' + nqFmt_(p) + ' — 손절가 ' + nqFmt_(o.stop) + '에 닿았습니다(진행 중인 4시간봉, 마감 때 확정)'); }
    if (p >= o.target && !warned[key + 't']) { warned[key + 't'] = 1; if (!first) msgs.push('🎯 ' + k + ' 현재가 ' + nqFmt_(p) + ' — 목표가 ' + nqFmt_(o.target) + '에 닿았습니다(진행 중인 4시간봉, 마감 때 확정)'); }
  });
  Object.keys(warned).forEach((w) => { if (!Object.keys(open).some((k) => w.indexOf(k + open[k].entryT) === 0)) delete warned[w]; });
  if (send) {
    msgs.forEach((m) => { try { send_('[나스닥 신호] ' + m + NQ_TAIL_); } catch (e) { Logger.log('알림 실패: ' + e.message); } });
    P.setProperty('NQ_STATE', JSON.stringify({ regime: R ? R.state : null, open: open, warned: warned, at: new Date().toISOString() }));
  }
  return { ev: ev, D: D, msgs: msgs };
}
/** 편집기에서 실행: 지금 나스닥 신호 계산 결과를 로그로 보여 줌(알림은 보내지 않음) */
function 나스닥신호점검() {
  const r = nqCheck_(false), ev = r.ev, R = ev.regime;
  Logger.log('QQQ 일봉 ' + r.D.qd.length + '개 · TQQQ 4시간봉 ' + r.D.T.length + '개 · SQQQ 4시간봉 ' + r.D.S.length + '개 · 현재가 ' + JSON.stringify(r.D.last));
  Logger.log('장세: ' + (R ? NQ_KO_[R.state] + ' 점수 ' + R.score + ' — ' + R.checks.map((c) => (c.ok ? '✅' : '❌') + c.name).join(' · ') : '계산 못 함'));
  Logger.log('지금 신호: ' + (ev.signal || '없음(관망)') + ' · 열린 가상 포지션: ' + (Object.keys(ev.open).join(', ') || '없음'));
  const s = ev.bt.stats; Logger.log('최근 300봉 시험: 거래 ' + s.n + '번 · 이긴 비율 ' + (s.winRate == null ? '-' : s.winRate.toFixed(0) + '%') + ' · 합계 ' + s.totalR.toFixed(2) + 'R');
  Logger.log('알림 설정: ' + (nqStatus_().enabled ? '켜짐' : '꺼짐(앱의 나스닥 신호 화면에서 켜기)'));
}

/* ───────── 📊 ETF 아침 정리: OKX 공개 시세 → scan.js(앱과 같은 계산) → 하루 한 번 디스코드. 주문 기능 없음 ───────── */
function scanStatus_() {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('SCAN_CFG') || '{}'), st = JSON.parse(P.getProperty('SCAN_STATE') || '{}');
  return { enabled: !!cfg.enabled, lastDay: st.day || null, at: st.at || null };
}
const SCAN_HOUR_ = 9, SCAN_MIN_ = 10; // 한국 시간 9시 10분 이후(OKX 일봉이 9시에 끝남)
function scanDaily_() {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('SCAN_CFG') || '{}');
  if (!cfg.enabled) return;
  const now = new Date(), h = Number(Utilities.formatDate(now, 'Asia/Seoul', 'H')), m = Number(Utilities.formatDate(now, 'Asia/Seoul', 'm'));
  if (h < SCAN_HOUR_ || (h === SCAN_HOUR_ && m < SCAN_MIN_)) return;
  const today = kstDay_(Date.now()), st = JSON.parse(P.getProperty('SCAN_STATE') || '{}');
  if (st.day === today) return;
  P.setProperty('SCAN_STATE', JSON.stringify({ day: today, at: now.toISOString(), pending: true })); // 실패해도 10분마다 되풀이하지 않게 먼저 적어 둠
  const text = scanBuild_().text;
  send_(text);
  P.setProperty('SCAN_STATE', JSON.stringify({ day: today, at: new Date().toISOString() }));
}
function scanBuild_() {
  const tick = {};
  okx_('/market/tickers?instType=SWAP').forEach((t) => { const sym = String(t.instId).replace(/-USDT-SWAP$/, ''); if (SCAN.META[sym] && /-USDT-SWAP$/.test(t.instId)) tick[sym] = { last: +t.last, chg: (+t.last / +t.open24h - 1) * 100, vol: +t.volCcy24h * +t.last }; });
  const byVol = Object.keys(tick).sort((a, b) => tick[b].vol - tick[a].vol);
  const syms = byVol.filter((x) => SCAN.CORE.indexOf(x) >= 0 || byVol.indexOf(x) < 12);
  const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const R = [];
  syms.forEach((x) => {
    try {
      const a = SCAN.analyze(SCAN.fromOkx(okx_('/market/candles?instId=' + x + '-USDT-SWAP&bar=4H&limit=300')), { dayStart: dayStart });
      const d = SCAN.analyze(SCAN.fromOkx(okx_('/market/candles?instId=' + x + '-USDT-SWAP&bar=1Dutc&limit=300')), { daily: true });
      if (!a.error) R.push({ s: x, a: a, d: d.error ? null : d, tk: tick[x] });
    } catch (e) { /* 한 종목 실패는 건너뜀 */ }
  });
  const f = (p) => (p >= 1000 ? p.toFixed(0) : p >= 100 ? p.toFixed(1) : p.toFixed(2));
  const money = (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + '억$' : Math.round(v / 1e4) + '만$');
  const pc = (x) => (x > 0 ? '+' : '') + x.toFixed(1) + '%';
  const tr = (d) => (!d ? '-' : d.trend === 'up' ? '상승' : d.trend === 'down' ? '하락' : '횡보');
  const L = [];
  L.push('📊 ETF 선물 아침 정리 (' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'M/d HH:mm') + ', OKX 공개 시세 · 4시간봉 점수 + 일봉 추세)');
  ['QQQ', 'SPY'].forEach((x) => { const r = R.filter((y) => y.s === x)[0]; if (r && r.d) L.push('• ' + x + ' ' + f(r.d.price) + ' · RSI ' + r.d.rsi.toFixed(0) + ' · ' + SCAN.dayTrend(r.d)); });
  const up = R.filter((r) => r.a.upScore >= 3).sort((p, q) => q.a.upScore - p.a.upScore || q.tk.vol - p.tk.vol).slice(0, 5);
  const dn = R.filter((r) => r.a.dnScore >= 3).sort((p, q) => q.a.dnScore - p.a.dnScore || q.tk.vol - p.tk.vol).slice(0, 5);
  L.push('');
  L.push('🔼 반등 관심(3점 이상): ' + (up.length ? up.map((r) => r.s + ' ' + r.a.upScore + '/5(일봉 ' + tr(r.d) + ')').join(', ') : '없음'));
  L.push('🔽 하락 전환 관심(3점 이상): ' + (dn.length ? dn.map((r) => r.s + ' ' + r.a.dnScore + '/5(일봉 ' + tr(r.d) + ')').join(', ') : '없음'));
  L.push('💰 OKX 24시간 거래대금: ' + byVol.slice(0, 6).map((x) => x + ' ' + money(tick[x].vol) + '(' + pc(tick[x].chg) + ')').join(', '));
  const vol = R.filter((r) => r.d && r.d.atrPct != null).sort((p, q) => q.d.atrPct - p.d.atrPct);
  L.push('🌊 변동성(일봉 ATR%): 높음 ' + vol.slice(0, 4).map((r) => r.s + ' ' + r.d.atrPct.toFixed(1) + '%').join(', ') + ' / 낮음 ' + vol.slice(-3).reverse().map((r) => r.s + ' ' + r.d.atrPct.toFixed(1) + '%').join(', '));
  const jump = R.filter((r) => r.d && r.d.atrJump >= 1.5).map((r) => r.s + ' ' + r.d.atrJump.toFixed(1) + '배');
  if (jump.length) L.push('⚠️ 변동성 확대(ATR이 20봉 전의 1.5배 이상): ' + jump.join(', '));
  const vspike = R.filter((r) => r.a.volRatio >= 2).map((r) => r.s + ' ' + r.a.volRatio.toFixed(1) + '배');
  if (vspike.length) L.push('📢 거래량 급증(4시간봉 평균의 2배 이상): ' + vspike.join(', '));
  if (up.some((r) => r.d && r.d.trend === 'down')) L.push('※ 일봉 하락 추세 속 반등 점수는 추세를 거스르는 단기 신호라 실패할 수도 있습니다.');
  L.push('');
  L.push('※ 정해진 조건의 개수로 매긴 점수입니다(공부용). 매수·매도 추천이 아니며 자동 주문은 하지 않습니다. 3배 레버리지 상품의 선물은 손실이 원금보다 커질 수 있습니다. 바이낸스는 구글 서버에서 막혀 OKX만 봤습니다.');
  return { text: L.join('\n').slice(0, 1990), R: R };
}
/* ── ⭐ 강한 신호 디스코드 알림(선물 스캐너 앱) ──
 * 10분마다 도는 가격확인() 안에서, 매시 정각 2분 뒤(1시간봉이 끝난 뒤) 한 번만 계산한다.
 * 대상: OKX 주식·ETF 선물 중 거래량 상위 ETF(안정 기준)와 개별주(하루 변동성 30% 이내). 봉은 OKX, 못 받으면 바이비트.
 * 같은 종목·같은 방향은 하루(한국 날짜) 한 번만 보내고, 동시에 두 번 돌지 않게 잠금을 건다(중복 방지).
 */
const ST_CALM_ = { vol: 5e6, chg: 15, range: 20, atr: 12 }, ST_STOCK_ = { vol: 2e6, chg: 30, range: 30, atr: 30 };
const ST_N_ETF_ = 12, ST_N_STOCK_ = 15, ST_MIN_ = 2;
const ST_KO_ = { NVDA: '엔비디아', SNDK: '샌디스크', MU: '마이크론', SKHYNIX: 'SK하이닉스', SKHY: 'SK하이닉스(해외)', SAMSUNG: '삼성전자', TSLA: '테슬라', AAPL: '애플', GOOGL: '구글', AMZN: '아마존', MSFT: '마이크로소프트', META: '메타', AMD: 'AMD', INTC: '인텔', AVGO: '브로드컴', TSM: 'TSMC', MSTR: '스트래티지', CRCL: '서클', COIN: '코인베이스', ANTHROPIC: '앤트로픽(상장 전)', SPCX: '스페이스X(상장 전)' };
function strongStatus_() {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('STRONG_CFG') || '{}'), st = JSON.parse(P.getProperty('STRONG_STATE') || '{}');
  const today = kstDay_(Date.now());
  return { enabled: !!cfg.enabled, at: st.at || null, hour: st.hour || null, sentToday: st.day === today ? Object.keys(st.sent || {}).length : 0, last: st.last || null };
}
function strongCheck_(force) {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('STRONG_CFG') || '{}');
  if (!cfg.enabled && !force) return null;
  const now = new Date(), hourKey = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH'), min = Number(Utilities.formatDate(now, 'Asia/Seoul', 'm'));
  let st = JSON.parse(P.getProperty('STRONG_STATE') || '{}');
  if (!force && (min < ST_MIN_ || st.hour === hourKey)) return null;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null; // 다른 실행이 계산 중이면 이번엔 건너뜀
  try {
    st = JSON.parse(P.getProperty('STRONG_STATE') || '{}');
    if (!force && st.hour === hourKey) return null;
    const today = kstDay_(Date.now()), sent = st.day === today ? (st.sent || {}) : {};
    if (!force) P.setProperty('STRONG_STATE', JSON.stringify({ hour: hourKey, day: today, sent: sent, at: now.toISOString(), last: st.last || null })); // 실패해도 이번 시간엔 다시 안 돎(점검은 상태를 안 바꿈)
    const R = strongScan_();
    const hits = R.rows.filter((x) => x.dir), fresh = hits.filter((x) => !sent[x.s + ':' + x.dir]);
    let result = { scanned: R.rows.length, hits: hits.length, fresh: fresh.length, sent: null };
    if (fresh.length && !force) { result.sent = send_(strongText_(fresh, '⭐ 강한 신호')); fresh.forEach((x) => { sent[x.s + ':' + x.dir] = hourKey; }); }
    if (!force) P.setProperty('STRONG_STATE', JSON.stringify({ hour: hourKey, day: today, sent: sent, at: new Date().toISOString(), last: { scanned: R.rows.length, hits: hits.length, sent: result.sent ? fresh.length : 0, fail: R.fail } }));
    result.text = fresh.length ? strongText_(fresh, '⭐ 강한 신호') : '';
    result.fail = R.fail;
    return result;
  } finally { lock.releaseLock(); }
}
// OKX 여러 요청을 8개씩 나눠 보내기(한꺼번에 몰리면 429)
function okxMany_(paths) {
  const out = [];
  for (let i = 0; i < paths.length; i += 8) {
    const rs = UrlFetchApp.fetchAll(paths.slice(i, i + 8).map((p) => ({ url: 'https://www.okx.com/api/v5' + p, muteHttpExceptions: true })));
    rs.forEach((r) => { try { const j = JSON.parse(r.getContentText() || '{}'); out.push(r.getResponseCode() === 200 && j.code === '0' ? j.data : null); } catch (e) { out.push(null); } });
    if (i + 8 < paths.length) Utilities.sleep(500);
  }
  return out;
}
// 바이비트 봉(OKX에서 못 받았을 때만). 구글 서버에서 막히면 null
function bybitCandles_(sym, interval, ms) {
  try {
    const r = UrlFetchApp.fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=' + sym + 'USDT&interval=' + interval + '&limit=300', { muteHttpExceptions: true });
    const j = JSON.parse(r.getContentText() || '{}'); if (r.getResponseCode() !== 200 || j.retCode !== 0) return null;
    return (j.result.list || []).filter((k) => +k[0] + ms <= Date.now()).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  } catch (e) { return null; }
}
function strongScan_() {
  const cache = CacheService.getScriptCache();
  let inst = null; try { inst = JSON.parse(cache.get('okxCat3') || 'null'); } catch (e) { inst = null; }
  if (!inst) { inst = okx_('/public/instruments?instType=SWAP').filter((x) => x.instCategory === '3' && x.state === 'live' && /-USDT-SWAP$/.test(x.instId)).map((x) => x.instId.replace(/-USDT-SWAP$/, '')); cache.put('okxCat3', JSON.stringify(inst), 21600); }
  const set = {}; inst.forEach((x) => { set[x] = 1; });
  const tick = {};
  okx_('/market/tickers?instType=SWAP').forEach((t) => { const s = String(t.instId).replace(/-USDT-SWAP$/, ''); if (set[s] && /-USDT-SWAP$/.test(t.instId)) tick[s] = { last: +t.last, chg: +t.open24h ? (+t.last / +t.open24h - 1) * 100 : 0, vol: +t.volCcy24h * +t.last, range: +t.low24h ? (+t.high24h / +t.low24h - 1) * 100 : 0 }; });
  const ok = (t, c) => t.vol >= c.vol && Math.abs(t.chg) <= c.chg && t.range <= c.range;
  const byVol = Object.keys(tick).sort((a, b) => tick[b].vol - tick[a].vol);
  const etf = byVol.filter((s) => SCAN.META[s] && ok(tick[s], ST_CALM_)).slice(0, ST_N_ETF_);
  const stk = byVol.filter((s) => !SCAN.META[s] && ok(tick[s], ST_STOCK_)).slice(0, ST_N_STOCK_);
  const syms = etf.concat(stk);
  const paths = [];
  syms.forEach((s) => { const id = s + '-USDT-SWAP'; paths.push('/market/candles?instId=' + id + '&bar=1H&limit=300', '/market/candles?instId=' + id + '&bar=4H&limit=300', '/market/candles?instId=' + id + '&bar=1Dutc&limit=300'); });
  const got = okxMany_(paths), dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const rows = [], fail = [];
  syms.forEach((s, i) => {
    try {
      let c1 = got[i * 3] ? SCAN.fromOkx(got[i * 3]) : bybitCandles_(s, '60', 3600e3);
      let c4 = got[i * 3 + 1] ? SCAN.fromOkx(got[i * 3 + 1]) : bybitCandles_(s, '240', 4 * 3600e3);
      let cd = got[i * 3 + 2] ? SCAN.fromOkx(got[i * 3 + 2]) : bybitCandles_(s, 'D', 86400e3);
      if (!c1 || !c4 || !cd) { fail.push(s); return; }
      c1 = LV.fixSplits(c1); c4 = LV.fixSplits(c4); cd = LV.fixSplits(cd); // 주식 분할 전 가격 맞춤
      const a = SCAN.analyze(c1, { dayStart: dayStart }), hi = SCAN.analyze(c4, { dayStart: dayStart }), d = SCAN.analyze(cd, { daily: true });
      if (a.error) { fail.push(s); return; }
      const stock = !SCAN.META[s], lim = stock ? ST_STOCK_ : ST_CALM_;
      if (d && !d.error && d.atrPct >= lim.atr) return; // 일봉 변동성이 너무 큼
      const lv = LV.levels(c1, a.atr), sg = LV.strong(c1, a, hi.error ? null : hi, lv, SCAN.rsiSeries(c1.map((k) => k.c)));
      const dir = sg.strongBuy ? 'buy' : sg.strongSell ? 'sell' : null;
      rows.push({ s: s, stock: stock, dir: dir, a: a, sg: sg, z: dir === 'buy' ? LV.buyZone(lv, a) : dir === 'sell' ? LV.sellZone(lv, a) : null, tk: tick[s], calm: ok(tick[s], ST_CALM_) && !(d && d.atrPct >= ST_CALM_.atr) });
    } catch (e) { fail.push(s); }
  });
  return { rows: rows, fail: fail };
}
const stFmt_ = (p) => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(0) : a >= 100 ? p.toFixed(1) : a >= 1 ? p.toFixed(2) : a === 0 ? '0' : p.toFixed(Math.min(10, 3 - Math.floor(Math.log10(a)))); };
function strongText_(L, title, names) {
  const f = stFmt_, pc = (x) => (x > 0 ? '+' : '') + x.toFixed(1) + '%';
  const out = [(title || '⭐ 강한 신호') + ' (1시간봉 · 상위 4시간봉 확인 · OKX) ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'M/d HH:mm')];
  L.sort((p, q) => (p.dir === q.dir ? q.tk.vol - p.tk.vol : p.dir === 'buy' ? -1 : 1)).forEach((x) => {
    const buy = x.dir === 'buy', nm = names || ST_KO_, name = nm[x.s] ? ' ' + nm[x.s] : x.stock ? ' 개별주' : '';
    out.push((buy ? '🟢 강한 매수 ' : '🔴 강한 매도 ') + x.s + name + ' ' + f(x.tk.last) + ' (' + pc(x.tk.chg) + ') · ' + (buy ? '반등 ' + x.a.upScore : '하락전환 ' + x.a.dnScore) + '/5 · 확인 ' + (buy ? x.sg.nb : x.sg.ns) + '/5' + (x.calm ? '' : ' ⚠️변동성 큼'));
    if (x.z) out.push('   ' + (buy ? '매수' : '매도') + ' 검토 가격대 ' + f(x.z.low) + '~' + f(x.z.high) + ' · 무효 ' + f(x.z.stop) + ' · 1차 목표 ' + f(x.z.target));
  });
  out.push('');
  out.push('※ 정해진 조건(기본 점수 4 이상 + 확인 5가지 중 3가지 이상)의 결과입니다(공부용). 매수·매도 추천이 아니며 자동 주문은 하지 않습니다. 같은 종목·같은 방향은 하루 한 번만 보냅니다.' + (title && title.indexOf('코인') >= 0 ? ' 코인 선물은 변동이 커서 짧은 시간에 강제 청산될 수 있습니다.' : ''));
  return out.join('\n').slice(0, 1990);
}
/* ── 🪙 코인 강한 신호 디스코드 알림(코인 스캐너 앱) ──
 * 선물 스캐너 알림과 같은 방식(매시 2분 뒤 한 번, 잠금, 같은 코인·방향 하루 한 번)이고 켜기·상태는 따로(COIN_STRONG_CFG/STATE).
 * 대상: OKX 코인 무기한 선물(USDT) 중 안정 기준(OKX 24시간 거래 1천만 달러↑ · 등락 ±15% · 고저 폭 20% · 일봉 ATR 10% 미만)을 통과한 거래 많은 15개 + 메이저.
 */
const CO_CALM_ = { vol: 1e7, chg: 15, range: 20, atr: 10 }, CO_N_ = 15;
const CO_STABLE_ = { USDC: 1, FDUSD: 1, TUSD: 1, DAI: 1, USDE: 1, USD1: 1, BUSD: 1, PYUSD: 1, RLUSD: 1, USDP: 1, USDD: 1, EURI: 1, EUR: 1, USDS: 1, PAXG: 1, XAUT: 1 };
const CO_MAJOR_ = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'];
const CO_KO_ = { BTC: '비트코인', ETH: '이더리움', SOL: '솔라나', XRP: '리플', BNB: 'BNB', DOGE: '도지코인', ADA: '에이다', TRX: '트론', LINK: '체인링크', AVAX: '아발란체', SUI: '수이', LTC: '라이트코인', BCH: '비트코인캐시', DOT: '폴카닷', TON: '톤코인', HYPE: '하이퍼리퀴드', PEPE: '페페', SHIB: '시바이누', XLM: '스텔라루멘', NEAR: '니어', APT: '앱토스', UNI: '유니스왑', AAVE: '에이브', ARB: '아비트럼', OP: '옵티미즘', ETC: '이더리움클래식', FIL: '파일코인', ATOM: '코스모스', WLD: '월드코인', ENA: '에테나', ONDO: '온도', TAO: '비트텐서', XMR: '모네로', ZEC: '지캐시' };
function coinStrongStatus_() {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('COIN_STRONG_CFG') || '{}'), st = JSON.parse(P.getProperty('COIN_STRONG_STATE') || '{}');
  return { enabled: !!cfg.enabled, at: st.at || null, hour: st.hour || null, sentToday: st.day === kstDay_(Date.now()) ? Object.keys(st.sent || {}).length : 0, last: st.last || null };
}
function coinStrongCheck_(force) {
  const P = PropertiesService.getScriptProperties(), cfg = JSON.parse(P.getProperty('COIN_STRONG_CFG') || '{}');
  if (!cfg.enabled && !force) return null;
  const now = new Date(), hourKey = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH'), min = Number(Utilities.formatDate(now, 'Asia/Seoul', 'm'));
  let st = JSON.parse(P.getProperty('COIN_STRONG_STATE') || '{}');
  if (!force && (min < ST_MIN_ || st.hour === hourKey)) return null;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    st = JSON.parse(P.getProperty('COIN_STRONG_STATE') || '{}');
    if (!force && st.hour === hourKey) return null;
    const today = kstDay_(Date.now()), sent = st.day === today ? (st.sent || {}) : {};
    // 점검(force)은 상태를 바꾸지 않음 → 정해진 시간의 실제 알림을 막지 않음
    if (!force) P.setProperty('COIN_STRONG_STATE', JSON.stringify({ hour: hourKey, day: today, sent: sent, at: now.toISOString(), last: st.last || null }));
    const R = coinStrongScan_();
    const hits = R.rows.filter((x) => x.dir), fresh = hits.filter((x) => !sent[x.s + ':' + x.dir]);
    const text = fresh.length ? strongText_(fresh, '🪙 코인 강한 신호', CO_KO_) : '';
    let sentR = null;
    if (fresh.length && !force) { sentR = send_(text); fresh.forEach((x) => { sent[x.s + ':' + x.dir] = hourKey; }); }
    if (!force) P.setProperty('COIN_STRONG_STATE', JSON.stringify({ hour: hourKey, day: today, sent: sent, at: new Date().toISOString(), last: { scanned: R.rows.length, hits: hits.length, sent: sentR ? fresh.length : 0, fail: R.fail } }));
    return { scanned: R.rows.length, hits: hits.length, fresh: fresh.length, sent: sentR, text: text, fail: R.fail, syms: R.syms };
  } finally { lock.releaseLock(); }
}
function coinStrongScan_() {
  const cache = CacheService.getScriptCache();
  let inst = null; try { inst = JSON.parse(cache.get('okxCat1') || 'null'); } catch (e) { inst = null; }
  if (!inst) { inst = okx_('/public/instruments?instType=SWAP').filter((x) => x.instCategory === '1' && x.settleCcy === 'USDT' && x.state === 'live' && /-USDT-SWAP$/.test(x.instId)).map((x) => x.instId.replace(/-USDT-SWAP$/, '')).filter((c) => !CO_STABLE_[c]); cache.put('okxCat1', JSON.stringify(inst), 21600); }
  const set = {}; inst.forEach((x) => { set[x] = 1; });
  const tick = {};
  okx_('/market/tickers?instType=SWAP').forEach((t) => { const c = String(t.instId).replace(/-USDT-SWAP$/, ''); if (set[c] && /-USDT-SWAP$/.test(t.instId)) tick[c] = { last: +t.last, chg: +t.open24h ? (+t.last / +t.open24h - 1) * 100 : 0, vol: +t.volCcy24h * +t.last, range: +t.low24h ? (+t.high24h / +t.low24h - 1) * 100 : 0 }; });
  const ok = (t) => t.vol >= CO_CALM_.vol && Math.abs(t.chg) <= CO_CALM_.chg && t.range <= CO_CALM_.range;
  const byVol = Object.keys(tick).sort((a, b) => tick[b].vol - tick[a].vol);
  const syms = CO_MAJOR_.filter((c) => tick[c] && ok(tick[c]));
  byVol.forEach((c) => { if (syms.length < CO_N_ + CO_MAJOR_.length && syms.indexOf(c) < 0 && ok(tick[c])) syms.push(c); });
  const paths = [];
  syms.forEach((c) => { const id = c + '-USDT-SWAP'; paths.push('/market/candles?instId=' + id + '&bar=1H&limit=300', '/market/candles?instId=' + id + '&bar=4H&limit=300', '/market/candles?instId=' + id + '&bar=1Dutc&limit=300'); });
  const got = okxMany_(paths), dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const rows = [], fail = [];
  syms.forEach((c, i) => {
    try {
      const c1 = got[i * 3] ? SCAN.fromOkx(got[i * 3]) : bybitCandles_(c, '60', 3600e3);
      const c4 = got[i * 3 + 1] ? SCAN.fromOkx(got[i * 3 + 1]) : bybitCandles_(c, '240', 4 * 3600e3);
      const cd = got[i * 3 + 2] ? SCAN.fromOkx(got[i * 3 + 2]) : bybitCandles_(c, 'D', 86400e3);
      if (!c1 || !c4 || !cd) { fail.push(c); return; }
      const a = SCAN.analyze(c1, { dayStart: dayStart }), hi = SCAN.analyze(c4, { dayStart: dayStart }), d = SCAN.analyze(cd, { daily: true });
      if (a.error) { fail.push(c); return; }
      if (d && !d.error && d.atrPct >= CO_CALM_.atr) return; // 일봉 변동성이 너무 큼
      const lv = LV.levels(c1, a.atr), sg = LV.strong(c1, a, hi.error ? null : hi, lv, SCAN.rsiSeries(c1.map((k) => k.c)));
      const dir = sg.strongBuy ? 'buy' : sg.strongSell ? 'sell' : null;
      rows.push({ s: c, stock: false, dir: dir, a: a, sg: sg, z: dir === 'buy' ? LV.buyZone(lv, a) : dir === 'sell' ? LV.sellZone(lv, a) : null, tk: tick[c], calm: true });
    } catch (e) { fail.push(c); }
  });
  return { rows: rows, fail: fail, syms: syms };
}
/** 편집기에서 실행: 지금 코인 강한 신호를 계산해 로그로만 보여 줌(보내지도, 상태를 바꾸지도 않음) */
function 코인강한신호점검() {
  const r = coinStrongCheck_(true);
  Logger.log('대상 ' + r.syms.length + '개(' + r.syms.join(',') + ') · 계산 ' + r.scanned + '개 · 강한 신호 ' + r.hits + '개 · 오늘 아직 안 보낸 것 ' + r.fresh + '개 · 봉 못 받은 코인 ' + (r.fail.join(', ') || '없음'));
  Logger.log(r.text || '(보낼 새 신호 없음)');
  Logger.log('코인 강한 신호 알림 설정: ' + (coinStrongStatus_().enabled ? '켜짐' : '꺼짐(코인 스캐너 앱 🧮 청산가 화면 아래에서 켜기)'));
}

/** 편집기에서 실행: 지금 강한 신호를 계산해 로그로만 보여 줌(보내지도, 상태를 바꾸지도 않음) */
function 강한신호점검() {
  const r = strongCheck_(true);
  Logger.log('계산 ' + r.scanned + '종목 · 강한 신호 ' + r.hits + '개 · 오늘 아직 안 보낸 것 ' + r.fresh + '개 · 봉 못 받은 종목 ' + (r.fail.join(', ') || '없음'));
  Logger.log(r.text || '(보낼 새 신호 없음)');
  Logger.log('강한 신호 알림 설정: ' + (strongStatus_().enabled ? '켜짐' : '꺼짐(선물 스캐너 앱 🔔 신호 화면에서 켜기)'));
}

/** 편집기에서 실행: 아침 정리 글을 만들어 로그로 보여 줌(보내지 않음) */
function ETF스캔점검() {
  const r = scanBuild_();
  Logger.log('분석한 종목 ' + r.R.length + '개 · 글자 수 ' + r.text.length);
  Logger.log(r.text);
  Logger.log('아침 정리 설정: ' + (scanStatus_().enabled ? '켜짐' : '꺼짐(앱의 ETF 스캐너 화면에서 켜기)'));
}

/* ==== scan.js 시작 (앱과 같은 스캐너 계산 — alert/build.mjs가 nasdaq-futures/scan.js에서 그대로 복사, 직접 고치지 말 것) ==== */
/* (가격 위치 앱의 scan.js를 바탕으로 종목을 늘린 복사본) 나스닥 선물 — 📊 ETF 선물 스캐너 계산 (OKX·바이낸스 공개 시세, 자동 주문 없음)
 * 앱과 알림 스크립트가 같은 계산을 쓰도록 화면·네트워크 없이 계산만 한다.
 * 반등 포착과 하락 전환 포착을 따로 점수(0~5)로 매기고, 거래대금·변동성(ATR%)·추세를 함께 본다.
 * 점수는 정해진 조건의 개수일 뿐 매수·매도 추천이 아니다.
 * 봉: 오래된 것부터 [{t, o, h, l, c, v}], 끝난 봉만.
 */
const SCAN = (() => {
  // 다루는 ETF·지수 선물(OKX·바이낸스에 실제로 있는 것). g: 묶음, lev: 배율(음수 = 인버스), pair: 반대 상품
  const META = {
    QQQ: { name: '나스닥100', g: 'nasdaq', lev: 1 }, TQQQ: { name: '나스닥100 3배', g: 'nasdaq', lev: 3, pair: 'SQQQ' }, SQQQ: { name: '나스닥100 인버스 3배', g: 'nasdaq', lev: -3, pair: 'TQQQ' },
    US100: { name: '나스닥100 지수(OKX)', g: 'nasdaq', lev: 1 },
    SPY: { name: 'S&P500', g: 'sp500', lev: 1 }, US500: { name: 'S&P500 지수(OKX)', g: 'sp500', lev: 1 },
    SOXL: { name: '반도체 3배', g: 'semi', lev: 3, pair: 'SOXS' }, SOXS: { name: '반도체 인버스 3배', g: 'semi', lev: -3, pair: 'SOXL' },
    SOXX: { name: '반도체', g: 'semi', lev: 1 }, SMH: { name: '반도체(반에크)', g: 'semi', lev: 1 },
    IWM: { name: '러셀2000(중소형주)', g: 'other', lev: 1, pair: 'TZA' }, TZA: { name: '러셀2000 인버스 3배', g: 'other', lev: -3, pair: 'IWM' },
    KORU: { name: '한국 3배', g: 'other', lev: 3 }, EWY: { name: '한국(MSCI)', g: 'other', lev: 1 }, EWJ: { name: '일본', g: 'other', lev: 1 }, EWT: { name: '대만', g: 'other', lev: 1 },
    UVXY: { name: 'VIX 변동성 1.5배', g: 'other', lev: 1.5 }, TLT: { name: '미국 장기국채', g: 'other', lev: 1 }, TMF: { name: '미국 장기국채 3배', g: 'other', lev: 3 },
    XLE: { name: '에너지', g: 'other', lev: 1 }, XLF: { name: '금융', g: 'other', lev: 1 }, XBI: { name: '바이오', g: 'other', lev: 1 }, IGV: { name: '소프트웨어', g: 'other', lev: 1 },
    GDX: { name: '금광', g: 'other', lev: 1 }, KWEB: { name: '중국 인터넷', g: 'other', lev: 1 }, EWZ: { name: '브라질', g: 'other', lev: 1 }, URNM: { name: '우라늄', g: 'other', lev: 1 }, IBIT: { name: '비트코인 현물 ETF', g: 'other', lev: 1 },
    XLV: { name: '헬스케어', g: 'other', lev: 1 }, USO: { name: '원유', g: 'other', lev: 1 }, EIDO: { name: '인도네시아', g: 'other', lev: 1 }, EWZS: { name: '브라질 소형주', g: 'other', lev: 1 }, TBT: { name: '장기국채 인버스 2배', g: 'other', lev: -2 }, BITO: { name: '비트코인 선물 ETF', g: 'other', lev: 1 },
    NVDL: { name: '엔비디아 2배', g: 'single', lev: 2 }, TSLL: { name: '테슬라 2배', g: 'single', lev: 2 }, MSTU: { name: '마이크로스트래티지 2배', g: 'single', lev: 2 }, AMDL: { name: 'AMD 2배', g: 'single', lev: 2 },
  };
  const GROUPS = { nasdaq: '나스닥100', sp500: 'S&P500', semi: '반도체', other: '기타 ETF', single: '개별주 레버리지 ETF' };
  const CORE = ['QQQ', 'TQQQ', 'SQQQ', 'US100', 'SPY', 'US500', 'SOXL', 'SOXS', 'SOXX', 'SMH'];

  const ema = (a, n) => { const k = 2 / (n + 1), out = []; let e = null; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out.push(i < n - 1 ? null : e); } return out; };
  function rsi(c, n) {
    n = n || 14; const out = c.map(() => null); if (c.length <= n) return out;
    let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n; out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    return out;
  }
  function wilder(a, n) { const out = a.map(() => null); if (a.length <= n) return out; let s = a.slice(1, n + 1).reduce((x, y) => x + y, 0); out[n] = s; for (let i = n + 1; i < a.length; i++) { s = s - s / n + a[i]; out[i] = s; } return out; }
  function ind(cs) {
    const c = cs.map((k) => k.c), n = c.length;
    const e12 = ema(c, 12), e26 = ema(c, 26), macd = c.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
    const st = macd.findIndex((x) => x != null), sp = st < 0 ? [] : ema(macd.slice(st), 9), sig = macd.map((_, i) => (st >= 0 && i >= st ? sp[i - st] : null));
    const hist = macd.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null));
    const tr = cs.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1].c), Math.abs(k.l - cs[i - 1].c)) : k.h - k.l));
    const atr = cs.map(() => null); if (n > 14) { let a = tr.slice(1, 15).reduce((x, y) => x + y, 0) / 14; atr[14] = a; for (let i = 15; i < n; i++) { a = (a * 13 + tr[i]) / 14; atr[i] = a; } }
    // ADX(14)
    const pdm = cs.map((k, i) => { if (!i) return 0; const up = k.h - cs[i - 1].h, dn = cs[i - 1].l - k.l; return up > dn && up > 0 ? up : 0; });
    const mdm = cs.map((k, i) => { if (!i) return 0; const up = k.h - cs[i - 1].h, dn = cs[i - 1].l - k.l; return dn > up && dn > 0 ? dn : 0; });
    const trS = wilder(tr, 14), pS = wilder(pdm, 14), mS = wilder(mdm, 14);
    const dx = c.map((_, i) => { if (trS[i] == null || !trS[i]) return null; const p = (100 * pS[i]) / trS[i], m = (100 * mS[i]) / trS[i]; return p + m ? (100 * Math.abs(p - m)) / (p + m) : 0; });
    const adx = c.map(() => null); const d0 = dx.findIndex((x) => x != null);
    if (d0 >= 0 && d0 + 14 <= n) { let a = dx.slice(d0, d0 + 14).reduce((x, y) => x + y, 0) / 14; adx[d0 + 13] = a; for (let i = d0 + 14; i < n; i++) { a = (a * 13 + dx[i]) / 14; adx[i] = a; } }
    return { c, ema5: ema(c, 5), ema20: ema(c, 20), ema50: ema(c, 50), ema200: ema(c, 200), rsi: rsi(c), macd, sig, hist, atr, adx, pdi: c.map((_, i) => (trS[i] ? (100 * pS[i]) / trS[i] : null)), mdi: c.map((_, i) => (trS[i] ? (100 * mS[i]) / trS[i] : null)) };
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  // 한 종목·한 봉 단위 분석. dayStart: VWAP 기준 시작 시각(ms, 그날 0시 UTC). 끝난 봉 기준
  function analyze(cs, opt) {
    opt = opt || {};
    const n = cs.length; if (n < 40) return { error: '봉이 40개보다 적음' };
    const I = ind(cs), i = n - 1, k = cs[i], p = k.c;
    const volAvg = avg(cs.slice(Math.max(0, i - 20), i).map((x) => x.v)), volRatio = volAvg ? k.v / volAvg : null;
    const rsiMin10 = Math.min(...I.rsi.slice(i - 10, i + 1).filter((x) => x != null)), rsiMax10 = Math.max(...I.rsi.slice(i - 10, i + 1).filter((x) => x != null));
    const lowRecent = Math.min(...cs.slice(i - 2, i + 1).map((x) => x.l)), lowPrev = Math.min(...cs.slice(i - 15, i - 2).map((x) => x.l));
    const highRecent = Math.max(...cs.slice(i - 2, i + 1).map((x) => x.h)), highPrev = Math.max(...cs.slice(i - 15, i - 2).map((x) => x.h));
    const h0 = I.hist[i], h1 = I.hist[i - 1], h2 = I.hist[i - 2];
    const up = [
      { key: 'rsi', name: 'RSI가 최근 40 이하까지 내려갔다가 다시 오름', ok: rsiMin10 <= 40 && I.rsi[i] > I.rsi[i - 3] },
      { key: 'macd', name: h0 > 0 && h1 <= 0 ? 'MACD 히스토그램 음→양 전환' : 'MACD 히스토그램 2봉 연속 좋아짐', ok: h0 != null && h1 != null && h2 != null && ((h0 > 0 && h1 <= 0) || (h0 > h1 && h1 > h2)) },
      { key: 'ema5', name: '종가가 5봉 지수평균 위로 회복', ok: I.ema5[i] != null && p > I.ema5[i] },
      { key: 'vol', name: '거래량 늘며 양봉(평균의 1.3배 이상)', ok: volRatio != null && volRatio >= 1.3 && k.c > k.o },
      { key: 'low', name: '직전 저점을 지킴(최근 3봉 저점이 그 전 저점보다 높음)', ok: lowRecent > lowPrev },
    ];
    const dn = [
      { key: 'rsi', name: 'RSI가 최근 60 이상까지 올랐다가 다시 내림', ok: rsiMax10 >= 60 && I.rsi[i] < I.rsi[i - 3] },
      { key: 'macd', name: h0 < 0 && h1 >= 0 ? 'MACD 히스토그램 양→음 전환' : 'MACD 히스토그램 2봉 연속 나빠짐', ok: h0 != null && h1 != null && h2 != null && ((h0 < 0 && h1 >= 0) || (h0 < h1 && h1 < h2)) },
      { key: 'ema5', name: '종가가 5봉 지수평균 아래로 내려감', ok: I.ema5[i] != null && p < I.ema5[i] },
      { key: 'vol', name: '거래량 늘며 음봉(평균의 1.3배 이상)', ok: volRatio != null && volRatio >= 1.3 && k.c < k.o },
      { key: 'high', name: '고점이 낮아짐(최근 3봉 고점이 그 전 고점보다 낮음)', ok: highRecent < highPrev },
    ];
    const trendUp = I.ema20[i] != null && I.ema50[i] != null && p > I.ema20[i] && I.ema20[i] > I.ema50[i];
    const trendDn = I.ema20[i] != null && I.ema50[i] != null && p < I.ema20[i] && I.ema20[i] < I.ema50[i];
    const trend = trendUp ? 'up' : trendDn ? 'down' : 'side';
    // VWAP: 그날(UTC 0시)부터의 거래량 가중 평균. 일봉이면 최근 20봉
    let vw = null;
    { const from = opt.dayStart != null ? cs.findIndex((x) => x.t >= opt.dayStart) : -1, seg = from >= 0 && opt.daily !== true ? cs.slice(from) : cs.slice(-20);
      const pv = seg.reduce((s, x) => s + ((x.h + x.l + x.c) / 3) * x.v, 0), vv = seg.reduce((s, x) => s + x.v, 0); vw = vv ? pv / vv : null; }
    const atrPct = I.atr[i] ? (I.atr[i] / p) * 100 : null, atrPct20 = I.atr[i - 20] ? (I.atr[i - 20] / cs[i - 20].c) * 100 : null;
    const score = (L) => L.filter((x) => x.ok).length;
    return {
      t: k.t, price: p, open: k.o, rsi: I.rsi[i], macd: I.macd[i], sig: I.sig[i], hist: h0, adx: I.adx[i], pdi: I.pdi[i], mdi: I.mdi[i],
      ema5: I.ema5[i], ema20: I.ema20[i], ema50: I.ema50[i], ema200: I.ema200[i], atr: I.atr[i], atrPct, atrJump: atrPct && atrPct20 ? atrPct / atrPct20 : null,
      vwap: vw, vwapGap: vw ? ((p / vw) - 1) * 100 : null, volRatio, trend, up, dn, upScore: score(up), dnScore: score(dn), bars: n,
      chg: (m) => (n > m ? ((p / cs[n - 1 - m].c) - 1) * 100 : null),
    };
  }
  // 변동성 등급(일봉 ATR%)
  const volClass = (x) => (x == null ? '-' : x >= 10 ? '초고변동' : x >= 5 ? '고변동' : x >= 2 ? '중간' : '낮음');
  const strength = (s) => (s >= 4 ? '강' : s === 3 ? '보통' : s === 2 ? '약' : '없음');
  // 일봉 추세 한 줄(장기 기준선 포함)
  function dayTrend(a) {
    if (!a || a.error) return '-';
    const parts = [a.trend === 'up' ? '상승 추세(종가>EMA20>EMA50)' : a.trend === 'down' ? '하락 추세(종가<EMA20<EMA50)' : '횡보·전환 구간'];
    if (a.ema200 != null) parts.push(a.price > a.ema200 ? '200일선 위' : '200일선 아래');
    if (a.adx != null) parts.push('ADX ' + a.adx.toFixed(0) + (a.adx >= 25 ? '(추세 강함)' : '(추세 약함)'));
    return parts.join(' · ');
  }
  // OKX 봉([ts,o,h,l,c,vol,…,confirm], 최신 먼저) / 바이낸스 봉([openTime,o,h,l,c,v,closeTime,…], 오래된 것부터) → 공통 모양(끝난 봉만)
  const fromOkx = (rows) => (rows || []).filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  const fromBinance = (rows, now) => (rows || []).filter((k) => +k[6] < (now || Date.now())).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  return { META, GROUPS, CORE, analyze, volClass, strength, dayTrend, fromOkx, fromBinance, rsiSeries: rsi };
})();
/* ==== scan.js 끝 ==== */

/* ==== levels.js 시작 (선물 스캐너 앱과 같은 매물대·지지저항·강한 신호 계산 — alert/build.mjs가 nasdaq-futures/levels.js에서 그대로 복사, 직접 고치지 말 것) ==== */
/* 나스닥 선물 — 매물대(거래량 프로파일)와 지지·저항 가격 계산 (화면·네트워크 없이 계산만)
 * 봉: 오래된 것부터 [{t, o, h, l, c, v}]. 매물대는 각 봉의 거래량을 그 봉의 고가~저가 사이에 고르게 나눠 쌓는다.
 * POC: 거래가 가장 많이 쌓인 가격 / 가치 영역(VAH~VAL): 거래의 70%가 몰린 범위
 * HVN: 거래가 많이 쌓인 마디(지지·저항이 되기 쉬움) / LVN: 거래가 적은 빈 구간(가격이 빨리 지나가기 쉬움)
 */
const LV = (() => {
  function profile(cs, bins) {
    bins = bins || 48;
    if (!cs || cs.length < 10) return null;
    const lo = Math.min(...cs.map((k) => k.l)), hi = Math.max(...cs.map((k) => k.h));
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins, vol = new Array(bins).fill(0), up = new Array(bins).fill(0);
    for (const k of cs) {
      const a = Math.max(0, Math.min(bins - 1, Math.floor((k.l - lo) / step))), b = Math.max(0, Math.min(bins - 1, Math.floor((k.h - lo) / step)));
      const share = (k.v || 0) / (b - a + 1);
      for (let j = a; j <= b; j++) { vol[j] += share; if (k.c >= k.o) up[j] += share; }
    }
    const total = vol.reduce((s, x) => s + x, 0); if (!total) return null;
    const poc = vol.indexOf(Math.max(...vol));
    let inside = vol[poc], dn = poc, upi = poc;
    while (inside < total * 0.7 && (dn > 0 || upi < bins - 1)) {
      const nd = dn > 0 ? vol[dn - 1] : -1, nu = upi < bins - 1 ? vol[upi + 1] : -1;
      if (nd >= nu) { dn--; inside += vol[dn]; } else { upi++; inside += vol[upi]; }
    }
    const mid = (j) => lo + step * (j + 0.5), mean = total / bins;
    const hvn = [], lvn = [];
    for (let j = 1; j < bins - 1; j++) {
      if (vol[j] >= mean * 1.3 && vol[j] >= vol[j - 1] && vol[j] >= vol[j + 1] && j !== poc) hvn.push(mid(j));
      if (vol[j] <= mean * 0.45 && vol[j] <= vol[j - 1] && vol[j] <= vol[j + 1]) lvn.push(mid(j));
    }
    return { lo, hi, step, bins: vol, upBins: up, poc: mid(poc), pocIdx: poc, vah: lo + step * (upi + 1), val: lo + step * dn, hvn, lvn, total };
  }
  function swings(cs, w) {
    w = w || 5; const highs = [], lows = [];
    for (let i = w; i < cs.length - w; i++) {
      let hi = true, lo = true;
      for (let k = i - w; k <= i + w; k++) { if (k === i) continue; if (cs[k].h > cs[i].h) hi = false; if (cs[k].l < cs[i].l) lo = false; }
      if (hi) highs.push({ i, p: cs[i].h }); if (lo) lows.push({ i, p: cs[i].l });
    }
    return { highs, lows };
  }
  const emaLast = (c, n) => { if (c.length < n) return null; const k = 2 / (n + 1); let e = c[0]; for (let i = 1; i < c.length; i++) e = c[i] * k + e * (1 - k); return e; };
  // 현재가 아래 지지·위 저항: 매물대(POC·VAH·VAL·HVN)·스윙 고저점·EMA50/200을 ATR 0.5배 안에서 묶음
  function levels(cs, atr) {
    const p = cs[cs.length - 1].c, vp = profile(cs.slice(-200)), sw = swings(cs.slice(-200)), c = cs.map((k) => k.c);
    const A = atr || p * 0.01, cand = [];
    const add = (price, label) => { if (Number.isFinite(price) && price > 0) cand.push({ p: price, label }); };
    if (vp) { add(vp.poc, '매물대 중심(POC)'); add(vp.vah, '가치영역 상단(VAH)'); add(vp.val, '가치영역 하단(VAL)'); vp.hvn.forEach((x) => add(x, '매물 마디(HVN)')); }
    sw.highs.slice(-8).forEach((s) => add(s.p, '스윙 고점')); sw.lows.slice(-8).forEach((s) => add(s.p, '스윙 저점'));
    const e50 = emaLast(c, 50), e200 = emaLast(c, 200); add(e50, 'EMA50'); add(e200, 'EMA200');
    const group = (L) => {
      const out = [];
      for (const x of L.sort((a, b) => a.p - b.p)) {
        const g = out.find((q) => Math.abs(q.p - x.p) <= A * 0.5);
        if (g) { g.items.push(x); g.p = g.items.reduce((s, y) => s + y.p, 0) / g.items.length; } else out.push({ p: x.p, items: [x] });
      }
      return out.map((g) => ({ p: g.p, labels: [...new Set(g.items.map((y) => y.label))], n: new Set(g.items.map((y) => y.label)).size, dist: ((g.p / p) - 1) * 100 }));
    };
    const sup = group(cand.filter((x) => x.p < p * 0.999)).sort((a, b) => b.p - a.p).slice(0, 4);
    const res = group(cand.filter((x) => x.p > p * 1.001)).sort((a, b) => a.p - b.p).slice(0, 4);
    let where = '';
    if (vp) where = p > vp.vah ? '가치영역 위(매물 적은 위쪽, 강세 쪽)' : p < vp.val ? '가치영역 아래(매물 적은 아래쪽, 약세 쪽)' : p >= vp.poc ? '가치영역 안 · POC 위' : '가치영역 안 · POC 아래';
    const inLvn = vp ? vp.lvn.some((x) => Math.abs(x - p) <= vp.step) : false;
    return { price: p, vp, sup, res, where, inLvn };
  }
  // 매수 검토 가격대(반등 쪽): 현재가 아래 1.5 ATR 안의 지지(근거 2개 이상 우선) 주변. 무효(손절) = 가격대 아래 1 ATR, 1차 목표 = 가장 가까운 저항
  function buyZone(lv, a) {
    const A = a.atr, p = a.price; if (!A || !lv) return null;
    const near = lv.sup.filter((s) => p - s.p <= 1.5 * A);
    const pick = near.find((s) => s.n >= 2) || near[0] || lv.sup[0]; if (!pick) return null;
    const low = pick.p - 0.25 * A, high = Math.min(p, pick.p + 0.5 * A), stop = low - A;
    const mid = (low + high) / 2, target = lv.res[0] ? lv.res[0].p : mid + 2 * (mid - stop);
    return { low, high, stop, target, rr: (target - mid) / (mid - stop), basis: pick.labels, star: pick.n >= 2, inZone: p >= low && p <= high * 1.001, dist: ((high / p) - 1) * 100 };
  }
  // 매도(숏) 검토 가격대(하락 전환 쪽): 현재가 위 1.5 ATR 안의 저항 주변. 무효 = 가격대 위 1 ATR, 1차 목표 = 가장 가까운 지지
  function sellZone(lv, a) {
    const A = a.atr, p = a.price; if (!A || !lv) return null;
    const near = lv.res.filter((s) => s.p - p <= 1.5 * A);
    const pick = near.find((s) => s.n >= 2) || near[0] || lv.res[0]; if (!pick) return null;
    const high = pick.p + 0.25 * A, low = Math.max(p, pick.p - 0.5 * A), stop = high + A;
    const mid = (low + high) / 2, target = lv.sup[0] ? lv.sup[0].p : mid - 2 * (stop - mid);
    return { low, high, stop, target, rr: (mid - target) / (stop - mid), basis: pick.labels, star: pick.n >= 2, inZone: p <= high && p >= low * 0.999, dist: ((low / p) - 1) * 100 };
  }
  // RSI 다이버전스(최근 40봉, 좌우 3봉 기준 스윙): 강세 = 가격 저점은 낮아졌는데 RSI 저점은 높아짐 / 약세 = 그 반대(고점)
  function divergence(cs, rsiArr) {
    const n = cs.length, from = Math.max(3, n - 40), lows = [], highs = [];
    for (let i = from; i < n - 3; i++) {
      let lo = true, hi = true;
      for (let k = i - 3; k <= i + 3; k++) { if (k === i) continue; if (cs[k].l < cs[i].l) lo = false; if (cs[k].h > cs[i].h) hi = false; }
      if (lo && rsiArr[i] != null) lows.push(i); if (hi && rsiArr[i] != null) highs.push(i);
    }
    const bull = lows.length >= 2 && (() => { const a = lows[lows.length - 2], b = lows[lows.length - 1]; return cs[b].l < cs[a].l && rsiArr[b] > rsiArr[a] + 1 && n - 1 - b <= 12; })();
    const bear = highs.length >= 2 && (() => { const a = highs[highs.length - 2], b = highs[highs.length - 1]; return cs[b].h > cs[a].h && rsiArr[b] < rsiArr[a] - 1 && n - 1 - b <= 12; })();
    return { bull, bear };
  }
  // 강한 신호 확인(기본 점수 4 이상일 때 추가로 5가지를 더 봄 → 3가지 이상이면 '강한 신호')
  function strong(cs, a, hi, lv, rsiArr) {
    const A = a.atr, p = a.price, last3 = cs.slice(-3), avg = cs.slice(-23, -3).reduce((s, k) => s + k.v, 0) / 20;
    const dv = divergence(cs, rsiArr);
    const buy = [
      { name: '상위 봉도 반등 쪽(상위 봉 반등 점수 3 이상)', ok: !!(hi && !hi.error && hi.upScore >= 3) },
      { name: '지지 근처(지지 가격 위 1 ATR 안)', ok: !!(lv && lv.sup[0] && p - lv.sup[0].p <= A) },
      { name: '그날 평균 거래가격(VWAP) 위', ok: a.vwapGap != null && a.vwapGap > 0 },
      { name: '최근 3봉 안에 거래량 1.5배 이상 양봉', ok: avg > 0 && last3.some((k) => k.v >= avg * 1.5 && k.c > k.o) },
      { name: 'RSI 강세 다이버전스(가격 저점↓·RSI 저점↑)', ok: dv.bull },
    ];
    const sell = [
      { name: '상위 봉도 하락 전환 쪽(상위 봉 하락 전환 점수 3 이상)', ok: !!(hi && !hi.error && hi.dnScore >= 3) },
      { name: '저항 근처(저항 가격 아래 1 ATR 안)', ok: !!(lv && lv.res[0] && lv.res[0].p - p <= A) },
      { name: '그날 평균 거래가격(VWAP) 아래', ok: a.vwapGap != null && a.vwapGap < 0 },
      { name: '최근 3봉 안에 거래량 1.5배 이상 음봉', ok: avg > 0 && last3.some((k) => k.v >= avg * 1.5 && k.c < k.o) },
      { name: 'RSI 약세 다이버전스(가격 고점↑·RSI 고점↓)', ok: dv.bear },
    ];
    const nb = buy.filter((x) => x.ok).length, ns = sell.filter((x) => x.ok).length;
    return { buy, sell, nb, ns, strongBuy: a.upScore >= 4 && nb >= 3, strongSell: a.dnScore >= 4 && ns >= 3 };
  }
  // 주식 분할(예: 10:1) 맞추기: 봉 기록에 분할 전 가격이 남아 있으면 변동성·매물대가 틀어짐.
  // 직전 종가→이번 시가, 또는 한 봉 안의 시가→종가가 1.85배 넘게 바뀌고 그 비율이 흔한 분할 비율에 가까우면 그 앞 봉들을 같은 비율로 맞춘다.
  const SPLIT_N = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 100];
  function fixSplits(cs) {
    if (!cs || cs.length < 3) return cs;
    const out = cs.map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }));
    let fixed = 0;
    for (let i = out.length - 1; i >= 1; i--) {
      const k = out[i];
      let r = out[i - 1].c / k.o, within = false;
      if (!(r > 1.85 || r < 0.54)) { r = k.o / k.c; within = true; if (!(r > 1.85 || r < 0.54)) continue; }
      const big = r > 1 ? r : 1 / r, n = SPLIT_N.reduce((p, q) => (Math.abs(q - big) < Math.abs(p - big) ? q : p));
      if (Math.abs(n - big) / n > (n <= 3 ? 0.06 : 0.25)) continue; // 분할 비율과 멀면 진짜 급등락으로 보고 그대로 둠(2·3배는 거의 딱 맞을 때만)
      const f = r > 1 ? 1 / n : n;
      for (let j = 0; j < i; j++) { const x = out[j]; x.o *= f; x.h *= f; x.l *= f; x.c *= f; x.v /= f; }
      if (within) { // 분할이 그 봉 안에서 일어남: 분할 전 쪽 값(시가와, 분할 전에 찍힌 고가·저가)만 맞춤
        k.o *= f; const hi = Math.max(k.o, k.c), lo = Math.min(k.o, k.c);
        if (f < 1 && k.h > hi * 1.5) k.h *= f;
        if (f > 1 && k.l < lo / 1.5) k.l *= f;
        k.h = Math.max(k.h, hi); k.l = Math.min(k.l, lo);
      }
      fixed++;
    }
    out.splits = fixed;
    return out;
  }
  return { profile, swings, levels, buyZone, sellZone, divergence, strong, fixSplits };
})();
/* ==== levels.js 끝 ==== */

/* ==== nq.js 시작 (앱과 같은 신호 계산 — alert/build.mjs가 ../nq.js에서 그대로 복사, 직접 고치지 말 것) ==== */
/* 가격 위치 — 📡 나스닥 신호 엔진 (OKX QQQ·TQQQ·SQQQ 무기한 선물, 공부용 규칙 신호)
 * 앱(브라우저)과 알림 스크립트(Apps Script)가 같은 계산을 쓰도록 화면·네트워크 없이 계산만 한다.
 * 자동 주문 없음. 신호는 정해진 규칙의 결과일 뿐 매수·매도 추천이 아니다.
 * 입력 봉: 오래된 것부터 [{t(시작 시각 ms), o, h, l, c, v}], 끝나지 않은 봉은 넣지 않는다.
 */
const NQ = (() => {
  const SYMS = { QQQ: 'QQQ-USDT-SWAP', TQQQ: 'TQQQ-USDT-SWAP', SQQQ: 'SQQQ-USDT-SWAP' };
  const DEF = { rsiMin: 50, atrMult: 2, rr: 2, feePct: 0.05, emaLen: 20 };
  const H4 = 4 * 3600e3, D1 = 86400e3;

  const sma = (a, n) => a.map((_, i) => (i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n));
  function ema(a, n) { const k = 2 / (n + 1), out = []; let e = null; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out.push(i < n - 1 ? null : e); } return out; }
  function rsi(c, n) {
    n = n || 14; const out = c.map(() => null); if (c.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n; out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    return out;
  }
  function macd(c) {
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const line = c.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
    const start = line.findIndex((x) => x != null);
    const sigPart = start < 0 ? [] : ema(line.slice(start), 9);
    const sig = line.map((_, i) => (start >= 0 && i >= start ? sigPart[i - start] : null));
    return { line, sig, hist: line.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null)) };
  }
  function atr(cs, n) {
    n = n || 14; const out = cs.map(() => null); if (cs.length <= n) return out;
    const tr = cs.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1].c), Math.abs(k.l - cs[i - 1].c)) : k.h - k.l));
    let a = tr.slice(1, n + 1).reduce((s, x) => s + x, 0) / n; out[n] = a;
    for (let i = n + 1; i < cs.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
    return out;
  }
  function ind(cs, p) {
    const c = cs.map((k) => k.c), m = macd(c);
    return { c, ema: ema(c, p.emaLen), sma20: sma(c, 20), sma50: sma(c, 50), rsi: rsi(c), macd: m.line, sig: m.sig, hist: m.hist, atr: atr(cs) };
  }

  // 장세(QQQ 일봉, 끝난 봉만): 5가지 확인 → +1/-1 합계. +3 이상 상승장, -3 이하 하락장, 그 사이 횡보
  function regimeSeries(qd) {
    const I = ind(qd, DEF), out = [];
    for (let i = 0; i < qd.length; i++) {
      if (i < 60 || I.sma50[i] == null || I.sma50[i - 10] == null || I.hist[i] == null || I.rsi[i] == null) { out.push(null); continue; }
      const checks = [
        { key: 'c>sma50', name: '종가가 50일 평균 위', ok: I.c[i] > I.sma50[i], val: I.sma50[i] },
        { key: 'sma20>sma50', name: '20일 평균이 50일 평균 위', ok: I.sma20[i] > I.sma50[i], val: I.sma20[i] },
        { key: 'slope', name: '50일 평균이 10일 전보다 높음', ok: I.sma50[i] > I.sma50[i - 10], val: I.sma50[i - 10] },
        { key: 'macd', name: 'MACD가 시그널선 위', ok: I.hist[i] > 0, val: I.hist[i] },
        { key: 'rsi', name: 'RSI(14) 50 이상', ok: I.rsi[i] >= 50, val: I.rsi[i] },
      ];
      const score = checks.reduce((s, x) => s + (x.ok ? 1 : -1), 0);
      out.push({ t: qd[i].t, close: I.c[i], score, state: score >= 3 ? 'up' : score <= -3 ? 'down' : 'side', checks });
    }
    return out;
  }
  // 4시간봉이 끝나는 시각까지 끝난 일봉의 장세
  function regimeLookup(qd) {
    const rs = regimeSeries(qd);
    return (tEnd) => { let r = null; for (let i = 0; i < qd.length; i++) { if (qd[i].t + D1 <= tEnd) { if (rs[i]) r = rs[i]; } else break; } return r; };
  }
  const NEED = { TQQQ: 'up', SQQQ: 'down' };
  function entryChecks(I, i, p) {
    return [
      { name: 'MACD 히스토그램이 이번 봉에 음→양으로 바뀜', ok: I.hist[i] != null && I.hist[i - 1] != null && I.hist[i] > 0 && I.hist[i - 1] <= 0 },
      { name: `RSI(14) ${p.rsiMin} 이상`, ok: I.rsi[i] != null && I.rsi[i] >= p.rsiMin, val: I.rsi[i] },
      { name: `종가가 ${p.emaLen}봉 지수평균 위`, ok: I.ema[i] != null && I.c[i] > I.ema[i], val: I.ema[i] },
    ];
  }
  function levels(entry, a, p) {
    const stop = entry - p.atrMult * a, risk = entry - stop;
    return { entry, stop, r1: entry + risk, target: entry + p.rr * risk, riskPct: (risk / entry) * 100, targetPct: ((p.rr * risk) / entry) * 100, atr: a };
  }
  // 규칙대로 지난 봉들을 따라가며 가상 매매(한 종목에 한 번에 하나)
  function backtest(qd, inst, params) {
    const p = Object.assign({}, DEF, params || {}), reg = regimeLookup(qd), trades = [], open = {};
    for (const sym of ['TQQQ', 'SQQQ']) {
      const cs = inst[sym]; if (!cs || cs.length < 40) continue;
      const I = ind(cs, p); let pos = null;
      for (let i = 30; i < cs.length; i++) {
        const k = cs[i], r = reg(k.t + H4), st = r ? r.state : null;
        if (pos) {
          let exit = null, why = '';
          if (k.l <= pos.stop) { exit = Math.min(k.o, pos.stop); why = '손절'; }
          else if (k.h >= pos.target) { exit = Math.max(k.o, pos.target); why = '목표 도달'; }
          else if (st !== NEED[sym]) { exit = k.c; why = '장세 바뀜'; }
          else if (I.hist[i] < 0 && I.c[i] < I.ema[i]) { exit = k.c; why = '추세 약해짐'; }
          if (exit != null) {
            const pct = (exit / pos.entry - 1) * 100 - 2 * p.feePct;
            trades.push(Object.assign({}, pos, { exitT: k.t + H4, exit, why, pct, R: pct / pos.riskPct, bars: i - pos.i }));
            pos = null;
          }
          continue;
        }
        if (st === NEED[sym] && I.atr[i] != null && entryChecks(I, i, p).every((x) => x.ok)) pos = Object.assign({ sym, i, entryT: k.t + H4 }, levels(k.c, I.atr[i], p));
      }
      if (pos) open[sym] = pos;
    }
    trades.sort((a, b) => a.entryT - b.entryT);
    let cum = 0, peak = 0, dd = 0; trades.forEach((x) => { cum += x.R; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); });
    const wins = trades.filter((x) => x.pct > 0).length;
    const hold = (sym) => { const cs = inst[sym]; return cs && cs.length > 30 ? ((cs[cs.length - 1].c / cs[30].c) - 1) * 100 : null; };
    return { p, trades, open, stats: { n: trades.length, wins, winRate: trades.length ? (wins / trades.length) * 100 : null, totalR: cum, avgR: trades.length ? cum / trades.length : null, totalPct: trades.reduce((s, x) => s + x.pct, 0), maxDD: dd, from: Math.min(...['TQQQ', 'SQQQ'].filter((s) => inst[s] && inst[s].length > 30).map((s) => inst[s][30].t)), holdT: hold('TQQQ'), holdS: hold('SQQQ') } };
  }
  // 지금 상태: 최신 장세, 그 장세에 맞는 종목, 마지막으로 끝난 4시간봉의 진입 조건, 규칙상 열린 가상 포지션
  function evaluate(qd, inst, params) {
    const p = Object.assign({}, DEF, params || {}), rs = regimeSeries(qd).filter(Boolean), regime = rs[rs.length - 1] || null;
    const bt = backtest(qd, inst, p), want = regime ? (regime.state === 'up' ? 'TQQQ' : regime.state === 'down' ? 'SQQQ' : null) : null;
    const now = {};
    for (const sym of ['TQQQ', 'SQQQ']) {
      const cs = inst[sym]; if (!cs || cs.length < 40) continue;
      const I = ind(cs, p), i = cs.length - 1;
      now[sym] = { t: cs[i].t + H4, close: cs[i].c, rsi: I.rsi[i], hist: I.hist[i], ema: I.ema[i], atr: I.atr[i], checks: entryChecks(I, i, p), levels: I.atr[i] ? levels(cs[i].c, I.atr[i], p) : null };
    }
    const sig = want && now[want] && now[want].checks.every((x) => x.ok) && !bt.open[want] ? want : null;
    return { regime, want, now, open: bt.open, bt, signal: sig, p };
  }
  // OKX 봉 응답(최신 먼저, [ts,o,h,l,c,vol,…,confirm]) → 오래된 것부터, 끝난 봉만
  function fromOkx(rows) { return (rows || []).filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse(); }
  return { SYMS, DEF, H4, regimeSeries, backtest, evaluate, levels, fromOkx, ind };
})();
/* ==== nq.js 끝 ==== */

/* ==== zones.js 시작 (앱과 같은 계산식 — alert/build.mjs가 ../zones.js에서 그대로 복사, 직접 고치지 말 것) ==== */
/* 가격 위치 — 매수 검토 구간 계산(공부용)
   여러 근거(지지선·저항→지지 전환·매물대·매물 마디·주봉 지지·이동평균·볼린저·피보나치·RSI 과매도·ATR)가 겹치는 가격대를 찾아 점수를 매기고,
   구간마다 과거에 그 가격대에 닿았을 때 실제로 반등했는지(과거 반응)를 세어 함께 보여 준다.
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
  // 좌우 w개보다 높은 고점(스윙 고점)
  function swingHighs(cs, w = 5) {
    const out = [];
    for (let i = w; i < cs.length - w; i++) {
      let ok = true;
      for (let k = i - w; k <= i + w && ok; k++) if (k !== i && cs[k].h > cs[i].h) ok = false;
      if (ok) out.push({ i, p: cs[i].h });
    }
    return out;
  }
  // 일봉 → 주봉(월요일 시작, 한국 시간)
  function weekly(cs) {
    const out = [];
    for (const k of cs) {
      const d = new Date(k.t + 9 * 3600e3), wk = Math.floor((d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3) / (7 * 86400e3));
      const last = out[out.length - 1];
      if (last && last.wk === wk) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v; }
      else out.push({ wk, t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    }
    return out;
  }
  // 과거 반응: 가격이 위에서 내려와 이 구간에 닿은 때마다, 그 뒤 10봉 안에 구간 위로 1.5 ATR 이상 반등했는지 / 구간 아래로 0.5 ATR 넘게 뚫렸는지
  // (마지막 5봉은 결과를 아직 모르므로 뺌. 구간을 만든 저점 자체도 포함되므로 참고용)
  function reaction(cs, low, high, A) {
    let touches = 0, bounces = 0, breaks = 0, i = 1;
    const end = cs.length - 5;
    while (i < end) {
      if (cs[i - 1].l > high && cs[i].l <= high && cs[i].h >= low) {
        touches++;
        let res = 0;
        for (let k = i; k < Math.min(cs.length, i + 10) && !res; k++) {
          if (cs[k].c < low - A * 0.5) res = -1;
          else if (cs[k].h >= high + A * 1.5) res = 1;
        }
        if (res > 0) bounces++; else if (res < 0) breaks++;
        i += 3; // 같은 닿음을 여러 번 세지 않게
      } else i++;
    }
    return { touches, bounces, breaks };
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
    flip: '저항→지지 전환', hvn: '매물 마디(HVN)', wk: '주봉 지지선',
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
    flip: '예전에 여러 번 막혔던 고점(저항)을 가격이 뚫고 올라간 자리입니다. 뚫린 저항은 다시 내려올 때 지지가 되는 경우가 많습니다(역할 전환).',
    hvn: 'POC 말고도 거래가 유난히 많이 쌓인 가격 마디입니다(평균의 1.3배 이상). 많은 사람이 사고판 가격이라 멈추기 쉽습니다.',
    wk: '일봉을 주봉으로 묶어 찾은 주봉 저점입니다. 더 큰 단위에서도 멈췄던 가격이라 일봉 지지선보다 무게가 있습니다.',
  };

  // opt.tf: 'day'면 주봉 지지도 같이 봄
  function analyze(cs, opt) {
    opt = opt || {};
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
    // 7) 저항→지지 전환: 최근 200봉 스윙 고점 중 지금 가격 아래로 내려와 있는 것(이미 뚫은 저항)
    const highs = swingHighs(recent).map((h) => ({ ...h, i: h.i + off })).filter((h) => h.p < price && h.i < n - 3);
    const hg = [];
    for (const h of highs.sort((a, b) => a.p - b.p)) {
      const g = hg.find((x) => Math.abs(x.p - h.p) <= A * 0.5);
      if (g) { g.list.push(h); g.p = g.list.reduce((x, y) => x + y.p, 0) / g.list.length; } else hg.push({ p: h.p, list: [h] });
    }
    for (const g of hg) add('flip', g.p, { touches: g.list.length });
    // 8) 매물 마디: 거래량 프로파일에서 POC 말고 평균 1.3배 이상 쌓인 봉우리
    if (vp) {
      const avgV = vp.bins.reduce((x, y) => x + y, 0) / vp.bins.length;
      vp.bins.forEach((v, j) => { const p = vp.lo + vp.step * (j + 0.5); if (v >= avgV * 1.3 && (j === 0 || v >= vp.bins[j - 1]) && (j === vp.bins.length - 1 || v >= vp.bins[j + 1]) && Math.abs(p - vp.poc) > vp.step) add('hvn', p); });
    }
    // 9) 주봉 지지(일봉일 때): 주봉 스윙 저점(좌우 3주), 최근 2년
    if (opt.tf === 'day') {
      const wk = weekly(cs).slice(-104);
      if (wk.length >= 20) for (const s2 of swingLows(wk, 3)) if (s2.p < price) add('wk', s2.p);
    }

    // 현재가 아래(+1% 위까지) 근거만 → ATR 0.6배 안의 근거끼리 묶어 구간을 만든다
    const below = cand.filter((x) => x.p <= price * 1.01).sort((a, b) => b.p - a.p);
    const zones = [];
    for (const x of below) {
      // 구간 폭은 ATR 1.5배까지만(가까운 근거가 줄줄이 이어져 구간이 너무 넓어지지 않게)
      const z = zones.find((q) => x.p >= q.min - A * 0.6 && x.p <= q.max + A * 0.6 && Math.max(q.max, x.p) - Math.min(q.min, x.p) <= A * 1.5);
      if (z) { z.items.push(x); z.min = Math.min(z.min, x.p); z.max = Math.max(z.max, x.p); } else zones.push({ min: x.p, max: x.p, items: [x] });
    }
    const out = zones.map((z) => {
      // 같은 성격의 근거는 한 가지로 셈(피보나치 3개·이동평균 3개·매물대(POC·VAL·마디)가 한 구간에 겹쳐도 각각 1)
      const kinds = new Set(z.items.map((x) => (x.key.startsWith('fib') ? 'fib' : x.key.startsWith('ma') ? 'ma' : x.key === 'poc' || x.key === 'val' || x.key === 'hvn' ? 'vol' : x.key)));
      const touchBonus = Math.min(1, z.items.filter((x) => x.key === 'swing' || x.key === 'flip').reduce((s, x) => s + Math.max(0, x.touches - 1), 0) * 0.5);
      const low = z.min - A * 0.25, high = Math.min(z.max + A * 0.25, price * 1.01);
      const rx = reaction(cs, low, high, A);
      // 과거 반응: 2번 이상 닿았을 때 반등이 많으면 +0.5, 뚫림이 많으면 −0.5
      const rxBonus = rx.touches >= 2 ? (rx.bounces / rx.touches >= 0.6 ? 0.5 : rx.breaks / rx.touches >= 0.6 ? -0.5 : 0) : 0;
      const score = kinds.size + touchBonus + rxBonus;
      return { low, high, mid: (low + high) / 2, score: Math.round(score * 10) / 10, kinds: kinds.size, items: z.items.sort((a, b) => b.p - a.p), distPct: ((z.max - price) / price) * 100, react: rx };
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
  // 과거 반응 한 줄(앱·알림 공통)
  const reactText = (rx) => (!rx || !rx.touches ? '과거에 위에서 내려와 닿은 적 없음' : `과거 ${rx.touches}번 닿아 반등 ${rx.bounces}번 · 뚫림 ${rx.breaks}번`);
  return { analyze, rsiSeries, atr, swingLows, swingHighs, volumeProfile, weekly, reaction, reactText, LABEL, WHY };
})();
/* ==== zones.js 끝 ==== */

/* ───────── 코인선물 현재가: 바이낸스(구글 서버 위치에서 막힐 수 있음) → OKX ───────── */
// 빗썸 공개 시세(업비트와 같은 모양): 시세 주소만 허용, 30초 캐시
function bithumbGet_(path) {
  const ok = /^\/candles\/(days|minutes\/240|minutes\/60)\?market=KRW-[A-Z0-9]+&count=\d{1,3}(&to=[0-9A-Za-z%:.-]+)?$/.test(path) || /^\/ticker\?markets=KRW-[A-Z0-9]+(,KRW-[A-Z0-9]+){0,29}$/.test(path);
  if (!ok) return { ok: false, error: '허용하지 않는 빗썸 주소입니다' };
  try {
    const r = UrlFetchApp.fetch('https://api.bithumb.com/v1' + path, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return { ok: false, error: '빗썸 응답 ' + r.getResponseCode() };
    const d = JSON.parse(r.getContentText()); return Array.isArray(d) ? { ok: true, data: d } : { ok: false, error: '빗썸 응답 이상' };
  } catch (e) { return { ok: false, error: '빗썸 연결 실패' }; }
}
function bybitPrice_(sym) {
  try { const r = UrlFetchApp.fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + encodeURIComponent(sym), { muteHttpExceptions: true }); if (r.getResponseCode() !== 200) return 0; const j = JSON.parse(r.getContentText()); const t = j.result && j.result.list && j.result.list[0]; return t ? Number(t.lastPrice) || 0 : 0; } catch (e) { return 0; }
}
// 기초 이름(BTC, NVDA 등)의 무기한 선물 봉: OKX → 바이비트(끝난 봉만, 오래된 것부터)
function perpCandles_(base, tf) {
  const B = { day: ['1Dutc', 'D', 86400e3], h4: ['4H', '240', 4 * 3600e3], h1: ['1H', '60', 3600e3] }[tf] || ['1Dutc', 'D', 86400e3];
  try {
    const d = okx_('/market/candles?instId=' + encodeURIComponent(base) + '-USDT-SWAP&bar=' + B[0] + '&limit=300');
    const cs = d.filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
    if (cs.length >= 30) { cs.src = 'OKX 선물'; return cs; }
  } catch (e) { /* 바이비트로 */ }
  const r = UrlFetchApp.fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=' + encodeURIComponent(base) + 'USDT&interval=' + B[1] + '&limit=300', { muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() !== 200 || j.retCode !== 0) throw new Error(base + ': 바이낸스·OKX·바이비트 선물 봉을 받지 못함(' + r.getResponseCode() + ')');
  const cs = (j.result.list || []).filter((k) => +k[0] + B[2] <= Date.now()).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  cs.src = '바이비트 선물'; return cs;
}
function cfutPrice_(sym) {
  try {
    const r = UrlFetchApp.fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + encodeURIComponent(sym), { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) { const p = Number(JSON.parse(r.getContentText()).price); if (p) return p; }
  } catch (e) { /* 다음 */ }
  try {
    const inst = sym.replace(/USDT$/, '') + '-USDT-SWAP';
    const r = UrlFetchApp.fetch('https://www.okx.com/api/v5/market/ticker?instId=' + encodeURIComponent(inst), { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) { const j = JSON.parse(r.getContentText()); const p = Number(j.data && j.data[0] && j.data[0].last); if (p) return p; }
  } catch (e) { /* 바이비트로 */ }
  return bybitPrice_(sym);
}

/* ───────── Alpha Vantage(해외주식): 키는 여기만, 결과는 캐시(무료 하루 25회) ───────── */
const AV_FN_ = { TIME_SERIES_DAILY: 6 * 3600, TIME_SERIES_WEEKLY: 24 * 3600, SYMBOL_SEARCH: 7 * 86400, GLOBAL_QUOTE: 1800, OVERVIEW: 24 * 3600, NEWS_SENTIMENT: 6 * 3600 };
function avRelay_(d) {
  const fn = String(d.fn || '');
  if (!AV_FN_[fn]) return { ok: false, error: '허용하지 않는 Alpha Vantage 기능입니다' };
  if (!PropertiesService.getScriptProperties().getProperty('ALPHAVANTAGE_API_KEY')) return { ok: false, error: '스크립트 속성에 ALPHAVANTAGE_API_KEY가 없습니다' };
  const q = { function: fn };
  if (fn === 'SYMBOL_SEARCH') q.keywords = String(d.keywords || '').slice(0, 40);
  else q.symbol = String(d.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 16);
  if (!(q.symbol || q.keywords)) return { ok: false, error: '종목을 넣어 주세요' };
  if (fn === 'NEWS_SENTIMENT') return { ok: true, data: avNews_(q.symbol) };
  return { ok: true, data: avFetch_(q, AV_FN_[fn]) };
}
// 뉴스·감성 점수: 원본이 커서(캐시 한도 100KB) 필요한 칸만 줄여 6시간 캐시 — AI 분석의 뉴스·여론 담당이 씀
function avNews_(sym) {
  const cache = CacheService.getScriptCache(), ck = 'avn_' + sym, hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const j = avFetch_({ function: 'NEWS_SENTIMENT', tickers: sym, limit: 40, sort: 'LATEST' }, 0);
  if (!j.feed) return j; // Note·Information(한도)·오류는 그대로 돌려줌
  const out = { items: j.items, feed: j.feed.slice(0, 40).map((x) => {
    const ts = (x.ticker_sentiment || []).find((t) => t.ticker === sym) || {};
    return { t: x.time_published, title: String(x.title || '').slice(0, 200), src: x.source, sum: String(x.summary || '').slice(0, 300),
      s: Number(x.overall_sentiment_score), sl: x.overall_sentiment_label, rel: Number(ts.relevance_score), ts: Number(ts.ticker_sentiment_score), tl: ts.ticker_sentiment_label };
  }) };
  const t = JSON.stringify(out); if (t.length < 95000) cache.put(ck, t, 6 * 3600);
  return out;
}

/* ───────── Claude(AI 분석): 키는 여기만, 모델 고정, 하루 호출 한도 ───────── */
const AI_MODEL_ = 'claude-opus-5-5';
const AI_DEFAULT_DAILY_CALLS_ = 130; // 종목 1개 = 약 13번 → 하루 10종목. 속성 AI_DAILY_CALLS로 바꿀 수 있음
function aiUsage_() {
  const u = JSON.parse(PropertiesService.getScriptProperties().getProperty('AI_USAGE') || '{}');
  const day = kstDay_(Date.now());
  return u.day === day ? u : { day: day, calls: 0, inTok: 0, outTok: 0 };
}
function aiCap_() { return Number(PropertiesService.getScriptProperties().getProperty('AI_DAILY_CALLS')) || AI_DEFAULT_DAILY_CALLS_; }
function claudeRelay_(d) {
  const P = PropertiesService.getScriptProperties();
  const key = (P.getProperty('ANTHROPIC_API_KEY') || '').trim();
  if (!key) return { ok: false, error: '스크립트 속성에 ANTHROPIC_API_KEY가 없습니다' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  let u;
  try {
    u = aiUsage_();
    if (u.calls >= aiCap_()) return { ok: false, error: '오늘 AI 호출 한도(' + aiCap_() + '번)를 다 썼습니다. 내일 다시 하거나 속성 AI_DAILY_CALLS를 늘리세요' };
    u.calls++; P.setProperty('AI_USAGE', JSON.stringify(u)); // 먼저 세어 두기(동시에 여러 개가 와도 한도를 넘지 않게)
  } finally { lock.releaseLock(); }
  const effort = ['low', 'medium', 'high'].indexOf(d.effort) >= 0 ? d.effort : 'medium';
  const body = { model: AI_MODEL_, max_tokens: Math.max(500, Math.min(Number(d.maxTokens) || 8000, 16000)),
    system: String(d.system || '').slice(0, 30000), messages: [{ role: 'user', content: String(d.user || '').slice(0, 150000) }],
    output_config: { effort: effort }, fallbacks: 'default' };
  if (d.schema && typeof d.schema === 'object') body.output_config.format = { type: 'json_schema', schema: d.schema };
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' }, payload: JSON.stringify(body) });
  const code = r.getResponseCode();
  let j; try { j = JSON.parse(r.getContentText()); } catch (e) { return { ok: false, error: 'Claude 응답을 읽지 못함(' + code + ')' }; }
  if (code !== 200) return { ok: false, error: 'Claude 오류 ' + code + ': ' + String((j.error && j.error.message) || '').replace(/sk-ant-\S+/g, '<키>').slice(0, 200) };
  if (j.stop_reason === 'refusal') return { ok: false, error: 'Claude가 이 요청을 거절했습니다(' + ((j.stop_details && j.stop_details.category) || '사유 없음') + ')' };
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const inTok = (j.usage && (j.usage.input_tokens + (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0))) || 0, outTok = (j.usage && j.usage.output_tokens) || 0;
  lock.waitLock(20000);
  try { const v = aiUsage_(); v.inTok += inTok; v.outTok += outTok; P.setProperty('AI_USAGE', JSON.stringify(v)); } finally { lock.releaseLock(); }
  return { ok: true, text: text, stop: j.stop_reason, model: j.model, usage: { in: inTok, out: outTok } };
}
/** ANTHROPIC_API_KEY를 넣은 뒤 실행: 아주 짧은 질문 하나로 키가 되는지 확인(키 값은 찍지 않음, 비용 1원 안팎) */
function AI연결확인() {
  const r = claudeRelay_({ system: '한국어로 한 문장만 답하세요.', user: '연결 확인입니다. "연결됨"이라고만 답하세요.', effort: 'low', maxTokens: 500 });
  Logger.log(r.ok ? '✅ Claude 연결됨 (' + r.model + '): ' + r.text + ' / 토큰 입력 ' + r.usage.in + '·출력 ' + r.usage.out : '❌ ' + r.error);
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
  const q = '&resultType=json&' + Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  let r = UrlFetchApp.fetch(KRX_URL_ + '?serviceKey=' + krxKey_() + q, { muteHttpExceptions: true });
  let t = r.getContentText();
  // '등록되지 않은 서비스키'면 키를 다른 모양(인코딩↔디코딩)으로 한 번 더
  if (/SERVICE_KEY_IS_NOT_REGISTERED|등록되지 않은/.test(t)) {
    const raw = String(PropertiesService.getScriptProperties().getProperty('DATA_GO_KR_KEY') || '').trim();
    // 인코딩 키면 한 번 풀었다 다시 인코딩(다른 방식으로 인코딩된 경우), 디코딩 키면 인코딩하지 않은 그대로
    let alt = raw; try { alt = /%[0-9A-Fa-f]{2}/.test(raw) ? encodeURIComponent(decodeURIComponent(raw)) : raw; } catch (e) { alt = raw; }
    if (alt !== krxKey_()) { const r2 = UrlFetchApp.fetch(KRX_URL_ + '?serviceKey=' + alt + q, { muteHttpExceptions: true }); if (!/SERVICE_KEY_IS_NOT_REGISTERED|등록되지 않은/.test(r2.getContentText())) { r = r2; t = r2.getContentText(); } }
  }
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

/** 국내주식 키가 '등록되지 않은 서비스키'로 나올 때: 키 값은 찍지 않고 모양만 점검 */
function 공공데이터키점검() {
  const raw = String(PropertiesService.getScriptProperties().getProperty('DATA_GO_KR_KEY') || '');
  const k = raw.trim();
  if (!k) { Logger.log('DATA_GO_KR_KEY가 없습니다'); return; }
  const odd = k.replace(/[A-Za-z0-9+\/=%]/g, '');
  Logger.log('길이 ' + k.length + '자' + (raw.length !== k.length ? ' (앞뒤 공백·줄바꿈 ' + (raw.length - k.length) + '자 — 자동으로 뺌)' : '') + ' · 모양: ' + (/%[0-9A-Fa-f]{2}/.test(k) ? "'인코딩' 키(% 들어 있음)" : /[+\/=]/.test(k) ? "'디코딩' 키(+ / = 들어 있음)" : /^[0-9a-f]{64}$/i.test(k) ? '새 형식(64자 영숫자)' : '영숫자만') + (odd ? ' · ⚠️ 키에 쓰지 않는 글자 ' + odd.length + '개 섞임(복사할 때 따라온 글자일 수 있음)' : ''));
  try { const cs = krxCandles_('005930'); Logger.log('✅ 삼성전자 일봉 ' + cs.length + '개 받음'); }
  catch (e) { Logger.log('❌ ' + (e && e.message || e)); Logger.log('확인할 것: data.go.kr 마이페이지 → 활용신청 현황에서 "금융위원회_주식시세정보"가 승인인지, 그 화면의 "일반 인증키(Decoding)"를 그대로 DATA_GO_KR_KEY에 넣었는지'); }
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
  const au = aiUsage_();
  Logger.log('🤖 AI 분석(Claude ' + AI_MODEL_ + '): 키 ' + (P.getProperty('ANTHROPIC_API_KEY') ? '있음' : '없음') + ' / 오늘 ' + au.calls + '번 사용(한도 ' + aiCap_() + ') · 토큰 입력 ' + au.inTok + '·출력 ' + au.outTok + ' · 추정 $' + (au.inTok * 4 / 1e6 + au.outTok * 20 / 1e6).toFixed(2));
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
  line('빗썸(코인 예비)', () => { const r = bithumbGet_('/ticker?markets=KRW-BTC'); if (!r.ok) throw new Error(r.error); return '비트코인 ' + fmt_(r.data[0].trade_price) + '원'; });
  line('바이비트 선물(예비)', () => { const p = bybitPrice_('BTCUSDT'); if (!p) throw new Error('응답 없음(이 서버 위치에서 막혔을 수 있음)'); return 'BTCUSDT ' + p; });
  line('해외주식 선물가(OKX NVDA)', () => { const d = okx_('/market/ticker?instId=NVDA-USDT-SWAP'); return 'NVDA ' + d[0].last + ' USDT'; });
  line('코인선물 알림용 가격(바이낸스→OKX→바이비트)', () => { const p = cfutPrice_('BTCUSDT'); if (!p) throw new Error('모두 실패'); return String(p); });
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
