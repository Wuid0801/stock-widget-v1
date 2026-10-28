// 야후 국내 일봉의 빈 날을 네이버 일봉으로 채우는지 — 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
//
// 야후는 국내 종목 일봉을 가끔 하루 통째로 비워 준다(종가 · 거래량 null). 2025-09-19 와 2026-10-12 는
// 모든 국내 종목이 비었고, 1년이 지나도 채워지지 않았다(2026-10-13 확인). 그대로 두면 차트에서 그날이
// 빠지고 이동평균 · RSI · 추세 점검이 그날 없이 계산된다.
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

// 지금 = 2026-10-13 10:00 KST. 야후 국내 일봉 시각은 그날 09:00 KST(00:00 UTC)다.
const NOW = Date.parse('2026-10-13T01:00:00Z');
class FixedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
const day = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;

// 야후 응답: 날짜와 종가(null 이면 빈 날). 시 · 고 · 저 · 거래량도 같이 비운다.
const yahoo = (rows) => ({
  chart: { result: [{
    timestamp: rows.map(([d]) => day(d)),
    indicators: { quote: [{
      close: rows.map(([, c]) => c),
      open: rows.map(([, c]) => (c == null ? null : c + 50)),
      high: rows.map(([, c]) => (c == null ? null : c + 100)),
      low: rows.map(([, c]) => (c == null ? null : c - 100)),
      volume: rows.map(([, c]) => (c == null ? null : 1000)),
    }] },
    meta: { regularMarketPrice: 30850, currency: 'KRW' },
  }] },
});
// 네이버 일봉 응답 한 줄 (실제 응답 모양 — 2026-10-13 카카오 10/12)
const naverRow = (d, close) => ({ localDate: d, openPrice: close + 450, highPrice: close + 600,
  lowPrice: close - 200, closePrice: close, accumulatedTradingVolume: 1799763, foreignRetentionRate: 30.1 });

let yahooBody = null;
let naverReply = () => ({ ok: true, status: 200, body: [] });
const naverCalls = [];
const yahooCalls = [];
const fakeFetch = async (url, opt = {}) => {
  url = String(url);
  if (url.includes('api.stock.naver.com')) {
    naverCalls.push({ url, headers: opt.headers || {} });
    const r = naverReply(url);
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }
  yahooCalls.push(url);
  return { ok: true, status: 200, json: async () => yahooBody };
};

new Function('require', 'process', 'fetch', 'AbortSignal', 'Date', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal, FixedDate);

const chart = (symbol, interval = '1d') => handlers['yf:chart']({}, { symbol, range: '1mo', interval });

// --- 1. 빈 날을 네이버 값으로 채운다 -------------------------------------------
{
  yahooBody = yahoo([['2026-10-08', 32300], ['2026-10-12', null], ['2026-10-13', 30850]]);
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20261012', 31900)] });
  const r = await chart('035720.KS');
  check('빈 날이 채워져 봉 수가 그대로다', r.ok && r.closes.length === 3, JSON.stringify(r.closes));
  check('채운 날의 종가 · 시 · 고 · 저 · 거래량은 네이버 값',
    same([r.closes[1], r.opens[1], r.highs[1], r.lows[1], r.volumes[1]], [31900, 32350, 32500, 31700, 1799763]),
    JSON.stringify([r.closes[1], r.opens[1], r.highs[1], r.lows[1], r.volumes[1]]));
  check('채운 날의 시각은 야후 시각 그대로', r.times[1] === day('2026-10-12') * 1000);
  check('다른 날은 야후 값 그대로', r.closes[0] === 32300 && r.closes[2] === 30850);
  const call = naverCalls.at(-1);
  check('네이버 일봉을 빈 날과 그 앞뒤 날까지 한 번 묻는다 (비율을 보려고)',
    naverCalls.length === 1 && call.url === 'https://api.stock.naver.com/chart/domestic/item/035720/day'
      + '?startDateTime=202610080000&endDateTime=202610132359', call && call.url);
  check('네이버 요청은 기존처럼 Referer 를 단다', call && call.headers.Referer === 'https://m.stock.naver.com/');

  await chart('035720.KS');
  check('같은 날은 다시 묻지 않는다 (지난 날은 바뀌지 않는다)', naverCalls.length === 1, `${naverCalls.length}번`);
}

