// 데이터 출처 점검 — 앱이 쓰는 비공식 주소(네이버 · 야후 · FRED · WiseReport)를 실제로 불러, 앱의 받기 · 해석 코드(main.js 의
// IPC 처리기)가 지금도 쓸 만한 값을 내는지 본다. 주소가 막히거나 응답 모양이 바뀌면 그 항목이 FAIL 이고 종료 코드가 1 이다.
//
// 앱을 띄우지 않는다 — 다른 스위트처럼 가짜 electron 으로 main.js 를 읽되(tests/_main.mjs) fetch 만 진짜를 끼운다. 그래서 주소뿐
// 아니라 해석 코드까지 같이 본다. 항목마다 그동안 나간 요청을 기록해, 결과는 멀쩡해도 요청 하나가 실패했으면(네이버가 막혀
// 야후로 대신 그린 경우 등) FAIL 이다 — 앱은 조용히 대체 경로로 넘어가 화면만 봐서는 모른다.
//
// 네트워크를 쓰므로 푸시마다 도는 고정 데이터 스위트(.github/workflows/test.yml)에는 넣지 않고 매주 따로 돈다
// (.github/workflows/sources.yml). 손으로는 `npm run check:sources`. 시세 · 장 상태에 따라 값은 달라지니 모양만 본다(있는지 ·
// 숫자인지 · 그럴듯한 범위 · 최근 날짜). 국내 장중(평일 09:00~15:30)에 돌려야 분봉 · 실시간 항목이 비지 않는다.
// 판정 로직(CHECKS 의 verify)은 tests/sources.mjs 가 네트워크 없이 고정 값으로 본다.
import { pathToFileURL } from 'node:url';
import { loadMain } from './_main.mjs';

// main.js 를 읽어 IPC 처리기를 꺼낸다. fetch 는 받은 것을, Electron net.fetch 자리는 netImpl(없으면 같은 fetch)을 쓴다.
// 앱은 FRED · CNN 만 Electron net.fetch 로 받는다 — 이 파일만 돌리면 Node fetch 로 대신해 주소 · 응답 모양만 본다(Electron 에서만
// 막히는 것은 못 본다 — tests/sources-electron.mjs 가 진짜 net.fetch 를 넘긴다)
export function loadHandlers(fetchImpl, netImpl = fetchImpl) {
  return loadMain({ globals: { fetch: fetchImpl }, electron: { net: { fetch: netImpl } }, platform: 'check' });
}

