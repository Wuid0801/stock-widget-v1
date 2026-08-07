import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// 완료 기준 4: 창을 옮기고 크기 바꾼 뒤 재실행하면 그 상태로 복원되는가.
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP = APP_DIR;
const BIN = path.join(APP, 'node_modules/electron/dist/electron.exe');
const SHOTS = SHOTS_DIR;
const launch = launchApp;
const ready = waitReady;
const snapshot = async (app, page) => ({
  bounds: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
  ...(await page.evaluate(() => ({
    selected: document.querySelector('#list .row.on')?.querySelector('.name').textContent,
    tf: [...document.querySelectorAll('#tf button')].find(b => b.classList.contains('on')).textContent,
    detail: document.getElementById('dname').textContent,
  }))),
});

// --- 1회차: 사용자가 창을 옮기고 크기 조절하고 종목/타임프레임 선택 ---
let app = await launch();
let page = await app.firstWindow();
await ready(page);

await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].setBounds({ x: 640, y: 210, width: 430, height: 640 }));
await page.evaluate(() => document.querySelectorAll('#list .row')[3].click());   // SK하이닉스
await page.evaluate(() => [...document.querySelectorAll('#tf button')].find(b => b.textContent === '1M').click());
await page.waitForTimeout(3000);

const before = await snapshot(app, page);
console.log('1회차 종료 직전:', JSON.stringify(before));
await app.close();
await new Promise(r => setTimeout(r, 1500));

console.log('디스크 저장값 :', fs.readFileSync(CFG_PATH, 'utf8')
  .replace(/\s+/g, ' ').replace(/"watchlist".*?\],/, '"watchlist":[...5종목],'));

// --- 2회차: 재실행 후 복원 확인 ---
app = await launch();
page = await app.firstWindow();
await ready(page);
await page.waitForTimeout(1500);
const after = await snapshot(app, page);
console.log('2회차 재실행 후:', JSON.stringify(after));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const okBounds = same(before.bounds, after.bounds);
const okSel = before.selected === after.selected && before.detail === after.detail;
const okTf = before.tf === after.tf;

console.log(`\n창 위치/크기 복원: ${okBounds ? 'OK' : 'FAIL'}  (${JSON.stringify(after.bounds)})`);
console.log(`선택 종목 복원   : ${okSel ? 'OK' : 'FAIL'}  (${after.detail})`);
console.log(`타임프레임 복원  : ${okTf ? 'OK' : 'FAIL'}  (${after.tf})`);

await page.screenshot({ path: path.join(SHOTS, '10-restored.png') });
// 마우스를 올린 상태(불투명)도 한 장
await page.evaluate(() => document.querySelector('.widget').style.opacity = '1');
await page.screenshot({ path: path.join(SHOTS, '11-restored-hover.png') });

console.log(`\n${okBounds && okSel && okTf ? 'PASS' : 'FAIL'}`);
await app.close();
