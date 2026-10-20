// 종목 검색(yf:search) — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 핸들러를 부른다.
//
// 네이버 자동완성은 앞글자로만 찾아 `금융` 으로 KB금융, `바이오로직스` 로 삼성바이오로직스가 나오지 않았다. 통합
// 검색(front-api/search)은 이름 중간 글자로도 찾는다. 다른 나라 종목이 섞여 오므로 국내 · 미국만 남긴다.
// 응답은 2026-10-20 실측(tests/fixtures/naver-search-20261020.json, 쓰는 필드만)이다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const FX = JSON.parse(fs.readFileSync(new URL('fixtures/naver-search-20261020.json', import.meta.url), 'utf8'));

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

// 질의(q)로 고정 데이터를 고른다. 없는 질의는 빈 결과, 'http500' 은 서버 오류, 'down' 은 연결 실패.
const calls = [];
const fakeFetch = async (url) => {
  const u = new URL(String(url));
  calls.push(u);
  const q = u.searchParams.get('q');
  if (q === 'down') throw new Error('연결 실패');
  if (q === 'http500') return { ok: false, status: 500, json: async () => ({}) };
  const body = FX[q] ?? { result: { query: q, totalCount: 0, items: [] } };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};
new Function('require', 'process', 'fetch', src)(require, { env: {}, platform: 'test' }, fakeFetch);
const search = (q) => handlers['yf:search']({}, q);

// 고정 데이터에서 국내 · 미국만 앱 기호로 — 기대값
const expected = (q) => FX[q].result.items.filter((i) => i.nationCode === 'KOR' || i.nationCode === 'USA')
  .map((i) => ({ symbol: i.nationCode === 'KOR' ? `${i.code}.${i.typeCode === 'KOSDAQ' ? 'KQ' : 'KS'}` : i.code,
    name: i.name, market: i.typeName })).slice(0, 12);

// --- 1. 이름 중간 글자로 찾는다 ------------------------------------------------------------
{
  calls.length = 0;
  const r = await search('금융');
  check('금융 → KB금융이 맨 위(코스피)', r.ok && same(r.items[0], { symbol: '105560.KS', name: 'KB금융', market: '코스피' }),
    JSON.stringify(r.items?.[0]));
  check('금융지주들도 나온다', ['하나금융지주', '우리금융지주'].every((n) => r.items.some((i) => i.name === n)));
  check('12개까지, 네이버 순서 그대로', r.items.length === 12 && same(r.items, expected('금융')));
  const u = calls[0];
  check('통합 검색 한 번 — q · target=stock · page=1 · size=30',
    calls.length === 1 && u.origin + u.pathname === 'https://m.stock.naver.com/front-api/search'
    && u.searchParams.get('q') === '금융' && u.searchParams.get('target') === 'stock'
    && u.searchParams.get('page') === '1' && u.searchParams.get('size') === '30', String(u));
}

// --- 2. 국내 · 미국만, 코스닥은 .KQ ----------------------------------------------------------
{
  const r = await search('바이오로직스');
  const names = r.items.map((i) => i.name);
  check('바이오로직스 → 삼성바이오로직스', r.ok && same(r.items[0], { symbol: '207940.KS', name: '삼성바이오로직스', market: '코스피' }));
  check('코스닥은 .KQ', r.items.some((i) => i.symbol === '206650.KQ' && i.name === '유바이오로직스'));
  check('홍콩 · 중국 종목은 뺀다', !names.some((n) => /이노벤트|칸시노/.test(n)), names.join(', '));
  check('미국은 티커 그대로', r.items.some((i) => i.nationCode === undefined && /^[A-Z]+$/.test(i.symbol) && i.name === '앱셀레라 바이오로직스'));
  check('국내 6 + 미국 4, 순서 그대로', same(r.items, expected('바이오로직스')), names.join(', '));
  const n = await search('nvda');
  check('티커로도 — nvda → 엔비디아', n.ok && same(n.items[0], { symbol: 'NVDA', name: '엔비디아', market: expected('nvda')[0].market }));
  const c = await search('005930');
  check('코드로도 — 005930 → 삼성전자', c.ok && same(c.items, [{ symbol: '005930.KS', name: '삼성전자', market: '코스피' }]));
}

// --- 3. 빈 질의 · 긴 질의 · 실패 ----------------------------------------------------------------
{
  calls.length = 0;
  const e = await search('');
  check('빈 질의는 묻지 않는다', e.ok && same(e.items, []) && calls.length === 0);
  const none = await search('없는종목');
  check('결과가 없으면 빈 목록', none.ok && same(none.items, []));
  calls.length = 0;
  await search('가'.repeat(80));
  check('질의는 50자까지만 보낸다', calls[0]?.searchParams.get('q') === '가'.repeat(50));
  const h = await search('http500');
  check('서버 오류는 HTTP 상태로', h.ok === false && h.error === 'HTTP 500', JSON.stringify(h));
  const d = await search('down');
  check('연결 실패는 오류 문구로', d.ok === false && d.error === '연결 실패', JSON.stringify(d));
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
