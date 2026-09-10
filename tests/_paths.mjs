// 테스트 공용 경로 및 헬퍼.
// 모든 스위트가 실제 앱을 Electron 으로 띄워 검증하므로 순차 실행해야 한다
// (설정 파일을 공유하고 창이 겹친다).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS_DIR = path.join(APP_DIR, 'tests', '.shots');

// 테스트 전용 Electron 프로필. --user-data-dir 로 물려 실제 설정을 건드리지 않는다.
// 예전에는 실제 프로필을 그대로 썼고, run.mjs 가 매 스위트 전에 resetConfig() 로
// '{}' 를 쓰기 때문에 npm test 한 번에 사용자의 관심종목·보유·알림이 날아갔다.
//
// 프로필이 둘이라는 점을 조심해야 한다 — 개발 실행은 package.json 의 name
// (kr-stock-widget), 설치본은 productName (관심종목 위젯) 아래에 쓴다.
// packaged.mjs 가 설치본을 띄우므로 그쪽에도 같은 스위치를 넘겨야 한다.
//
// 경로는 고정이다. 스위트마다 프로세스가 새로 뜨고, 한 스위트 안에서 앱을 두 번
// 띄워 "재실행 후 유지"를 확인하므로 실행 사이에 남아 있어야 한다.
export const USER_DATA_DIR = path.join(os.tmpdir(), 'kr-stock-widget-tests');

// electron-store 는 app.getPath('userData') 아래 config.json 에 쓴다.
// --user-data-dir 를 주면 userData 가 그 경로 자체가 된다.
export const CFG_PATH = path.join(USER_DATA_DIR, 'config.json');

const ELECTRON_BIN = path.join(
  APP_DIR,
  'node_modules/electron/dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

// 스위치가 앱 경로보다 앞에 와야 한다. `electron <앱경로> --user-data-dir=X` 로
// 두면 스위치가 앱에 전달되는 인자로 취급되어 Electron 이 무시한다 — 실제로 그렇게
// 두었다가 앱이 실제 프로필(kr-stock-widget)에 585바이트를 쓰는 것을 확인했다.
// 설치본을 직접 띄우는 packaged.mjs 도 이 스위치를 써야 한다(tests/isolation.mjs).
export const LAUNCH_ARGS = [`--user-data-dir=${USER_DATA_DIR}`, APP_DIR];

// --user-data-dir 만으로는 설정 파일이 안 옮겨간다. main.js 가 electron-store 의
// cwd 를 app.getPath('appData') 기준으로 고정해 두었고(설치본이 기존 설정을 잃지
// 않도록 일부러 그렇게 둔 것) appData 는 그 스위치의 영향을 받지 않는다. 실제로
// 스위치만 준 채 돌렸더니 실제 프로필에 583바이트가 써졌다. 설정 경로는 이
// 환경변수로 따로 돌린다.
export const CFG_ENV = 'KR_STOCK_WIDGET_CONFIG_DIR';
export const LAUNCH_ENV = { ...process.env, [CFG_ENV]: USER_DATA_DIR };

// 상류 실패와 장 상태를 만들어내는 훅. 예전에는 스위트가 main.js 를 디스크에서
// 치환해 이 동작을 흉내 냈는데, 프로세스가 죽으면 소스가 패치된 채로 남았다.
export const FAIL_URLS_ENV = 'KR_STOCK_WIDGET_FAIL_URLS';
export const SESSION_ENV = 'KR_STOCK_WIDGET_FORCE_SESSION';

// extraEnv 로 위 훅을 얹는다. 인자가 없으면 지금까지와 동작이 같다.
export const launchApp = (extraEnv = {}) => electron.launch({
  executablePath: ELECTRON_BIN,
  args: LAUNCH_ARGS,
  env: { ...LAUNCH_ENV, ...extraEnv },
  timeout: 40000,
});

// 첫 시세 갱신이 끝나 헤더에 시각이 찍힐 때까지 대기
export const waitReady = (page) => page.waitForFunction(
  () => /\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),
  { timeout: 60000 },
);

export const resetConfig = () => fs.writeFileSync(CFG_PATH, '{}');
export const readConfig = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
