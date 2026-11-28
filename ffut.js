// 해외선물 공통(앱·알림 스크립트 같이 씀 — alert/build.mjs가 Code.gs에 복사)
// - 종목은 '뿌리 기호'(NQ·ES·GC…)로 저장 → 주력 월물 코드(NQZ26 등)는 날짜로 자동 계산, 월물이 바뀌면 저절로 다음 월물
// - 한국투자증권 키가 생기기 전까지는 OKX의 같은 기초자산 무기한 선물 가격으로 대신 봄(CME 가격과 조금 다름)
// - 만기·롤오버 날짜는 거래소 규칙을 단순화한 '추정'(공휴일은 따지지 않음)
var FF = (function () {
  var L = 'FGHJKMNQUVXZ'; // 1~12월 월물 글자
  var Q = [3, 6, 9, 12];
  // 셋째 금요일 13:30 UTC(미국 지수 선물 만기)
  function third(y, m) { var d = new Date(Date.UTC(y, m - 1, 1)); var add = (5 - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(y, m - 1, 1 + add + 14, 13, 30)); }
  // 달 계산(m은 1~12, 넘치면 해를 넘김)
  function day(y, m, d) { return new Date(Date.UTC(y, m - 1, d, 18)); }
  var IDX = { months: Q, exp: third, roll: function (e) { return new Date(e.getTime() - 8 * 86400e3); } };
  // 원유: 인도 월 전달 20일쯤 만기 · 천연가스: 전달 26일쯤 · 브렌트: 두 달 전 말일쯤
  var CLR = { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], exp: function (y, m) { return day(y, m - 1, 20); }, roll: function (e) { return new Date(e.getTime() - 5 * 86400e3); } };
  var NGR = { months: CLR.months, exp: function (y, m) { return day(y, m - 1, 26); }, roll: CLR.roll };
  var BZR = { months: CLR.months, exp: function (y, m) { return day(y, m - 1, 0); }, roll: CLR.roll };
  // 금속: 거래가 전달 말(첫 통지일) 전에 다음 월물로 옮겨 감 → 전달 25일쯤 롤오버, 만기는 그 달 27일쯤
  function metal(ms) { return { months: ms, exp: function (y, m) { return day(y, m, 27); }, roll: function (e, y, m) { return day(y, m - 1, 25); } }; }
  // 미국 국채: 전달 말 첫 통지일 전 롤오버
  var BOND = { months: Q, exp: function (y, m) { return day(y, m, 20); }, roll: function (e, y, m) { return day(y, m - 1, 24); } };
  var ROOTS = {
    NQ: { name: '나스닥100 선물', ex: 'CME', okx: 'US100', sch: IDX, pt: '1포인트 $20' },
    MNQ: { name: '마이크로 나스닥100 선물', ex: 'CME', okx: 'US100', sch: IDX, pt: '1포인트 $2' },
    ES: { name: 'S&P500 선물', ex: 'CME', okx: 'US500', sch: IDX, pt: '1포인트 $50' },
    MES: { name: '마이크로 S&P500 선물', ex: 'CME', okx: 'US500', sch: IDX, pt: '1포인트 $5' },
    RTY: { name: '러셀2000 선물', ex: 'CME', okx: 'IWM', sch: IDX, etf: true, pt: '1포인트 $50' },
    NKD: { name: '니케이225 선물(달러)', ex: 'CME', okx: 'JP225', sch: IDX, pt: '1포인트 $5' },
    CL: { name: 'WTI 원유 선물', ex: 'NYMEX', okx: 'CL', sch: CLR, pt: '1달러 $1,000' },
    MCL: { name: '마이크로 WTI 원유 선물', ex: 'NYMEX', okx: 'CL', sch: CLR, pt: '1달러 $100' },
    BZ: { name: '브렌트유 선물', ex: 'NYMEX', okx: 'BZ', sch: BZR, pt: '1달러 $1,000' },
    NG: { name: '천연가스 선물', ex: 'NYMEX', okx: 'NG', sch: NGR, pt: '0.001달러 $10' },
    GC: { name: '금 선물', ex: 'COMEX', okx: 'XAU', sch: metal([2, 4, 6, 8, 10, 12]), pt: '1달러 $100' },
    MGC: { name: '마이크로 금 선물', ex: 'COMEX', okx: 'XAU', sch: metal([2, 4, 6, 8, 10, 12]), pt: '1달러 $10' },
    SI: { name: '은 선물', ex: 'COMEX', okx: 'XAG', sch: metal([3, 5, 7, 9, 12]), pt: '0.005달러 $25' },
    HG: { name: '구리 선물', ex: 'COMEX', okx: 'XCU', sch: metal([3, 5, 7, 9, 12]), pt: '0.0005달러 $12.5' },
    PL: { name: '백금 선물', ex: 'NYMEX', okx: 'XPT', sch: metal([1, 4, 7, 10]), pt: '1달러 $50' },
    PA: { name: '팔라듐 선물', ex: 'NYMEX', okx: 'XPD', sch: metal([3, 6, 9, 12]), pt: '1달러 $100' },
    ZN: { name: '미국 10년 국채 선물', ex: 'CBOT', okx: 'TLT', sch: BOND, etf: true, pt: '1포인트 $1,000' },
    ZB: { name: '미국 30년 국채 선물', ex: 'CBOT', okx: 'TLT', sch: BOND, etf: true, pt: '1포인트 $1,000' },
  };
  // 'NQZ25'·'NQZ2025'·'nq' → 'NQ' (예전에 월물 코드로 저장한 종목도 뿌리로 읽음)
  function root(sym) {
    var s = String(sym || '').toUpperCase().trim();
    if (ROOTS[s]) return s;
    var m = s.match(/^([A-Z]{1,3})[FGHJKMNQUVXZ]\d{1,4}$/);
    return m && ROOTS[m[1]] ? m[1] : s;
  }
  // 주력 월물: 롤오버 날이 지나면 다음 월물
  function front(sym, now) {
    now = now || new Date();
    var r = ROOTS[root(sym)]; if (!r) return null;
    var list = [], y0 = now.getUTCFullYear();
    for (var y = y0; y <= y0 + 2; y++) r.sch.months.forEach(function (m) {
      var e = r.sch.exp(y, m);
      list.push({ code: root(sym) + L[m - 1] + String(y).slice(2), y: y, mm: m, exp: e, roll: r.sch.roll(e, y, m) });
    });
    list.sort(function (a, b) { return a.exp - b.exp; });
    var act = list.filter(function (x) { return x.exp > now; });
    var i = act[0].roll <= now ? 1 : 0;
    return { main: act[i], next: act[i + 1], front: act[0], rolled: i === 1, daysToRoll: Math.ceil((act[i].roll - now) / 86400e3), daysToExp: Math.ceil((act[0].exp - now) / 86400e3) };
  }
  function info(sym) { return ROOTS[root(sym)] || null; }
  function okxId(sym) { var r = info(sym); return r ? r.okx + '-USDT-SWAP' : ''; }
  // 화면 이름: '나스닥100 선물 NQZ26'
  function label(sym, name) { var f = front(sym); var r = info(sym); return (name || (r ? r.name : sym)) + (f ? ' ' + f.main.code : ''); }
  function list() { return Object.keys(ROOTS).map(function (k) { return { sym: k, name: ROOTS[k].name, r: ROOTS[k] }; }); }
  return { ROOTS: ROOTS, root: root, front: front, info: info, okxId: okxId, label: label, list: list };
})();
if (typeof module !== 'undefined') module.exports = FF;
