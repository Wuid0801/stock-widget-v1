// 지표 보기(naver:detail) — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 핸들러를 부른다.
//
// 차트 대신 보는 지표 화면의 데이터다. 국내는 네이버 종목 상세(가치 지표 · 컨센서스 · 실적 일정 · 동종 업종) ·
// 투자자별 매매동향 · 분기 실적 · KRX 실시간 거래량 · 주주 구성, 미국은 네이버 해외 종목 정보 · 컨센서스 · 분기 실적.
// 응답은 2026-10-16 실측(tests/fixtures/naver-detail-20261016.json, 쓰는 필드만)이고, 주주 구성은 네이버 금융
// 기업정보 페이지 2026-10-28 실측(tests/fixtures/wisereport-holders-20261028.json, 쓰는 부분만 잘라 둠)이다.
import fs from 'node:fs';
import { loadMain } from './_main.mjs';

const FX = JSON.parse(fs.readFileSync(new URL('fixtures/naver-detail-20261016.json', import.meta.url), 'utf8'));
const HOLD = JSON.parse(fs.readFileSync(new URL('fixtures/wisereport-holders-20261028.json', import.meta.url), 'utf8'));
// 삼성전자우 · SK텔레콤은 주주 구성만 본다 — 나머지 네이버 응답은 삼성전자 것을 빌린다
const BORROW = { '005935': '005930', '017670': '005930' };

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 주소로 고정 데이터를 고른다. blocked 에 든 조각이 주소에 있으면 그 요청은 실패한다.
const calls = [];
let blocked = [];
const route = (url) => {
  let m = /m\.stock\.naver\.com\/api\/stock\/(\w+)\/(integration|trend|finance\/quarter)/.exec(url);
  if (m) return FX[BORROW[m[1]] || m[1]]?.[{ integration: 'integration', trend: 'trend', 'finance/quarter': 'quarter' }[m[2]]];
  m = /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/(\w+)$/.exec(url);
  if (m) return FX[BORROW[m[1]] || m[1]]?.realtime;
  m = /navercomp\.wisereport\.co\.kr\/v2\/company\/c1010001\.aspx\?cmp_cd=(\w+)$/.exec(url);
  if (m) return HOLD[m[1]]?.html; // 페이지(글자). ETF 는 실제로는 ETF 페이지로 넘어간다 — 넘어간 뒤의 페이지를 준다
  m = /autoComplete\?query=(\w+)/.exec(url);
  if (m) return Object.values(FX).find((f) => f.search?.result.items[0].code === m[1])?.search ?? { result: { items: [] } };
  m = /api\.stock\.naver\.com\/stock\/([\w.]+)\/(basic|integration|finance\/quarter)/.exec(url);
  if (m) return FX[m[1]]?.[{ basic: 'basic', integration: 'integration', 'finance/quarter': 'quarter' }[m[2]]];
  m = /finance\.daum\.net\/api\/trader\/ranks\?symbolCode=A(\w+)&/.exec(url);
  if (m) return TRADERS[m[1]];
  m = /finance\.daum\.net\/api\/home\/dart-filings\?code=(\w+)$/.exec(url);
  if (m) return FILINGS[m[1]] && { code: m[1], rows: FILINGS[m[1]] };
  for (const [part, body] of Object.entries(DAUM)) if (url.includes(part)) return typeof body === 'function' ? body(url) : body;
  return undefined;
};
// 다음 금융 공시 목록(home/dart-filings) — { code, rows: [{ no, day, name }] }, 2026-10-30 실측(효성중공업 · 삼성전자). 7번에서 채운다.
const FILINGS = {};
// 다음 금융 종목 정보(2026-11-24) — 주소 조각 → 응답(값이 함수면 주소를 받아 만든다). 10번에서 채운다
const DAUM = {};
// 다음 금융 거래원(trader/ranks) — 2026-10-30 브라우저 실측에서 쓰는 필드만. BID 는 매수 상위, ASK 는 매도 상위(각 10개사, 주),
// foreignInvestorAskBidSum 은 그 목록 안 외국계의 합. 목록에 든 반대쪽 수량은 0 으로 오기도 한다(한화투자 매도 0).
const trader = (traderName, bid, ask, foreign = false) => ({ traderName, bidAccTradeVolume: bid, askAccTradeVolume: ask,
  netSales: bid - ask, isForeignInvestor: foreign, isLeftStock: false });
const TRADERS = {
  '005930': { baseDate: '2026-10-30 00:00:00',
    BID: { data: [trader('한국증권', 1718002, 1167012), trader('골드만', 458984, 999036, true), trader('JP모간', 331515, 0, true)],
      foreignInvestorAskBidSum: 790499 },
    ASK: { data: [trader('BNK증권', 1670805, 1535498), trader('골드만', 458984, 999036, true), trader('한화투자', 996251, 0)],
      foreignInvestorAskBidSum: 999036 } },
};
const fakeFetch = async (url, opt = {}) => {
  url = String(url);
  calls.push({ url, signal: !!opt.signal, referer: opt.headers && opt.headers.Referer });
  if (blocked.some((b) => url.includes(b))) throw new Error('막힌 요청');
  const body = route(url);
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  if (typeof body === 'string') return { ok: true, status: 200, text: async () => body };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};

// 주주 구성은 6시간 기억한다 — 시계를 앞으로 돌려 본다
let SHIFT = 0;
const RealDate = Date;
class ShiftDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [RealDate.now() + SHIFT])); }
  static now() { return RealDate.now() + SHIFT; }
}
const opened = []; // dart:open 이 기본 브라우저로 연 주소(shell.openExternal)
const handlers = loadMain({ globals: { fetch: fakeFetch, Date: ShiftDate },
  electron: { shell: { openExternal: async (url) => { opened.push(url); } } } });
const detail = (symbol) => handlers['naver:detail']({}, symbol);

