// 백테스트 엔진·전략 단위 시험 — 실행: node tests/backtest.test.mjs (네트워크 없음)
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const ctx = vm.createContext({ console, Math, Number, Array, Object, Set, Map, JSON, Infinity, NaN, isFinite });
for (const f of ['scan.js', 'strategies.js', 'backtest.js']) vm.runInContext(fs.readFileSync(new URL(f, root), 'utf8').replace(/^const (SCAN|STRATS|BT) =/m, 'globalThis.$1 ='), ctx, { filename: f });
const { SCAN, STRATS, BT } = ctx;
let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, info !== undefined ? JSON.stringify(info) : ''); } };
const H = 3600e3, T0 = Date.UTC(2026, 0, 1);
// 결정적 가짜 봉(오르락내리락)
function series(n, tf = H, seed = 3) {
  let s = seed, p = 100; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => { const o = p; p = p * (1 + (rnd() - 0.5) * 0.03 + Math.sin(i / 15) * 0.004); const h = Math.max(o, p) * (1 + rnd() * 0.006), l = Math.min(o, p) * (1 - rnd() * 0.006); return { t: T0 + i * tf, o, h, l, c: p, v: 1000 + rnd() * 2000 }; });
}
const base = { tfMs: H, capital: 1000, riskPct: 1, lev: 1, fee: 0.05, slip: 0.05, fund8h: 0.01, stopAtr: 2, rr: 2 };

// 1) 미래 봉을 보지 않음: 앞부분만 넣은 결과와, 전체를 넣은 결과에서 그 시점 전에 끝난 거래가 같아야 함
for (const k of ['A', 'B', 'C', 'D', 'E']) {
  const cs = series(700), cut = 500;
  const full = BT.run(cs, { ...base, strat: k }), part = BT.run(cs.slice(0, cut), { ...base, strat: k });
  const endT = cs[cut - 1].t; // part의 마지막 봉 시작
  const a = full.trades.filter((x) => x.exitT < endT).map((x) => [x.entryT, x.exitT, x.why, +x.pnl.toFixed(8)]);
  const b = part.trades.filter((x) => x.exitT < endT).map((x) => [x.entryT, x.exitT, x.why, +x.pnl.toFixed(8)]);
  ok(`미래 봉 차단 — 전략 ${k} (거래 ${a.length}개 같음)`, JSON.stringify(a) === JSON.stringify(b), { a: a.length, b: b.length });
}
// 2) 진입은 신호 다음 봉 시가 + 슬리피지
{ const cs = series(700), r = BT.run(cs, { ...base, strat: 'B' }), byT = new Map(cs.map((k) => [k.t, k]));
  ok('진입 = 다음 봉 시가 × (1 + 슬리피지)', r.trades.length > 0 && r.trades.every((x) => Math.abs(x.entry - byT.get(x.entryT).o * 1.0005) < 1e-9), r.trades.length); }
