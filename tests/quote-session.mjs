// Deterministic snapshots + boundary/error cases; no Electron or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { normalizeQuote, normalizeWorldQuote, confirmedRegularClose, overFromClose, dailyRegularClose } from '../quote-session.cjs';
const require = createRequire(import.meta.url);
const read = (name) => JSON.parse(fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const paused = read('naver-break-20260915.json');
const after = read('naver-after-20260915.json');
const nxt = read('naver-nxt-20260915.json');
const now = Date.parse('2026-09-15T16:10:00+09:00');
const clone = (v) => structuredClone(v);
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`OK   ${name}`); };
const row = (patch = {}) => ({ ...clone(after.datas[0]), ...patch });

await test('OPEN+break selects AFTER_MARKET instead of regular', () => {
  const q = normalizeQuote(paused.datas[0], { now });
  assert.equal(q.price, 248000);
  assert.equal(q.session, 'after');
  assert.equal(q.open, false);
  assert.equal(q.isTrading, true);
  assert.equal(q.regularClose, 248500);
  assert.equal(q.fromClose, -500);
  assert.equal(q.market, null); // Legacy nested source: venue not assumed.
});
await test('16:00 KRX OPEN+afterMarket is not regular and has no fabricated close', () => {
  const q = normalizeQuote(row({ overMarketPriceInfo: null }), { now });
  assert.equal(q.session, 'after');
  assert.equal(q.market, 'KRX');
  assert.equal(q.open, false);
  assert.equal(q.fromClose, null);
  assert.equal(q.regularClose, null);
});
await test('Two trading venues select KRX, not the later serialization stamp', () => {
  // A live localTradedAt is the response serialization time, not a trade time.
  const q = normalizeQuote(after.datas[1], { now, nxt: nxt.datas[1] });
  assert.equal(q.market, 'KRX');
  assert.equal(q.source, 'naver-base');
  assert.equal(q.price, Number(after.datas[1].closePriceRaw));
  assert.equal(q.prevClose, q.price - q.change);
  assert.equal(q.session, 'after');
});
await test('A microsecond-later nested after record does not outrank the KRX price', () => {
  // Captured 52us apart in one response, yet 1,000 KRW apart.
  const q = normalizeQuote(after.datas[1], { now });
  assert.equal(q.price, 1688000);
  assert.equal(q.market, 'KRX');
});
await test('NXT is selected only when the KRX record is not trading', () => {
  const stopped = row({ ...clone(after.datas[1]), marketStatus: 'CLOSE', marketStatusDetailType: 'close' });
  const q = normalizeQuote(stopped, { now, nxt: nxt.datas[1] });
  assert.equal(q.market, 'NXT');
  assert.equal(q.source, 'naver-nxt');
  assert.equal(q.price, Number(nxt.datas[1].closePriceRaw));
});
await test('Once nothing trades, the later real timestamp still wins', () => {
  const d = row({ marketSessionType: 'regularMarket', marketStatus: 'CLOSE',
    marketStatusDetailType: 'close', localTradedAt: '2026-09-15T15:30:00+09:00' });
  d.overMarketPriceInfo = { ...d.overMarketPriceInfo, overMarketStatus: 'CLOSE',
    overPrice: '247,000', localTradedAt: '2026-09-15T18:00:00+09:00' };
  const q = normalizeQuote(d, { now: Date.parse('2026-09-15T18:30:00+09:00') });
  assert.equal(q.price, 247000);
  assert.equal(q.priceSession, 'after');
  assert.equal(q.session, 'closed');
});
await test('ETF without NXT stays closed', () => {
  const q = normalizeQuote(after.datas[2], { now });
  assert.equal(q.session, 'closed');
  assert.equal(q.isTrading, false);
  assert.equal(q.fromClose, null);
});
await test('Confirmed close cache survives 16:00 but never another date', () => {
  const close = confirmedRegularClose(paused.datas[1]);
  assert.deepEqual(close, { date: '2026-09-15', price: 1690000 });
  const q = normalizeQuote(after.datas[1], { now, regularClose: close });
  assert.equal(q.price, 1688000);
  assert.equal(q.fromClose, -2000);
  assert.equal(normalizeQuote(after.datas[1], { now, regularClose: { ...close, date: '2026-09-14' } }).fromClose, null);
});
await test('Active regular price and daily after price are never saved as regular close', () => {
  assert.equal(confirmedRegularClose(row()), null);
  assert.equal(confirmedRegularClose(row({ marketSessionType: 'regularMarket', localTradedAt: '2026-09-15T15:29:00+09:00' })), null);
  assert.equal(confirmedRegularClose(row({ marketSessionType: 'regularMarket', marketStatusDetailType: 'break', localTradedAt: '2026-09-15T15:29:00+09:00' })), null);
});
await test('Unknown session enums stay unknown, not implicitly after/regular', () => {
  const q = normalizeQuote(row({ marketSessionType: 'newSession', overMarketPriceInfo: null }), { now });
  assert.equal(q.session, 'unknown');
  assert.equal(q.isTrading, null);
  assert.equal(q.open, false);
});
await test('20:00 close retains last after price and verified difference', () => {
  const q = normalizeQuote(row({ marketStatus: 'CLOSE', marketStatusDetailType: 'close',
    localTradedAt: '2026-09-15T20:00:00+09:00', overMarketPriceInfo: null }), {
    now: Date.parse('2026-09-15T20:01:00+09:00'), regularClose: { date: '2026-09-15', price: 249000 },
  });
  assert.equal(q.session, 'closed');
  assert.equal(q.priceSession, 'after');
  assert.equal(q.price, 248500);
  assert.equal(q.fromClose, -500);
});
await test('Weekend stale OPEN is not reported as live', () => {
  const q = normalizeQuote(row(), { now: Date.parse('2026-09-19T12:00:00+09:00') });
  assert.equal(q.session, 'closed');
  assert.equal(q.isTrading, false);
});
await test('New day pre excludes old after snapshot and yesterday close cache', () => {
  const d = row({ marketSessionType: 'regularMarket', marketStatus: 'CLOSE', marketStatusDetailType: 'close' });
  d.overMarketPriceInfo = { ...d.overMarketPriceInfo, tradingSessionType: 'BEFORE_MARKET',
    overPrice: '250000', localTradedAt: '2026-09-16T08:10:00+09:00' };
  const q = normalizeQuote(d, { now: Date.parse('2026-09-16T08:11:00+09:00'), regularClose: { date: '2026-09-15', price: 248500 } });
  assert.equal(q.session, 'pre');
  assert.equal(q.price, 250000);
  assert.equal(q.regularClose, null);
  assert.equal(q.fromClose, null);
});
await test('Today regular excludes previous-day nested after even if marked OPEN', () => {
  const d = row({ marketSessionType: 'regularMarket', localTradedAt: '2026-09-16T09:10:00+09:00' });
  const q = normalizeQuote(d, { now: Date.parse('2026-09-16T09:11:00+09:00') });
  assert.equal(q.session, 'regular');
  assert.equal(q.open, true);
  assert.equal(q.market, 'KRX');
});
await test('Empty/invalid numeric values are not silently converted to zero', () => {
  for (const value of [null, '', ' ', 'NaN', 'Infinity', '0', '-1']) {
    const d = row({ closePriceRaw: value, closePrice: value, overMarketPriceInfo: null });
    assert.equal(normalizeQuote(d, { now }), null, String(value));
  }
  assert.equal(normalizeQuote(row({ compareToPreviousClosePriceRaw: '', overMarketPriceInfo: null }), { now }), null);
});
await test('Missing base price may still use valid explicit NXT', () => {
  const q = normalizeQuote({ itemCode: '005930' }, { now, nxt: nxt.datas[0] });
  assert.equal(q.market, 'NXT');
  assert.equal(q.session, 'after');
});
await test('Missing/future timestamps do not create regular trading or fake close', () => {
  const q = normalizeQuote(row({ localTradedAt: '', overMarketPriceInfo: null }), { now });
  assert.equal(q.session, 'unknown');
  assert.equal(q.tradedAt, null);
  assert.equal(normalizeQuote(row({ localTradedAt: '2026-09-16T16:00:00+09:00', overMarketPriceInfo: null }), { now }), null);
});
await test('Daily meta after the exchange end time is a confirmed close', () => {
  // Yahoo meta measured 2026-09-15: regularMarketTime 15:30:22 KST, endTime 1530.
  const meta = { price: 248500, timeMs: Date.parse('2026-09-15T15:30:22+09:00') };
  assert.deepEqual(dailyRegularClose(meta, '1530'), { date: '2026-09-15', price: 248500 });
});
await test('Daily meta still inside the 20-minute delay is rejected', () => {
  const meta = { price: 247000, timeMs: Date.parse('2026-09-15T15:10:00+09:00') };
  assert.equal(dailyRegularClose(meta, '1530'), null);
  assert.equal(dailyRegularClose(meta, ''), null); // No exchange end time to compare.
  assert.equal(dailyRegularClose({ price: 0, timeMs: Date.parse('2026-09-15T15:31:00+09:00') }, '1530'), null);
  assert.equal(dailyRegularClose({ price: 248500, timeMs: NaN }, '1530'), null);
});
await test('A holiday keeps yesterday date so it never matches today price', () => {
  const stale = dailyRegularClose({ price: 248500, timeMs: Date.parse('2026-09-14T15:30:10+09:00') }, '1530');
  assert.equal(stale.date, '2026-09-14');
  assert.equal(normalizeQuote(after.datas[0], { now, regularClose: stale }).fromClose, null);
});
await test('Difference arithmetic includes zero and never pre session', () => {
  assert.equal(overFromClose(100, 100, 'after'), 0);
  assert.equal(overFromClose(100, 110, 'after'), 10);
  assert.equal(overFromClose(100, 110, 'pre'), null);
  assert.equal(overFromClose(null, 110, 'after'), null);
});

