// 앱 시작 — 한 번만 실행 · 기본 메뉴 · 창 위치. 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
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
// env: 저장된 창 위치(bounds), 지금 연결된 모니터들(displays — 각자 workArea),
//      설정 파일이 깨져 첫 읽기가 실패하는가(brokenConfig)
async function launch(gotLock, packaged = false, env = {}) {
  const log = [];
  const menus = [];
  const stores = []; // Store 를 만들 때 넘긴 옵션
  const renames = [];
  const notes = [];
  const appEvents = {};
  const ipc = {};
  let displays = env.displays || [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  let win = null;
  let permission = null; // 권한 요청 처리기(카메라 · 알림 등) — 이 앱은 하나도 쓰지 않는다
  class FakeWindow {
    constructor(o) {
      if (env.windowFails) throw new Error('창을 만들지 못함');
      win = this; this.visible = true; this.minimized = false;
      this.wcEvents = {};
      this.webContents = {
        setWindowOpenHandler() {}, on: (e, fn) => { this.wcEvents[e] = fn; }, reload: () => log.push('reload'),
      };
      this.opts = o; this.sets = []; this.minSize = null;
      this.bounds = { x: o.x ?? 790, y: o.y ?? 280, width: o.width, height: o.height }; // x/y 가 없으면 OS 가 가운데에 놓는다
    }
    setBounds(b) { this.sets.push(b); this.bounds = { ...this.bounds, ...b }; }
    getBounds() { return { ...this.bounds }; }
    setMinimumSize(w, h) { this.minSize = [w, h]; } isDestroyed() { return false; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { log.push('restore'); this.minimized = false; }
    show() { log.push('show'); this.visible = true; }
    focus() { log.push('focus'); }
    setAlwaysOnTop() {} loadFile() {} on() {}
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
    dialog: { showErrorBox: (title) => log.push(`errorbox:${title}`) },
    session: { defaultSession: { setPermissionRequestHandler: (fn) => { permission = fn; } } },
    BrowserWindow: FakeWindow,
    ipcMain: { handle() {}, on: (ch, fn) => { ipc[ch] = fn; } },
    globalShortcut: { register: () => true },
    screen: {
      getAllDisplays: () => displays,
      // 가장 많이 겹치는 모니터, 하나도 안 겹치면 첫 모니터(Electron 은 가장 가까운 모니터를 준다)
      getDisplayMatching: (r) => displays.map((d) => {
        const a = d.workArea;
        const w = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x);
        const h = Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y);
        return { d, area: Math.max(0, w) * Math.max(0, h) };
      }).sort((p, q) => q.area - p.area)[0].d,
    },
    Notification: class {
      static isSupported() { return true; }
      constructor(o) { notes.push(o); }
      show() {}
    },
  };
  const modules = {
    electron,
    'electron-store': class {
      constructor(o) {
        stores.push(o);
        // conf 는 읽지 못한 JSON 을 SyntaxError 로 그대로 던진다(clearInvalidConfig 기본 false)
        if (env.brokenConfig && stores.length === 1) throw new SyntaxError('Unexpected token } in JSON at position 31');
        this.d = structuredClone(o.defaults);
        if ('bounds' in env) this.d.bounds = env.bounds; // null 도 그대로(손으로 고친 설정)
      }
      get(k) { return this.d[k]; } set(k, v) { this.d[k] = v; }
    },
    path,
    fs: { renameSync: (from, to) => renames.push([from, to]) },
    './quote-session.cjs': createRequire(import.meta.url)('../quote-session.cjs'),
  };
  const require = (m) => {
    if (!(m in modules)) throw new Error(`main.js 가 예상하지 못한 모듈을 부른다: ${m}`);
    return modules[m];
  };
  new Function('require', 'process', 'fetch', 'AbortSignal', '__dirname', src)(
    require, { env: {}, platform: 'test' }, () => Promise.reject(new Error('네트워크 없음')), AbortSignal, ROOT);
  await new Promise((r) => setImmediate(r)); // whenReady().then(...) 가 돌 때까지
  return { log, appEvents, menus, ipc, stores, renames, notes, get win() { return win; }, get permission() { return permission; },
    setDisplays(d) { displays = d; } };
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
// 있어서, 위젯을 누른 채 Ctrl+W 면 앱이 꺼지고(목표가 알림도 끊긴다) Ctrl+M 은 창을
// 최소화하고 Ctrl+R 은 화면을 새로 띄워 접힌 상태를 어긋나게 한다.
// 개발 실행(npm start)은 새로고침 · 개발자 도구 단축키를 쓰도록 그대로 둔다.
{
  const installed = await launch(true, true);
  check('설치본은 기본 메뉴(와 그 단축키)를 없앤다', installed.menus.length === 1 && installed.menus[0] === null,
    JSON.stringify(installed.menus));
  const dev = await launch(true, false);
  check('개발 실행은 기본 메뉴를 그대로 둔다', dev.menus.length === 0, JSON.stringify(dev.menus));
}

// 창 위치 — 외부 모니터에 둔 채 끄고 그 모니터 없이 켜면 저장된 위치가 화면 밖이다. Windows 는
// 그 창을 화면 안으로 옮겨 주지 않아 되살릴 길이 마땅치 않다. 위쪽 끌기 막대를 잡을 수 있을
// 만큼(가로 40px · 세로 20px) 어느 모니터 작업 영역에 걸쳐 있으면 그대로 두고, 아니면 위치는
// 버리고 크기만 쓴다 — 첫 실행처럼 OS 가 가운데에 놓는다.
const MAIN = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const RIGHT = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };
const LEFT = { workArea: { x: -1500, y: 0, width: 1500, height: 860 } };
const placed = async (bounds, displays = [MAIN]) => {
  const w = (await launch(true, false, { bounds, displays })).win;
  return { ctor: [w.opts.x, w.opts.y, w.opts.width, w.opts.height], set: w.sets.find((b) => 'x' in b) || null };
};
{
  const gone = await placed({ x: 2200, y: 300, width: 340, height: 520 });
  check('떼어 낸 오른쪽 모니터에 저장된 위치는 버리고 크기만 쓴다',
    gone.ctor[0] === undefined && gone.ctor[1] === undefined && gone.ctor[2] === 340 && gone.ctor[3] === 520 && gone.set === null,
    JSON.stringify(gone));
  const here = await placed({ x: 1500, y: 400, width: 340, height: 520 });
  check('화면 안의 위치는 그대로 되살린다', here.ctor[0] === 1500 && here.set && here.set.x === 1500 && here.set.y === 400,
    JSON.stringify(here));
  const left = await placed({ x: -1200, y: 100, width: 340, height: 520 }, [MAIN, LEFT]);
  check('왼쪽 모니터가 붙어 있으면 음수 좌표도 그대로', left.set && left.set.x === -1200, JSON.stringify(left));

  // 경계: 막대가 가로 40px 보이면 둔다(1880 → 1920-1880=40), 39px 면 버린다
  const x40 = await placed({ x: 1880, y: 400, width: 340, height: 520 });
  const x39 = await placed({ x: 1881, y: 400, width: 340, height: 520 });
  check('가로로 40px 걸치면 두고 39px 면 버린다', x40.set && x40.set.x === 1880 && x39.set === null,
    `40px ${JSON.stringify(x40.set)} · 39px ${JSON.stringify(x39.set)}`);
  // 위쪽: 막대(30px)가 화면 위로 10px 나가 20px 보이면 둔다, 11px 나가면 버린다
  const y20 = await placed({ x: 500, y: -10, width: 340, height: 520 });
  const y19 = await placed({ x: 500, y: -11, width: 340, height: 520 });
  check('끌기 막대가 세로 20px 보이면 두고 19px 면 버린다', y20.set && y20.set.y === -10 && y19.set === null,
    `20px ${JSON.stringify(y20.set)} · 19px ${JSON.stringify(y19.set)}`);
}
// 접은 채(우하단) 외부 모니터를 떼면, 펼칠 자리(접기 직전 위치)가 사라진 화면을 가리킨다.
// 그때는 크기만 살려 지금 있는 화면의 오른쪽 아래에 편다(접기와 같은 12px 여백).
{
  const app = await launch(true, false, { bounds: { x: 2200, y: 300, width: 340, height: 520 }, displays: [MAIN, RIGHT] });
  const dock = app.ipc['win:dock'];
  dock(null, true, 200);
  dock(null, false);
  const back = app.win.sets.at(-1);
  check('모니터가 그대로면 접기 직전 자리로 편다', back.x === 2200 && back.y === 300 && back.height === 520, JSON.stringify(back));

  dock(null, true, 200);
  app.setDisplays([MAIN]);
  app.win.bounds = { x: 1568, y: 828, width: 340, height: 200 }; // Windows 가 남은 화면으로 옮긴 접힌 창
  dock(null, false);
  const out = app.win.sets.at(-1);
  check('접은 채 모니터를 떼고 펴면 남은 화면 오른쪽 아래에 편다',
    out.x === 1920 - 340 - 12 && out.y === 1040 - 520 - 12 && out.width === 340 && out.height === 520, JSON.stringify(out));
}