// --- 1. 국내 주식(삼성전자) ------------------------------------------------------------
{
  calls.length = 0;
  const d = await detail('005930.KS');
  check('성공', d.ok === true, d.error);
  check('국내 · 주식', d.market === 'kr' && d.kind === 'stock');
  check('열세 군데를 묻는다(종목 상세 · 매매동향 · 분기 실적 · KRX 실시간 · 기업정보 · 다음 거래원 · 다음 공시 목록 · 다음 금융 종목 정보 여섯 — '
    + '시세 요약 · 재무 · 추정 실적 · 회사 · 뉴스 · 공시 목록 — 10번), 모두 시간 제한을 건다',
    calls.length === 13 && calls.every((c) => c.signal), calls.map((c) => c.url).join('\n'));
  // 거래원(2026-10-30 사용자 요청) — 종목의 장중 투자자별 수급은 무료 출처에 없어 외국계 창구로 외국인 매매를 어림한다
  const daum = calls.find((c) => c.url.includes('finance.daum.net/api/trader'));
  check('거래원은 다음 금융 — 오늘 매수 · 매도 상위 10개사, 브라우저처럼 Referer', daum?.url === 'https://finance.daum.net/api/trader/ranks?'
    + 'symbolCode=A005930&BidFieldName=bidAccTradeVolume&BidOrder=desc&AskFieldName=askAccTradeVolume&AskOrder=desc&intervalType=TODAY&limit=10'
    && daum.referer === 'https://finance.daum.net/', JSON.stringify(daum));
  check('거래원 — 매수 · 매도 상위(그쪽 수량, 0 은 뺀다) · 외국계 표시 · 목록 안 외국계 합 · 기준일', same(d.traders, {
    date: '20261030',
    buy: [{ name: '한국증권', volume: 1718002, foreign: false }, { name: '골드만', volume: 458984, foreign: true },
      { name: 'JP모간', volume: 331515, foreign: true }],
    sell: [{ name: 'BNK증권', volume: 1535498, foreign: false }, { name: '골드만', volume: 999036, foreign: true }],
    foreignBuy: 790499, foreignSell: 999036,
  }), JSON.stringify(d.traders));
  check('매매동향은 20일치를 묻는다', calls.some((c) => /\/trend\?pageSize=20$/.test(c.url)));
  // 거래량은 KRX 실시간(야후 일봉 거래량 · 매매동향의 날짜별 거래량과 같은 기준). 종목 상세의 거래량은 NXT 포함이라 따로 둔다.
  check('오늘 거래량은 KRX 실시간과 그 시각', d.today.volume === 11822115 && d.today.at === '2026-10-16T13:30:41.947981+09:00', JSON.stringify(d.today));
  check('NXT 포함 거래량 · 대금 · 시총 · 외국인 소진율은 종목 상세 그대로',
    d.today.totalVolume === 21217698 && d.today.value === '4조 5,732억' && d.today.marketValue === '1,280조 3,350억'
      && d.today.foreignRate === '45.98%', JSON.stringify(d.today));
  check('가치 지표 — 네이버 표기 그대로, 정한 순서로',
    same(d.valuation, [{ label: 'PER', value: '9.82배' }, { label: '추정 PER', value: '4.81배' }, { label: 'PBR', value: '2.54배' },
      { label: 'EPS', value: '22,292원' }, { label: 'BPS', value: '86,052원' }, { label: '배당수익률', value: '0.76%' },
      { label: '주당배당금', value: '1,668원' }]), JSON.stringify(d.valuation));
  check('컨센서스 — 목표가 평균 · 투자의견 · 기준일 (국내는 최고 · 최저가 없다)',
    same(d.consensus, { target: 495227, high: null, low: null, opinion: 4, date: '2026-10-15', currency: 'KRW' }), JSON.stringify(d.consensus));
  check('실적 발표 일정', same(d.ir, { title: '2026년 3분기 경영실적 발표', date: '2026-10-29', dday: 13 }), JSON.stringify(d.ir));
  check('매매동향 20일, 최근이 먼저, 부호 있는 수', d.trend.length === 20
    && same(d.trend[0], { date: '20261015', foreign: -7280040, organ: 2391459, individual: 4658533, foreignRatio: 45.98 }), JSON.stringify(d.trend[0]));
  check('분기 실적 — 단위 억원, 열은 오래된 것부터, 마지막은 컨센서스(추정)',
    d.quarters.unit === '억원' && same(d.quarters.cols, [
      { title: '25.06', estimate: false }, { title: '25.09', estimate: false }, { title: '25.12', estimate: false },
      { title: '26.03', estimate: false }, { title: '26.06', estimate: false }, { title: '26.09', estimate: true }]),
    JSON.stringify(d.quarters.cols));
  check('분기 실적 — 매출액 · 영업이익 · 당기순이익만(ROE 등은 뺀다)',
    same(d.quarters.rows.map((r) => r.title), ['매출액', '영업이익', '당기순이익'])
      && same(d.quarters.rows[0].values, [745663, 860617, 938374, 1338734, 1714995, 2007657])
      && same(d.quarters.rows[2].values, [51164, 122257, 196417, 472253, 716245, 883532]), JSON.stringify(d.quarters.rows));
  check('동종 업종 — 이름과 등락률', same(d.peers.slice(0, 2), [{ name: 'SK하이닉스', pct: 3.25, code: '000660' }, { name: 'SK스퀘어', pct: 3.92, code: '402340' }])
    && d.peers.length === 6, JSON.stringify(d.peers));
  check('ETF 칸은 없다', d.etf === null);
  // 주요주주는 페이지 순서 그대로(최대주주등 → 5% 이상 → 자사주). 외국인은 지분율(소진율 아님) · 유동비율 · 기준일은 같은 페이지
  check('주주 구성 — 주요주주 이름 · 지분율, 외국인 지분율 · 유동비율, 기준일', same(d.holders, {
    date: '2026-10-27', common: null, foreign: 46.1, float: 74.98,
    rows: [{ name: '삼성생명보험 외 17인', pct: 19.69 }, { name: '국민연금공단', pct: 7.84 },
      { name: 'BlackRock Fund Advisors 외 15인', pct: 5.14 }, { name: '자사주', pct: 2.34 }],
  }), JSON.stringify(d.holders));
}

// --- 2. 국내 ETF(KODEX 200) -----------------------------------------------------------
{
  const d = await detail('069500.KS');
  check('ETF', d.ok && d.kind === 'etf', JSON.stringify(d).slice(0, 120));
  check('NAV · 괴리율(부호) · 운용사 · 기초지수 · 분배율',
    same(d.etf, { nav: 87038.98, deviation: -0.02, issuer: '삼성자산운용(ETF)', baseIndex: '코스피 200', dividendYield: 0.98 }), JSON.stringify(d.etf));
  check('ETF 시총은 ETF 지표에서', d.today.marketValue === '21조 4,372억', d.today.marketValue);
  check('ETF 는 가치 지표 · 컨센서스 · 실적 일정 · 분기 실적이 없다',
    d.valuation.length === 0 && d.consensus === null && d.ir === null && d.quarters === null);
  // 네이버가 "동종 업종" 자리에 주는 것은 인기 ETF(미국 S&P500 등)라 업종 비교로 읽히면 틀린 정보다
  check('ETF 는 동종 업종을 비운다', d.peers.length === 0, JSON.stringify(d.peers));
  check('매매동향은 ETF 도 있다', d.trend.length === 20);
  check('ETF 는 주주 구성이 없다(기업정보가 ETF 페이지로 넘긴다)', d.holders === null, JSON.stringify(d.holders));
}

