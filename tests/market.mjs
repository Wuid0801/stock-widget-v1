// 시장 지표 화면의 데이터(main.js market:extras) — 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
// 외국인 현물 · 선물 수급(네이버 모바일 지수 수급, 날짜별), 코스피 · 코스피200 선물 일별 종가(네이버 지수 일봉),
// 미국 HY OAS(FRED CSV). 응답 모양은 2026-10-27 실측에서 쓰는 필드만 옮겼다.
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
  net: { fetch: (url, opt) => { netCalls.push(String(url)); return fakeFetch(url, opt); } }, // Electron net.fetch(Chromium) — FRED 만
};
const netCalls = [];
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
const kst = (s) => Date.parse(`${s}+09:00`);

// 가짜 네트워크 — 주소별로 답한다. 답이 Error 면 던지고, { status } 면 그 상태로 실패한다.
const calls = [];
const headersOf = {}; // 경로 → 마지막 요청 헤더
let reply = {};
const fakeFetch = async (url, opt) => {
  url = String(url);
  calls.push(url);
  const route = url.includes('/chart/domestic/index/KOSPI/day') ? 'kospiDay' : url.includes('/chart/domestic/index/FUT/day') ? 'futDay'
    : url.includes('/chart/domestic/index/KPI200/day') ? 'k200Day' : url.includes('/chart/domestic/index/KPI200/minute') ? 'k200Min'
    : url.includes('/api/index/KOSPI/trend') ? 'spot' : url.includes('/api/index/FUT/trend') ? 'fut'
      : url.includes('fred.stlouisfed.org') ? 'fred'
        : url.includes('finance.daum.net/api/investor/KOSPI/times') ? 'daumSpot' : url.includes('finance.daum.net/api/investor/future/times') ? 'daumFut'
          : url.includes('finance.daum.net/api/domestic/quotes') ? 'daumQuotes' : 'other';
  headersOf[route] = opt && opt.headers;
  const date = (/bizdate=(\d{8})/.exec(url) || [])[1];
  const body = typeof reply[route] === 'function' ? reply[route](date) : reply[route];
  if (body instanceof Error) throw body;
  if (body && body.status) return { ok: false, status: body.status, json: async () => ({}), text: async () => '' };
  return { ok: true, status: 200, json: async () => body, text: async () => String(body ?? '') };
};

new Function('require', 'process', 'fetch', 'AbortSignal', 'Date', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal, FixedDate);

const day = (d, close) => ({ localDate: d, closePrice: close, openPrice: close, highPrice: close, lowPrice: close });
const trend = (date, foreign) => ({ bizdate: date, personalValue: '+1', foreignValue: foreign, institutionalValue: '' });
const SPOT = { 20261023: '-9,811', 20261026: '-6,827', 20261027: '+4,080', 20261028: '+1,500' };
const FUT = { 20261023: '+4,514', 20261026: '-1,200', 20261027: '+6,185', 20261028: '-300' };
const FRED = 'observation_date,BAMLH0A0HYM2\n2026-10-21,3.27\n2026-10-22,\n2026-10-23,.\n2026-10-24,3.40\n';
const base = () => ({
  kospiDay: [day('20261023', 5550.3), day('20261026', 5469.47), day('20261027', 5641.17)],
  futDay: [day('20261023', 863.3), day('20261026', 850), day('20261027', 883.7)],
  k200Day: [day('20261023', 860.3), day('20261026', 848.6), day('20261027', 881.2)],
  // 오늘 1분봉 — 네이버 응답 순서가 섞여도 시각 순으로, 값이 없는 줄은 뺀다
  k200Min: [{ localDateTime: '20261027131600', currentPrice: 886.5 }, { localDateTime: '20261027131000', currentPrice: 885 },
    { localDateTime: '20261027131700', currentPrice: null }],
  spot: (d) => trend(d, SPOT[d]),
  fut: (d) => trend(d, FUT[d]),
  fred: FRED,
});
const extras = () => handlers['market:extras']({});
const trendDates = (kind) => calls.filter((u) => u.includes(`/api/index/${kind}/trend`)).map((u) => /bizdate=(\d{8})/.exec(u)[1]);

