// 1D 차트의 시간외(프리 · 애프터) 봉 — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 yf:chart 를 부른다.
//
// 미국은 야후가 includePrePost 로 프리 · 애프터 봉을 같이 주고, 응답의 tradingPeriods 가 정규장 구간이다.
// 국내는 야후가 15:30 까지만 줘서 네이버 NXT 분봉(프리 08:00~08:50 · 애프터 15:40~20:00)을 5분봉으로
// 묶어 붙인다. 응답 모양은 2026-10-14 실측(SOXL · 삼성전자)에서 쓰는 필드만 옮겼다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

let NOW = 0;
class FixedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
const kst = (s) => Date.parse(`${s}+09:00`); // '2026-10-14T17:00' → ms
const hm = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(11, 16);

// 야후 5분봉 응답. bars = [['2026-10-14T09:00', 종가], ...], 정규장 구간은 tradingPeriods 로.
const yahoo = (bars, regular) => ({
  chart: { result: [{
    timestamp: bars.map(([t]) => kst(t) / 1000),
    indicators: { quote: [{
      close: bars.map(([, c]) => c),
      open: bars.map(([, c]) => c), high: bars.map(([, c]) => c + 1), low: bars.map(([, c]) => c - 1),
      volume: bars.map(() => 100),
    }] },
    meta: { regularMarketPrice: bars.length ? bars.at(-1)[1] : 1, currency: 'KRW',
      ...(regular ? { tradingPeriods: { regular: [[{ start: kst(regular[0]) / 1000, end: kst(regular[1]) / 1000 }]] } } : {}) },
  }] },
});
// 네이버 분봉 한 줄(실제 응답 모양). accumulatedTradingVolume 은 그 1분의 거래량이다.
const minute = (t, c, v = 10, o = c, h = c, l = c) => ({ localDateTime: `${t.replace(/\D/g, '')}00`,
  currentPrice: c, openPrice: o, highPrice: h, lowPrice: l, accumulatedTradingVolume: v });