// 3) 시험용 전략: 정해진 봉에서만 진입, 청산 신호 없음 → 손절·목표·갭 규칙만 시험
STRATS.LIST.T = { name: 'T', desc: 'test', enter: (P, i) => i === 100, exit: () => '' };
function flat(n) { return Array.from({ length: n }, (_, i) => ({ t: T0 + i * H, o: 100, h: 101, l: 99, c: 100, v: 1000 })); }
{ // 갭으로 손절가 아래에서 시작 → 시가 체결
  const cs = flat(200); const atr = 2; // 평평한 봉 ATR ≈ 2
  cs[102] = { ...cs[102], o: 90, h: 91, l: 89, c: 90 };
  const r = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0, fund8h: 0 }), t = r.trades[0];
  ok('갭 손절은 손절가가 아니라 시가에 체결', t && t.why === '손절(갭)' && Math.abs(t.exit - 90) < 1e-9, t);
}
{ // 한 봉에서 손절·목표 둘 다 닿음 → 손절(보수적)
  const cs = flat(200); cs[102] = { ...cs[102], o: 100, h: 120, l: 80, c: 100 };
  const r = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0, fund8h: 0 }), t = r.trades[0];
  ok('같은 봉에 손절·목표 → 손절로 봄', t && t.why === '손절' && Math.abs(t.exit - t.stop) < 1e-9, t);
}
{ // 목표 도달
  const cs = flat(200); cs[103] = { ...cs[103], o: 100, h: 115, l: 99.5, c: 112 };
  const r = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0, fund8h: 0 }), t = r.trades[0];
  ok('목표 도달은 목표가에 체결', t && t.why === '목표' && Math.abs(t.exit - t.target) < 1e-9, t);
}
// 4) 비용 계산: 수수료·슬리피지·펀딩
{ const cs = flat(200); cs[110] = { ...cs[110], o: 100, h: 130, l: 99.5, c: 112 }; // 진입(101봉 시가) 후 9봉 뒤 목표
  const r = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0.1, fund8h: 0.01 }), t = r.trades[0];
  const feeExp = t.qty * t.entry * 0.001 + t.qty * t.exit * 0.001;
  ok('수수료 = 진입·청산 명목가 × 수수료율', Math.abs(t.fee - feeExp) < 1e-9, { fee: t.fee, feeExp });
  // 101봉(진입)~110봉(청산) 사이 펀딩: 각 봉이 UTC 0·8·16시를 지나는 횟수(진입 봉 포함, 청산 봉은 청산 뒤라 제외)
  let n8 = 0; for (let i = 101; i < 110; i++) { const st = cs[i].t, en = st + H; n8 += Math.floor(en / (8 * H)) - Math.floor(st / (8 * H)); }
  ok(`펀딩 = 명목가 × 비율 × 정산 횟수(${n8}번)`, Math.abs(t.fund - t.qty * 100 * 0.0001 * n8) < 1e-9, { fund: t.fund, n8 });
  ok('최종 자산 = 처음 자산 + 거래 손익 합(열린 포지션 없을 때)', !r.open && Math.abs(r.stats.final - (1000 + r.trades.reduce((a, x) => a + x.pnl, 0))) < 1e-6, { final: r.stats.final });
}
{ const cs = flat(200); const r0 = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0, fund8h: 0 }), r1 = BT.run(cs, { ...base, strat: 'T', slip: 0.1, fee: 0, fund8h: 0 });
  ok('슬리피지가 있으면 진입가가 비싸짐(0.1% 만큼)', !!(r1.open && r0.open) && Math.abs(r1.open.entry - r0.open.entry * 1.001) < 1e-9, { r0: r0.open && r0.open.entry, r1: r1.open && r1.open.entry }); }
// 5) 위험 크기: 손절에 닿으면 자산의 위험%만큼(수수료 0일 때)
{ const cs = flat(200); cs[105] = { ...cs[105], o: 100, h: 100.5, l: 50, c: 60 };
  const r = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0, fund8h: 0, riskPct: 2, lev: 100 }), t = r.trades[0];
  ok('손절 시 손실 = 자산의 위험%', t && Math.abs(t.pnl + 1000 * 0.02) < 1e-6, t && t.pnl); }
{ const cs = flat(200); const r = BT.run(cs, { ...base, strat: 'T', slip: 0, fee: 0, fund8h: 0, riskPct: 50, lev: 1 });
  ok('명목가는 자산 × 최대 배율을 넘지 않음', r.open && r.open.qty * r.open.entry <= 1000 + 1e-9, r.open); }
// 6) 데이터 검사
{ const cs = flat(50); const bad = cs.slice(); bad.splice(10, 3); bad.push({ ...cs[5] }); bad.push({ t: T0 + 60 * H, o: 100, h: 90, l: 99, c: 100, v: 1 });
  const d = BT.checkData(bad, H);
  ok('데이터 검사: 중복·누락·비정상 봉을 찾음', d.issues.dup === 1 && d.issues.bad === 1 && d.issues.gaps >= 1 && d.issues.gapBars >= 3, d.issues); }
// 7) 상위 봉은 끝난 뒤에만 — 실제 함수(STRATS.higherTrend)로 확인
{ const hi = series(90, 4 * H, 11), lo = series(360, H, 5); const out = STRATS.higherTrend(lo, H, hi, 4 * H), Hh = SCAN.ind(hi);
  let bad = 0, checked = 0;
  lo.forEach((k, i) => { const j = Math.floor((i + 1) / 4) - 1; // 1시간봉 i가 끝난 시각에 이미 끝난 마지막 4시간봉
    const exp = j < 0 || Hh.ema20[j] == null || Hh.ema50[j] == null ? null : hi[j].c > Hh.ema20[j] && Hh.ema20[j] > Hh.ema50[j];
    if (out[i] !== exp) bad++; else if (exp !== null) checked++; });
  ok('상위 봉은 그 봉이 끝난 뒤부터 참조(' + checked + '개 봉 확인)', bad === 0 && checked > 100, { bad, checked }); }
