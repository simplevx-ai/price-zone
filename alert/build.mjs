// 앱의 계산 파일(zones.js·nq.js)을 Code.gs 안의 표시 사이에 그대로 복사한다. 실행: node alert/build.mjs
import fs from 'node:fs';
const dir = new URL('.', import.meta.url);
const gsPath = new URL('Code.gs', dir);
let gs = fs.readFileSync(gsPath, 'utf8');
for (const name of ['zones.js', 'nq.js']) {
  const src = fs.readFileSync(new URL('../' + name, dir), 'utf8').trim();
  const A = '/* ==== ' + name + ' 시작', B = '/* ==== ' + name + ' 끝 ==== */';
  const a = gs.indexOf(A), b = gs.indexOf(B);
  if (a < 0 || b < a) throw new Error('Code.gs에서 ' + name + ' 표시를 찾지 못했습니다');
  gs = gs.slice(0, gs.indexOf('\n', a) + 1) + src + '\n' + gs.slice(b);
}
fs.writeFileSync(gsPath, gs);
console.log('zones.js·nq.js → Code.gs 복사 완료');