// --- 1. 수급은 거래일만 묻는다 ------------------------------------------------------------------
{
  NOW = kst('2026-10-27T15:00');
  reply = base();
  calls.length = 0;
  const r = await extras();
  check('수급은 거래일만 묻는다(10/24 · 10/25 없음)', same(trendDates('KOSPI'), ['20261023', '20261026', '20261027'])
    && same(trendDates('FUT'), ['20261023', '20261026', '20261027']), calls.join(' '));
  check('외국인 순매수 문자열을 숫자로 — 부호 · 쉼표', same(r.spotFlows?.map((f) => f.foreign), [-9811, -6827, 4080])
    && same(r.futFlows?.map((f) => f.foreign), [4514, -1200, 6185]), JSON.stringify(r.spotFlows));
  check('빈 값은 null', r.spotFlows?.[0].inst === null && r.spotFlows?.[0].personal === 1, JSON.stringify(r.spotFlows?.[0]));
  check('일별 종가 · HY OAS 모양', same(r.kospiDays?.map((d) => [d.date, d.close]), [['20261023', 5550.3], ['20261026', 5469.47], ['20261027', 5641.17]])
    && r.futDays?.length === 3 && r.ok === true && typeof r.at === 'string', JSON.stringify(r).slice(0, 200));
  check('코스피200 현물 일별 종가(베이시스용)', same(r.k200Days?.map((d) => [d.date, d.close]), [['20261023', 860.3], ['20261026', 848.6], ['20261027', 881.2]]),
    JSON.stringify(r.k200Days));
  check('코스피200 현물 오늘 1분 종가 — 시각(ms) 순, 빈 값은 뺀다(베이시스를 선물 시각에 맞출 때)',
    same(r.k200Min, [{ t: kst('2026-10-27T13:10'), close: 885 }, { t: kst('2026-10-27T13:16'), close: 886.5 }]), JSON.stringify(r.k200Min));
  check('분봉은 오늘 하루를 묻는다', calls.some((u) => u.includes('/index/KPI200/minute?startDateTime=202610270000&endDateTime=202610272359')),
    calls.filter((u) => u.includes('minute')).join(' '));
}

// --- 2. final 은 한국 20:30 — 지난 날 · 확정된 오늘은 다시 묻지 않는다 -------------------------------------
// 예전 18:00 — 2026-09-14 KRX 애프터마켓(16:00~20:00)이 생긴 뒤 그날 투자자별 값이 20:00 까지 바뀌는지 확인하지 못해, 어느 쪽이든
// 틀리지 않게 20:30 으로 늦췄다(2026-11-02 사용자 결정).
{
  NOW = kst('2026-10-27T20:29');
  reply = base();
  calls.length = 0;
  let r = await extras();
  check('final 은 한국 20:30 — 20:29 의 오늘은 잠정', same(r.spotFlows.map((f) => f.final), [true, true, false]), JSON.stringify(r.spotFlows));
  check('지난 날은 다시 묻지 않는다(1번에서 확정) · 잠정인 오늘은 묻는다', same(trendDates('KOSPI'), ['20261027']), trendDates('KOSPI').join(' '));
  NOW = kst('2026-10-27T20:30');
  calls.length = 0;
  r = await extras();
  check('20:30 이면 오늘도 확정', r.spotFlows.at(-1).final === true && same(trendDates('KOSPI'), ['20261027']), JSON.stringify(r.spotFlows.at(-1)));
  calls.length = 0;
  NOW = kst('2026-10-27T20:31');
  await extras();
  check('확정된 오늘은 다시 묻지 않는다', trendDates('KOSPI').length === 0 && trendDates('FUT').length === 0, calls.join(' '));
}

