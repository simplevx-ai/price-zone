/* AI 마켓 스캐너 — 🧪 백테스트 화면 (거래소 공개 봉으로 과거 가상 체결 · 실제 주문 없음)
 * 데이터: OKX(최근 300봉 + 과거 페이지) 또는 바이낸스(한 번에 최대 1500봉) 무기한 선물. 끝난 봉만.
 * 거래소 무기한 선물 가격이며 미국 상장 ETF 실제 가격이 아니다(24시간 거래, 펀딩비 있음). 둘을 섞지 않는다.
 * 상품 정보(계약 크기·최소 수량·호가 단위)를 거래소에서 확인하고, 확인이 안 되는 상품은 실행하지 않는다.
 */
'use strict';

const BT_PRODUCTS = [
  { id: 'QQQ', name: 'QQQ 나스닥100' }, { id: 'TQQQ', name: 'TQQQ 나스닥100 3배' }, { id: 'SQQQ', name: 'SQQQ 나스닥100 인버스 3배' },
  { id: 'SOXL', name: 'SOXL 반도체 3배' }, { id: 'NVDA', name: 'NVDA 엔비디아' }, { id: 'SKHYNIX', name: 'SKHYNIX SK하이닉스' }, { id: 'SNDK', name: 'SNDK 샌디스크' },
  { id: 'BTC', name: 'BTC 비트코인' }, { id: 'ETH', name: 'ETH 이더리움' }, { id: 'SOL', name: 'SOL 솔라나' },
];
const BT_TF = {
  '15m': { label: '15분봉', ms: 15 * 60e3, okx: '15m', bn: '15m', hi: '1H' }, '30m': { label: '30분봉', ms: 30 * 60e3, okx: '30m', bn: '30m', hi: '4H' },
  '1H': { label: '1시간봉', ms: 3600e3, okx: '1H', bn: '1h', hi: '4H' }, '4H': { label: '4시간봉', ms: 4 * 3600e3, okx: '4H', bn: '4h', hi: '1D' },
  '1D': { label: '일봉', ms: 86400e3, okx: '1Dutc', bn: '1d', hi: null },
};
const BT_EX = { okx: 'OKX', bn: '바이낸스' };

// 상품 정보(거래소에서 직접) — 없으면 null
async function btMeta(ex, base) {
  const key = `btmeta:${ex}:${base}`, hit = await KV.get(key, null);
  if (hit && Date.now() - hit.at < 86400e3) return hit.data;
  let data = null;
  if (ex === 'okx') {
    const r = (await okxGet(`/public/instruments?instType=SWAP&instId=${encodeURIComponent(base)}-USDT-SWAP`))[0];
    if (r && r.state === 'live') data = { sym: r.instId, kind: r.instCategory === '3' ? '주식·ETF 무기한 선물(OKX 분류 3)' : '코인 무기한 선물', ctVal: r.ctVal + ' ' + r.ctValCcy, ctMult: r.ctMult, lotSz: r.lotSz, minSz: r.minSz, tickSz: r.tickSz, ctType: r.ctType, settle: r.settleCcy, listed: +r.listTime || null };
  } else {
    let ei = await KV.get('btBnInfo', null);
    if (!ei || Date.now() - ei.at > 86400e3) { ei = { at: Date.now(), data: (await binance('/exchangeInfo')).symbols.map((s) => ({ symbol: s.symbol, status: s.status, contractType: s.contractType, underlyingType: s.underlyingType, quoteAsset: s.quoteAsset, onboardDate: s.onboardDate, filters: s.filters })) }; KV.set('btBnInfo', ei).catch(() => {}); }
    const s = ei.data.find((x) => x.symbol === base + 'USDT');
    if (s && s.status === 'TRADING') { const F = (t) => s.filters.find((x) => x.filterType === t) || {}; data = { sym: s.symbol, kind: `${s.contractType}/${s.underlyingType}`, lotSz: F('LOT_SIZE').stepSize, minSz: F('LOT_SIZE').minQty, tickSz: F('PRICE_FILTER').tickSize, minNotional: F('MIN_NOTIONAL').notional, settle: s.quoteAsset, listed: s.onboardDate || null }; }
  }
  KV.set(key, { at: Date.now(), data }).catch(() => {});
  return data;
}
// 봉 받기(끝난 봉만, 오래된 것부터)
async function btCandles(ex, base, tf, want, onProg) {
  const f = BT_TF[tf];
  if (ex === 'bn') {
    const r = await binance(`/klines?symbol=${encodeURIComponent(base)}USDT&interval=${f.bn}&limit=${Math.min(1500, want)}`);
    return r.filter((k) => +k[6] < Date.now()).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }
  const id = `${base}-USDT-SWAP`;
  let rows = await okxGet(`/market/candles?instId=${id}&bar=${f.okx}&limit=300`);
  let after = rows.length ? rows[rows.length - 1][0] : '';
  while (rows.length < want && after) {
    await sleep(150);
    const r = await okxGet(`/market/history-candles?instId=${id}&bar=${f.okx}&limit=100&after=${after}`);
    if (!r.length) break;
    rows = rows.concat(r); after = r[r.length - 1][0];
    if (onProg) onProg(rows.length);
  }
  return rows.filter((k) => k[8] === undefined || k[8] === '1').map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse().slice(-want);
}

