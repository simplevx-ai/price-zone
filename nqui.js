/* AI 마켓 스캐너 — 📡 나스닥 신호 화면 (OKX QQQ·TQQQ·SQQQ 무기한 선물 공개 시세, 자동 주문 없음) */
'use strict';

const NQ_OKX = 'https://www.okx.com/api/v5';
async function okxGet(path) {
  let r; try { r = await fetch(NQ_OKX + path); } catch { throw new Error('OKX 시세를 받지 못했습니다(인터넷 확인)'); }
  const j = await r.json().catch(() => ({}));
  if (j.code !== '0') throw new Error('OKX 응답 오류 ' + (j.msg || r.status));
  return j.data || [];
}
// 봉 모으기: 최신 300개 + 과거 페이지(100개씩). 10분 동안 폰에 저장해 다시 씀
async function nqHist(inst, bar, pages) {
  const key = `nq:${inst}:${bar}`, hit = await KV.get(key, null);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
  let rows = await okxGet(`/market/candles?instId=${inst}&bar=${bar}&limit=300`), after = rows.length ? rows[rows.length - 1][0] : '';
  for (let p = 0; p < pages && after; p++) {
    await sleep(120);
    const r = await okxGet(`/market/history-candles?instId=${inst}&bar=${bar}&limit=100&after=${after}`);
    if (!r.length) break; rows = rows.concat(r); after = r[r.length - 1][0];
  }
  const data = NQ.fromOkx(rows);
  KV.set(key, { at: Date.now(), data }).catch(() => {});
  return data;
}
async function nqLoad() {
  const qd = await nqHist(NQ.SYMS.QQQ, '1Dutc', 3);
  const T = await nqHist(NQ.SYMS.TQQQ, '4H', 10), S = await nqHist(NQ.SYMS.SQQQ, '4H', 10), Q4 = await nqHist(NQ.SYMS.QQQ, '4H', 3); // 600봉: 타점 점수의 과거 결과 계산용
  const tick = {}, fund = {};
  await Promise.all(Object.entries(NQ.SYMS).map(async ([s, id]) => {
    try { const t = (await okxGet(`/market/ticker?instId=${id}`))[0]; tick[s] = { last: +t.last, open24: +t.open24h, vol: +t.volCcy24h, ts: +t.ts }; } catch { /* 없음 */ }
    try { const f = (await okxGet(`/public/funding-rate?instId=${id}`))[0]; fund[s] = { rate: +f.fundingRate, next: +f.fundingTime }; } catch { /* 없음 */ }
  }));
  return { qd, T, S, Q4, tick, fund };
}

const NQ_STATE_KO = { up: { t: '상승장', c: 'var(--red)', i: '📈' }, down: { t: '하락장', c: 'var(--blue)', i: '📉' }, side: { t: '횡보', c: 'var(--muted)', i: '➖' } };
const nqTime = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const n2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? '-' : Number(x).toFixed(d));
const chg = (cs, k) => (cs.length > k ? ((cs[cs.length - 1].c / cs[cs.length - 1 - k].c) - 1) * 100 : null);

