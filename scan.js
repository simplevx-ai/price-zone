/* 가격 위치 — 📊 ETF 선물 스캐너 계산 (OKX·바이낸스 공개 시세, 자동 주문 없음)
 * 앱과 알림 스크립트가 같은 계산을 쓰도록 화면·네트워크 없이 계산만 한다.
 * 반등 포착과 하락 전환 포착을 따로 점수(0~5)로 매기고, 거래대금·변동성(ATR%)·추세를 함께 본다.
 * 점수는 정해진 조건의 개수일 뿐 매수·매도 추천이 아니다.
 * 봉: 오래된 것부터 [{t, o, h, l, c, v}], 끝난 봉만.
 */
const SCAN = (() => {
  // 다루는 ETF·지수 선물(OKX·바이낸스에 실제로 있는 것). g: 묶음, lev: 배율(음수 = 인버스), pair: 반대 상품
  const META = {
    QQQ: { name: '나스닥100', g: 'nasdaq', lev: 1 }, TQQQ: { name: '나스닥100 3배', g: 'nasdaq', lev: 3, pair: 'SQQQ' }, SQQQ: { name: '나스닥100 인버스 3배', g: 'nasdaq', lev: -3, pair: 'TQQQ' },
    US100: { name: '나스닥100 지수(OKX)', g: 'nasdaq', lev: 1 },
    SPY: { name: 'S&P500', g: 'sp500', lev: 1 }, US500: { name: 'S&P500 지수(OKX)', g: 'sp500', lev: 1 },
    SOXL: { name: '반도체 3배', g: 'semi', lev: 3, pair: 'SOXS' }, SOXS: { name: '반도체 인버스 3배', g: 'semi', lev: -3, pair: 'SOXL' },
    SOXX: { name: '반도체', g: 'semi', lev: 1 }, SMH: { name: '반도체(반에크)', g: 'semi', lev: 1 },
    IWM: { name: '러셀2000(중소형주)', g: 'other', lev: 1, pair: 'TZA' }, TZA: { name: '러셀2000 인버스 3배', g: 'other', lev: -3, pair: 'IWM' },
    KORU: { name: '한국 3배', g: 'other', lev: 3 }, EWY: { name: '한국(MSCI)', g: 'other', lev: 1 }, EWJ: { name: '일본', g: 'other', lev: 1 }, EWT: { name: '대만', g: 'other', lev: 1 },
    UVXY: { name: 'VIX 변동성 1.5배', g: 'other', lev: 1.5 }, TLT: { name: '미국 장기국채', g: 'other', lev: 1 }, TMF: { name: '미국 장기국채 3배', g: 'other', lev: 3 },
    XLE: { name: '에너지', g: 'other', lev: 1 }, XLF: { name: '금융', g: 'other', lev: 1 }, XBI: { name: '바이오', g: 'other', lev: 1 }, IGV: { name: '소프트웨어', g: 'other', lev: 1 },
    GDX: { name: '금광', g: 'other', lev: 1 }, KWEB: { name: '중국 인터넷', g: 'other', lev: 1 }, EWZ: { name: '브라질', g: 'other', lev: 1 }, URNM: { name: '우라늄', g: 'other', lev: 1 }, IBIT: { name: '비트코인 현물 ETF', g: 'other', lev: 1 },
  };
  const GROUPS = { nasdaq: '나스닥100', sp500: 'S&P500', semi: '반도체', other: '기타 ETF' };
  const CORE = ['QQQ', 'TQQQ', 'SQQQ', 'US100', 'SPY', 'US500', 'SOXL', 'SOXS', 'SOXX', 'SMH'];

  const ema = (a, n) => { const k = 2 / (n + 1), out = []; let e = null; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out.push(i < n - 1 ? null : e); } return out; };
  function rsi(c, n) {
    n = n || 14; const out = c.map(() => null); if (c.length <= n) return out;
    let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n; out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    return out;
  }
  function wilder(a, n) { const out = a.map(() => null); if (a.length <= n) return out; let s = a.slice(1, n + 1).reduce((x, y) => x + y, 0); out[n] = s; for (let i = n + 1; i < a.length; i++) { s = s - s / n + a[i]; out[i] = s; } return out; }
  function ind(cs) {
    const c = cs.map((k) => k.c), n = c.length;
    const e12 = ema(c, 12), e26 = ema(c, 26), macd = c.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
    const st = macd.findIndex((x) => x != null), sp = st < 0 ? [] : ema(macd.slice(st), 9), sig = macd.map((_, i) => (st >= 0 && i >= st ? sp[i - st] : null));
    const hist = macd.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null));
    const tr = cs.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1].c), Math.abs(k.l - cs[i - 1].c)) : k.h - k.l));
    const atr = cs.map(() => null); if (n > 14) { let a = tr.slice(1, 15).reduce((x, y) => x + y, 0) / 14; atr[14] = a; for (let i = 15; i < n; i++) { a = (a * 13 + tr[i]) / 14; atr[i] = a; } }
    // ADX(14)
    const pdm = cs.map((k, i) => { if (!i) return 0; const up = k.h - cs[i - 1].h, dn = cs[i - 1].l - k.l; return up > dn && up > 0 ? up : 0; });
    const mdm = cs.map((k, i) => { if (!i) return 0; const up = k.h - cs[i - 1].h, dn = cs[i - 1].l - k.l; return dn > up && dn > 0 ? dn : 0; });
    const trS = wilder(tr, 14), pS = wilder(pdm, 14), mS = wilder(mdm, 14);
    const dx = c.map((_, i) => { if (trS[i] == null || !trS[i]) return null; const p = (100 * pS[i]) / trS[i], m = (100 * mS[i]) / trS[i]; return p + m ? (100 * Math.abs(p - m)) / (p + m) : 0; });
    const adx = c.map(() => null); const d0 = dx.findIndex((x) => x != null);
    if (d0 >= 0 && d0 + 14 <= n) { let a = dx.slice(d0, d0 + 14).reduce((x, y) => x + y, 0) / 14; adx[d0 + 13] = a; for (let i = d0 + 14; i < n; i++) { a = (a * 13 + dx[i]) / 14; adx[i] = a; } }
    return { c, ema5: ema(c, 5), ema20: ema(c, 20), ema50: ema(c, 50), ema200: ema(c, 200), rsi: rsi(c), macd, sig, hist, atr, adx, pdi: c.map((_, i) => (trS[i] ? (100 * pS[i]) / trS[i] : null)), mdi: c.map((_, i) => (trS[i] ? (100 * mS[i]) / trS[i] : null)) };
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  // 한 종목·한 봉 단위 분석. dayStart: VWAP 기준 시작 시각(ms, 그날 0시 UTC). 끝난 봉 기준
  function analyze(cs, opt) {
    opt = opt || {};
    const n = cs.length; if (n < 40) return { error: '봉이 40개보다 적음' };
    const I = ind(cs), i = n - 1, k = cs[i], p = k.c;
    const volAvg = avg(cs.slice(Math.max(0, i - 20), i).map((x) => x.v)), volRatio = volAvg ? k.v / volAvg : null;
    const rsiMin10 = Math.min(...I.rsi.slice(i - 10, i + 1).filter((x) => x != null)), rsiMax10 = Math.max(...I.rsi.slice(i - 10, i + 1).filter((x) => x != null));
    const lowRecent = Math.min(...cs.slice(i - 2, i + 1).map((x) => x.l)), lowPrev = Math.min(...cs.slice(i - 15, i - 2).map((x) => x.l));
    const highRecent = Math.max(...cs.slice(i - 2, i + 1).map((x) => x.h)), highPrev = Math.max(...cs.slice(i - 15, i - 2).map((x) => x.h));
    const h0 = I.hist[i], h1 = I.hist[i - 1], h2 = I.hist[i - 2];
    const up = [
      { key: 'rsi', name: 'RSI가 최근 40 이하까지 내려갔다가 다시 오름', ok: rsiMin10 <= 40 && I.rsi[i] > I.rsi[i - 3] },
      { key: 'macd', name: h0 > 0 && h1 <= 0 ? 'MACD 히스토그램 음→양 전환' : 'MACD 히스토그램 2봉 연속 좋아짐', ok: h0 != null && h1 != null && h2 != null && ((h0 > 0 && h1 <= 0) || (h0 > h1 && h1 > h2)) },
      { key: 'ema5', name: '종가가 5봉 지수평균 위로 회복', ok: I.ema5[i] != null && p > I.ema5[i] },
      { key: 'vol', name: '거래량 늘며 양봉(평균의 1.3배 이상)', ok: volRatio != null && volRatio >= 1.3 && k.c > k.o },
      { key: 'low', name: '직전 저점을 지킴(최근 3봉 저점이 그 전 저점보다 높음)', ok: lowRecent > lowPrev },
    ];
    const dn = [
      { key: 'rsi', name: 'RSI가 최근 60 이상까지 올랐다가 다시 내림', ok: rsiMax10 >= 60 && I.rsi[i] < I.rsi[i - 3] },
      { key: 'macd', name: h0 < 0 && h1 >= 0 ? 'MACD 히스토그램 양→음 전환' : 'MACD 히스토그램 2봉 연속 나빠짐', ok: h0 != null && h1 != null && h2 != null && ((h0 < 0 && h1 >= 0) || (h0 < h1 && h1 < h2)) },
      { key: 'ema5', name: '종가가 5봉 지수평균 아래로 내려감', ok: I.ema5[i] != null && p < I.ema5[i] },
      { key: 'vol', name: '거래량 늘며 음봉(평균의 1.3배 이상)', ok: volRatio != null && volRatio >= 1.3 && k.c < k.o },
      { key: 'high', name: '고점이 낮아짐(최근 3봉 고점이 그 전 고점보다 낮음)', ok: highRecent < highPrev },
    ];
    const trendUp = I.ema20[i] != null && I.ema50[i] != null && p > I.ema20[i] && I.ema20[i] > I.ema50[i];
    const trendDn = I.ema20[i] != null && I.ema50[i] != null && p < I.ema20[i] && I.ema20[i] < I.ema50[i];
    const trend = trendUp ? 'up' : trendDn ? 'down' : 'side';
    // VWAP: 그날(UTC 0시)부터의 거래량 가중 평균. 일봉이면 최근 20봉
    let vw = null;
    { const from = opt.dayStart != null ? cs.findIndex((x) => x.t >= opt.dayStart) : -1, seg = from >= 0 && opt.daily !== true ? cs.slice(from) : cs.slice(-20);
      const pv = seg.reduce((s, x) => s + ((x.h + x.l + x.c) / 3) * x.v, 0), vv = seg.reduce((s, x) => s + x.v, 0); vw = vv ? pv / vv : null; }
    const atrPct = I.atr[i] ? (I.atr[i] / p) * 100 : null, atrPct20 = I.atr[i - 20] ? (I.atr[i - 20] / cs[i - 20].c) * 100 : null;
    const score = (L) => L.filter((x) => x.ok).length;
    return {
      t: k.t, price: p, open: k.o, rsi: I.rsi[i], macd: I.macd[i], sig: I.sig[i], hist: h0, adx: I.adx[i], pdi: I.pdi[i], mdi: I.mdi[i],
      ema5: I.ema5[i], ema20: I.ema20[i], ema50: I.ema50[i], ema200: I.ema200[i], atr: I.atr[i], atrPct, atrJump: atrPct && atrPct20 ? atrPct / atrPct20 : null,
      vwap: vw, vwapGap: vw ? ((p / vw) - 1) * 100 : null, volRatio, trend, up, dn, upScore: score(up), dnScore: score(dn), bars: n,
      chg: (m) => (n > m ? ((p / cs[n - 1 - m].c) - 1) * 100 : null),
    };
  }
  // 변동성 등급(일봉 ATR%)
  const volClass = (x) => (x == null ? '-' : x >= 10 ? '초고변동' : x >= 5 ? '고변동' : x >= 2 ? '중간' : '낮음');
  const strength = (s) => (s >= 4 ? '강' : s === 3 ? '보통' : s === 2 ? '약' : '없음');
  // 일봉 추세 한 줄(장기 기준선 포함)
  function dayTrend(a) {
    if (!a || a.error) return '-';
    const parts = [a.trend === 'up' ? '상승 추세(종가>EMA20>EMA50)' : a.trend === 'down' ? '하락 추세(종가<EMA20<EMA50)' : '횡보·전환 구간'];
    if (a.ema200 != null) parts.push(a.price > a.ema200 ? '200일선 위' : '200일선 아래');
    if (a.adx != null) parts.push('ADX ' + a.adx.toFixed(0) + (a.adx >= 25 ? '(추세 강함)' : '(추세 약함)'));
    return parts.join(' · ');
  }
  // OKX 봉([ts,o,h,l,c,vol,…,confirm], 최신 먼저) / 바이낸스 봉([openTime,o,h,l,c,v,closeTime,…], 오래된 것부터) → 공통 모양(끝난 봉만)
  const fromOkx = (rows) => (rows || []).filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  const fromBinance = (rows, now) => (rows || []).filter((k) => +k[6] < (now || Date.now())).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  return { META, GROUPS, CORE, analyze, volClass, strength, dayTrend, fromOkx, fromBinance };
})();
