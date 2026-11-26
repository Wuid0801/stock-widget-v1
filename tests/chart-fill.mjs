// 야후 국내 일봉의 빈 날을 네이버 일봉으로 채우는지 — 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
//
// 야후는 국내 종목 일봉을 가끔 하루 통째로 비워 준다(종가 · 거래량 null). 2025-09-19 와 2026-10-12 는
// 모든 국내 종목이 비었고, 1년이 지나도 채워지지 않았다(2026-10-13 확인). 그대로 두면 차트에서 그날이
// 빠지고 이동평균 · RSI · 추세 점검이 그날 없이 계산된다.
import { loadMain } from './_main.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
let hourReply = null; // 선물 빈 날 채우기(8번)의 야후 1시간봉 응답 — 없으면 다른 야후 요청처럼 yahooBody
const hourCalls = [];
const fakeFetch = async (url, opt = {}) => {
  url = String(url);
  if (url.includes('api.stock.naver.com')) {
    naverCalls.push({ url, headers: opt.headers || {} });
    const r = naverReply(url);
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }
  if (hourReply && url.includes('interval=1h')) {
    hourCalls.push(url);
    const r = hourReply();
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }
  yahooCalls.push(url);
  return { ok: true, status: 200, json: async () => yahooBody };
};

const handlers = loadMain({ globals: { fetch: fakeFetch, AbortSignal, Date: FixedDate } });

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
  // 30m 이 아니라 5m — 1mo · 30m 은 1W RSI 의 앞 거래일 봉이라 네이버 분봉을 묻는다(2026-11-04), 빈 날 채우기와 상관없다
  await chart('051910.KS', '5m');
  check('일봉이 아니면 묻지 않는다', naverCalls.length === 0, naverCalls.map((c) => c.url).join(' '));

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

// --- 7. 통합(KRX + NXT) 일봉 — 일봉 캔들 기준 '통합'(증권사 앱의 통합 캔들) -----------------------------------------
// 실측 모양(2026-11-06 SK하이닉스): KRX 1,089,000 · 1,217,000 · 1,089,000 · 1,176,000(네이버 KRX 일봉 종가는 하루 마지막 체결) /
// NXT 1,172,000 · 1,216,000 · 1,070,000 · 1,176,000 → 증권사 앱 통합 1,172,000 · 1,217,000 · 1,070,000 · 1,176,000
{
  naverCalls.length = 0;
  const row = (d, o, h, l, c, v = 100) => ({ localDate: d, openPrice: o, highPrice: h, lowPrice: l, closePrice: c, accumulatedTradingVolume: v });
  naverReply = (url) => ({ ok: true, status: 200, body: url.includes('/NXT/')
    ? [row('20261006', 500, 500, 500, 500, 0), row('20261008', 1172000, 1216000, 1070000, 1176000), row('20261012', 10, 12, 9, 11)]
    : [row('20261006', 1, 2, 1, 2), row('20261008', 1089000, 1217000, 1089000, 1176000)] });
  const r = await handlers['naver:venueDays']({}, '000660.KS', '20261001');
  check('통합 = 시가 NXT · 고저 두 시장 · 종가 KRX 일봉(하루 마지막 체결) — 증권사 앱과 같다',
    r.ok && same(r.days['20261008'], { open: 1172000, high: 1217000, low: 1070000, close: 1176000 }), JSON.stringify(r.days));
  check('NXT 거래가 없는 날(거래량 0)은 담지 않는다 — 렌더러가 KRX 캔들 그대로 둔다', r.ok && !('20261006' in r.days));
  check('KRX 줄이 없으면 NXT 값', r.ok && same(r.days['20261012'], { open: 10, high: 12, low: 9, close: 11 }));
  const B = 'https://api.stock.naver.com/chart/domestic';
  check('KRX · NXT 일봉을 첫 날부터 오늘까지 한 번씩', naverCalls.length === 2
    && naverCalls.some((x) => x.url === `${B}/item/000660/day?startDateTime=20261001&endDateTime=20261013`)
    && naverCalls.some((x) => x.url === `${B}/NXT/item/000660/day?startDateTime=20261001&endDateTime=20261013`),
  naverCalls.map((x) => x.url).join(' '));
  naverCalls.length = 0;
  await handlers['naver:venueDays']({}, '000660.KS', '20240101');
  check('NXT 가 열리기 전(2025-03-04) 날짜부터는 묻지 않는다', naverCalls.length === 2
    && naverCalls.every((x) => x.url.includes('startDateTime=20250304')), naverCalls.map((x) => x.url).join(' '));
  check('국내 종목만 — 지수 · 해외는 거절', (await handlers['naver:venueDays']({}, '^KS11', '20261001')).ok === false);
  naverReply = () => ({ ok: false, status: 500, body: null });
  const fail = await handlers['naver:venueDays']({}, '000660.KS', '20261001');
  check('받기에 실패하면 ok: false — 렌더러가 KRX 캔들로 그린다', fail.ok === false && /HTTP 500/.test(fail.error), JSON.stringify(fail));
}