async function viewNq() {
  const live = liveNow();
  setTitle('🔔 QQQ 규칙 신호');
  view().innerHTML = '<div class="card"><div class="muted">OKX 시세를 받는 중… (처음엔 10초쯤)</div></div>';
  let D;
  try { D = await nqLoad(); } catch (e) { if (!live()) return; view().innerHTML = `<div class="card errbox">${esc(e.message)}</div>`; return; }
  if (!live()) return;
  const ev = NQ.evaluate(D.qd, { TQQQ: D.T, SQQQ: D.S }), R = ev.regime, st = R ? NQ_STATE_KO[R.state] : null, bt = ev.bt, s = bt.stats;
  const cfg = await KV.get('nqAlert', { enabled: false }), rs = await KV.get('relayStatus', {});

  // 1) 세 종목 비교
  const day = (sym) => { const cs = sym === 'QQQ' ? D.qd : null; return cs; };
  const px = (sym, cs4) => {
    const t = D.tick[sym], f = D.fund[sym], c24 = t ? ((t.last / t.open24) - 1) * 100 : null;
    return `<div class="stat"><div class="muted" style="font-size:12px">${sym}</div><b>${t ? n2(t.last) : '-'}</b>
      <div class="${c24 > 0 ? 'up' : c24 < 0 ? 'down' : ''}" style="font-size:13px">24시간 ${pct(c24)}</div>
      <div class="muted" style="font-size:11px">5일 ${pct(chg(cs4, 30))} · 20일 ${pct(chg(cs4, 120))}<br>펀딩 ${f ? (f.rate * 100).toFixed(4) + '%' : '-'}</div></div>`;
  };
  const q1 = D.tick.QQQ ? (D.tick.QQQ.last / D.tick.QQQ.open24 - 1) * 100 : null, t1 = D.tick.TQQQ ? (D.tick.TQQQ.last / D.tick.TQQQ.open24 - 1) * 100 : null, s1 = D.tick.SQQQ ? (D.tick.SQQQ.last / D.tick.SQQQ.open24 - 1) * 100 : null;
  const ratio = (a) => (q1 && Math.abs(q1) > 0.15 && a != null ? (a / q1).toFixed(1) + '배' : '변동이 작아 계산 안 함');

  // 2) 지금 신호
  const want = ev.want, nw = want ? ev.now[want] : null, open = ev.open;
  const openRows = Object.values(open).map((o) => { const last = D.tick[o.sym] ? D.tick[o.sym].last : null, pnl = last ? ((last / o.entry) - 1) * 100 : null; return `<div class="zone in"><div class="row spread"><b>${o.sym} 가상 보유 중 <span class="muted" style="font-size:12px">(${nqTime(o.entryT)} 진입)</span></b><span class="${pnl > 0 ? 'up' : 'down'}">${pct(pnl)}</span></div>
      <div class="grid2" style="font-size:13px;margin-top:6px"><div>진입가 <b>${n2(o.entry)}</b></div><div>현재가 <b>${n2(last)}</b></div><div style="color:var(--blue)">손절가 <b>${n2(o.stop)}</b> (${pct(-o.riskPct)})</div><div style="color:var(--red)">목표가 <b>${n2(o.target)}</b> (${pct(o.targetPct)})</div><div class="muted">1R(위험만큼 이익) ${n2(o.r1)}</div><div class="muted">ATR ${n2(o.atr)}</div></div></div>`; }).join('');
  const sigCard = `<div class="card"><h2>지금 규칙 신호 <span class="muted">(마지막으로 끝난 4시간봉)</span></h2>
    ${ev.signal ? `<div class="okbox" style="border-color:var(--red);color:var(--red)">🔔 ${ev.signal} 매수 신호 — ${nqTime(nw.t)} 봉 마감 기준</div>` : `<div class="muted" style="font-size:14px">${want ? `${want} 진입 조건을 아직 다 채우지 못했습니다 → 관망` : '횡보장이라 새 진입 신호를 내지 않습니다 → 관망'}</div>`}
    ${want && nw ? `<ul class="checks">${nw.checks.map((c) => `<li>${c.ok ? '✅' : '⬜'} ${esc(c.name)}${c.val != null ? ` <span class="muted">(${n2(c.val)})</span>` : ''}</li>`).join('')}</ul>
      ${nw.levels ? `<div class="muted" style="font-size:13px">지금 들어간다면(규칙 계산): 진입 ${n2(nw.levels.entry)} · 손절 <b style="color:var(--blue)">${n2(nw.levels.stop)}</b> (${pct(-nw.levels.riskPct)}) · 목표 <b style="color:var(--red)">${n2(nw.levels.target)}</b> (${pct(nw.levels.targetPct)}) · 손익비 1:${ev.p.rr}</div>` : ''}` : ''}
    ${openRows ? `<h4>규칙상 열린 가상 포지션</h4>${openRows}` : '<div class="muted" style="font-size:12px;margin-top:6px">규칙상 지금 열린 가상 포지션은 없습니다.</div>'}</div>`;

  // 3) 과거 시험
  const tr = bt.trades.slice().reverse();
  const btCard = `<div class="card"><h2>과거 시험 <span class="muted">(규칙 그대로, ${s.from ? new Date(s.from).toLocaleDateString('ko-KR') : '-'}부터)</span></h2>
    <div class="grid2" style="font-size:14px"><div>거래 <b>${s.n}번</b></div><div>이긴 비율 <b>${s.winRate != null ? s.winRate.toFixed(0) + '%' : '-'}</b></div>
      <div>합계 <b class="${s.totalR > 0 ? 'up' : 'down'}">${n2(s.totalR)}R</b> <span class="muted">(${pct(s.totalPct)})</span></div><div>평균 <b>${n2(s.avgR)}R</b></div>
      <div>가장 깊은 하락 <b>${n2(s.maxDD)}R</b></div><div class="muted">그냥 들고 있었다면: TQQQ ${pct(s.holdT)} · SQQQ ${pct(s.holdS)}</div></div>
    <canvas id="nqEq" class="chart" style="height:120px;margin-top:8px" aria-label="누적 R 그래프"></canvas>
    <div class="muted" style="font-size:12px">R = 처음 정한 위험(진입가−손절가) 1배만큼의 손익. 수수료 한쪽 ${ev.p.feePct}% 반영, 펀딩비는 빠짐. 거래가 ${s.n}번뿐이라 이 숫자로 앞날을 판단하기엔 표본이 적습니다.</div>
    <details style="margin-top:8px"><summary>거래 기록 ${tr.length}건</summary><div class="tblwrap"><table class="md"><thead><tr><th>종목</th><th>진입</th><th>진입가→청산가</th><th>이유</th><th>결과</th></tr></thead><tbody>
      ${tr.map((x) => `<tr><td>${x.sym}</td><td>${nqTime(x.entryT)}</td><td>${n2(x.entry)}→${n2(x.exit)}</td><td>${esc(x.why)}</td><td class="${x.pct > 0 ? 'up' : 'down'}">${pct(x.pct)} · ${n2(x.R)}R</td></tr>`).join('')}</tbody></table></div></details></div>`;

  // 4) 알림
  const alertCard = `<div class="card"><div class="row spread"><b>🔔 디스코드 알림</b><label class="row" style="margin:0;color:var(--ink)"><input type="checkbox" id="nqAl" ${cfg.enabled ? 'checked' : ''} style="width:22px;min-height:22px"> 켜기</label></div>
    <div class="muted" style="font-size:13px;margin-top:4px">스크립트가 10분마다 확인해 ① 장세가 바뀔 때 ② 4시간봉 마감에 매수 신호가 나올 때 ③ 가상 포지션이 손절·목표·청산될 때 ④ 진행 중인 봉에서 손절가·목표가에 닿을 때 알립니다. 주문은 하지 않습니다.</div>
    ${rs.checkedAt && (rs.version || 0) < 8 ? '<div class="warnlist">스크립트를 새 버전(v8)으로 바꿔야 알림이 동작합니다</div>' : ''}
    ${rs.nq && rs.nq.enabled ? `<div class="muted" style="font-size:12px;margin-top:4px">스크립트 상태: 켜짐${rs.nq.regime ? ' · 장세 ' + (NQ_STATE_KO[rs.nq.regime] || {}).t : ''}${rs.nq.at ? ' · 마지막 확인 ' + nqTime(rs.nq.at) : ''}</div>` : ''}</div>`;

  view().innerHTML = `${nqSwitch('nq')}<div class="card warnlist" style="margin-top:0;font-size:13px">📘 정해진 규칙이 낸 신호입니다. 매수·매도 추천이 아니며 <b>자동 주문은 하지 않습니다</b>. TQQQ·SQQQ는 3배 레버리지 상품이고 선물은 손실이 원금보다 커질 수 있습니다.</div>${nqCmeCard()}
    <div class="card"><div class="row spread"><h2 style="margin:0">지금 장세 <span class="muted">(QQQ 일봉)</span></h2>${st ? `<b style="color:${st.c};font-size:18px">${st.i} ${st.t}</b>` : '<span class="muted">계산 못 함</span>'}</div>
      ${R ? `<div class="muted" style="font-size:12px;margin:4px 0 6px">점수 ${R.score > 0 ? '+' : ''}${R.score} (−5~+5, +3 이상 상승장 → TQQQ 쪽만, −3 이하 하락장 → SQQQ 쪽만, 그 사이 관망) · ${new Date(R.t).toLocaleDateString('ko-KR')} 마감 기준</div>
      <ul class="checks">${R.checks.map((c) => `<li>${c.ok ? '✅' : '❌'} ${esc(c.name)} <span class="muted">(${n2(c.val, c.key === 'macd' ? 3 : 2)})</span></li>`).join('')}</ul>` : ''}
      <canvas id="nqReg" class="chart" style="height:130px;margin-top:6px" aria-label="QQQ 일봉과 장세"></canvas>
      <div class="muted" style="font-size:11px">선: QQQ 종가 · 배경: <span style="color:var(--red)">상승장</span>/<span style="color:var(--blue)">하락장</span>/회색 횡보</div></div>
    <div class="card"><h2>QQQ · TQQQ · SQQQ 비교</h2><div class="grid3">${px('QQQ', D.Q4)}${px('TQQQ', D.T)}${px('SQQQ', D.S)}</div>
      <div class="muted" style="font-size:12px;margin-top:8px">배율 확인(24시간 변화 ÷ QQQ): TQQQ ${ratio(t1)} · SQQQ ${ratio(s1)} — 원래 TQQQ는 약 +3배, SQQQ는 약 −3배로 움직입니다. 크게 다르면 미국장이 쉬는 시간의 선물 가격이거나 괴리가 생긴 것입니다.</div></div>
    ${nqPlanCard(D)}${sigCard}${btCard}${alertCard}
    <div class="card"><details><summary><b>신호 규칙 자세히</b></summary><ol class="steps" style="margin-top:8px">
      <li><b>장세(QQQ 일봉)</b>: 종가>50일 평균 · 20일>50일 평균 · 50일 평균이 10일 전보다 높음 · MACD>시그널 · RSI≥50 — 맞으면 +1, 아니면 −1.</li>
      <li><b>종목</b>: 상승장이면 TQQQ, 하락장이면 SQQQ(인버스)만 봅니다. 횡보면 새로 들어가지 않습니다.</li>
      <li><b>진입(4시간봉 마감)</b>: MACD 히스토그램이 그 봉에서 음→양 · RSI ${ev.p.rsiMin} 이상 · 종가가 ${ev.p.emaLen}봉 지수평균 위 — 셋 다 맞을 때.</li>
      <li><b>손절가</b> = 진입가 − ATR(14)×${ev.p.atrMult}, <b>목표가</b> = 진입가 + (진입가−손절가)×${ev.p.rr} (손익비 1:${ev.p.rr}).</li>
      <li><b>청산</b>: 손절가·목표가에 닿거나, 장세가 바뀌거나, MACD 히스토그램 음수 + 종가가 ${ev.p.emaLen}봉 평균 아래.</li></ol></details></div>
    <div class="card"><h2>⚠️ 꼭 알아 둘 위험</h2><ul class="steps" style="font-size:13px">
      <li><b>3배 레버리지 감쇠</b>: TQQQ·SQQQ는 하루 수익률의 3배를 따라가서, 오르내림이 반복되면 지수가 제자리여도 값이 줄어듭니다.</li>
      <li><b>무기한 선물</b>: 8시간마다 펀딩비를 주고받고, 레버리지를 쓰면 강제 청산될 수 있습니다.</li>
      <li><b>24시간 거래</b>: 미국장이 쉬는 밤·주말에도 가격이 움직여 실제 ETF와 차이가 날 수 있습니다.</li>
      <li><b>짧은 기록</b>: TQQQ는 2026년 7월, SQQQ는 7월 중순 상장이라 과거 시험 거래 수가 적습니다.</li></ul></div>
    <div class="disc">시세: OKX 공개 API(QQQ·TQQQ·SQQQ-USDT-SWAP) · ${nqTime(Date.now())} 기준 · 자동 주문 없음</div>`;

  // 그래프
  nqPlanBind();
  drawNqRegime($('#nqReg'), D.qd.slice(-150), NQ.regimeSeries(D.qd).slice(-150));
  drawNqEquity($('#nqEq'), bt.trades);
  $('#nqAl').onchange = async (e) => {
    if (e.target.checked && !(await relayOn())) { e.target.checked = false; alert('설정에서 알림 스크립트를 먼저 연결해 주세요'); return; }
    try { await relay('saveNq', { enabled: e.target.checked }); await KV.set('nqAlert', { enabled: e.target.checked }); toast(e.target.checked ? '나스닥 신호 알림을 켰습니다' : '나스닥 신호 알림을 껐습니다'); }
    catch (err) { e.target.checked = !e.target.checked; alert('저장 실패: ' + err.message); }
  };
  // 스크립트의 실제 알림 상태로 스위치 맞추기(다른 기기나 스크립트 쪽에서 켜고 끈 경우)
  if (await relayOn()) {
    relay('ping').then(async (d) => {
      if (!d.nq) return;
      const cb = $('#nqAl'); if (cb) cb.checked = !!d.nq.enabled;
      if ((d.version || 0) >= 8 && cb) cb.closest('.card').querySelectorAll('.warnlist').forEach((w) => w.remove());
      await KV.set('nqAlert', { enabled: !!d.nq.enabled });
      const st = await KV.get('relayStatus', {}); st.nq = d.nq; st.version = d.version; await KV.set('relayStatus', st);
    }).catch(() => {});
  }
}

