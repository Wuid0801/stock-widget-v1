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
// 미국 지수(네이버 해외 지수)와 원/달러(야후 KRW=X)는 처음엔 비어 있다 — 아래에서 채워 본다.
// 선물 · 유가 · 국채(extras)도 비어 있다가(야후 차트 모양이 와서 항목이 없다) 아래에서 채운다.
let indexBody = fixture;
let usIndexBody = { datas: [] };
let fxBody = null;
let extras = null;
let failUrl = null;
const fetched = [];
const fakeFetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  if (failUrl && u.includes(failUrl)) return { ok: false, status: 500, json: async () => ({}) };
  const body = u.includes('/worldstock/index/') ? usIndexBody : u.includes('/index/') ? indexBody
    : extras && u.includes('/worldstock/futures/') ? extras.futures
    : extras && u.includes('/marketindex/energy/') ? extras.energy
    : extras && u.includes('/marketindex/bond/') ? extras.bond
    : u.includes('/chart/KRW=X') && fxBody ? fxBody : {
      chart: { result: [{ timestamp: [1], indicators: { quote: [{ close: [100] }] },
        meta: { regularMarketPrice: 100, currency: 'KRW' } }] },
    };
  return { ok: true, status: 200, json: async () => body };
};

new Function('require', 'process', 'fetch', 'AbortSignal', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal);

