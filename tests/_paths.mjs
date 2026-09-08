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

// 설치본을 직접 띄우는 packaged.mjs 도 이 스위치를 써야 한다(tests/isolation.mjs).
export const LAUNCH_ARGS = [APP_DIR, `--user-data-dir=${USER_DATA_DIR}`];

export const launchApp = () => electron.launch({
  executablePath: ELECTRON_BIN,
  args: LAUNCH_ARGS,
  timeout: 40000,
});

// 첫 시세 갱신이 끝나 헤더에 시각이 찍힐 때까지 대기
export const waitReady = (page) => page.waitForFunction(
  () => /\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),
  { timeout: 60000 },
);

export const resetConfig = () => fs.writeFileSync(CFG_PATH, '{}');
export const readConfig = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