// 8) 전략 F: 상위 봉 데이터가 없으면 거절
{ let msg = ''; try { BT.run(series(300), { ...base, strat: 'F' }); } catch (e) { msg = e.message; } ok('전략 F는 상위 봉 없으면 실행 안 함', /상위 봉/.test(msg), msg); }
// 9) 성과 지표 값이 숫자로 나옴
{ const r = BT.run(series(900), { ...base, strat: 'C' }), s = r.stats;
  ok('성과 지표(수익률·MDD·PF·Sharpe·Sortino·연속 손실) 계산', [s.netPct, s.mdd, s.winRate, s.maxLossStreak].every(Number.isFinite) && (s.sharpe === null || Number.isFinite(s.sharpe)) && r.segs.length === 3, { n: s.n, net: s.netPct, mdd: s.mdd, pf: s.pf, sh: s.sharpe, segs: r.segs.map((x) => x.name) }); }
// ── 3단계 ──
// 10) 워크포워드: 시험 구간은 학습 구간 뒤, 서로 겹치지 않음
{ const cs = series(1200), w = BT.walkForward(cs, { ...base, strat: 'C' });
  const order = w.folds.every((f, i) => f.trainTo <= f.testFrom && (i === 0 || w.folds[i - 1].testTo <= f.testFrom));
  ok(`워크포워드 구간 순서·겹침 없음(${w.folds.length}구간, 조합 ${w.combos}개 × ${w.folds.length} = ${w.tried}번 시험)`, order && w.folds.length === 4 && w.tried === 36, w.folds.map((f) => [f.trainFrom, f.trainTo, f.testFrom, f.testTo])); }
// 11) 워크포워드: 학습 때 고른 설정은 시험 구간 데이터를 바꿔도 그대로(학습이 시험 구간을 보지 않음)
{ const cs = series(1200), w1 = BT.walkForward(cs, { ...base, strat: 'C' });
  const f0 = w1.folds[0], cs2 = cs.map((k) => (k.t >= f0.testFrom ? { ...k, o: k.o * 1.3, h: k.h * 1.3, l: k.l * 1.3, c: k.c * 1.3 } : k));
  const w2 = BT.walkForward(cs2, { ...base, strat: 'C' });
  ok('워크포워드 학습은 시험 구간을 보지 않음', JSON.stringify(w1.folds[0].pick) === JSON.stringify(w2.folds[0].pick) && w1.folds[0].train && w2.folds[0].train && Math.abs(w1.folds[0].train.netPct - w2.folds[0].train.netPct) < 1e-9, { a: w1.folds[0].pick, b: w2.folds[0].pick }); }
// 12) 워크포워드: 시험 구간 성과를 이어 붙인 값
{ const w = BT.walkForward(series(1200), { ...base, strat: 'B' });
  const chain = (w.folds.reduce((a, f) => a * (1 + f.test.netPct / 100), 1) - 1) * 100;
  ok('워크포워드 시험 구간 이어 붙인 수익률', Math.abs(chain - w.oos.netPct) < 1e-9 && w.oos.n === w.folds.reduce((a, f) => a + f.test.n, 0), { oos: w.oos }); }
// 13) 봉이 부족하면 거절
{ let msg = ''; try { BT.walkForward(series(250), { ...base, strat: 'B' }); } catch (e) { msg = e.message; } ok('워크포워드: 봉이 모자라면 거절', /봉이 더 필요/.test(msg), msg); }
// 14) 시장 국면은 그 봉까지의 데이터로만(앞부분만 넣어도 같음)
{ const cs = series(600), a = BT.regimes(cs), b = BT.regimes(cs.slice(0, 400));
  ok('시장 국면은 미래 봉을 보지 않음', JSON.stringify(a.slice(0, 400)) === JSON.stringify(b), null); }
// 15) 국면별 거래 수 합 = 전체 거래 수(추세 기준)
{ const cs = series(900), r = BT.run(cs, { ...base, strat: 'C' }), g = BT.byRegime(r, cs);
  const sum = (keys) => g.filter((x) => keys.includes(x.key)).reduce((a, x) => a + x.n, 0);
  const nT = sum(['up', 'side', 'down', 'na_t']), nV = sum(['high', 'low', 'na_v']);
  ok(`국면별 거래 수 합 = 전체(${r.trades.length}) — 추세 ${nT}·변동성 ${nV}`, nT === r.trades.length && nV === r.trades.length, { nT, nV, all: r.trades.length, g: g.map((x) => x.key + ':' + x.n) }); }
console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
