// 시장 순위(naver:rank) — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 핸들러를 부른다.
//
// 국내: 인기 검색 · 급등 · 급락 · 거래대금(코스피 + 코스닥) · 업종 · 테마, 미국: 급등 · 급락 · 거래대금 · 시총 상위(나스닥 + 뉴욕).
// 급등 · 급락 · 거래대금은 잡음을 거른다 — 국내는 일반 주식만(ETF · ETN · 우선주 제외) · 거래대금 10억 원 이상,
// 미국은 일반 주식만 · 시총 3억 달러 이상. 응답은 2026-10-16 실측(tests/fixtures/naver-rank-20261016.json,
// 목록마다 상위 50줄 · 쓰는 필드만)이다. 업종 · 테마는 2026-10-21 실측(tests/fixtures/naver-groups-20261021.json).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const FX = JSON.parse(fs.readFileSync(new URL('fixtures/naver-rank-20261016.json', import.meta.url), 'utf8'));
const GX = JSON.parse(fs.readFileSync(new URL('fixtures/naver-groups-20261021.json', import.meta.url), 'utf8'));

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
  electron, 'electron-store': class { get() {} set() {} }, fs, path,
  './quote-session.cjs': createRequire(import.meta.url)('../quote-session.cjs'),
};
const require = (m) => {
  if (!(m in modules)) throw new Error(`main.js 가 예상하지 못한 모듈을 부른다: ${m}`);
  return modules[m];
};

const calls = [];
let blocked = [];
const KR_PATH = { up: 'up', down: 'down', priceTop: 'value' };
const US_PATH = { up: 'up', down: 'down', priceTop: 'value', marketValue: 'cap' };
const route = (url) => {
  if (/m\.stock\.naver\.com\/api\/stocks\/searchTop\?/.test(url)) return FX.kr.search;
  let m = /m\.stock\.naver\.com\/api\/stocks\/(up|down|priceTop)\/(KOSPI|KOSDAQ)\?/.exec(url);
  if (m) return FX.kr[KR_PATH[m[1]]][m[2]];
  m = /api\.stock\.naver\.com\/stock\/exchange\/(NASDAQ|NYSE)\/(up|down|priceTop|marketValue)\?/.exec(url);
  if (m) return FX.us[US_PATH[m[2]]][m[1]];
  m = /m\.stock\.naver\.com\/api\/stocks\/(industry|theme)(?:\/(\d+))?\?/.exec(url);
  if (m) return m[2] ? GX[`${m[1]}/${m[2]}`] : GX[m[1]];
  return undefined;
};
const fakeFetch = async (url, opt = {}) => {
  url = String(url);
  calls.push({ url, signal: !!opt.signal });
  if (blocked.some((b) => url.includes(b))) throw new Error('막힌 요청');
  const body = route(url);
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};
new Function('require', 'process', 'fetch', src)(require, { env: {}, platform: 'test' }, fakeFetch);
const rank = (market, kind, no) => handlers['naver:rank']({}, no === undefined ? { market, kind } : { market, kind, no });
const desc = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] >= x);
const asc = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

// --- 1. 국내 인기 검색 — 거르지 않고 네이버 순서 그대로 -----------------------------------
{
  calls.length = 0;
  const d = await rank('kr', 'search');
  check('성공', d.ok === true, d.error);
  check('인기 검색 한 군데를 20개 묻고, 시간 제한을 건다',
    calls.length === 1 && /searchTop\?page=1&pageSize=20$/.test(calls[0].url) && calls[0].signal, calls.map((c) => c.url).join(' '));
  check('20개, 네이버 순서 그대로', d.items.length === 20
    && same(d.items.slice(0, 3).map((i) => i.name), ['삼성전자', 'SK하이닉스', '현대차']));
  check('야후 기호로 — 코스피는 .KS, 코스닥은 .KQ', d.items[0].symbol === '005930.KS'
    && d.items.find((i) => i.name === '알테오젠').symbol === '196170.KQ', JSON.stringify(d.items[0]));
  check('사람들이 실제로 본 목록이라 우선주도 그대로 둔다', d.items.some((i) => i.symbol === '005935.KS'));
  check('거르지 않았다고 알린다', d.filtered === false);
  check('한 줄: 이름 · 가격 · 등락률 · 거래대금(원) · 시총(원) · 통화',
    same(d.items[0], { symbol: '005930.KS', name: '삼성전자', price: 219000, pct: 4.29, value: 3043864000000, cap: 1280335015152000, currency: 'KRW' }),
    JSON.stringify(d.items[0]));
  check('기준 시각은 가장 늦은 체결 시각(줄마다 다르다)', d.at === '2026-10-16T14:22:23+09:00', d.at);
}

