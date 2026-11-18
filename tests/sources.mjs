// 데이터 출처 점검(tests/sources-live.mjs)의 판정 — 네트워크 없이 고정 값으로 본다. 진짜 출처를 부르는 것은 sources-live 가
// 매주 한다(.github/workflows/sources.yml). 여기서는 (1) 앱이 네트워크를 쓰는 IPC 처리기가 모두 점검에 들어 있는지,
// (2) 정상 모양은 통과하고 깨진 모양 · 실패한 요청은 FAIL 인지, (3) 출처가 모두 막혀도 점검이 죽지 않는지 본다.
import fs from 'node:fs';
import { CHECKS, runChecks } from './sources-live.mjs';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// --- 1. 네트워크를 쓰는 IPC 처리기는 모두 점검한다 — 처리기를 새로 만들고 점검을 빠뜨리면 여기서 걸린다 ---------------------
{
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  // 설정 파일만 읽고 쓴다 · 공시 원문은 기본 브라우저에 맡긴다(dart:open — 요청을 보내지 않는다) · 모아 둔 장중 수급 파일을 읽는다
  const local = new Set(['state:get', 'state:set', 'backup:export', 'backup:import', 'dart:open', 'market:intradayPast']);
  const names = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]).filter((n) => !local.has(n));
  const called = CHECKS.map((c) => c.call.toString()).join('\n');
  const missing = names.filter((n) => !called.includes(`h['${n}']`));
  check(`네트워크 처리기 ${names.length}개가 모두 점검에 있다`, names.length >= 9 && missing.length === 0, missing.join(', '));
  check('점검 이름이 겹치지 않는다', new Set(CHECKS.map((c) => c.name)).size === CHECKS.length);
}

