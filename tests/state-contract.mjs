// 저장 계약 가드 — 앱을 띄우지 않고 렌더러(renderer/*.js)와 main.js 의 키 목록만 맞춰 본다.
//
// 두 가지를 검사한다.
// 1) 렌더러의 save() 가 보내는 키와 main.js 의 STATE_KEYS 가 같은지. state:set 은 이 목록에 있는 키만 쓰고 state:get ·
//    설정 백업은 이 목록을 읽는다 — 목록에 빠진 키는 예외도 로그도 없이 저장 · 복원되지 않아 앱을 껐다 켜야만
//    드러난다(chartMode 는 저장은 됐는데 다음 실행에 읽히지 않았다). 목록에만 있는 키는 죽은 항목이다.
// 2) IPC 계약 — preload.js 가 내보내는 함수 · 채널, main.js 가 받는 채널, 렌더러가 부르는 api 함수가 서로 맞는지.
//    한쪽 이름만 바꾸면 그 기능이 조용히 죽는다(invoke 는 "No handler registered", 렌더러는 undefined 호출).
import fs from 'node:fs';
import { rendererSource } from './_renderer.mjs';

const renderer = rendererSource(); // renderer/*.js 를 index.html 순서로 이은 것(예전 renderer.js)
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// save() 가 api.setState 로 보내는 키
const saveStart = renderer.indexOf('const save = () => api.setState({');
const saveEnd = renderer.indexOf('});', saveStart);
check('렌더러에서 save() 를 찾았다', saveStart >= 0 && saveEnd > saveStart);

// main.js 의 STATE_KEYS — 읽기 · 쓰기 · 백업이 함께 쓰는 목록(셋이 따로 적혀 있던 것을 하나로, 2026-11-05)
const stateKeys = /const STATE_KEYS = \[([^\]]*)\]/.exec(main);
check('main.js 에서 STATE_KEYS 를 찾았다', !!stateKeys);

if (saveStart >= 0 && saveEnd > saveStart && stateKeys) {
  const sent = [...renderer.slice(saveStart, saveEnd).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const listed = [...stateKeys[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);

  check('save() 가 보내는 키가 하나 이상이다', sent.length > 0, sent.join(' '));

  const missing = sent.filter((k) => !listed.includes(k));
  check('save() 가 보내는 키가 STATE_KEYS 에 모두 있다', missing.length === 0,
    missing.length ? `STATE_KEYS 에 없음: ${missing.join(' ')}` : `${sent.length}개 확인`);

  const unsent = listed.filter((k) => !sent.includes(k));
  check('STATE_KEYS 에 보내지 않는 키가 없다', unsent.length === 0,
    unsent.length ? `save() 가 안 보냄: ${unsent.join(' ')}` : '');
}

// 2) IPC 계약
const preload = fs.readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
const exposed = new Map([...preload.matchAll(/^\s+(\w+): \([^)]*\) => ipcRenderer\.(?:invoke|send)\('([^']+)'/gm)].map((m) => [m[1], m[2]]));
const handled = new Set([...main.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1]));
const used = new Set([...renderer.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]));
check('preload · main · renderer 에서 IPC 를 찾았다', exposed.size > 0 && handled.size > 0 && used.size > 0,
  `preload ${exposed.size} · main ${handled.size} · renderer ${used.size}`);
const noHandler = [...exposed].filter(([, ch]) => !handled.has(ch)).map(([n, ch]) => `${n}→${ch}`);
check('preload 가 보내는 채널을 main 이 모두 받는다', !noHandler.length, noHandler.join(' '));
const unknown = [...used].filter((n) => !exposed.has(n));
check('renderer 가 부르는 api 함수는 preload 에 모두 있다', !unknown.length, unknown.join(' '));
const unusedFn = [...exposed.keys()].filter((n) => !used.has(n));
check('preload 가 내보내는 함수는 renderer 가 모두 쓴다', !unusedFn.length, unusedFn.join(' '));
const orphan = [...handled].filter((ch) => ![...exposed.values()].includes(ch));
check('main 이 받는 채널은 preload 가 모두 내보낸다', !orphan.length, orphan.join(' '));

// 항상 위(설정의 고정 / 안 고정, 2026-11-13) — 창을 만들 때 · 저장을 받을 때 · 백업을 불러올 때 · 다시 보일 때 저장값을 따른다.
// 한 곳이라도 true 로 못 박혀 있으면 안 고정으로 둔 창이 숨겼다 켤 때 다시 고정된다.
check('항상 위는 저장값을 따른다(못 박은 true 없음)', !/setAlwaysOnTop\(true/.test(main) && !/alwaysOnTop: true,\s*skipTaskbar/.test(main)
  && /alwaysOnTop: store\.get\('alwaysOnTop'\) !== false,/.test(main)
  && /function applyOnTop\(\) \{\s*if \(win\) win\.setAlwaysOnTop\(store\.get\('alwaysOnTop'\) !== false, 'screen-saver'\);/.test(main));
// 작업표시줄 버튼은 늘 둔다(2026-11-17 사용자 요청) — 예전에는 숨기고(skipTaskbar) 최소화한 동안만 보였다. 복원 때 다시 숨기던
// 처리가 남으면 최소화했다 되살린 뒤 버튼이 사라진다.
check('작업표시줄 버튼은 늘 있다', /\n {4}skipTaskbar: false,/.test(main) && !/setSkipTaskbar/.test(main));
check('저장 · 백업 불러오기 · 다시 보이기가 항상 위를 다시 적용한다', /if \('alwaysOnTop' in next\) applyOnTop\(\);/.test(main)
  && (main.match(/applyOnTop\(\);/g) || []).length >= 5, String((main.match(/applyOnTop\(\);/g) || []).length));

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
