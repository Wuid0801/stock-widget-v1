// 종목명 옆 업종을 한글로 — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 yf:sector 를 부른다.
//
// 야후 업종은 영어이고(39가지), 검증용 99종목 중 21종목은 비어 있었다(SK하이닉스 · 삼성전기 · MSFT · TSLA …).
// 국내 분류도 어색했다(삼성전자 Consumer Electronics, 한화오션 Aerospace & Defense). 네이버 업종을 먼저 쓴다:
// 국내는 네이버 업종 79개(삼성전자 반도체와반도체장비), 미국은 네이버 해외 업종(애플 전화 및 소형 장치).
// 네이버에 없으면 야후 영어를 그대로 쓴다(2026-10-14 실측).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

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

// 실제 응답 모양(2026-10-14) 중 쓰는 필드만. 없는 주소는 404.
const NAVER = {
  'https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100': { groups: [
    { no: 278, name: '반도체와반도체장비' }, { no: 25, name: '기타' }, { no: 319, name: '조선' }] },
  'https://m.stock.naver.com/api/stock/005930/integration': { stockEndType: 'stock', industryCode: '278' },
  'https://m.stock.naver.com/api/stock/042660/integration': { stockEndType: 'stock', industryCode: '319' },
  'https://m.stock.naver.com/api/stock/069500/integration': { stockEndType: 'etf', industryCode: '25' },
  'https://m.stock.naver.com/api/stock/000660/integration': { stockEndType: 'stock', industryCode: '999' },
  'https://api.stock.naver.com/stock/AAPL.O/basic': { stockEndType: 'stock',
    industryCodeType: { code: '57106020', industryGroupKor: '전화 및 소형 장치' } },
  'https://api.stock.naver.com/stock/SPY/basic': { stockEndType: 'etf' },
};
const AUTO = { // 네이버 검색: 티커 → 네이버 코드
  AAPL: [{ code: 'AAPL', nationCode: 'USA', reutersCode: 'AAPL.O' }],
  SPY: [{ code: 'SPY', nationCode: 'USA', reutersCode: 'SPY' }],
  'BRK-B': [{ code: 'BRK.B', nationCode: 'USA', reutersCode: 'BRK.B' }], // 표기가 달라 정확히 맞지 않는다
};
const YAHOO = {
  'BRK-B': { symbol: 'BRK-B', sectorDisp: 'Financial Services', industryDisp: 'Insurance—Diversified' },
  '000660.KS': { symbol: '000660.KS', sectorDisp: 'Technology', industryDisp: 'Semiconductors' },
  '069500.KS': { symbol: '069500.KS' },
  SPY: { symbol: 'SPY' },
};
let failNaver = false;
const calls = [];
const reply = (ok, body) => ({ ok, status: ok ? 200 : 404, json: async () => body });
const fakeFetch = async (url) => {
  url = String(url);
  calls.push(url);
  if (url.includes('naver.com')) {
    if (failNaver) return { ok: false, status: 500, json: async () => null };
    const auto = /autoComplete\?query=([^&]+)&target=stock$/.exec(url);
    if (auto) return reply(true, { result: { items: AUTO[decodeURIComponent(auto[1])] || [] } });
    return url in NAVER ? reply(true, NAVER[url]) : reply(false, null);
  }
  const q = decodeURIComponent(/[?&]q=([^&]+)/.exec(url)[1]);
  return reply(true, { quotes: YAHOO[q] ? [YAHOO[q]] : [] });
};

new Function('require', 'process', 'fetch', 'AbortSignal', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal);
const sector = (symbol) => handlers['yf:sector']({}, symbol);
const yahooAsked = () => calls.filter((u) => u.includes('yahoo')).length;

// --- 국내 --------------------------------------------------------------------
{
  let r = await sector('005930.KS');
  check('국내 종목은 네이버 업종 이름 (삼성전자 → 반도체와반도체장비)', r.ok && r.industry === '반도체와반도체장비', JSON.stringify(r));
  r = await sector('042660.KS');
  check('한화오션 → 조선', r.ok && r.industry === '조선', JSON.stringify(r));
  check('네이버 업종 이름 목록(79개)은 한 번만 받는다',
    calls.filter((u) => u.includes('/api/stocks/industry?')).length === 1);
  check('네이버에 이름이 있으면 야후를 묻지 않는다', yahooAsked() === 0, `${yahooAsked()}번`);

  r = await sector('069500.KS');
  check('ETF 는 네이버 "기타" 대신 야후 값(ETF 는 없음) — 지금처럼 비운다',
    r.ok && r.industry === null && r.sector === null, JSON.stringify(r));
  r = await sector('000660.KS');
  check('네이버 업종 목록에 없는 코드면 야후 영어로', r.ok && r.industry === 'Semiconductors', JSON.stringify(r));
}

// --- 미국 --------------------------------------------------------------------
{
  calls.length = 0;
  let r = await sector('AAPL');
  check('미국 종목은 네이버 해외 업종 (애플 → 전화 및 소형 장치)', r.ok && r.industry === '전화 및 소형 장치', JSON.stringify(r));
  check('네이버 검색으로 네이버 코드(AAPL.O)를 찾아 묻는다',
    calls.some((u) => u.endsWith('autoComplete?query=AAPL&target=stock'))
      && calls.some((u) => u.endsWith('/stock/AAPL.O/basic')) && yahooAsked() === 0, calls.join(' '));
  r = await sector('BRK-B');
  check('네이버에서 못 찾으면(BRK-B ↔ BRK.B) 야후 영어 그대로',
    r.ok && r.industry === 'Insurance—Diversified' && r.sector === 'Financial Services', JSON.stringify(r));
  r = await sector('SPY');
  check('미국 ETF 도 비운다', r.ok && r.industry === null && r.sector === null, JSON.stringify(r));
}

// --- 실패 --------------------------------------------------------------------
{
  failNaver = true;
  calls.length = 0;
  const r = await sector('035420.KS');
  check('네이버가 실패하면 실패로 끝난다 — 야후 영어로 굳히지 않고 다음에 다시 묻는다',
    r.ok === false && yahooAsked() === 0, JSON.stringify(r));
  failNaver = false;
  const bad = await sector('삼성전자');
  check('잘못된 심볼은 그대로 거절한다', bad.ok === false && bad.error === '잘못된 요청', JSON.stringify(bad));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
