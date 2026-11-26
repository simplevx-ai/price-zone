/* AI 마켓 스캐너 — 🧪 백테스트·모의매매 공통 전략 (계산만, 화면·네트워크·주문 없음)
 * 지침(CLAUDE.md) 7장의 전략 A~F. 아래 조건은 '검증해 볼 예시'이며 수익이 입증된 규칙이 아니다.
 * 규칙: 봉 i의 신호는 봉 i가 끝난 뒤(종가 기준)에만 정해지고, 봉 i까지의 값만 쓴다(미래 봉을 보지 않음).
 *       상위 봉은 그 봉이 실제로 끝난 뒤에만 참조한다. 지표가 아직 없는 구간(초기)은 신호를 내지 않는다(0이나 미래 값으로 채우지 않음).
 * 지금은 롱(매수)만 시험한다. 진입·청산 가격과 체결은 backtest.js(과거)·paper.js(실시간 모의)가 따로 처리한다.
 * 봉: 오래된 것부터 [{t(시작 ms), o, h, l, c, v}], 끝난 봉만.
 */
'use strict';

const STRATS = (() => {
  const VERSION = '2026-11-27.1'; // 결과 재현용: 전략 규칙을 바꾸면 올린다
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
    return { cs, I, vAvg, hiUp: higherTrend(cs, opt.tfMs, opt.hiCs, opt.hiMs) };
  }
  // 지표가 다 생기기 전(앞쪽 봉)은 쓰지 않음
  const warmup = 60;
  return { VERSION, LIST, prepare, higherTrend, warmup };
})();