// --- 3. 미국 주식(AAPL) ---------------------------------------------------------------
{
  calls.length = 0;
  const d = await detail('AAPL');
  check('미국 · 주식', d.ok && d.market === 'us' && d.kind === 'stock', d.error);
  check('네이버 코드(AAPL.O)를 찾아 해외 종목 정보 · 상세 · 분기 실적을 묻는다',
    calls.some((c) => c.url.includes('/stock/AAPL.O/basic')) && calls.some((c) => c.url.includes('/stock/AAPL.O/integration'))
      && calls.some((c) => c.url.includes('/stock/AAPL.O/finance/quarter')), calls.map((c) => c.url).join('\n'));
  check('거래량은 통합(정규장) 거래량과 그 시각, NXT 같은 따로 셀 것은 없다',
    d.today.volume === 39767256 && d.today.at === '2026-10-15T16:00:00-04:00' && d.today.totalVolume === null, JSON.stringify(d.today));
  check('대금 · 시총', d.today.value === '137억 USD' && d.today.marketValue === '4조 9,912억 USD' && d.today.foreignRate === null);
  check('가치 지표 — N/A 는 빼고 배당락일까지',
    same(d.valuation.map((v) => v.label), ['PER', 'PBR', 'EPS', 'BPS', '배당수익률', '주당배당금', '배당락일'])
      && d.valuation.find((v) => v.label === '배당락일').value === '2026.08.10.', JSON.stringify(d.valuation));
  check('컨센서스 — 미국은 최고 · 최저 목표가와 달러',
    same(d.consensus, { target: 324.89, high: 405, low: 215, opinion: 3.7, date: '2026-10-08', currency: 'USD' }), JSON.stringify(d.consensus));
  check('매매동향 · 실적 일정은 국내만', d.trend === null && d.ir === null);
  check('분기 실적 — USD 백만, 영업이익 자리에 EBIT, 열 순서는 목록 순서',
    d.quarters.unit === 'USD 백만' && same(d.quarters.rows.map((r) => r.title), ['매출액', '영업이익(EBIT)', '당기순이익'])
      && same(d.quarters.cols.map((c) => c.title), ['25.06', '25.09', '25.12', '26.03', '26.06'])
      && same(d.quarters.rows[0].values, [94036, 102466, 143756, 111184, 109417])
      && d.quarters.rows[1].values[4] === 35695, JSON.stringify(d.quarters));
  check('동종 업종 — 해외 목록', d.peers.length === 6 && same(d.peers[0], { name: '델테크놀로지', pct: -6.8, code: 'DELL' }), JSON.stringify(d.peers[0]));
}

// --- 4. 미국 ETF(SOXL) ----------------------------------------------------------------
{
  const d = await detail('SOXL');
  check('미국 ETF', d.ok && d.market === 'us' && d.kind === 'etf', d.error);
  check('분기 실적 · 컨센서스 · 동종 업종이 없으면 비운다', d.quarters === null && d.consensus === null && d.peers.length === 0);
  check('가치 지표는 N/A 를 빼면 배당만 남는다', same(d.valuation.map((v) => v.label), ['배당수익률', '주당배당금', '배당락일']),
    JSON.stringify(d.valuation));
}

// --- 5. 일부 · 전부 실패 ---------------------------------------------------------------
{
  blocked = ['/trend'];
  let d = await detail('005930.KS');
  check('매매동향만 실패하면 그 칸만 비운다', d.ok && d.trend === null && d.valuation.length === 7 && d.quarters !== null);
  blocked = ['polling.finance.naver.com'];
  d = await detail('005930.KS');
  check('KRX 실시간이 실패하면 거래량만 비운다', d.ok && d.today.volume === null && d.today.totalVolume === 21217698, JSON.stringify(d.today));
  blocked = ['/integration'];
  d = await detail('005930.KS');
  check('종목 상세가 실패해도 나머지는 쓴다', d.ok && d.valuation.length === 0 && d.trend.length === 20 && d.today.volume === 11822115);
  blocked = ['finance.daum.net'];
  d = await detail('005930.KS');
  check('거래원이 실패하면 그 칸만 비운다', d.ok && d.traders === null && d.trend.length === 20, JSON.stringify(d.traders));
  blocked = [];
  calls.length = 0;
  d = await detail('AAPL');
  check('미국 종목은 거래원을 묻지 않는다(국내만)', d.ok && !calls.some((c) => c.url.includes('daum')) && !d.traders, calls.map((c) => c.url).join(' '));
  blocked = ['naver.com'];
  d = await detail('005930.KS');
  // 기업정보(wisereport.co.kr)는 막히지 않았지만 주주 구성만으로는 지표 화면이 되지 않는다
  check('전부 실패하면 ok:false', d.ok === false && typeof d.error === 'string', JSON.stringify(d));
  d = await detail('NVDA'); // 고정 데이터에 없음 — 검색은 되지만 해외 응답이 막혔다
  check('미국도 전부 실패하면 ok:false', d.ok === false);
  blocked = [];
}

// --- 6. 받지 않는 것 -------------------------------------------------------------------
{
  calls.length = 0;
  for (const s of ['^KS11', 'KRW=X', '../etc', '']) {
    const d = await detail(s);
    check(`${JSON.stringify(s)} 는 묻지 않고 ok:false`, d.ok === false);
  }
  check('지수 · 환율 · 잘못된 기호로는 요청이 나가지 않는다', calls.length === 0, calls.map((c) => c.url).join(' '));
  const d = await detail('ZZZZ'); // 네이버 검색에 없는 미국 기호
  check('네이버에 없는 미국 종목은 ok:false', d.ok === false && /네이버/.test(d.error), d.error);
}

