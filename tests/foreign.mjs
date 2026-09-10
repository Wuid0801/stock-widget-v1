// E. 미국 주식 지원 검증 (검색 / 통화 표시 / 국내와 혼용)
import { APP_DIR, CFG_PATH, SHOTS_DIR, launchApp, waitReady } from './_paths.mjs';
import path from 'node:path'; import fs from 'node:fs';

const CFG = CFG_PATH;
const SHOTS = SHOTS_DIR;
fs.writeFileSync(CFG, '{}');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

let app = await launchApp(); let page = await app.firstWindow();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await waitReady(page); await page.waitForTimeout(1500);

const disk = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
const results = () => page.evaluate(() => [...document.querySelectorAll('#results .hit')]
  .map((e) => e.innerText.replace(/\n/g, ' ')));
const detail = () => page.evaluate(() => ({
  name: document.getElementById('dname').textContent,
  price: document.getElementById('dprice').textContent,
  chg: document.getElementById('dchg').innerText.replace(/\n/g, ' '),
  w52lo: document.getElementById('w52lo').textContent,
  w52hi: document.getElementById('w52hi').textContent,
  yTicks: (() => { const c = Chart.getChart(document.getElementById('chart')); return c ? c.scales.y.ticks.map((t) => t.label) : []; })(),
  chartN: (() => { const c = Chart.getChart(document.getElementById('chart')); return c ? c.data.datasets[0].data.length : 0; })(),
}));

// --- 한글로 미국 종목 검색 ---
await page.click('#add'); await page.waitForTimeout(400);
await page.fill('#q', '엔비디아'); await page.waitForTimeout(1300);
const r1 = await results();
console.log('  "엔비디아" 검색:', r1.join(' | '));
check('한글로 미국 종목 검색됨', r1.some((t) => t.includes('NVDA')), r1.join(' | '));

// --- 추가 ---
const before = await page.evaluate(() => document.querySelectorAll('#list .row').length);
await page.evaluate(() => {
  const hit = [...document.querySelectorAll('#results .hit')].find((e) => e.innerText.includes('NVDA'));
  hit.click();
});
await page.waitForTimeout(6000);
const after = await page.evaluate(() => document.querySelectorAll('#list .row').length);
check('미국 종목 추가됨', after === before + 1, `${before} → ${after}`);

const added = disk().watchlist[disk().watchlist.length - 1];
console.log('  추가된 종목:', JSON.stringify(added));
check('심볼에 .KS/.KQ 접미사 없음', added.symbol === 'NVDA', added.symbol);

// --- 통화 표시 ---
const d = await detail();
console.log(`  상세: ${d.name} ${d.price} (${d.chg}) | 52주 ${d.w52lo}~${d.w52hi} | y축 ${d.yTicks.join(', ')}`);
check('종목명 옆에 통화 표시', d.name.includes('(USD)'), d.name);
check('가격이 소수 2자리', /^\d[\d,]*\.\d{2}$/.test(d.price), d.price);
check('등락도 소수 2자리', /[+-]?[\d,]+\.\d{2}/.test(d.chg), d.chg);
check('52주 값도 소수 2자리', /\.\d{2}$/.test(d.w52lo) && /\.\d{2}$/.test(d.w52hi), `${d.w52lo}~${d.w52hi}`);
check('차트 y축도 소수 2자리', d.yTicks.every((t) => /\.\d{2}$/.test(t)), d.yTicks.join(','));
check('미국 종목 차트 로드', d.chartN > 0, `${d.chartN}포인트`);
await page.screenshot({ path: path.join(SHOTS, 'foreign-detail.png') });

// --- 국내 종목과 혼용해도 각자 형식 유지 ---
await page.evaluate(() => document.querySelectorAll('#list .row')[0].click());
await page.waitForTimeout(3000);
const dk = await detail();
console.log(`  국내 상세: ${dk.name} ${dk.price}`);
check('국내는 통화 표기 없음', !dk.name.includes('('), dk.name);
check('국내는 정수 표기', !/\.\d{2}$/.test(dk.price), dk.price);

const rows = await page.evaluate(() => [...document.querySelectorAll('#list .row')]
  .map((r) => ({ name: r.querySelector('.name').textContent, px: r.querySelector('.px').textContent })));
console.log('  목록:', rows.map((r) => `${r.name} ${r.px}`).join(' | '));
const krRow = rows[0]; const usRow = rows[rows.length - 1];
check('목록에서 국내는 정수', !/\.\d{2}$/.test(krRow.px), `${krRow.name} ${krRow.px}`);
check('목록에서 미국은 소수 2자리', /\.\d{2}$/.test(usRow.px), `${usRow.name} ${usRow.px}`);
check('국내·미국 혼용 시 모두 값이 채워짐', rows.every((r) => r.px !== '—' && r.px !== ''), rows.map((r) => r.px).join(','));
await page.screenshot({ path: path.join(SHOTS, 'foreign-mixed.png') });

// --- 실시간 조회가 미국 종목 때문에 깨지지 않는지 ---
const badge = await page.evaluate(() => document.querySelector('#updated span').className);
check('혼용 상태에서도 국내 시세 소스 정상', ['live', 'over', 'closed'].includes(badge), badge);

check('콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' / '));

// --- 재실행 후 유지 ---
await app.close(); await new Promise((r) => setTimeout(r, 1500));
app = await launchApp(); page = await app.firstWindow();
await waitReady(page); await page.waitForTimeout(1200);
const names = await page.evaluate(() => [...document.querySelectorAll('#list .row .name')].map((e) => e.textContent));
check('재실행 후 미국 종목 유지', names.includes('엔비디아'), names.join(','));
await app.close();

fs.writeFileSync(CFG, '{}');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
