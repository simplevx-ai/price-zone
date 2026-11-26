/* AI 마켓 스캐너 — 🧪 백테스트 엔진 (과거 봉으로 가상 체결, 계산만 · 주문 없음)
 * 체결 규칙(지침 6장):
 *  - 신호는 봉 i 종가에 정해지고, 진입·신호 청산은 다음 봉(i+1) 시가에 체결한다(+슬리피지).
 *  - 손절·목표는 진입한 봉부터 확인한다. 한 봉에서 둘 다 닿으면 순서를 모르므로 손절로 본다(보수적).
 *  - 시가가 이미 손절가 아래로 갭이면 손절가가 아니라 시가에 체결한다(목표 위로 갭이면 시가).
 *  - 비용: 수수료(진입·청산 각각, 명목가 기준) · 슬리피지(가격에 반영) · 펀딩비(UTC 0·8·16시를 지날 때마다, 가정값). 0으로 숨기지 않고 결과에 따로 적는다.
 *  - 포지션 크기: 거래당 위험 = 자산 × 위험% → 수량 = 위험 ÷ (진입가 − 손절가), 명목가는 자산 × 최대 배율을 넘지 않게.
 *  - 계약 단위·최소 수량 반올림은 아직 하지 않는다(가정 목록에 표시). 롱만.
 */
'use strict';

