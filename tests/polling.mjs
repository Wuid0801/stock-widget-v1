import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// ① 장 마감 시 폴링 간격 확대 검증
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';
const APP = APP_DIR;
const MAIN=path.join(APP,'main.js');
const CFG = CFG_PATH;
const launch = launchApp;
const ready = waitReady;
let fails=0;
const check=(t,c,x='')=>{ if(!c) fails++; console.log(`${c?'OK  ':'FAIL'} ${t}${x?'  '+x:''}`); };
const head = (p) => p.evaluate(()=>({
  text: document.getElementById('updated').textContent,
  cls: document.querySelector('#updated span')?.className,
}));

// 갱신 시각이 바뀔 때까지 기다렸다가 걸린 시간을 잰다
async function timeToNextRefresh(page, maxMs) {
  const start = Date.now();
  const first = (await head(page)).text;
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(1000);
    if ((await head(page)).text !== first) return Date.now() - start;
  }
  return null; // maxMs 안에 갱신 없음
}

// ===== A. 장중: 30초 간격 =====
console.log('=== A. 장중 (marketStatus=OPEN) ===');
fs.writeFileSync(CFG,'{}');
let app = await launch(); let page = await app.firstWindow();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await ready(page); await page.waitForTimeout(1500);
const hA = await head(page);
console.log('헤더:', hA.text, `(class=${hA.cls})`);
check('장중 배지 = 실시간', hA.cls === 'live', hA.cls);

const dtA = await timeToNextRefresh(page, 55000);
console.log(`  다음 갱신까지 ${dtA===null?'55초 내 없음':Math.round(dtA/1000)+'초'}`);
check('장중에는 약 30초 간격', dtA !== null && dtA >= 25000 && dtA <= 45000, `${dtA}ms`);
check('A 콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' / '));
await app.close(); await new Promise(r=>setTimeout(r,1200));

// ===== B. 장 마감 강제: 간격 확대 =====
console.log('\n=== B. 장 마감 강제 (marketStatus 를 CLOSE 로 고정) ===');
const orig = fs.readFileSync(MAIN,'utf8');
const NEEDLE = "open: d.marketStatus === 'OPEN'";
if (!orig.includes(NEEDLE)) { console.log('FAIL: 패치 지점을 찾지 못함'); process.exit(1); }
fs.writeFileSync(MAIN, orig.replace(NEEDLE, 'open: false'));
console.log('  (main.js에서 장 상태를 강제로 마감 처리)');
try {
  fs.writeFileSync(CFG,'{}');
  app = await launch(); page = await app.firstWindow();
  const errs2=[]; page.on('pageerror',e=>errs2.push(e.message));
  await ready(page); await page.waitForTimeout(1500);
  const hB = await head(page);
  console.log('헤더:', hB.text, `(class=${hB.cls})`);
  check('장마감 배지로 표시', hB.cls === 'closed', hB.cls);
  check('가격은 그대로 표시', await page.evaluate(()=>document.getElementById('dprice').textContent) !== '—');

  // 장중이면 30초 안에 갱신되어야 하는데, 마감이면 5분 간격이라 70초 동안 갱신이 없어야 한다
  const dtB = await timeToNextRefresh(page, 70000);
  console.log(`  다음 갱신까지 ${dtB===null?'70초 내 없음 (간격 확대됨)':Math.round(dtB/1000)+'초'}`);
  check('장 마감 시 30초 폴링 중단', dtB === null, dtB ? `${dtB}ms 만에 갱신됨` : '');
  check('B 콘솔 에러 없음', errs2.length===0, errs2.slice(0,2).join(' / '));
  await app.close();
} finally {
  fs.writeFileSync(MAIN, orig);
  console.log('  (main.js 원복 완료)');
}
check('main.js 원복 확인', fs.readFileSync(MAIN,'utf8') === orig);
fs.writeFileSync(CFG,'{}');
console.log(`\n${fails===0?'PASS':'FAIL'}: 실패 ${fails}건`);
