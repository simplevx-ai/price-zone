// zones.js(앱의 구간 계산식)를 Code.gs 안의 표시 사이에 그대로 복사한다. 실행: node alert/build.mjs
import fs from 'node:fs';
const dir = new URL('.', import.meta.url);
const gsPath = new URL('Code.gs', dir), zones = fs.readFileSync(new URL('../zones.js', dir), 'utf8').trim();
const gs = fs.readFileSync(gsPath, 'utf8');
const A = '/* ==== zones.js 시작', B = '/* ==== zones.js 끝 ==== */';
const a = gs.indexOf(A), b = gs.indexOf(B);
if (a < 0 || b < a) throw new Error('Code.gs에서 zones.js 표시를 찾지 못했습니다');
const head = gs.slice(0, gs.indexOf('\n', a) + 1);
fs.writeFileSync(gsPath, head + zones + '\n' + gs.slice(b));
console.log('zones.js → Code.gs 복사 완료');
