/* 가격 위치 — 매수 검토 구간 계산(공부용)
   여러 근거(지지선·매물대·이동평균·볼린저·피보나치·RSI 과매도·ATR)가 겹치는 가격대를 찾아 점수를 매긴다.
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
  };

  function analyze(cs) {
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

    // 현재가 아래(+1% 위까지) 근거만 → ATR 0.6배 안의 근거끼리 묶어 구간을 만든다
    const below = cand.filter((x) => x.p <= price * 1.01).sort((a, b) => b.p - a.p);
    const zones = [];
    for (const x of below) {
      const z = zones.find((q) => x.p >= q.min - A * 0.6 && x.p <= q.max + A * 0.6);
      if (z) { z.items.push(x); z.min = Math.min(z.min, x.p); z.max = Math.max(z.max, x.p); } else zones.push({ min: x.p, max: x.p, items: [x] });
    }
    const out = zones.map((z) => {
      const kinds = new Set(z.items.map((x) => (x.key.startsWith('fib') ? 'fib' : x.key.startsWith('ma') ? 'ma' : x.key)));
      const touchBonus = Math.min(1, z.items.filter((x) => x.key === 'swing').reduce((s, x) => s + Math.max(0, x.touches - 1), 0) * 0.5);
      const score = kinds.size + touchBonus;
      const low = z.min - A * 0.25, high = Math.min(z.max + A * 0.25, price * 1.01);
      return { low, high, mid: (low + high) / 2, score: Math.round(score * 10) / 10, kinds: kinds.size, items: z.items.sort((a, b) => b.p - a.p), distPct: ((z.max - price) / price) * 100 };
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
  return { analyze, rsiSeries, atr, swingLows, volumeProfile, LABEL, WHY };
})();
