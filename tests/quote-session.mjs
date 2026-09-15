// Deterministic snapshots + boundary/error cases; no Electron or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { normalizeQuote, confirmedRegularClose, overFromClose, dailyRegularClose } from '../quote-session.cjs';
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

// Exercise the actual IPC adapter with the same snapshots and fake transport.
// No source rewriting, Electron launch, user profile, or real market dependency.
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const start = main.indexOf("ipcMain.handle('quote:realtime'");
const end = main.indexOf('// 코스피/코스닥 지수', start);
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
class Clock extends Date { static now() { return now; } }
vm.runInNewContext(main.slice(start, end), {
  ipcMain: { handle: (_, fn) => { handler = fn; } },
  ...require('../quote-session.cjs'), Date: Clock, AbortSignal,
  regularCloseCache: cache, regularCloseTried: tried, CLOSE_RETRY: 300000, FORCE_SESSION: '',
  netFetch: async (url) => {
    if (url.includes('finance.yahoo.com')) {
      yahooCalls.push(url);
      if (failed.has('YAHOO')) throw new Error('fixture failure');
      return { ok: true, json: async () => yahooResponse };
    }
    const venue = url.includes('/NXT/') ? 'NXT' : 'KRX';
    if (failed.has(venue)) throw new Error('fixture failure');
    return { ok: true, json: async () => venue === 'NXT' ? nxtResponse : baseResponse };
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
console.log(`\nPASS: ${count} deterministic session cases`);
