// ① 장 상태에 따른 폴링 간격 검증.
//
// 실제 장 시간에 의존하면 밤이나 주말에 돌릴 때 실패하므로,
// main.js 의 장 상태 판정을 양쪽으로 강제해 두 경로를 모두 확인한다(검증 후 원복).
import { APP_DIR, CFG_PATH, launchApp, waitReady } from './_paths.mjs';
import path from 'node:path'; import fs from 'node:fs';

const MAIN = path.join(APP_DIR, 'main.js');
const CFG = CFG_PATH;
const NEEDLE = "open: d.marketStatus === 'OPEN'";

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const head = (page) => page.evaluate(() => ({
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

const orig = fs.readFileSync(MAIN, 'utf8');
if (!orig.includes(NEEDLE)) { console.log('FAIL: 장 상태 판정 지점을 찾지 못함'); process.exit(1); }

async function runWith(marketOpenLiteral, label, fn) {
  fs.writeFileSync(MAIN, orig.replace(NEEDLE, `open: ${marketOpenLiteral}`));
  console.log(`\n=== ${label} ===`);
  fs.writeFileSync(CFG, '{}');
  const app = await launchApp();
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await waitReady(page); await page.waitForTimeout(1500);
  try {
    await fn(page, errs);
  } finally {
    await app.close();
    await new Promise((r) => setTimeout(r, 1200));
  }
}

try {
  // --- 장중: 30초 간격 ---
  await runWith('true', '장중 강제', async (page, errs) => {
    const h = await head(page);
    console.log('헤더:', h.text, `(class=${h.cls})`);
    check('장중 배지 = 실시간', h.cls === 'live', h.cls);

    const dt = await timeToNextRefresh(page, 55000);
    console.log(`  다음 갱신까지 ${dt === null ? '55초 내 없음' : Math.round(dt / 1000) + '초'}`);
    check('장중에는 약 30초 간격', dt !== null && dt >= 25000 && dt <= 45000, `${dt}ms`);
    check('장중 콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' / '));
  });

  // --- 장 마감: 간격 확대 ---
  await runWith('false', '장 마감 강제', async (page, errs) => {
    const h = await head(page);
    console.log('헤더:', h.text, `(class=${h.cls})`);
    check('장마감 배지로 표시', h.cls === 'closed', h.cls);
    check('가격은 그대로 표시', await page.evaluate(() => document.getElementById('dprice').textContent) !== '—');

    // 장중이면 30초 안에 갱신되어야 하는데, 마감이면 5분 간격이라 70초 동안 갱신이 없어야 한다
    const dt = await timeToNextRefresh(page, 70000);
    console.log(`  다음 갱신까지 ${dt === null ? '70초 내 없음 (간격 확대됨)' : Math.round(dt / 1000) + '초'}`);
    check('장 마감 시 30초 폴링 중단', dt === null, dt ? `${dt}ms 만에 갱신됨` : '');
    check('장마감 콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' / '));
  });
} finally {
  fs.writeFileSync(MAIN, orig);
  console.log('\n  (main.js 원복)');
}
check('main.js 원복 확인', fs.readFileSync(MAIN, 'utf8') === orig);

fs.writeFileSync(CFG, '{}');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
