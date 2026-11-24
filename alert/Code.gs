/**
 * 가격 위치 앱 — 텔레그램 알림 스크립트 (Google Apps Script 웹 앱 + 10분 자동 확인)
 *
 * 앱이 계산한 '검토 구간'을 저장해 두고, 10분마다 업비트 공개 시세(키 없음)로 현재가를 확인해
 * 가격이 구간에 '들어올 때' 텔레그램·디스코드로 알린다(설정한 곳 모두). 주문 기능은 없다.
 *
 * ── 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 직접 넣을 값 ──
 *   TELEGRAM_BOT_TOKEN  텔레그램 봇 토큰(@BotFather에서 받은 값)   ┐ 텔레그램을 쓸 때
 *   TELEGRAM_CHAT_ID    알림 받을 채팅 ID(숫자)                      ┘
 *   DISCORD_WEBHOOK_URL 디스코드 채널 웹훅 주소(https://discord.com/api/webhooks/…) — 디스코드를 쓸 때
 *   (텔레그램·디스코드 중 하나 이상)
 *   APP_KEY             앱과 이 스크립트만 아는 암호(아무 긴 문자열). 앱 설정에도 같은 값
 *
 * 처음 한 번: 편집기에서 '알림켜기' 실행 → 10분마다 '가격확인'이 돌도록 트리거가 만들어진다.
 */

const VERSION = 3;
const COOLDOWN_H = 6; // 같은 구간 알림은 6시간에 한 번

function doPost(e) {
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const P = PropertiesService.getScriptProperties();
    const appKey = (P.getProperty('APP_KEY') || '').trim();
    if (!appKey || d.key !== appKey) return json_({ ok: false, error: 'denied' });
    if (d.action === 'ping') {
      return json_({ ok: true, version: VERSION, telegram: !!(P.getProperty('TELEGRAM_BOT_TOKEN') && P.getProperty('TELEGRAM_CHAT_ID')), discord: !!discordUrl_(), trigger: hasTrigger_(), watching: watch_().length });
    }
    if (d.action === 'upbit') return json_(upbitRelay_(String(d.path || '')));
    if (d.action === 'test') { const r = send_('✅ 가격 위치 알림 테스트입니다. 이 메시지가 보이면 연결이 잘 된 것입니다.'); return json_({ ok: true, sent: r }); }
    if (d.action === 'saveWatch') {
      const items = (d.items || []).slice(0, 30).map((x) => ({
        market: String(x.market || '').replace(/[^A-Z0-9-]/g, '').slice(0, 20), name: String(x.name || '').slice(0, 40), tf: String(x.tf || '').slice(0, 10),
        zones: (x.zones || []).slice(0, 5).map((z) => ({ low: Number(z.low), high: Number(z.high), score: Number(z.score) || 0, labels: (z.labels || []).slice(0, 8).map(String) })).filter((z) => z.low > 0 && z.high >= z.low),
      })).filter((x) => /^KRW-[A-Z0-9]+$/.test(x.market));
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
  const r = UrlFetchApp.fetch('https://api.upbit.com/v1/ticker?markets=' + items.map((x) => x.market).join(','), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return;
  const price = {};
  JSON.parse(r.getContentText()).forEach((t) => { price[t.market] = t.trade_price; });
  const P = PropertiesService.getScriptProperties();
  const state = JSON.parse(P.getProperty('STATE') || '{}');
  const now = Date.now();
  items.forEach((x) => {
    const p = price[x.market];
    if (!p) return;
    x.zones.forEach((z, i) => {
      const id = x.market + '|' + Math.round(z.low) + '|' + Math.round(z.high);
      const s = state[id] || { inside: false, last: 0 };
      const inside = p >= z.low && p <= z.high;
      if (inside && !s.inside && now - s.last > COOLDOWN_H * 3600e3) {
        send_('🔔 ' + x.name + ' (' + x.market.slice(4) + ') 검토 구간 진입\n' +
          '현재가 ' + fmt_(p) + '원\n' +
          '구간 ' + (i + 1) + ': ' + fmt_(z.low) + ' ~ ' + fmt_(z.high) + ' (' + x.tf + ', 근거 점수 ' + z.score + ')\n' +
          '근거: ' + z.labels.join(', ') + '\n\n' +
          '※ 공부용 알림입니다. 매수 추천이 아니며 결정과 책임은 본인에게 있습니다.');
        s.last = now;
      }
      s.inside = inside;
      state[id] = s;
    });
  });
  // 지금 저장된 구간이 아닌 오래된 기록은 정리
  const live = {};
  items.forEach((x) => x.zones.forEach((z) => { live[x.market + '|' + Math.round(z.low) + '|' + Math.round(z.high)] = 1; }));
  Object.keys(state).forEach((k) => { if (!live[k]) delete state[k]; });
  P.setProperty('STATE', JSON.stringify(state));
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
/** 편집기에서 실행해 설정 확인(토큰 값은 찍지 않음) */
function 설정확인() {
  const P = PropertiesService.getScriptProperties();
  Logger.log('텔레그램 봇 토큰: ' + (P.getProperty('TELEGRAM_BOT_TOKEN') ? '있음' : '없음') + ' / 채팅 ID: ' + (P.getProperty('TELEGRAM_CHAT_ID') ? '있음' : '없음') + ' / 디스코드 웹훅: ' + (discordUrl_() ? '있음' : (P.getProperty('DISCORD_WEBHOOK_URL') ? '모양이 틀림' : '없음')) + ' / APP_KEY: ' + (P.getProperty('APP_KEY') ? '있음' : '없음') + ' / 자동 확인: ' + (hasTrigger_() ? '켜짐' : '꺼짐') + ' / 저장된 코인: ' + watch_().length);
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

function watch_() { try { return (JSON.parse(PropertiesService.getScriptProperties().getProperty('WATCH') || '{}').items) || []; } catch (e) { return []; } }
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
