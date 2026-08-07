import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// ③ 드래그로 관심종목 순서 변경 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
fs.writeFileSync(CFG,'{}');
const launch = launchApp;
const ready = waitReady;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };

let app = await launch(); let page = await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await ready(page); await page.waitForTimeout(1200);

const names = () => page.evaluate(()=>[...document.querySelectorAll('#list .row .name')].map(e=>e.textContent));
const disk  = () => JSON.parse(fs.readFileSync(CFG,'utf8')).watchlist.map(w=>w.name);
const selected = () => page.evaluate(()=>document.getElementById('dname').textContent);

// 실제 마우스 드래그 (Playwright 의 HTML5 DnD)
// HTML5 드래그는 합성 마우스 이벤트라 부하가 걸리면 간헐적으로 시작되지 않는다.
// 고정 대기 대신 순서가 실제로 바뀔 때까지 기다리고, 안 바뀌면 한 번 더 시도한다.
async function drag(fromIdx, toIdx) {
  const rows = page.locator('#list .row');
  const before = JSON.stringify(await names());

  const attempt = async () => {
    await rows.nth(fromIdx).dragTo(rows.nth(toIdx));
    if (fromIdx === toIdx) { await page.waitForTimeout(400); return true; }
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(150);
      if (JSON.stringify(await names()) !== before) return true;
    }
    return false;
  };

  if (!await attempt()) await attempt();
}

console.log('초기 순서:', (await names()).join(' > '));
check('draggable 속성 설정됨', await page.evaluate(()=>[...document.querySelectorAll('#list .row')].every(r=>r.draggable)));

// 1) 4번째(SK하이닉스)를 맨 위로
const before = await names();
await drag(3, 0);
const after1 = await names();
console.log('  3→0 드래그 후:', after1.join(' > '));
const expect1 = [before[3], before[0], before[1], before[2], before[4]];
check('맨 위로 이동', JSON.stringify(after1) === JSON.stringify(expect1), after1.join(','));
check('디스크에 저장됨', JSON.stringify(disk()) === JSON.stringify(after1), disk().join(','));

// 2) 맨 위를 맨 아래로
const before2 = await names();
await drag(0, 4);
const after2 = await names();
console.log('  0→4 드래그 후:', after2.join(' > '));
const expect2 = [before2[1], before2[2], before2[3], before2[4], before2[0]];
check('맨 아래로 이동', JSON.stringify(after2) === JSON.stringify(expect2), after2.join(','));

// 3) 드래그가 종목 선택으로 새지 않는지
const selBefore = await selected();
await drag(2, 1);
await page.waitForTimeout(1500);
const selAfter = await selected();
check('드래그가 종목 선택을 바꾸지 않음', selBefore === selAfter, `${selBefore} → ${selAfter}`);

// 4) 같은 자리에 드롭하면 변화 없음
const before4 = await names();
await drag(2, 2);
check('제자리 드롭은 무시', JSON.stringify(await names()) === JSON.stringify(before4));

// 5) 드래그 후 클릭 선택은 여전히 동작
await page.evaluate(()=>document.querySelectorAll('#list .row')[4].click());
await page.waitForTimeout(2500);
const n = await names();
check('드래그 후에도 클릭 선택 동작', await selected() === n[4], `${await selected()} vs ${n[4]}`);

// 6) 잔여 클래스 정리 확인
check('드래그 잔여 스타일 없음', await page.evaluate(()=>
  ![...document.querySelectorAll('#list .row')].some(r=>r.classList.contains('dragging')||r.classList.contains('dropto'))));

// 7) 재실행 후 순서 유지
const finalOrder = await names();
await app.close(); await new Promise(r=>setTimeout(r,1500));
app = await launch(); page = await app.firstWindow();
await ready(page); await page.waitForTimeout(1000);
check('재실행 후 순서 유지', JSON.stringify(await names()) === JSON.stringify(finalOrder), (await names()).join(','));

check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
fs.writeFileSync(CFG,'{}');
