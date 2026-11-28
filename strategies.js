/* AI 마켓 스캐너 — 🧪 백테스트·모의매매 공통 전략 (계산만, 화면·네트워크·주문 없음)
 * 지침(CLAUDE.md) 7장의 전략 A~F. 아래 조건은 '검증해 볼 예시'이며 수익이 입증된 규칙이 아니다.
 * 규칙: 봉 i의 신호는 봉 i가 끝난 뒤(종가 기준)에만 정해지고, 봉 i까지의 값만 쓴다(미래 봉을 보지 않음).
 *       상위 봉은 그 봉이 실제로 끝난 뒤에만 참조한다. 지표가 아직 없는 구간(초기)은 신호를 내지 않는다(0이나 미래 값으로 채우지 않음).
 * A~F는 지침의 기본 예시, G~K는 2026-11-28 추가(볼린저 반등·돌파·눌림목·거래량 돌파·다중 확인). 지금은 롱(매수)만 시험한다. 진입·청산 가격과 체결은 backtest.js(과거)·paper.js(실시간 모의)가 따로 처리한다.
 * 봉: 오래된 것부터 [{t(시작 ms), o, h, l, c, v}], 끝난 봉만.
 */
'use strict';

const STRATS = (() => {
  const VERSION = '2026-11-28.1'; // G~K 추가(A~F 규칙은 그대로) // 결과 재현용: 전략 규칙을 바꾸면 올린다
  const ok = (...xs) => xs.every((x) => x != null && Number.isFinite(x));
  const crossUp = (I, i) => ok(I.hist[i], I.hist[i - 1]) && I.hist[i] > 0 && I.hist[i - 1] <= 0;
  const crossDn = (I, i) => ok(I.hist[i], I.hist[i - 1]) && I.hist[i] < 0 && I.hist[i - 1] >= 0;

  const LIST = {
    A: {
      name: 'A. RSI 과매도 뒤 반등', desc: '최근 5봉 안에 RSI(14)가 30 아래였고, RSI가 35 위로 올라오며 양봉. 청산: RSI 65 이상',
      enter: (P, i) => { const { I, cs } = P; if (!ok(I.rsi[i], I.rsi[i - 1])) return false; let low = false; for (let k = i - 5; k < i; k++) if (I.rsi[k] != null && I.rsi[k] < 30) low = true; return low && I.rsi[i] >= 35 && I.rsi[i] > I.rsi[i - 1] && cs[i].c > cs[i].o; },
      exit: (P, i) => (P.I.rsi[i] != null && P.I.rsi[i] >= 65 ? 'RSI 65 도달' : ''),
    },
    B: {
      name: 'B. MACD 골든크로스', desc: 'MACD 히스토그램 음→양(골든크로스). 청산: 양→음(데드크로스)',
      enter: (P, i) => crossUp(P.I, i),
      exit: (P, i) => (crossDn(P.I, i) ? 'MACD 데드크로스' : ''),
    },
    C: {
      name: 'C. EMA20 상향 돌파', desc: '종가가 EMA20을 아래에서 위로 돌파. 청산: 종가가 EMA20 아래로',
      enter: (P, i) => { const { I, cs } = P; return ok(I.ema20[i], I.ema20[i - 1]) && cs[i].c > I.ema20[i] && cs[i - 1].c <= I.ema20[i - 1]; },
      exit: (P, i) => (P.I.ema20[i] != null && P.cs[i].c < P.I.ema20[i] ? 'EMA20 아래로' : ''),
    },
    D: {
      name: 'D. EMA 정배열 + 거래량 증가', desc: 'EMA5>EMA20>EMA50 정배열에서 거래량이 20봉 평균의 1.5배 이상인 양봉(직전 봉은 조건 아님). 청산: 종가가 EMA20 아래로',
      enter: (P, i) => { const D = (k) => { const { I, cs, vAvg } = P; return ok(I.ema5[k], I.ema20[k], I.ema50[k], vAvg[k]) && I.ema5[k] > I.ema20[k] && I.ema20[k] > I.ema50[k] && cs[k].v >= vAvg[k] * 1.5 && cs[k].c > cs[k].o; }; return D(i) && !D(i - 1); },
      exit: (P, i) => (P.I.ema20[i] != null && P.cs[i].c < P.I.ema20[i] ? 'EMA20 아래로' : ''),
    },
    E: {
      name: 'E. RSI + MACD 복합', desc: 'MACD 골든크로스이면서 RSI 45~70. 청산: 데드크로스 또는 RSI 75 이상',
      enter: (P, i) => crossUp(P.I, i) && P.I.rsi[i] != null && P.I.rsi[i] >= 45 && P.I.rsi[i] <= 70,
      exit: (P, i) => (crossDn(P.I, i) ? 'MACD 데드크로스' : P.I.rsi[i] != null && P.I.rsi[i] >= 75 ? 'RSI 75 도달' : ''),
    },
    F: {
      name: 'F. 상위 봉 추세 + MACD', desc: '끝난 상위 봉(예: 15분봉이면 1시간봉)이 상승 추세(종가>EMA20>EMA50)일 때 하위 봉 MACD 골든크로스. 청산: 데드크로스 또는 상위 봉 추세 깨짐', needsHigher: true,
      enter: (P, i) => P.hiUp[i] === true && crossUp(P.I, i),
      exit: (P, i) => (crossDn(P.I, i) ? 'MACD 데드크로스' : P.hiUp[i] === false ? '상위 봉 추세 깨짐' : ''),
    },
    G: {
      name: 'G. 볼린저 하단 복귀', desc: '직전 봉이 볼린저 밴드(20, 2) 하단 아래에서 끝났고, 이번 봉이 하단 위로 돌아오며 RSI가 오름(과매도 되돌림). 청산: 종가가 밴드 중간선(20봉 평균) 이상',
      enter: (P, i) => { const { cs, bb, I } = P; return ok(bb.lo[i], bb.lo[i - 1], I.rsi[i], I.rsi[i - 1]) && cs[i - 1].c < bb.lo[i - 1] && cs[i].c > bb.lo[i] && I.rsi[i] > I.rsi[i - 1] && I.rsi[i] < 45; },
      exit: (P, i) => (P.bb.mid[i] != null && P.cs[i].c >= P.bb.mid[i] ? '밴드 중간선 도달' : ''),
    },
    H: {
      name: 'H. 20봉 고점 돌파(추세 추종)', desc: '종가가 앞 20봉 최고가를 넘고 EMA50 위, ADX 20 이상(추세가 있음). 청산: 종가가 앞 10봉 최저가 아래',
      enter: (P, i) => { const { cs, I, hh20 } = P; return ok(hh20[i], I.ema50[i], I.adx[i]) && cs[i].c > hh20[i] && cs[i].c > I.ema50[i] && I.adx[i] >= 20; },
      exit: (P, i) => (P.ll10[i] != null && P.cs[i].c < P.ll10[i] ? '10봉 최저가 아래' : ''),
    },
    I: {
      name: 'I. 상승 추세 눌림목', desc: 'EMA20>EMA50 상승 추세에서 저가가 EMA20 근처(0.3% 안)까지 내려왔다가 EMA20 위 양봉으로 마감, RSI 40~60. 청산: 종가가 EMA50 아래 또는 RSI 75 이상',
      enter: (P, i) => { const { cs, I } = P; return ok(I.ema20[i], I.ema50[i], I.rsi[i]) && I.ema20[i] > I.ema50[i] && cs[i].l <= I.ema20[i] * 1.003 && cs[i].c > I.ema20[i] && cs[i].c > cs[i].o && I.rsi[i] >= 40 && I.rsi[i] <= 60; },
      exit: (P, i) => (P.I.ema50[i] != null && P.cs[i].c < P.I.ema50[i] ? 'EMA50 아래로' : P.I.rsi[i] != null && P.I.rsi[i] >= 75 ? 'RSI 75 도달' : ''),
    },
    J: {
      name: 'J. 거래량 급증 돌파', desc: '거래량이 앞 20봉 평균의 2배 이상이면서 종가가 앞 20봉 최고가 위인 양봉. 청산: 종가가 EMA20 아래',
      enter: (P, i) => { const { cs, vAvg, hh20 } = P; return ok(vAvg[i], hh20[i]) && cs[i].v >= vAvg[i] * 2 && cs[i].c > hh20[i] && cs[i].c > cs[i].o; },
      exit: (P, i) => (P.I.ema20[i] != null && P.cs[i].c < P.I.ema20[i] ? 'EMA20 아래로' : ''),
    },
    K: {
      name: 'K. 다중 확인 점수(5점 중 4점)', desc: '①종가>EMA50 ②MACD 히스토그램 양수·증가 ③RSI 50~70 ④거래량>20봉 평균 ⑤상위 봉 상승(없으면 EMA20>EMA50) — 4점 이상이 되는 순간 진입. 청산: 1점 이하',
      enter: (P, i) => P.score[i] != null && P.score[i] >= 4 && (P.score[i - 1] == null || P.score[i - 1] < 4),
      exit: (P, i) => (P.score[i] != null && P.score[i] <= 1 ? '확인 점수 1점 이하' : ''),
    },
  };

  // 하위 봉 i가 끝난 시각에 이미 끝나 있던 마지막 상위 봉으로 추세 판단(상위 봉이 끝나기 전에는 쓰지 않음)
  function higherTrend(cs, tfMs, hiCs, hiMs) {
    const out = cs.map(() => null);
    if (!hiCs || !hiCs.length) return out;
    const H = SCAN.ind(hiCs);
    let j = -1;
    for (let i = 0; i < cs.length; i++) {
      const close = cs[i].t + tfMs;
      while (j + 1 < hiCs.length && hiCs[j + 1].t + hiMs <= close) j++;
      if (j < 0 || !ok(H.ema20[j], H.ema50[j])) continue;
      out[i] = hiCs[j].c > H.ema20[j] && H.ema20[j] > H.ema50[j];
    }
    return out;
  }
  // 전략에 필요한 값을 한 번에 계산(모든 전략이 같은 지표를 씀)
  function prepare(cs, opt) {
    opt = opt || {};
    const I = SCAN.ind(cs);
    const vAvg = cs.map((_, i) => { if (i < 20) return null; let s = 0; for (let k = i - 20; k < i; k++) s += cs[k].v; return s / 20; }); // 이번 봉을 뺀 앞 20봉
    const hiUp = higherTrend(cs, opt.tfMs, opt.hiCs, opt.hiMs);
    // 볼린저(20, 2) — 이번 봉까지
    const bb = { mid: cs.map(() => null), lo: cs.map(() => null), up: cs.map(() => null) };
    for (let i = 19; i < cs.length; i++) { let s = 0; for (let k = i - 19; k <= i; k++) s += cs[k].c; const m = s / 20; let v = 0; for (let k = i - 19; k <= i; k++) v += (cs[k].c - m) ** 2; const sd = Math.sqrt(v / 20); bb.mid[i] = m; bb.lo[i] = m - 2 * sd; bb.up[i] = m + 2 * sd; }
    // 앞 20봉 최고가·앞 10봉 최저가(이번 봉 제외 — 돌파 판단용)
    const hh20 = cs.map((_, i) => { if (i < 20) return null; let h = -Infinity; for (let k = i - 20; k < i; k++) h = Math.max(h, cs[k].h); return h; });
    const ll10 = cs.map((_, i) => { if (i < 10) return null; let l = Infinity; for (let k = i - 10; k < i; k++) l = Math.min(l, cs[k].l); return l; });
    // 다중 확인 점수(K)
    const score = cs.map((k, i) => {
      if (!ok(I.ema50[i], I.hist[i], I.hist[i - 1], I.rsi[i], vAvg[i])) return null;
      let s = 0;
      if (k.c > I.ema50[i]) s++;
      if (I.hist[i] > 0 && I.hist[i] > I.hist[i - 1]) s++;
      if (I.rsi[i] >= 50 && I.rsi[i] <= 70) s++;
      if (k.v > vAvg[i]) s++;
      if (hiUp[i] === true || (hiUp[i] == null && ok(I.ema20[i]) && I.ema20[i] > I.ema50[i])) s++;
      return s;
    });
    return { cs, I, vAvg, hiUp, bb, hh20, ll10, score };
  }
  // 지표가 다 생기기 전(앞쪽 봉)은 쓰지 않음
  const warmup = 60;
  return { VERSION, LIST, prepare, higherTrend, warmup };
})();
