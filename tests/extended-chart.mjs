// 1D · 1W 차트의 시간외(프리 · 애프터) 봉 — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 yf:chart 를 부른다.
// 1D 는 5분봉, 1W 는 30분봉이다. 렌더러의 정규장 / 전체 버튼이 extended 로 고른다(정규장이면 false).
//
// 미국은 야후가 includePrePost 로 프리 · 애프터 봉을 같이 주고, 응답의 tradingPeriods 가 정규장 구간이다.
// 국내는 야후가 15:30 까지만 줘서 네이버 NXT 분봉(프리 08:00~08:50 · 애프터 15:40~20:00)을 5분봉으로
// 묶어 붙인다. 응답 모양은 2026-10-14 실측(SOXL · 삼성전자)에서 쓰는 필드만 옮겼다.
// 국내 정규장은 네이버 KRX 분봉(실시간)으로 그리고 실패하거나 비면 야후다(6번). 2~5번은 KRX 분봉이 비어 야후로 그린다.
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
// 국내 정규장(KRX) 분봉 · 일봉 — 기본은 빈 응답이라 야후로 그린다(6번에서 채운다)
const krxCalls = [];
let krxReply = () => [];
let pollingBody = { datas: [] }; // 지수 줄 응답(6번 — 그날 장 종료 시각)
// 네이버 모바일 하루 차트(7번 — 지수 줄의 선물 · 미국채 1D). 기본은 빈 응답이라 야후로 그린다.
const frontCalls = [];
let frontReply = () => null;
const fakeFetch = async (url) => {
  url = String(url);
  if (/\/chart\/domestic\/(item|index)\//.test(url)) {
    krxCalls.push(url);
    const body = krxReply(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  }
  if (url.includes('polling.finance.naver.com')) return { ok: true, status: 200, json: async () => pollingBody };
  if (url.includes('m.stock.naver.com/front-api/')) {
    frontCalls.push(url);
    const body = frontReply(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  }
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
  await handlers['yf:chart']({}, { symbol: 'SOXL', range: '1mo', interval: '1d', extended: true });
  check('분봉(1D · 1W)이 아니면 시간외를 묻지 않는다', !/includePrePost/.test(yahooCalls.at(-1)), yahooCalls.at(-1));
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
  await handlers['yf:chart']({}, { symbol: '005930.KS', range: '1mo', interval: '1d', extended: true });
  check('지수와 일봉은 NXT 시간외 분봉을 묻지 않는다', naverCalls.length === 0, naverCalls.join(' '));
}

// --- 5. 1W(30분봉) ------------------------------------------------------------------------
// 야후 5d 응답의 정규장 구간은 날마다 하나다(tradingPeriods.regular = [[하루], [하루], …], 2026-10-21 실측).
const yahooDays = (bars, periods) => {
  const body = yahoo(bars);
  body.chart.result[0].meta.tradingPeriods = { regular: periods.map(([a, b]) => [{ start: kst(a) / 1000, end: kst(b) / 1000 }]) };
  return body;
};
const oneWeek = (symbol, extended = true) => handlers['yf:chart']({}, { symbol, range: '5d', interval: '30m', extended });
const md = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' '); // '10-14 08:00'
const weekRuns = (r) => r.times.map((t, i) => `${md(t)}${r.ext && r.ext[i] ? `:${r.ext[i]}` : ''}`).join(' | ');
{
  // 미국: 야후 프리 · 애프터, 봉마다 그날의 정규장 구간으로 세션을 단다
  NOW = kst('2026-10-15T07:00');
  yahooCalls.length = 0; naverCalls.length = 0;
  yahooBody = yahooDays([['2026-10-13T17:00', 100], ['2026-10-13T22:30', 101], ['2026-10-13T23:00', 102],
    ['2026-10-14T05:00', 103], ['2026-10-14T06:00', 104],
    ['2026-10-14T17:00', 105], ['2026-10-14T22:30', 106], ['2026-10-15T05:00', 107]],
  [['2026-10-13T22:30', '2026-10-14T05:00'], ['2026-10-14T22:30', '2026-10-15T05:00']]);
  let r = await oneWeek('SOXL');
  check('미국 1W 도 야후에 프리 · 애프터를 묻는다', /range=5d&interval=30m&includePrePost=true/.test(yahooCalls.at(-1)), yahooCalls.at(-1));
  check('둘째 날 프리(10/14 17:00)는 첫날 정규장 뒤라도 pre — 날마다 그날의 정규장 구간', same(r.ext,
    ['pre', null, null, 'after', 'after', 'after', 'pre', null, 'after']), weekRuns(r));
  check('애프터의 빈 30분 칸(05:30)은 직전 종가 · 거래량 0', md(r.times[4]) === '10-14 05:30' && r.closes[4] === 103 && r.volumes[4] === 0,
    weekRuns(r));
  check('미국은 네이버 분봉을 묻지 않는다', naverCalls.length === 0);
  r = await oneWeek('SOXL', false);
  check('정규장만(extended false)이면 includePrePost 없이', !/includePrePost/.test(yahooCalls.at(-1)) && !('ext' in r));
}
{
  // 국내: 야후 30분봉(정규장) + 날마다 NXT 프리 · 애프터를 30분 칸으로. 앞 절에서 쓰지 않은 종목이다 —
  // 네이버 창 캐시는 종목 · 날 · 창마다라 같은 종목이면 앞 절이 받아 둔 10/14 창을 그대로 쓴다.
  NOW = kst('2026-10-15T17:00');
  naverCalls.length = 0;
  yahooBody = yahoo([['2026-10-14T09:00', 230000], ['2026-10-14T09:30', 231000], ['2026-10-14T14:30', 232000],
    ['2026-10-15T09:00', 233000], ['2026-10-15T14:30', 234000]]);
  const replies = {
    202610140800: [minute('2026-10-14T08:00', 237000, 100, 238000, 238500, 236500), minute('2026-10-14T08:10', 236000, 20),
      minute('2026-10-14T08:31', 236500, 5)],
    202610141530: [minute('2026-10-14T15:40', 233000, 40), minute('2026-10-14T15:50', 233500, 5),
      minute('2026-10-14T16:05', 234000, 7), minute('2026-10-14T19:55', 235000, 9)],
    202610150800: [minute('2026-10-15T08:05', 239000, 3)],
    202610151530: [minute('2026-10-15T15:45', 234500, 4)],
    202610160800: [minute('2026-10-16T08:00', 240000, 6)],
  };
  naverReply = (url) => replies[/startDateTime=(\d{12})/.exec(url)[1]] || [];
  let r = await oneWeek('066570.KS');
  const asked = () => naverCalls.map((u) => /startDateTime=(\d{12})/.exec(u)[1]).sort();
  check('날마다 NXT 프리 · 애프터 창을 묻는다', same(asked(), ['202610140800', '202610141530', '202610150800', '202610151530']),
    asked().join(' '));
  check('국내 야후 요청에는 includePrePost 를 붙이지 않는다', !/includePrePost/.test(yahooCalls.at(-1)));
  check('프리 → 정규장 → 애프터가 날마다 이어진다(빈 칸은 직전 종가로)', same(r.times.map(md), ['10-14 08:00', '10-14 08:30',
    '10-14 09:00', '10-14 09:30', '10-14 14:30', '10-14 15:30', '10-14 16:00', '10-14 16:30', '10-14 17:00', '10-14 17:30',
    '10-14 18:00', '10-14 18:30', '10-14 19:00', '10-14 19:30', '10-15 08:00', '10-15 09:00', '10-15 14:30', '10-15 15:30']),
  weekRuns(r));
  check('세션: 프리 · 정규장 · 애프터, 다음 날 프리로 넘어가는 곳은 채우지 않는다', same(r.ext, ['pre', 'pre', null, null, null,
    'after', 'after', 'after', 'after', 'after', 'after', 'after', 'after', 'after', 'pre', null, null, 'after']), JSON.stringify(r.ext));
  check('1분봉을 30분봉 하나로: 시가는 첫 봉, 종가는 끝 봉, 고 · 저는 전체, 거래량은 합',
    same([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes[0]], [238000, 238500, 236000, 236000, 120]),
    JSON.stringify([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes[0]]));
  check('애프터 15:30 칸 = 15:40 · 15:50 체결', r.opens[5] === 233000 && r.closes[5] === 233500 && r.volumes[5] === 45);
  check('빈 칸(16:30~19:00)은 16:00 칸 종가 · 거래량 0', same(r.closes.slice(7, 13), Array(6).fill(234000))
    && same(r.volumes.slice(7, 13), Array(6).fill(0)));
  check('정규장 봉은 야후 값 그대로', same([r.closes[2], r.closes[3], r.closes[4], r.closes[15], r.closes[16]],
    [230000, 231000, 232000, 233000, 234000]));

  // 캐시: 지난 날 · 끝난 창은 다시 묻지 않고, 진행 중인 오늘 애프터만 30초 뒤에
  naverCalls.length = 0;
  NOW = kst('2026-10-15T17:00') + 10000;
  await oneWeek('066570.KS');
  check('30초 안에는 다시 묻지 않는다', naverCalls.length === 0, naverCalls.join(' '));
  NOW = kst('2026-10-15T17:00') + 40000;
  await oneWeek('066570.KS');
  check('30초가 지나면 오늘 애프터 창만 다시 묻는다', same(asked(), ['202610151530']), asked().join(' '));

  // 다음 날 프리마켓: 야후는 아직 어제까지 — 오늘 프리 봉을 끝에 붙인다
  naverCalls.length = 0;
  NOW = kst('2026-10-16T08:30');
  r = await oneWeek('066570.KS');
  check('다음 날 08:30: 끝나지 않았던 어제 애프터와 오늘 프리만 묻는다', same(asked(), ['202610151530', '202610160800']),
    asked().join(' '));
  check('오늘 프리 봉이 맨 끝', md(r.times.at(-1)) === '10-16 08:00' && r.ext.at(-1) === 'pre' && r.closes.at(-1) === 240000, weekRuns(r));

  // 야후가 하루를 통째로 비우고 그날 프리도 없으면 애프터끼리 맞닿는다 — 날을 넘는 빈 칸은 채우지 않는다
  NOW = kst('2026-10-15T17:00');
  yahooBody = yahoo([['2026-10-14T09:00', 100000], ['2026-10-14T14:30', 101000]]);
  naverReply = (url) => (url.includes('202610141530') ? [minute('2026-10-14T19:55', 102000)]
    : url.includes('202610151530') ? [minute('2026-10-15T15:45', 103000)] : []);
  r = await oneWeek('051910.KS');
  check('하루를 넘는 빈 칸(10/14 19:30 → 10/15 15:30)은 채우지 않는다', same(r.times.map(md),
    ['10-14 09:00', '10-14 14:30', '10-14 19:30', '10-15 15:30']), weekRuns(r));

  naverCalls.length = 0;
  r = await oneWeek('035420.KS', false);
  check('정규장만(extended false)이면 네이버 분봉을 묻지 않는다', naverCalls.length === 0 && !('ext' in r));
}

// --- 6. 국내 정규장: 네이버 KRX 실시간 분봉 ---------------------------------------------------
// 야후 국내 분봉은 20분 늦어 1D · 1W 정규장도 네이버 KRX 1분봉(실시간)으로 그린다. 종목은 15:30 봉이 공식 종가이고
// 15:40 부터는 시간외라 장 종료 칸(15:30~15:34)까지만 쓴다(2026-10-26 실측 — 코스피 지수는 15:32 봉이 종가).
// 앞 절에서 쓰지 않은 종목 · 날이다(분봉 캐시는 경로 · 날마다).
const krxPathOf = (u) => u.replace('https://api.stock.naver.com/chart/domestic/', '');
{
  NOW = kst('2026-10-27T09:52');
  yahooCalls.length = 0; naverCalls.length = 0; krxCalls.length = 0;
  krxReply = (url) => (url.includes('/item/005380/minute?startDateTime=202610270000') ? [
    minute('2026-10-27T09:00', 223250, 663527, 222000, 223500, 221500), minute('2026-10-27T09:01', 223000, 100, 223250, 223400, 222900),
    minute('2026-10-27T09:04', 222750, 50), minute('2026-10-27T09:05', 222500, 30), minute('2026-10-27T09:51', 223750, 131)] : []);
  let r = await oneDay('005380.KS', false);
  check('1D 정규장은 네이버 KRX 분봉 — 오늘 하루를 장 종료 칸(15:35 앞)까지 묻는다', same(krxCalls.map(krxPathOf),
    ['item/005380/minute?startDateTime=202610270000&endDateTime=202610271535']), krxCalls.join(' '));
  check('야후는 묻지 않는다', yahooCalls.length === 0, yahooCalls.join(' '));
  check('5분봉이 지금(09:51)까지 있다 — realtime', r.ok && r.realtime === true && same(r.times.map(hm), ['09:00', '09:05', '09:50'])
    && !('ext' in r), JSON.stringify(r).slice(0, 200));
  check('09:00 칸 = 09:00~09:04 (거래량에 시가 동시호가 포함)', same([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes[0]],
    [222000, 223500, 221500, 222750, 663677]), JSON.stringify([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes[0]]));

  naverReply = (url) => (url.includes('startDateTime=202610270800') ? [minute('2026-10-27T08:00', 221000), minute('2026-10-27T08:45', 222000)] : []);
  r = await oneDay('005380.KS');
  check('전체: NXT 프리 봉 뒤에 네이버 정규장 봉(30초 안이라 KRX 는 다시 묻지 않는다)', r.realtime === true && r.ext[0] === 'pre'
    && hm(r.times[r.ext.indexOf(null)]) === '09:00' && r.closes.at(-1) === 223750 && krxCalls.length === 1, runs(r));

  // 장 전 · 휴장: 오늘 정규장 봉이 없으면 앞 거래일(네이버 일봉의 날짜). 종가 동시호가(15:30)까지, 15:40 시간외는 뺀다.
  krxCalls.length = 0;
  NOW = kst('2026-10-28T08:30');
  krxReply = (url) => (url.includes('/item/012330/day?') ? [{ localDate: '20261023' }, { localDate: '20261026' }, { localDate: '20261027' }]
    : url.includes('/item/012330/minute?startDateTime=202610270000') ? [minute('2026-10-27T15:19', 213000, 31372),
      minute('2026-10-27T15:30', 213000, 1346511), minute('2026-10-27T15:40', 213000, 751), minute('2026-10-27T16:00', 212500, 1672)]
    : []);
  r = await oneDay('012330.KS', false);
  check('장 전에는 오늘 · 거래일 목록(3주) · 앞 거래일 순으로 묻는다', same(krxCalls.map(krxPathOf), [
    'item/012330/minute?startDateTime=202610280000&endDateTime=202610281535',
    'item/012330/day?startDateTime=20261007&endDateTime=20261028',
    'item/012330/minute?startDateTime=202610270000&endDateTime=202610271535']), krxCalls.join(' '));
  check('앞 거래일 정규장: 15:15 · 15:30(종가 동시호가) 칸, 15:40 · 16:00 시간외는 뺀다', r.realtime === true
    && same(r.times.map(hm), ['15:15', '15:30']) && same(r.volumes, [31372, 1346511]), JSON.stringify(r).slice(0, 200));
  krxCalls.length = 0;
  NOW = kst('2026-10-28T08:31');
  await oneDay('012330.KS', false);
  check('지난 날 봉 · 거래일 목록은 다시 묻지 않는다(오늘만 10초마다)', same(krxCalls.map(krxPathOf),
    ['item/012330/minute?startDateTime=202610280000&endDateTime=202610281535']), krxCalls.join(' '));

  // 1W: 최근 다섯 거래일(오늘 포함)을 30분봉으로
  krxCalls.length = 0;
  NOW = kst('2026-10-27T10:00');
  krxReply = (url) => {
    if (url.includes('/item/011170/day?')) return ['20261020', '20261021', '20261022', '20261023', '20261026'].map((d) => ({ localDate: d }));
    const m = /item\/011170\/minute\?startDateTime=(\d{4})(\d{2})(\d{2})0000/.exec(url);
    if (!m) return [];
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return d === '2026-10-27' ? [minute(`${d}T09:00`, 100), minute(`${d}T09:31`, 101)]
      : [minute(`${d}T09:00`, 90), minute(`${d}T15:30`, 95, 1000)];
  };
  r = await oneWeek('011170.KS', false);
  check('1W 는 최근 다섯 거래일(오늘 포함)의 정규장 30분봉', r.realtime === true && same(r.times.map(md), ['10-21 09:00', '10-21 15:30',
    '10-22 09:00', '10-22 15:30', '10-23 09:00', '10-23 15:30', '10-26 09:00', '10-26 15:30', '10-27 09:00', '10-27 09:30']), weekRuns(r));
  check('1W 는 야후를 묻지 않는다', !yahooCalls.some((u) => u.includes('011170')), yahooCalls.join(' '));

  // 코스피 지수: 15:32 봉이 공식 종가 — 15:30 칸의 종가가 된다
  krxCalls.length = 0;
  NOW = kst('2026-10-26T16:00');
  krxReply = (url) => (url.includes('/index/KOSPI/minute?startDateTime=202610260000') ? [minute('2026-10-26T15:29', 5472.92, 0),
    minute('2026-10-26T15:30', 5469.59, 8103), minute('2026-10-26T15:32', 5469.47, 12010)] : []);
  r = await oneDay('^KS11');
  check('코스피 지수도 네이버 — 15:32 공식 종가가 15:30 칸의 종가', krxCalls[0]?.includes('/chart/domestic/index/KOSPI/minute')
    && r.realtime === true && r.closes.at(-1) === 5469.47 && !('ext' in r), JSON.stringify(r).slice(0, 200));

  // 수능일처럼 장이 늦게 끝나는 날: 그날 네이버가 알려 준 종료 시각(지수 줄 응답)의 칸까지
  NOW = kst('2026-11-19T16:50');
  pollingBody = { datas: [{ itemCode: 'KOSPI', stockName: '코스피', closePrice: '5500.00', compareToPreviousClosePrice: '1.00',
    fluctuationsRatio: '0.02', marketStatus: 'CLOSE', stockExchangeType: { startTime: '1000', endTime: '1630' } }] };
  await handlers['quote:indices']({});
  pollingBody = { datas: [] };
  krxCalls.length = 0;
  krxReply = (url) => (url.includes('/item/000810/minute?startDateTime=202611190000') ? [minute('2026-11-19T10:00', 100),
    minute('2026-11-19T16:20', 101), minute('2026-11-19T16:30', 102, 5000), minute('2026-11-19T16:40', 102, 3)] : []);
  r = await oneDay('000810.KS', false);
  check('수능일: 16:30 칸까지 묻고 그린다(16:40 시간외는 뺀다)', krxCalls[0]?.endsWith('endDateTime=202611191635')
    && same(r.times.map(hm), ['10:00', '16:20', '16:30']), `${krxCalls.join(' ')} ${JSON.stringify(r.times?.map(hm))}`);

  // 네이버가 실패하면 야후(20분 지연)로 — realtime 없이. 실패는 기억하지 않는다.
  krxCalls.length = 0; yahooCalls.length = 0;
  NOW = kst('2026-10-27T11:00');
  krxReply = () => new TypeError('fetch failed');
  yahooBody = krYahoo('2026-10-27');
  r = await oneDay('028260.KS', false);
  check('네이버가 실패하면 야후로 그린다(realtime 없음)', r.ok && !('realtime' in r) && yahooCalls.length === 1
    && same(r.closes, [230000, 231000, 232000]), JSON.stringify(r).slice(0, 200));
  krxReply = (url) => (url.includes('/item/028260/minute?startDateTime=202610270000') ? [minute('2026-10-27T10:58', 1000)] : []);
  r = await oneDay('028260.KS', false);
  check('다음 요청에서 받으면 네이버로', r.realtime === true && r.closes.at(-1) === 1000, JSON.stringify(r).slice(0, 200));

  // 1D RSI 의 앞 거래일 봉(5d · 5m, 렌더러 rsiWarmFor): 국내는 네이버 정규장 5분봉 — 야후 국내 5분봉은 15:00 뒤 봉이 없다
  // (2026-10-29 실측 삼성전자 날마다 09:00~14:55). 1W 처럼 최근 다섯 거래일이되 30분으로 묶지 않는다.
  krxCalls.length = 0; yahooCalls.length = 0;
  NOW = kst('2026-10-27T10:00');
  krxReply = (url) => {
    if (url.includes('/item/009150/day?')) return ['20261020', '20261021', '20261022', '20261023', '20261026'].map((d) => ({ localDate: d }));
    const m = /item\/009150\/minute\?startDateTime=(\d{4})(\d{2})(\d{2})0000/.exec(url);
    if (!m) return [];
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return [minute(`${d}T09:00`, 90), minute(`${d}T15:12`, 94), minute(`${d}T15:30`, 95, 1000)];
  };
  r = await handlers['yf:chart']({}, { symbol: '009150.KS', range: '5d', interval: '5m' });
  check('5d · 5m 도 국내는 네이버 — 최근 다섯 거래일(오늘 포함)의 정규장 5분봉, 15:00 뒤 봉까지', r.ok && r.realtime === true
    && same(r.times.map(md), ['10-21', '10-22', '10-23', '10-26', '10-27'].flatMap((d) => [`${d} 09:00`, `${d} 15:10`, `${d} 15:30`])),
    weekRuns(r));
  check('5d · 5m 은 야후를 묻지 않는다', !yahooCalls.some((u) => u.includes('009150')), yahooCalls.join(' '));
  krxReply = () => [];
}

// --- 7. 지수 줄의 선물 · 미국채 1D: 네이버 하루 차트 -----------------------------------------------
// 야후는 선물의 하루를 미국 동부 자정(한국 13:00)에 새로 시작하고 10분 늦어 그 뒤 10분쯤 1D 가 비었고(2026-10-27 13:06 둘 다
// 0봉), 미국채는 미국 정규장에만 움직였다. 응답 모양은 2026-10-27 실측(front-api/chart/pricesByPeriod)에서 쓰는 필드만 옮겼다.
// 선물은 거래소 하루(17:00 CT ~), 미국채는 최근 24시간(전날의 같은 시각 뒤 + 오늘)이다.
const dayChart = (zoneId, priceInfos, lastPriceInfos = []) => ({ isSuccess: true, result: { zoneId, priceInfos, lastPriceInfos } });
const pt = (t, c, v) => ({ localDateTime: `${t.replace(/\D/g, '')}00`, currentPrice: c, ...(v == null ? {} : { accumulatedTradingVolume: v }) });
const FRONT = 'https://m.stock.naver.com/front-api/chart/pricesByPeriod?';
{
  NOW = kst('2026-10-27T13:06');
  yahooCalls.length = 0; frontCalls.length = 0;
  frontReply = (url) => (url.includes('NQcv1') ? dayChart('CST6CDT', [pt('2026-10-26T17:00', 29474.5, 49),
    pt('2026-10-26T17:01', 29480, 100), pt('2026-10-26T17:04', 29470, 130), pt('2026-10-26T17:05', 29475, 140),
    pt('2026-10-26T22:55', 29452.25, 52669)]) : null);
  let r = await oneDay('NQ=F');
  check('나스닥 선물 1D 는 네이버 하루 차트를 묻는다', same(frontCalls,
    [`${FRONT}reutersCode=NQcv1&category=major&chartInfoType=futures&scriptChartType=day`]), frontCalls.join(' '));
  check('야후는 묻지 않는다', yahooCalls.length === 0, yahooCalls.join(' '));
  check('거래소 하루(17:00 CT = 한국 07:00)부터 5분봉, 지금까지 — realtime', r.ok && r.realtime === true && !('ext' in r)
    && same(r.times.map(hm), ['07:00', '07:05', '12:55']), JSON.stringify(r).slice(0, 200));
  check('5분 칸: 시가는 첫 값, 고 · 저는 칸 안, 종가는 끝 값 · 거래량은 누적의 차이', same([r.opens[0], r.highs[0], r.lows[0], r.closes[0]],
    [29474.5, 29480, 29470, 29470]) && same(r.volumes, [130, 10, 52529]), JSON.stringify([r.opens[0], r.highs[0], r.lows[0], r.closes[0], r.volumes]));

  // WTI 는 에너지, 겨울(CST)에는 17:00 CT 가 한국 08:00
  frontCalls.length = 0;
  NOW = kst('2026-12-02T09:00');
  frontReply = (url) => (url.includes('CLcv1') ? dayChart('CST6CDT', [pt('2026-12-01T17:00', 101.27, 6), pt('2026-12-01T17:59', 101.4, 58)]) : null);
  r = await oneDay('CL=F');
  check('WTI: 에너지 · 선물, 겨울에는 17:00 CT = 한국 08:00', frontCalls[0]?.includes('reutersCode=CLcv1&category=energy&chartInfoType=futures')
    && same(r.times.map(hm), ['08:00', '08:55']) && r.realtime === true, `${frontCalls.join(' ')} ${JSON.stringify(r.times?.map(hm))}`);

  // 미국채: 뉴욕 날짜가 막 바뀌어 오늘 값이 하나뿐이어도 전날의 같은 시각 뒤를 이어 최근 24시간
  frontCalls.length = 0;
  NOW = kst('2026-10-27T13:18');
  frontReply = (url) => (url.includes('US10YT%3DRR') ? dayChart('America/New_York', [pt('2026-10-27T00:09', 4.97)],
    [pt('2026-10-26T00:19', 4.968), pt('2026-10-26T23:59', 4.965)]) : null);
  r = await oneDay('^TNX');
  check('미국채: 국채 차트를 묻는다', frontCalls[0] === `${FRONT}reutersCode=US10YT%3DRR&category=bond&chartInfoType=governmentBond&scriptChartType=day`,
    frontCalls.join(' '));
  check('미국채는 최근 24시간(전날 00:19 NY = 한국 13:19 부터), 거래량 없음', same(r.times.map(md), ['10-26 13:15', '10-27 12:55', '10-27 13:05'])
    && same(r.volumes, [0, 0, 0]) && r.closes.at(-1) === 4.97 && r.realtime === true, weekRuns(r));

  // 네이버가 실패하거나 비면 야후로 — 실패는 기억하지 않는다
  yahooCalls.length = 0;
  yahooBody = yahoo([['2026-10-27T13:00', 100], ['2026-10-27T13:05', 101]]);
  frontReply = () => new TypeError('fetch failed');
  r = await oneDay('CL=F');
  check('네이버가 실패하면 야후로(realtime 없음)', r.ok && !('realtime' in r) && yahooCalls.length === 1 && same(r.closes, [100, 101]), JSON.stringify(r).slice(0, 160));
  frontReply = () => dayChart('CST6CDT', []);
  r = await oneDay('CL=F');
  check('네이버가 비면 야후로', r.ok && !('realtime' in r) && yahooCalls.length === 2);
  frontReply = () => ({ detailCode: 'invalid_value', message: '...' }); // 모양이 다른 응답(주소가 바뀌었을 때)
  r = await oneDay('CL=F');
  check('모양이 다른 응답도 야후로', r.ok && !('realtime' in r) && yahooCalls.length === 3);

  // 1W · 일봉과 다른 종목은 묻지 않는다
  frontCalls.length = 0;
  await oneWeek('NQ=F');
  await handlers['yf:chart']({}, { symbol: 'CL=F', range: '1mo', interval: '1d' });
  await oneDay('^IXIC');
  check('1W · 일봉 · 다른 지수는 네이버 하루 차트를 묻지 않는다', frontCalls.length === 0, frontCalls.join(' '));
  frontReply = () => null;
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