// --- 3. FRED 빈 값 · 점은 건너뛴다, 6시간 기억 ------------------------------------------------------
{
  NOW = kst('2026-10-27T15:00') + 6 * 3600000 + 1; // 1번(15:00)에 받은 FRED 기억이 막 지났다 — 여기서 새로 받는다
  calls.length = 0;
  const r = await extras();
  check('기억이 지나 FRED 를 새로 받았다', calls.some((u) => u.includes('fred')));
  check('FRED 빈 값 · 점은 건너뛴다', same(r.hyOas, [{ date: '20261021', value: 3.27 }, { date: '20261024', value: 3.4 }]), JSON.stringify(r.hyOas));
  // Electron 44 의 Node fetch 는 FRED 에서 답이 없고(20초), net.fetch 에 User-Agent 를 바꿔 달면 HTTP2 오류다(2026-11-02 실측)
  check('FRED 는 Electron net.fetch 로, 다른 출처는 Node fetch 로', netCalls.length > 0 && netCalls.every((u) => u.includes('fred.stlouisfed.org')),
    netCalls.join(' '));
  check('FRED 요청은 User-Agent 를 바꾸지 않는다', !JSON.stringify(headersOf.fred || {}).includes('User-Agent'), JSON.stringify(headersOf.fred));
  calls.length = 0;
  const fetchedAt = NOW;
  NOW = fetchedAt + 5 * 3600000;
  await extras();
  check('6시간 안에는 FRED 를 다시 묻지 않는다', !calls.some((u) => u.includes('fred')), calls.join(' '));
  NOW = fetchedAt + 6 * 3600000;
  await extras();
  check('6시간이 지나면 다시 묻는다', calls.some((u) => u.includes('fred')));
}

// --- 4. 출처 하나가 실패해도 나머지는 온다 ------------------------------------------------------------
{
  NOW = kst('2026-10-28T09:30');
  reply = { ...base(), fred: { status: 500 } };
  reply.kospiDay = [...reply.kospiDay, day('20261028', 5650)];
  NOW += 7 * 3600000; // FRED 기억(6시간)이 지나서 다시 묻게
  let r = await extras();
  check('FRED 가 500 이면 hyOas 만 null', r.ok === true && r.hyOas === null && r.spotFlows?.length === 4 && r.kospiDays?.length === 4,
    JSON.stringify(r).slice(0, 200));
  // 실패한 부분은 errors 에 이유(한글 문구) — 지표 화면이 빈 줄 메모에 적는다(2026-11-02)
  check('실패한 부분의 이유를 errors 에', r.errors?.hyOas === 'HTTP 500' && !('spotFlows' in r.errors) && !('kospiDays' in r.errors),
    JSON.stringify(r.errors));
  reply = { ...base(), fred: new Error('net::ERR_INTERNET_DISCONNECTED') }; // Electron net.fetch 는 Chromium 오류 코드로 실패한다
  NOW += 7 * 3600000;
  r = await extras();
  check('net.fetch 의 Chromium 오류는 한글로 — 코드는 괄호에', r.errors?.hyOas === '네트워크 오류 (ERR_INTERNET_DISCONNECTED)', JSON.stringify(r.errors));
  reply = { ...base(), kospiDay: new TypeError('fetch failed') };
  NOW += 7 * 3600000;
  r = await extras();
  check('코스피 일봉이 실패하면 수급도 null(거래일을 모른다) — 선물 일봉 · HY OAS 는 온다', r.ok === true && r.spotFlows === null
    && r.futFlows === null && r.kospiDays === null && r.futDays?.length === 3 && r.hyOas?.length === 2, JSON.stringify(r).slice(0, 200));
  check('수급의 이유는 코스피 일봉의 실패', r.errors?.spotFlows === '네트워크 연결 실패' && r.errors?.futFlows === '네트워크 연결 실패'
    && r.errors?.kospiDays === '네트워크 연결 실패' && !('hyOas' in r.errors), JSON.stringify(r.errors));
  reply = { kospiDay: new TypeError('fetch failed'), futDay: new TypeError('fetch failed'), spot: new TypeError('x'), fut: new TypeError('x'), fred: { status: 500 } };
  NOW += 7 * 3600000;
  r = await extras();
  check('모두 실패하면 ok: false', r.ok === false && typeof r.error === 'string', JSON.stringify(r));
}

