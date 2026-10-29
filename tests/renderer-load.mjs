// 렌더러 싣기 순서 — renderer/*.js 를 index.html 의 태그 순서대로 브라우저처럼 따로따로 실어 본다(앱을 띄우지 않는다).
//
// 렌더러는 한 덩어리를 단락별로 나눈 클래식 스크립트들이다. 한 파일일 때는 함수 선언이 파일 전체로 끌어올려져 어디서든 불렀지만,
// 나눈 뒤에는 맨 위에서 바로 도는 코드(최상위 const 의 초기값 · 이벤트 등록 · init)가 **뒤 파일**의 함수나 const 를 쓰면 그 파일이
// 실리기 전이라 ReferenceError 로 화면이 통째로 죽는다. 같은 이름을 두 파일에서 선언해도 뒤 파일이 SyntaxError 로 죽는다.
// 둘 다 앱이 떠야만 드러나서 여기서 막는다. DOM · preload(api) · Chart.js 는 무엇을 물어도 답하는 가짜를 끼운다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { RENDERER_FILES, rendererFile } from './_renderer.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// 무엇을 물어도 자기를 돌려주는 가짜(부르기 · new · 속성 · 문자열 바꾸기 모두). await 하면 영영 기다린다 — init 은 첫 await 에서 멈춘다.
const any = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? () => {} : k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : any),
  apply: () => any,
  construct: () => any,
  has: () => true,
});

// 렌더러 앞에 싣는 것들(index.html 과 같은 순서)과 가짜 브라우저 · 앱
function load(files, patch = (_f, src) => src) {
  const c = vm.createContext({
    document: any, window: any, api: any, Chart: any, navigator: any, localStorage: any, getComputedStyle: any,
    matchMedia: any, ResizeObserver: any, requestAnimationFrame: any, Notification: any,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console,
  });
  for (const f of ['indicators.js', 'backtest.js', 'market-check.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), c, { filename: f });
  }
  for (const f of files) vm.runInContext(patch(f, rendererFile(f)), c, { filename: f });
  return c;
}

check('index.html 이 렌더러 파일을 싣는다', RENDERER_FILES.length >= 10, RENDERER_FILES.join(' '));

// 1. 태그 순서대로 실으면 아무 파일도 죽지 않는다
let err = null;
try { load(RENDERER_FILES); } catch (e) { err = e; }
check('태그 순서대로 실으면 죽지 않는다', !err, err ? `${err.name}: ${err.message}` : '');

// 2. 실린 뒤에는 모든 파일의 최상위 이름이 한 전역에 있다 — 앞 파일의 함수가 뒤 파일의 것을 부를 수 있다
{
  const c = load(RENDERER_FILES);
  const names = ['state', 'quotes', 'levelOf', 'money', 'renderList', 'renderIndices', 'renderFolio', 'renderDetail', 'metricsHtml',
    'marketHtml', 'renderTrendCheck', 'drawChart', 'loadChart', 'select', 'renderTabs', 'pollTick'];
  const missing = names.filter((n) => vm.runInContext(`typeof ${n}`, c) === 'undefined');
  check('파일마다의 이름이 한 전역에 있다', missing.length === 0, missing.join(', '));
}

// 3. 이 검사가 실제로 잡는지 — 앞 파일 맨 위에서 뒤 파일의 함수를 쓰면 죽는다(한 파일이었으면 끌어올려져 살았다).
//    같은 이름을 다른 파일에서 또 선언해도 죽는다.
{
  const early = RENDERER_FILES[1];
  let e1 = null;
  try { load(RENDERER_FILES, (f, src) => (f === early ? `${src}\nconst __probe = drawChart;\n` : src)); } catch (e) { e1 = e; }
  check(`${early} 맨 위에서 뒤 파일의 drawChart 를 쓰면 ReferenceError`, e1 && e1.name === 'ReferenceError', e1 ? e1.message : '죽지 않았다');
  let e2 = null;
  try { load(RENDERER_FILES, (f, src) => (f === RENDERER_FILES.at(-1) ? `${src}\nconst UP = 'x';\n` : src)); } catch (e) { e2 = e; }
  check('다른 파일과 같은 이름을 선언하면 SyntaxError', e2 && e2.name === 'SyntaxError', e2 ? e2.message : '죽지 않았다');
}

// 4. 파일마다 그 자체로 문법이 맞는다 — 문장이 파일 경계에 걸쳐 잘리지 않았다
{
  const bad = RENDERER_FILES.filter((f) => { try { new vm.Script(rendererFile(f), { filename: f }); return false; } catch { return true; } });
  check('파일마다 문법이 맞는다', bad.length === 0, bad.join(', '));
}

assert.ok(true);
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