const DAY = 86400000;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pos = (v) => num(v) && v > 0;
const need = (cond, msg) => (cond ? [] : [msg]);
const okOf = (r) => need(r && r.ok === true, `ok 가 아님 — ${r && r.error ? r.error : String(JSON.stringify(r)).slice(0, 80)}`);
// 'YYYYMMDD' · 'YYYY-MM-DD' · ms 가 days 일 안인지(주말 · 연휴를 넘겨 여유를 둔다)
const recent = (d, days) => {
  const ms = typeof d === 'number' ? d : Date.parse(String(d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
  return Number.isFinite(ms) && Date.now() - ms < days * DAY && ms - Date.now() < DAY;
};
// 차트 응답(yf:chart) — 봉 수 · 숫자 종가 · 마지막 봉 날짜
const series = (r, label, minBars, days) => [
  ...okOf(r).map((m) => `${label}: ${m}`),
  ...(r && r.ok ? [
    ...need(Array.isArray(r.closes) && r.closes.length >= minBars, `${label}: 봉 ${r.closes ? r.closes.length : 0}개(${minBars}개 이상이어야)`),
    ...need(Array.isArray(r.closes) && r.closes.every(pos), `${label}: 종가에 숫자가 아닌 값`),
    ...need(Array.isArray(r.times) && recent(r.times.at(-1), days), `${label}: 마지막 봉이 ${days}일보다 오래됨`),
  ] : []),
];
// 지금 한국 날짜 'YYYYMMDD' · 시각 HHMM(숫자)
const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const kstHm = () => Number(new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 16).replace(':', ''));
const yahooCalled = (calls) => need(!calls.some((c) => c.url.includes('finance.yahoo.com')), '네이버 대신 야후로 그렸다(네이버 응답을 못 씀)');

// 점검 항목. call 은 IPC 처리기를 부르고, verify(결과, 그동안의 요청) 는 문제 목록(빈 배열이면 통과)을 낸다.
export const CHECKS = [
  {
    name: '국내 실시간 시세', source: '네이버 polling (KRX · NXT)',
    call: (h) => h['quote:realtime']({}, ['005930.KS', '000660.KS']),
    verify: (r) => [...okOf(r), ...['005930', '000660'].flatMap((c) => {
      const q = r && r.quotes && r.quotes[c];
      return need(q && pos(q.price) && pos(q.prevClose), `${c}: 가격 · 전일 종가 없음`);
    })],
  },
  {
    name: '미국 실시간 시세', source: '네이버 polling (worldstock)',
    call: (h) => h['quote:realtime']({}, ['AAPL', 'NVDA']),
    verify: (r) => [...okOf(r), ...['AAPL', 'NVDA'].flatMap((s) => {
      const q = r && r.quotes && r.quotes[s];
      return need(q && pos(q.price) && pos(q.prevClose), `${s}: 가격 · 전일 종가 없음`);
    })],
  },
  {
    name: '지수 줄', source: '네이버 polling · 미국채 · 야후 환율',
    call: (h) => h['quote:indices'](),
    verify: (r) => [...okOf(r), ...['KOSPI', 'KOSDAQ', 'KPI200', 'FUT', 'NASDAQ', 'SPX', 'VIX', 'SOX', 'NQ', 'WTI', 'BRENT', 'US10Y', 'USDKRW'].flatMap((code) => {
      const it = r && Array.isArray(r.items) && r.items.find((i) => i.code === code);
      return need(it && pos(it.value) && num(it.pct), `${code}: 값 · 등락률 없음`);
    })],
  },
  {
    name: '시장 지표', source: '네이버 수급 · 지수 일봉, FRED HY OAS, 다음 금융 장중 수급, CNN 공포 · 탐욕',
    call: (h) => h['market:extras'](),
    verify: (r) => [...okOf(r), ...(r && r.ok ? [
      ...need(Array.isArray(r.kospiDays) && r.kospiDays.length >= 10 && r.kospiDays.every((d) => pos(d.close)), '코스피 일별 종가가 10일 미만'),
      ...need(Array.isArray(r.kospiDays) && r.kospiDays.length && recent(r.kospiDays.at(-1).date, 7), '코스피 일봉이 7일보다 오래됨'),
      ...need(Array.isArray(r.futDays) && r.futDays.length >= 10, '코스피200 선물 일별 종가가 10일 미만'),
      ...need(Array.isArray(r.k200Days) && r.k200Days.length >= 10 && r.k200Days.every((d) => pos(d.close)), '코스피200 현물 일별 종가가 10일 미만'),
      // 오늘 1분 종가 — 오늘이 거래일(일봉에 오늘이 있다)이고 09:10 이 지났으면 비면 안 된다(베이시스를 선물 시각에 못 맞춘다)
      ...need(Array.isArray(r.k200Min) && r.k200Min.every((m) => num(m.t) && pos(m.close)), '코스피200 현물 1분 종가 모양이 다름'),
      ...need(!(Array.isArray(r.k200Days) && r.k200Days.length && r.k200Days.at(-1).date === kstToday() && kstHm() >= 910)
        || (Array.isArray(r.k200Min) && r.k200Min.length > 0), '오늘 장중인데 코스피200 현물 1분 종가가 비었음'),
      ...need(Array.isArray(r.spotFlows) && r.spotFlows.some((f) => f.final && num(f.foreign)), '외국인 현물 수급(확정일)이 없음'),
      ...need(Array.isArray(r.futFlows) && r.futFlows.some((f) => f.final && num(f.foreign)), '외국인 선물 수급(확정일)이 없음'),
      ...need(Array.isArray(r.hyOas) && r.hyOas.length >= 6 && r.hyOas.every((d) => num(d.value)), 'HY OAS 가 6개 미만'),
      ...need(Array.isArray(r.hyOas) && r.hyOas.length && recent(r.hyOas.at(-1).date, 10), 'HY OAS 가 10일보다 오래됨'),
      // 미국 장단기 금리차(FRED T10Y2Y, 2026-11-03) — 역전이면 − 라 부호는 보지 않는다
      ...need(Array.isArray(r.curve) && r.curve.length >= 6 && r.curve.every((d) => num(d.value)), '장단기 금리차가 6개 미만'),
      ...need(Array.isArray(r.curve) && r.curve.length && recent(r.curve.at(-1).date, 10), '장단기 금리차가 10일보다 오래됨'),
      // 장중 수급(다음 금융, 2026-10-30) — 장 전 · 휴장일에도 마지막 거래일 값이 오는지는 아직 모른다
      ...need(r.intraday && Array.isArray(r.intraday.spot) && r.intraday.spot.length > 0
        && r.intraday.spot.every((s) => num(s.t) && num(s.foreign) && num(s.individual) && num(s.institution)), '장중 수급 현물(다음 금융)이 없음'),
      ...need(r.intraday && Array.isArray(r.intraday.spot) && r.intraday.spot.length && recent(r.intraday.spot.at(-1).t, 7),
        '장중 수급 현물이 7일보다 오래됨'),
      ...need(r.intraday && Array.isArray(r.intraday.fut) && r.intraday.fut.length > 0 && r.intraday.fut.every((s) => num(s.foreign)),
        '장중 수급 선물(다음 금융)이 없음'),
      ...need(r.intraday && num(r.intraday.program), '프로그램 매매(다음 금융)가 없음'),
      // CNN 공포 · 탐욕(2026-11-03) — 공식 API 가 아닌 CNN 웹페이지 데이터
      ...need(r.fearGreed && num(r.fearGreed.score) && r.fearGreed.score >= 0 && r.fearGreed.score <= 100 && r.fearGreed.rating,
        'CNN 공포 · 탐욕 점수가 없음'),
      ...need(r.fearGreed && Array.isArray(r.fearGreed.days) && r.fearGreed.days.length >= 10, 'CNN 공포 · 탐욕 날마다 기록이 10일 미만'),
      ...need(r.fearGreed && recent(Date.parse(r.fearGreed.at), 7), 'CNN 공포 · 탐욕이 7일보다 오래됨'),
    ] : [])],
  },
  {
    // 일봉 캔들 기준 '통합'(증권사 앱의 통합 캔들) — 네이버 KRX · NXT 일봉을 합친 값. 삼성전자는 NXT 에서 날마다 거래된다.
    name: '통합 일봉 (KRX + NXT)', source: '네이버 KRX · NXT 일봉',
    call: (h) => h['naver:venueDays']({}, '005930.KS', new Date(Date.now() - 30 * DAY + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '')),
    verify: (r) => {
      const days = r && r.ok && r.days ? Object.entries(r.days).sort(([a], [b]) => a.localeCompare(b)) : [];
      return [...okOf(r),
        ...need(days.length >= 10, `NXT 거래일이 30일에 ${days.length}일뿐`),
        ...need(days.every(([d, v]) => /^\d{8}$/.test(d) && [v.open, v.high, v.low, v.close].every(pos)
          && v.low <= Math.min(v.open, v.close) && v.high >= Math.max(v.open, v.close)), '시 · 고 · 저 · 종이 맞지 않는 날이 있음'),
        ...need(days.length && recent(days[days.length - 1][0], 7), '마지막 날이 7일보다 오래됨')];
    },
  },
  {
    name: '일봉 5년', source: '야후 chart (국내 · 미국 · 지수)',
    call: async (h) => ({
      kr: await h['yf:chart']({}, { symbol: '005930.KS', range: '5y', interval: '1d' }),
      us: await h['yf:chart']({}, { symbol: 'AAPL', range: '5y', interval: '1d' }),
      ix: await h['yf:chart']({}, { symbol: '^KS11', range: '5y', interval: '1d' }),
    }),
    verify: (r) => [
      ...series(r.kr, '005930.KS', 1000, 7), ...series(r.us, 'AAPL', 1000, 7), ...series(r.ix, '^KS11', 1000, 7),
      ...need(r.kr && Array.isArray(r.kr.volumes) && r.kr.volumes.some(pos), '005930.KS: 거래량이 없음'),
      ...need(r.ix && Array.isArray(r.ix.volumes) && r.ix.volumes.some(pos), '^KS11: 거래량이 없음(코스톨라니 달걀이 빈다)'),
    ],
  },
  {
    name: '국내 1D 분봉', source: '네이버 KRX 분봉 · NXT',
    call: (h) => h['yf:chart']({}, { symbol: '005930.KS', range: '1d', interval: '5m', extended: true }),
    verify: (r, calls) => [...series(r, '005930.KS 1D', 1, 4), ...yahooCalled(calls)],
  },
  {
    name: '국내 1W 30분봉 · 시간외', source: '네이버 KRX 분봉 · NXT',
    call: (h) => h['yf:chart']({}, { symbol: '005930.KS', range: '5d', interval: '30m', extended: true }),
    verify: (r, calls) => [...series(r, '005930.KS 1W', 20, 4),
      ...need(r && Array.isArray(r.ext) && r.ext.includes('after'), '005930.KS 1W: 애프터마켓(NXT) 봉이 없음'), ...yahooCalled(calls)],
  },
  {
    // NXT 에 없는 종목의 애프터는 KRX 분봉의 장 종료 칸 뒤(2026-10-30 사용자 제보 — DSC인베스트먼트)
    name: '국내 1W 애프터 (NXT 밖 종목)', source: '네이버 KRX 분봉',
    call: (h) => h['yf:chart']({}, { symbol: '241520.KQ', range: '5d', interval: '30m', extended: true }),
    verify: (r, calls) => [...series(r, '241520.KQ 1W', 20, 4),
      ...need(r && Array.isArray(r.ext) && r.ext.includes('after'), '241520.KQ 1W: 애프터마켓(KRX) 봉이 없음'), ...yahooCalled(calls)],
  },
  {
    name: '1D RSI 앞 거래일 5분봉', source: '네이버 KRX 분봉',
    call: (h) => h['yf:chart']({}, { symbol: '005930.KS', range: '5d', interval: '5m' }),
    verify: (r, calls) => [...series(r, '005930.KS 5d/5m', 150, 4), ...yahooCalled(calls)],
  },
  {
    name: '미국 1D 프리 · 애프터', source: '야후 chart includePrePost',
    call: (h) => h['yf:chart']({}, { symbol: 'AAPL', range: '1d', interval: '5m', extended: true }),
    verify: (r) => series(r, 'AAPL 1D', 10, 4),
  },
  {
    name: '선물 · 미국채 1D', source: '네이버 하루 차트(front-api)',
    call: async (h) => ({
      nq: await h['yf:chart']({}, { symbol: 'NQ=F', range: '1d', interval: '5m' }),
      tnx: await h['yf:chart']({}, { symbol: '^TNX', range: '1d', interval: '5m' }),
    }),
    verify: (r, calls) => [...series(r.nq, 'NQ=F 1D', 10, 4), ...series(r.tnx, '^TNX 1D', 10, 4), ...yahooCalled(calls)],
  },
  {
    // 지표 화면의 달러 인덱스 · 금 · 구리(2026-11-03) — 값도 차트도 야후 일봉이다(실시간 값을 줄 네이버 코드를 확인하지 못했다)
    name: '달러 인덱스 · 금 · 구리 일봉', source: '야후 차트',
    call: async (h) => ({
      dxy: await h['yf:chart']({}, { symbol: 'DX-Y.NYB', range: '1mo', interval: '1d' }),
      gold: await h['yf:chart']({}, { symbol: 'GC=F', range: '1mo', interval: '1d' }),
      copper: await h['yf:chart']({}, { symbol: 'HG=F', range: '1mo', interval: '1d' }),
    }),
    verify: (r) => [...series(r.dxy, 'DX-Y.NYB 1M', 15, 5), ...series(r.gold, 'GC=F 1M', 15, 5), ...series(r.copper, 'HG=F 1M', 15, 5)],
  },
  {
    // 지표 화면의 코스피200 현물 · 선물 줄을 누르면 그리는 차트(2026-10-30) — 야후에 없어 분봉 · 일봉 모두 네이버다
    name: '코스피200 현물 · 선물 차트', source: '네이버 지수 분봉 · 일봉',
    call: async (h) => ({
      spot: await h['yf:chart']({}, { symbol: '^KS200', range: '1d', interval: '5m' }),
      fut: await h['yf:chart']({}, { symbol: '^KS200F', range: '1d', interval: '5m' }),
      spotDay: await h['yf:chart']({}, { symbol: '^KS200', range: '5y', interval: '1d' }),
      futDay: await h['yf:chart']({}, { symbol: '^KS200F', range: '5y', interval: '1d' }),
      futMax: await h['yf:chart']({}, { symbol: '^KS200F', range: 'max', interval: '1mo' }),
    }),
    verify: (r, calls) => [...series(r.spot, '^KS200 1D', 1, 4), ...series(r.fut, '^KS200F 1D', 1, 4),
      ...series(r.spotDay, '^KS200 5년 일봉', 1000, 7), ...series(r.futDay, '^KS200F 5년 일봉', 1000, 7),
      ...series(r.futMax, '^KS200F 전체(월봉)', 60, 40), ...yahooCalled(calls)],
  },
  {
    name: '종목 지표 (국내)', source: '네이버 종목 상세 · 매매동향 · 분기 실적, WiseReport 주주, 다음 거래원',
    call: (h) => h['naver:detail']({}, '005930.KS'),
    verify: (r) => [...okOf(r), ...(r && r.ok ? [
      ...need(r.today && num(r.today.volume), '오늘 거래량 없음'),
      ...need(Array.isArray(r.valuation) && r.valuation.length >= 3, '가치 지표가 3개 미만'),
      ...need(Array.isArray(r.trend) && r.trend.length >= 10, '투자자별 매매동향이 10일 미만'),
      ...need(r.quarters && Array.isArray(r.quarters.cols) && r.quarters.cols.length >= 4, '분기 실적이 4분기 미만'),
      ...need(r.holders && Array.isArray(r.holders.rows) && r.holders.rows.length >= 1, '주주 구성(WiseReport)이 없음'),
      ...need(r.consensus && pos(r.consensus.target), '컨센서스 목표가가 없음'),
      // 거래원(다음 금융, 2026-10-30) — 장 전에도 오늘(또는 마지막 거래일) 목록이 오는지는 아직 모른다
      ...need(r.traders && Array.isArray(r.traders.buy) && r.traders.buy.length >= 5 && Array.isArray(r.traders.sell) && r.traders.sell.length >= 5
        && r.traders.buy.every((t) => t.name && pos(t.volume)), '거래원(다음 금융)이 5개사 미만'),
    ] : [])],
  },
  {
    name: '종목 지표 (미국 · ETF)', source: '네이버 해외 종목 정보 · ETF',
    call: async (h) => ({ us: await h['naver:detail']({}, 'AAPL'), etf: await h['naver:detail']({}, '069500.KS') }),
    verify: (r) => [
      ...okOf(r.us).map((m) => `AAPL: ${m}`),
      ...(r.us && r.us.ok ? [
        ...need(Array.isArray(r.us.valuation) && r.us.valuation.length >= 3, 'AAPL: 가치 지표가 3개 미만'),
        ...need(r.us.quarters && Array.isArray(r.us.quarters.cols) && r.us.quarters.cols.length >= 4, 'AAPL: 분기 실적이 4분기 미만'),
      ] : []),
      ...okOf(r.etf).map((m) => `069500: ${m}`),
      ...(r.etf && r.etf.ok ? need(r.etf.kind === 'etf' && r.etf.etf && pos(r.etf.etf.nav), '069500: ETF NAV 가 없음') : []),
    ],
  },
  {
    name: '일정 (실적 · 배당락)', source: '네이버 종목 상세 · 다음 공시 목록',
    call: async (h) => ({ kr: await h['naver:events']({}, '005930.KS'), us: await h['naver:events']({}, 'AAPL') }),
    verify: (r) => [...okOf(r.kr).map((m) => `005930: ${m}`), ...okOf(r.us).map((m) => `AAPL: ${m}`),
      ...need(r.kr && Array.isArray(r.kr.events) && r.us && Array.isArray(r.us.events), '일정이 배열이 아님')],
  },
  {
    name: '시장 순위', source: '네이버 순위 · 업종 · 테마',
    call: async (h) => {
      const theme = await h['naver:rank']({}, { market: 'kr', kind: 'theme' });
      const first = theme && theme.ok && theme.groups && theme.groups[0];
      return {
        search: await h['naver:rank']({}, { market: 'kr', kind: 'search' }),
        up: await h['naver:rank']({}, { market: 'kr', kind: 'up' }),
        us: await h['naver:rank']({}, { market: 'us', kind: 'up' }),
        industry: await h['naver:rank']({}, { market: 'kr', kind: 'industry' }),
        theme,
        inside: first ? await h['naver:rank']({}, { market: 'kr', kind: 'theme', no: first.no }) : null,
      };
    },
    verify: (r) => [
      ...['search', 'up', 'us'].flatMap((k) => [...okOf(r[k]).map((m) => `${k}: ${m}`),
        ...need(r[k] && Array.isArray(r[k].items) && r[k].items.length >= 5
          && r[k].items.every((i) => i.symbol && i.name && pos(i.price) && num(i.pct)), `${k}: 종목이 5개 미만이거나 값이 빔`)]),
      ...['industry', 'theme'].flatMap((k) => [...okOf(r[k]).map((m) => `${k}: ${m}`),
        ...need(r[k] && Array.isArray(r[k].groups) && r[k].groups.length >= 10, `${k}: 묶음이 10개 미만`)]),
      ...need(r.inside && r.inside.ok && Array.isArray(r.inside.items), '테마 안 종목을 못 받음'),
    ],
  },
  {
    name: '종목 검색', source: '네이버 검색',
    call: async (h) => ({ kr: await h['yf:search']({}, '삼성전자'), us: await h['yf:search']({}, 'nvidia') }),
    verify: (r) => [
      ...need(r.kr && r.kr.ok && r.kr.items.some((i) => i.symbol === '005930.KS'), '삼성전자 → 005930.KS 가 없음'),
      ...need(r.us && r.us.ok && r.us.items.some((i) => i.symbol === 'NVDA'), 'nvidia → NVDA 가 없음'),
    ],
  },
  {
    name: '업종', source: '네이버 업종 · 야후 검색',
    call: async (h) => ({ kr: await h['yf:sector']({}, '005930.KS'), us: await h['yf:sector']({}, 'AAPL') }),
    verify: (r) => [
      ...need(r.kr && r.kr.ok && r.kr.industry, '005930.KS: 업종이 없음'),
      ...need(r.us && r.us.ok && (r.us.sector || r.us.industry), 'AAPL: 업종이 없음'),
    ],
  },
];

// 항목을 차례로 돌린다(동시에 몰아 묻지 않는다 — 출처가 막을 수 있다). 항목마다 그동안 나간 요청을 기록해 실패한 요청도
// 문제로 넣는다. netImpl 은 Electron net.fetch 자리(loadHandlers). → [{ name, source, problems, calls }]
export async function runChecks(fetchImpl, checks = CHECKS, netImpl = fetchImpl) {
  let calls = [];
  const recorded = (impl) => async (url, opt) => {
    const at = String(url);
    try {
      const res = await impl(url, opt);
      calls.push({ url: at, status: res.status });
      return res;
    } catch (err) {
      calls.push({ url: at, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  };
  const handlers = loadHandlers(recorded(fetchImpl), recorded(netImpl));
  const out = [];
  for (const c of checks) {
    calls = [];
    let problems;
    try {
      const r = await c.call(handlers);
      problems = c.verify(r, calls);
    } catch (err) {
      problems = [`예외 — ${err && err.message ? err.message : err}`];
    }
    const failed = calls.filter((x) => x.error || x.status >= 400)
      .map((x) => `요청 실패 ${x.error || `HTTP ${x.status}`} — ${x.url.replace(/\?.*$/, '')}`);
    out.push({ name: c.name, source: c.source, problems: [...problems, ...failed], calls: calls.slice() });
  }
  return out;
}

// node tests/sources-live.mjs — 진짜 fetch 로 돌리고 결과를 적는다. 하나라도 FAIL 이면 종료 코드 1.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = new Date();
  console.log(`데이터 출처 점검 ${started.toISOString()} (KST ${new Date(started.getTime() + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ')})`);
  const results = await runChecks(globalThis.fetch);
  for (const r of results) {
    console.log(`${r.problems.length ? 'FAIL' : 'OK  '} ${r.name}  (${r.source}, 요청 ${r.calls.length}개)`);
    for (const p of r.problems) console.log(`       - ${p}`);
  }
  const bad = results.filter((r) => r.problems.length).length;
  console.log(`\n${bad ? 'FAIL' : 'PASS'}: ${results.length}개 중 ${bad}개 실패`);
  process.exit(bad ? 1 : 0);
}
