/* AI 마켓 스캐너 — 🎯 QQQ 지금 시점 타점(규칙 계산, 공부용 · 자동 주문 없음)
 * 데이터: OKX QQQ 무기한 4시간봉(+일봉). CME 나스닥 선물(NQ)과는 값·시간이 다르다(같은 % 움직임으로 참고).
 * 1) 진입 점수 0~100: 상위 봉(일봉) 추세·4시간봉 추세·MACD·RSI·주간 VWAP·지지/저항 거리·거래량·다이버전스/ADX를 점수로 더함(매수·매도 따로)
 * 2) 과거 같은 점수대 결과: 지난 4시간봉마다 같은 점수를 계산하고(그때까지 데이터만), 그 뒤 12봉 안에 +1.5 ATR이 −1 ATR보다 먼저 왔는지 셈
 * 3) 가격: 매수 검토 구간(검토 구간 계산 zones.js)·매도 검토 구간(위쪽 스윙 고점·매물대 상단)·손절·1~3차 목표, 분할 진입/청산 비율과 금액
 */
'use strict';

const NP = (() => {
  const ok = (...xs) => xs.every((x) => x != null && Number.isFinite(x));
  // 주간 VWAP(이번 주 월요일 00:00 UTC부터, 이번 봉까지)
  function weekVwap(cs) {
    const out = cs.map(() => null); let wk = null, pv = 0, vv = 0;
    cs.forEach((k, i) => {
      const d = new Date(k.t), w = Math.floor((k.t - ((d.getUTCDay() + 6) % 7) * 86400e3) / (7 * 86400e3));
      if (w !== wk) { wk = w; pv = 0; vv = 0; }
      const tp = (k.h + k.l + k.c) / 3; pv += tp * k.v; vv += k.v; out[i] = vv ? pv / vv : null;
    });
    return out;
  }
  // 4시간봉 i가 끝난 시각에 이미 끝난 일봉 인덱스
  function dayIdx(q4, qd) { const out = []; let j = -1; for (const k of q4) { const end = k.t + 4 * 3600e3; while (j + 1 < qd.length && qd[j + 1].t + 86400e3 <= end) j++; out.push(j); } return out; }
  // 점수 계산(롱·숏) — i까지의 데이터만 씀
  function scoreAt(X, i) {
    const { cs, I, D, di, vw, vAvg } = X, k = cs[i], p = k.c, j = di[i];
    if (!ok(I.ema20[i], I.ema50[i], I.hist[i], I.hist[i - 1], I.rsi[i], I.atr[i])) return null;
    const L = [], S = [];
    const add = (arr, w, name, cond) => arr.push({ w, name, ok: !!cond });
    const dUp = j >= 0 && ok(D.ema50[j]) && D.c[j] > D.ema50[j] && (D.ema200[j] == null || D.ema50[j] > D.ema200[j]);
    const dDn = j >= 0 && ok(D.ema50[j]) && D.c[j] < D.ema50[j] && (D.ema200[j] == null || D.ema50[j] < D.ema200[j]);
    add(L, 20, '상위 봉(일봉) 상승: 종가>EMA50>EMA200', dUp); add(S, 20, '상위 봉(일봉) 하락: 종가<EMA50<EMA200', dDn);
    add(L, 15, '4시간봉 추세 상승: 종가>EMA20>EMA50', p > I.ema20[i] && I.ema20[i] > I.ema50[i]); add(S, 15, '4시간봉 추세 하락: 종가<EMA20<EMA50', p < I.ema20[i] && I.ema20[i] < I.ema50[i]);
    add(L, 15, 'MACD 히스토그램 양수이거나 좋아지는 중', I.hist[i] > 0 || I.hist[i] > I.hist[i - 1]); add(S, 15, 'MACD 히스토그램 음수이거나 나빠지는 중', I.hist[i] < 0 || I.hist[i] < I.hist[i - 1]);
    add(L, 10, 'RSI 40~65(과열 아님, 힘 있음)', I.rsi[i] >= 40 && I.rsi[i] <= 65); add(S, 10, 'RSI 35~60(과매도 아님, 힘 빠짐)', I.rsi[i] >= 35 && I.rsi[i] <= 60);
    add(L, 10, '주간 VWAP 위(이번 주 평균 매수가보다 위)', vw[i] != null && p > vw[i]); add(S, 10, '주간 VWAP 아래', vw[i] != null && p < vw[i]);
    // 지지·저항 거리: 최근 60봉 저점·고점까지 1 ATR 안
    let lo = Infinity, hi = -Infinity; for (let q = Math.max(0, i - 60); q < i; q++) { lo = Math.min(lo, cs[q].l); hi = Math.max(hi, cs[q].h); }
    add(L, 15, '지지(최근 60봉 저점) 1 ATR 안 — 손절이 가까움', p - lo <= I.atr[i] * 1.5); add(S, 15, '저항(최근 60봉 고점) 1 ATR 안 — 손절이 가까움', hi - p <= I.atr[i] * 1.5);
    const upV = k.c > k.o && vAvg[i] && k.v > vAvg[i] * 1.2, dnV = k.c < k.o && vAvg[i] && k.v > vAvg[i] * 1.2;
    add(L, 5, '오른 봉에 거래량 증가(20봉 평균 1.2배↑)', upV); add(S, 5, '내린 봉에 거래량 증가(20봉 평균 1.2배↑)', dnV);
    add(L, 10, 'ADX 20↑에 +DI>−DI(상승 힘이 우세)', ok(I.adx[i], I.pdi[i], I.mdi[i]) && I.adx[i] >= 20 && I.pdi[i] > I.mdi[i]); add(S, 10, 'ADX 20↑에 −DI>+DI(하락 힘이 우세)', ok(I.adx[i], I.pdi[i], I.mdi[i]) && I.adx[i] >= 20 && I.mdi[i] > I.pdi[i]);
    const sum = (A) => A.reduce((a, x) => a + (x.ok ? x.w : 0), 0);
    return { long: sum(L), short: sum(S), L, S };
  }
  function prep(q4, qd) {
    const I = SCAN.ind(q4), Dx = SCAN.ind(qd), D = { c: qd.map((k) => k.c), ema50: Dx.ema50, ema200: Dx.ema200 };
    const vAvg = q4.map((_, i) => { if (i < 20) return null; let s = 0; for (let k = i - 20; k < i; k++) s += q4[k].v; return s / 20; });
    return { cs: q4, I, D, di: dayIdx(q4, qd), vw: weekVwap(q4), vAvg };
  }
  // 과거 같은 점수대 결과: 12봉 안에 +1.5 ATR(이김)이 −1 ATR(짐)보다 먼저 왔는지(한 봉에 둘 다면 짐)
  function history(X, side) {
    const B = [[0, 39], [40, 59], [60, 79], [80, 100]].map(([a, b]) => ({ a, b, n: 0, win: 0 }));
    for (let i = 60; i < X.cs.length - 12; i++) {
      const sc = scoreAt(X, i); if (!sc) continue;
      const v = sc[side], A = X.I.atr[i], p = X.cs[i].c, up = side === 'long' ? p + 1.5 * A : p - 1.5 * A, dn = side === 'long' ? p - A : p + A;
      let res = 0;
      for (let q = i + 1; q <= i + 12 && !res; q++) { const k = X.cs[q]; const lose = side === 'long' ? k.l <= dn : k.h >= dn, win = side === 'long' ? k.h >= up : k.l <= up; if (lose) res = -1; else if (win) res = 1; }
      const b = B.find((x) => v >= x.a && v <= x.b); b.n++; if (res > 0) b.win++;
    }
    return B;
  }
  // 가격 계획
  function plan(X, side) {
    const cs = X.cs, n = cs.length, i = n - 1, p = cs[i].c, A = X.I.atr[i];
    const zr = ZoneMath.analyze(cs, { tf: 'h4' });
    const highs = ZoneMath.swingHighs(cs.slice(-200), 3).map((x) => x.p), lows = ZoneMath.swingLows(cs.slice(-200), 3).map((x) => x.p);
    const vp = zr.vp || ZoneMath.volumeProfile(cs.slice(-120));
    const ladder = (start, dir, lv, risk) => { const out = []; lv.filter((x) => (x - start) * dir >= risk * 0.8).sort((a, b) => (a - b) * dir).forEach((x) => { if (out.length < 3 && (!out.length || Math.abs(x - out[out.length - 1]) >= A * 0.5)) out.push(x); }); if (!out.length) out.push(start + dir * risk * 2); while (out.length < 3) out.push(out[out.length - 1] + dir * Math.max(risk, A)); return out; };
    if (side === 'long') {
      const z = (!zr.error && zr.zones.find((q) => q.high >= p - 3 * A)) || { low: p - 1.2 * A, high: p - 0.4 * A, items: [{ label: '근거 겹친 구간 없음 → ATR 기준' }], grade: '약', prob: null };
      const top = Math.min(z.high, p), mid = (z.low + top) / 2, stop = z.low - 0.5 * A, avg = top * 0.4 + mid * 0.3 + z.low * 0.3;
      const tg = ladder(avg, 1, highs.concat(vp ? [vp.vah, vp.poc] : []), avg - stop);
      return { side, zone: z, entries: [[top, 40], [mid, 30], [z.low, 30]], avg, stop, targets: tg, basis: [...new Set(z.items.map((x) => x.label))], inside: p <= z.high && p >= z.low };
    }
    const res = highs.filter((x) => x > p).sort((a, b) => a - b)[0] || (vp && vp.vah > p ? vp.vah : p + A);
    const z = { low: Math.max(p, res - 0.5 * A), high: res + 0.25 * A }, mid = (z.low + z.high) / 2, stop = z.high + 0.5 * A, avg = z.low * 0.4 + mid * 0.3 + z.high * 0.3;
    const tg = ladder(avg, -1, lows.concat(vp ? [vp.val, vp.poc] : []), stop - avg);
    return { side, zone: z, entries: [[z.low, 40], [mid, 30], [z.high, 30]], avg, stop, targets: tg, basis: ['위쪽 스윙 고점(저항)' + (vp && Math.abs(vp.vah - res) < A ? '·매물대 상단' : '')], inside: p >= z.low && p <= z.high };
  }
  return { prep, scoreAt, history, plan, weekVwap };
})();