let yahooBody = null;
const yahooCalls = [];
const naverCalls = [];
let naverReply = () => [];
const fakeFetch = async (url) => {
  url = String(url);
  if (url.includes('api.stock.naver.com')) {
    naverCalls.push(url);
    const body = naverReply(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  }
  yahooCalls.push(url);
  return { ok: true, status: 200, json: async () => yahooBody };
};

new Function('require', 'process', 'fetch', 'AbortSignal', 'Date', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal, FixedDate);

const oneDay = (symbol, extended = true) => handlers['yf:chart']({}, { symbol, range: '1d', interval: '5m', extended });
const runs = (r) => (r.ext || []).map((e, i) => `${hm(r.times[i])}${e ? `:${e}` : ''}`).join(' ');

// --- 1. 미국: 야후 프리 · 애프터 봉, tradingPeriods 로 세션을 단다 ----------------------
{
  NOW = kst('2026-10-14T06:00');
  yahooBody = yahoo([['2026-10-13T17:00', 120], ['2026-10-13T17:05', 121], ['2026-10-13T22:30', 122],
    ['2026-10-13T22:35', 123], ['2026-10-14T05:00', 124], ['2026-10-14T05:20', 125], ['2026-10-14T05:25', 126]],
  ['2026-10-13T22:30', '2026-10-14T05:00']);
  let r = await oneDay('SOXL');
  check('미국 1D 는 야후에 프리 · 애프터를 같이 묻는다', /[?&]includePrePost=true/.test(yahooCalls.at(-1)), yahooCalls.at(-1));
  check('봉마다 세션: 정규장 앞은 pre, 끝(05:00)부터 after',
    same(r.ext.slice(0, 4), ['pre', 'pre', null, null]) && r.ext[4] === 'after', runs(r));
  check('애프터의 빈 5분 칸은 직전 종가로 채운다 (05:05 · 05:10 · 05:15)',
    same(r.times.map(hm).slice(4), ['05:00', '05:05', '05:10', '05:15', '05:20', '05:25'])
      && same(r.closes.slice(5, 8), [124, 124, 124]) && same(r.volumes.slice(5, 8), [0, 0, 0]), runs(r));
  check('세션이 바뀌는 곳(17:05 → 22:30, 22:35 → 05:00)은 채우지 않는다', r.closes.length === 10, `${r.closes.length}봉`);
  check('모든 배열의 길이가 같다', ['times', 'volumes', 'opens', 'highs', 'lows', 'ext']
    .every((k) => r[k].length === r.closes.length));
  check('미국은 네이버 분봉을 묻지 않는다', naverCalls.length === 0);

  yahooBody = yahoo([['2026-10-13T22:30', 122], ['2026-10-13T22:35', 123]]);
  r = await oneDay('SOXL');
  check('tradingPeriods 가 없으면 세션을 달지 않는다 (응답 모양은 예전 그대로)', r.ok && !('ext' in r), JSON.stringify(Object.keys(r)));
  r = await oneDay('SOXL', false);
  check('extended 없이 물으면 includePrePost 도 없다', !/includePrePost/.test(yahooCalls.at(-1)) && !('ext' in r));
  await handlers['yf:chart']({}, { symbol: 'SOXL', range: '5d', interval: '30m', extended: true });
  check('1D(5분봉)가 아니면 시간외를 묻지 않는다', !/includePrePost/.test(yahooCalls.at(-1)), yahooCalls.at(-1));
}

// --- 2. 국내: 야후 정규장 + 네이버 NXT 프리 · 애프터 5분봉 ----------------------------
const krYahoo = (day) => yahoo([[`${day}T09:00`, 230000], [`${day}T09:05`, 231000], [`${day}T15:00`, 232000]]);
{
  NOW = kst('2026-10-14T17:00');
  yahooBody = krYahoo('2026-10-14');
  naverReply = (url) => (url.includes('startDateTime=202610140800') ? [
    minute('2026-10-14T08:00', 237000, 100, 238000, 238500, 236500), minute('2026-10-14T08:01', 236500, 50, 237000, 237000, 236000),
    minute('2026-10-14T08:02', 237500, 30), minute('2026-10-14T08:15', 236000, 20)]
    : [minute('2026-10-14T15:40', 233000, 40), minute('2026-10-14T15:41', 233500, 5), minute('2026-10-14T15:50', 234000, 7)]);
  const r = await oneDay('005930.KS');
  check('국내는 NXT 분봉을 프리 · 애프터 구간만 묻는다', same(naverCalls,
    ['https://api.stock.naver.com/chart/domestic/NXT/item/005930/minute?startDateTime=202610140800&endDateTime=202610140850',
      'https://api.stock.naver.com/chart/domestic/NXT/item/005930/minute?startDateTime=202610141530&endDateTime=202610142000']),
  naverCalls.join(' '));
  check('국내 야후 요청에는 includePrePost 를 붙이지 않는다 (국내는 15:30 까지만 준다)', !/includePrePost/.test(yahooCalls.at(-1)));
  check('프리 → 정규장 → 애프터가 시각 순서로 이어진다', same(r.times.map(hm),
    ['08:00', '08:05', '08:10', '08:15', '09:00', '09:05', '15:00', '15:40', '15:45', '15:50']), runs(r));
  check('세션: 프리 4칸 · 정규장 3칸 · 애프터 3칸', same(r.ext,
    ['pre', 'pre', 'pre', 'pre', null, null, null, 'after', 'after', 'after']), JSON.stringify(r.ext));
  check('1분봉 셋을 5분봉 하나로: 시가는 첫 봉, 종가는 끝 봉, 고 · 저는 전체, 거래량은 합',
    same([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes[0]], [238000, 238500, 236000, 237500, 180]),
    JSON.stringify([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes[0]]));
  check('빈 칸(08:05 · 08:10 · 15:45)은 직전 종가 · 거래량 0', same([r.closes[1], r.closes[2], r.closes[8]], [237500, 237500, 233500])
    && same([r.volumes[1], r.volumes[2], r.volumes[8]], [0, 0, 0]));
  check('정규장 봉은 야후 값 그대로', same(r.closes.slice(4, 7), [230000, 231000, 232000]));

  // 캐시: 끝난 창(프리)은 다시 묻지 않고, 진행 중인 창(애프터)은 30초 뒤에 다시 묻는다
  naverCalls.length = 0;
  NOW = kst('2026-10-14T17:00') + 10000;
  await oneDay('005930.KS');
  check('30초 안에는 다시 묻지 않는다', naverCalls.length === 0, naverCalls.join(' '));
  NOW = kst('2026-10-14T17:00') + 40000;
  await oneDay('005930.KS');
  check('30초가 지나면 진행 중인 애프터 창만 다시 묻는다', naverCalls.length === 1 && naverCalls[0].includes('1530'), naverCalls.join(' '));
  NOW = kst('2026-10-14T20:01');
  await oneDay('005930.KS');
  NOW = kst('2026-10-14T21:00');
  await oneDay('005930.KS');
  check('20:00 이 지나 받은 애프터 창은 끝난 것으로 기억한다', naverCalls.length === 2, `${naverCalls.length}번`);
}

// --- 3. 프리마켓이 열리면 새 하루 · 열리기 전에는 어제 하루 ---------------------------
{
  naverCalls.length = 0;
  NOW = kst('2026-10-15T08:30');
  yahooBody = krYahoo('2026-10-14'); // 야후는 아직 어제 정규장
  naverReply = (url) => (url.includes('20261015') ? [minute('2026-10-15T08:00', 240000), minute('2026-10-15T08:25', 241000)] : []);
  let r = await oneDay('000660.KS');
  check('08:30 에는 오늘 프리 창만 묻는다 (애프터는 아직)', same(naverCalls,
    ['https://api.stock.naver.com/chart/domestic/NXT/item/000660/minute?startDateTime=202610150800&endDateTime=202610150850']),
  naverCalls.join(' '));
  check('오늘 프리 봉만 남고 어제 정규장은 빠진다', r.ok && r.ext.every((e) => e === 'pre')
    && hm(r.times[0]) === '08:00' && hm(r.times.at(-1)) === '08:25' && r.closes.at(-1) === 241000, runs(r));

  naverCalls.length = 0;
  NOW = kst('2026-10-15T07:00');
  naverReply = (url) => (url.includes('202610140800') ? [minute('2026-10-14T08:00', 229000)]
    : url.includes('202610141530') ? [minute('2026-10-14T19:55', 233000)] : []);
  r = await oneDay('035420.KS');
  check('08:00 전에는 야후 봉의 날(어제)의 두 창을 묻는다', naverCalls.length === 2 && naverCalls.every((u) => u.includes('20261014')),
    naverCalls.join(' '));
  check('어제 하루가 프리 · 정규장 · 애프터로 이어진다', same(r.ext, ['pre', null, null, null, 'after']), runs(r));
}

// --- 4. 시간외가 없거나 네이버가 실패하면 예전처럼 정규장만 -----------------------------
{
  naverCalls.length = 0;
  NOW = kst('2026-10-14T17:00');
  yahooBody = krYahoo('2026-10-14');
  naverReply = () => []; // ETF 는 NXT 에 없어 빈 배열이다(2026-10-14 실측 069500)
  let r = await oneDay('069500.KS');
  check('ETF: 정규장만, 응답 모양은 예전 그대로', r.ok && !('ext' in r) && r.closes.length === 3, JSON.stringify(Object.keys(r)));

  naverCalls.length = 0;
  naverReply = () => new TypeError('fetch failed');
  r = await oneDay('207940.KS');
  check('네이버가 실패해도 정규장 차트는 나온다', r.ok && !('ext' in r) && r.closes.length === 3);
  naverReply = (url) => (url.includes('0800') ? [minute('2026-10-14T08:00', 1000000)] : []);
  r = await oneDay('207940.KS');
  check('실패는 기억하지 않고 다음에 다시 묻는다', naverCalls.length === 4 && r.ext && r.ext[0] === 'pre', `${naverCalls.length}번`);

  naverCalls.length = 0;
  NOW = kst('2026-10-15T09:10');
  yahooBody = yahoo([]); // 장 시작 직후: 야후 국내 분봉은 20분 늦어 비어 있다
  naverReply = (url) => (url.includes('20261015') ? [minute('2026-10-15T08:00', 50000), minute('2026-10-15T08:45', 50500)] : []);
  r = await oneDay('005380.KS');
  check('야후가 비어 있어도 오늘 프리 봉은 그린다', r.ok && r.ext.every((e) => e === 'pre') && r.closes.at(-1) === 50500, runs(r));
  naverReply = () => [];
  r = await oneDay('000270.KS');
  check('야후도 비고 프리도 없으면 예전처럼 빈 데이터', !r.ok && r.error === '빈 데이터', JSON.stringify(r));

  naverCalls.length = 0;
  await handlers['yf:chart']({}, { symbol: '^KS11', range: '1d', interval: '5m', extended: true });
  await handlers['yf:chart']({}, { symbol: '005930.KS', range: '5d', interval: '30m', extended: true });
  check('지수와 1W 는 네이버 분봉을 묻지 않는다', naverCalls.length === 0, naverCalls.join(' '));
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