const BT = (() => {
  const H8 = 8 * 3600e3;
  // 봉 검사: 시간 중복·순서·빈 봉(누락)·비정상 값. 문제가 있는 봉은 빼고 무엇을 뺐는지 돌려준다
  function checkData(cs, tfMs) {
    const issues = { dup: 0, order: 0, bad: 0, gaps: 0, gapBars: 0 }, clean = [];
    const seen = new Set();
    for (const k of cs) {
      if (seen.has(k.t)) { issues.dup++; continue; }
      if (![k.o, k.h, k.l, k.c].every((x) => Number.isFinite(x) && x > 0) || k.h < k.l || k.h < Math.max(k.o, k.c) * 0.999999 || k.l > Math.min(k.o, k.c) * 1.000001 || !(k.v >= 0)) { issues.bad++; continue; }
      seen.add(k.t); clean.push(k);
    }
    const sorted = clean.slice().sort((a, b) => a.t - b.t);
    for (let i = 1; i < clean.length; i++) if (clean[i].t < clean[i - 1].t) issues.order++;
    for (let i = 1; i < sorted.length; i++) { const miss = Math.round((sorted[i].t - sorted[i - 1].t) / tfMs) - 1; if (miss > 0) { issues.gaps++; issues.gapBars += miss; } }
    return { cs: sorted, issues };
  }

  const DEF = { capital: 1000, riskPct: 1, lev: 1, fee: 0.05, slip: 0.05, fund8h: 0.01, stopAtr: 2, rr: 2, split: [60, 20, 20] };

  function run(rawCs, opt) {
    const o = Object.assign({}, DEF, opt || {}), S = STRATS.LIST[o.strat];
    if (!S) throw new Error('전략이 없습니다: ' + o.strat);
    const { cs, issues } = checkData(rawCs, o.tfMs);
    if (cs.length < STRATS.warmup + 30) throw new Error(`봉이 ${cs.length}개라 부족합니다(최소 ${STRATS.warmup + 30}개)`);
    if (S.needsHigher && !(o.hiCs && o.hiCs.length)) throw new Error('이 전략은 상위 봉 데이터가 필요합니다');
    const P = STRATS.prepare(cs, { tfMs: o.tfMs, hiCs: o.hiCs, hiMs: o.hiMs });
    const fee = o.fee / 100, slip = o.slip / 100, f8 = o.fund8h / 100;
    let cash = o.capital, pos = null, pendIn = false, pendOut = '';
    const trades = [], curve = [], costs = { fee: 0, slip: 0, fund: 0 };
    const close = (k, px, why, i) => {
      const exitPx = px * (1 - slip), notional = pos.qty * exitPx, f = notional * fee;
      costs.fee += f; costs.slip += pos.qty * px * slip;
      const gross = pos.qty * (exitPx - pos.entry);
      cash += gross - f;
      const pnl = gross - f - pos.feeIn - pos.fund;
      trades.push({ entryT: pos.entryT, entry: pos.entry, exitT: k.t, exit: exitPx, qty: pos.qty, why, pnl, pct: (pnl / pos.eqAt) * 100, R: pnl / pos.risk, bars: i - pos.i + 1, fee: pos.feeIn + f, fund: pos.fund, stop: pos.stop, target: pos.target, reason: pos.reason });
      pos = null;
    };
    for (let i = STRATS.warmup; i < cs.length; i++) {
      const k = cs[i];
      // 1) 지난 봉 종가에 정해진 청산 → 이번 봉 시가
      if (pos && pendOut) { close(k, k.o, pendOut, i); pendOut = ''; }
      // 2) 지난 봉 종가에 정해진 진입 → 이번 봉 시가(+슬리피지)
      if (!pos && pendIn) {
        pendIn = false;
        const a = P.I.atr[i - 1], entry = k.o * (1 + slip), stop = entry - o.stopAtr * a;
        if (a > 0 && stop > 0 && entry > stop) {
          const eq = cash, risk = eq * (o.riskPct / 100), qty = Math.min(risk / (entry - stop), (eq * o.lev) / entry);
          if (qty > 0) {
            const feeIn = qty * entry * fee; cash -= feeIn; costs.fee += feeIn; costs.slip += qty * k.o * slip;
            pos = { i, entryT: k.t, entry, stop, target: entry + o.rr * (entry - stop), qty, feeIn, fund: 0, risk: qty * (entry - stop), eqAt: eq, reason: S.name };
          }
        }
      }
      // 3) 손절·목표(손절 먼저, 갭은 시가)
      if (pos) {
        if (k.o <= pos.stop) close(k, k.o, '손절(갭)', i);
        else if (k.l <= pos.stop) close(k, pos.stop, '손절', i);
        else if (k.o >= pos.target) close(k, k.o, '목표(갭)', i);
        else if (k.h >= pos.target) close(k, pos.target, '목표', i);
      }
      // 4) 펀딩비: 이 봉 동안 UTC 0·8·16시를 지나면(봉 시작 < 정산 시각 ≤ 봉 끝) 명목가 × 가정 비율
      if (pos && f8) {
        const end = k.t + o.tfMs, n8 = Math.floor(end / H8) - Math.floor(k.t / H8);
        if (n8 > 0) { const f = pos.qty * k.c * f8 * n8; pos.fund += f; cash -= f; costs.fund += f; }
      }
      // 5) 이번 봉 종가로 신호 → 다음 봉에 체결(마지막 봉 신호는 다음 봉이 없어 체결 안 함)
      if (i < cs.length - 1) {
        if (!pos && S.enter(P, i)) pendIn = true;
        else if (pos) { const why = S.exit(P, i); if (why) pendOut = why; }
      }
      curve.push({ t: k.t + o.tfMs, eq: cash + (pos ? pos.qty * (k.c * (1 - slip) - pos.entry) - pos.qty * k.c * (1 - slip) * fee : 0) });
    }
    const open = pos ? { entryT: pos.entryT, entry: pos.entry, stop: pos.stop, target: pos.target, qty: pos.qty, last: cs[cs.length - 1].c, unreal: curve[curve.length - 1].eq - cash } : null;
    return { opt: o, strat: o.strat, version: STRATS.VERSION, name: S.name, desc: S.desc, issues, bars: cs.length, from: cs[STRATS.warmup].t, to: cs[cs.length - 1].t + o.tfMs, trades, curve, open, costs, stats: stats(trades, curve, o, costs, cash), segs: segments(trades, curve, o) };
  }

  // 성과 지표
  function stats(trades, curve, o, costs, cash) {
    const n = trades.length, wins = trades.filter((x) => x.pnl > 0), losses = trades.filter((x) => x.pnl <= 0);
    const sumW = wins.reduce((a, x) => a + x.pnl, 0), sumL = losses.reduce((a, x) => a + x.pnl, 0);
    let peak = o.capital, mdd = 0; for (const p of curve) { peak = Math.max(peak, p.eq); mdd = Math.min(mdd, (p.eq - peak) / peak); }
    const rets = []; for (let i = 1; i < curve.length; i++) rets.push(curve[i].eq / curve[i - 1].eq - 1);
    const mean = rets.length ? rets.reduce((a, x) => a + x, 0) / rets.length : 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1)) : 0;
    const dsd = rets.length > 1 ? Math.sqrt(rets.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / (rets.length - 1)) : 0;
    const perYear = (365 * 86400e3) / o.tfMs; // 무기한 선물은 24시간·365일 거래
    let streak = 0, maxStreak = 0; for (const t of trades) { if (t.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
    const final = curve.length ? curve[curve.length - 1].eq : o.capital;
    return {
      capital: o.capital, final, realized: cash - o.capital, unrealized: final - cash,
      netPct: (final / o.capital - 1) * 100, grossPct: ((final + costs.fee + costs.fund) / o.capital - 1) * 100,
      n, winRate: n ? (wins.length / n) * 100 : null, avgWin: wins.length ? sumW / wins.length : null, avgLoss: losses.length ? sumL / losses.length : null,
      payoff: wins.length && losses.length && sumL ? (sumW / wins.length) / Math.abs(sumL / losses.length) : null,
      pf: sumL ? sumW / Math.abs(sumL) : sumW > 0 ? Infinity : null, mdd: mdd * 100,
      sharpe: sd ? (mean / sd) * Math.sqrt(perYear) : null, sortino: dsd ? (mean / dsd) * Math.sqrt(perYear) : null,
      avgBars: n ? trades.reduce((a, x) => a + x.bars, 0) / n : null, maxLossStreak: maxStreak, avgR: n ? trades.reduce((a, x) => a + x.R, 0) / n : null,
      fee: costs.fee, slip: costs.slip, fund: costs.fund,
    };
  }
  // 시간순 구간 나누기(개발/검증/테스트): 구간마다 수익률·최대 낙폭·진입한 거래 수 — 튜닝에 쓰지 말고 비교만
  function segments(trades, curve, o) {
    if (curve.length < 10) return [];
    const names = ['개발', '검증', '테스트'], tot = o.split.reduce((a, b) => a + b, 0), out = [];
    let start = 0;
    o.split.forEach((w, s) => {
      const end = s === o.split.length - 1 ? curve.length : Math.round(curve.length * (o.split.slice(0, s + 1).reduce((a, b) => a + b, 0) / tot));
      const seg = curve.slice(start, end); if (!seg.length) return;
      const base = start ? curve[start - 1].eq : o.capital;
      let peak = base, mdd = 0; for (const p of seg) { peak = Math.max(peak, p.eq); mdd = Math.min(mdd, (p.eq - peak) / peak); }
      const t0 = start ? curve[start - 1].t : -Infinity, t1 = seg[seg.length - 1].t;
      const tr = trades.filter((x) => x.entryT >= t0 && x.entryT < t1);
      out.push({ name: names[s] || '구간 ' + (s + 1), w, from: seg[0].t, to: t1, ret: (seg[seg.length - 1].eq / base - 1) * 100, mdd: mdd * 100, n: tr.length, win: tr.length ? (tr.filter((x) => x.pnl > 0).length / tr.length) * 100 : null });
      start = end;
    });
    return out;
  }

  /* ── 3단계: 워크포워드 검증 ──
   * 데이터를 시간순으로 [학습 2칸 | 시험 1칸]씩 밀어 가며:
   *  학습 구간에서만 손절(ATR 배수)·목표(R) 조합을 골라(시험 구간은 보지 않음) → 바로 다음 시험 구간에서 처음 보는 데이터로 성과를 잰다.
   *  지표 준비용 앞쪽 봉(warmup)은 그 구간 '이전' 데이터만 쓴다. 시험 구간끼리는 겹치지 않는다.
   * 결과: 구간마다 고른 설정·학습 성과·시험 성과, 시험 구간을 이어 붙인 성과, 같은 구간에서 기본 설정의 성과(비교용), 시험한 조합 수(과최적화 위험).
   */
  const GRID = { stopAtr: [1.5, 2, 3], rr: [1.5, 2, 3] };
  function walkForward(rawCs, opt, wf) {
    wf = Object.assign({ folds: 4, trainMult: 2, minTrades: 3 }, wf || {});
    const o = Object.assign({}, DEF, opt || {});
    const { cs } = checkData(rawCs, o.tfMs);
    const W = STRATS.warmup, usable = cs.length - W, T = Math.floor(usable / (wf.folds + wf.trainMult));
    if (T < 40) throw new Error('워크포워드에는 봉이 더 필요합니다(구간마다 40봉 이상 — 봉 개수를 늘리거나 짧은 봉을 쓰세요)');
    const combos = []; GRID.stopAtr.forEach((a) => GRID.rr.forEach((r) => combos.push({ stopAtr: a, rr: r })));
    const seg = (a, b, extra) => run(cs.slice(a - W, b), Object.assign({}, o, extra || {})); // a..b-1 구간을 거래, 앞 W봉은 지표 준비(과거)
    const folds = [];
    for (let f = 0; f < wf.folds; f++) {
      const tr0 = W + f * T, tr1 = tr0 + wf.trainMult * T, te1 = tr1 + T;
      // 학습: 조합마다 돌려서 순수익률이 가장 높은 것(거래 수 minTrades 이상), 같으면 MDD가 작은 것
      let best = null;
      for (const c of combos) {
        const r = seg(tr0, tr1, c);
        if (r.stats.n < wf.minTrades) continue;
        if (!best || r.stats.netPct > best.r.stats.netPct || (r.stats.netPct === best.r.stats.netPct && r.stats.mdd > best.r.stats.mdd)) best = { c, r };
      }
      const pick = best ? best.c : { stopAtr: o.stopAtr, rr: o.rr };
      const test = seg(tr1, te1, pick), base = seg(tr1, te1, { stopAtr: o.stopAtr, rr: o.rr });
      folds.push({ trainFrom: cs[tr0].t, trainTo: cs[tr1 - 1].t + o.tfMs, testFrom: cs[tr1].t, testTo: cs[te1 - 1].t + o.tfMs, pick, picked: !!best, train: best ? best.r.stats : null, test: test.stats, base: base.stats });
    }
    const chain = (k) => (folds.reduce((a, x) => a * (1 + x[k].netPct / 100), 1) - 1) * 100;
    const sumN = (k) => folds.reduce((a, x) => a + x[k].n, 0);
    const avg = (L) => (L.length ? L.reduce((a, x) => a + x, 0) / L.length : null);
    return {
      folds, T, combos: combos.length, tried: combos.length * wf.folds,
      oos: { netPct: chain('test'), n: sumN('test'), worstMdd: Math.min(...folds.map((x) => x.test.mdd)) },
      baseOos: { netPct: chain('base'), n: sumN('base') },
      avgTrain: avg(folds.filter((x) => x.train).map((x) => x.train.netPct)), avgTest: avg(folds.map((x) => x.test.netPct)),
    };
  }

  /* ── 3단계: 시장 국면별 결과 ──
   * 국면은 진입 신호가 난 봉까지의 데이터로만 정한다(미래 안 봄).
   *  추세: 종가 > EMA50 이고 EMA50이 10봉 전보다 높으면 '상승', 종가 < EMA50 이고 낮으면 '하락', 그 밖은 '횡보'
   *  변동성: 그 봉의 ATR% 가 그때까지 지난 100봉 ATR% 중간값보다 크면 '고변동', 아니면 '저변동'
   */
  function regimes(cs) {
    const I = SCAN.ind(cs), out = [];
    const atrP = cs.map((k, i) => (I.atr[i] ? I.atr[i] / k.c : null));
    for (let i = 0; i < cs.length; i++) {
      const e = I.ema50[i], e10 = I.ema50[i - 10], c = cs[i].c;
      const trend = e == null || e10 == null ? null : c > e && e > e10 ? 'up' : c < e && e < e10 ? 'down' : 'side';
      const past = atrP.slice(Math.max(0, i - 100), i).filter((x) => x != null).sort((a, b) => a - b);
      const vol = atrP[i] == null || past.length < 20 ? null : atrP[i] > past[Math.floor(past.length / 2)] ? 'high' : 'low';
      out.push({ trend, vol });
    }
    return out;
  }
  const RG_KO = { up: '상승', down: '하락', side: '횡보', high: '고변동', low: '저변동', na_t: '추세 판단 못 함', na_v: '변동성 판단 못 함' };
  function byRegime(r, rawCs) {
    const { cs } = checkData(rawCs, r.opt.tfMs), rg = regimes(cs), idx = new Map(cs.map((k, i) => [k.t, i]));
    const buckets = {};
    for (const t of r.trades) {
      const ei = idx.get(t.entryT), si = ei - 1; // 신호 봉 = 진입 봉 바로 앞
      const g = si >= 0 ? rg[si] : null;
      for (const [key, miss] of [[g && g.trend, 'na_t'], [g && g.vol, 'na_v']]) {
        const k = key || miss;
        const b = buckets[k] || (buckets[k] = { key: k, name: RG_KO[k] || '판단 못 함', n: 0, win: 0, pnl: 0, R: 0 });
        b.n++; if (t.pnl > 0) b.win++; b.pnl += t.pnl; b.R += t.R;
      }
    }
    // 데이터 기간 중 각 국면이 차지한 비율(거래가 없어도 보여 주려고)
    const share = {}; let cnt = 0;
    rg.slice(STRATS.warmup).forEach((g) => { if (!g.trend) return; cnt++; share[g.trend] = (share[g.trend] || 0) + 1; if (g.vol) share[g.vol] = (share[g.vol] || 0) + 1; });
    const order = ['up', 'side', 'down', 'na_t', 'high', 'low', 'na_v'];
    return order.filter((k) => buckets[k] || share[k]).map((k) => Object.assign({ key: k, name: RG_KO[k] || '판단 못 함', n: 0, win: 0, pnl: 0, R: 0 }, buckets[k] || {}, { share: cnt ? ((share[k] || 0) / cnt) * 100 : null }));
  }
  return { DEF, run, checkData, stats, walkForward, regimes, byRegime, GRID };
})();