// --- 2. 국내 급등 · 급락 · 거래대금 — 코스피 + 코스닥, 거른다 -------------------------------
{
  calls.length = 0;
  const up = await rank('kr', 'up');
  check('코스피 · 코스닥 급등을 100개씩 묻는다', calls.length === 2
    && calls.some((c) => /\/up\/KOSPI\?page=1&pageSize=100$/.test(c.url)) && calls.some((c) => /\/up\/KOSDAQ\?page=1&pageSize=100$/.test(c.url)));
  check('20개까지', up.items.length === 20, up.items.length);
  check('등락률 높은 순', desc(up.items.map((i) => i.pct)), up.items.map((i) => i.pct).join(' '));
  check('일반 주식만 — 우선주(코드 끝이 0 이 아님) · ETN · ETF 를 뺀다',
    up.items.every((i) => /0\.K[SQ]$/.test(i.symbol)) && !up.items.some((i) => /ETN|KODEX|TIGER|KIWOOM|우$/.test(i.name)),
    up.items.map((i) => i.name).join(', '));
  check('거래대금 10억 원 이상만', up.items.every((i) => i.value >= 1e9));
  check('코스피 종목도 섞인다(대양금속 009190.KS)', up.items.some((i) => i.symbol === '009190.KS'));
  check('거른 목록이라고 알린다', up.filtered === true);

  const down = await rank('kr', 'down');
  check('급락 — 등락률 낮은 순, 첫째 하이퍼코퍼레이션(코스닥)', asc(down.items.map((i) => i.pct))
    && down.items[0].symbol === '065650.KQ' && down.items[0].pct === -17.46, JSON.stringify(down.items[0]));
  check('급락 — 거르고 남은 것이 20개보다 적으면 그만큼만(인버스 ETN 이 많았다)', down.items.length === 17, down.items.length);
  check('급락 — 대한항공(코스피, 거래대금 1,683억)', down.items.some((i) => i.symbol === '003490.KS'));

  const value = await rank('kr', 'value');
  check('거래대금 — 많은 순, SK하이닉스 · 삼성전자', desc(value.items.map((i) => i.value))
    && same(value.items.slice(0, 2).map((i) => i.symbol), ['000660.KS', '005930.KS']));
  check('거래대금 — KODEX 200 같은 ETF 는 뺀다', !value.items.some((i) => /KODEX|TIGER/.test(i.name)));
  check('거래대금 — 거래대금이 커도 우선주(삼성전자우 5,826억)는 뺀다', !value.items.some((i) => i.symbol === '005935.KS')
    && value.items.every((i) => /0.K[SQ]$/.test(i.symbol)));
}

