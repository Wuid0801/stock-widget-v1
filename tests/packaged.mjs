// ③ 패키징된(asar) 앱이 실제로 동작하는지 검증.
// dist/ 가 없으면 건너뛴다 — 먼저 `npm run dist` 를 실행해야 의미가 있다.
import { APP_DIR, CFG_PATH, SHOTS_DIR, USER_DATA_DIR, LAUNCH_ENV } from './_paths.mjs';
import { RENDERER_FILES } from './_renderer.mjs';
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs';

const OUT = path.join(APP_DIR, 'dist');
const EXE = path.join(OUT, 'win-unpacked', '관심종목 위젯.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP: dist/ 가 없습니다. `npm run dist` 후 다시 실행하세요.');
  console.log('\nPASS: 실패 0건');
  process.exit(0);
}

// 빌드가 설정 경로 환경변수를 모르면 띄우는 순간 실제 사용자 설정에 쓴다.
// (2026-08-07 자 빌드를 띄웠다가 %APPDATA%/kr-stock-widget 에 513바이트가 써졌다)
// asar 은 원본을 그대로 담으므로 바이트에서 바로 찾을 수 있다.
const ASAR = path.join(OUT, 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(ASAR) || !fs.readFileSync(ASAR).includes('KR_STOCK_WIDGET_CONFIG_DIR')) {
  console.log('SKIP: dist/ 빌드가 설정 경로 격리를 모릅니다(빌드가 낡음).');
  console.log('      그대로 띄우면 실제 설정을 건드리므로 건너뜁니다. `npm run dist` 로 다시 빌드하세요.');
  console.log('\nPASS: 실패 0건');
  process.exit(0);
}

// 빌드 뒤로 앱 소스를 고쳤으면 낡은 산출물을 지금 코드처럼 검사하게 된다(2026-10-21: 10/8 빌드에 그 뒤 커밋 52개) — 건너뛴다
const SOURCES = ['main.js', 'preload.js', ...RENDERER_FILES, 'index.html', 'indicators.js', 'backtest.js', 'market-check.js', 'quote-session.cjs', 'package.json'];
if (fs.statSync(ASAR).mtimeMs < Math.max(...SOURCES.map((f) => fs.statSync(path.join(APP_DIR, f)).mtimeMs))) {
  console.log('SKIP: dist/ 빌드가 앱 소스보다 오래됐습니다. `npm run dist` 로 다시 빌드하세요.');
  console.log('\nPASS: 실패 0건');
  process.exit(0);
}

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

check('asar 로 묶임', fs.existsSync(path.join(OUT, 'win-unpacked', 'resources', 'app.asar')));
check('설치 파일 생성됨', fs.readdirSync(OUT).some((f) => f.endsWith('.exe') && f.includes('Setup')));

fs.writeFileSync(CFG_PATH, '{}');
// 설치본은 productName('관심종목 위젯') 프로필에 쓴다. 스위치를 안 주면 실제
// 사용자 설정을 띄우게 되고, 바로 위에서 쓴 CFG_PATH 와도 다른 파일이 된다.
const app = await electron.launch({
  executablePath: EXE, args: [`--user-data-dir=${USER_DATA_DIR}`],
  env: LAUNCH_ENV, timeout: 60000 });
const page = await app.firstWindow();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.waitForFunction(
  () => /\d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent), { timeout: 60000 });
await page.waitForTimeout(2000);

const ui = await page.evaluate(() => ({
  chartLoaded: typeof window.Chart !== 'undefined',
  chartPts: (() => { const c = Chart.getChart(document.getElementById('chart')); return c ? c.data.datasets[0].data.length : 0; })(),
  rows: [...document.querySelectorAll('#list .row')].map((r) => `${r.querySelector('.name').textContent} ${r.querySelector('.px').textContent}`),
  price: document.getElementById('dprice').textContent,
  badge: document.getElementById('badge').textContent,
  indices: document.getElementById('indices').innerText.replace(/\s+/g, ' ').trim(),
  updated: document.getElementById('updated').textContent,
}));
console.log('  헤더:', ui.updated, '| 지수:', ui.indices);
console.log('  목록:', ui.rows.join(' | '));

// 상대경로 <script src="./node_modules/chart.js/..."> 가 asar 안에서 풀리는지가 핵심
check('Chart.js 가 asar 안에서 로드됨', ui.chartLoaded);
check('차트 렌더링됨', ui.chartPts > 0, `${ui.chartPts}포인트`);
check('시세 표시됨', ui.price !== '—', ui.price);
check('RSI 배지 표시', /RSI \d+/.test(ui.badge), ui.badge);
check('지수 줄 표시', ui.indices.includes('코스피'), ui.indices);
check('전 종목 값 채워짐', ui.rows.every((r) => !r.endsWith('—')), ui.rows.join(','));

// 외부 API + IPC 경로도 패키징 상태에서 살아있는지
await page.click('#add'); await page.waitForTimeout(400);
await page.fill('#q', '카카오'); await page.waitForTimeout(1500);
const hits = await page.evaluate(() => [...document.querySelectorAll('#results .hit')].map((e) => e.innerText.replace(/\n/g, ' ')));
check('패키징 상태에서 검색 동작', hits.length > 0, hits.slice(0, 2).join(' | '));

check('콘솔 에러 없음', errs.length === 0, errs.slice(0, 3).join(' / '));
await page.screenshot({ path: path.join(SHOTS_DIR, 'packaged.png') });
await app.close();

fs.writeFileSync(CFG_PATH, '{}');
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
