// 한 번만 실행 — 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
//
// 위젯이 둘 뜨면 각자 관심종목 전체를 저장해 서로 덮어쓴다(한쪽에서 추가한 종목이 다른
// 쪽 저장에 사라진다). 네이버 요청도 두 배가 된다. 그래서 두 번째 실행은 창을 만들지 않고
// 끝나고, 이미 떠 있는 창이 숨었거나 최소화돼 있으면 앞으로 나온다.
// 실제 잠금(같은 userData 끼리만 걸린다)은 Electron 몫이라 여기서는 연결만 본다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// gotLock: 이 프로세스가 잠금을 얻었는가(= 첫 번째 실행인가), packaged: 설치본으로 실행했는가
async function launch(gotLock, packaged = false) {
  const log = [];
  const menus = [];
  const appEvents = {};
  let win = null;
  class FakeWindow {
    constructor() { win = this; this.visible = true; this.minimized = false; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { log.push('restore'); this.minimized = false; }
    show() { log.push('show'); this.visible = true; }
    focus() { log.push('focus'); }
    setAlwaysOnTop() {} setBounds() {} loadFile() {} on() {}
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => gotLock,
      quit: () => log.push('quit'),
      whenReady: () => Promise.resolve(),
      on: (e, fn) => { appEvents[e] = fn; },
      getPath: () => '',
      setAppUserModelId() {},
      isPackaged: packaged,
    },
    Menu: { setApplicationMenu: (m) => menus.push(m) },
    BrowserWindow: FakeWindow,
    ipcMain: { handle() {}, on() {} },
    globalShortcut: { register: () => true },
    screen: {}, Notification: {},
  };
  const modules = {
    electron,
    'electron-store': class { constructor(o) { this.d = structuredClone(o.defaults); } get(k) { return this.d[k]; } set(k, v) { this.d[k] = v; } },
    path,
    './quote-session.cjs': createRequire(import.meta.url)('../quote-session.cjs'),
  };
  const require = (m) => {
    if (!(m in modules)) throw new Error(`main.js 가 예상하지 못한 모듈을 부른다: ${m}`);
    return modules[m];
  };
  new Function('require', 'process', 'fetch', 'AbortSignal', '__dirname', src)(
    require, { env: {}, platform: 'test' }, () => Promise.reject(new Error('네트워크 없음')), AbortSignal, ROOT);
  await new Promise((r) => setImmediate(r)); // whenReady().then(...) 가 돌 때까지
  return { log, appEvents, menus, get win() { return win; } };
}

{
  const second = await launch(false);
  check('두 번째 실행은 창을 만들지 않는다', second.win === null);
  check('두 번째 실행은 바로 끝난다', second.log.includes('quit'), second.log.join(','));
}
{
  const first = await launch(true);
  check('첫 번째 실행은 창을 만든다', first.win !== null);
  check('첫 번째 실행은 끝나지 않는다', !first.log.includes('quit'), first.log.join(','));
  check('다른 실행이 들어오는 것을 기다린다', typeof first.appEvents['second-instance'] === 'function');

  // 숨겼거나(Ctrl+Alt+S) 최소화해 둔 채로 바탕화면 아이콘을 또 눌렀다
  first.win.visible = false;
  first.win.minimized = true;
  first.appEvents['second-instance']?.();
  check('떠 있는 창을 되살린다', first.win.visible === true && first.win.minimized === false,
    `visible=${first.win.visible} minimized=${first.win.minimized}`);
  check('앞으로 가져온다', first.log.includes('focus'), first.log.join(','));
}

// 설치본에서는 Electron 기본 메뉴를 없앤다. 테두리 없는 창이라 메뉴줄은 안 보여도 단축키는 살아
// 있어서, 위젯을 누른 채 Ctrl+W 면 앱이 꺼지고(목표가 알림도 끊긴다) Ctrl+M 은 작업표시줄 버튼
// 없는 창을 최소화해 숨기고 Ctrl+R 은 화면을 새로 띄워 접힌 상태를 어긋나게 한다.
// 개발 실행(npm start)은 새로고침 · 개발자 도구 단축키를 쓰도록 그대로 둔다.
{
  const installed = await launch(true, true);
  check('설치본은 기본 메뉴(와 그 단축키)를 없앤다', installed.menus.length === 1 && installed.menus[0] === null,
    JSON.stringify(installed.menus));
  const dev = await launch(true, false);
  check('개발 실행은 기본 메뉴를 그대로 둔다', dev.menus.length === 0, JSON.stringify(dev.menus));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
