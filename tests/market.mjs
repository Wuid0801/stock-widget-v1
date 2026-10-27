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
const kst = (s) => Date.parse(`${s}+09:00`);

// 가짜 네트워크 — 주소별로 답한다. 답이 Error 면 던지고, { status } 면 그 상태로 실패한다.
const calls = [];
let reply = {};
const fakeFetch = async (url) => {
  url = String(url);
  calls.push(url);
  const route = url.includes('/chart/domestic/index/KOSPI/day') ? 'kospiDay' : url.includes('/chart/domestic/index/FUT/day') ? 'futDay'
    : url.includes('/api/index/KOSPI/trend') ? 'spot' : url.includes('/api/index/FUT/trend') ? 'fut'
      : url.includes('fred.stlouisfed.org') ? 'fred' : 'other';
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
}

// --- 2. final 은 한국 18:00 — 지난 날 · 확정된 오늘은 다시 묻지 않는다 -------------------------------------
{
  NOW = kst('2026-10-27T17:59');
  reply = base();
  calls.length = 0;
  let r = await extras();
  check('final 은 한국 18:00 — 17:59 의 오늘은 잠정', same(r.spotFlows.map((f) => f.final), [true, true, false]), JSON.stringify(r.spotFlows));
  check('지난 날은 다시 묻지 않는다(1번에서 확정) · 잠정인 오늘은 묻는다', same(trendDates('KOSPI'), ['20261027']), trendDates('KOSPI').join(' '));
  NOW = kst('2026-10-27T18:00');
  calls.length = 0;
  r = await extras();
  check('18:00 이면 오늘도 확정', r.spotFlows.at(-1).final === true && same(trendDates('KOSPI'), ['20261027']), JSON.stringify(r.spotFlows.at(-1)));
  calls.length = 0;
  NOW = kst('2026-10-27T18:01');
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
  reply = { ...base(), kospiDay: new TypeError('fetch failed') };
  NOW += 7 * 3600000;
  r = await extras();
  check('코스피 일봉이 실패하면 수급도 null(거래일을 모른다) — 선물 일봉 · HY OAS 는 온다', r.ok === true && r.spotFlows === null
    && r.futFlows === null && r.kospiDays === null && r.futDays?.length === 3 && r.hyOas?.length === 2, JSON.stringify(r).slice(0, 200));
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
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
