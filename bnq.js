/* 🧠 비트코인·나스닥100 퀀트 분석 카드
 * 데이터: data/btc_nq.json — PC의 예약 작업(평일 18시, btc_nq/report.mjs)이 계산해 이 저장소에 올림. 디스코드로 가는 글과 같은 내용.
 * 표시 규칙: 상승 ▲ 빨강 · 하락 ▼ 파랑 · % 숫자 빨강 · 중요도 ★ 1~5개(많을수록 진한 노랑) · 비트코인·나스닥 가격은 크게
 */
'use strict';

const BNQ = (() => {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n0 = (x) => (x == null || !isFinite(x) ? '-' : Math.round(x).toLocaleString('en-US'));
  const arrow = (d) => (d > 0 ? '<b class="bq-up">▲</b>' : d < 0 ? '<b class="bq-dn">▼</b>' : '<b class="bq-flat">―</b>');
  // 글 안의 ▲▼와 % 숫자에 색 입히기(이미 이스케이프한 글에만)
  const paint = (html) => html.replace(/([+\-−]?\d[\d,]*(?:\.\d+)?%)/g, '<span class="bq-pct">$1</span>').replace(/▲/g, '<b class="bq-up">▲</b>').replace(/▼/g, '<b class="bq-dn">▼</b>');
  const stars = (k) => { k = Math.max(1, Math.min(5, k | 0)); return `<span class="bq-stars s${k}" title="중요도 ${k}/5">${'<i>★</i>'.repeat(k)}${'<i class="off">★</i>'.repeat(5 - k)}</span>`; };
  const verdictCls = (v) => (/좋음/.test(v) ? 'good' : /나쁨/.test(v) ? 'bad' : 'mid');

  function asset(a) {
    const cs = a.concl === '상승' ? 1 : a.concl === '하락' ? -1 : 0, s = a.signal || {};
    const tfRow = a.tf ? `<div class="bq-tf"><span>큰 흐름(주봉) ${arrow(a.tf.big)}</span><span>중간(일봉·4시간) ${arrow(a.tf.mid)}</span><span>단기(1시간·15분) ${arrow(a.tf.short)}</span></div>` : '';
    let plan;
    if (!s.side) plan = `<div class="bq-sig"><div class="bq-sigh">${arrow(0)} 시그널: 관망 ${stars(s.star || 1)}</div>
      <div class="bq-note">롱·숏 모두 과거 1년 비슷한 날 기대값이 손해 쪽 → 기다림.<br>${arrow(1)} <b>${n0(s.wait && s.wait.up)}</b> 위 일봉 마감이면 상승 쪽 · ${arrow(-1)} <b>${n0(s.wait && s.wait.dn)}</b> 아래 마감이면 하락 쪽으로 다시 판단</div></div>`;
    else plan = `<div class="bq-sig"><div class="bq-sigh">${arrow(s.side)} 시그널: ${e(s.text)} ${stars(s.star)}</div>
      ${(s.why || []).length ? `<div class="bq-note">${paint(e(s.why.join(' · ')))}</div>` : ''}
      <table class="bq-plan">
        <tr class="r-p"><th>확률</th><td>1차 목표 먼저 <span class="bq-pct big">${s.p1}%</span> · 2차 <span class="bq-pct">${s.p2}%</span></td></tr>
        <tr class="r-e"><th>진입</th><td><b>${n0(s.zone[0])} ~ ${n0(s.zone[1])}</b>${s.wait ? `<div class="bq-sub">${n0(s.wait.level)}까지 ${s.side > 0 ? '눌림' : '반등'} 먼저 올 확률 <span class="bq-pct">${s.wait.pct}%</span> → 그 근처에서 확인 후</div>` : ''}</td></tr>
        <tr class="r-s"><th>손절</th><td><b>${n0(s.stop)}</b> <span class="bq-pct">${s.stopPct >= 0 ? '+' : ''}${s.stopPct.toFixed(1)}%</span> <span class="bq-sub">일봉 종가 기준${s.next ? ` · 깨지면 다음 ${n0(s.next)}` : ''}</span></td></tr>
        <tr class="r-t"><th>목표 1</th><td><b>${n0(s.t1)}</b> <span class="bq-sub">손익비 ${s.rr1.toFixed(1)} · 일부 정리 후 손절을 진입가로</span></td></tr>
        <tr class="r-t"><th>목표 2</th><td><b>${n0(s.t2)}</b> <span class="bq-sub">손익비 ${s.rr2.toFixed(1)}</span></td></tr>
      </table></div>`;
    return `<div class="bq-asset">
      <div class="bq-head"><span class="bq-name">${e(a.icon)} ${e(a.name)}</span><span class="bq-price">${n0(a.price)}</span></div>
      <div class="bq-concl">${arrow(cs)} 결론 <b>${e(a.concl)}</b> <span class="bq-pct big">${a.prob}%</span> ${stars(a.cStar)}</div>
      ${a.rel ? `<div class="bq-rel"><span class="bq-relg g-${a.rel.grade === '높음' ? 'hi' : a.rel.grade === '보통' ? 'mid' : 'lo'}">신뢰도 ${e(a.rel.grade)}</span> <span class="bq-sub">최근 1년 실제: ${paint(e(a.rel.text))}${a.rel.grade === '낮음' ? ' → 확률은 참고만' : ''}</span></div>` : ''}
      <div class="bq-race">${arrow(1)} ${n0(a.up.p)} 먼저 <span class="bq-pct">${a.up.pct}%</span> · ${arrow(-1)} ${n0(a.dn.p)} 먼저 <span class="bq-pct">${a.dn.pct}%</span> <span class="bq-sub">(최근 1년 비슷한 날 ${a.sims}일${a.sims < 60 ? ', 표본 적음' : ''})</span></div>
      ${tfRow}${plan}</div>`;
  }

  async function card(host) {
    if (!host) return;
    host.innerHTML = '<div class="card bq"><div class="muted">🧠 비트코인·나스닥 분석 받는 중…</div></div>';
    let J;
    try { const r = await fetch('data/btc_nq.json?t=' + Math.floor(Date.now() / 60e3), { cache: 'no-cache' }); if (!r.ok) throw new Error('아직 분석 파일이 없습니다'); J = await r.json(); }
    catch (err) { host.innerHTML = `<div class="card bq"><h2>🧠 비트코인·나스닥 분석</h2><div class="muted" style="font-size:13px">${e(err.message)} — 평일 18시에 PC가 계산해 올립니다.</div></div>`; return; }
    const ageH = (Date.now() - Date.parse(J.at)) / 3600e3;
    host.innerHTML = `<div class="card bq">
      <div class="row spread"><h2 style="margin:0">🧠 비트코인·나스닥 분석</h2><span class="muted" style="font-size:12px">${e(J.stamp)} 기준${ageH > 30 ? ' · <b style="color:var(--red)">오래된 분석</b>' : ''}</span></div>
      <div class="muted" style="font-size:12px;margin:2px 0 8px">확률은 최근 1년 중 지금과 같은 점수였던 날들에서 실제로 먼저 닿은 쪽을 센 값 · 중요도 ★(최대 5)</div>
      ${J.assets.map(asset).join('')}
      <details class="bq-more" open><summary><b>근거 요약</b></summary>${J.facts.slice().sort((a, b) => b.star - a.star).map((f) => `<div class="bq-fact">${stars(f.star)} ${arrow(f.dir)} <b>${e(f.name)}</b> <span class="bq-v ${verdictCls(f.verdict)}">${e(f.verdict)}</span><div class="bq-ft">${paint(e(f.txt))}</div></div>`).join('')}</details>
      ${J.econ && J.econ.length ? `<details class="bq-more"><summary><b>미국 경제 일정</b> <span class="muted" style="font-size:12px">한국 시간</span></summary>${J.econ.map((x) => `<div class="bq-fact">${stars(x.star)} <b>${e(x.when)}</b> ${e(x.name)}${x.fc ? ` <span class="bq-sub">예상 ${paint(e(x.fc))} · 이전 ${paint(e(x.pv || '-'))}</span>` : ''}</div>`).join('')}</details>` : ''}
      ${J.risks && J.risks.length ? `<details class="bq-more"><summary><b>리스크</b></summary>${J.risks.map((r) => `<div class="bq-fact">${stars(r.star)} ${paint(e(r.text))}</div>`).join('')}</details>` : ''}
      ${J.warn && J.warn.length ? `<div class="muted" style="font-size:11px;margin-top:6px">빠진 데이터: ${e(J.warn.join(' · '))}</div>` : ''}
      <div class="muted" style="font-size:11px;margin-top:6px">규칙으로 계산한 공부용 결과이며 매매 권유가 아닙니다. 평일 18시 갱신(디스코드와 같은 내용).</div></div>`;
  }
  return { card };
})();