// --- 3. 미국 — 나스닥 + 뉴욕 ----------------------------------------------------------
{
  calls.length = 0;
  const up = await rank('us', 'up');
  check('나스닥 · 뉴욕 급등을 100개씩 묻는다', calls.length === 2
    && calls.some((c) => /exchange\/NASDAQ\/up\?page=1&pageSize=100$/.test(c.url)) && calls.some((c) => /exchange\/NYSE\/up\?page=1&pageSize=100$/.test(c.url)));
  check('급등 — 시총 3억 달러 이상 · 일반 주식만, 등락률 높은 순', up.items.length === 20
    && up.items.every((i) => i.cap >= 3e8) && desc(up.items.map((i) => i.pct)), up.items.map((i) => `${i.symbol} ${i.cap}`).slice(0, 3).join(', '));
  check('급등 첫째 INDP(시총 약 4억 달러), 달러', up.items[0].symbol === 'INDP' && up.items[0].currency === 'USD', JSON.stringify(up.items[0]));
  check('기호는 야후와 같은 꼴(마침표 있는 BRK.B 같은 것은 뺀다)', up.items.every((i) => /^[A-Z][A-Z0-9-]{0,9}$/.test(i.symbol)));
  const down = await rank('us', 'down');
  check('급락 — 첫째 FMC', down.items[0].symbol === 'FMC' && asc(down.items.map((i) => i.pct)));
  const value = await rank('us', 'value');
  check('거래대금 — 첫째 MU(마이크론), 많은 순', value.items[0].symbol === 'MU' && desc(value.items.map((i) => i.value)));
  // 실측 미국 순위에는 ETF · 마침표 기호가 없었다 — 한 줄씩 끼워 넣어 거르는지 본다(거래대금 · 시총이 가장 크게)
  const fake = (symbolCode, stockEndType) => ({ symbolCode, stockName: symbolCode, stockEndType, closePriceRaw: '500',
    fluctuationsRatioRaw: '1.00', accumulatedTradingValueRaw: '999999999999', marketValueRaw: '9999999999999', localTradedAt: '2026-10-15T16:00:00-04:00' });
  const saved = FX.us.value.NYSE.stocks;
  FX.us.value.NYSE.stocks = [fake('SPYX', 'etf'), fake('BRK.B', 'stock'), ...saved];
  const injected = await rank('us', 'value');
  FX.us.value.NYSE.stocks = saved;
  check('미국도 ETF 는 뺀다', !injected.items.some((i) => i.symbol === 'SPYX'), injected.items[0].symbol);
  check('야후 기호 꼴이 아니면(BRK.B) 뺀다', !injected.items.some((i) => i.symbol === 'BRK.B'));
  const cap = await rank('us', 'cap');
  check('시총 상위 — NVDA · AAPL · MSFT', same(cap.items.slice(0, 3).map((i) => i.symbol), ['NVDA', 'AAPL', 'MSFT'])
    && desc(cap.items.map((i) => i.cap)));
  check('시총 상위는 시총으로 거르지 않는다(일반 주식만)', cap.filtered === true && cap.items.length === 20);
  check('미국 기준 시각(뉴욕 마감)', up.at === '2026-10-15T16:00:00-04:00', up.at);
}

