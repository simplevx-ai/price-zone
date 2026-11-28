/* 연결 도우미 — 거래소·스크립트 요청에 시간 제한·한 번 재시도·'연결이 느립니다' 표시를 붙인다.
 * AI 마켓 스캐너·선물 스캐너·코인 스캐너가 같은 파일을 쓴다(앱 파일보다 먼저 불러옴).
 * - 다른 주소(거래소 API·구글 스크립트)로 가는 fetch만 감싼다. 앱 자기 파일은 그대로.
 * - GET: 12초 안에 응답이 없거나 네트워크 오류·429·5xx면 0.8초 쉬고 한 번 더(그래도 안 되면 원래처럼 오류 → 앱의 다음 거래소로 넘어감)
 * - POST(구글 스크립트): 30초 제한, 재시도 안 함(알림 저장 같은 일이 두 번 되지 않게)
 * - 요청 하나가 6초 넘게 걸리면 화면 아래에 '연결이 느립니다 · 다시 시도' 표시
 */
(() => {
  if (window.__netWrapped) return;
  window.__netWrapped = true;
  const raw = window.fetch.bind(window);
  const GET_MS = 12000, POST_MS = 30000, SLOW_MS = 6000;
  let pending = 0, slowTimer = null;
  const bar = () => {
    let b = document.getElementById('netSlow');
    if (!b) {
      b = document.createElement('div'); b.id = 'netSlow'; b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(122px + env(safe-area-inset-bottom));z-index:9;display:none;align-items:center;justify-content:space-between;gap:8px;background:#FFF4D6;color:#5A3D00;border:1px solid #E8A317;border-radius:10px;padding:8px 10px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.18)';
      b.innerHTML = '<span>🐢 연결이 느립니다 — 거래소 응답을 기다리는 중</span><button type="button" style="border:1px solid #C98A00;background:#FFC83D;color:#1A1300;border-radius:8px;padding:5px 10px;font-weight:700">다시 시도</button>';
      b.querySelector('button').onclick = () => { b.style.display = 'none'; window.dispatchEvent(new HashChangeEvent('hashchange')); };
      document.body.appendChild(b);
    }
    return b;
  };
  const show = (on) => { try { bar().style.display = on ? 'flex' : 'none'; } catch { /* 화면 준비 전 */ } };
  const begin = () => { pending++; if (!slowTimer) slowTimer = setTimeout(() => { slowTimer = null; if (pending > 0) show(true); }, SLOW_MS); };
  const end = () => { pending = Math.max(0, pending - 1); if (!pending) { clearTimeout(slowTimer); slowTimer = null; show(false); } };
  const once = async (input, init, ms) => {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    if (init && init.signal) init.signal.addEventListener('abort', () => ac.abort());
    try { return await raw(input, { ...(init || {}), signal: ac.signal }); }
    finally { clearTimeout(t); }
  };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    let other = false; try { other = new URL(url, location.href).origin !== location.origin; } catch { other = false; }
    if (!other) return raw(input, init);
    const post = !!(init && init.method && init.method.toUpperCase() !== 'GET');
    begin();
    try {
      if (post) return await once(input, init, POST_MS);
      try {
        const r = await once(input, init, GET_MS);
        if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 800)); return await once(input, init, GET_MS); }
        return r;
      } catch (e) {
        if (init && init.signal && init.signal.aborted) throw e; // 앱이 직접 취소한 요청은 다시 하지 않음
        await new Promise((ok) => setTimeout(ok, 800));
        return await once(input, init, GET_MS);
      }
    } finally { end(); }
  };
})();
