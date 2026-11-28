/* 🌍 시장 전체 카드 — 알림 스크립트 v17(네이버 시장 지표 중계) + OKX QQQ·SPY 무기한(24시간) + CoinGecko 전체 시장
 * AI 마켓 스캐너·선물 스캐너가 같은 파일을 씀. 필요한 전역: relay, relayOn, KV, esc, pct. 실패해도 다른 화면은 그대로.
 * 해석 한 줄은 정해진 기준으로 붙인 '공부용 참고'이지 예측이 아님. */
const MK_T = { good: ['🟢', '좋음'], mid: ['🟡', '보통'], warn: ['🟠', '주의'], bad: ['🔴', '위험'] };
// 지표별 해석(값·변화로 단계와 짧은 이유)
function mkRead(x) {
  const c = x.chg || 0;
  switch (x.key) {
    case 'vix': return x.price >= 30 ? ['bad', '공포 큼 — 변동성 매우 큼'] : x.price >= 20 ? ['warn', '불안 — 변동성 큰 편'] : x.price >= 15 ? ['mid', '보통'] : ['good', '안정'];
    case 'us10y': return x.diff >= 0.07 ? ['warn', '금리 급등 — 기술주·코인 부담'] : x.diff <= -0.07 ? ['good', '금리 하락 — 성장주에 우호적'] : x.price >= 4.75 ? ['warn', '금리 높은 수준'] : ['mid', '큰 변화 없음'];
    case 'dxy': return c >= 0.5 ? ['warn', '달러 강세 — 위험자산 부담'] : c <= -0.5 ? ['good', '달러 약세 — 위험자산에 우호적'] : ['mid', '큰 변화 없음'];
    case 'usdkrw': return x.price >= 1450 ? ['bad', '원화 많이 약함 — 외국인 매도 압력'] : c >= 0.5 ? ['warn', '원화 약세 — 외국인 매도 압력'] : c <= -0.5 ? ['good', '원화 강세 — 외국인 매수에 우호적'] : ['mid', '큰 변화 없음'];
    case 'wti': return Math.abs(c) >= 3 ? ['warn', c > 0 ? '유가 급등 — 물가·금리 부담' : '유가 급락 — 경기 걱정 신호일 수 있음'] : ['mid', '큰 변화 없음'];
    case 'gold': return c >= 1.5 ? ['warn', '금 급등 — 안전자산 선호(불안 심리)'] : ['mid', '큰 변화 없음'];
    default: return c <= -2 ? ['bad', '크게 하락'] : c <= -1 ? ['warn', '하락'] : c >= 1 ? ['good', '상승'] : ['mid', '보합'];
  }
}
function mkRow(x, valTxt) {
  if (x.error) return `<div class="row spread" style="font-size:13px;padding:3px 0"><span>${esc(x.name || x.key)}</span><span class="muted">못 받음</span></div>`;
  const [lv, why] = mkRead(x), [ic] = MK_T[lv];
  return `<div style="padding:4px 0;border-bottom:1px solid var(--line)"><div class="row spread" style="font-size:14px"><span>${ic} ${esc(x.name)}</span><span><b>${valTxt || x.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</b> <span class="${x.chg > 0 ? 'up' : x.chg < 0 ? 'down' : ''}">${x.key === 'us10y' ? (x.diff >= 0 ? '+' : '') + x.diff.toFixed(3) + '%p' : pct(x.chg)}</span></span></div><div class="muted" style="font-size:11px">${esc(why)}</div></div>`;
}
// 전체 분위기 점수(-? ~ +?): 좋음 +1, 주의 −1, 위험 −2
function mkMood(L) { let s = 0, n = 0; L.forEach((x) => { if (x.error) return; const lv = mkRead(x)[0]; s += lv === 'good' ? 1 : lv === 'warn' ? -1 : lv === 'bad' ? -2 : 0; n++; }); return { s, n, t: s >= 2 ? ['🟢', '위험자산에 우호적인 편'] : s <= -3 ? ['🔴', '조심할 신호가 많음'] : s <= -1 ? ['🟠', '주의 신호가 좀 있음'] : ['🟡', '뚜렷한 방향 없음'] }; }
async function mkMacro() {
  const hit = await KV.get('mkMacro', null);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.data;
  const d = await relay('naver', { kind: 'macro' });
  if (!d.macro) throw new Error('알림 스크립트를 v17 이상으로 바꿔야 시장 지표가 나옵니다');
  KV.set('mkMacro', { at: Date.now(), data: d.macro }).catch(() => {});
  return d.macro;
}
// OKX QQQ·SPY 무기한(24시간 — 미국장 밖 시간의 나스닥·S&P 선물 대신)
async function mkPerps() {
  const r = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP').then((x) => x.json());
  const out = {}; (r.data || []).forEach((t) => { if (t.instId === 'QQQ-USDT-SWAP' || t.instId === 'SPY-USDT-SWAP') out[t.instId.split('-')[0]] = { last: +t.last, chg: (+t.last / +t.open24h - 1) * 100 }; });
  return out;
}
/* opt.groups: ['us','kr','fx','perp'] 중 보여 줄 것, opt.title */
async function macroCard(host, opt) {
  if (!host) return;
  opt = Object.assign({ groups: ['perp', 'us', 'fx', 'kr'], title: '🌍 시장 전체' }, opt || {});
  host.innerHTML = `<div class="card"><h2>${opt.title}</h2><div class="muted">시장 지표 받는 중…</div></div>`;
  const perpP = opt.groups.includes('perp') ? mkPerps().catch(() => null) : Promise.resolve(null);
  let M = null, err = '';
  if (await relayOn()) { try { M = await mkMacro(); } catch (e) { err = e.message; } } else err = '설정에서 알림 스크립트를 연결하면 금리·달러·유가·VIX·코스피 수급이 나옵니다';
  const P = await perpP;
  let CGd = null; if (opt.groups.includes('coin')) { try { const h = await KV.get('mkCg', null); if (h && Date.now() - h.at < 10 * 60e3) CGd = h.data; else { const j = await fetch('https://api.coingecko.com/api/v3/global').then((x) => x.json()); CGd = { cap: j.data.total_market_cap.usd, chg: j.data.market_cap_change_percentage_24h_usd, btc: j.data.market_cap_percentage.btc, eth: j.data.market_cap_percentage.eth }; KV.set('mkCg', { at: Date.now(), data: CGd }).catch(() => {}); } } catch { CGd = null; } }
  if (!host.isConnected) return;
  const by = {}; (M ? M.items : []).forEach((x) => { by[x.key] = x; });
  const pick = (keys) => keys.map((k) => by[k]).filter(Boolean);
  const all = [];
  const sec = (title, rows) => (rows ? `<h4 style="margin:8px 0 2px">${title}</h4>${rows}` : '');
  let html = '';
  if (P && (P.QQQ || P.SPY)) { const L = ['QQQ', 'SPY'].filter((k) => P[k]).map((k) => ({ key: 'perp', name: k === 'QQQ' ? '나스닥(QQQ 무기한, 24시간)' : 'S&P500(SPY 무기한, 24시간)', price: P[k].last, chg: P[k].chg })); all.push(...L); html += sec('⏱️ 지금 움직임(24시간 거래)', L.map((x) => mkRow(x)).join('')); }
  if (opt.groups.includes('us')) { const L = pick(['nasdaq', 'sp500', 'dow', 'vix']); all.push(...L); if (L.length) html += sec('🇺🇸 미국 증시(직전 정규장)', L.map((x) => mkRow(x)).join('')); }
  if (opt.groups.includes('fx')) { const L = pick(['us10y', 'dxy', 'usdkrw', 'wti', 'gold']); all.push(...L); if (L.length) html += sec('💵 금리·달러·원자재', L.map((x) => mkRow(x, x.key === 'us10y' ? x.price.toFixed(3) + '%' : x.key === 'usdkrw' ? x.price.toLocaleString('ko-KR') + '원' : x.key === 'wti' || x.key === 'gold' ? '$' + x.price.toLocaleString('en-US') : null)).join('')); }
  if (opt.groups.includes('kr')) { const L = pick(['kospi', 'kosdaq']); all.push(...L); const f = M && M.kospiFlow;
    if (L.length || f) html += sec('🇰🇷 한국 증시', L.map((x) => mkRow(x)).join('') + (f ? `<div style="font-size:13px;padding:4px 0">${f.foreign > 0 ? '🟢' : '🟠'} 코스피 외국인 <b class="${f.foreign > 0 ? 'up' : 'down'}">${f.foreign > 0 ? '+' : ''}${f.foreign.toLocaleString('ko-KR')}억</b> · 기관 ${f.inst > 0 ? '+' : ''}${f.inst.toLocaleString('ko-KR')}억 · 개인 ${f.indiv > 0 ? '+' : ''}${f.indiv.toLocaleString('ko-KR')}억 <span class="muted">(${f.day.slice(4, 6)}/${f.day.slice(6, 8)})</span><div class="muted" style="font-size:11px">${f.foreign > 0 ? '외국인이 사는 날은 지수에 우호적인 편' : '외국인이 파는 날은 지수에 부담인 편'}</div></div>` : '')); }
  if (CGd) { const x = { key: 'coin', name: '코인 전체 시가총액', price: CGd.cap, chg: CGd.chg }; all.push(x); html += sec('🪙 코인 시장(CoinGecko)', mkRow(x, (CGd.cap / 1e12).toFixed(2) + '조 달러') + `<div class="muted" style="font-size:12px;padding:3px 0">비트코인 점유율 ${CGd.btc.toFixed(1)}% · 이더리움 ${CGd.eth.toFixed(1)}% — 비트코인 점유율이 오르면 알트코인이 약한 편</div>`); }
  const mood = mkMood(all);
  host.innerHTML = `<div class="card"><div class="row spread"><h2 style="margin:0">${opt.title}</h2>${mood.n ? `<b>${mood.t[0]} ${mood.t[1]}</b>` : ''}</div>
    ${html || ''}${err ? `<div class="muted" style="font-size:12px;margin-top:6px">${esc(err)}</div>` : ''}
    <div class="muted" style="font-size:11px;margin-top:6px">🟢좋음 🟡보통 🟠주의 🔴위험 — 정해진 기준으로 붙인 공부용 참고(예측 아님) · 출처: 네이버 증권(공개 주소, 알림 스크립트 중계)·OKX${M ? ' · ' + new Date(M.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준' : ''}</div></div>`;
}
