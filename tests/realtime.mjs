// Network smoke only: ±0.5% allows movement between asynchronous requests.
// Exact session/source selection belongs to deterministic fixture tests.
import { CFG_PATH, FAIL_URLS_ENV, launchApp, waitReady } from './_paths.mjs';
import fs from 'node:fs';
import { normalizeQuote } from '../quote-session.cjs';

const H = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' };
let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
const near = (actual, expected) => Number.isFinite(expected) && expected > 0
  && Math.abs(actual - expected) / expected < 0.005;

const ui = (page) => page.evaluate(() => {
  const c = Chart.getChart(document.getElementById('chart'));
  const selected = quotes[state.selected];
  return {
    live: selected?.live, session: selected?.session, priceSession: selected?.priceSession,
    source: selected?.source, symbol: state.selected,
    badge: document.querySelector('#updated span')?.className,
    updated: document.getElementById('updated').textContent,
    name: document.getElementById('dname').textContent,
    price: document.getElementById('dprice').textContent,
    tf: state.timeframe,
    chartLast: c?.data.datasets[0].data.at(-1) ?? null,
    chartN: c?.data.datasets[0].data.length ?? 0,
    hLines: Array.from(c?.options.plugins.hLine.lines || [], (line) => ({
      value: line.value, label: line.label,
    })),
    rows: [...document.querySelectorAll('#list .row')].map((r, index) => ({
      symbol: state.watchlist[index].symbol,
      name: r.querySelector('.name').textContent, px: r.querySelector('.px').textContent,
    })),
  };
});

let app;
try {
  fs.writeFileSync(CFG_PATH, '{}');
  console.log('=== A. Naver 정규화 시세 smoke ===');
  app = await launchApp();
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await waitReady(page);
  await page.waitForFunction(() => !busy);
  const a = await ui(page);
  console.log('헤더:', a.updated, '| 상세:', a.name, a.price, '| 출처:', a.source);
  check('네이버 소스 사용 중 (Yahoo 폴백 아님)', a.live === true, a.source);

  // The base record is not necessarily the current quote. Normalize all candidates.
  const codes = a.rows.map((r) => r.symbol.split('.')[0]);
  const [response, nxtResponse] = await Promise.all([
    fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`, { headers: H }).then((r) => r.json()),
    fetch(`https://polling.finance.naver.com/api/realtime/domestic/NXT/stock/${codes.join(',')}`, { headers: H }).then((r) => r.json()),
  ]);
  const nxtByCode = Object.fromEntries((nxtResponse.datas || []).map((d) => [d.itemCode, d]));
  const now = Date.now();
  const reference = Object.fromEntries(response.datas.map((d) => [d.itemCode,
    normalizeQuote(d, { now, nxt: nxtByCode[d.itemCode] }),
  ]));
  const selectedReference = reference[a.symbol.split('.')[0]];
  const shown = num(a.price);
  console.log(`  화면=${shown} 정규화 Naver=${selectedReference?.price} 세션=${selectedReference?.session} 출처=${selectedReference?.source}`);
  check('화면 가격이 정규화 Naver와 근접(±0.5%, smoke)', near(shown, selectedReference?.price));

  if (a.session === 'regular') {
    check('정규장 1D 차트 끝점 = 현재가', a.tf === '1D' && near(a.chartLast, shown),
      `차트끝=${a.chartLast} 현재가=${shown}`);
  } else if (['after', 'pre'].includes(a.priceSession)) {
    const label = a.priceSession === 'after' ? '애프터' : '프리';
    check('시간외 현재가가 별도 수평선에 표시', a.tf === '1D'
      && a.hLines.some((line) => line.label === label && line.value === shown), JSON.stringify(a.hLines));
  }
  check('1D 차트 데이터 있음', a.tf === '1D' && a.chartN > 0, `${a.chartN}포인트`);

  let listOk = 0;
  for (const row of a.rows) {
    const ref = reference[row.symbol.split('.')[0]];
    if (near(num(row.px), ref?.price)) listOk++;
  }
  check('리스트 전 종목 정규화 시세 반영(±0.5%, smoke)', listOk === a.rows.length, `${listOk}/${a.rows.length}`);
  check('A 구간 콘솔 에러 없음', errors.length === 0, errors.join(' / '));
  await app.close();
  app = null;

  console.log('\n=== B. Naver 실패 시 Yahoo 폴백 ===');
  fs.writeFileSync(CFG_PATH, '{}');
  // Keep index requests available. Block base and direct NXT stock requests.
  app = await launchApp({ [FAIL_URLS_ENV]: '/api/realtime/domestic/stock,/api/realtime/domestic/NXT/stock' });
  page = await app.firstWindow();
  const fallbackErrors = [];
  page.on('pageerror', (e) => fallbackErrors.push(e.message));
  await waitReady(page);
  await page.waitForFunction(() => !busy);
  const b = await ui(page);
  console.log('헤더:', b.updated, '| 상세:', b.name, b.price);
  check('Yahoo 지연 소스로 전환', b.live === false && b.badge === 'delay', b.source);
  const yh = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${b.symbol}?range=1y&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.json());
  const yahooPx = yh.chart.result[0].meta.regularMarketPrice;
  check('Yahoo 값으로 정상 표시(±0.5%, smoke)', near(num(b.price), yahooPx));
  check('폴백에서도 가격이 비어있지 않음', b.price !== '—' && num(b.price) > 0);
  check('폴백에서도 차트 정상', b.chartN > 0, `${b.chartN}포인트`);
  check('폴백에서 리스트 전 종목 표시', b.rows.every((r) => r.px !== '—' && r.px !== ''), b.rows.map((r) => r.px).join(','));
  check('B 구간 콘솔 에러 없음', fallbackErrors.length === 0, fallbackErrors.join(' / '));
} finally {
  if (app) await app.close();
  fs.writeFileSync(CFG_PATH, '{}');
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exitCode = fails === 0 ? 0 : 1;