// --- 5. 모양이 다른 수급 응답은 그날을 뺀다 --------------------------------------------------------------
{
  NOW = kst('2026-11-02T10:00');
  reply = base();
  reply.kospiDay = [day('20261029', 5700), day('20261030', 5710), day('20261102', 5720)];
  reply.spot = (d) => (d === '20261030' ? { detailCode: 'invalid', message: '...' } : trend(d, '+1,000'));
  reply.fut = (d) => (d === '20261029' ? trend('20261028', '+5') : trend(d, '-2')); // 다른 날의 값이 오면 그날도 뺀다
  const r = await extras();
  check('모양이 다른 수급 응답은 그날을 뺀다', same(r.spotFlows?.map((f) => f.date), ['20261029', '20261102']), JSON.stringify(r.spotFlows));
  check('묻지 않은 날의 값이 오면 그날을 뺀다', same(r.futFlows?.map((f) => f.date), ['20261030', '20261102']), JSON.stringify(r.futFlows));
}

// --- 7. 셋 다 0 인 수급은 아직 없는 값이다 ---------------------------------------------------------------
// 리뷰(2026-10-27): 확정된 날에 0 이 한 번 오면 그대로 기억해 앱을 다시 켤 때까지 연속 일수 · 판정이 틀렸다(네이버는 값이 없을 때도
// 오류 대신 0 을 준다 — 휴장일 · 미래 날짜 실측). 외국인 · 기관 · 개인이 셋 다 0 이면 그날을 빼고 기억하지 않는다 — 다음에 다시 묻는다.
{
  NOW = kst('2026-11-03T19:00');
  reply = base();
  reply.kospiDay = [day('20261103', 5800)];
  reply.futDay = [day('20261103', 900)];
  reply.spot = (d) => ({ bizdate: d, personalValue: '0', foreignValue: '0', institutionalValue: '0' });
  calls.length = 0;
  let r = await extras();
  check('셋 다 0 인 날은 뺀다', same(r.spotFlows, []), JSON.stringify(r.spotFlows));
  reply.spot = (d) => trend(d, '+2,000');
  calls.length = 0;
  r = await extras();
  check('0 이었던 날은 기억하지 않아 다시 묻는다', same(trendDates('KOSPI'), ['20261103']) && r.spotFlows?.[0]?.foreign === 2000,
    `${trendDates('KOSPI').join(' ')} ${JSON.stringify(r.spotFlows)}`);
  reply.spot = (d) => ({ bizdate: d, personalValue: '+120', foreignValue: '0', institutionalValue: '-120' });
  NOW = kst('2026-11-04T19:00');
  reply.kospiDay = [day('20261104', 5810)];
  r = await extras();
  check('외국인만 0 이면 진짜 0 이다(둔다)', r.spotFlows?.[0]?.foreign === 0, JSON.stringify(r.spotFlows));
}

// --- 8. 장중 수급(다음 금융) — 지표 화면의 '코스피 장중 수급' 묶음, 2026-10-30 사용자 요청 ---------------------------------
// 네이버 수급은 날짜마다 값 하나라 장중 흐름이 없다. 응답 모양은 2026-10-30 브라우저 실측에서 쓰는 필드만 옮겼다 — 현물은 원(최신이 앞),
// 선물도 금액(type=PRICE, 원 — 처음에는 계약수였는데 현물과 단위가 달라 견주기 어려웠다, 사용자 요청), 프로그램은 코스피(KGG01P)의 지금 값 하나.
const spotRow = (t, i, f, inst, corp, pension, etcForeign = 0) => ({ date: `2026-10-30 ${t}:00`, time: `${t}:00`,
  individualStraightPurchasePrice: i * 1e8, foreignStraightPurchasePrice: f * 1e8, institutionStraightPurchasePrice: inst * 1e8,
  details: { ETC_CORPORATION: corp * 1e8, PENSION_FUND: pension * 1e8, ETC_FOREIGN: etcForeign * 1e8, BANK: 0 } });
