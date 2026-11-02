// main.js 를 앱을 띄우지 않고 불러 IPC 처리기를 꺼낸다 — 앱을 띄우지 않는 스위트가 함께 쓴다. 예전에는 스위트마다 가짜 electron ·
// require 를 복사해 두어, main.js 가 Electron 기능을 하나 더 쓰면 모두 고쳐야 했다(2026-11-02 net 을 세 곳에 따로 넣었다).
//
//  - globals: main.js 의 전역 중 바꿔 끼울 것 — { fetch, AbortSignal, Date }. 넘기지 않은 것은 진짜를 쓴다.
//  - electron: 가짜 electron 에 더하거나 바꿀 것(dialog · app 등). net.fetch(FRED)는 따로 주지 않으면 globals.fetch 를 따른다.
//  - store: electron-store 대신 쓸 클래스. 기본은 아무것도 기억하지 않는다.
//  - platform: process.platform 자리.
// 창은 만들지 않는다(whenReady 가 끝나지 않는다). main.js 가 여기 없는 모듈을 부르면 바로 실패한다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const quoteSession = createRequire(import.meta.url)('../quote-session.cjs');

export function loadMain({ globals = {}, electron = {}, store = class { get() {} set() {} }, platform = 'test' } = {}) {
  const handlers = {};
  const fake = {
    app: { getPath: () => '', whenReady: () => new Promise(() => {}), on() {}, requestSingleInstanceLock: () => true },
    BrowserWindow: class {}, screen: {}, globalShortcut: {}, Notification: {},
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
    net: { fetch: globals.fetch || fetch },
    ...electron,
  };
  const modules = { electron: fake, 'electron-store': store, fs, path, './quote-session.cjs': quoteSession };
  const require = (m) => {
    if (!(m in modules)) throw new Error(`main.js 가 예상하지 못한 모듈을 부른다: ${m}`);
    return modules[m];
  };
  const names = Object.keys(globals);
  new Function('require', 'process', ...names, src)(require, { env: {}, platform }, ...names.map((k) => globals[k]));
  return handlers;
}