function nqCanvas(cv) { const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); return { g, w, h, css: getComputedStyle(document.documentElement) }; }
function drawNqRegime(cv, cs, rs) {
  if (!cv || cs.length < 2) return;
  const { g, w, h, css } = nqCanvas(cv), lo = Math.min(...cs.map((k) => k.c)), hi = Math.max(...cs.map((k) => k.c)), x = (i) => (i / (cs.length - 1)) * (w - 4) + 2, y = (p) => h - 4 - ((p - lo) / (hi - lo || 1)) * (h - 8);
  rs.forEach((r, i) => { if (!r) return; g.fillStyle = r.state === 'up' ? 'rgba(214,69,69,.13)' : r.state === 'down' ? 'rgba(28,96,214,.13)' : 'rgba(128,128,128,.08)'; g.fillRect(x(i) - (w / cs.length) / 2, 0, w / cs.length + 1, h); });
  g.strokeStyle = css.getPropertyValue('--ink') || '#15203A'; g.lineWidth = 1.5; g.beginPath(); cs.forEach((k, i) => (i ? g.lineTo(x(i), y(k.c)) : g.moveTo(x(i), y(k.c)))); g.stroke();
  g.fillStyle = css.getPropertyValue('--muted') || '#66708A'; g.font = '10px sans-serif'; g.fillText(hi.toFixed(0), 4, 11); g.fillText(lo.toFixed(0), 4, h - 4);
}
function drawNqEquity(cv, trades) {
  if (!cv) return;
  const { g, w, h, css } = nqCanvas(cv);
  const pts = [0]; trades.forEach((t) => pts.push(pts[pts.length - 1] + t.R));
  if (pts.length < 2) { g.fillStyle = css.getPropertyValue('--muted'); g.font = '12px sans-serif'; g.fillText('거래 기록이 없습니다', 8, 20); return; }
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), x = (i) => (i / (pts.length - 1)) * (w - 30) + 26, y = (v) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 12);
  g.strokeStyle = css.getPropertyValue('--line') || '#E2E6EF'; g.beginPath(); g.moveTo(26, y(0)); g.lineTo(w, y(0)); g.stroke();
  g.strokeStyle = pts[pts.length - 1] >= 0 ? '#D64545' : '#1C60D6'; g.lineWidth = 2; g.beginPath(); pts.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
  g.fillStyle = css.getPropertyValue('--muted') || '#66708A'; g.font = '10px sans-serif'; g.fillText(hi.toFixed(1) + 'R', 0, 10); g.fillText(lo.toFixed(1) + 'R', 0, h - 2);
}