// --- 2. 판정 — 정상 모양은 통과, 깨진 모양은 FAIL -------------------------------------------------------------------
const DAY = 86400000;
const ymd = (ago) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10).replace(/-/g, '');
const chart = (n, lastAgo = 0, extra = {}) => ({
  ok: true, closes: Array(n).fill(100), volumes: Array(n).fill(10),
  times: Array.from({ length: n }, (_, i) => Date.now() - lastAgo * DAY - (n - 1 - i) * 300000), ...extra,
});
const items = (n) => Array.from({ length: n }, (_, i) => ({ symbol: `00000${i}.KS`, name: `종목${i}`, price: 1000, pct: 1.5 }));
const days = (n) => Array.from({ length: n }, (_, i) => ({ date: ymd(n - 1 - i), close: 2500 }));
const GOOD = {
  '국내 실시간 시세': { ok: true, quotes: { '005930': { price: 230000, prevClose: 232000 }, '000660': { price: 1529000, prevClose: 1487000 } } },
  '미국 실시간 시세': { ok: true, quotes: { AAPL: { price: 270, prevClose: 268 }, NVDA: { price: 200, prevClose: 205 } } },
  '지수 줄': { ok: true, items: ['KOSPI', 'KOSDAQ', 'KPI200', 'FUT', 'NASDAQ', 'SPX', 'VIX', 'SOX', 'NQ', 'WTI', 'BRENT', 'US10Y', 'USDKRW'].map((code) => ({ code, value: 10, pct: -0.5 })) },
  '시장 지표': { ok: true, kospiDays: days(20), futDays: days(20), k200Days: days(20), k200Min: [{ t: Date.now() - 60000, close: 880 }],
    intraday: { spot: [{ t: Date.now() - 60000, foreign: -13737, individual: 7761, institution: 3670, pension: 4853, corp: 2306 }],
      fut: [{ t: Date.now() - 60000, foreign: 203, individual: 434, institution: -541, pension: 130, corp: -96 }], program: -419 },
    spotFlows: [{ date: ymd(1), foreign: -1200, final: true }],
    futFlows: [{ date: ymd(1), foreign: 300, final: true }], hyOas: Array.from({ length: 60 }, (_, i) => ({ date: ymd(61 - i), value: 3.2 })),
    fearGreed: { score: 22.7, rating: 'extreme fear', at: new Date(Date.now() - 3600000).toISOString(), prevClose: 22.7, week: 32.9,
      month: 38.2, year: 32.6, days: Array(30).fill(25) },
    curve: Array.from({ length: 60 }, (_, i) => ({ date: ymd(61 - i), value: i % 2 ? 0.5 : -0.1 })) },
  '외국인 수급 이력': { ok: true, errors: {},
    spotFlows: Array.from({ length: 720 }, (_, i) => ({ date: ymd(720 - i), foreign: i - 300, final: true })),
    futFlows: Array.from({ length: 720 }, (_, i) => ({ date: ymd(720 - i), foreign: 300 - i, final: true })) },
  '통합 일봉 (KRX + NXT)': { ok: true,
    days: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [ymd(20 - i), { open: 100, high: 110, low: 90, close: 105 }])) },
  '일봉 5년': { kr: chart(1220, 1), us: chart(1254, 1), ix: chart(1221, 1) },
  '국내 1D 분봉': chart(70),
  '국내 1W 30분봉 · 시간외': chart(60, 0, { ext: [...Array(50).fill(null), 'after', 'pre', ...Array(8).fill(null)] }),
  '국내 1W 애프터 (NXT 밖 종목)': chart(60, 0, { ext: [...Array(50).fill(null), 'after', ...Array(9).fill(null)] }),
  '1D RSI 앞 거래일 5분봉': chart(300),
  '미국 1D 프리 · 애프터': chart(150, 1),
  '선물 · 미국채 1D': { nq: chart(200), tnx: chart(200) },
  '달러 인덱스 · 금 · 구리 일봉': { dxy: chart(22, 1), gold: chart(22, 1), copper: chart(22, 1) },
  '코스피200 현물 · 선물 차트': { spot: chart(60), fut: chart(70), spotDay: chart(1220, 1), futDay: chart(1220, 1), futMax: chart(360, 20) },
  '종목 지표 (국내)': { ok: true, today: { volume: 11822115 }, valuation: [{}, {}, {}, {}], trend: Array(20).fill({}),
    quarters: { cols: Array(5).fill({}) }, holders: { rows: [{ name: '삼성생명보험', pct: 8.5 }] }, consensus: { target: 495227 },
    traders: { date: '20261030', buy: Array(10).fill({ name: '한국증권', volume: 1718002, foreign: false }),
      sell: Array(10).fill({ name: 'BNK증권', volume: 1535498, foreign: false }), foreignBuy: 790499, foreignSell: 999036 } },
  '종목 지표 (미국 · ETF)': { us: { ok: true, valuation: [{}, {}, {}], quarters: { cols: Array(4).fill({}) } },
    etf: { ok: true, kind: 'etf', etf: { nav: 87025 } } },
  '일정 (실적 · 배당락)': { kr: { ok: true, events: [{ kind: 'ir', title: '실적 발표', date: '2026-10-30' }] }, us: { ok: true, events: [] } },
  '시장 순위': { search: { ok: true, items: items(20) }, up: { ok: true, items: items(20) }, us: { ok: true, items: items(20) },
    industry: { ok: true, groups: Array(20).fill({ no: 1 }) }, theme: { ok: true, groups: Array(20).fill({ no: 2 }) }, inside: { ok: true, items: items(3) } },
  '종목 검색': { kr: { ok: true, items: [{ symbol: '005930.KS' }] }, us: { ok: true, items: [{ symbol: 'NVDA' }] } },
  '업종': { kr: { ok: true, industry: '반도체와반도체장비' }, us: { ok: true, sector: 'Technology', industry: null } },
};
{
  const noSample = CHECKS.filter((c) => !(c.name in GOOD)).map((c) => c.name);
  check('점검마다 정상 표본이 있다', noSample.length === 0, noSample.join(', '));
  const falseAlarm = CHECKS.filter((c) => c.name in GOOD).map((c) => [c.name, c.verify(GOOD[c.name], [])]).filter(([, p]) => p.length);
  check('정상 모양은 통과한다(헛경보 없음)', falseAlarm.length === 0, falseAlarm.map(([n, p]) => `${n}: ${p.join(' / ')}`).join(' | '));
  const silent = CHECKS.filter((c) => !c.verify({ ok: false, error: '막힘' }, []).length).map((c) => c.name);
  check('실패 응답은 모두 FAIL', silent.length === 0, silent.join(', '));
  const by = (name) => CHECKS.find((c) => c.name === name);
  // 깨진 모양 — 하나씩
  const g = (name) => structuredClone(GOOD[name]);
  const kr = g('국내 실시간 시세'); delete kr.quotes['000660'];
  check('종목 하나가 빠지면 FAIL', by('국내 실시간 시세').verify(kr, []).some((p) => p.startsWith('000660')));
  const ix = g('지수 줄'); ix.items = ix.items.filter((i) => i.code !== 'US10Y');
  check('지수 하나가 빠지면 그 이름으로 FAIL', by('지수 줄').verify(ix, []).join() === 'US10Y: 값 · 등락률 없음');
  const ex = g('시장 지표'); ex.hyOas = ex.hyOas.map((d) => ({ ...d, date: '20260101' }));
  check('HY OAS 가 오래되면 FAIL', by('시장 지표').verify(ex, []).some((p) => p.includes('HY OAS 가 10일보다')));
  const fg = g('시장 지표'); fg.fearGreed = null;
  check('CNN 공포 · 탐욕이 없으면 FAIL', by('시장 지표').verify(fg, []).some((p) => p.includes('CNN 공포 · 탐욕 점수')));
  const ix2 = g('시장 지표'); ix2.intraday = null;
  check('장중 수급(다음 금융)이 없으면 FAIL', by('시장 지표').verify(ix2, []).some((p) => p.includes('장중 수급 현물')));
  const fh = g('외국인 수급 이력'); fh.spotFlows = fh.spotFlows.slice(-100);
  check('외국인 수급 이력이 3년치가 안 되면 FAIL', by('외국인 수급 이력').verify(fh, []).some((p) => p.includes('현물 수급 이력이 3년치')));
  const fo = g('외국인 수급 이력'); fo.futFlows = fo.futFlows.map((f) => ({ ...f, date: '20260101' }));
  check('외국인 수급 이력이 오래되면 FAIL', by('외국인 수급 이력').verify(fo, []).some((p) => p.includes('선물 수급 이력이 7일보다')));
  const d5 = g('일봉 5년'); d5.ix.volumes = d5.ix.volumes.map(() => 0);
  check('지수 거래량이 0 이면 FAIL(달걀이 빈다)', by('일봉 5년').verify(d5, []).some((p) => p.startsWith('^KS11: 거래량')));
  check('마지막 봉이 오래되면 FAIL', by('국내 1D 분봉').verify(chart(70, 10), []).some((p) => p.includes('오래됨')));
  check('종가에 빈 값이 섞이면 FAIL', by('국내 1D 분봉').verify({ ...chart(5), closes: [1, null, 1, 1, 1] }, []).some((p) => p.includes('숫자가 아닌')));
  check('네이버 대신 야후로 그렸으면 FAIL', by('국내 1D 분봉').verify(chart(70), [{ url: 'https://query1.finance.yahoo.com/v8/finance/chart/005930.KS', status: 200 }])
    .some((p) => p.includes('야후')));
  const w = g('국내 1W 30분봉 · 시간외'); w.ext = w.ext.map(() => null);
  check('1W 에 NXT 애프터 봉이 없으면 FAIL', by('국내 1W 30분봉 · 시간외').verify(w, []).some((p) => p.includes('애프터')));
  const dt = g('종목 지표 (국내)'); dt.holders = null;
  check('주주 구성(WiseReport)이 빠지면 FAIL', by('종목 지표 (국내)').verify(dt, []).join() === '주주 구성(WiseReport)이 없음');
  const rk = g('시장 순위'); rk.us.items[2].price = null;
  check('순위 종목 값이 비면 FAIL', by('시장 순위').verify(rk, []).some((p) => p.startsWith('us:')));
  const sr = g('종목 검색'); sr.us.items = [{ symbol: 'NVDA.O' }];
  check('검색 결과의 기호가 바뀌면 FAIL', by('종목 검색').verify(sr, []).some((p) => p.includes('NVDA')));
}

