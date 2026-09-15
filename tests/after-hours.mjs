// Confirmed regular-close differences, then deterministic UI display checks.
// Live smoke and session/chart behavior are covered by their own suites.
import fs from 'node:fs';
import { CFG_PATH, launchApp, waitReady } from './_paths.mjs';
import { confirmedRegularClose, overFromClose } from '../quote-session.cjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// No source extraction and no FORCE_SESSION-derived fake closing price.
const close = confirmedRegularClose({
  closePriceRaw: 270000, marketSessionType: 'regularMarket', marketStatus: 'CLOSE',
  localTradedAt: '2026-09-15T15:30:00+09:00', stockExchangeType: { endTime: '1530' },
});
check('확정된 정규장 종가', close?.price === 270000 && close?.date === '2026-09-15');
for (const [label, regularClose, price, priceSession, expected] of [
  ['SK하이닉스 장후', 1853000, 1849000, 'after', -4000],
  ['삼성전자 장후', 269000, 267000, 'after', -2000],
  ['오르면 양수', 269000, 271500, 'after', 2500],
  ['안 움직였으면 0', 269000, 269000, 'after', 0],
  ['장전에는 내지 않는다', 269000, 267000, 'pre', null],
  ['정규장에는 내지 않는다', 269000, 267000, 'regular', null],
  ['출처가 closed이면 내지 않는다', 269000, 267000, 'closed', null],
  ['종가가 없으면 null', undefined, 267000, 'after', null],
  ['현재가가 없으면 null', 269000, null, 'after', null],
]) {
  const actual = overFromClose(regularClose, price, priceSession);
  check(label, actual === expected, `${actual} (expected ${expected})`);
}

fs.writeFileSync(CFG_PATH, '{}');
let app;
try {
  app = await launchApp();
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await waitReady(page);
  await page.waitForFunction(() => !busy);

  // Access the renderer's lexical globals in the page, not window.quotes.
  // A single synchronous evaluation injects and renders each case, then restores it.
  const shown = (session, priceSession, price, regularClose) => page.evaluate((q) => {
    const symbol = state.selected;
    const previous = quotes[symbol];
    try {
      quotes[symbol] = { ...previous, ...q, live: true, source: 'naver-base',
        fetchedAt: Date.now(), isTrading: q.session !== 'closed' };
      renderDetail();
      const el = document.getElementById('dclose');
      return { exists: !!el, hidden: el?.hidden, text: el?.textContent.trim() };
    } finally {
      quotes[symbol] = previous;
      renderDetail();
    }
  }, { session, priceSession, price, regularClose,
    fromClose: overFromClose(regularClose, price, priceSession) });

  for (const [label, session, priceSession, price, regularClose, expectedText] of [
    ['장후 -500', 'after', 'after', 269500, close?.price, '종가대비 -500'],
    ['장후 0도 표시', 'after', 'after', 270000, close?.price, '종가대비 0'],
    ['확정 종가가 없으면 숨김', 'after', 'after', 269500, null, null],
    ['장전 종가 대비 숨김', 'pre', 'pre', 269500, close?.price, null],
    ['종료 후 확정된 장후 차이 유지', 'closed', 'after', 269500, close?.price, '종가대비 -500'],
  ]) {
    const result = await shown(session, priceSession, price, regularClose);
    check(label, result.exists && (expectedText === null
      ? result.hidden && result.text === ''
      : !result.hidden && result.text === expectedText), JSON.stringify(result));
  }
  check('콘솔 에러 없음', errors.length === 0, errors.join(' / '));
} finally {
  if (app) await app.close();
  fs.writeFileSync(CFG_PATH, '{}');
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exitCode = fails === 0 ? 0 : 1;
