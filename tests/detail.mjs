// 지표 보기(naver:detail) — 앱을 띄우지 않고 가짜 electron 으로 main.js 의 핸들러를 부른다.
//
// 차트 대신 보는 지표 화면의 데이터다. 국내는 네이버 종목 상세(가치 지표 · 컨센서스 · 실적 일정 · 동종 업종) ·
// 투자자별 매매동향 · 분기 실적 · KRX 실시간 거래량, 미국은 네이버 해외 종목 정보 · 컨센서스 · 분기 실적.
// 응답은 2026-10-16 실측(tests/fixtures/naver-detail-20261016.json, 쓰는 필드만)이다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const FX = JSON.parse(fs.readFileSync(new URL('fixtures/naver-detail-20261016.json', import.meta.url), 'utf8'));

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

// 주소로 고정 데이터를 고른다. blocked 에 든 조각이 주소에 있으면 그 요청은 실패한다.
const calls = [];
let blocked = [];
const route = (url) => {
  let m = /m\.stock\.naver\.com\/api\/stock\/(\w+)\/(integration|trend|finance\/quarter)/.exec(url);
  if (m) return FX[m[1]]?.[{ integration: 'integration', trend: 'trend', 'finance/quarter': 'quarter' }[m[2]]];
  m = /polling\.finance\.naver\.com\/api\/realtime\/domestic\/stock\/(\w+)$/.exec(url);
  if (m) return FX[m[1]]?.realtime;
  m = /autoComplete\?query=(\w+)/.exec(url);
  if (m) return Object.values(FX).find((f) => f.search?.result.items[0].code === m[1])?.search ?? { result: { items: [] } };
  m = /api\.stock\.naver\.com\/stock\/([\w.]+)\/(basic|integration|finance\/quarter)/.exec(url);
  if (m) return FX[m[1]]?.[{ basic: 'basic', integration: 'integration', 'finance/quarter': 'quarter' }[m[2]]];
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
const detail = (symbol) => handlers['naver:detail']({}, symbol);

// --- 1. 국내 주식(삼성전자) ------------------------------------------------------------
{
  calls.length = 0;
  const d = await detail('005930.KS');
  check('성공', d.ok === true, d.error);
  check('국내 · 주식', d.market === 'kr' && d.kind === 'stock');
  check('네 군데를 묻는다(종목 상세 · 매매동향 · 분기 실적 · KRX 실시간), 모두 시간 제한을 건다',
    calls.length === 4 && calls.every((c) => c.signal), calls.map((c) => c.url).join('\n'));
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
  check('동종 업종 — 이름과 등락률', same(d.peers.slice(0, 2), [{ name: 'SK하이닉스', pct: 3.25 }, { name: 'SK스퀘어', pct: 3.92 }])
    && d.peers.length === 6, JSON.stringify(d.peers));
  check('ETF 칸은 없다', d.etf === null);
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
  check('동종 업종 — 해외 목록', d.peers.length === 6 && same(d.peers[0], { name: '델테크놀로지', pct: -6.8 }), JSON.stringify(d.peers[0]));
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
  blocked = ['naver.com'];
  d = await detail('005930.KS');
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

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