// --- 원/엔은 100엔당 원 — 야후 JPYKRW=X(1엔당)에 100 을 곱한다(YF_SCALE, 2026-11-12). 다른 기호는 그대로 ---------------
{
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  yahooBody = yahoo([['2026-10-12', 8.5], ['2026-10-13', 8.3]]);
  yahooBody.chart.result[0].meta = { regularMarketPrice: 8.298, currency: 'KRW', fiftyTwoWeekHigh: 9.7726, fiftyTwoWeekLow: 8.292 };
  const jpy = await chart('JPYKRW=X');
  check('원/엔: 값 · 봉 · 52주 고저에 100 을 곱한다', jpy.ok && near(jpy.price, 829.8) && near(jpy.closes[0], 850) && near(jpy.closes[1], 830)
    && near(jpy.opens[0], 5850) && near(jpy.highs[0], 10850) && near(jpy.lows[0], -9150)
    && near(jpy.week52High, 977.26) && near(jpy.week52Low, 829.2), JSON.stringify(jpy));
  const usd = await chart('KRW=X');
  check('다른 기호는 그대로', usd.ok && usd.price === 8.298 && usd.closes[1] === 8.3 && usd.week52High === 9.7726, JSON.stringify(usd));
  delete yahooBody.chart.result[0].meta.fiftyTwoWeekHigh;
  delete yahooBody.chart.result[0].meta.regularMarketPrice;
  const bare = await chart('JPYKRW=X');
  check('원/엔: 값이 비면 마지막 봉, 52주가 비면 null(0 이 아니다)', bare.ok && near(bare.price, 830) && bare.week52High === null, JSON.stringify(bare));
}

