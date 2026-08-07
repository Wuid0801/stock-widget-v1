import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
const launch = launchApp;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };

let app = await launch(); let page = await app.firstWindow();
page.on('pageerror', e => console.log('[PAGEERROR]', e.message));
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});

const win = () => app.evaluate(({BrowserWindow, screen}) => {
  const w = BrowserWindow.getAllWindows()[0]; const b = w.getBounds();
  return { bounds: b, workArea: screen.getDisplayMatching(b).workArea, onTop: w.isAlwaysOnTop() };
});
const dom = () => page.evaluate(() => {
  const rows=[...document.querySelectorAll('#list .row')];
  const list=document.getElementById('list');
  const c=Chart.getChart(document.getElementById('chart'));
  return {
    compact: document.querySelector('.widget').classList.contains('compact'),
    btnOn: document.getElementById('dock').classList.contains('on'),
    btnTitle: document.getElementById('dock').title,
    detailVisible: getComputedStyle(document.querySelector('.detail')).display !== 'none',
    rowH: rows[0]?.offsetHeight, listH: list.clientHeight, listScroll: list.scrollHeight,
    barH: document.querySelector('.bar').offsetHeight,
    ixH: document.getElementById('indices').hidden ? 0 : document.getElementById('indices').offsetHeight,
    chartPts: c ? c.data.datasets[0].data.length : 0,
    dockGlyph: document.getElementById('dock').textContent,
  };
});

const b0 = await win(); const d0 = await dom();
console.log('펼친 상태:', JSON.stringify(b0.bounds), '작업영역:', JSON.stringify(b0.workArea));
console.log('버튼 글리프:', JSON.stringify(d0.dockGlyph), '행높이:', d0.rowH, '바높이:', d0.barH);

// --- 접기 ---
await page.evaluate(()=>document.getElementById('dock').click());
await page.waitForTimeout(1200);
const b1 = await win(); const d1 = await dom();
console.log('\n접은 상태:', JSON.stringify(b1.bounds));
check('차트/상세 숨김', d1.detailVisible === false);
check('버튼 활성 표시', d1.btnOn === true, d1.btnTitle);
check('폭 유지(±2)', Math.abs(b1.bounds.width-b0.bounds.width)<=2, `${b1.bounds.width} vs ${b0.bounds.width}`);
const expectH = d0.barH + d0.ixH + d0.rowH*3 + 2;
check('높이 = 바 + 지수 + 3행', Math.abs(b1.bounds.height - expectH) <= 2, `실제 ${b1.bounds.height} 기대 ${expectH}`);
check('정확히 3행 보임', Math.floor(d1.listH / d1.rowH) === 3, `목록높이 ${d1.listH} / 행 ${d1.rowH}`);
check('나머지는 스크롤로 접근', d1.listScroll > d1.listH, `전체 ${d1.listScroll}`);
const M=12, wa=b1.workArea;
check('우하단 정렬 (작업표시줄 회피)',
  Math.abs((b1.bounds.x+b1.bounds.width)-(wa.x+wa.width-M))<=2 && Math.abs((b1.bounds.y+b1.bounds.height)-(wa.y+wa.height-M))<=2,
  `우=${b1.bounds.x+b1.bounds.width} 기대=${wa.x+wa.width-M}, 하=${b1.bounds.y+b1.bounds.height} 기대=${wa.y+wa.height-M}`);
check('접어도 항상 위 유지', b1.onTop === true);
const diskWhileCompact = JSON.parse(fs.readFileSync(CFG,'utf8')).bounds;
check('접힌 크기는 저장 안 됨(±2)', Math.abs(diskWhileCompact.height-b0.bounds.height)<=2, JSON.stringify(diskWhileCompact)+' vs '+b0.bounds.height);
await page.screenshot({ path: path.join(SHOTS,'30-docked.png') });

// --- 펴기 ---
await page.evaluate(()=>document.getElementById('dock').click());
await page.waitForTimeout(1500);
const b2 = await win(); const d2 = await dom();
console.log('\n다시 편 상태:', JSON.stringify(b2.bounds));
check('원래 위치/크기 복원(±2)', ['x','y','width','height'].every(k=>Math.abs(b2.bounds[k]-b0.bounds[k])<=2), JSON.stringify(b2.bounds));
check('차트/상세 다시 보임', d2.detailVisible === true);
check('버튼 비활성 표시', d2.btnOn === false, d2.btnTitle);
check('차트 살아있음', d2.chartPts > 0, `${d2.chartPts}포인트`);
await page.screenshot({ path: path.join(SHOTS,'31-expanded.png') });

// --- 접은 채로 종료 후 재실행 ---
await page.evaluate(()=>document.getElementById('dock').click());
await page.waitForTimeout(1200);
await app.close(); await new Promise(r=>setTimeout(r,1500));
app = await launch(); page = await app.firstWindow();
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});
const b3 = await win(); const d3 = await dom();
check('접은 채 종료 → 재실행 시 펼쳐진 원래 크기(±2)', ['x','y','width','height'].every(k=>Math.abs(b3.bounds[k]-b0.bounds[k])<=2), JSON.stringify(b3.bounds));
check('재실행 시 차트 보임', d3.detailVisible === true);

console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
