// 테스트 공용 경로 및 헬퍼.
// 모든 스위트가 실제 앱을 Electron 으로 띄워 검증하므로 순차 실행해야 한다
// (설정 파일을 공유하고 창이 겹친다).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS_DIR = path.join(APP_DIR, 'tests', '.shots');

// electron-store 저장 위치 (package.json 의 name 기준)
export const CFG_PATH = path.join(
  process.env.APPDATA || path.join(process.env.HOME || '', '.config'),
  'kr-stock-widget',
  'config.json',
);

const ELECTRON_BIN = path.join(
  APP_DIR,
  'node_modules/electron/dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

fs.mkdirSync(SHOTS_DIR, { recursive: true });

export const launchApp = () => electron.launch({
  executablePath: ELECTRON_BIN,
  args: [APP_DIR],
  timeout: 40000,
});

// 첫 시세 갱신이 끝나 헤더에 시각이 찍힐 때까지 대기
export const waitReady = (page) => page.waitForFunction(
  () => /\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),
  { timeout: 60000 },
);

export const resetConfig = () => fs.writeFileSync(CFG_PATH, '{}');
export const readConfig = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