// --- 2. 빈 날이 여럿이면 한 번에 묻는다 ----------------------------------------
{
  naverCalls.length = 0;
  yahooBody = yahoo([['2025-09-18', 64700], ['2025-09-19', null], ['2025-09-22', 66400],
    ['2026-10-08', 32300], ['2026-10-12', null], ['2026-10-13', 30850]]);
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20250918', 64700), naverRow('20250919', 67000),
    naverRow('20250922', 66400), naverRow('20261012', 31900)] });
  const r = await chart('005930.KS');
  check('가장 이른 빈 날 ~ 가장 늦은 빈 날(과 그 앞뒤 날)을 한 번에 묻는다',
    naverCalls.length === 1 && naverCalls[0].url.endsWith('/005930/day?startDateTime=202509180000&endDateTime=202610132359'),
    naverCalls.map((c) => c.url).join(' '));
  check('두 빈 날이 모두 채워진다', r.ok && same(r.closes, [64700, 67000, 66400, 32300, 31900, 30850]), JSON.stringify(r.closes));
}

// --- 3. 네이버가 그날을 모르거나 실패하면 지금처럼 그날만 뺀다 ----------------------
{
  naverCalls.length = 0;
  yahooBody = yahoo([['2026-10-08', 100], ['2026-10-12', null], ['2026-10-13', 110]]);
  naverReply = () => ({ ok: true, status: 200, body: [] });
  let r = await chart('000660.KS');
  check('네이버에도 없는 날은 뺀다', r.ok && same(r.closes, [100, 110]), JSON.stringify(r.closes));
  await chart('000660.KS');
  check('네이버에도 없던 날은 다시 묻지 않는다', naverCalls.length === 1, `${naverCalls.length}번`);

  naverCalls.length = 0;
  naverReply = () => new TypeError('fetch failed');
  r = await chart('035420.KS');
  check('네이버 요청이 실패해도 차트는 나온다 (그날만 빠진다)', r.ok && same(r.closes, [100, 110]), JSON.stringify(r));
  naverReply = () => ({ ok: false, status: 500, body: null });
  r = await chart('035420.KS');
  check('실패는 기억하지 않고 다음에 다시 묻는다', naverCalls.length === 2 && r.ok && same(r.closes, [100, 110]),
    `${naverCalls.length}번`);
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20261012', 105)] });
  r = await chart('035420.KS');
  check('다음 요청에서 받으면 채운다', naverCalls.length === 3 && same(r.closes, [100, 105, 110]), JSON.stringify(r.closes));
}

// --- 4. 네이버를 묻지 않는 경우 -------------------------------------------------
{
  naverCalls.length = 0;
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20261012', 999)] });
  yahooBody = yahoo([['2026-10-08', 100], ['2026-10-12', null], ['2026-10-13', 110]]);
  for (const s of ['AAPL', '^GSPC', 'BRK-B']) await chart(s);
  check('해외 종목 · 해외 지수는 묻지 않는다(국내 지수는 6번)', naverCalls.length === 0, naverCalls.map((c) => c.url).join(' '));
  await chart('051910.KS', '30m');
  check('일봉이 아니면 묻지 않는다', naverCalls.length === 0);

  // 전체 탭: 처음부터 끝까지(max), 봉 크기는 야후가 고른다(월봉 · 주봉 · 분기봉). 1mo 로 물어 일봉용 채우기가 섞이지 않는다.
  yahooCalls.length = 0;
  const all = await handlers['yf:chart']({}, { symbol: '005930.KS', range: 'max', interval: '1mo' });
  check('전체(max · 1mo) 요청을 받는다', all.ok && yahooCalls.at(-1)?.endsWith('?range=max&interval=1mo'), yahooCalls.at(-1));
  check('전체 탭은 네이버를 묻지 않는다', naverCalls.length === 0);
  const bad = await handlers['yf:chart']({}, { symbol: '005930.KS', range: 'max', interval: '1wk' });
  check('허용하지 않은 봉 크기는 그대로 거절한다', bad.ok === false && bad.error === '잘못된 요청', JSON.stringify(bad));

  yahooBody = yahoo([['2026-10-08', 100], ['2026-10-12', 105], ['2026-10-13', 110]]);
  await chart('051910.KS');
  check('빈 날이 없으면 묻지 않는다', naverCalls.length === 0);

  // 장 전에는 야후가 오늘 칸만 비워 두기도 한다. 오늘 봉은 renderer 가 실시간 값으로 덧붙인다.
  yahooBody = yahoo([['2026-10-08', 100], ['2026-10-12', 105], ['2026-10-13', null]]);
  const r = await chart('051910.KS');
  check('오늘 칸이 비어 있으면 채우지 않고 뺀다', naverCalls.length === 0 && same(r.closes, [100, 105]),
    JSON.stringify(r.closes));
}

