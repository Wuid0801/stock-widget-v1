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

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
