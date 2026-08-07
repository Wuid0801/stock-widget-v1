import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
// 강화 검증: 화면의 차트 데이터가 "헤더에 표시된 종목 + 활성 타임프레임"의
// 실제 야후 시계열과 일치하는지 독립적으로 가져와 대조한다.
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';

const APP = APP_DIR;
const TF = { '1D': ['1d','5m'], '1W': ['5d','30m'], '1M': ['1mo','1d'], '1Y': ['1y','1d'] };
const NAME2SYM = { '삼성전자':'005930.KS', 'KODEX 200':'069500.KS', 'KODEX 레버리지':'122630.KS', 'SK하이닉스':'000660.KS', 'NAVER':'035420.KS' };

async function series(symbol, tf) {
  const [range, interval] = TF[tf];
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const r = (await res.json()).chart.result[0];
  return r.indicators.quote[0].close.filter(x => x != null);
}

const app = await launchApp();
const page = await app.firstWindow();
const consoleErrs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(`[${m.type()}] ${m.text().slice(0,200)}`); });
page.on('pageerror', e => consoleErrs.push(`[PAGEERROR] ${e.message}`));

await page.waitForFunction(() => /\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent), { timeout: 60000 });

const probe = () => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('chart'));
  return {
    name: document.getElementById('dname').textContent,
    tf: [...document.querySelectorAll('#tf button')].find(b => b.classList.contains('on')).textContent,
    data: c ? c.data.datasets[0].data : null,
    labels: c ? [c.data.labels[0], c.data.labels.at(-1)] : null,
  };
});
const clickRow = (i) => page.evaluate((n) => document.querySelectorAll('#list .row')[n].click(), i);
const clickTf  = (t) => page.evaluate((x) => [...document.querySelectorAll('#tf button')].find(b => b.textContent === x).click(), t);

let fails = 0;
async function verify(tag, expectName, expectTf) {
  const p = await probe();
  const problems = [];
  if (p.name !== expectName) problems.push(`헤더=${p.name} 기대=${expectName}`);
  if (p.tf !== expectTf) problems.push(`탭=${p.tf} 기대=${expectTf}`);
  if (!p.data) problems.push('차트 없음');
  else {
    const ref = await series(NAME2SYM[expectName], expectTf);
    let data = p.data;
    // 1D는 장중 실시간 현재가가 끝점으로 한 개 덧붙는다 → 분리해서 본다
    if (expectTf === '1D' && data.length === ref.length + 1) { p.rt = data.at(-1); data = data.slice(0, -1); }
    if (Math.abs(data.length - ref.length) > 2) problems.push(`길이 ${data.length} vs 실제 ${ref.length}`);
    // 09:00 첫 봉은 장중 변하지 않는다 → 다른 종목이 그려졌는지 가장 확실하게 잡힌다
    if (data[0] !== ref[0]) problems.push(`첫 봉 ${data[0]} vs 실제 ${ref[0]} (다른 종목?)`);
    if (Math.abs(data.at(-1) - ref.at(-1)) / ref.at(-1) > 0.02) {
      problems.push(`마지막값 ${data.at(-1)} vs 실제 ${ref.at(-1)} (2% 초과)`);
    }
  }
  if (problems.length) fails++;
  console.log(`${problems.length ? 'FAIL' : 'OK  '} ${tag}: ${p.name}/${p.tf} n=${p.data?.length}${p.rt ? ' (실시간끝점 ' + p.rt + ')' : ''} x축[${p.labels}]${problems.length ? '  ← ' + problems.join('; ') : ''}`);
}

console.log('--- A. tf 클릭 직후 종목 클릭 (경쟁 유도) ---');
const rows = [['삼성전자',0],['KODEX 200',1],['KODEX 레버리지',2],['SK하이닉스',3],['NAVER',4]];
for (const [name, i] of rows) {
  await clickTf('1D');
  await clickRow(i);            // 대기 없이 연속 → 요청 2건 동시 비행
  await page.waitForTimeout(3000);
  await verify(`tf+row 연속 ${name}`, name, '1D');
}

console.log('\n--- B. 종목 빠른 연타 (역순 도착 유도) ---');
for (const t of [1,2,3]) {
  await clickRow(3); await page.waitForTimeout(40);
  await clickRow(0); await page.waitForTimeout(40);
  await clickRow(2);            // 최종 = KODEX 레버리지
  await page.waitForTimeout(3500);
  await verify(`연타 #${t}`, 'KODEX 레버리지', '1D');
}

console.log('\n--- C. 타임프레임 연타 ---');
await clickRow(3); await page.waitForTimeout(2500);
for (const t of [1,2]) {
  await clickTf('1Y'); await page.waitForTimeout(40);
  await clickTf('1M'); await page.waitForTimeout(40);
  await clickTf('1W'); await page.waitForTimeout(40);
  await clickTf('1D');
  await page.waitForTimeout(3500);
  await verify(`tf연타 #${t}`, 'SK하이닉스', '1D');
}

console.log('\n--- D. 각 타임프레임 정상 동작 ---');
await clickRow(0); await page.waitForTimeout(2500);
for (const tf of ['1D','1W','1M','1Y']) {
  await clickTf(tf);
  await page.waitForTimeout(3000);
  await verify(`${tf} 단독`, '삼성전자', tf);
}

console.log('\n--- 콘솔 경고/에러 ---');
console.log(consoleErrs.length ? consoleErrs.join('\n') : '(없음)');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 불일치 ${fails}건`);
await app.close();
