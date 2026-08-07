import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// 검색 / 추가 / 삭제 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
const launch = launchApp;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };

let app = await launch(); let page = await app.firstWindow();
const errs=[];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});

const names = () => page.evaluate(()=>[...document.querySelectorAll('#list .row .name')].map(e=>e.textContent));
const disk  = () => JSON.parse(fs.readFileSync(CFG,'utf8'));
const results = () => page.evaluate(()=>[...document.querySelectorAll('#results .hit')].map(e=>({
  text: e.innerText.replace(/\n/g,' '), dup: e.classList.contains('dup') })));
const type = async (t) => { await page.fill('#q', t); await page.waitForTimeout(900); };

console.log('초기 관심종목:', (await names()).join(', '));
await page.screenshot({ path: path.join(SHOTS,'40-header.png') });

// --- 검색 열기 ---
await page.click('#add');
await page.waitForTimeout(400);
check('검색 오버레이 열림', await page.evaluate(()=>!document.getElementById('search').hidden));
check('입력창 포커스', await page.evaluate(()=>document.activeElement.id==='q'));

// --- 한글 검색 (코스닥 종목 포함) ---
await type('에코프로');
const r1 = await results();
console.log('  "에코프로" 결과:', r1.map(r=>r.text).join(' | '));
check('한글 검색 결과 있음', r1.length > 0);
check('코스닥 종목 노출', r1.some(r=>r.text.includes('코스닥')), '');
await page.screenshot({ path: path.join(SHOTS,'41-search.png') });

// --- 코스닥 종목 추가 (.KQ 매핑 검증) ---
const before = (await names()).length;
await page.evaluate(()=>{
  const hit=[...document.querySelectorAll('#results .hit')].find(e=>e.innerText.includes('코스닥'));
  hit.click();
});
await page.waitForTimeout(5000);
const after = await names();
check('종목 추가됨', after.length === before + 1, after.join(', '));
check('검색창 자동 닫힘', await page.evaluate(()=>document.getElementById('search').hidden));
const d1 = disk();
const added = d1.watchlist[d1.watchlist.length-1];
console.log('  추가된 종목:', JSON.stringify(added));
check('코스닥 → .KQ 심볼', added.symbol.endsWith('.KQ'), added.symbol);
check('저장됨', d1.watchlist.length === before + 1);
check('추가 종목이 선택됨', await page.evaluate(()=>document.getElementById('dname').textContent) === added.name);
const dz = await page.evaluate(()=>{ const c=Chart.getChart(document.getElementById('chart')); return c?c.data.datasets[0].data.length:0; });
check('추가 종목 차트 로드', dz > 0, `${dz}포인트`);
check('추가 종목 시세 표시', await page.evaluate(()=>document.getElementById('dprice').textContent) !== '—');

// --- 중복 표시 ---
await page.click('#add'); await page.waitForTimeout(300);
await type('삼성전자');
const r2 = await results();
check('이미 있는 종목은 "추가됨" 비활성', r2.some(r=>r.dup && r.text.includes('추가됨')), r2[0]?.text);

// --- ESC 로 닫기 ---
await page.press('#q','Escape'); await page.waitForTimeout(300);
check('Esc 로 닫힘', await page.evaluate(()=>document.getElementById('search').hidden));

// --- 삭제: 선택 중이 아닌 종목 ---
const list1 = await names();
await page.evaluate(()=>document.querySelectorAll('#list .row')[1].querySelector('.del').click());
await page.waitForTimeout(2500);
const list2 = await names();
check('삭제됨', list2.length === list1.length-1 && !list2.includes(list1[1]), list2.join(', '));
check('삭제 저장됨', disk().watchlist.length === list2.length);

// --- 삭제: 현재 선택 중인 종목 ---
await page.evaluate(()=>document.querySelectorAll('#list .row')[0].click());
await page.waitForTimeout(2500);
const selName = await page.evaluate(()=>document.getElementById('dname').textContent);
await page.evaluate(()=>document.querySelectorAll('#list .row')[0].querySelector('.del').click());
await page.waitForTimeout(2500);
const afterSel = await page.evaluate(()=>document.getElementById('dname').textContent);
check('선택 종목 삭제 시 다른 종목으로 이동', afterSel !== selName && afterSel !== '—', `${selName} → ${afterSel}`);

// --- 재실행 후 유지 ---
const finalList = await names();
await app.close(); await new Promise(r=>setTimeout(r,1500));
app = await launch(); page = await app.firstWindow();
await page.waitForFunction(()=>/\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),{timeout:60000});
check('재실행 후 관심종목 유지', JSON.stringify(await names()) === JSON.stringify(finalList), (await names()).join(', '));

// --- 전부 삭제 → 빈 상태 ---
for (let i = (await names()).length; i > 0; i--) {
  await page.evaluate(()=>document.querySelectorAll('#list .row')[0].querySelector('.del').click());
  await page.waitForTimeout(900);
}
check('전부 삭제 시 빈 상태 안내', await page.evaluate(()=>!!document.querySelector('#list .empty')));
check('빈 상태에서 에러 없음', errs.length === 0, errs.slice(0,2).join(' / '));
await page.screenshot({ path: path.join(SHOTS,'42-empty.png') });

// --- 빈 상태에서 다시 추가 ---
await page.click('#add'); await page.waitForTimeout(300);
await type('005930');
const r3 = await results();
console.log('  "005930" 결과:', r3.map(r=>r.text).join(' | '));
check('코드로 검색됨', r3.length > 0);
await page.evaluate(()=>document.querySelector('#results .hit').click());
await page.waitForTimeout(5000);
check('빈 상태에서 추가 복구', (await names()).length === 1, (await names()).join(','));

console.log('\n콘솔 에러:', errs.length ? errs.join('\n') : '(없음)');
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
await app.close();