// --- 3. 실제로 돌리기 — 출처가 모두 막혀도 죽지 않고 항목마다 FAIL, 실패한 요청을 적는다 -------------------------------------
{
  const down = await runChecks(async () => { throw new Error('막힘'); });
  check('모든 항목을 돌린다', down.length === CHECKS.length);
  check('출처가 막히면 모든 항목이 FAIL', down.every((r) => r.problems.length > 0), down.filter((r) => !r.problems.length).map((r) => r.name).join(', '));
  check('예외로 죽지 않는다(처리기가 실패를 돌려준다)', down.every((r) => !r.problems.some((p) => p.startsWith('예외'))),
    down.flatMap((r) => r.problems.filter((p) => p.startsWith('예외')).map((p) => `${r.name}: ${p}`)).join(' | '));
  check('실패한 요청을 주소와 함께 적는다', down.every((r) => r.problems.some((p) => /^요청 실패 막힘 — https:\/\//.test(p))));
  check('주소의 쿼리는 적지 않는다', down.every((r) => r.problems.every((p) => !/^요청 실패.*\?/.test(p))));
  // 요청은 됐지만 HTTP 오류(503)면 결과가 대체 경로로 멀쩡해도 FAIL 이다 — 받은 것은 빈 JSON
  const busy = await runChecks(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }), CHECKS.slice(0, 1));
  check('HTTP 오류도 FAIL', busy[0].problems.some((p) => p.startsWith('요청 실패 HTTP 503')), busy[0].problems.join(' / '));
  // Electron 점검(sources-electron.mjs)은 net.fetch 자리에 진짜 net.fetch 를 따로 넘긴다 — FRED(HY OAS · 장단기 금리차) · CNN(시장
  // 지표)만 그쪽으로 가고, 그 실패도 적는다
  const viaNet = [];
  const market = CHECKS.filter((c) => c.name === '시장 지표');
  const split = await runChecks(async () => { throw new Error('막힘'); }, market,
    async (url) => { viaNet.push(String(url)); throw new Error('net 막힘'); });
  check('net.fetch 자리는 따로 넘긴 것을 쓴다 — FRED · CNN 만', viaNet.length === 3
    && viaNet.filter((u) => u.includes('fred.stlouisfed.org')).length === 2 && viaNet.some((u) => u.includes('dataviz.cnn.io')), viaNet.join(' '));
  check('net.fetch 쪽 실패도 적는다', split[0].problems.some((p) => p.startsWith('요청 실패 net 막힘 — https://fred.stlouisfed.org')),
    split[0].problems.join(' / '));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