/* CME 나스닥100 선물(NQ·MNQ) 월물 — 날짜로 지금 거래하는 월물 코드를 계산(시세 아님, 정보용) */
function nqCme(now = new Date()) {
  const M = [[2, 'H', 3], [5, 'M', 6], [8, 'U', 9], [11, 'Z', 12]]; // [월 인덱스, 코드, 월]
  const third = (y, m) => { const d = new Date(Date.UTC(y, m, 1)); const add = (5 - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(y, m, 1 + add + 14, 13, 30)); }; // 셋째 금요일 09:30 ET ≈ 13:30 UTC
  const list = [];
  for (let y = now.getUTCFullYear(); y <= now.getUTCFullYear() + 1; y++) for (const [m, c, mm] of M) { const ex = third(y, m); list.push({ code: 'NQ' + c + String(y).slice(2), mcode: 'MNQ' + c + String(y).slice(2), y, mm, exp: ex, roll: new Date(ex.getTime() - 8 * 86400e3) }); }
  const act = list.filter((x) => x.exp > now);
  const front = act[0], next = act[1];
  const rolled = now >= front.roll; // 롤오버 날이 지나면 거래가 다음 월물로 옮겨 감
  return { front, next, main: rolled ? next : front, rolled, daysToExp: Math.ceil((front.exp - now) / 86400e3), daysToRoll: Math.ceil((front.roll - now) / 86400e3) };
}
function nqCmeCard() {
  const k = nqCme(), d = (t) => `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  return `<div class="card"><h2>🏦 CME 나스닥100 선물 월물 <span class="muted">(정보 — 시세 아님)</span></h2>
    <div class="grid2" style="font-size:14px">
      <div>지금 주로 거래하는 월물<br><b style="font-size:18px">${k.main.code}</b> <span class="muted">(${k.main.y}년 ${k.main.mm}월물)</span></div>
      <div>만기(셋째 금요일)<br><b>${d(k.front.exp)}</b> <span class="muted">${k.front.code} · ${k.daysToExp}일 남음</span></div>
      <div>롤오버(다음 월물로 옮겨 가는 날)<br><b>${d(k.front.roll)}</b> <span class="muted">${k.rolled ? '지났음 → ' + k.next.code + ' 거래' : k.daysToRoll + '일 남음'}</span></div>
      <div>다음 월물<br><b>${k.next.code}</b> <span class="muted">만기 ${d(k.next.exp)}</span></div></div>
    <ul class="steps" style="font-size:13px;margin-top:8px">
      <li><b>NQ</b>(E-mini): 1포인트 = <b>$20</b> · 최소 움직임 0.25포인트 = $5</li>
      <li><b>MNQ</b>(Micro, ${k.main.mcode}): 1포인트 = <b>$2</b> · 0.25포인트 = $0.50 (NQ의 1/10)</li>
      <li>월물 코드: H=3월 · M=6월 · U=9월 · Z=12월 + 연도 두 자리 (예: NQZ25 = 2025년 12월물, <b>2025-12-19 만기로 끝남</b>)</li>
      <li>거래 시간(한국): 월~금 오전 7시(겨울 8시) ~ 다음 날 오전 6시(겨울 7시), 매일 1시간 쉼</li>
      <li>이 앱의 '나스닥 선물'은 OKX·바이낸스의 <b>QQQ 무기한</b>(24시간·펀딩비) 가격입니다. CME NQ와 값·시간이 다르며, CME 실시간 시세는 한국투자증권 키를 넣으면 볼 수 있게 할 예정입니다.</li></ul></div>`;
}