// 화면(렌더러) 프로세스가 죽으면 창은 남는데 내용이 없고 ✕ 도 안 먹는다 — 테두리 없는 투명 창이라
// 빠져나오기 어렵다. 다시 띄운다. 다시 뜬 화면은 펼친 상태로 시작하므로 접혀 있었으면 창도 편다.
// 시작하자마자 또 죽으면 끝없이 다시 띄우게 되니 1분 안의 두 번째부터는 되풀이하지 않는다.
{
  const app = await launch(true, false, { bounds: { x: 100, y: 100, width: 340, height: 520 } });
  const gone = app.win.wcEvents['render-process-gone'];
  const reloads = () => app.log.filter((x) => x === 'reload').length;
  check('화면 프로세스가 죽는 것을 지켜본다', typeof gone === 'function');
  gone?.({}, { reason: 'clean-exit' });
  check('정상 종료는 다시 띄우지 않는다', reloads() === 0);
  app.ipc['win:dock'](null, true, 200); // 접힌 채로 죽는다
  gone?.({}, { reason: 'crashed' });
  check('죽으면 다시 띄운다', reloads() === 1, app.log.join(','));
  const b = app.win.sets.at(-1);
  check('접혀 있었으면 펴서 다시 띄운다', b.x === 100 && b.y === 100 && b.height === 520
    && app.win.minSize && app.win.minSize[1] === 380, `${JSON.stringify(b)} min ${JSON.stringify(app.win.minSize)}`);
  gone?.({}, { reason: 'oom' });
  check('1분 안에 또 죽으면 되풀이하지 않는다', reloads() === 1, app.log.join(','));
}