const futRow = (t, p, f, inst, corp, pension) => ({ date: `2026-10-30 ${t}:00`, privateSettlement: p * 1e8, foreignSettlement: f * 1e8,
  institutionalSettlement: inst * 1e8, etcCorporationSettlement: corp * 1e8, pensionFundInvestment: pension * 1e8 });
{
  NOW = kst('2026-10-30T14:30');
  reply = {
    ...base(),
    daumSpot: { code: 200, data: [spotRow('14:25', 7761, -13737, 3670, 2306, 4853),
      spotRow('14:01', 0, -12854, 2845, 2159, 3446), // 한 칸이 0 으로 빈 줄(실측) — 합이 0 이 아니다
      { date: null }, spotRow('13:55', 8000, -12500, 2500, 1990, 3000, 10)] },
    daumFut: { code: 200, data: [futRow('14:25', 434, 203, -541, -96, 130), futRow('08:45', 5, -5, 0, 0, 0)] },
    daumQuotes: [{ symbolCode: 'K2G01P', investorSummary: { programStraightPurchasePrice: null } },
      { symbolCode: 'KGG01P', investorSummary: { programStraightPurchasePrice: -419e8 } }],
  };
  calls.length = 0;
  let r = await extras();
  check('다음 금융 세 주소를 묻는다 — 현물은 그날 하루치(세부 포함), 선물도 하루치', [
    'finance.daum.net/api/investor/KOSPI/times?market=KOSPI&page=1&perPage=400&details=true&pagination=true',
    'finance.daum.net/api/investor/future/times?page=1&perPage=400&terms=times&pagination=true&type=PRICE',
    'finance.daum.net/api/domestic/quotes?summary=true&changeStatistics=true'].every((u) => calls.some((c) => c.endsWith(u))),
  calls.filter((c) => c.includes('daum')).join(' '));
  check('브라우저처럼 Referer 를 붙인다(없으면 막힌다)', ['daumSpot', 'daumFut', 'daumQuotes']
    .every((k) => headersOf[k] && headersOf[k].Referer === 'https://finance.daum.net/'), JSON.stringify(headersOf.daumSpot));
  check('현물: 억 원 · 시각 오름차순 · 빈 줄(합이 어긋난 줄)과 날짜 없는 줄은 뺀다', same(r.intraday?.spot, [
    { t: kst('2026-10-30T13:55'), individual: 8000, foreign: -12500, institution: 2500, pension: 3000, corp: 1990 },
    { t: kst('2026-10-30T14:25'), individual: 7761, foreign: -13737, institution: 3670, pension: 4853, corp: 2306 }]), JSON.stringify(r.intraday?.spot));
  check('선물: 억 원 · 시각 오름차순', same(r.intraday?.fut, [
    { t: kst('2026-10-30T08:45'), individual: 5, foreign: -5, institution: 0, pension: 0, corp: 0 },
    { t: kst('2026-10-30T14:25'), individual: 434, foreign: 203, institution: -541, pension: 130, corp: -96 }]), JSON.stringify(r.intraday?.fut));
  check('프로그램: 코스피의 지금 값(억 원)', r.intraday?.program === -419, JSON.stringify(r.intraday?.program));

  reply.daumQuotes = { status: 500 };
  reply.daumFut = new TypeError('fetch failed');
  r = await extras();
  check('하나가 실패하면 그것만 null', r.intraday?.program === null && r.intraday?.fut === null && r.intraday?.spot?.length === 2,
    JSON.stringify(r.intraday));
  reply.daumSpot = { status: 403 };
  r = await extras();
  check('셋 다 실패하면 장중 수급 부분이 null(나머지는 온다)', r.ok === true && r.intraday === null && r.kospiDays?.length === 3,
    JSON.stringify(r).slice(0, 160));
}

