import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// 접힌 상태에서 검색 진입 → 닫으면 다시 접힌 상태로 복귀하는지 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
fs.writeFileSync(CFG,'{}');
const app = await launchApp();
const page = await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});

let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };
const bounds = () => app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
const st = () => page.evaluate(()=>({
  compact: document.querySelector('.widget').classList.contains('compact'),
  dockOn: document.getElementById('dock').classList.contains('on'),
  dockTitle: document.getElementById('dock').title,
  searchOpen: !document.getElementById('search').hidden,
  detailVisible: getComputedStyle(document.querySelector('.detail')).display !== 'none',
  rows: document.querySelectorAll('#list .row').length,
}));
const near = (a,b,t=3)=>['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<=t);

const expanded = await bounds();
console.log('펼친 상태:', JSON.stringify(expanded));

// 1) 접기
await page.click('#dock'); await page.waitForTimeout(1000);
const docked = await bounds(); const s1 = await st();
console.log('접은 상태:', JSON.stringify(docked));
check('접힘', s1.compact && s1.dockOn && !s1.detailVisible);

// 2) 접힌 상태에서 검색 열기 → 자동으로 펼쳐져야 함
await page.click('#add'); await page.waitForTimeout(1200);
const s2 = await st(); const b2 = await bounds();
check('검색 열림', s2.searchOpen);
check('검색 위해 자동으로 펼쳐짐', !s2.compact, JSON.stringify(b2));
check('펼친 크기가 접기 전과 동일', near(b2, expanded), JSON.stringify(b2));
check('접기 버튼 비활성 표시', !s2.dockOn && s2.dockTitle === '우하단으로 접기');

// 3) Esc 로 닫으면 다시 접혀야 함
await page.press('#q','Escape'); await page.waitForTimeout(1200);
const s3 = await st(); const b3 = await bounds();
check('검색 닫힘', !s3.searchOpen);
check('다시 접힌 상태로 복귀', s3.compact && s3.dockOn, JSON.stringify(b3));
check('접힌 크기/위치가 아까와 동일', near(b3, docked), `${JSON.stringify(b3)} vs ${JSON.stringify(docked)}`);

// 4) ✕ 버튼으로 닫아도 동일
await page.click('#add'); await page.waitForTimeout(1000);
await page.click('#qclose'); await page.waitForTimeout(1200);
const s4 = await st(); const b4 = await bounds();
check('✕ 로 닫아도 접힌 상태 복귀', s4.compact && !s4.searchOpen && near(b4, docked), JSON.stringify(b4));

// 5) 접힌 상태에서 검색 → 종목 추가 → 추가 후에도 접힌 상태로 복귀
const before = (await st()).rows;
await page.click('#add'); await page.waitForTimeout(1000);
await page.fill('#q','카카오'); await page.waitForTimeout(1300);
await page.evaluate(()=>document.querySelector('#results .hit:not(.dup)').click());
await page.waitForTimeout(5000);
const s5 = await st(); const b5 = await bounds();
check('종목 추가됨', s5.rows === before + 1, `${before} → ${s5.rows}`);
check('추가 후에도 접힌 상태 복귀', s5.compact && !s5.searchOpen, JSON.stringify(b5));
check('추가 후 접힌 크기 동일', near(b5, docked), `${JSON.stringify(b5)} vs ${JSON.stringify(docked)}`);

// 6) 접힌 상태에서 검색 중 ◲ 직접 누르면 검색만 닫히고 펼쳐진 채 유지
await page.click('#add'); await page.waitForTimeout(1000);
check('검색용 자동 펼침 상태', !(await st()).compact);
await page.click('#dock'); await page.waitForTimeout(1200);
const s6 = await st(); const b6 = await bounds();
check('◲ 직접 클릭 시 검색 닫히고 접힘(이중 토글 없음)', s6.compact && !s6.searchOpen, JSON.stringify(b6));
check('그때도 접힌 크기 정상', near(b6, docked), `${JSON.stringify(b6)} vs ${JSON.stringify(docked)}`);

// 7) 마지막으로 펴서 원래대로 돌아오는지
await page.click('#dock'); await page.waitForTimeout(1200);
const s7 = await st(); const b7 = await bounds();
check('최종 펼침 복원', !s7.compact && s7.detailVisible && near(b7, expanded), JSON.stringify(b7));

check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
fs.writeFileSync(CFG,'{}');