// --- 8. 선물(=F) 일봉의 빈 날을 야후 1시간봉으로 채운다 ----------------------------------------
// 야후는 끝난 선물 거래일의 일봉 칸에 다음 거래 시간의 시가 · 거래량을 넣고 종가를 비워 준다(2026-11-26 실측 NQ · CL · BZ · GC …
// 11/25 칸 — 사용자 제보: 나스닥 선물 1M 이 11/24 다음 11/26). 실제 모양처럼 일봉 칸은 그날 00:00 뉴욕(10월은 EDT, 04:00 UTC),
// 진행 중 봉은 지금 시각. 지금 = 10-12 21:00 뉴욕 — 10-13 거래일이 10-12 18:00 에 시작했다.
{
  const at = (iso) => Date.parse(iso) / 1000;
  const daily = (rows) => ({ chart: { result: [{
    timestamp: rows.map(([t]) => at(t)),
    indicators: { quote: [{ close: rows.map((r) => r[1]), open: rows.map((r) => r[2]), high: rows.map((r) => r[2] + 1),
      low: rows.map((r) => r[2] - 1), volume: rows.map((r) => r[3]) }] },
    meta: { regularMarketPrice: 104, currency: 'USD' },
  }] } });
  // 10-12 칸: 종가 없이 새 거래 시간의 시가 103 · 거래량 5 (진행 중 봉과 같다). 채우기가 응답을 고치므로 매번 새로 만든다
  const broken = () => daily([['2026-10-08T04:00:00Z', 100, 99.5, 900], ['2026-10-09T04:00:00Z', 101, 100.2, 800],
    ['2026-10-12T04:00:00Z', null, 103, 5], ['2026-10-13T00:58:00Z', 104, 103, 5]]);
  // 1시간봉: 10-09 거래일 끝 · 10-12 거래일(10-11 18:00 ~ 10-12 17:00 뉴욕) · 17:00 쉬는 칸 · 10-13 거래일 첫 봉
  const hours = { chart: { result: [{
    timestamp: ['2026-10-09T19:00:00Z', '2026-10-11T22:00:00Z', '2026-10-12T15:00:00Z', '2026-10-12T20:00:00Z', '2026-10-12T21:00:00Z',
      '2026-10-12T22:00:00Z'].map(at),
    indicators: { quote: [{ open: [100.5, 101.5, 101.8, 105, null, 103], high: [101.2, 102, 106, 105.5, null, 104],
      low: [100.3, 101, 99, 102, null, 102.8], close: [101, 101.8, 105, 102.5, null, 103.9], volume: [7, 10, 20, 30, 0, 5] }] },
  }] } };
  hourReply = () => ({ ok: true, status: 200, body: hours });
  yahooBody = broken();
  const r = await chart('NQ=F');
  check('빈 날을 그 거래일(전날 18:00 ~ 그날 17:00 뉴욕)의 1시간봉으로 채운다 — 시가 첫 봉 · 고저 · 종가 마지막 체결 · 거래량 합',
    r.ok && same(r.closes, [100, 101, 102.5, 104]) && same([r.opens[2], r.highs[2], r.lows[2], r.volumes[2]], [101.5, 106, 99, 60]),
    JSON.stringify([r.closes, r.opens[2], r.highs[2], r.lows[2], r.volumes[2]]));
  check('채운 날의 시각은 야후 일봉 칸 그대로', r.times[2] === at('2026-10-12T04:00:00Z') * 1000);
  check('1시간봉 5일치를 한 번 묻는다', hourCalls.length === 1 && hourCalls[0].endsWith('/NQ%3DF?range=5d&interval=1h'), hourCalls.join(' '));

  hourCalls.length = 0;
  yahooBody = daily([['2026-10-08T04:00:00Z', 100, 99.5, 900], ['2026-10-09T04:00:00Z', 101, 100.2, 800], ['2026-10-12T04:00:00Z', 102, 101, 700]]);
  await chart('NQ=F');
  check('빈 날이 없으면 묻지 않는다', hourCalls.length === 0);
  yahooBody = daily([['2026-09-01T04:00:00Z', null, 99, 5], ['2026-10-09T04:00:00Z', 101, 100.2, 800], ['2026-10-12T04:00:00Z', 102, 101, 700]]);
  const old = await chart('CL=F');
  check('일주일보다 오래된 빈 날은 묻지 않고 지금처럼 뺀다(1시간봉 5일치에 없다)', hourCalls.length === 0 && same(old.closes, [101, 102]), JSON.stringify(old.closes));
  yahooBody = broken();
  const ix = await chart('^IXIC');
  check('선물(=F)이 아니면 묻지 않는다(빈 날은 지금처럼 뺀다)', hourCalls.length === 0 && same(ix.closes, [100, 101, 104]), JSON.stringify(ix.closes));

  hourReply = () => new Error('timeout');
  yahooBody = broken();
  const failed = await chart('GC=F');
  check('1시간봉을 못 받아도 차트는 나온다(그날만 빠진다)', hourCalls.length === 1 && failed.ok && same(failed.closes, [100, 101, 104]), JSON.stringify(failed.closes));
  hourReply = null;
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
