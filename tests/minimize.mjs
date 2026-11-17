import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
const APP = APP_DIR;
const SHOTS = SHOTS_DIR;
const app = await launchApp();
const page = await app.firstWindow();
page.on('pageerror', e => console.log('[PAGEERROR]', e.message));
await page.waitForFunction(() => /\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent), { timeout: 60000 });

// 'restore' 이벤트가 실제로 발생하는지 감시
await app.evaluate(({BrowserWindow}) => {
  const w = BrowserWindow.getAllWindows()[0];
  global.__restored = 0;
  w.on('restore', () => global.__restored++);
});

const state = () => app.evaluate(({BrowserWindow}) => {
  const w = BrowserWindow.getAllWindows()[0];
  return { minimized: w.isMinimized(), onTop: w.isAlwaysOnTop(), bounds: w.getBounds(), visible: w.isVisible() };
});

let fails = 0;
const check = (tag, cond, extra='') => { if(!cond) fails++; console.log(`${cond?'OK  ':'FAIL'} ${tag}${extra?'  '+extra:''}`); };

const before = await state();
console.log('초기:', JSON.stringify(before));
await page.screenshot({ path: path.join(SHOTS, '20-buttons.png') });

// 버튼 존재 확인
const btns = await page.evaluate(() => [...document.querySelectorAll('.bar button')].map(b => ({ id:b.id, t:b.textContent, title:b.title,
  region: getComputedStyle(b).webkitAppRegion })));
console.log('버튼:', JSON.stringify(btns));
check('최소화 버튼 존재', btns.some(b => b.id === 'min'));
// 버튼은 드래그 영역 밖에 있어야 한다. 예전에는 드래그 영역 안에 no-drag 로 박아뒀는데,
// 그 중첩이 투명 창 깜빡임의 원인이라 형제로 분리했다(이제 'none').
check('버튼이 드래그 영역이 아님', btns.every((b) => b.region !== 'drag'), JSON.stringify(btns.map((b) => b.region)));

// 최소화 클릭
await page.evaluate(() => document.getElementById('min').click());
await page.waitForTimeout(1500);
const mini = await state();
check('클릭 후 최소화됨', mini.minimized === true, JSON.stringify(mini));

// 복원
await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].restore());
await page.waitForTimeout(1500);
const back = await state();
const restored = await app.evaluate(() => global.__restored);
check('복원됨', back.minimized === false);
check("'restore' 이벤트 발생", restored >= 1, `${restored}회`);
check('복원 후에도 항상 위', back.onTop === true);
check('복원 후 위치/크기 유지', JSON.stringify(back.bounds) === JSON.stringify(before.bounds), JSON.stringify(back.bounds));

// 두 번째 최소화도 되는지
await page.evaluate(() => document.getElementById('min').click());
await page.waitForTimeout(1200);
check('두 번째 최소화도 동작', (await state()).minimized === true);
await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].restore());
await page.waitForTimeout(1200);
check('두 번째 복원도 동작', (await state()).minimized === false);

// 데이터가 계속 살아있는지 (폴링 유지)
const alive = await page.evaluate(() => document.getElementById('dprice').textContent);
check('복원 후 데이터 유지', alive !== '—', alive);
await page.screenshot({ path: path.join(SHOTS, '21-after-restore.png') });

console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