// US (Naver worldstock). Measured 2026-10-14: 17:08 KST is 04:08 New York, four minutes
// into pre-market; 16:57 KST was just before it. 2026-10-15 09:54 KST is after the after-market
// ended (20:00 New York). The regular and live after-market states below are built from the
// measured records by changing only the status/time fields.
const usPre = read('naver-us-pre-20261014.json');
const usPreopen = read('naver-us-preopen-20261014.json');
const usAfterClose = read('naver-us-afterclose-20261015.json');
const usNow = Date.parse('2026-10-14T17:08:34+09:00');
const soxl = (patch = {}) => ({ ...clone(usPre.datas[0]), ...patch });
const overOf = (patch) => ({ ...clone(usPre.datas[0].overMarketPriceInfo), ...patch });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

await test('US pre-market: over price measured from the last regular close', () => {
  const q = normalizeWorldQuote(usPre.datas[0], { now: usNow });
  assert.equal(q.price, 127.52);
  assert.equal(q.prevClose, 127.57);
  near(q.change, -0.05);
  assert.equal(q.session, 'pre');
  assert.equal(q.priceSession, 'pre');
  assert.equal(q.isTrading, true);
  assert.equal(q.open, false);
  assert.equal(q.regularClose, 127.57); // The day candle (yesterday's session) closes there.
  assert.equal(q.fromClose, null);
  assert.deepEqual(q.candle, { open: 118.42, high: 127.92, low: 115.84 });
  assert.equal(q.market, 'AMEX');
  assert.equal(q.source, 'naver-us-over');
  assert.equal(q.tradedAt, '2026-10-14T04:08:30-04:00');
  // HHMM fields are Korean clock times elsewhere; New York's 0930/1600 must not leak in.
  assert.equal(q.openTime, null);
  assert.equal(q.closeTime, null);
  // The rebuilt change equals Naver's own pre-market change for every captured stock.
  for (const d of usPre.datas) {
    near(normalizeWorldQuote(d, { now: usNow }).change, Number(d.overMarketPriceInfo.compareToPreviousClosePrice));
  }
});
await test('US PREOPEN (change reset to 0.00) is not used', () => {
  assert.equal(normalizeWorldQuote(usPreopen.datas[0], { now: Date.parse('2026-10-14T16:57:56+09:00') }), null);
  assert.equal(normalizeWorldQuote(soxl({ marketStatus: 'SOMETHING_NEW' }), { now: usNow }), null);
});
await test('US regular: OPEN on the exchange date is trading, across Korean midnight', () => {
  // 23:59 KST on the 14th is 10:59 New York; a minute later Korea is on the 15th, New York is not.
  const d = soxl({ marketStatus: 'OPEN', localTradedAt: '2026-10-14T10:59:00-04:00', overMarketPriceInfo: null });
  const q = normalizeWorldQuote(d, { now: Date.parse('2026-10-15T00:00:30+09:00') });
  assert.equal(q.session, 'regular');
  assert.equal(q.open, true);
  assert.equal(q.isTrading, true);
  assert.equal(q.price, 127.57);
  assert.equal(q.prevClose, 127.57 + 0.83);
  assert.equal(q.regularClose, null);
  assert.equal(q.source, 'naver-us');
  const old = normalizeWorldQuote(d, { now: Date.parse('2026-10-15T23:00:00+09:00') });
  assert.equal(old.session, 'unknown'); // OPEN stamped on another exchange day.
  assert.equal(old.isTrading, null);
  const halted = normalizeWorldQuote({ ...d, tradeStopType: { name: 'HALT' } }, { now: Date.parse('2026-10-15T00:00:30+09:00') });
  assert.equal(halted.open, false);
});
await test('US after the after-market: last after price, change from the previous close, difference from today\'s close', () => {
  // Measured: SOXL closed 110.54 (-17.03 from 127.57), after-market ended at 103.61.
  const now = Date.parse('2026-10-15T09:54:12+09:00');
  const q = normalizeWorldQuote(usAfterClose.datas[0], { now });
  assert.equal(q.session, 'closed');
  assert.equal(q.priceSession, 'after');
  assert.equal(q.isTrading, false);
  assert.equal(q.price, 103.61);
  near(q.prevClose, 127.57);
  near(q.change, 103.61 - 127.57);
  assert.equal(q.regularClose, 110.54);
  near(q.fromClose, -6.93);
  // Naver's own after-market change is measured from today's close: it equals fromClose for every stock.
  for (const d of usAfterClose.datas) {
    near(normalizeWorldQuote(d, { now }).fromClose, Number(d.overMarketPriceInfo.compareToPreviousClosePrice));
  }
});
await test('US live after-market: the same record while overMarketStatus is OPEN is trading', () => {
  const d = clone(usAfterClose.datas[0]);
  d.overMarketPriceInfo.overMarketStatus = 'OPEN';
  d.overMarketPriceInfo.localTradedAt = '2026-10-14T16:59:00-04:00';
  const q = normalizeWorldQuote(d, { now: Date.parse('2026-10-15T06:00:00+09:00') }); // 17:00 New York
  assert.equal(q.session, 'after');
  assert.equal(q.isTrading, true);
  near(q.fromClose, -6.93);
});
await test('US over record older than the close, or from another day, is not live', () => {
  // Yesterday's after-market left in the response once today's close is in.
  const stale = soxl({ localTradedAt: '2026-10-14T16:00:00-04:00', overMarketPriceInfo: overOf({ tradingSessionType: 'AFTER_MARKET',
    overPrice: '120.00', localTradedAt: '2026-10-13T19:59:00-04:00' }) });
  const q = normalizeWorldQuote(stale, { now: Date.parse('2026-10-15T05:30:00+09:00') });
  assert.equal(q.price, 127.57);
  assert.equal(q.priceSession, 'regular');
  assert.equal(q.session, 'closed');
  assert.equal(q.regularClose, 127.57);
  // Friday's after-market still marked OPEN on Saturday.
  const fri = soxl({ localTradedAt: '2026-10-16T16:00:00-04:00', overMarketPriceInfo: overOf({ tradingSessionType: 'AFTER_MARKET',
    localTradedAt: '2026-10-16T19:59:00-04:00' }) });
  const sat = normalizeWorldQuote(fri, { now: Date.parse('2026-10-17T15:00:00+09:00') });
  assert.equal(sat.session, 'closed');
  assert.equal(sat.isTrading, false);
  // An unknown over status is unknown, not trading or closed.
  const odd = normalizeWorldQuote(soxl({ overMarketPriceInfo: overOf({ overMarketStatus: 'NEW' }) }), { now: usNow });
  assert.equal(odd.session, 'unknown');
  assert.equal(odd.isTrading, null);
});
await test('US invalid numbers and future stamps are rejected', () => {
  for (const value of [null, '', 'NaN', '0', '-1']) {
    assert.equal(normalizeWorldQuote(soxl({ closePriceRaw: value, closePrice: value }), { now: usNow }), null, String(value));
  }
  assert.equal(normalizeWorldQuote(soxl({ compareToPreviousClosePriceRaw: '', compareToPreviousClosePrice: '' }), { now: usNow }), null);
  assert.equal(normalizeWorldQuote(soxl({ localTradedAt: '' }), { now: usNow }), null);
  assert.equal(normalizeWorldQuote(soxl({ localTradedAt: '2026-10-14T05:00:00-04:00' }), { now: usNow }), null);
  assert.equal(normalizeWorldQuote(undefined, { now: usNow }), null);
  // A broken over price falls back to the regular close, not to zero.
  const q = normalizeWorldQuote(soxl({ overMarketPriceInfo: overOf({ overPrice: '' }) }), { now: usNow });
  assert.equal(q.price, 127.57);
  assert.equal(q.session, 'closed');
});