// --- 7. 관심종목 일정(naver:events) — 목록의 실적 · 배당락 D-day -------------------------------
// 국내는 종목 상세 1건(미리 알린 실적 발표일) + 다음 금융 공시 목록 1건(잠정실적 공시 — 오늘 냈는지, 작년 공시일로 본 예상일), 미국은
// 해외 종목 정보 1건(배당락일). 렌더러가 30분마다 묻고(오늘 공시를 늦지 않게) 네이버 부분은 6시간 기억한다.
const kstIso = (ms) => new RealDate(ms + 9 * 3600000).toISOString().slice(0, 10);
const shiftIso = (iso, days, years = 0) => {
  const d = new RealDate(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const prelim = (day, name = '연결재무제표기준영업(잠정)실적(공정공시)') => ({ no: '20261030800916', day, name });
// 가장 최근에 지난 잠정실적 공시(2026-11-02 사용자 요청) — 날짜만 준다. 얼마나 보일지(일주일)는 렌더러가 정한다(EVENT_PAST_DAYS).
const past = (date) => ({ kind: 'irPast', title: '잠정실적 공시', date });
{
  const events = (symbol) => handlers['naver:events']({}, symbol);
  const TODAY = kstIso(RealDate.now());
  calls.length = 0;
  let e = await events('005930.KS');
  check('국내 — 실적 발표 일정', e.ok && JSON.stringify(e.events) === JSON.stringify([{ kind: 'ir', title: '2026년 3분기 경영실적 발표', date: '2026-10-29' }]),
    JSON.stringify(e));
  check('국내는 종목 상세 · 다음 공시 목록 한 건씩(다음은 Referer)', calls.length === 2 && calls.every((c) => c.signal)
    && calls.some((c) => /\/api\/stock\/005930\/integration$/.test(c.url))
    && calls.some((c) => c.url === 'https://finance.daum.net/api/home/dart-filings?code=005930' && c.referer === 'https://finance.daum.net/'),
  calls.map((c) => c.url).join(' '));
  calls.length = 0;
  await events('005930.KS');
  check('네이버 부분은 6시간 기억한다 — 공시 목록만 다시 묻는다', calls.length === 1 && calls[0].url.includes('dart-filings'),
    calls.map((c) => c.url).join(' '));
  e = await events('069500.KS');
  check('일정이 없으면(ETF) 빈 목록 — 실패가 아니다', e.ok && e.events.length === 0, JSON.stringify(e));

  // 잠정실적 공시(2026-10-30 사용자 제보 — 효성중공업은 일정을 미리 알리지 않고 잠정실적 · IR 안내를 같은 날 공시해 D-day 가 없었다)
  FILINGS['069500'] = [prelim(TODAY), { no: '2', day: TODAY, name: '기업설명회(IR)개최(안내공시)' }, prelim(shiftIso(TODAY, 1, -1))];
  e = await events('069500.KS');
  check('오늘 잠정실적을 공시했으면 오늘 실적 일정', JSON.stringify(e.events) === JSON.stringify([{ kind: 'ir', title: '잠정실적 공시', date: TODAY }]),
    JSON.stringify(e));
  const lastYear = shiftIso(TODAY, 5, -1);
  FILINGS['069500'] = [prelim(lastYear), { no: '3', day: lastYear, name: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)' },
    prelim(shiftIso(TODAY, -60, -1), '영업(잠정)실적(공정공시)'), prelim(shiftIso(TODAY, -100))];
  e = await events('069500.KS');
  check('작년 공시일 + 1년이 앞으로 30일 안이면 예상 일정(정정 · 지난 날 · 먼 날은 뺀다)', JSON.stringify(e.events) === JSON.stringify([
    past(shiftIso(TODAY, -100)), { kind: 'irEst', title: `작년 같은 분기 잠정실적 공시일(${lastYear}) 기준 예상`, date: shiftIso(lastYear, 0, 1) }]), JSON.stringify(e));
  FILINGS['069500'] = [prelim(lastYear), prelim(shiftIso(TODAY, -3))];
  e = await events('069500.KS');
  check('올해 그 분기를 이미 냈으면(예상일 45일 앞부터 오늘 사이 공시) 예상하지 않는다 — 지난 공시만', JSON.stringify(e.events) === JSON.stringify([past(shiftIso(TODAY, -3))]),
    JSON.stringify(e));
  // 미리 알린 일정(네이버)이 앞에 있으면 예상하지 않는다 — 삼성전자 10/29 를 아직 앞에 두려고 10/20 로 돌린다
  SHIFT = RealDate.parse('2026-10-20T12:00:00+09:00') - RealDate.now();
  FILINGS['005930'] = [prelim('2025-10-25')];
  e = await events('005930.KS');
  check('미리 알린 일정이 앞에 있으면 예상 일정은 없다', JSON.stringify(e.events) === JSON.stringify([{ kind: 'ir', title: '2026년 3분기 경영실적 발표', date: '2026-10-29' }, past('2025-10-25')]),
    JSON.stringify(e));

  // 네이버 IR 일정은 그 분기 잠정실적을 아직 내지 않았을 때만 실적이다(2026-11-02 사용자 제보 — 효성중공업이 10/30 잠정실적 뒤
  // 11/4~6 기관 대면 미팅(NDR)을 '3분기 경영실적 발표 및 질의응답' 으로 공시해 '실적 D-2' 가 떴다). 제목에 '실적' 이 없으면(증권사
  // 컨퍼런스 · NDR — 대형주 14곳 IR 공시 97건 중 74건) 실적이 아니다. 아래 제목 · 날짜는 그 IR 공시(DART)의 개최목적 · 일시.
  FILINGS['005930'] = [prelim('2026-10-08')];
  e = await events('005930.KS');
  check('월초 잠정실적 뒤의 컨퍼런스콜은 실적 일정이 아니다(실적 숫자는 이미 나왔다)', JSON.stringify(e.events) === JSON.stringify([past('2026-10-08')]), JSON.stringify(e));
  SHIFT = RealDate.parse('2026-10-29T12:00:00+09:00') - RealDate.now();
  FILINGS['005930'] = [prelim('2026-10-29')];
  e = await events('005930.KS');
  check('같은 날 낸 잠정실적은 그 일정을 지우지 않는다', JSON.stringify(e.events) === JSON.stringify([
    { kind: 'ir', title: '2026년 3분기 경영실적 발표', date: '2026-10-29' }, { kind: 'ir', title: '잠정실적 공시', date: '2026-10-29' }]),
  JSON.stringify(e));
  SHIFT = RealDate.parse('2026-11-02T12:00:00+09:00') - RealDate.now();
  const irInfo = (title, irScheduleDate) => ({ integration: { irScheduleInfo: { title, irScheduleDate } } });
  FX['298040'] = irInfo('2026년 3분기 경영실적 발표 및 질의응답', '2026-11-04');
  FILINGS['298040'] = [prelim('2026-10-30'), { no: '4', day: '2026-10-30', name: '기업설명회(IR)개최(안내공시)' }, prelim('2025-10-31')];
  e = await events('298040.KS');
  check('효성중공업 — 잠정실적(10/30) 뒤의 기관 미팅(11/4)은 실적 D-2 가 아니다 — 지난 공시(10/30)만', JSON.stringify(e.events) === JSON.stringify([past('2026-10-30')]),
    JSON.stringify(e));
  FX['000270'] = irInfo('국내기관 방문 IR (Non-Deal Roadshow) 실시', '2026-11-05');
  FILINGS['000270'] = [prelim('2026-10-30'), prelim('2026-10-01', '영업(잠정)실적(공정공시)')];
  e = await events('000270.KS');
  check('제목에 실적이 없는 IR(NDR · 컨퍼런스)은 실적 일정이 아니다', JSON.stringify(e.events) === JSON.stringify([past('2026-10-30')]), JSON.stringify(e));
  SHIFT = RealDate.parse('2026-11-03T12:00:00+09:00') - RealDate.now();
  FILINGS['000270'] = [prelim('2026-10-30'), prelim('2026-11-03', '영업(잠정)실적(공정공시)')];
  e = await events('000270.KS');
  check('연결 잠정실적을 내는 회사의 매달 별도 잠정실적(기아 · 현대차)은 실적 D-day 가 아니다', JSON.stringify(e.events) === JSON.stringify([past('2026-10-30')]),
    JSON.stringify(e));
  SHIFT = 0;
  FILINGS['069500'] = [prelim(TODAY, '영업(잠정)실적(공정공시)')];
  e = await events('069500.KS');
  check('연결 공시가 없는 회사(한화)는 별도 잠정실적이 분기 실적', JSON.stringify(e.events) === JSON.stringify([{ kind: 'ir', title: '잠정실적 공시', date: TODAY }]),
    JSON.stringify(e));
  FILINGS['069500'] = [prelim(TODAY, '[첨부추가]연결재무제표기준영업(잠정)실적(공정공시)')];
  e = await events('069500.KS');
  check('[첨부추가] 는 정정이 아니라 원래 공시(LG에너지솔루션 7/7)', JSON.stringify(e.events) === JSON.stringify([{ kind: 'ir', title: '잠정실적 공시', date: TODAY }]),
    JSON.stringify(e));
  delete FX['298040'];
  delete FX['000270'];
  delete FILINGS['298040'];
  delete FILINGS['000270'];
  SHIFT = 0;
  blocked = ['finance.daum.net'];
  e = await events('005930.KS');
  check('공시 목록이 실패하면 네이버 일정만', e.ok && e.events.length === 1 && e.events[0].kind === 'ir', JSON.stringify(e));
  blocked = [];
  delete FILINGS['005930'];
  delete FILINGS['069500'];
  calls.length = 0;
  e = await events('AAPL');
  check('미국 — 배당락일(2026.08.10. → 2026-08-10)', e.ok && JSON.stringify(e.events) === JSON.stringify([{ kind: 'exdiv', title: '배당락일', date: '2026-08-10' }]),
    JSON.stringify(e));
  check('미국은 해외 종목 정보 한 건만 묻는다(네이버 코드는 기억해 둔 것)', calls.length === 1 && /\/stock\/AAPL\.O\/basic$/.test(calls[0].url),
    calls.map((c) => c.url).join(' '));
  e = await events('SOXL');
  check('미국 ETF 도 배당락일', e.ok && e.events[0].date === '2026-09-22', JSON.stringify(e));
  calls.length = 0;
  for (const s of ['^KS11', 'KRW=X', '']) check(`${JSON.stringify(s)} 는 일정을 묻지 않는다`, (await events(s)).ok === false);
  check('지수 · 환율로는 요청이 나가지 않는다', calls.length === 0);
  SHIFT = 7 * 3600000; // 네이버 기억이 지난 뒤
  calls.length = 0;
  await events('AAPL');
  check('6시간이 지나면 네이버를 다시 묻는다', calls.some((c) => /\/stock\/AAPL\.O\/basic$/.test(c.url)), calls.map((c) => c.url).join(' '));
  blocked = ['/integration'];
  e = await events('005930.KS');
  check('받지 못하면 ok:false(다음 갱신에 다시 묻게)', e.ok === false && typeof e.error === 'string');
  blocked = [];
  SHIFT = 0;
}

// --- 8. 주주 구성(국내) — 네이버 금융 기업정보 페이지 ---------------------------------------
// JSON 이 없어 페이지의 주요주주 표 · 외국인지분율 · 유동비율을 뽑는다. 주주 명부는 공시로만 바뀌어 종목마다 6시간
// 기억한다 — 지표 화면은 열려 있는 동안 1분마다 다시 받는다.
{
  const asked = () => calls.filter((c) => c.url.includes('wisereport')).length;
  calls.length = 0;
  let d = await detail('005930.KS');
  check('6시간 안에는 기업정보를 다시 묻지 않는다', d.holders?.rows.length === 4 && asked() === 0, calls.map((c) => c.url).join(' '));
  d = await detail('069500.KS');
  check('ETF 의 빈 주주 구성도 기억한다(1분마다 묻지 않게)', d.holders === null && asked() === 0);

  // 받지 못하면 그 칸만 비고, 기억하지 않아 다음 갱신에 다시 묻는다
  blocked = ['wisereport'];
  d = await detail('017670.KS');
  check('기업정보가 실패하면 주주 구성만 빈다', d.ok && d.holders === null && d.valuation.length === 7, JSON.stringify(d.holders));
  blocked = [];
  calls.length = 0;
  d = await detail('017670.KS');
  // 외국인 한도가 있는 종목은 소진율과 지분율이 다르다 — SK텔레콤 10/27 소진율 72.17%, 지분율 35.39%
  check('실패는 기억하지 않아 다음에 다시 묻는다', asked() === 1);
  check('SK텔레콤 — 외국인은 지분율, 유동비율 · 주요주주', same(d.holders, {
    date: '2026-10-27', common: null, foreign: 35.39, float: 57.32,
    rows: [{ name: 'SK 외 11인', pct: 30.6 }, { name: '국민연금공단', pct: 8.46 }, { name: '자사주', pct: 0.81 }],
  }), JSON.stringify(d.holders));

  // 우선주를 물으면 기업정보는 회사(보통주) 페이지를 준다 — 보통주 코드를 같이 돌려 화면이 '보통주 기준' 이라 적게
  d = await detail('005935.KS');
  check('삼성전자우 — 보통주(005930) 기준 값이다', d.holders?.common === '005930' && d.holders.foreign === 46.1
    && d.holders.rows[0].name === '삼성생명보험 외 17인', JSON.stringify(d.holders));

  // 6시간이 지나면 다시 묻는다. 그때 실패하면 있던 것을 둔다 — 공시로만 바뀌는 값이라 지난 것이 빈칸보다 낫다
  SHIFT = 7 * 3600000;
  blocked = ['wisereport'];
  calls.length = 0;
  d = await detail('005930.KS');
  check('6시간이 지나면 다시 묻고, 실패하면 있던 것을 둔다', asked() === 1 && d.holders?.rows.length === 4, JSON.stringify(d.holders));
  blocked = [];
  calls.length = 0;
  d = await detail('005930.KS');
  check('실패한 뒤에는 다음 갱신에 다시 묻는다', asked() === 1 && d.holders?.rows.length === 4);
  calls.length = 0;
  await detail('005930.KS');
  check('받으면 다시 6시간 기억한다', asked() === 0);
  SHIFT = 0;
}

// --- 9. 최근 공시(국내, 2026-11-17) — 다음 금융 공시 목록에서 최근 10건, 누르면 DART 원문 ------------------------------
// 응답은 최근 날부터 온다(2026-11-17 브라우저 실측, 삼성전자 561건 — 같은 날 안은 접수 순이 아님). 거래소 공시(…80…)도 DART 에서 열린다.
{
  FILINGS['005930'] = [
    { no: '20261116001482', day: '2026-11-16', name: '분기보고서 (2026.09)', seen: '2026-11-16 16:49:55' },
    { no: '20261113801115', day: '2026-11-13', name: '기업설명회(IR)개최(안내공시)' },
    { no: '', day: '2026-11-13', name: '번호 없음' },
    { no: '20261113001527', day: '2026.11.13', name: '날짜 틀림' },
    ...Array.from({ length: 12 }, (_, i) => ({ no: `202611010000${String(i).padStart(2, '0')}`, day: '2026-11-01', name: `공시 ${i}` })),
  ];
  calls.length = 0;
  let d = await detail('005930.KS');
  check('최근 공시 — 받은 순서 그대로 10건, 접수번호 · 날짜가 맞는 줄만, 쓰는 필드만',
    d.filings?.length === 10 && same(d.filings[0], { no: '20261116001482', day: '2026-11-16', name: '분기보고서 (2026.09)' })
      && d.filings[1].no === '20261113801115' && d.filings[2].name === '공시 0', JSON.stringify(d.filings?.slice(0, 3)));
  check('공시 목록도 시간 제한 · Referer', calls.some((c) => c.url === 'https://finance.daum.net/api/home/dart-filings?code=005930'
    && c.signal && c.referer === 'https://finance.daum.net/'));
  blocked = ['dart-filings'];
  d = await detail('005930.KS');
  check('공시 목록이 실패하면 그 칸만 비운다', d.ok && d.filings === null && d.trend.length === 20, JSON.stringify(d.filings));
  blocked = [];
  delete FILINGS['005930'];
  calls.length = 0;
  d = await detail('AAPL');
  check('미국 종목은 공시를 묻지 않는다', d.ok && d.filings === undefined && !calls.some((c) => c.url.includes('dart-filings')));

  // 원문 열기 — 렌더러는 접수번호만 넘기고 주소는 main 이 만든다(아무 주소나 열 수 없게)
  const ok = await handlers['dart:open']({}, '20261113801115');
  check('DART 원문을 기본 브라우저로', ok === true && same(opened, ['https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261113801115']), JSON.stringify(opened));
  opened.length = 0;
  const bad = [];
  for (const v of ['https://example.com', '2026111380111', '20261113801115&x=1', null, undefined, { no: 1 }]) bad.push(await handlers['dart:open']({}, v));
  check('접수번호(14자리)가 아니면 열지 않는다', bad.every((r) => r === false) && opened.length === 0, JSON.stringify(bad));
}

// --- 10. 다음 금융 종목 정보(2026-11-24) — 관심종목의 위험 상태 · 52주 · 상하한가(daum:quotes), 휴장일(daum:marketDays), 지표 보기의 회사 개요 ·
// 업종 · 추정 실적 · 재무 · 공시 요약 · 뉴스 · 전일 거래량(naver:detail 의 daum), 뉴스 · 홈페이지 열기. 응답은 같은 날 브라우저에서 본 것의 쓰는 필드만
// (위험 상태는 깨끗한나라우 · 케이아이이 · 핌스의 값 — 다음 금융 화면에 '투자경고 외 1' · '투자주의' 로 보였다)
{
  const state = (o = {}) => ({ isBackDoorListed: false, marketWarning: 'NONE', isTradingSuspended: false, parValueChange: 'NONE', isUnfaithfulDisclosureDesignated: false,
    ex: 'NONE', isAdministrativeIssue: false, revaluation: 'NONE', isPreDelistingTrading: false, isLowLiquidity: false, isDelisted: false, shortTermOverheat: 'NONE',
    isAbnormalRise: false, isInvestmentPrecaution: false, ...o });
  const quote = (code, o = {}) => ({ symbolCode: `A${code}`, market: 'KOSPI', high52wPrice: 374500, high52wDate: '2026-06-19', low52wPrice: 97800, low52wDate: '2025-11-25',
    high50dPrice: 286500, low50dPrice: 171500, upperLimitPrice: 230500, lowerLimitPrice: 124300, stockState: state(), ...o });
  const RISK = { '004545': { stockState: state({ marketWarning: 'ALERT', isAdministrativeIssue: true }) }, '009140': { stockState: state({ marketWarning: 'CAUTION' }) },
    '347770': { stockState: state({ parValueChange: 'MERGE' }) },
    '111111': { stockState: state({ isTradingSuspended: true, marketWarning: 'CAUTION', ex: 'EX_DIVIDEND', shortTermOverheat: 'DESIGNATED' }) } };
  DAUM['/api/quotes?symbolCodes='] = (url) => /symbolCodes=([^&]+)/.exec(url)[1].split(',').map((s) => s.slice(1)).filter((c) => c !== '999999')
    .map((c) => quote(c, RISK[c] || {}));
  calls.length = 0;
  let r = await handlers['daum:quotes']({}, ['005930.KS', '004545.KS', '009140.KS', '347770.KQ', '111111.KS', '999999.KQ', 'AAPL', '^KS11', '005930.KS']);
  check('관심종목 — 국내 종목만 한 번에(같은 종목은 한 번), Referer · 시간 제한', calls.length === 1
    && calls[0].url === 'https://finance.daum.net/api/quotes?symbolCodes=A005930,A004545,A009140,A347770,A111111,A999999'
    && calls[0].signal && calls[0].referer === 'https://finance.daum.net/', calls.map((c) => c.url).join(' '));
  const labels = (c) => r.items[c].risk.map((x) => `${x.label}${x.level}`).join(' ');
  check('위험 상태 — 다음 금융 화면의 이름, 심한 것부터(같은 정도는 정한 순서)', labels('004545') === '투자경고2 관리종목2' && labels('009140') === '투자주의1'
    && labels('347770') === '액면병합0' && labels('111111') === '거래정지2 투자주의1 단기과열1 배당락0' && labels('005930') === '',
    ['004545', '009140', '347770', '111111'].map(labels).join(' / '));
  check('52주 최고 · 최저(날짜) · 50일 최고 · 최저 · 상하한가', same(r.items['005930'], { risk: [], hi52: 374500, hi52Date: '2026-06-19', lo52: 97800, lo52Date: '2025-11-25',
    hi50: 286500, lo50: 171500, upper: 230500, lower: 124300 }), JSON.stringify(r.items['005930']));
  check('모르는 코드는 빠진다', r.ok && !('999999' in r.items));
  calls.length = 0;
  r = await handlers['daum:quotes']({}, Array.from({ length: 51 }, (_, i) => `${100000 + i}.KS`));
  check('50개가 넘으면 나눠 묻는다', calls.length === 2 && Object.keys(r.items).length === 51, `${calls.length}번`);
  calls.length = 0;
  r = await handlers['daum:quotes']({}, ['AAPL', null, 5]);
  check('국내 종목이 없으면 묻지 않는다', r.ok && same(r.items, {}) && calls.length === 0);
  check('목록이 배열이 아니어도 묻지 않는다', (await handlers['daum:quotes']({}, 'AAPL')).ok === true && calls.length === 0);
  blocked = ['finance.daum.net'];
  r = await handlers['daum:quotes']({}, ['005930.KS']);
  check('받지 못하면 ok:false(렌더러는 있던 것을 둔다)', r.ok === false && typeof r.error === 'string', JSON.stringify(r));

  // 휴장일 · 운영시간 — 처음부터 못 받으면 ok:false. 받으면 6시간 기억
  r = await handlers['daum:marketDays']({});
  check('휴장일 — 받지 못하면 ok:false', r.ok === false);
  blocked = [];
  DAUM['/api/home/market-days'] = { days: [
    { date: '2026-11-19', holiday: false, holidayReason: '대학수학능력시험 (1시간 늦춤)', hourChanged: true,
      sessions: [{ session: 'REGULAR', start: '10:00', end: '16:30' }, { session: 'AFTER_MARKET', start: '17:00', end: '20:00' }, { session: 'X', start: '9시' }] },
    { date: '2026-11-21', holiday: true, holidayReason: null, hourChanged: false, sessions: [] }, { date: '2026.11.22', holiday: true }] };
  r = await handlers['daum:marketDays']({});
  check('휴장일 — 날짜 · 휴장 · 운영시간 변경 · 사유 · 세션(시각이 이상한 세션 · 날짜가 이상한 날은 뺀다)', r.ok && same(r.days, [
    { date: '2026-11-19', holiday: false, changed: true, reason: '대학수학능력시험 (1시간 늦춤)',
      sessions: [{ session: 'REGULAR', start: '10:00', end: '16:30' }, { session: 'AFTER_MARKET', start: '17:00', end: '20:00' }] },
    { date: '2026-11-21', holiday: true, changed: false, reason: null, sessions: [] }]), JSON.stringify(r.days));
  calls.length = 0;
  await handlers['daum:marketDays']({});
  check('휴장일은 6시간 기억한다', calls.length === 0, calls.map((c) => c.url).join(' '));

  // 지표 보기 — 삼성전자
  Object.assign(DAUM, {
    '/api/quotes/A005930?summary=true': quote('005930', { companySummary: '동사는 1969년 설립된 글로벌 전자 기업', listingDate: '1975-06-11',
      wicsSectorCode: 'G453010', wicsSectorName: '반도체와반도체장비', wicsSectorChangeRate: 0.0832836706, sectorPer: 20.43901, marketCapRank: 1,
      prevAccTradeVolumeChangeRate: 0.6545692727 }),
    '/api/quote/A005930/financials': { data: { QUARTER: [{ dividendPerShare: 4601, date: '2026-09-01', eps: 11311.791, roe: 0.12851, debtRatio: 28.941 },
      { dividendPerShare: null, date: '2026-06-01', eps: 10717.849, roe: 0.13718, debtRatio: 31.101 }, { date: '이상한 날', eps: 1 }] } },
    '/api/home/consensus?code=005930': { code: '005930', date: '2026-11-23', eps: 45565, per: 3.9 },
    '/api/home/corp?code=005930': { code: '005930', ceo: '전영현, 노태문', home: 'https://www.samsung.com/sec', est: '1969.01.13', emp: 128881 },
    'keyword%3DA005930': { data: [{ newsId: '20261124131932192', title: '5000피 회복', cpKorName: '이데일리', createdAt: '2026-11-24 13:19:32' },
      { newsId: 'https://evil', title: '번호가 아님', cpKorName: 'x', createdAt: '2026-11-24 13:00:00' }] },
    '/api/disclosures?symbolCode=A005930': { data: [
      { disclosureId: '20261113113820', title: '삼성전자(주) 기업설명회(IR) 개최(안내공시)', createdAt: '2026-11-13 15:37:04' },
      { disclosureId: '20261029108257', title: '삼성전자(주) (정정)연결재무제표기준영업(잠정)실적(공정공시)', createdAt: '2026-10-29 10:00:16' },
      { disclosureId: '20261029108254', title: '삼성전자(주) 현금ㆍ현물 배당 결정', createdAt: '2026-10-29 09:53:29' },
      { disclosureId: '20261029108251', title: '삼성전자(주) 연결재무제표기준영업(잠정)실적(공정공시)', createdAt: '2026-10-29 09:50:31' }] },
    '/api/home/disclosure?id=20261029108257': { line: '2026년 3분기 · 매출 195.3조원(전년 동기 대비 +126.9%) · 영업이익 107.4조원(+783.1%)' },
    '/api/home/disclosure?id=20261029108254': { line: '분기배당 · 1주당 4,601원 · 시가배당률 1.7%' },
    '/api/sector/wics/G453010/stocks': { data: [{ symbolCode: 'A005930', name: '삼성전자', change: 'RISE', changeRate: 0.0839 },
      { symbolCode: 'A000660', name: 'SK하이닉스', change: 'FALL', changeRate: 0.02 }, { symbolCode: 'A12', name: '코드 이상' }] },
  });
  const daumCalls = () => calls.filter((c) => c.url.includes('finance.daum.net') && !/trader|dart-filings/.test(c.url));
  calls.length = 0;
  let d = await detail('005930.KS');
  check('지표 — 다음 금융 여섯 곳 + 업종 시총 상위 + 공시 요약 둘, 모두 Referer · 시간 제한', daumCalls().length === 9
    && daumCalls().every((c) => c.signal && c.referer === 'https://finance.daum.net/'), daumCalls().map((c) => c.url).join('\n'));
  const dm = d.daum || {};
  check('회사 개요 — 소개 · 상장 · 대표 · 설립 · 직원 · 홈페이지는 주소 이름만', same(dm.company, { summary: '동사는 1969년 설립된 글로벌 전자 기업', listed: '1975-06-11',
    ceo: '전영현, 노태문', est: '1969.01.13', emp: 128881, home: 'www.samsung.com' }), JSON.stringify(dm.company));
  check('업종 — 이름 · 오늘 등락률(%) · PER · 시장 안 순위 · 시총 상위(목록은 change 로 부호, 코드가 이상한 줄은 뺀다)', dm.sector && dm.sector.name === '반도체와반도체장비'
    && Math.abs(dm.sector.pct - 8.32836706) < 1e-9 && dm.sector.per === 20.43901 && dm.sector.rank === 1 && dm.sector.market === '코스피'
    && same(dm.sector.top, [{ name: '삼성전자', code: '005930', pct: 8.39 }, { name: 'SK하이닉스', code: '000660', pct: -2 }]), JSON.stringify(dm.sector));
  check('추정 실적', same(dm.estimate, { eps: 45565, per: 3.9, date: '2026-11-23' }), JSON.stringify(dm.estimate));
  check('재무 — 네이버 실적 표의 열 이름(YY.MM), ROE 는 %, 날짜가 이상한 줄은 뺀다', same(Object.keys(dm.finance || {}), ['26.09', '26.06'])
    && dm.finance['26.09'].dps === 4601 && Math.abs(dm.finance['26.09'].roe - 12.851) < 1e-9 && dm.finance['26.09'].debt === 28.941 && dm.finance['26.06'].dps === null,
    JSON.stringify(dm.finance));
  check('뉴스 — 기사 번호가 아닌 것은 뺀다, 시각은 분까지', same(dm.news, [{ id: '20261124131932192', title: '5000피 회복', source: '이데일리', at: '2026-11-24 13:19' }]),
    JSON.stringify(dm.news));
  check('공시 요약 — 가장 최근의 잠정실적(정정) · 배당 결정, 다음 금융이 정리한 한 줄', same(dm.notices, [
    { kind: 'earnings', label: '잠정실적', day: '2026-10-29', line: '2026년 3분기 · 매출 195.3조원(전년 동기 대비 +126.9%) · 영업이익 107.4조원(+783.1%)' },
    { kind: 'dividend', label: '배당', day: '2026-10-29', line: '분기배당 · 1주당 4,601원 · 시가배당률 1.7%' }]), JSON.stringify(dm.notices));
  check('전일 대비 거래량', dm.volRatio === 0.6545692727);
  calls.length = 0;
  await detail('005930.KS');
  let again = daumCalls().map((c) => c.url);
  check('다시 열면 시세 요약만 다시 묻고 나머지는 기억한 것', again.length === 1 && again[0].includes('/api/quotes/A005930?summary=true'), again.join(' '));
  SHIFT = 11 * 60000;
  calls.length = 0;
  await detail('005930.KS');
  again = daumCalls().map((c) => c.url);
  check('10분이 지나면 뉴스 · 업종 시총 상위도 다시, 재무 · 추정 · 회사 · 공시는 그대로', again.length === 3 && again.some((u) => u.includes('keyword%3DA005930'))
    && again.some((u) => u.includes('/sector/wics/')), again.join(' '));
  SHIFT = 0;
  blocked = ['finance.daum.net'];
  d = await detail('017670.KS'); // 다음 금융은 처음 묻는 종목
  check('다음 금융이 막혀도 지표는 온다 — 그 부분만 빈다', d.ok && d.trend.length === 20 && Object.values(d.daum).every((v) => v == null), JSON.stringify(d.daum));
  blocked = [];
  d = await detail('AAPL');
  check('미국 종목에는 다음 금융 부분이 없다', d.ok && d.daum === undefined);

  // 뉴스 · 홈페이지 열기 — 렌더러는 기사 번호 · 종목 코드만 넘기고 주소는 main 이 만든다(아무 주소나 열 수 없게)
  opened.length = 0;
  const news = [await handlers['news:open']({}, '20261124131932192'), await handlers['news:open']({}, 'https://evil.example'),
    await handlers['news:open']({}, '123'), await handlers['news:open']({}, null)];
  check('뉴스 원문 — 기사 번호만 받아 다음 뉴스 주소를 만든다', same(news, [true, false, false, false]) && same(opened, ['https://v.daum.net/v/20261124131932192']),
    `${JSON.stringify(news)} ${JSON.stringify(opened)}`);
  opened.length = 0;
  Object.assign(DAUM, { '/api/home/corp?code=035720': { code: '035720', home: 'www.kakaocorp.com' }, // 앞에 scheme 이 없는 꼴
    '/api/home/corp?code=111111': { code: '111111', home: 'javascript:alert(1)' }, '/api/home/corp?code=222222': { code: '222222', missing: true } });
  const home = [];
  for (const c of ['005930', '035720', '111111', '222222', '999998', '../x', 'https://evil.example', null]) home.push(await handlers['corp:open']({}, c));
  check('홈페이지 — 회사 정보의 http(s) 주소만(scheme 없는 www.… 도), 렌더러가 준 주소 · javascript: · 회사 정보 없음은 열지 않는다',
    same(home, [true, true, false, false, false, false, false, false]) && same(opened, ['https://www.samsung.com/sec', 'http://www.kakaocorp.com/']),
    `${JSON.stringify(home)} ${JSON.stringify(opened)}`);
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