// --- 5. 가격 기준이 다른 종목은 야후 기준으로 맞춘다 -----------------------------
// 네이버는 증자 · 분할 · 분배금을 지난 가격에 반영하고(수정주가) 야후 close 는 액면분할만 반영한다.
// 삼성바이오로직스 2025-09-19 는 야후/네이버가 1.053 이라 그대로 넣으면 그날만 5% 꺼졌다(2026-10-13 실측).
{
  naverCalls.length = 0;
  // 야후 = 네이버 × 1.0625. 빈 날 바로 앞날(09-18)만 야후 값이 어긋나 있다 — 실측에서도 빈 날 앞날은 자주 어긋났다.
  yahooBody = yahoo([['2025-09-15', 3400], ['2025-09-16', 3417], ['2025-09-17', 3434], ['2025-09-18', 3551],
    ['2025-09-19', null], ['2025-09-22', 3485], ['2025-09-23', 3502]]);
  naverReply = () => ({ ok: true, status: 200, body: [['20250915', 3200], ['20250916', 3216], ['20250917', 3232],
    ['20250918', 3248], ['20250919', 3264], ['20250922', 3280], ['20250923', 3296]].map(([d, c]) => naverRow(d, c)) });
  let r = await chart('207940.KS');
  const filled = (x) => [x.closes[4], x.opens[4], x.highs[4], x.lows[4], x.volumes[4]];
  check('앞뒤 날 야후/네이버 비율의 중앙값을 곱해 채운다 (거래량은 그대로)',
    r.ok && same(filled(r), [3468, 3946.125, 4105.5, 3255.5, 1799763]), JSON.stringify(filled(r)));
  check('비율을 볼 앞뒤 날까지 같이 묻는다',
    naverCalls.length === 1 && naverCalls[0].url.endsWith('/207940/day?startDateTime=202509150000&endDateTime=202509232359'),
    naverCalls.map((c) => c.url).join(' '));
  r = await chart('207940.KS');
  check('다시 그릴 때도 기억한 앞뒤 날로 같은 값을 채운다 (다시 묻지 않는다)',
    naverCalls.length === 1 && same(filled(r), [3468, 3946.125, 4105.5, 3255.5, 1799763]), JSON.stringify(filled(r)));

  // 1% 안쪽은 기준 차이가 아니라 날마다 한두 틱 다른 잡음이다 — 거래소 종가(네이버)를 그대로 둔다.
  yahooBody = yahoo([['2026-10-06', 10050], ['2026-10-07', 10150], ['2026-10-08', 10250], ['2026-10-12', null], ['2026-10-13', 9000]]);
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20261006', 10000), naverRow('20261007', 10100),
    naverRow('20261008', 10200), naverRow('20261012', 10100)] });
  r = await chart('000270.KS');
  check('비율이 1% 안이면 네이버 값 그대로', r.ok && r.closes[3] === 10100, JSON.stringify(r.closes));

  // 오늘 봉은 장중에 움직이므로 비율에 쓰지 않는다.
  yahooBody = yahoo([['2026-10-08', 10000], ['2026-10-12', null], ['2026-10-13', 9000]]);
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20261008', 10000), naverRow('20261012', 9900),
    naverRow('20261013', 6000)] });
  r = await chart('034730.KS');
  check('오늘 봉은 비율에 쓰지 않는다', r.ok && r.closes[1] === 9900, JSON.stringify(r.closes));
}

// --- 6. 코스피 · 코스닥 지수도 빈 날을 네이버 지수 일봉으로 채운다 --------------------------------
// 야후는 지수 일봉도 하루를 비워 준다(2026-10-28 실측: ^KS11 · ^KQ11 의 10/27 이 null — 같은 날 삼성전자는 값이 있었다).
// 네이버 지수 일봉은 종가 · 거래량이 야후와 같다(10/19~10/26 여섯 날 종가가 같고 거래량 비율 1.0).
{
  naverCalls.length = 0;
  yahooBody = yahoo([['2026-10-08', 5550.3], ['2026-10-12', null], ['2026-10-13', 5600]]);
  naverReply = () => ({ ok: true, status: 200, body: [naverRow('20261008', 5550.3), naverRow('20261012', 5638.34)] });
  const r = await chart('^KS11');
  check('코스피 지수의 빈 날을 네이버 지수 일봉으로 채운다', r.ok && same(r.closes, [5550.3, 5638.34, 5600]), JSON.stringify(r.closes));
  check('네이버 지수 일봉(index/KOSPI)을 묻는다', naverCalls.length === 1
    && naverCalls[0].url.startsWith('https://api.stock.naver.com/chart/domestic/index/KOSPI/day?'), naverCalls.map((c) => c.url).join(' '));
  naverCalls.length = 0;
  yahooBody = yahoo([['2026-10-08', 751.69], ['2026-10-12', null], ['2026-10-13', 760]]); // 위에서 채운 응답은 다시 쓰지 않는다
  await chart('^KQ11');
  check('코스닥 지수는 index/KOSDAQ', naverCalls.length === 1 && naverCalls[0].url.includes('/chart/domestic/index/KOSDAQ/day?'),
    naverCalls.map((c) => c.url).join(' '));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