// 설정 파일이 깨지면(손으로 고치다 남긴 끝 쉼표, PowerShell 5.1 '{}' > 가 만든 UTF-16 등) Store 를
// 만드는 순간 SyntaxError 가 나서 창이 아예 안 떴다. 지우지 않고 이름을 바꿔 두고(평단가가 이 파일
// 에만 있다) 기본값으로 시작한 뒤, 무슨 일이 있었는지 알림으로 한 번 알린다.
{
  const broken = await launch(true, false, { brokenConfig: true });
  check('설정 파일이 깨져도 창이 뜬다', broken.win !== null && broken.stores.length === 2, `Store ${broken.stores.length}번`);
  const [from, to] = broken.renames[0] || [];
  check('깨진 파일은 지우지 않고 config.broken-<시각>.json 으로 옮겨 둔다', broken.renames.length === 1
    && path.basename(from) === 'config.json' && /^config\.broken-\d+\.json$/.test(path.basename(to || ''))
    && path.dirname(from) === path.dirname(to), JSON.stringify(broken.renames));
  check('옮겨 둔 파일 이름을 알림으로 알린다', broken.notes.length === 1 && broken.notes[0].body.includes(path.basename(to || '?')),
    JSON.stringify(broken.notes));
  const fine = await launch(true);
  check('멀쩡하면 옮기지도 알리지도 않는다', fine.renames.length === 0 && fine.notes.length === 0);
  // 메모장 · PowerShell 이 붙인 UTF-8 BOM 은 깨진 게 아니다 — 읽을 때 떼어 낸다
  const read = fine.stores[0].deserialize;
  check('BOM 이 붙은 설정도 그대로 읽는다', typeof read === 'function' && read('\uFEFF{"a":1}').a === 1 && read('{"a":2}').a === 2);
}

// 손으로 고친 설정 — bounds 가 null 이거나 크기가 없으면 예외로 창 없이 프로세스만 남았다. 단일 실행 잠금을 쥔 채라
// 다시 실행해도 뜨지 않았다(작업 관리자로 꺼야 했다).
{
  const nul = await launch(true, false, { bounds: null });
  check('bounds 가 null 이어도 기본 크기로 뜬다', nul.win && nul.win.opts.width === 340 && nul.win.opts.height === 520,
    JSON.stringify(nul.win && nul.win.opts));
  const noSize = await launch(true, false, { bounds: { x: 100, y: 100 } });
  const last = noSize.win && noSize.win.sets.at(-1);
  check('위치만 있고 크기가 없으면 기본 크기로 놓는다', last && last.width === 340 && last.height === 520, JSON.stringify(last));
  const broken = await launch(true, false, { windowFails: true });
  check('시작하다 실패하면 알리고 끝낸다(프로세스만 남아 잠금을 쥐지 않게)',
    broken.log.some((l) => l.startsWith('errorbox:')) && broken.log.includes('quit'), broken.log.join(','));
}

// 렌더러가 보내는 값의 모양을 믿지 않는다 — ipcMain.on 안의 예외는 메인 프로세스의 잡히지 않은 예외가 된다.
// 이 앱은 권한(카메라 · 마이크 · 위치 · 알림 등)이 필요한 웹 기능을 하나도 쓰지 않는다 — 요청은 모두 거절한다.
{
  const app = await launch(true);
  let threw = null;
  try { app.ipc.notify({}, null); } catch (e) { threw = e; }
  check('알림 요청의 값이 없어도 예외를 내지 않는다', threw === null, String(threw));
  const before = app.win.sets.length;
  for (const h of ['x', -5, NaN, 99999]) app.ipc['win:dock']({}, true, h);
  check('접기 높이가 숫자가 아니거나 터무니없으면 무시한다', app.win.sets.length === before, JSON.stringify(app.win.sets.slice(before)));
  let granted = null;
  app.permission?.({}, 'media', (ok) => { granted = ok; });
  check('웹 권한 요청은 모두 거절한다', typeof app.permission === 'function' && granted === false, String(granted));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
