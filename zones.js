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