// Exercise the actual IPC adapter with the same snapshots and fake transport.
// No source rewriting, Electron launch, user profile, or real market dependency.
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const start = main.indexOf("ipcMain.handle('quote:realtime'");
const end = main.indexOf('// 지수 줄 (실시간)', start);
if (end < 0) throw new Error('main.js 의 지수 줄 주석을 찾지 못했다 — quote:realtime 끝을 못 자른다');
let handler;
let baseResponse = paused;
let nxtResponse = { datas: [] };
let failed = new Set();
let yahooCalls = [];
// Measured Yahoo meta for 000660 on 2026-09-15: the regular close stamped after 15:30.
let yahooResponse = { chart: { result: [{ meta: { regularMarketPrice: 1690000,
  regularMarketTime: Date.parse('2026-09-15T15:30:22+09:00') / 1000 } }] } };
const tried = new Map();
const cache = new Map();
let clockNow = now;
class Clock extends Date { static now() { return clockNow; } }
// US: ticker → Naver code (autoComplete in the app), then one worldstock request.
const usCodes = { SOXL: 'SOXL.K', AAPL: 'AAPL.O', NVDA: 'NVDA.O' };
let usCalls = [];
let usAsked = [];
vm.runInNewContext(main.slice(start, end), {
  ipcMain: { handle: (_, fn) => { handler = fn; } },
  ...require('../quote-session.cjs'), Date: Clock, AbortSignal,
  regularCloseCache: cache, regularCloseTried: tried, CLOSE_RETRY: 300000, FORCE_SESSION: '',
  naverUsCode: async (s) => { usAsked.push(s); return usCodes[s] ?? null; },
  // 국내 KRX · NXT 도 naverJson 으로 묻는다(main.js 의 네이버 요청은 이것 하나) — 주소로 가른다
  naverJson: async (url) => {
    if (url.includes('/domestic/')) {
      const venue = url.includes('/NXT/') ? 'NXT' : 'KRX';
      if (failed.has(venue)) throw new Error('fixture failure');
      return venue === 'NXT' ? nxtResponse : baseResponse;
    }
    usCalls.push(url);
    if (failed.has('US')) throw new Error('fixture failure');
    return usPre;
  },
  netFetch: async (url) => { // 야후 일봉(애프터마켓 종가 되찾기)만 여기로 온다
    yahooCalls.push(url);
    if (failed.has('YAHOO')) throw new Error('fixture failure');
    return { ok: true, json: async () => yahooResponse };
  },
});
await test('IPC carries verified close from break snapshot into after session', async () => {
  let r = await handler(null, ['005930.KS', '000660.KS', '069500.KS']);
  assert.equal(r.quotes['005930'].fromClose, -500);
  baseResponse = after;
  nxtResponse = nxt;
  r = await handler(null, ['005930.KS', '000660.KS', '069500.KS']);
  assert.equal(r.quotes['000660'].regularClose, 1690000);
  assert.equal(r.quotes['000660'].session, 'after');
  assert.equal(r.quotes['000660'].market, 'KRX'); // Both trading: venue order decides.
  assert.equal(r.quotes['069500'].session, 'closed');
});
await test('IPC cold start in after-market recovers the close from daily data', async () => {
  tried.clear();
  cache.clear(); // Nothing captured: the app started after the regular session.
  yahooCalls = [];
  baseResponse = after;
  nxtResponse = { datas: [] };
  const r = await handler(null, ['000660.KS', '069500.KS']);
  assert.equal(r.quotes['000660'].session, 'after');
  assert.equal(r.quotes['000660'].regularClose, 1690000);
  assert.equal(r.quotes['000660'].fromClose, -2000); // 1,688,000 - 1,690,000
  assert.equal(yahooCalls.length, 1); // Only the after-market symbol, by its own symbol.
  assert.match(yahooCalls[0], /chart\/000660\.KS\?/);
  assert.equal(r.quotes['069500'].fromClose, null); // A closed ETF asks for nothing.
});
await test('IPC asks for the daily close once, then uses the cache', async () => {
  yahooCalls = [];
  const r = await handler(null, ['000660.KS']);
  assert.equal(r.quotes['000660'].fromClose, -2000);
  assert.equal(yahooCalls.length, 0);
});
await test('IPC daily failure leaves the price alone and keeps no close', async () => {
  tried.clear();
  cache.clear();
  failed = new Set(['YAHOO']);
  const r = await handler(null, ['005930.KS']);
  failed = new Set();
  assert.equal(r.quotes['005930'].session, 'after');
  assert.equal(r.quotes['005930'].price, 248500);
  assert.equal(r.quotes['005930'].fromClose, null);
});
await test('IPC cold start ignores a daily close from another day (Yahoo a day behind)', async () => {
  tried.clear();
  cache.clear();
  baseResponse = after;
  nxtResponse = { datas: [] };
  const today = yahooResponse;
  yahooResponse = { chart: { result: [{ meta: { regularMarketPrice: 1700000,
    regularMarketTime: Date.parse('2026-09-14T15:30:22+09:00') / 1000 } }] } };
  const r = await handler(null, ['000660.KS']);
  yahooResponse = today;
  assert.equal(r.quotes['000660'].session, 'after');
  assert.equal(r.quotes['000660'].regularClose, null, '어제 종가를 오늘 종가로 붙이지 않는다');
  assert.equal(r.quotes['000660'].fromClose, null);
  assert.equal(cache.has('000660'), false, '다른 날 종가는 기억하지 않는다');
});
await test('IPC single-venue failure keeps usable price, not false all-closed', async () => {
  failed = new Set(['NXT']);
  const r = await handler(null, ['069500.KS']);
  assert.equal(r.ok, true);
  assert.equal(r.quotes['069500'].isTrading, null);
  assert.equal(r.quotes['069500'].session, 'unknown');
});
await test('IPC both venues failed requests Yahoo fallback', async () => {
  failed = new Set(['KRX', 'NXT']);
  assert.equal((await handler(null, ['005930.KS'])).ok, false);
});
await test('IPC US: one worldstock request, quotes keyed by the Yahoo ticker', async () => {
  failed = new Set();
  clockNow = usNow;
  usCalls = [];
  usAsked = [];
  const r = await handler(null, ['SOXL', 'AAPL', 'BRK-B', '^KS11', 'KRW=X', '005930.KS']);
  assert.deepEqual([...usAsked], ['SOXL', 'AAPL', 'BRK-B'], 'only US tickers are looked up on Naver');
  clockNow = now;
  assert.equal(r.ok, true);
  // BRK-B has no Naver code; ^ and = are not US stocks. Domestic keeps its code key.
  assert.deepEqual(Object.keys(r.quotes).sort(), ['005930', 'AAPL', 'SOXL']);
  assert.equal(r.quotes.SOXL.session, 'pre');
  assert.equal(r.quotes.SOXL.price, 127.52);
  assert.equal(usCalls.length, 1);
  assert.equal(usCalls[0], 'https://polling.finance.naver.com/api/realtime/worldstock/stock/SOXL.K,AAPL.O');
});
await test('IPC US and domestic fail independently', async () => {
  clockNow = usNow;
  failed = new Set(['KRX', 'NXT']); // Domestic down, US up: US quotes still arrive.
  let r = await handler(null, ['005930.KS', 'SOXL']);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.quotes), ['SOXL']);
  failed = new Set(['US']); // US down, domestic up: the domestic answer is unchanged.
  baseResponse = after;
  nxtResponse = nxt;
  clockNow = now;
  r = await handler(null, ['005930.KS', 'SOXL']);
  assert.equal(r.ok, true);
  assert.equal(r.quotes.SOXL, undefined);
  assert.equal(r.quotes['005930'].session, 'after');
  failed = new Set(['US']);
  // Renderer falls back to Yahoo. (JSON: the vm's objects are from another realm.)
  assert.equal(JSON.stringify(await handler(null, ['SOXL'])), '{"ok":true,"quotes":{}}');
  failed = new Set();
});