// --- 6. 데드캣 점검 판정(market-check.js — 순수 함수) ---------------------------------------------------
// 기준(설계 ③): 외국인 현물 2거래일 연속 · SOX 직전 20거래일 최고 돌파 / 최저의 3% 이내 · 원/달러 5일 +1% · VIX 5일 +15% 또는
// 하루 +10% · HY OAS 5영업일 +0.25%p · 미국채 5일 ±10bp 안정 / +20bp 위험. 경계값은 부동소수 오차에도 같은 쪽으로 판정해야 한다.
{
  const { marketChecks, CHECK } = createRequire(import.meta.url)('../market-check.js');
  const verdictOf = (input, key) => marketChecks(input).find((c) => c.key === key);
  const v = (input, key) => verdictOf(input, key).verdict;
  const series = (base, now) => ({ now, closes: [base, base, base, base, base, base], dayPct: 0 }); // 마지막 봉 앞 다섯 번째 = base
  check('판정 키와 순서', same(marketChecks({}).map((c) => c.key), ['spot', 'futures', 'sox', 'usdkrw', 'vix', 'hyoas', 'us10y'])
    && marketChecks({}).every((c) => c.verdict === null && c.detail === '데이터 부족'));
  check('기준 숫자', CHECK.LOOKBACK === 5 && CHECK.USD_RISK === 0.01 && CHECK.VIX_RISK_5D === 0.15 && CHECK.VIX_RISK_DAY === 10
    && CHECK.OAS_RISK === 0.25 && CHECK.TNX_CALM_BP === 10 && CHECK.TNX_RISK_BP === 20 && CHECK.SOX_DAYS === 20 && CHECK.SOX_NEAR_LOW === 0.03);

  check('원/달러: 보합 good · +0.999% neutral · +1% risk', same(['1000', '1009.99', '1010'].map((n) => v({ usdkrw: series(1000, Number(n)) }, 'usdkrw')),
    ['good', 'neutral', 'risk']));
  check('원/달러 근거', /1,000\.00 → 지금 1,010\.00 \(\+1\.00%\)/.test(verdictOf({ usdkrw: series(1000, 1010) }, 'usdkrw').detail),
    verdictOf({ usdkrw: series(1000, 1010) }, 'usdkrw').detail);
  check('VIX: 하락 good · +14.95% neutral · +15% risk(23/20 은 부동소수로 0.1499…)', same([19.9, 22.99, 23].map((n) => v({ vix: series(20, n) }, 'vix')),
    ['good', 'neutral', 'risk']));
  check('VIX: 하루 +10% 면 5일 +2.5% 여도 risk', v({ vix: { ...series(20, 20.5), dayPct: 10 } }, 'vix') === 'risk');
  const oas = (now) => ({ hyOas: [3.1, 3.2, 3.2, 3.3, 3.3, now].map((value, i) => ({ date: `2026102${i}`, value })) });
  check('HY OAS: 3.10 → 3.10 neutral · 3.09 good · 3.35 risk(+0.25%p)', same([3.1, 3.09, 3.35].map((n) => v(oas(n), 'hyoas')),
    ['neutral', 'good', 'risk']));
  check('HY OAS: 다섯 개뿐이면 판정 불가', v({ hyOas: oas(3.2).hyOas.slice(1) }, 'hyoas') === null);
  check('미국채: +10bp good · +19bp neutral · +20bp risk(5.10-4.90 은 0.1999…)', same([5.0, 5.09, 5.1].map((n) => v({ us10y: series(4.9, n) }, 'us10y')),
    ['good', 'neutral', 'risk']));
  check('미국채: 크게 내려도(-25bp) 위험은 아니다(상승만 위험) — 안정도 아니다', v({ us10y: series(4.9, 4.65) }, 'us10y') === 'neutral');
  const sox = (now, n = 21) => ({ sox: { now, closes: [...Array.from({ length: 20 }, (_, i) => 100 + i), 119.5].slice(-n), dayPct: 0 } });
  check('SOX: 직전 20거래일 최고 돌파 good · 최저의 3% 이내 risk · 그사이 neutral', same([120, 103, 110].map((n) => v(sox(n), 'sox')),
    ['good', 'risk', 'neutral']));
  check('SOX: 일봉 20개뿐이면 판정 불가', v(sox(120, 20), 'sox') === null);

  const f = (date, foreign, final = true) => ({ date, foreign, final });
  const kospi = [{ date: '20261022', close: 100 }, { date: '20261023', close: 101 }, { date: '20261026', close: 102 }, { date: '20261027', close: 101 }];
  check('현물: 잠정치는 판정에 쓰지 않는다 — 마지막 두 확정(+1 · +2)이면 good',
    v({ spotFlows: [f('20261022', -1), f('20261023', 1), f('20261026', 2), f('20261027', -5, false)], kospiDays: kospi }, 'spot') === 'good');
  check('현물: 코스피가 오른 날(10/23) 외국인 순매도면 risk', v({ spotFlows: [f('20261022', 1), f('20261023', -3)], kospiDays: kospi }, 'spot') === 'risk');
  check('현물: 코스피가 내린 날 순매도면 neutral', v({ spotFlows: [f('20261026', 1), f('20261027', -3)], kospiDays: kospi }, 'spot') === 'neutral');
  check('현물: 확정일이 하나뿐이면 판정 불가', v({ spotFlows: [f('20261023', 5), f('20261026', 5, false)], kospiDays: kospi }, 'spot') === null);
  const fut = [{ date: '20261022', close: 850 }, { date: '20261023', close: 860 }, { date: '20261026', close: 855 }];
  check('선물: 선물이 오른 날(10/23) 외국인 선물 순매수면 good', v({ futFlows: [f('20261023', 6185)], futDays: fut, kospiDays: kospi }, 'futures') === 'good');
  check('선물: 코스피가 오른 날(10/23) 외국인 선물 순매도면 risk', v({ futFlows: [f('20261023', -1200)], futDays: fut, kospiDays: kospi }, 'futures') === 'risk');
  check('선물: 선물이 내린 날(10/26) 순매수면 neutral', v({ futFlows: [f('20261026', 300)], futDays: fut, kospiDays: kospi }, 'futures') === 'neutral');
  check('선물: 그날 일봉이 없으면 판정 불가', v({ futFlows: [f('20261027', 300)], futDays: fut, kospiDays: kospi }, 'futures') === null);
  // 네이버 지수 수급의 단위는 억 원이다 — 10/23 외국인 선물 +4,514 가 다음 금융 금액(4,514억, 계약으로는 2,177)과 같고, 현물 -9,811 이
  // 다음 금액 -9,789억과 거의 같다(2026-11-02 확인). 예전에는 단위를 몰라 '네이버 표기 그대로' 숫자만 적었다.
  check('수급 근거는 억 원', verdictOf({ spotFlows: [f('20261022', 1000), f('20261023', 2100)], kospiDays: kospi }, 'spot').detail
    === '확정 10/22 +1,000억 · 10/23 +2,100억 · 10/23 코스피 상승'
    && verdictOf({ futFlows: [f('20261023', 4514)], futDays: fut, kospiDays: kospi }, 'futures').detail
      === '10/23 외국인 선물 +4,514억 · 선물 상승 · 코스피 상승',
  `${verdictOf({ spotFlows: [f('20261022', 1000), f('20261023', 2100)], kospiDays: kospi }, 'spot').detail} | ${verdictOf({ futFlows: [f('20261023', 4514)], futDays: fut, kospiDays: kospi }, 'futures').detail}`);
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
