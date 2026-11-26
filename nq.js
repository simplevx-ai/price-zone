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