// The day candle must describe the integrated (KRX + NXT) session, the way a
// broker's chart does. The top-level open/high/low are KRX only, and on a day
// when NXT opened first the two disagree: this fixture opens at 248,000 on KRX
// but 245,500 integrated - a large body with no upper shadow versus a small one
// with a long shadow. Confirmed live on 2026-09-22 (283,000 KRX, 279,000 both).
await test('day candle uses the integrated session, not KRX alone', () => {
  const q = normalizeQuote(paused.datas[0], { now });
  assert.deepEqual(q.candle, { open: 245500, high: 252000, low: 245000 });
  // KRX 만의 값도 같이 준다 — 일봉 차트의 캔들 기준을 KRX 로 고르면 오늘 캔들이 이것이다
  assert.deepEqual(q.krxCandle, { open: 248000, high: 252000, low: 246000 });
});
await test('day candle falls back to KRX when no integrated block is given', () => {
  const q = normalizeQuote(row({ integratedPriceInfo: null }), { now });
  assert.equal(q.candle.open, 248000);
});
await test('day candle is null when the open is missing', () => {
  const q = normalizeQuote(row({ integratedPriceInfo: null, openPriceRaw: null, openPrice: null }), { now });
  assert.equal(q.candle, null);
});
await test('regular open time comes from the exchange metadata; malformed values are dropped', () => {
  assert.equal(normalizeQuote(paused.datas[0], { now }).openTime, '0900');
  const late = row({ stockExchangeType: { ...after.datas[0].stockExchangeType, startTime: '1000' } });
  assert.equal(normalizeQuote(late, { now }).openTime, '1000'); // e.g. college entrance exam day
  const bad = row({ stockExchangeType: { ...after.datas[0].stockExchangeType, startTime: '9:00' } });
  assert.equal(normalizeQuote(bad, { now }).openTime, null);
});
await test('regular close time comes from the exchange metadata too (1D chart close point label)', () => {
  assert.equal(normalizeQuote(paused.datas[0], { now }).closeTime, '1530');
  const bad = row({ stockExchangeType: { ...after.datas[0].stockExchangeType, endTime: '15:30' } });
  assert.equal(normalizeQuote(bad, { now }).closeTime, null);
});
console.log(`\nPASS: ${count} deterministic session cases`);
