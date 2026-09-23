// 저장 계약 가드 — 앱을 띄우지 않고 renderer.js 와 main.js 의 키 목록만 맞춰 본다.
//
// 세 경로를 검사한다.
// 1) renderer.js 의 save() 가 보내는 키를 main.js 의 state:set 허용목록이 받아주지
//    않으면 store.set 이 호출되지 않는다. 예외도 로그도 없이 그 설정만 저장되지
//    않고, 앱을 껐다 켜야만 드러난다.
// 2) save() 가 보내는 키를 main.js 의 state:get 이 돌려주지 않으면, 저장은 되지만
//    다음 실행에 읽히지 않는다 — state.xxx 가 undefined 라 초기화 기본값이 조용히
//    이긴다. 이것도 앱을 껐다 켜야만 드러난다.
// 새 설정을 추가할 때 세 곳 중 한쪽만 고치기 쉬워서 여기서 막는다.
import fs from 'node:fs';

const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// save() 가 api.setState 로 보내는 키
const saveStart = renderer.indexOf('const save = () => api.setState({');
const saveEnd = renderer.indexOf('});', saveStart);
check('renderer.js 에서 save() 를 찾았다', saveStart >= 0 && saveEnd > saveStart);

// main.js 의 허용목록 — [...].includes(k) 형태
const allowList = /\[([^\]]*)\]\.includes\(k\)/.exec(main);
check('main.js 에서 state:set 허용목록을 찾았다', !!allowList);

if (saveStart >= 0 && saveEnd > saveStart && allowList) {
  const sent = [...renderer.slice(saveStart, saveEnd).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const allowed = [...allowList[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);

  check('save() 가 보내는 키가 하나 이상이다', sent.length > 0, sent.join(' '));

  const missing = sent.filter((k) => !allowed.includes(k));
  check('save() 가 보내는 키를 main.js 가 전부 받는다', missing.length === 0,
    missing.length ? `허용목록에 없음: ${missing.join(' ')}` : `${sent.length}개 확인`);

  // 반대쪽도 본다. 허용목록에만 있는 키는 죽은 항목이다.
  const unsent = allowed.filter((k) => !sent.includes(k));
  check('허용목록에 보내지 않는 키가 없다', unsent.length === 0,
    unsent.length ? `save() 가 안 보냄: ${unsent.join(' ')}` : '');

  check('chartMode 가 양쪽에 있다',
    sent.includes('chartMode') && allowed.includes('chartMode'));

  // main.js 의 state:get — `ipcMain.handle('state:get', () => ({ key: store.get('key'), ... }))`
  const getStart = main.indexOf("ipcMain.handle('state:get'");
  const getEnd = main.indexOf('}));', getStart);
  check('main.js 에서 state:get 을 찾았다', getStart >= 0 && getEnd > getStart);

  if (getStart >= 0 && getEnd > getStart) {
    const returned = [...main.slice(getStart, getEnd).matchAll(/^\s{2}(\w+):\s*store\.get\(/gm)].map((m) => m[1]);

    check('state:get 이 돌려주는 키가 하나 이상이다', returned.length > 0, returned.join(' '));

    // save() 가 보내는데 state:get 이 안 돌려주는 키는 저장은 되지만 재실행 후
    // 다시 읽히지 않는다 — chartMode 가 실제로 겪은 버그.
    const unread = sent.filter((k) => !returned.includes(k));
    check('save() 가 보내는 키를 state:get 이 전부 돌려준다', unread.length === 0,
      unread.length ? `state:get 에 없음: ${unread.join(' ')}` : `${sent.length}개 확인`);
  }
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
