// 앱의 계산 파일(zones.js·nq.js·scan.js·levels.js)을 Code.gs 안의 표시 사이에 그대로 복사한다. 실행: node alert/build.mjs
import fs from 'node:fs';
const dir = new URL('.', import.meta.url);
const gsPath = new URL('Code.gs', dir);
let gs = fs.readFileSync(gsPath, 'utf8');
// scan.js·levels.js는 선물 스캐너 앱(nasdaq-futures) 것을 씀: ETF 목록이 더 많고 강한 신호 계산(levels.js)과 rsiSeries가 있음
const FROM = { 'zones.js': '../zones.js', 'nq.js': '../nq.js', 'scan.js': '../../nasdaq-futures/scan.js', 'levels.js': '../../nasdaq-futures/levels.js' };
for (const name of Object.keys(FROM)) {
  const src = fs.readFileSync(new URL(FROM[name], dir), 'utf8').trim();
  const A = '/* ==== ' + name + ' 시작', B = '/* ==== ' + name + ' 끝 ==== */';
  const a = gs.indexOf(A), b = gs.indexOf(B);
  if (a < 0 || b < a) throw new Error('Code.gs에서 ' + name + ' 표시를 찾지 못했습니다');
  gs = gs.slice(0, gs.indexOf('\n', a) + 1) + src + '\n' + gs.slice(b);
}
fs.writeFileSync(gsPath, gs);
console.log('zones.js·nq.js·scan.js·levels.js → Code.gs 복사 완료');