// 화면 카드
function nqPlanCard(D) {
  const q4 = D.Q4, qd = D.qd;
  if (!q4 || q4.length < 120) return '<div class="card"><h2>🎯 지금 시점 타점</h2><div class="muted">QQQ 4시간봉이 부족해 계산하지 못했습니다.</div></div>';
  const X = NP.prep(q4, qd), i = q4.length - 1, sc = NP.scoreAt(X, i);
  if (!sc) return '';
  const side = sc.long >= sc.short ? 'long' : 'short', P = NP.plan(X, side), H = NP.history(X, side), v = sc[side];
  const b = H.find((x) => v >= x.a && v <= x.b), rate = b && b.n >= 8 ? Math.round((b.win / b.n) * 100) : null;
  const col = v >= 70 ? 'var(--green)' : v >= 50 ? '#E8A317' : 'var(--muted)';
  const verdict = v >= 70 ? (side === 'long' ? '매수 쪽 근거가 많이 겹침' : '매도 쪽 근거가 많이 겹침') : v >= 50 ? '근거 절반 — 확인 뒤 일부만' : '근거 부족 — 관망';
  const f = (x) => n2(x, 2), pc = (x) => `${x >= P.avg ? '+' : ''}${(((x / P.avg) - 1) * 100).toFixed(2)}%`;
  const dirKo = side === 'long' ? '매수(롱)' : '매도(숏)';
  const items = sc[side === 'long' ? 'L' : 'S'];
  const A = X.I.atr[i], vw = X.vw[i], I = X.I;
  return `<div class="card" id="npCard" style="border:2px solid ${col}"><h2>🎯 지금 시점 타점 <span class="muted">(QQQ 4시간봉 규칙 계산)</span></h2>
    <div class="row spread" style="align-items:center"><div><div class="muted" style="font-size:12px">${dirKo} 진입 점수</div><b style="font-size:40px;line-height:1;color:${col}">${v}</b><span class="muted"> / 100</span></div>
      <div style="text-align:right"><b style="color:${col}">${verdict}</b><div class="muted" style="font-size:12px">반대쪽(${side === 'long' ? '매도' : '매수'}) 점수 ${sc[side === 'long' ? 'short' : 'long']}</div>
      <div style="font-size:13px;margin-top:2px">과거 같은 점수대(${b.a}~${b.b}) ${rate != null ? `<b>${rate}%</b> 이김 (${b.n}번)` : `<span class="muted">표본 ${b ? b.n : 0}번 — 부족</span>`}</div></div></div>
    <div style="height:10px;background:var(--line);border-radius:6px;margin:8px 0 4px;overflow:hidden"><div style="width:${v}%;height:100%;background:${col}"></div></div>
    <div class="muted" style="font-size:11px">이김 = 그 뒤 12봉(약 2일) 안에 +1.5 ATR이 −1 ATR보다 먼저 옴. 점수대별: ${H.map((x) => `${x.a}~${x.b}점 ${x.n ? Math.round((x.win / x.n) * 100) + '%' : '-'}(${x.n})`).join(' · ')}</div>
    <details style="margin-top:6px"><summary><b>근거 ${items.filter((x) => x.ok).length}/${items.length}개 일치</b></summary><ul class="checks" style="font-size:13px">${items.map((x) => `<li>${x.ok ? '✅' : '❌'} ${esc(x.name)} <span class="muted">(${x.w}점)</span></li>`).join('')}</ul></details>
    <h4 style="margin-top:10px">📍 ${dirKo} 검토 가격 ${P.inside ? '<span style="color:#E8A317">(지금 구간 안)</span>' : ''}</h4>
    <div class="grid2" style="font-size:14px">
      <div>검토 구간<br><b>${f(P.zone.low)} ~ ${f(P.zone.high)}</b></div><div>손절(무효)<br><b class="down">${f(P.stop)}</b> <span class="muted">(${pc(P.stop)})</span></div>
      ${P.targets.map((t, k) => `<div>${k + 1}차 목표<br><b class="up">${f(t)}</b> <span class="muted">(${pc(t)}, ${(Math.abs(t - P.avg) / Math.abs(P.avg - P.stop)).toFixed(1)}R)</span></div>`).join('')}
      <div>평균 진입가(분할)<br><b>${f(P.avg)}</b></div></div>
    <div class="muted" style="font-size:12px;margin-top:4px">근거: ${P.basis.map(esc).join(' · ')}${P.zone.grade ? ` · 신뢰도 ${P.zone.grade}${P.zone.prob != null ? ' · 과거 반등 ' + P.zone.prob + '%' : ''}` : ''}</div>
    <h4 style="margin-top:10px">🪜 분할 ${side === 'long' ? '매수' : '매도'}·청산 계획</h4>
    <label for="npAmt">이번에 쓸 총액 (USDT)</label><input id="npAmt" type="number" inputmode="decimal" value="1000">
    <div id="npOut" data-plan='${esc(JSON.stringify({ side, e: P.entries, stop: P.stop, t: P.targets, avg: P.avg }))}'></div>
    <ul class="steps" style="font-size:13px;margin-top:6px">
      <li><b>언제 들어가나</b>: 4시간봉이 검토 구간 안에서 ${side === 'long' ? '양봉' : '음봉'}으로 <b>끝난 뒤</b>(봉 마감 확인). 구간을 뚫고 손절가까지 가면 계획 취소.</li>
      <li><b>언제 나오나</b>: 1차 목표에서 40% 정리 → 남은 물량 손절을 평균 진입가(본전)로 → 2차 30% → 3차 30%.</li>
      <li><b>지표</b>: RSI ${n2(I.rsi[i], 0)} · MACD 히스토그램 ${n2(I.hist[i], 3)} · ADX ${n2(I.adx[i], 0)} · ATR ${f(A)} · 주간 VWAP ${f(vw)} · EMA20/50 ${f(I.ema20[i])}/${f(I.ema50[i])}</li>
      <li><b>나스닥 선물(NQ)로 볼 때</b>: 이 가격은 OKX QQQ 무기한 기준입니다. NQ에는 같은 <b>%</b>(손절·목표 %)를 대입하세요. NQ 1계약은 1포인트 $20, MNQ는 $2라 손절 폭(포인트) × 계약 수로 손실 금액을 먼저 계산하세요.</li></ul>
    <div class="muted" style="font-size:11px">규칙 계산 결과(공부용) · 매매 권유 아님 · 자동 주문 없음</div></div>`;
}
// 금액 입력 → 분할 금액·손익 표(한 번만 등록)
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'npAmt') { nqPlanAmt(); KV.set('npAmt', +e.target.value || 0).catch(() => {}); } });
async function nqPlanBind() { const el = document.getElementById('npAmt'); if (!el) return; el.value = (await KV.get('npAmt', 1000)) || 1000; nqPlanAmt(); }
function nqPlanAmt() {
  const out = document.getElementById('npOut'), el = document.getElementById('npAmt'); if (!out || !el) return;
  const P = JSON.parse(out.dataset.plan), amt = +el.value || 0, lg = P.side === 'long', f = (x) => n2(x, 2);
  const legs = P.e.map(([px, w]) => ({ px, w, usd: (amt * w) / 100, qty: (amt * w) / 100 / px }));
  const qty = legs.reduce((a, x) => a + x.qty, 0), cost = legs.reduce((a, x) => a + x.usd, 0), avg = qty ? cost / qty : P.avg;
  const pnl = (px) => (lg ? px - avg : avg - px) * qty;
  const tw = [40, 30, 30], tp = P.t.reduce((a, t, k) => a + (lg ? t - avg : avg - t) * qty * (tw[k] / 100), 0);
  out.innerHTML = `<div class="tblwrap"><table class="md" style="margin-top:6px;font-size:13px"><thead><tr><th>단계</th><th>가격</th><th>비율</th><th>금액</th></tr></thead><tbody>
    ${legs.map((x, k) => `<tr><td>${k + 1}차 ${lg ? '매수' : '매도'}</td><td>${f(x.px)}</td><td>${x.w}%</td><td>${x.usd.toFixed(0)} USDT</td></tr>`).join('')}
    ${P.t.map((t, k) => `<tr><td>${k + 1}차 정리</td><td>${f(t)}</td><td>${tw[k]}%</td><td class="up">+${((lg ? t - avg : avg - t) * qty * (tw[k] / 100)).toFixed(1)} USDT</td></tr>`).join('')}</tbody></table></div>
    <div class="grid2" style="font-size:14px;margin-top:4px"><div>모두 체결 시 평균가 <b>${f(avg)}</b></div><div>손절 시 <b class="down">${pnl(P.stop).toFixed(1)} USDT</b> (${amt ? ((pnl(P.stop) / amt) * 100).toFixed(1) : 0}%)</div>
      <div>목표 1~3차 모두 정리 시 <b class="up">+${tp.toFixed(1)} USDT</b></div><div>손익비 약 <b>1 : ${pnl(P.stop) ? (tp / -pnl(P.stop)).toFixed(2) : '-'}</b></div></div>
    <div class="muted" style="font-size:11px">배율 1배(현물처럼) 기준 · 수수료·펀딩비 제외. 배율을 쓰면 손익이 그 배수만큼 커집니다.</div>`;
}