const btPct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '-' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
const btNum = (x, d = 2) => (x == null ? '-' : x === Infinity ? '∞' : Number.isFinite(x) ? x.toFixed(d) : '-');
const btT = (t) => new Date(t).toLocaleString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function viewBacktest() {
  setTitle('🧪 백테스트');
  const P = Object.assign({ ex: 'okx', base: 'QQQ', tf: '1H', bars: 1000, strat: 'B', capital: 1000, riskPct: 1, lev: 1, fee: 0.05, slip: 0.05, fund8h: 0.01, stopAtr: 2, rr: 2 }, await KV.get('btPrefs', {}));
  const runs = await KV.get('bt:runs', []);
  const opt = (v, t, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${t}</option>`;
  const num = (id, label, v, step, hint) => `<div><label for="${id}">${label}</label><input id="${id}" type="number" inputmode="decimal" step="${step}" value="${v}"><div class="muted" style="font-size:11px">${hint}</div></div>`;
  view().innerHTML = `<div class="card" style="margin-top:0;border:2px solid #7A4CD1;background:rgba(122,76,209,.08)"><b>🧪 백테스트 · 과거 데이터로 가상 체결 · 실제 주문 없음</b>
      <div class="muted" style="font-size:12px;margin-top:4px">과거 성과는 미래 수익을 보장하지 않습니다. 전략 A~F는 검증해 보는 예시일 뿐 수익이 입증된 규칙이 아닙니다(공부용).</div></div>
    <div class="card"><h2>설정</h2>
      <div class="grid2">
        <div><label for="bx">거래소</label><select id="bx">${Object.entries(BT_EX).map(([k, v]) => opt(k, v, P.ex)).join('')}</select></div>
        <div><label for="bb">상품(무기한 선물)</label><select id="bb">${BT_PRODUCTS.map((p) => opt(p.id, p.name, P.base)).join('')}${BT_PRODUCTS.some((p) => p.id === P.base) ? '' : opt(P.base, P.base, P.base)}</select></div>
        <div><label for="btf">봉</label><select id="btf">${Object.entries(BT_TF).map(([k, v]) => opt(k, v.label, P.tf)).join('')}</select></div>
        <div><label for="bn">봉 개수(기간)</label><select id="bn">${[300, 500, 1000, 1500].map((n) => opt(n, n + '개', P.bars)).join('')}</select></div>
      </div>
      <label for="bs">전략</label><select id="bs">${Object.entries(STRATS.LIST).filter(([k]) => /^[A-F]$/.test(k)).map(([k, v]) => opt(k, v.name, P.strat)).join('')}</select>
      <div class="muted" id="bsd" style="font-size:12px;margin-top:4px"></div>
      <details style="margin-top:8px"><summary><b>비용·위험 설정</b> <span class="muted" style="font-size:12px">(가정값 — 결과에 함께 표시)</span></summary><div class="grid2">
        ${num('bcap', '초기 자본(USDT)', P.capital, 100, '가상 자금')}
        ${num('brisk', '거래당 위험(자산의 %)', P.riskPct, 0.5, '손절에 닿으면 잃는 비율')}
        ${num('blev', '최대 배율', P.lev, 1, '명목가 ≤ 자산 × 배율')}
        ${num('bfee', '수수료(한쪽, %)', P.fee, 0.01, 'OKX 테이커 약 0.05%')}
        ${num('bslip', '슬리피지(한쪽, %)', P.slip, 0.01, '체결가가 불리하게 밀리는 정도')}
        ${num('bfund', '펀딩비(8시간마다, %)', P.fund8h, 0.005, '롱이 내는 가정값. 실제는 매번 달라짐')}
        ${num('bstop', '손절(ATR 배수)', P.stopAtr, 0.5, '진입가 − ATR × 배수')}
        ${num('brr', '목표(손익비 R)', P.rr, 0.5, '진입가 + 위험 × R')}</div></details>
      <div class="row wrap" style="gap:6px;margin-top:10px"><button class="btn primary" id="brun" type="button">▶ 백테스트 실행</button><button class="btn" id="ball" type="button">전략 A~F 전부 비교</button></div>
      <div id="bmsg" class="muted" style="font-size:13px;margin-top:6px"></div></div>
    <div id="bout"></div>
    <div class="card"><details><summary><b>체결·비용 규칙</b></summary><ul class="steps" style="font-size:13px;margin-top:6px">
      <li>신호는 봉이 <b>끝난 뒤</b> 종가로 정하고, 진입·신호 청산은 <b>다음 봉 시가</b>에 체결합니다(+슬리피지). 끝나지 않은 봉은 쓰지 않습니다.</li>
      <li>손절·목표는 진입한 봉부터 확인합니다. 한 봉에서 둘 다 닿으면 순서를 알 수 없어 <b>손절로 봅니다</b>(보수적). 시가가 손절가 아래로 갭이면 손절가가 아닌 <b>시가</b>에 체결합니다.</li>
      <li>상위 봉(전략 F)은 그 봉이 끝난 뒤부터만 씁니다. 지표가 생기기 전 앞쪽 60봉은 신호를 내지 않습니다.</li>
      <li>수수료는 진입·청산 명목가에 각각, 펀딩비는 UTC 0·8·16시(한국 9·17·1시)를 지날 때마다 명목가 × 가정 비율. <b>실제 과거 펀딩비가 아닌 가정값</b>입니다.</li>
      <li>아직 하지 않은 것: 계약 수량·호가 단위 반올림, 숏(매도) 진입, 지정가·부분 체결, 실제 과거 펀딩비. 결과는 이 가정에 따라 달라집니다.</li>
      <li>기간은 시간순으로 개발 60% · 검증 20% · 테스트 20%로 나눠 각각 보여 줍니다. 테스트 구간 결과로 설정을 맞추면 과최적화가 됩니다.</li></ul></details></div>
    ${runs.length ? `<div class="card"><h2>지난 실행 <span class="muted">(${runs.length})</span></h2>${runs.slice(0, 10).map((r) => `<div class="logrow">${esc(r.when)} · ${esc(r.label)} · <b class="${r.net > 0 ? 'up' : 'down'}">${btPct(r.net)}</b> · MDD ${btPct(r.mdd)} · ${r.n}번 <span class="muted">(전략 v${esc(r.ver)})</span></div>`).join('')}</div>` : ''}
    <div class="disc">공부용 · 실제 주문 없음 · <a href="#/learn">📘 검토 구간 근거 설명</a> · v${APP_VERSION}</div>`;
  const showDesc = () => { $('#bsd').textContent = STRATS.LIST[$('#bs').value].desc; };
  $('#bs').onchange = showDesc; showDesc();
  const read = () => ({ ex: $('#bx').value, base: $('#bb').value, tf: $('#btf').value, bars: +$('#bn').value, strat: $('#bs').value, capital: +$('#bcap').value, riskPct: +$('#brisk').value, lev: +$('#blev').value, fee: +$('#bfee').value, slip: +$('#bslip').value, fund8h: +$('#bfund').value, stopAtr: +$('#bstop').value, rr: +$('#brr').value });
  const go = async (all) => {
    const p = read(), msg = (t) => { $('#bmsg').innerHTML = t; };
    if (!(p.capital > 0 && p.riskPct > 0 && p.lev > 0 && p.stopAtr > 0 && p.rr > 0 && p.fee >= 0 && p.slip >= 0 && p.fund8h >= 0)) { msg('<span style="color:var(--red)">설정 값을 확인하세요(0보다 커야 하는 값이 있음)</span>'); return; }
    await KV.set('btPrefs', p);
    $('#brun').disabled = $('#ball').disabled = true;
    try {
      msg('상품 정보 확인 중…');
      const meta = await btMeta(p.ex, p.base);
      if (!meta) { msg(`<span style="color:var(--red)">${esc(BT_EX[p.ex])}에 ${esc(p.base)} USDT 무기한 선물이 없거나 거래 중이 아니라 실행하지 않습니다(상품 정보를 확인할 수 없는 상품은 제외).</span>`); return; }
      msg(`${esc(BT_EX[p.ex])} ${esc(p.base)} ${BT_TF[p.tf].label} 받는 중…`);
      const fetched = new Date();
      const cs = await btCandles(p.ex, p.base, p.tf, p.bars, (k) => msg(`봉 받는 중… ${k}개`));
      const hiTf = BT_TF[p.tf].hi;
      let hiCs = null;
      const keys = all ? ['A', 'B', 'C', 'D', 'E', 'F'] : [p.strat];
      if (keys.includes('F') && hiTf) { msg('상위 봉 받는 중…'); hiCs = await btCandles(p.ex, p.base, hiTf, Math.min(1500, Math.ceil((p.bars * BT_TF[p.tf].ms) / BT_TF[hiTf].ms) + 120)); }
      const ctx = { meta, fetched, src: `${BT_EX[p.ex]} ${meta.sym} ${BT_TF[p.tf].label}` };
      const res = [];
      for (const k of keys) {
        if (STRATS.LIST[k].needsHigher && !hiCs) { res.push({ strat: k, name: STRATS.LIST[k].name, error: '일봉은 상위 봉이 없어 전략 F를 쓸 수 없습니다' }); continue; }
        try { res.push(BT.run(cs, { ...p, strat: k, tfMs: BT_TF[p.tf].ms, hiCs, hiMs: hiTf ? BT_TF[hiTf].ms : null })); } catch (e) { res.push({ strat: k, name: STRATS.LIST[k].name, error: e.message }); }
      }
      msg('');
      $('#bout').innerHTML = all ? btCompare(res, ctx, p) : btReport(res[0], ctx, p);
      const cv = $('#bcv'); if (cv && res[0] && !res[0].error) btDraw(cv, res[0]);
      // 재현용 기록(설정·전략 버전·데이터 범위)
      const ok = res.filter((r) => !r.error), rr = await KV.get('bt:runs', []);
      ok.forEach((r) => rr.unshift({ when: btT(Date.now()), label: `${p.base} ${BT_TF[p.tf].label} ${BT_EX[p.ex]} · ${r.name}`, net: r.stats.netPct, mdd: r.stats.mdd, n: r.stats.n, ver: r.version, opt: { ...p, strat: r.strat }, from: r.from, to: r.to }));
      await KV.set('bt:runs', rr.slice(0, 30));
    } catch (e) { msg(`<span style="color:var(--red)">${esc(e.message)}</span>`); }
    finally { $('#brun').disabled = $('#ball').disabled = false; }
  };
  $('#brun').onclick = () => go(false);
  $('#ball').onclick = () => go(true);
}

function btAssume(r, ctx, p) {
  const m = ctx.meta, iss = r.issues;
  return `<details style="margin-top:8px"><summary class="muted" style="font-size:13px">가정·데이터·상품 정보</summary><ul class="steps" style="font-size:12px;margin-top:4px">
    <li>데이터: ${esc(ctx.src)} · 봉 ${r.bars}개(앞 ${STRATS.warmup}봉은 지표 준비) · ${btT(r.from)} ~ ${btT(r.to)} · 받은 시각 ${btT(ctx.fetched)}</li>
    <li>데이터 검사: 중복 ${iss.dup} · 비정상 봉 ${iss.bad} · 빈 구간 ${iss.gaps}곳(${iss.gapBars}봉)${iss.dup || iss.bad ? ' — 문제 봉은 빼고 계산' : ''}${iss.gaps ? ' — 빈 구간은 채우지 않음(거래 중단·점검 시간일 수 있음)' : ''}</li>
    <li>상품: ${esc(m.sym)} · ${esc(m.kind)}${m.ctVal ? ' · 1계약 = ' + esc(m.ctVal) : ''}${m.lotSz ? ' · 수량 단위 ' + esc(m.lotSz) : ''}${m.minSz ? ' · 최소 ' + esc(m.minSz) : ''}${m.tickSz ? ' · 호가 단위 ' + esc(m.tickSz) : ''}${m.minNotional ? ' · 최소 명목가 ' + esc(m.minNotional) : ''}${m.listed ? ' · 상장 ' + btT(m.listed) : ''}</li>
    <li>거래소 무기한 선물 가격입니다. 미국 상장 ETF·주식의 실제 가격이 아니며(24시간 거래·펀딩비), ETF 자체의 일일 레버리지·복리 효과와 거래소 레버리지는 다릅니다.</li>
    <li>비용 가정: 수수료 한쪽 ${p.fee}% · 슬리피지 한쪽 ${p.slip}% · 펀딩비 8시간마다 ${p.fund8h}%(가정, 롱이 냄) · 계약 단위 반올림 안 함 · 롱만</li>
    <li>위험 가정: 초기 ${p.capital} USDT · 거래당 위험 ${p.riskPct}% · 최대 배율 ${p.lev}배 · 손절 ATR×${p.stopAtr} · 목표 ${p.rr}R · 전략 버전 ${esc(r.version)}</li></ul></details>`;
}
function btReport(r, ctx, p) {
  if (r.error) return `<div class="card errbox">${esc(r.name)}: ${esc(r.error)}</div>`;
  const s = r.stats;
  const cell = (k, v, cls) => `<div>${k} <b class="${cls || ''}">${v}</b></div>`;
  return `<div class="card"><h2>${esc(r.name)} <span class="muted">${esc(p.base)} · ${BT_TF[p.tf].label}</span></h2>
      <div class="muted" style="font-size:12px">${esc(r.desc)}</div>
      <canvas id="bcv" class="chart" style="height:200px;margin-top:8px" aria-label="자산 곡선과 낙폭"></canvas>
      <div class="muted" style="font-size:11px">선: 자산(비용·미실현 포함) · 아래 붉은 면: 최고점 대비 낙폭</div>
      <div class="grid2" style="font-size:13px;margin-top:8px">
        ${cell('초기 → 최종', `${btNum(s.capital, 0)} → ${btNum(s.final, 2)}`)}${cell('순수익률(비용 뺌)', btPct(s.netPct), s.netPct > 0 ? 'up' : 'down')}
        ${cell('수수료·펀딩 빼기 전', btPct(s.grossPct))}${cell('최대 낙폭(MDD)', btPct(s.mdd), 'down')}
        ${cell('거래 수', s.n + '번')}${cell('승률', btPct(s.winRate, 1).replace('+', ''))}
        ${cell('평균 이익 / 손실', `${btNum(s.avgWin)} / ${btNum(s.avgLoss)}`)}${cell('손익비', btNum(s.payoff))}
        ${cell('Profit Factor', btNum(s.pf))}${cell('평균 R', btNum(s.avgR))}
        ${cell('Sharpe(연환산)', btNum(s.sharpe))}${cell('Sortino(연환산)', btNum(s.sortino))}
        ${cell('평균 보유', s.avgBars != null ? `${s.avgBars.toFixed(1)}봉` : '-')}${cell('최대 연속 손실', s.maxLossStreak + '번')}
        ${cell('실현 / 미실현 손익', `${btNum(s.realized)} / ${btNum(s.unrealized)}`)}${cell('수수료 합', btNum(s.fee))}
        ${cell('슬리피지 추정', btNum(s.slip))}${cell('펀딩비 합(가정)', btNum(s.fund))}</div>
      ${r.open ? `<div class="warnlist" style="font-size:12px">아직 열린 가상 포지션: ${btT(r.open.entryT)} 진입 ${btNum(r.open.entry, 4)} · 손절 ${btNum(r.open.stop, 4)} · 목표 ${btNum(r.open.target, 4)} · 미실현 ${btNum(r.open.unreal)}</div>` : ''}
      <h4>구간별(시간순, 튜닝에 쓰지 말 것)</h4>
      <div class="tblwrap"><table class="md"><thead><tr><th>구간</th><th>기간</th><th>수익률</th><th>MDD</th><th>거래</th><th>승률</th></tr></thead><tbody>${r.segs.map((g) => `<tr><td>${g.name} ${g.w}%</td><td>${btT(g.from)}~${btT(g.to)}</td><td class="${g.ret > 0 ? 'up' : 'down'}">${btPct(g.ret)}</td><td>${btPct(g.mdd)}</td><td>${g.n}</td><td>${g.win != null ? g.win.toFixed(0) + '%' : '-'}</td></tr>`).join('')}</tbody></table></div>
      <details style="margin-top:8px"><summary><b>거래 내역</b> <span class="muted">(${r.trades.length})</span></summary><div class="tblwrap"><table class="md"><thead><tr><th>진입</th><th>진입가</th><th>청산</th><th>청산가</th><th>사유</th><th>손익</th><th>R</th><th>봉</th><th>비용</th></tr></thead><tbody>
        ${r.trades.slice().reverse().map((t) => `<tr><td>${btT(t.entryT)}</td><td>${btNum(t.entry, 4)}</td><td>${btT(t.exitT)}</td><td>${btNum(t.exit, 4)}</td><td>${esc(t.why)}</td><td class="${t.pnl > 0 ? 'up' : 'down'}">${btNum(t.pnl)}</td><td>${btNum(t.R)}</td><td>${t.bars}</td><td>${btNum(t.fee + t.fund)}</td></tr>`).join('')}</tbody></table></div></details>
      ${btAssume(r, ctx, p)}</div>`;
}
function btCompare(res, ctx, p) {
  const ok = res.filter((r) => !r.error);
  return `<div class="card"><h2>전략 비교 <span class="muted">${esc(p.base)} · ${BT_TF[p.tf].label} · 같은 데이터·비용·자본</span></h2>
    <div class="tblwrap"><table class="md"><thead><tr><th>전략</th><th>순수익률</th><th>MDD</th><th>거래</th><th>승률</th><th>PF</th><th>Sharpe</th><th>테스트 구간</th></tr></thead><tbody>
      ${res.map((r) => r.error ? `<tr><td>${esc(r.name)}</td><td colspan="7" class="muted">${esc(r.error)}</td></tr>` : `<tr><td>${esc(r.name)}</td><td class="${r.stats.netPct > 0 ? 'up' : 'down'}">${btPct(r.stats.netPct)}</td><td>${btPct(r.stats.mdd)}</td><td>${r.stats.n}</td><td>${r.stats.winRate != null ? r.stats.winRate.toFixed(0) + '%' : '-'}</td><td>${btNum(r.stats.pf)}</td><td>${btNum(r.stats.sharpe)}</td><td class="${r.segs[2] && r.segs[2].ret > 0 ? 'up' : 'down'}">${r.segs[2] ? btPct(r.segs[2].ret) : '-'}</td></tr>`).join('')}</tbody></table></div>
    <div class="muted" style="font-size:12px;margin-top:6px">순위를 매기지 않습니다. 거래 수가 적으면(예: 10번 미만) 우연일 수 있고, 여러 전략 중 가장 좋은 것을 고르는 것 자체가 과최적화 위험입니다. 자세히 보려면 전략을 하나 골라 실행하세요.</div>
    ${ok[0] ? btAssume(ok[0], ctx, p) : ''}</div>`;
}
// 자산 곡선 + 낙폭
function btDraw(cv, r) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, Hh = cv.clientHeight; cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const eq = r.curve.map((p) => p.eq); if (eq.length < 2) return;
  let peak = eq[0]; const dd = eq.map((v) => { peak = Math.max(peak, v); return (v - peak) / peak; });
  const lo = Math.min(...eq, r.opt.capital), hi = Math.max(...eq, r.opt.capital), mdd = Math.min(...dd) || -0.0001;
  const topH = Hh * 0.72, x = (i) => (i / (eq.length - 1)) * (W - 50), y = (v) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (topH - 12);
  const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue('--muted') || '#888';
  g.font = '10px sans-serif'; g.fillStyle = ink;
  [lo, r.opt.capital, hi].forEach((v) => { g.fillText(v.toFixed(0), W - 46, y(v) + 3); });
  g.strokeStyle = 'rgba(128,128,128,.35)'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, y(r.opt.capital)); g.lineTo(W - 50, y(r.opt.capital)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#7A4CD1'; g.lineWidth = 1.6; g.beginPath(); eq.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
  g.fillStyle = 'rgba(214,69,69,.35)'; g.beginPath(); g.moveTo(0, topH + 4); dd.forEach((d, i) => g.lineTo(x(i), topH + 4 + (d / mdd) * (Hh - topH - 8))); g.lineTo(x(dd.length - 1), topH + 4); g.closePath(); g.fill();
  g.fillStyle = ink; g.fillText(`MDD ${(mdd * 100).toFixed(1)}%`, W - 50, Hh - 4);
}