// --- 차트 요청의 기호 ---------------------------------------------------------
for (const symbol of ['^KS11', '^KQ11', '005930.KS', 'AAPL', 'BRK-B', '^IXIC', '^GSPC', 'KRW=X', 'NQ=F', 'CL=F', '^TNX']) {
  fetched.length = 0;
  const r = await handlers['yf:chart']({}, { symbol, range: '1d', interval: '5m' });
  check(`${symbol} 차트 요청을 받는다`,
    r.ok === true && fetched.some((u) => u.includes(`/chart/${encodeURIComponent(symbol)}?`)),
    JSON.stringify(r).slice(0, 80));
}
// = 는 끝의 =X(환율) · =F(선물) 한 번만 받는다
for (const symbol of ['^^KS11', 'KS11^', '^', '^.KS', '^KS11/../x', '', '=X', 'KRW=', 'KRW=Y', 'KRW=X=X', 'A=B',
  '=F', 'NQ=FF', 'NQ=F=F', 'NQ=X=F']) {
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

// --- 미국 지수 · 원/달러 ----------------------------------------------------------
// 네이버 해외 지수 응답(2026-10-15 11:2x KST — 뉴욕 10/14 장 마감 뒤)과 야후 KRW=X 의 meta.
const usFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/naver-us-index-20261015.json', import.meta.url), 'utf8'));
indexBody = fixture;
usIndexBody = usFixture;
const fxTime = Math.floor(Date.now() / 1000) - 60; // 1분 전 값 — 거래 중
fxBody = { chart: { result: [{ meta: { regularMarketPrice: 1349.46, chartPreviousClose: 1340.86, regularMarketTime: fxTime,
  regularMarketDayHigh: 1352.82, regularMarketDayLow: 1338.88 } }] } };
fetched.length = 0;
const all = await handlers['quote:indices']({});
check('국내 둘 · 미국 둘 · 원/달러 하나', all.ok && same(all.items.map((i) => i.code), ['KOSPI', 'KOSDAQ', 'NASDAQ', 'SPX', 'USDKRW']),
  JSON.stringify(all.items?.map((i) => i.code)));
check('미국 지수는 네이버 해외 지수를 한 번에 묻는다',
  fetched.filter((u) => u.includes('/worldstock/index/.IXIC,.INX')).length === 1, fetched.join(' '));
const nasdaq = all.items?.find((i) => i.code === 'NASDAQ');
check('나스닥 항목(이름은 짧게)', same(nasdaq, { code: 'NASDAQ', name: '나스닥', value: 26692.87, change: -511.51, pct: -1.88,
  open: 27031.64, high: 27134.29, low: 26602.12, isOpen: false, tradedAt: '2026-10-14T17:15:59-04:00' }), JSON.stringify(nasdaq));
check('S&P 500 이름', all.items?.find((i) => i.code === 'SPX')?.name === 'S&P 500');
usIndexBody = { datas: [...usFixture.datas, { ...usFixture.datas[0], reutersCode: '.DJI', indexName: '다우' }] };
check('모르는 해외 지수가 섞여도 나스닥 · S&P 500 은 보인다',
  same((await handlers['quote:indices']({})).items.map((i) => i.code), ['KOSPI', 'KOSDAQ', 'NASDAQ', 'SPX', 'USDKRW']));
usIndexBody = usFixture;
const fx = all.items?.find((i) => i.code === 'USDKRW');
check('원/달러는 야후의 지금 값과 전일 종가로', fx && fx.value === 1349.46 && Math.abs(fx.change - 8.6) < 1e-9
  && Math.abs(fx.pct - (8.6 / 1340.86) * 100) < 1e-9 && fx.open === null && fx.high === 1352.82, JSON.stringify(fx));
check('값이 막 바뀌었으면 거래 중', fx?.isOpen === true && fx.tradedAt === new Date(fxTime * 1000).toISOString());
fxBody.chart.result[0].meta.regularMarketTime = fxTime - 3600; // 한 시간째 그대로 — 주말
check('한 시간째 그대로면 쉬는 중', (await handlers['quote:indices']({})).items.find((i) => i.code === 'USDKRW')?.isOpen === false);
fxBody.chart.result[0].meta.chartPreviousClose = undefined;
check('전일 종가가 없으면 원/달러는 뺀다', !(await handlers['quote:indices']({})).items.some((i) => i.code === 'USDKRW'));

// --- 나스닥 100 선물 · WTI · 미국채 10년 ------------------------------------------------
// 네이버 응답(2026-10-23 13:49 KST — 셋 다 거래 중). 선물은 해외 지수처럼 compareToPreviousClosePrice, 유가 · 국채
// (시장지표)는 fluctuations 가 전일 대비다. 국채는 폴링 주소가 없어(404) 상세(api.stock.naver.com)를 받는다.
const extrasFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/naver-market-extras-20261023.json', import.meta.url), 'utf8'));
extras = extrasFixture;
fxBody.chart.result[0].meta.chartPreviousClose = 1340.86;
fetched.length = 0;
const more = await handlers['quote:indices']({});
check('선물 · 유가 · 금리까지 여덟', more.ok && same(more.items.map((i) => i.code),
  ['KOSPI', 'KOSDAQ', 'NASDAQ', 'SPX', 'NQ', 'WTI', 'US10Y', 'USDKRW']), JSON.stringify(more.items?.map((i) => i.code)));
for (const where of ['/worldstock/futures/NQcv1', '/marketindex/energy/CLcv1', '/marketindex/bond/US10YT=RR']) {
  check(`${where} 를 한 번 묻는다`, fetched.filter((u) => u.includes(where)).length === 1, fetched.join(' '));
}
const byCode = (code) => more.items?.find((i) => i.code === code);
check('나스닥 100 선물', same(byCode('NQ'), { code: 'NQ', name: '나스닥 선물', value: 29122.75, change: -19.25, pct: -0.07,
  open: 29116.5, high: 29212.5, low: 29022.75, isOpen: true, tradedAt: '2026-10-22T23:48:45-05:00' }), JSON.stringify(byCode('NQ')));
check('WTI — 전일 대비는 fluctuations', same(byCode('WTI'), { code: 'WTI', name: 'WTI', value: 100.36, change: 0.89, pct: 0.89,
  open: 99.1, high: 100.97, low: 98.84, isOpen: true, tradedAt: '2026-10-22T23:48:47-05:00' }), JSON.stringify(byCode('WTI')));
check('미국채 10년 — 전일 대비(fluctuations)는 금리 차라 등락률과 다르다', same(byCode('US10Y'), { code: 'US10Y',
  name: '미국채 10년', value: 4.97, change: 0.0167, pct: 0.34, open: 4.957, high: 4.971, low: 4.945, isOpen: true,
  tradedAt: '2026-10-23T00:49:17-04:00' }), JSON.stringify(byCode('US10Y')));
extras = { ...extrasFixture, futures: { datas: [{ ...extrasFixture.futures.datas[0], reutersCode: 'EScv1' }] } };
check('다른 선물이 오면 빼고 나머지는 보인다', same((await handlers['quote:indices']({})).items.map((i) => i.code),
  ['KOSPI', 'KOSDAQ', 'NASDAQ', 'SPX', 'WTI', 'US10Y', 'USDKRW']));
extras = extrasFixture;
failUrl = '/marketindex/bond/';
const noBond = await handlers['quote:indices']({});
check('국채가 실패해도 나머지는 보인다', noBond.ok && same(noBond.items.map((i) => i.code),
  ['KOSPI', 'KOSDAQ', 'NASDAQ', 'SPX', 'NQ', 'WTI', 'USDKRW']), JSON.stringify(noBond.items?.map((i) => i.code)));
failUrl = null;
extras = null; // 아래 실패 검사는 원래의 넷(국내 · 미국 지수)으로 본다
fxBody.chart.result[0].meta.chartPreviousClose = undefined;

// 하나가 실패해도 나머지는 보인다
failUrl = '/domestic/index/';
let part = await handlers['quote:indices']({});
check('국내 지수가 실패해도 미국 지수는 보인다', part.ok && same(part.items.map((i) => i.code), ['NASDAQ', 'SPX']),
  JSON.stringify(part));
failUrl = '/worldstock/index/';
part = await handlers['quote:indices']({});
check('미국 지수가 실패해도 국내 지수는 보인다', part.ok && same(part.items.map((i) => i.code), ['KOSPI', 'KOSDAQ']),
  JSON.stringify(part));
failUrl = '/index/';
fxBody = null;
part = await handlers['quote:indices']({});
check('모두 실패하면 실패를 알린다(지수 줄이 숨는다)', part.ok === false && part.error === 'HTTP 500', JSON.stringify(part));
failUrl = null;

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