// --- 3b. 국내 업종 · 테마 — 묶음 순위와 그 안의 종목 ------------------------------------------
// 묶음 등락률은 평균이라 한두 종목이 정한다 — 5종목 미만 묶음은 뺀다(2~3종목 테마가 상위를 차지했다).
{
  calls.length = 0;
  const ind = await rank('kr', 'industry');
  check('업종 목록을 한 번(100개) 묻고, 시간 제한을 건다',
    calls.length === 1 && /api\/stocks\/industry\?page=1&pageSize=100$/.test(calls[0].url) && calls[0].signal, calls.map((c) => c.url).join(' '));
  const want = GX.industry.groups.filter((g) => g.totalCount >= 5).slice(0, 20);
  check('5종목 이상만, 등락률 높은 순 20개', ind.ok && ind.groups.length === 20 && desc(ind.groups.map((g) => g.pct))
    && ind.groups.every((g) => g.count >= 5), ind.groups.map((g) => `${g.name} ${g.pct}`).slice(0, 3).join(', '));
  check('한 줄: 번호 · 이름 · 등락률 · 종목 수 · 오른 · 내린 종목 수', same(ind.groups[0], { no: Number(want[0].no), name: want[0].name,
    pct: Number(want[0].changeRate), count: want[0].totalCount, up: want[0].riseCount, down: want[0].fallCount }), JSON.stringify(ind.groups[0]));
  check('네이버 순서(등락률 순)와 같다', same(ind.groups.map((g) => g.name), want.map((g) => g.name)));
  check('묶음 목록에는 종목 줄이 없다', !('items' in ind));
  const saved = GX.industry.groups;
  GX.industry.groups = [...saved].reverse(); // 네이버가 순서를 지키지 않아도(테마 안 종목은 등락률 순이 아니었다)
  const shuffled = await rank('kr', 'industry');
  GX.industry.groups = saved;
  check('받은 순서와 상관없이 등락률 높은 순', same(shuffled.groups.map((g) => g.name), want.map((g) => g.name)));
  // 번호가 숫자가 아니거나 이름이 빈 줄은 뺀다 — 번호로 그 안의 종목을 묻는다(등락률이 가장 높게 끼워 넣는다)
  GX.industry.groups = [{ no: 'x', name: '번호 없음', totalCount: 10, changeRate: '99', riseCount: 9, fallCount: 1 },
    { no: 7, name: '', totalCount: 10, changeRate: '98', riseCount: 9, fallCount: 1 }, ...saved];
  const bad = await rank('kr', 'industry');
  GX.industry.groups = saved;
  check('번호 · 이름이 맞지 않는 줄은 뺀다', same(bad.groups.map((g) => g.name), want.map((g) => g.name)), bad.groups[0].name);
  const th = await rank('kr', 'theme');
  const tiny = GX.theme.groups.slice(0, 30).filter((g) => g.totalCount < 5).map((g) => g.name);
  check('테마도 — 상위의 5종목 미만 테마는 뺀다', th.ok && th.groups.length === 20 && tiny.length > 0
    && !th.groups.some((g) => tiny.includes(g.name)) && desc(th.groups.map((g) => g.pct)), tiny.join(', '));
}
{
  calls.length = 0;
  const d = await rank('kr', 'industry', 278);
  check('업종 안의 종목을 100개 묻는다', calls.length === 1 && /api\/stocks\/industry\/278\?page=1&pageSize=100$/.test(calls[0].url),
    calls.map((c) => c.url).join(' '));
  check('종목 줄은 순위 탭과 같은 모양', d.ok && d.items.length > 0 && same(Object.keys(d.items[0]), ['symbol', 'name', 'price', 'pct', 'value', 'cap', 'currency']),
    JSON.stringify(d.items[0]));
  check('일반 주식만 · 거래대금 10억 원 이상 — 코넥스 · 우선주 · 거래가 적은 종목은 뺀다',
    d.items.every((i) => /0\.K[SQ]$/.test(i.symbol) && i.value >= 1e9), d.items.map((i) => i.name).slice(0, 5).join(', '));
  check('등락률 높은 순 20개까지', d.items.length === 20 && desc(d.items.map((i) => i.pct)));
  check('거른 목록 · 기준 시각', d.filtered === true && typeof d.at === 'string');
  const raw = GX['theme/536'].stocks.map((x) => Number(x.fluctuationsRatio));
  const t = await rank('kr', 'theme', 536);
  check('테마 안 — 네이버가 등락률 순으로 주지 않아도(HBM) 등락률 높은 순', !desc(raw) && t.ok && t.items.length > 0
    && desc(t.items.map((i) => i.pct)), t.items.map((i) => i.pct).slice(0, 5).join(' '));
}

// --- 4. 일부 · 전부 실패, 받지 않는 요청 -------------------------------------------------
{
  blocked = ['KOSDAQ'];
  let d = await rank('kr', 'up');
  check('코스닥이 실패하면 코스피만으로', d.ok && d.items.length > 0 && d.items.every((i) => i.symbol.endsWith('.KS')));
  blocked = ['naver.com'];
  d = await rank('kr', 'up');
  check('전부 실패하면 ok:false', d.ok === false && typeof d.error === 'string', JSON.stringify(d));
  blocked = [];
  calls.length = 0;
  for (const [m, k] of [['us', 'search'], ['jp', 'up'], ['kr', 'cap'], ['kr', 'x'], [undefined, undefined], ['us', 'industry']]) {
    d = await rank(m, k);
    check(`${m}/${k} 는 ok:false`, d.ok === false);
  }
  for (const [k, no] of [['up', 278], ['industry', '278'], ['industry', 1.5], ['industry', -1], ['theme', null]]) {
    d = await rank('kr', k, no);
    check(`kr/${k} 번호 ${JSON.stringify(no)} 는 ok:false (번호는 업종 · 테마의 양의 정수만)`, d.ok === false);
  }
  check('잘못된 요청은 네트워크로 나가지 않는다', calls.length === 0, calls.map((c) => c.url).join(' '));
  d = await handlers['naver:rank']({}, null);
  check('인자가 없어도 ok:false', d.ok === false);
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
