// ① 장 상태에 따른 폴링 간격 검증.
//
// 실제 장 시간에 의존하면 밤이나 주말에 돌릴 때 실패하므로,
// 장 상태를 양쪽으로 강제해 두 경로를 모두 확인한다.
//
// 예전에는 main.js 를 디스크에서 치환하고 finally 에서 되돌렸다. 프로세스가
// 중간에 죽으면 사용자의 소스가 패치된 채로 남고, 판정 코드가 조금만 바뀌어도
// 치환 대상 문자열을 못 찾아 스위트 전체가 죽었다 — 실제로 시간외 커밋
// (eb8bbfd) 이후로 계속 그 상태였다. 이제 환경변수로 강제한다.
import { CFG_PATH, SESSION_ENV, launchApp, waitReady } from './_paths.mjs';
import fs from 'node:fs';

const CFG = CFG_PATH;

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

async function runWith(session, label, fn) {
  console.log(`\n=== ${label} ===`);
  fs.writeFileSync(CFG, '{}');
  const app = await launchApp({ [SESSION_ENV]: session });
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
  await runWith('regular', '장중 강제', async (page, errs) => {
    const h = await head(page);
    console.log('헤더:', h.text, `(class=${h.cls})`);
    check('장중 배지 = 실시간', h.cls === 'live', h.cls);

    const dt = await timeToNextRefresh(page, 55000);
    console.log(`  다음 갱신까지 ${dt === null ? '55초 내 없음' : Math.round(dt / 1000) + '초'}`);
    check('장중에는 약 30초 간격', dt !== null && dt >= 25000 && dt <= 45000, `${dt}ms`);
    check('장중 콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' / '));
  });

  // --- 장 마감: 간격 확대 ---
  await runWith('closed', '장 마감 강제', async (page, errs) => {
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
  fs.writeFileSync(CFG, '{}');
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
