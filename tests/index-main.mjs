// main.js 의 지수 쪽 — 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
//
// 1) 차트 요청의 기호 검사가 야후 지수 기호(^KS11 코스피 · ^KQ11 코스닥)를 받는다.
//    ^ 는 맨 앞 한 번만 — 그 밖의 모양은 지금처럼 URL 에 닿기 전에 거절한다.
// 2) quote:indices 가 지수 헤더에 필요한 값(전일 대비 · 시 · 고 · 저 · 장 상태 · 시각)을 꺼낸다.
//    저장해 둔 네이버 응답(2026-10-02 15:37, 장 마감 직후 — 코스피 상승 · 코스닥 하락)을 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/naver-index-20261002.json', import.meta.url), 'utf8'));

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// electron 은 필요한 만큼만 흉내 낸다. 창은 만들지 않는다(whenReady 가 끝나지 않는다).
const handlers = {};
const electron = {
  app: { getPath: () => '', whenReady: () => new Promise(() => {}), on() {}, requestSingleInstanceLock: () => true },
  BrowserWindow: class {}, screen: {}, globalShortcut: {}, Notification: {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
};
const modules = {
  electron,
  'electron-store': class { get() {} set() {} },
  fs,
  path,
  './quote-session.cjs': createRequire(import.meta.url)('../quote-session.cjs'),
};
const require = (m) => {
  if (!(m in modules)) throw new Error(`main.js 가 예상하지 못한 모듈을 부른다: ${m}`);
  return modules[m];
};

// 지수 주소면 픽스처, 아니면 봉 하나짜리 야후 차트를 돌려준다. 받은 주소를 기록한다.
let indexBody = fixture;
const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(String(url));
  const body = String(url).includes('/index/') ? indexBody : {
    chart: { result: [{ timestamp: [1], indicators: { quote: [{ close: [100] }] },
      meta: { regularMarketPrice: 100, currency: 'KRW' } }] },
  };
  return { ok: true, status: 200, json: async () => body };
};

new Function('require', 'process', 'fetch', 'AbortSignal', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal);

// --- 차트 요청의 기호 ---------------------------------------------------------
for (const symbol of ['^KS11', '^KQ11', '005930.KS', 'AAPL', 'BRK-B']) {
  fetched.length = 0;
  const r = await handlers['yf:chart']({}, { symbol, range: '1d', interval: '5m' });
  check(`${symbol} 차트 요청을 받는다`,
    r.ok === true && fetched.some((u) => u.includes(`/chart/${encodeURIComponent(symbol)}?`)),
    JSON.stringify(r).slice(0, 80));
}
for (const symbol of ['^^KS11', 'KS11^', '^', '^.KS', '^KS11/../x', '']) {
  fetched.length = 0;
  const r = await handlers['yf:chart']({}, { symbol, range: '1d', interval: '5m' });
  check(`${JSON.stringify(symbol)} 는 거절한다`,
    r.ok === false && r.error === '잘못된 요청' && fetched.length === 0, JSON.stringify(r));
}

// --- 지수 응답 -------------------------------------------------------------------
const r = await handlers['quote:indices']({});
check('지수 응답을 읽는다', r.ok === true && r.items?.length === 2, JSON.stringify(r).slice(0, 120));
const [kospi, kosdaq] = r.items || [];
check('코스피 항목', same(kospi, {
  code: 'KOSPI', name: '코스피', value: 7003.74, change: 32.39, pct: 0.46,
  open: 6938.27, high: 7011.04, low: 6927.88, isOpen: false, tradedAt: '2026-10-02T15:37:00+09:00',
}), JSON.stringify(kospi));
check('하락한 지수는 전일 대비가 음수다', kosdaq?.change === -1 && kosdaq?.pct === -0.11, JSON.stringify(kosdaq));

// 빠진 값은 0 이 아니라 null — 0 이면 시가 0 캔들 · 전일 대비 0 으로 잘못 그린다
indexBody = { datas: [{ ...fixture.datas[0], openPrice: undefined, openPriceRaw: undefined,
  compareToPreviousClosePrice: undefined, compareToPreviousClosePriceRaw: undefined, marketStatus: 'OPEN' }] };
const partial = await handlers['quote:indices']({});
const p = partial.items?.[0];
check('빠진 값은 null 이다', p && p.open === null && p.change === null && p.value === 7003.74, JSON.stringify(p));
check('장이 열려 있으면 isOpen', p?.isOpen === true, JSON.stringify(p));

// 종가 · 등락률이 비면 그 지수는 뺀다. 숫자로 바꾸면 0 이 되어 지수 줄에 "코스피 0.00" 이 떴다
// (헤더 · 차트는 indexLive 가 이미 막는다 — 6f6af8c). 하나만 비면 나머지 지수는 그대로 보인다.
for (const [label, blank] of [
  ['종가가 빈', { closePrice: '', closePriceRaw: undefined }],
  ['종가가 0 인', { closePrice: '0', closePriceRaw: '0' }], // 지수가 0 일 수는 없다
  ['등락률이 빈', { fluctuationsRatio: '', fluctuationsRatioRaw: undefined }],
]) {
  indexBody = { datas: [{ ...fixture.datas[0], ...blank }, fixture.datas[1]] };
  const out = await handlers['quote:indices']({});
  check(`${label} 지수는 빼고 나머지는 보인다`,
    out.ok === true && out.items.length === 1 && out.items[0].code === 'KOSDAQ', JSON.stringify(out).slice(0, 160));
}
indexBody = { datas: fixture.datas.map((d) => ({ ...d, closePrice: '', closePriceRaw: undefined })) };
const none = await handlers['quote:indices']({});
check('둘 다 비면 빈 응답이다(지수 줄이 숨는다)', none.ok === false, JSON.stringify(none));

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
