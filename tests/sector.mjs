// 종목명 옆 업종을 한글로 — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 yf:sector 를 부른다.
//
// 야후 업종은 영어이고(39가지), 검증용 99종목 중 21종목은 비어 있었다(SK하이닉스 · 삼성전기 · MSFT · TSLA …).
// 국내 분류도 어색했다(삼성전자 Consumer Electronics, 한화오션 Aerospace & Defense). 네이버 업종을 먼저 쓴다:
// 국내는 네이버 업종 79개(삼성전자 반도체와반도체장비), 미국은 네이버 해외 업종(애플 전화 및 소형 장치).
// 네이버에 없으면 야후 영어를 그대로 쓴다(2026-10-14 실측).
import { loadMain } from './_main.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

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
let emptyIndustryList = false; // 네이버가 업종 목록을 빈 채로(200) 줄 때
let NOW = Date.now();
class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
const calls = [];
const reply = (ok, body) => ({ ok, status: ok ? 200 : 404, json: async () => body });
const fakeFetch = async (url) => {
  url = String(url);
  calls.push(url);
  if (url.includes('naver.com')) {
    if (failNaver) return { ok: false, status: 500, json: async () => null };
    const auto = /autoComplete\?query=([^&]+)&target=stock$/.exec(url);
    if (auto) return reply(true, { result: { items: AUTO[decodeURIComponent(auto[1])] || [] } });
    if (emptyIndustryList && url.includes('/api/stocks/industry?')) return reply(true, {});
    return url in NAVER ? reply(true, NAVER[url]) : reply(false, null);
  }
  const q = decodeURIComponent(/[?&]q=([^&]+)/.exec(url)[1]);
  return reply(true, { quotes: YAHOO[q] ? [YAHOO[q]] : [] });
};

const handlers = loadMain({ globals: { fetch: fakeFetch, AbortSignal, Date: FakeDate } });
const sector = (symbol) => handlers['yf:sector']({}, symbol);
const yahooAsked = () => calls.filter((u) => u.includes('yahoo')).length;

// --- 빈 업종 목록은 기억하지 않는다 ---------------------------------------------------
// 네이버가 목록을 한 번 빈 채로 주면, 기억할 경우 앱이 켜져 있는 동안 모든 국내 종목이 야후 영어 업종이 된다.
{
  emptyIndustryList = true;
  let r = await sector('005930.KS');
  check('업종 목록이 비어 오면 실패로 끝난다(굳히지 않는다)', r.ok === false, JSON.stringify(r));
  emptyIndustryList = false;
  r = await sector('005930.KS');
  check('다음에는 목록을 다시 받아 네이버 업종 이름', r.ok && r.industry === '반도체와반도체장비', JSON.stringify(r));
  calls.length = 0;
}

// --- 국내 --------------------------------------------------------------------
{
  let r = await sector('005930.KS');
  check('국내 종목은 네이버 업종 이름 (삼성전자 → 반도체와반도체장비)', r.ok && r.industry === '반도체와반도체장비', JSON.stringify(r));
  r = await sector('042660.KS');
  check('한화오션 → 조선', r.ok && r.industry === '조선', JSON.stringify(r));
  check('받아 둔 네이버 업종 이름 목록(79개)은 다시 받지 않는다(앞 절에서 받았다)',
    calls.filter((u) => u.includes('/api/stocks/industry?')).length === 0);
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

  // 못 찾음은 1시간만 기억한다 — 네이버가 잠깐 빈 결과를 줘도 재시작까지 그 종목의 시간외 시세 · 지표 · 일정 · 업종을
  // 잃지 않게. 찾은 코드는 계속 기억한다.
  const asked = (t) => calls.filter((u) => u.includes(`autoComplete?query=${t}&`)).length;
  calls.length = 0;
  await sector('BRK-B');
  check('못 찾은 종목은 1시간 안에는 다시 찾지 않는다', asked('BRK-B') === 0, `${asked('BRK-B')}번`);
  NOW += 61 * 60000;
  await sector('BRK-B');
  check('1시간이 지나면 다시 찾는다', asked('BRK-B') === 1, `${asked('BRK-B')}번`);
  NOW += 5 * 3600000;
  await sector('AAPL');
  check('찾은 코드는 계속 기억한다', asked('AAPL') === 0, `${asked('AAPL')}번`);
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
