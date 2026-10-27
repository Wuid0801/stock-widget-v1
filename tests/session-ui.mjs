// Deterministic renderer session tests. No Electron, network, timers, or source patches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as indicators from '../indicators.js';
import * as backtest from '../backtest.js';

const source = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
// renderer.js 를 자르는 표식(주석 · 선언). 없거나 둘 이상이면 원인을 알 수 없는 전체 실패가 났다 — 주석 문구만 다듬어도
// prelude 가 파일 거의 전체가 되어 "document.addEventListener is not a function" 하나로 103개가 다 깨졌다. 바로 알린다.
const mark = (text) => {
  const i = source.indexOf(text);
  assert.ok(i >= 0, `renderer.js 표식 없음: ${text}`);
  assert.equal(source.indexOf(text, i + 1), -1, `renderer.js 표식이 둘 이상: ${text}`);
  return i;
};
const prelude = source.slice(0, mark('// 과열도 5단계'));
// 가격 포맷(fmt · money · curOf …). 화살표 함수라 realFunction 으로 못 꺼내 구획째 넣는다.
const formatting = source.slice(mark('// --- 포맷'), mark('// 색은 CSS 변수 한 곳에서만'));
function realFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `renderer function ${name} exists`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return source.slice(start, end + 2);
}

const NOW = Date.parse('2026-09-10T09:30:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
function harness(extra = []) {
  const elements = new Map();
  const timers = [];
  const notifications = [];
  const errors = [];
  const c = vm.createContext({
    Date: FixedDate,
    console: { error: (...args) => errors.push(args) },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '', textContent: '', title: '' });
      return elements.get(id);
    } },
    api: { notify: (n) => notifications.push(n) },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout: () => {},
  });
  // 계산 함수는 통째로 넣는다 — 이름을 하나씩 나열하면 새 함수를 부를 때마다
  // ReferenceError 가 나고 목록을 손으로 늘려야 한다.
  // daysAgo 만 기본 인자를 하네스 시각으로 묶는다. 주입된 함수는 vm 밖에서
  // 만들어져 Date.now() 가 FixedDate 가 아니라 진짜 지금을 읽는다.
  Object.assign(c, indicators, backtest, {
    daysAgo: (ms, now = NOW) => indicators.daysAgo(ms, now),
    // loadChart 는 다른 종목 · 기간으로 넘어갈 때 옛 차트를 지운다 — 차트가 없는 하네스에서는 할 일이 없다.
    // 진짜가 필요한 테스트는 extra 에 'clearChart' 를 넣는다(아래 선언이 이것을 덮는다).
    clearChart: () => {},
    renderMetrics: () => {},
    renderRank: () => {},
    loadEvents: async () => {}, // 갱신이 부르는 관심종목 일정 — 진짜는 extra 로
  });
  const names = ['quoteSession', 'tradingState', 'isDomestic', 'isUs', 'isOverseas', 'pollingIsOpen', 'priceSessionOf',
    'renderUpdated', 'intradayEnd', 'kstClockMs', 'infoTip', 'benchReturn', 'benchmarkOf', 'benchLine', 'alignByDay', 'tipBases', 'marketDay', 'chartTf', 'rankPct', 'rankCount', 'rankKey', 'rankBackHtml', ...extra];
  vm.runInContext(prelude + '\n' + [...new Set(names)].map(realFunction).join('\n'), c);
  const run = (code) => vm.runInContext(code, c);
  run(`state = { watchlist: [{symbol:'005930.KS', name:'삼성전자'},
    {symbol:'000660.KS', name:'SK하이닉스'}], selected:'005930.KS', timeframe:'1D',
    holdings:{}, maPeriods:[], alerts:{enabled:true, targets:{}} };`);
  return { c, run, elements, timers, notifications, errors };
}
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`OK ${name}`);
}

await test('five session labels; missing quotes stay unknown; legacy open/session fallback', () => {
  const { run } = harness();
  for (const [session, label] of Object.entries({regular:'정규장', pre:'프리마켓',
    after:'애프터마켓', closed:'장마감', unknown:'확인중'})) {
    assert.equal(run(`SESSION_TEXT[quoteSession({session:'${session}'})]`), label);
  }
  assert.equal(run('quoteSession(null)'), 'unknown');
  assert.equal(run('quoteSession({open:true})'), 'regular');
  assert.equal(run('quoteSession({open:false})'), 'closed');
  assert.equal(run("tradingState({session:'after',open:false})"), true);
  assert.equal(run("tradingState({session:'pre',open:false})"), true);
  assert.equal(run("tradingState({session:'regular',isTrading:null})"), null);
  assert.equal(run("tradingState({session:'regular',isTrading:false})"), false);
  assert.equal(run('tradingState({price:100})'), null);
});

await test('polling: any active/missing/unknown domestic stays fast; only all closed slows', () => {
  const { c } = harness();
  const symbols = ['005930.KS', '000660.KS'];
  const closed = { session:'closed', isTrading:false };
  assert.equal(c.pollingIsOpen(symbols, {'005930':closed,'000660':closed}), false);
  for (const q of [{session:'regular',isTrading:true}, {session:'pre',isTrading:true},
    {session:'after',isTrading:true}, {session:'unknown',isTrading:null}, {}, undefined]) {
    assert.equal(c.pollingIsOpen(symbols, {'005930':closed,'000660':q}), true);
  }
  assert.equal(c.pollingIsOpen(symbols, {'005930':{open:false},'000660':{open:false}}), false);
  assert.equal(c.pollingIsOpen(symbols, {'005930':closed,'000660':{session:'after',open:false}}), true);
  assert.equal(c.isDomestic('0095N0.KS'), true);
  assert.equal(c.isDomestic('ABC.kq'), true);
  assert.equal(c.isDomestic('005930'), true);
  assert.equal(c.isDomestic('TOOLONGSYMB.KS'), false);
  assert.equal(c.pollingIsOpen(['0095N0.KS'], {'0095N0':closed}), false);
  assert.equal(c.pollingIsOpen(['005930.KS','0095N0.KS'], {'005930':closed}), true);
  assert.equal(c.pollingIsOpen(['AAPL','BRK-B'], {}), true);
  assert.equal(c.pollingIsOpen([], {}), true);
});

await test('fetch failures/empty/partial results clear stale closure; partial symbol fetch keeps aggregate', async () => {
  const { c, run } = harness(['fetchLive']);
  const symbols = ['005930.KS','000660.KS'];
  c.api.realtimeQuotes = async () => ({ok:true,quotes:{'005930':{session:'closed'},'000660':{session:'closed'}}});
  await c.fetchLive(symbols);
  assert.equal(run('marketOpen'), false);
  for (const result of [{ok:false}, {ok:true,quotes:{}}, {ok:true,quotes:{'005930':{session:'closed'}}}]) {
    c.api.realtimeQuotes = async () => result;
    run('marketOpen = false; isLive = true;');
    await c.fetchLive(symbols);
    assert.equal(run('marketOpen'), true);
    if (!result.ok) assert.equal(run('isLive'), false);
  }
  c.api.realtimeQuotes = async () => { throw new Error('offline'); };
  run('marketOpen = false; isLive = true;');
  assert.equal(Object.keys(await c.fetchLive(symbols)).length, 0);
  assert.equal(run('marketOpen'), true);
  assert.equal(run('isLive'), false);
  run("quotes['000660.KS'] = {session:'after',isTrading:true};");
  c.api.realtimeQuotes = async () => ({ok:true,quotes:{'005930':{session:'closed',isTrading:false}}});
  await c.fetchLive(['005930.KS']);
  assert.equal(run('marketOpen'), true);
});

// 장 전(NXT 프리마켓 08:00~)과 개장 직후에는 야후 일봉의 마지막 봉이 아직 어제다(20분 지연 + 30분
// 캐시). 그 자리에 오늘 가격을 덮으면 어제 봉의 이동평균 끝점이 오늘 가격으로 틀어진다 — 차트의
// 어제 캔들은 실제 종가라 둘이 어긋났다. 오늘 봉을 덧붙이면 RSI 는 지금 가격을 따르고 어제 종가는 남는다.
await test('before Yahoo has today\'s bar, the live price is added as today instead of replacing yesterday', async () => {
  const { c, run } = harness(['loadQuote', 'maFor']);
  let clock;
  c.Date = class extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  };
  const at = (d) => Date.parse(`${d}T00:00:00Z`); // KRX 일봉 시각 = 09:00 KST
  const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']; // 월~목
  const closes = [100, 102, 104, 108];
  c.dailyFor = async () => ({ price: 108, closes, times: days.map(at), currency: 'KRW' });
  const live = (price, tradedAt) => ({ price, prevClose: 108, open: true, session: 'pre', priceSession: 'pre',
    isTrading: true, source: 'Naver', tradedAt });

  clock = Date.parse('2026-09-11T08:30:00+09:00'); // 금요일 프리마켓, 야후 마지막 봉은 목요일
  await c.loadQuote({ symbol: '005930.KS' }, live(112, '2026-09-11T08:29:00+09:00'));
  let d = run("quotes['005930.KS'].daily");
  assert.equal(JSON.stringify(d.closes), '[100,102,104,108,112]', 'Thursday keeps its close, Friday is added');
  assert.equal(d.times.at(-1), at('2026-09-11'), 'stamped as Friday 09:00 KST like a Yahoo daily bar');
  assert.equal(run(`maFor('005930.KS', [${at('2026-09-10')}], 2)[0]`), 106, "Thursday's MA2 is (104 + 108) / 2");
  assert.equal(closes.length, 4, 'the cached series is not touched');

  // 야후에 오늘 봉이 이미 있으면 지금처럼 그 봉을 지금 가격으로 맞춘다
  c.dailyFor = async () => ({ price: 110, closes: [...closes, 110], times: [...days, '2026-09-11'].map(at), currency: 'KRW' });
  clock = Date.parse('2026-09-11T10:00:00+09:00');
  await c.loadQuote({ symbol: '005930.KS' }, live(113, '2026-09-11T09:59:00+09:00'));
  d = run("quotes['005930.KS'].daily");
  assert.equal(JSON.stringify(d.closes), '[100,102,104,108,113]');

  // 휴장일(토요일)에는 실시간 값도 금요일 것이다 — 토요일 봉을 지어내지 않는다
  clock = Date.parse('2026-09-12T10:00:00+09:00');
  await c.loadQuote({ symbol: '005930.KS' }, live(113, '2026-09-11T20:00:00+09:00'));
  d = run("quotes['005930.KS'].daily");
  assert.equal(d.closes.length, 5, 'no Saturday bar');
});

await test('loadQuote carries metadata, zero close delta, timestamp, and delayed fallback', async () => {
  const { c, run } = harness(['loadQuote']);
  c.dailyFor = async () => ({price:99,closes:[90,100,99],times:[1,2,3],currency:'KRW'});
  const live = {price:102,prevClose:100,change:2,open:false,session:'closed',priceSession:'after',
    isTrading:false,regularClose:102,fromClose:0,market:'NXT',source:'Naver',tradedAt:'2026-09-10T09:29:00Z',
    closeTime:'1530'};
  await c.loadQuote({symbol:'005930.KS'}, live);
  const q = run("quotes['005930.KS']");
  for (const field of Object.keys(live)) assert.equal(q[field], live[field], field);
  assert.equal(q.fetchedAt, NOW);
  assert.equal(q.live, true);
  assert.equal(q.daily.closes.at(-1), 102);
  await c.loadQuote({symbol:'000660.KS'}, {price:105,prevClose:100,open:false,session:'after'});
  assert.equal(run("quotes['000660.KS'].isTrading"), true);
  assert.equal(run("quotes['000660.KS'].priceSession"), 'after');
  await c.loadQuote({symbol:'005930.KS'});
  const fallback = run("quotes['005930.KS']");
  assert.equal(fallback.session, 'unknown');
  assert.equal(fallback.isTrading, null);
  assert.equal(fallback.fromClose, null);
  assert.equal(fallback.regularClose, null);
  assert.equal(fallback.priceSession, 'unknown');
  assert.equal(fallback.market, null);
  assert.equal(fallback.source, 'Yahoo');
  assert.equal(fallback.tradedAt, null);
  assert.equal(fallback.live, false);
  c.dailyFor = async () => ({error:'offline'});
  await c.loadQuote({symbol:'005930.KS'}, live);
  assert.equal(run("quoteSession(quotes['005930.KS'])"), 'unknown');
});

await test('selected detail updates header, independent of aggregate; quote and fetch time differ', () => {
  const { c, run, elements } = harness(['renderDetail']);
  Object.assign(c, {
    curOf: () => 'KRW', money: (v) => v == null ? '—' : String(v),
    sectors: new Map([['005930.KS',''],['000660.KS','']]),
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({label:'—',color:'#000000'}), cssVar: () => '#000000',
  });
  run(`quotes['005930.KS'] = {price:102, live:true, session:'closed', priceSession:'after',
    market:'NXT', source:'Naver', tradedAt:'2026-09-10T09:29:00Z', fetchedAt:Date.now()};
    quotes['000660.KS'] = {price:103, live:true, session:'after', market:'NXT', source:'Naver',
    tradedAt:'2026-09-10T09:29:30Z', fetchedAt:Date.now()}; marketOpen = true;`);
  c.renderDetail();
  const header = elements.get('updated');
  assert.match(header.innerHTML, /장마감/);
  assert.match(header.title, /소스: 실시간 · Naver · NXT/);
  assert.match(header.title, /조회 완료: 2026-09-10T09:30:00.000Z/);
  assert.match(header.title, /시세 시각: 2026-09-10T09:29:00Z/);
  run("state.selected = '000660.KS';");
  c.renderDetail();
  assert.match(header.innerHTML, /애프터마켓/);
  assert.match(header.title, /시세 시각: 2026-09-10T09:29:30Z/);
  run("quotes['000660.KS'] = {price:100,live:false,session:'unknown',source:'Yahoo',fetchedAt:Date.now()};");
  c.renderDetail();
  assert.match(header.innerHTML, /20분지연/);
  assert.match(header.title, /20분지연 · Yahoo/);
  assert.match(header.title, /세션: 확인중/);
  assert.match(header.title, /시세 시각: 확인 불가/);
  run("quotes['000660.KS'].live = true;");
  c.renderUpdated();
  assert.match(header.innerHTML, /확인중/);
  run("state.selected = null;");
  c.renderUpdated();
  assert.match(header.innerHTML, /확인중/);
  assert.doesNotMatch(header.title, /NXT|실시간|20분지연/);
  // 접혀 있으면 갱신 때마다 손잡이 툴팁(세 줄 미리보기)도 새로 쓴다
  run("state.selected = '000660.KS'; state.infoOpen = false;");
  c.renderDetail();
  assert.equal(elements.get('infoToggle').title, '누르면 펼칩니다');
});

await test('1D appends only active regular; pre/after lines retain price origin after close', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = {ok:true,closes:[98,100],times:[1,2],volumes:[10,20],highs:[99,101],lows:[97,99]};
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  for (const [session, priceSession, open, size, label] of [
    ['regular','regular',true,3,null], ['regular','regular',false,2,null],
    ['pre','pre',false,2,'프리'], ['after','after',false,2,'애프터'],
    ['after','after',true,2,'애프터'], ['closed','after',false,2,'애프터'],
    ['closed','regular',false,2,null], ['unknown','unknown',false,2,null],
  ]) {
    run(`lastDrawSig = null; quotes['005930.KS'] = {price:102,prevClose:95,change:7,live:true,
      open:${open},session:'${session}',priceSession:'${priceSession}'};`);
    await c.loadChart();
    const chart = draws.at(-1);
    assert.equal(chart.closes.length, size, session);
    assert.equal(chart.times.length, size);
    assert.equal(chart.highs.length, size);
    assert.equal(chart.volumes.length, size);
    const line = chart.hLines.find((l) => l.varName === '--over-line');
    assert.equal(line?.label || null, label, session);
    if (line) assert.equal(line.value, 102);
  }
  assert.deepEqual(bars.closes, [98,100], 'original regular bars remain unchanged');
  run("lastDrawSig = null; quotes['005930.KS'] = {price:102,live:true,open:false,session:'pre'};");
  await c.loadChart();
  assert.equal(draws.at(-1).hLines[0].label, '프리', 'legacy fallback without prevClose');
  const before = draws.length;
  run("quotes['005930.KS'].session = 'after';");
  await c.loadChart();
  assert.equal(draws.length, before + 1, 'same price but changed label redraws');
  assert.equal(draws.at(-1).hLines[0].label, '애프터');
  run("state.timeframe = '1M'; lastDrawSig = null;");
  await c.loadChart();
  assert.equal(draws.at(-1).closes.length, 2);
  assert.equal(draws.at(-1).hLines.length, 0);
});

// 국내 1D 정규장을 네이버 실시간 분봉으로 받으면(main.js 가 realtime 을 단다) 봉이 이미 지금까지 있다 — 현재가 ·
// 종가를 끝에 덧붙이지 않는다. 덧붙이면 마지막 봉 뒤에 같은 순간의 점이 하나 더 생긴다. 야후로 그렸을 때는 그대로 붙인다.
// 다만 받은 지 차트 캐시만큼 지나 끝이 헤더와 달랐다(2026-10-27 SK하이닉스 1,368,000 vs 1,365,000) — 장중이면 오늘
// 마지막 봉을 현재가로 맞춘다(점은 더하지 않는다).
await test('1D from Naver real-time bars: no end point is added; while trading the last bar follows the header price', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = { ok: true, realtime: true, closes: [98, 100], times: [NOW - 600000, NOW - 300000], volumes: [10, 20],
    highs: [99, 101], lows: [97, 99] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  const quote = (session, open) => run(`lastDrawSig = null; quotes['005930.KS'] = {price:102,prevClose:95,change:7,live:true,
    open:${open},session:'${session}',priceSession:'${session}',tradedAt:new Date().toISOString(),closeTime:'1530'};`);
  quote('regular', true);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 102], '장중: 마지막 봉 = 헤더 현재가, 봉 수는 그대로');
  assert.deepEqual([draws.at(-1).highs[1], draws.at(-1).lows[1]], [102, 99], '고가를 넓힌다');
  quote('closed', false);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100], '장 마감 뒤: 받은 봉 그대로(15:30 봉이 공식 종가)');
  bars.times = [NOW - 2 * 86400000, NOW - 2 * 86400000 + 300000]; // 장 전 · 휴장 — 지난 날 봉
  quote('regular', true);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100], '지난 날 봉은 건드리지 않는다');
  bars.times = [NOW - 600000, NOW - 300000];
  delete bars.realtime; // 야후로 그린 차트 — 장중 현재가를 덧붙인다
  run("lastDrawSig = null; quotes['005930.KS'] = {price:102,prevClose:95,change:7,live:true,open:true,session:'regular',priceSession:'regular'};");
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100, 102]);
});

// 15:30 에 정규장이 끝나면 KRX 는 휴지(OPEN + break)이고 가격은 NXT 애프터마켓에서 온다(세션 애프터마켓).
// 야후는 종가를 거래량 0 인 마지막 봉으로 싣는데 20분 늦어 15:50쯤 온다(2026-10-13 실측: regularMarketTime
// 15:30:12). 예전에는 그사이 1D 차트가 20분 전 봉에서 멈췄다 — 확인된 종가로 끝낸다.
await test('1D ends at the verified close until Yahoo\'s close bar arrives; never at an after price', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = { ok: true, closes: [98, 100], times: [1, 2], volumes: [10, 20], highs: [99, 101], lows: [97, 99] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  // 하네스 시각은 2026-09-10 18:30 KST. 15:56 은 tests/fixtures/naver-break-20260915.json 과 같은 상태다.
  const quote = (patch = {}) => run(`lastDrawSig = null; quotes['005930.KS'] = ${JSON.stringify({ price: 102, prevClose: 95,
    change: 7, live: true, open: false, session: 'after', priceSession: 'after', isTrading: true,
    tradedAt: '2026-09-10T15:56:03+09:00', regularClose: 101, closeTime: '1530', ...patch })};`);
  const draw = async (patch) => { quote(patch); await c.loadChart(); return draws.at(-1); };

  let d = await draw();
  assert.deepEqual(d.closes, [98, 100, 101], '종가로 끝난다 (애프터 가격 102 가 아니다)');
  assert.equal(d.times.at(-1), Date.parse('2026-09-10T15:30:00+09:00'), '이름표는 거래소가 알려 준 종료 시각');
  assert.equal(d.volumes.length, 3);
  assert.equal(d.hLines.find((l) => l.varName === '--over-line')?.value, 102, '애프터 가격은 점선 그대로');
  d = await draw({ closeTime: null });
  assert.equal(d.times.at(-1), NOW, '종료 시각을 모르면 지금');

  // 야후 종가 봉(거래량 0)이 들어오면 점을 더하지 않고 그 봉을 거래소 종가로 맞춘다 — 틱 차이로 끝이 둘이 되지 않게
  Object.assign(bars, { closes: [98, 100, 100.5], times: [1, 2, 3], volumes: [10, 20, 0], highs: [99, 101, 100.5],
    lows: [97, 99, 100.5] });
  d = await draw();
  assert.deepEqual(d.closes, [98, 100, 101]);
  assert.deepEqual(d.times, [1, 2, 3]);
  assert.deepEqual(bars.closes, [98, 100, 100.5], '받은 봉은 그대로');
  // ETF 는 애프터마켓이 없어 15:30 뒤 장마감이다 — 가격이 정규장 것이어도 확인된 종가가 있으면 같은 규칙
  d = await draw({ price: 101, session: 'closed', priceSession: 'regular', isTrading: false });
  assert.deepEqual(d.closes, [98, 100, 101], 'ETF: 종가 봉이 한 번만');

  Object.assign(bars, { closes: [98, 100], times: [1, 2], volumes: [10, 20], highs: [99, 101], lows: [97, 99] });
  // 단일가 · 일시정지처럼 정규장 가격이 멈춰 있고 아직 종가가 없으면 그 가격으로 끝낸다
  d = await draw({ price: 99, session: 'closed', priceSession: 'regular', isTrading: false, regularClose: null,
    tradedAt: '2026-09-10T15:25:00+09:00' });
  assert.deepEqual(d.closes, [98, 100, 99]);
  assert.equal(d.times.at(-1), NOW);
  // 지수에는 애프터마켓이 없다 — 마감 뒤 값이 곧 종가다
  d = await draw({ price: 103, session: 'closed', priceSession: 'closed', isTrading: false, regularClose: null,
    closeTime: null, tradedAt: '2026-09-10T15:30:05+09:00' });
  assert.deepEqual(d.closes, [98, 100, 103]);

  // 종가를 모르는 애프터 · 프리 가격, 어제 가격(장 전 · 휴일), 지연 시세는 붙이지 않는다
  for (const patch of [{ regularClose: null }, { session: 'pre', priceSession: 'pre', regularClose: null },
    { tradedAt: '2026-09-09T15:56:03+09:00' }, { session: 'closed', priceSession: 'closed', tradedAt: '2026-09-09T15:30:05+09:00' },
    { live: false }, { tradedAt: null }]) {
    assert.deepEqual((await draw(patch)).closes, [98, 100], JSON.stringify(patch));
  }
});

// 미국 종목은 네이버 해외 시세가 현재가 · 등락 · 세션을 준다(2026-10-14 실측 SOXL 프리마켓 17:03 KST:
// 정규장 종가 127.57 에서 126.20). 야후 미국 시세는 늦지 않지만 정규장 가격뿐이라 프리 · 애프터가 안 보였다.
await test('US live quote: price from Naver; Yahoo daily untouched and cached briefly', async () => {
  const { c, run } = harness(['loadQuote']);
  const ttls = [];
  c.dailyFor = async (_s, ttl) => { ttls.push(ttl); return { price: 127.57, closes: [128.4, 127.57], times: [1, 2], currency: 'USD' }; };
  const live = { price: 126.2, prevClose: 127.57, change: -1.37, open: false, session: 'pre', priceSession: 'pre',
    isTrading: true, regularClose: 127.57, fromClose: null, market: 'AMEX', source: 'naver-us-over',
    tradedAt: '2026-10-14T04:03:01-04:00' };
  await c.loadQuote({ symbol: 'SOXL' }, live);
  const q = run("quotes['SOXL']");
  assert.equal(q.price, 126.2);
  assert.equal(q.prevClose, 127.57);
  assert.equal(q.session, 'pre');
  assert.equal(q.live, true);
  // 프리 · 애프터 가격을 정규장 봉에 넣지 않는다. 한국 날짜로 오늘 봉을 덧붙이지도 않는다.
  assert.equal(JSON.stringify(q.daily.closes), '[128.4,127.57]');
  assert.equal(ttls.at(-1), 60000, 'Yahoo US daily is not delayed, so it keeps the RSI current');
  await c.loadQuote({ symbol: '005930.KS' }, { ...live, price: 250000, prevClose: 249000, tradedAt: '2026-09-10T18:29:00+09:00' });
  assert.equal(ttls.at(-1), run('DAILY_TTL'), 'domestic live keeps the long cache');
  // 미국 지수 · 환율(지수 줄)도 일봉을 건드리지 않는다. 캐시는 길게 — 세 개를 1분마다 5년치씩 받지 않는다.
  await c.loadQuote({ symbol: '^IXIC', name: '나스닥' }, { ...live, price: 130, session: 'regular', priceSession: 'regular' });
  assert.equal(JSON.stringify(run("quotes['^IXIC'].daily.closes")), '[128.4,127.57]', '지수 줄의 미국 지수도 한국 날짜로 봉을 덧붙이지 않는다');
  assert.equal(ttls.at(-1), run('DAILY_TTL'));
});

await test('US header: never 20분지연 — the Naver session when live, 확인중 on Yahoo\'s regular price', () => {
  const { run, elements } = harness();
  const header = () => elements.get('updated');
  run(`state.selected = 'SOXL'; quotes['SOXL'] = {price:126.2, live:true, session:'pre', source:'naver-us-over',
    market:'AMEX', fetchedAt:Date.now()};`);
  run('renderUpdated()');
  assert.match(header().innerHTML, /프리마켓/);
  assert.match(header().title, /소스: 실시간 · naver-us-over · AMEX/);
  run("quotes['SOXL'] = {price:127.57, live:false, session:'unknown', source:'Yahoo', fetchedAt:Date.now()};");
  run('renderUpdated()');
  assert.doesNotMatch(header().innerHTML, /20분지연/);
  assert.match(header().innerHTML, /확인중/);
  assert.match(header().title, /소스: 정규장 가격 · Yahoo/);
  run("quotes['SOXL'].stale = true;");
  run('renderUpdated()');
  assert.match(header().innerHTML, /갱신 실패/);
  assert.match(header().title, /마지막으로 받은 값/);
  // 국내 종목 · 지수의 야후 값은 그대로 20분지연이다
  for (const s of ['005930.KS', '^KS11']) {
    run(`state.selected = '${s}'; quotes['${s}'] = {price:100, live:false, session:'unknown', source:'Yahoo', fetchedAt:Date.now()};`);
    run('renderUpdated()');
    assert.match(header().innerHTML, /20분지연/, s);
  }
  // 미국 지수 · 환율(지수 줄)의 야후 값은 늦지 않다
  for (const s of ['^GSPC', 'KRW=X']) {
    run(`state.selected = '${s}'; quotes['${s}'] = {price:100, live:false, session:'unknown', source:'Yahoo', fetchedAt:Date.now()};`);
    run('renderUpdated()');
    assert.doesNotMatch(header().innerHTML, /20분지연/, s);
  }
});

// 선물 · 유가는 거래소가 10분 늦게 준다(네이버 · 야후 같다) — 거래 중에는 정규장 · 실시간이 아니라 10분지연. 금리는 실시간이다.
await test('futures and oil say 10분지연 while trading and 장마감 when closed; the 10-year yield stays real-time', () => {
  const { run, elements } = harness();
  const header = () => elements.get('updated');
  for (const s of ['NQ=F', 'CL=F']) {
    run(`state.selected = '${s}'; quotes['${s}'] = {price:100, live:true, session:'regular', source:'Naver', fetchedAt:Date.now()};`);
    run('renderUpdated()');
    assert.match(header().innerHTML, /^<span class="delay">10분지연<\/span>/, s);
    assert.match(header().title, /소스: 10분 지연 · Naver/, s);
    run(`quotes['${s}'].session = 'closed';`);
    run('renderUpdated()');
    assert.match(header().innerHTML, /^<span class="closed">장마감<\/span>/, s);
  }
  run("state.selected = '^TNX'; quotes['^TNX'] = {price:4.97, live:true, session:'regular', source:'Naver', fetchedAt:Date.now()};");
  run('renderUpdated()');
  assert.match(header().innerHTML, /^<span class="live">정규장<\/span>/);
  assert.match(header().title, /소스: 실시간 · Naver/);
});

// 선물(=F)의 하루는 CME 하루(18:00 ET ~ 다음 날 17:00 ET)이고 야후 일봉 시각은 끝 날 00:00 ET — 서머타임이든 아니든
// 그 하루가 일봉과 같은 날짜로 떨어져야 1W 툴팁 등락률 · 전일 고저가 앞 거래일을 본다.
await test('marketDay: a CME futures session (18:00 ET to 17:00 ET) is the day its Yahoo daily bar is stamped, summer or winter', () => {
  const { c } = harness();
  const day = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86400000);
  for (const [at, want] of [
    ['2026-10-22T22:00:00Z', '2026-10-23'], // 10/22 18:00 EDT — 10/23 하루의 첫 봉
    ['2026-10-23T04:00:00Z', '2026-10-23'], // 10/23 00:00 EDT — 10/23 일봉의 시각
    ['2026-10-23T20:55:00Z', '2026-10-23'], // 10/23 16:55 EDT — 마지막 봉
    ['2026-12-01T23:00:00Z', '2026-12-02'], // 12/01 18:00 EST
    ['2026-12-02T05:00:00Z', '2026-12-02'], // 12/02 00:00 EST — 일봉
    ['2026-12-02T21:55:00Z', '2026-12-02'], // 12/02 16:55 EST
  ]) {
    for (const s of ['NQ=F', 'CL=F']) assert.equal(c.marketDay(Date.parse(at), s), day(want), `${s} ${at}`);
  }
  // 미국채 10년(^TNX)은 미국 지수처럼 -5시간 — 08:20 ET 일봉도 그날
  assert.equal(c.marketDay(Date.parse('2026-10-22T12:20:00Z'), '^TNX'), day('2026-10-22'));
});

await test('polling: a US stock counts by its own Naver session, not the Korean market', () => {
  const { c } = harness();
  const closed = { session: 'closed', isTrading: false };
  const pre = { session: 'pre', isTrading: true };
  assert.equal(c.pollingIsOpen(['SOXL', 'AAPL'], { SOXL: closed, AAPL: closed }), false);
  assert.equal(c.pollingIsOpen(['005930.KS', 'SOXL'], { '005930': closed, SOXL: pre }), true, 'US pre-market while KRX is closed');
  assert.equal(c.pollingIsOpen(['005930.KS', 'BRK-B'], { '005930': closed }), true, 'a US stock Naver does not have stays fast');
  assert.equal(c.isUs('SOXL'), true);
  assert.equal(c.isUs('BRK-B'), true);
  assert.equal(c.isUs('005930.KS'), false);
  assert.equal(c.isUs('^KS11'), false);
});

// 야후 미국 분봉은 늦지 않아 1D 끝을 맞출 것이 없다. intradayEnd 의 날짜 · 종료 시각은 한국 기준이기도 하다.
await test('1D US chart: no end point from the live quote; the over-market line still shows', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = { ok: true, closes: [128, 127.57], times: [1, 2], volumes: [10, 20], highs: [129, 128], lows: [127, 127] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'USD',
    drawChart: (data) => draws.push(data),
  });
  run("let lastDrawSig = null; state.watchlist.push({symbol:'SOXL', name:'SOXL'}); state.selected = 'SOXL';");
  for (const patch of [{ session: 'regular', priceSession: 'regular', open: true, isTrading: true },
    { session: 'after', priceSession: 'after', isTrading: true, regularClose: 127.6 }]) {
    run(`lastDrawSig = null; quotes['SOXL'] = ${JSON.stringify({ price: 127.78, prevClose: 128.4, change: -0.62,
      live: true, open: false, tradedAt: '2026-09-10T18:29:00+09:00', ...patch })};`);
    await c.loadChart();
    assert.deepEqual(draws.at(-1).closes, [128, 127.57], patch.session);
  }
  assert.equal(draws.at(-1).hLines.find((l) => l.varName === '--over-line')?.label, '애프터');
  // 지수 줄의 미국 지수도 같다 — 열려 있어도 끝점을 덧붙이지 않는다
  run(`lastDrawSig = null; state.selected = '^IXIC'; quotes['^IXIC'] = { price: 130, prevClose: 128, change: 2, live: true,
    open: true, session: 'regular', priceSession: 'regular', isTrading: true };`);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [128, 127.57], '^IXIC');
});

// 1D 에 시간외 봉이 붙으면(main.js: 국내 NXT 프리 · 애프터, 미국 야후) 정규장 끝점(확인된 종가 · 현재가)은
// 마지막 칸이 아니라 정규장 마지막 봉 자리에 맞춰야 한다. 끝에 붙이면 선이 애프터에서 종가로 되돌아간다.
await test('1D with extended bars: the regular end point sits before the after bars, arrays stay aligned', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const T = (s) => Date.parse(`2026-09-10T${s}:00+09:00`);
  const hm = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(11, 16);
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  const quote = (patch = {}) => run(`quotes['005930.KS'] = ${JSON.stringify({ price: 103, prevClose: 95, change: 8,
    live: true, open: false, session: 'after', priceSession: 'after', isTrading: true,
    tradedAt: '2026-09-10T16:05:00+09:00', regularClose: 101, closeTime: '1530', ...patch })};`);
  const series = (closes, at, ext, volumes) => ({ ok: true, closes, times: at.map(T), volumes, ext,
    opens: closes.slice(), highs: closes.map((v) => v + 1), lows: closes.map((v) => v - 1) });
  const draw = async (patch) => { run('lastDrawSig = null;'); quote(patch); await c.loadChart(); return draws.at(-1); };

  bars = series([99, 98, 100, 102, 103], ['08:00', '09:00', '15:00', '15:40', '15:45'],
    ['pre', null, null, 'after', 'after'], [5, 10, 20, 7, 3]);
  let d = await draw();
  assert.deepEqual(d.closes, [99, 98, 100, 101, 102, 103], '확인된 종가가 15:30 자리에');
  assert.deepEqual(d.times.map(hm), ['08:00', '09:00', '15:00', '15:30', '15:40', '15:45']);
  assert.deepEqual(d.ext, ['pre', null, null, null, 'after', 'after'], '끼운 끝점은 정규장');
  assert.deepEqual(d.volumes, [5, 10, 20, 0, 7, 3]);
  assert.deepEqual([d.opens[3], d.highs[3], d.lows[3]], [101, 101, 101]);
  assert.deepEqual([d.highs[4], d.lows[4]], [103, 101], '뒤의 애프터 봉은 제 값 그대로');
  assert.deepEqual(bars.closes, [99, 98, 100, 102, 103], '받은 봉은 그대로');

  // 종가가 바뀌면(마지막 칸은 그대로여도) 다시 그린다
  const before = draws.length;
  quote({ regularClose: 101.5 });
  await c.loadChart();
  assert.equal(draws.length, before + 1, 'redraws when only the middle end point changes');

  // 야후 종가 봉(거래량 0)이 들어오면 그 봉을 맞춘다 — 마지막 애프터 봉이 아니라
  bars = series([99, 98, 100, 100.5, 102, 103], ['08:00', '09:00', '15:00', '15:30', '15:40', '15:45'],
    ['pre', null, null, null, 'after', 'after'], [5, 10, 20, 0, 7, 3]);
  d = await draw();
  assert.deepEqual(d.closes, [99, 98, 100, 101, 102, 103]);

  // 종료 시각을 몰라 "지금" 으로 가는 끝점은 애프터 봉 뒤에 붙이지 않는다
  bars = series([99, 98, 100, 102, 103], ['08:00', '09:00', '15:00', '15:40', '15:45'],
    ['pre', null, null, 'after', 'after'], [5, 10, 20, 7, 3]);
  d = await draw({ closeTime: null });
  assert.deepEqual(d.closes, [99, 98, 100, 102, 103]);

  // 장 시작 직후 야후가 비어 프리 봉만 있으면 현재가는 그 뒤에 붙는다
  bars = series([99, 98.5], ['08:00', '08:45'], ['pre', 'pre'], [5, 4]);
  d = await draw({ session: 'regular', priceSession: 'regular', open: true, price: 104, regularClose: null });
  assert.deepEqual(d.closes, [99, 98.5, 104]);
  assert.deepEqual(d.ext, ['pre', 'pre', null]);
});

// 보조 지표(설정의 칩): 볼린저 밴드 · VWAP · 거래량 평균 · 전일 고저. 기본은 모두 꺼짐.
await test('indicators: saved value is cleaned; chips toggle, save and redraw', () => {
  const { c, run, elements } = harness(['renderIndChips']);
  assert.equal(JSON.stringify(run("cleanIndicators({ bb: true, vwap: 'yes', bogus: true })")),
    '{"bb":true,"vwap":false,"volAvg":false,"prevHL":false,"vp":false,"rel":false,"sar":false}', '아는 키만, true 일 때만');
  assert.equal(JSON.stringify(run('cleanIndicators(undefined)')),
    '{"bb":false,"vwap":false,"volAvg":false,"prevHL":false,"vp":false,"rel":false,"sar":false}');
  const kids = [];
  let saves = 0;
  let loads = 0;
  c.document.createElement = () => ({ style: {} });
  c.document.getElementById('indChips').appendChild = (b) => kids.push(b);
  Object.assign(c, { save: () => { saves++; }, loadChart: () => { loads++; }, cssVar: (n) => n });
  run("state.indicators = cleanIndicators({ bb: true });");
  run('renderIndChips()');
  const shown = () => kids.slice(-7);
  assert.deepEqual(shown().map((b) => b.textContent), ['볼린저', 'VWAP', '거래량 평균', '전일 고저', '매물대', '지수 대비', 'SAR']);
  assert.equal(shown()[0].className, 'on');
  assert.equal(shown()[0].style.color, '--bb-line', '켜진 칩은 그 선의 색');
  assert.equal(shown()[1].className, undefined);
  shown()[1].onclick();
  assert.equal(run('state.indicators.vwap'), true);
  assert.equal(run('state.indicators.bb'), true, '다른 칩은 그대로');
  assert.equal(saves, 1);
  assert.equal(loads, 1);
  assert.equal(shown()[1].className, 'on', '칩을 다시 그린다');
  assert.ok(elements.get('indChips'));
});

await test('indicators: loadChart passes only the enabled overlays — bands and volume average on daily, VWAP and previous high/low on 1D', async () => {
  const { c, run } = harness(['loadChart', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const draws = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  const day = 86400000;
  // 국내 일봉 시각 = 09:00 KST. 마지막 일봉이 아래 1D 의 날(9/10)이라, 볼린저를 1D 에 잘못 그리면 값이 잡힌다.
  const t0 = Date.parse('2026-07-28T00:00:00Z');
  const N = 45; // 차트 첫 봉(끝에서 22번째) 앞에 20봉이 넘게 있다
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const C = Array.from({ length: N }, (_, i) => 100 + (i % 5));
  const V = Array.from({ length: N }, (_, i) => (i === N - 1 ? 5000 : 1000));
  run(`quotes['005930.KS'] = { price: ${C[N - 1]}, prevClose: 100, change: 4, live: true,
    daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} },
    dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} },
    recentBars: { times: [${Date.parse('2026-09-09T00:00:00Z')}, ${Date.parse('2026-09-10T00:00:00Z')}], highs: [110, 120], lows: [90, 95] } };`);
  const daily = { ok: true, closes: C.slice(-22), times: T.slice(-22), volumes: V.slice(-22),
    opens: C.slice(-22), highs: C.slice(-22), lows: C.slice(-22) };
  const draw = async (tf, ind, b) => {
    bars = b;
    run(`state.timeframe = '${tf}'; state.indicators = cleanIndicators(${JSON.stringify(ind)});`);
    await c.loadChart();
    return draws.at(-1);
  };

  let d = await draw('1M', {}, daily);
  assert.equal(d.bands, null);
  assert.equal(d.vwapLine, null);
  assert.equal(d.volAvg, null, '꺼 두면 아무것도 넘기지 않는다');

  const before = draws.length;
  d = await draw('1M', { bb: true, volAvg: true, vp: true }, daily);
  assert.equal(draws.length, before + 1, '칩만 바꿔도 다시 그린다');
  assert.equal(d.profile, true, '매물대는 일봉 기간에 그린다(구간은 drawChart 가 정한다)');
  const full = c.bollinger(C, 20, 2);
  assert.equal(d.bands.upper.length, 22);
  assert.equal(d.bands.upper[21], full.upper[N - 1], '5년치 일봉으로 계산해 차트 날짜에 맞춘다');
  assert.equal(d.bands.lower[0], full.lower[N - 22], '1M 첫 봉부터 그려진다');
  assert.equal(d.volAvg[21], (19 * 1000 + 5000) / 20, '일봉 거래량 20일 평균');
  assert.equal(d.volAvg[0], 1000);
  assert.equal(d.vwapLine, null, 'VWAP 는 1D 만');

  // 1D: 프리 · 정규장 · 애프터 봉. VWAP 와 거래량 평균은 정규장 봉만, 전일 고저는 어제 일봉에서
  const T1 = (s) => Date.parse(`2026-09-10T${s}:00+09:00`);
  const oneDay = { ok: true, closes: [99, 100, 102, 101, 103], times: ['08:00', '09:00', '09:05', '15:00', '15:40'].map(T1),
    volumes: [10, 100, 300, 0, 50], opens: [99, 100, 102, 101, 103], highs: [99, 101, 103, 101, 103], lows: [99, 99, 101, 101, 103],
    ext: ['pre', null, null, null, 'after'] };
  d = await draw('1D', { bb: true, vwap: true, prevHL: true, vp: true }, oneDay);
  assert.equal(d.bands, null, '볼린저는 일봉 기간만');
  assert.equal(d.profile, false, '매물대도 일봉 기간만');
  const tp1 = (101 + 99 + 100) / 3;
  const tp2 = (103 + 101 + 102) / 3;
  assert.equal(d.vwapLine[0], null, '프리 봉은 빼고 그 칸은 비운다');
  assert.equal(d.vwapLine[1], tp1);
  assert.equal(d.vwapLine[2], (tp1 * 100 + tp2 * 300) / 400);
  assert.equal(d.vwapLine[3], d.vwapLine[2], '거래량 0 인 봉은 직전 값');
  assert.equal(d.vwapLine[4], null, '애프터 봉도 비운다');
  const hl = d.hLines.filter((l) => l.label === '전고' || l.label === '전저');
  assert.equal(JSON.stringify(hl.map((l) => [l.label, l.value])), '[["전고",110],["전저",90]]', '오늘(9/10) 앞의 9/9 일봉');
  assert.equal(JSON.stringify(hl.map((l) => l.varName)), '["--prevhi-line","--prevlo-line"]', '전고 옅은 빨강 · 전저 옅은 파랑');

  d = await draw('1D', { vwap: false, prevHL: false }, oneDay);
  assert.equal(d.vwapLine, null);
  assert.equal(d.hLines.some((l) => l.label === '전고'), false);
});

await test('indicators: volume average leaves out extended and zero-volume bars; previous day uses the market\'s own date', () => {
  const { c, run } = harness(['seriesVolAvg', 'prevDayRange']);
  const vols = Array.from({ length: 25 }, (_, i) => (i < 2 ? 5 : 100));
  const ext = vols.map((_, i) => (i < 2 ? 'pre' : null));
  vols[10] = 0; // 끼운 끝점처럼 거래량 0
  const avg = c.seriesVolAvg(vols, ext);
  assert.equal(avg[0], null, '시간외 봉은 평균에 넣지도, 칸을 채우지도 않는다');
  assert.equal(avg[10], null, '거래량 0 인 봉도');
  // 쓰는 봉: 2~9, 11~ → 20번째는 22번 칸
  assert.equal(avg[22], 100, '정규장 봉 20개가 모인 첫 칸');
  assert.equal(avg[21], null, '아직 19개');

  // 국내 1D 프리 봉(08:30 KST)은 UTC 로 전날이다 — 한국 날짜로 세야 어제(10/14) 일봉을 고른다
  run(`quotes['005930.KS'] = { recentBars: { times: [${Date.parse('2026-10-13T00:00:00Z')}, ${Date.parse('2026-10-14T00:00:00Z')}],
    highs: [200, 210], lows: [190, 195] } };`);
  assert.deepEqual({ ...c.prevDayRange('005930.KS', [Date.parse('2026-10-15T08:30:00+09:00')]) }, { high: 210, low: 195 });
  // 미국 1D 애프터 봉(08:55 KST = 뉴욕 10/14 19:55)은 UTC 날짜가 뉴욕 날짜다 — 10/14 일봉은 그날이라 빼고 10/13
  run(`quotes.SOXL = { recentBars: { times: [${Date.parse('2026-10-13T13:30:00Z')}, ${Date.parse('2026-10-14T13:30:00Z')}],
    highs: [128, 130], lows: [115, 110] } };`);
  assert.deepEqual({ ...c.prevDayRange('SOXL', [Date.parse('2026-10-15T08:55:00+09:00')]) }, { high: 128, low: 115 });
  // 서머타임이 끝나면(11/1~) 뉴욕 19:00~20:00 이 UTC 로 다음 날이다 — 11/17 19:55 EST 봉에서 11/17 일봉(그날)을 고르면 안 된다
  run(`quotes.SOXL = { recentBars: { times: [${Date.parse('2026-11-16T14:30:00Z')}, ${Date.parse('2026-11-17T14:30:00Z')}],
    highs: [128, 130], lows: [115, 110] } };`);
  assert.deepEqual({ ...c.prevDayRange('SOXL', [Date.parse('2026-11-18T00:55:00Z')]) }, { high: 128, low: 115 }, '겨울(EST) 애프터 끝');
  assert.equal(c.prevDayRange('000660.KS', [1]), null, '일봉이 없으면 그리지 않는다');
});

await test('indicators: drawChart draws the band as a filled pair, VWAP on the price axis, the average on the volume axis', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  run(`state.timeframe = '1D';
    var C_ = [100, 101, 102, 103];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [10, 10, 50, 10], highs: C_, lows: C_,
      bands: { upper: [110, 111, 112, 113], lower: [90, 91, 92, 93] }, vwapLine: [100, 100.5, 101, 101.5],
      volAvg: [null, 10, 20, 15] };`);
  run('drawChart(arg_);');
  const sets = configs.at(-1).data.datasets;
  const up = sets.findIndex((d) => d.borderColor === '--bb-line' && d.fill === '+1');
  assert.ok(up >= 0, '위쪽 경계가 아래쪽까지 채운다');
  assert.equal(sets[up + 1].borderColor, '--bb-line', '아래쪽 경계가 바로 다음 데이터셋이다(fill +1)');
  assert.equal(JSON.stringify(sets[up + 1].data), '[90,91,92,93]');
  const vw = sets.find((d) => d.borderColor === '--vwap-line');
  assert.equal(vw.yAxisID, 'y');
  const avg = sets.find((d) => d.borderColor === '--vol-avg');
  assert.equal(avg.yAxisID, 'yVol', '거래량 평균은 거래량 축');
  const vol = sets.find((d) => d.isVolume);
  assert.equal(JSON.stringify(vol.backgroundColor), '["a0.2","a0.2","a0.55","a0.2"]', '평균의 2배 넘는 막대만 진하게');

  run('arg_.bands = null; arg_.vwapLine = null; arg_.volAvg = null; drawChart(arg_);');
  const off = configs.at(-1).data.datasets;
  assert.equal(off.some((d) => ['--bb-line', '--vwap-line', '--vol-avg'].includes(d.borderColor)), false);
  assert.equal(off.find((d) => d.isVolume).backgroundColor, 'a0.2', '끄면 막대 색은 예전처럼 하나');
});

await test('indicators: legend shows BB low~high on hover, VWAP its latest value until hovered', () => {
  const { c, run, elements } = harness(['renderMaLegend']);
  run(formatting);
  const box = c.document.getElementById('maLegend');
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  c.document.createElement = () => node();
  box.appendChild = (s) => items.push(s);
  Object.assign(c, { cssVar: (n) => n, maColor: () => '#000' });
  run('lastProfile = null;');
  run(`lastChart = { cur: 'KRW', mas: [], trends: [], bands: { upper: [110, 120], lower: [90, 95] },
    vwapLine: [100, 102, null] };`);
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  run('hoverIdx = null; renderMaLegend();');
  assert.equal(elements.get('maLegend').hidden, false, '지표만 켜져 있어도 범례가 보인다');
  assert.deepEqual([...read()], ['BB=', 'VWAP=102'], '마우스를 안 올리면 VWAP 는 마지막 값(애프터 칸 앞), BB 는 비움');
  items.length = 0;
  run('hoverIdx = 0; renderMaLegend();');
  assert.deepEqual([...read()], ['BB=90~110', 'VWAP=100']);
  items.length = 0;
  run('lastChart.bands = null; lastChart.vwapLine = null; renderMaLegend();');
  assert.equal(elements.get('maLegend').hidden, true);
  // 매물대는 가장 많이 거래된 가격대를 늘 보인다
  items.length = 0;
  run('lastProfile = { lo: 100, step: 5, poc: 2, vols: [1, 2, 9] }; renderMaLegend();');
  assert.equal(elements.get('maLegend').hidden, false);
  assert.deepEqual([...read()], ['매물대=110~115']);
});

// 파라볼릭 SAR(보조 지표). 일봉 기간은 차트 첫날 앞의 5년치 일봉 고 · 저를 이어 계산한다 — SAR 은 지난 흐름을
// 이어받아서, 차트 첫 봉에서 새로 시작하면 1M 은 대부분 다른 값이 된다. 1D 는 정규장 봉만, 그날 첫 봉부터.
await test('indicators: SAR continues from the daily history on daily charts and uses regular bars only on 1D', () => {
  const { c, run } = harness(['sarFor']);
  const day = 86400000;
  const t0 = Date.parse('2026-08-01T00:00:00Z');
  const N = 40;
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const H = Array.from({ length: N }, (_, i) => 101 + 10 * Math.sin(i / 4));
  const L = H.map((v) => v - 2);
  run(`quotes.X = { dailyHL: { times: ${JSON.stringify(T)}, highs: ${JSON.stringify(H)}, lows: ${JSON.stringify(L)} } };`);
  // 차트는 마지막 10일. 오늘 봉은 실시간 캔들로 맞춘 값이라 일봉과 다를 수 있다 — 차트 쪽 값을 쓴다.
  const cH = H.slice(-10); const cL = L.slice(-10);
  cH[9] += 5;
  const r = run(`sarFor('X', ${JSON.stringify(T.slice(-10))}, ${JSON.stringify(cH)}, ${JSON.stringify(cL)})`);
  const full = c.parabolicSar([...H.slice(0, 30), ...cH], [...L.slice(0, 30), ...cL]);
  assert.equal(JSON.stringify(r.data), JSON.stringify(full.sar.slice(30)), '5년치 흐름을 이어 받은 값');
  assert.equal(JSON.stringify(r.up), JSON.stringify(full.up.slice(30)));
  let k = full.up.length - 1;
  while (full.up[k - 1] === full.up.at(-1)) k--;
  assert.equal(r.rising, full.up.at(-1));
  assert.equal(r.since, full.up.length - k, '전환 봉부터 센 봉 수');
  assert.equal(r.flipAt, [...T.slice(0, 30), ...T.slice(-10)][k], '전환 봉의 시각(차트 밖일 수도 있다)');
  const alone = c.parabolicSar(cH, cL);
  assert.notEqual(JSON.stringify(r.data), JSON.stringify(alone.sar), '차트 봉만으로 새로 시작한 값과 다르다');

  // 1D: 정규장 봉만으로 계산하고 시간외 칸은 비운다. 일봉 흐름은 잇지 않는다(그날 첫 봉부터).
  const t1 = Date.parse('2026-09-10T08:00:00+09:00');
  const times = [0, 1, 2, 3, 4, 5].map((i) => t1 + i * 300000);
  const h1 = [50, 101, 103, 104, 102, 60];
  const l1 = [49, 99, 101, 102, 98, 59];
  const ext = ['pre', null, null, null, null, 'after'];
  const d = run(`sarFor('X', ${JSON.stringify(times)}, ${JSON.stringify(h1)}, ${JSON.stringify(l1)}, ${JSON.stringify(ext)})`);
  const reg = c.parabolicSar(h1.slice(1, 5), l1.slice(1, 5));
  assert.equal(JSON.stringify(d.data), JSON.stringify([null, ...reg.sar, null]), '시간외 칸은 비우고 정규장 봉만으로');
  assert.equal(d.up[0], null);
  assert.equal(d.up[5], null);

  run('delete quotes.X;');
  const bare = run(`sarFor('X', ${JSON.stringify(T.slice(-10))}, ${JSON.stringify(cH)}, ${JSON.stringify(cL)})`);
  assert.equal(JSON.stringify(bare.data), JSON.stringify(alone.sar), '일봉이 없으면 차트 봉만으로');
  assert.equal(run('sarFor("X", [1], [1], [1])'), null, '봉이 모자라면 없다');
});

await test('indicators: loadChart passes SAR on 1D, 1W and the daily periods only, and only when the chip is on', async () => {
  const { c, run } = harness(['loadChart', 'sarFor']);
  const draws = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, renderTrendBadges: () => {}, curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run("let lastDrawSig = null; quotes['005930.KS'] = { price: 104, prevClose: 100, change: 4 };");
  const series = (n) => ({ ok: true, closes: Array.from({ length: n }, (_, i) => 100 + (i % 4)),
    times: Array.from({ length: n }, (_, i) => Date.parse('2026-09-01T00:00:00Z') + i * 86400000),
    volumes: new Array(n).fill(1), opens: Array.from({ length: n }, (_, i) => 100 + (i % 4)),
    highs: Array.from({ length: n }, (_, i) => 101 + (i % 4)), lows: Array.from({ length: n }, (_, i) => 99 + (i % 4)) });
  const show = async (tf, on) => {
    bars = series(8);
    run(`lastDrawSig = null; state.timeframe = '${tf}'; state.indicators = cleanIndicators({ sar: ${on} });`);
    await c.loadChart();
    return draws.at(-1).sar;
  };
  for (const tf of ['1D', '1W', '1M', '3M', '1Y', '3Y']) assert.ok(await show(tf, true), `${tf} 에는 그린다`);
  assert.equal((await show('1M', true)).data.length, 8);
  assert.equal(await show('전체', true), null, '전체(월봉 · 분기봉)도 그리지 않는다');
  assert.equal(await show('1M', false), null, '칩을 끄면 없다');
});

await test('indicators: SAR legend shows the direction and how long it has held, the value on hover', () => {
  const { c, run } = harness(['renderMaLegend', 'labelFor']);
  run(formatting);
  const box = c.document.getElementById('maLegend');
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  c.document.createElement = () => node();
  box.appendChild = (s) => items.push(s);
  Object.assign(c, { cssVar: (n) => n, maColor: () => '#000' });
  const flip = Date.parse('2026-10-09T00:00:00Z');
  run(`lastProfile = null; state.timeframe = '1M';
    lastChart = { cur: 'KRW', mas: [], trends: [], sar: { data: [null, 95000, 96000], up: [null, false, false],
      rising: false, since: 4, flipAt: ${flip} } };`);
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  run('hoverIdx = null; renderMaLegend();');
  assert.equal(c.document.getElementById('maLegend').hidden, false, 'SAR 만 켜져 있어도 범례가 보인다');
  assert.deepEqual([...read()], ['SAR=하락 4일째']);
  assert.equal(items[0].kids[1].style.background, '--sar-down', '하락이면 파랑 점의 색');
  assert.equal(items[0].title, `파라볼릭 SAR — ${run(`labelFor(${flip}, '1M')`)} 하락 전환 (가속 0.02 · 최대 0.2). 상승 추세면 점이 봉 아래, 하락 추세면 봉 위`);
  items.length = 0;
  run('hoverIdx = 1; renderMaLegend();');
  assert.deepEqual([...read()], ['SAR=95,000'], '마우스를 올리면 그 봉의 SAR');
  items.length = 0;
  const at = Date.parse('2026-10-15T13:20:00+09:00');
  run(`hoverIdx = null; state.timeframe = '1D'; lastChart.sar.rising = true; lastChart.sar.flipAt = ${at}; renderMaLegend();`);
  assert.deepEqual([...read()], [`SAR=상승 · ${run(`labelFor(${at}, '1D')`)}부터`], '1D 는 일 대신 전환 시각');
  assert.equal(items[0].kids[1].style.background, '--sar-up');
  items.length = 0;
  run("state.timeframe = '1W'; renderMaLegend();");
  assert.deepEqual([...read()], [`SAR=상승 · ${run(`labelFor(${at}, '1W')`)}부터`], '1W 도 전환 시각(1W 축과 같은 날짜 · 시)');
});

await test('indicators: drawChart draws SAR as dots on the price axis, red below a rising trend and blue above a falling one', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  run(`state.timeframe = '1M';
    var C_ = [100, 101, 102, 103];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [1, 1, 1, 1], highs: C_, lows: C_,
      sar: { data: [null, 99, 100, 104], up: [null, true, true, false] } };`);
  run('drawChart(arg_);');
  const dots = configs.at(-1).data.datasets.find((d) => d.showLine === false);
  assert.ok(dots, '선 없이 점만');
  assert.equal(dots.yAxisID, 'y');
  assert.equal(JSON.stringify(dots.data), '[null,99,100,104]');
  assert.equal(JSON.stringify(dots.pointBackgroundColor.slice(1)), '["--sar-up","--sar-up","--sar-down"]');
  assert.ok(dots.pointRadius > 0 && dots.pointHitRadius === 0, '점은 보이되 마우스 대상은 아니다');
  run('arg_.sar = null; drawChart(arg_);');
  assert.equal(configs.at(-1).data.datasets.some((d) => d.showLine === false), false);
});

// 지수 대비 수익률(보조 지표): 기간 배지에 종목 수익률 - 같은 기간 지수 수익률(%p).
await test('indicators: period badge adds the excess return over the index, with the index return in its tooltip', () => {
  const { run, elements } = harness(['renderPeriod']);
  run(formatting);
  run("hexA = () => 'bg'; cssVar = () => '#888';");
  const el = () => elements.get('period');
  run("state.timeframe = '1M'; renderPeriod(100, 105.2, { name: '코스피', pct: 2.1 });");
  assert.equal(el().hidden, false);
  assert.match(el().innerHTML, /^1M \+5\.20%<span style="color:#e24b4a"> · 초과 \+3\.10%p<\/span>$/, el().innerHTML);
  assert.equal(el().title, '같은 기간 코스피 +2.10% — 종목이 3.10%p 앞섬');
  run("renderPeriod(100, 101, { name: '코스닥', pct: 4 });");
  assert.match(el().innerHTML, /초과 -3\.00%p/);
  assert.match(el().innerHTML, /color:#185fa5/, '뒤처지면 파랑');
  assert.match(el().title, /3\.00%p 뒤처짐/);
  run('renderPeriod(100, 101);');
  assert.equal(el().innerHTML, '1M +1.00%', '끄면 예전 그대로');
  assert.equal(el().title, '');
  run("state.timeframe = '1D'; renderPeriod(100, 101, { name: '코스피', pct: 1 });");
  assert.equal(el().hidden, true, '1D 는 기간 배지가 없다');
});

await test('indicators: loadChart fetches the matching index with the chart — KOSPI, KOSDAQ or S&P 500 — and uses the live index value', async () => {
  const { c, run } = harness(['loadChart', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const asked = [];
  const periods = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => day(`2026-09-0${i + 1}`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  const charts = { '^KS11': series([2000, 2100]), '^KQ11': series([800, 760]), '^GSPC': series([5000, 5100]) };
  Object.assign(c, {
    fetchChartCached: async (s) => { asked.push(s); return charts[s] || series([100, 110]); },
    err: () => {}, quoteErrText: () => '', renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW', drawChart: () => {},
    renderPeriod: (first, last, rel) => periods.push({ first, last, rel }),
  });
  run("let lastDrawSig = null; state.watchlist = [{ symbol: '005930.KS', name: 'a' }, { symbol: '247540.KQ', name: 'b' }, { symbol: 'SOXL', name: 'c' }];");
  const view = async (symbol, tf = '1M', rel = true) => {
    asked.length = 0;
    run(`lastDrawSig = null; state.selected = '${symbol}'; state.timeframe = '${tf}';
      state.indicators = cleanIndicators({ rel: ${rel} }); quotes['${symbol}'] = { price: 110, prevClose: 100, change: 10 };`);
    await c.loadChart();
    return periods.at(-1);
  };
  let p = await view('005930.KS');
  assert.deepEqual([...asked], ['005930.KS', '^KS11'], '코스피 상장은 코스피');
  assert.equal(p.rel.name, '코스피');
  assert.equal(p.rel.pct, 5, '지수 차트 마지막 값으로');
  run("quotes['^KS11'] = { price: 2200 };"); // 위 지수 줄의 실시간 값
  p = await view('005930.KS');
  assert.equal(p.rel.pct, 10, '국내 지수는 실시간 지수 값을 쓴다');
  p = await view('247540.KQ');
  assert.deepEqual([...asked], ['247540.KQ', '^KQ11'], '코스닥 상장은 코스닥');
  assert.equal(p.rel.pct, -5);
  p = await view('SOXL');
  assert.deepEqual([...asked], ['SOXL', '^GSPC'], '미국은 S&P 500');
  assert.equal(p.rel.name, 'S&P 500');
  p = await view('SOXL', '1M', false);
  assert.deepEqual([...asked], ['SOXL'], '끄면 지수를 받지 않는다');
  assert.equal(p.rel, null);
  p = await view('SOXL', '1D');
  assert.deepEqual([...asked], ['SOXL'], '1D 는 기간 배지가 없어 받지 않는다');
  run("state.selected = '^KS11'; state.timeframe = '1M'; quotes['^KS11'] = { price: 2200 }; lastDrawSig = null;");
  asked.length = 0;
  await c.loadChart();
  assert.deepEqual([...asked], ['^KS11'], '지수 자체를 볼 때는 비교하지 않는다');
});

// 지표 보기(차트 대신): 오늘 거래량 배수 · 기간 수익률 · 투자자별 매매동향 · 실적 · 가치 지표 · 컨센서스 · 동종 업종.
// 데이터는 main 의 naver:detail(tests/detail.mjs), 배수 · 수익률은 이미 받은 일봉으로 렌더러가 센다.
// renderer.js 의 const 한 문장(끝 표시까지). 소스는 CRLF 라 줄 끝을 가리지 않는다.
const block = (name, end = /\r?\n\};\r?\n/) => {
  const i = source.indexOf(`const ${name} = `);
  assert.notEqual(i, -1, name);
  const m = end.exec(source.slice(i));
  assert.ok(m, `${name} 의 끝`);
  return source.slice(i, i + m.index + m[0].length);
};
const helpers = () => formatting + block('fmtVol') + block('esc', /\}\[c\]\)\);/);
const text = (h) => h.replace(/<[^>]+>/g, ''); // 태그를 뺀 글자 — 항목마다 줄바꿈을 막는 span 을 건너뛰고 읽는다
const kst = (d) => Date.parse(`${d}T09:00:00+09:00`); // 국내 일봉 시각(00:00 UTC)
const days = (from, n) => Array.from({ length: n }, (_, i) => kst(from) + i * 86400000);

await test('metrics: today volume against the 20 trading days before its own date (KRX), US by its own date', () => {
  const { run } = harness(['metricsVolume']);
  // 25일: 앞 4일 500, 그다음 20일 1,000, 마지막(오늘 10/16) 9,999 — 오늘 봉은 평균에서 뺀다
  const T = days('2026-09-22', 25);
  const V = [500, 500, 500, 500, ...new Array(20).fill(1000), 9999];
  run(`quotes['005930.KS'] = { dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} } };`);
  const r = run("metricsVolume('005930.KS', { volume: 550, at: '2026-10-16T13:30:41+09:00' })");
  assert.equal(r.avg, 1000, '그날 앞의 20일');
  assert.equal(r.ratio, 0.55);
  // 거래량 0 인 날(휴장 · 빈 봉)은 평균에서 뺀다
  V[23] = 0;
  run(`quotes['005930.KS'].dailyVolume.volumes = ${JSON.stringify(V)};`);
  assert.equal(run("metricsVolume('005930.KS', { volume: 550, at: '2026-10-16T13:30:41+09:00' })").avg, (19 * 1000 + 500) / 20);
  assert.equal(run("metricsVolume('005930.KS', { volume: null, at: null })"), null, '거래량이 없으면 없다');
  assert.equal(run("metricsVolume('NONE', { volume: 5, at: '2026-10-16T13:30:41+09:00' })"), null, '일봉이 없으면 없다');

  // 미국: 장 전에는 어제(뉴욕) 거래량이 온다 — 그날 앞의 20일로 센다. 날짜는 UTC(뉴욕과 같다)
  const U = Array.from({ length: 22 }, (_, i) => Date.parse('2026-09-15T13:30:00Z') + i * 86400000);
  const UV = [...new Array(21).fill(2000), 7777];
  run(`quotes.SOXL = { dailyVolume: { times: ${JSON.stringify(U)}, volumes: ${JSON.stringify(UV)} } };`);
  const at = new Date(U[21]).toISOString().slice(0, 10) + 'T16:00:00-04:00';
  const u = run(`metricsVolume('SOXL', { volume: 4000, at: '${at}' })`);
  assert.equal(u.avg, 2000, '거래량의 날(뉴욕 마감) 봉은 빼고 그 앞 20일');
  assert.equal(u.ratio, 2);
});

await test('metrics: period returns from the daily closes — 1W · 1M · 3M · YTD · 1Y, empty when the history is shorter', () => {
  const { run } = harness(['periodReturns']);
  // 2025-10-01 ~ 2026-10-16 매일 한 봉, 종가 = 1000 + 날짜 번호
  const T = days('2025-10-01', 381);
  const C = T.map((_, i) => 1000 + i);
  run(`quotes.X = { price: 2000, daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} } };`);
  const at = (d) => 1000 + T.indexOf(kst(d));
  const pct = (base) => ((2000 - base) / base) * 100;
  const r = run("periodReturns('X')");
  assert.deepEqual([...r.map((x) => x.label)], ['1주', '1개월', '3개월', '올해', '1년']);
  assert.equal(r[0].pct, pct(at('2026-10-09')), '1주 — 7일 전 봉부터, 마지막은 현재가');
  assert.equal(r[1].pct, pct(at('2026-09-16')));
  assert.equal(r[2].pct, pct(at('2026-07-16')));
  assert.equal(r[3].pct, pct(at('2025-12-31')), '올해 — 작년 마지막 봉부터');
  assert.equal(r[4].pct, pct(at('2025-10-16')));
  // 한 달치뿐이면 3개월 · 올해 · 1년은 없다(첫 봉부터 센 값이 그 기간 수익률로 읽히면 안 된다)
  run(`quotes.X.daily = { times: ${JSON.stringify(T.slice(-31))}, closes: ${JSON.stringify(C.slice(-31))} };`);
  const short = run("periodReturns('X')");
  assert.deepEqual([...short.map((x) => x.pct == null)], [false, false, true, true, true]);
  assert.equal(run("periodReturns('NONE')").length, 0);
  // 3/31 의 한 달 전은 2/28 이다(2/31 이 3/3 으로 넘어가지 않게)
  const M = days('2026-01-01', 90); // ~ 2026-03-31
  run(`quotes.X.daily = { times: ${JSON.stringify(M)}, closes: ${JSON.stringify(M.map((_, i) => 1000 + i))} };`);
  assert.equal(run("periodReturns('X')")[1].pct, pct(1000 + M.indexOf(kst('2026-02-28'))), '그달에 그날이 없으면 그달 마지막 날');
});

const KR_DETAIL = {
  ok: true, market: 'kr', kind: 'stock',
  today: { volume: 11822115, at: '2026-10-16T13:30:41+09:00', totalVolume: 21217698, value: '4조 5,732억', marketValue: '1,280조 3,350억', foreignRate: '45.98%' },
  valuation: [{ label: 'PER', value: '9.82배' }, { label: 'PBR', value: '2.54배' }],
  consensus: { target: 495227, high: null, low: null, opinion: 4, date: '2026-10-15', currency: 'KRW' },
  trend: Array.from({ length: 20 }, (_, i) => ({ date: `202610${String(15 - (i % 10)).padStart(2, "0")}`, foreign: i < 5 ? -100000 : 10000, organ: 20000, individual: 0, foreignRatio: 45 })),
  ir: { title: '2026년 3분기 경영실적 발표', date: '2026-10-29', dday: 13 },
  quarters: { unit: '억원', cols: [{ title: '25.12', estimate: false }, { title: '26.03', estimate: false }, { title: '26.06', estimate: false }, { title: '26.09', estimate: true }, { title: '26.12', estimate: true }],
    rows: [{ title: '매출액', values: [938374, 1338734, 1714995, 2007657, null] }, { title: '영업이익', values: [-5000, 572328, 894924, 1069435, null] }] },
  peers: [{ name: 'SK하이닉스', pct: 3.25 }, { name: '<b>가짜</b>', pct: -1.5 }],
  etf: null,
};

await test('metrics: panel for a Korean stock — volume multiple, returns, investor table with 5/20-day sums, earnings, valuation, consensus, peers', () => {
  const { c, run } = harness(['metricsHtml', 'metricsVolume', 'periodReturns']);
  run(helpers());
  const T = days('2026-09-15', 32);
  run(`quotes['005930.KS'] = { price: 219000, currency: 'KRW',
    daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(T.map(() => 200000))} },
    dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(T.map(() => 21495000))} } };`);
  c.D = KR_DETAIL;
  const html = run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])");
  assert.match(html, /거래량 <b>1,182만 주<\/b> · 20일 평균의 <b>0\.55배<\/b>/, '오늘 거래량(KRX)과 배수');
  assert.match(html, /10\/16 13:30/, '그 거래량의 시각');
  assert.match(text(html), /NXT 포함 2,122만 · 대금 4조 5,732억 · 시총 1,280조 3,350억 · 외국인 소진율 45\.98%/);
  assert.match(html, /<span class="mxi">외국인 소진율 45\.98%<\/span>/, '항목 하나는 줄바꿈하지 않는다(외국인 / 소진율로 쪼개지지 않게)');
  assert.match(html, /<span class="mxi">1주 <b/, '기간 수익률도 항목마다(1 / 년으로 쪼개지지 않게)');
  assert.match(html, /1주 <b style="color:#e24b4a">\+9\.50%<\/b>/, '기간 수익률(빨강 = 상승)');
  // 매매동향: 앞 5일 외국인 -10만 × 5 = -50만, 20일 = -50만 + 1만 × 15 = -35만. 기관 2만 × 5 = +10만, × 20 = +40만
  assert.match(html, /<td>5일<\/td><td style="color:#185fa5">-50만<\/td><td style="color:#e24b4a">\+10만<\/td><td>0<\/td>/, '5일 합');
  assert.match(html, /<td>20일<\/td><td style="color:#185fa5">-35만<\/td><td style="color:#e24b4a">\+40만<\/td>/, '20일 합');
  assert.equal((html.match(/<tr class="day">/g) || []).length, 10, '날짜별은 최근 10일');
  assert.match(html, /<tr class="day"><td>10\/15<\/td><td style="color:#185fa5">-10만<\/td>/, '최근이 먼저, MM/DD');
  assert.match(html, /2026년 3분기 경영실적 발표 <b>10\/29<\/b> · D-13/, '실적 발표 일정');
  assert.match(html, /<th>26\.03<\/th><th>26\.06<\/th><th>26\.09E<\/th><th>26\.12E<\/th>/, '분기는 최근 4개, 추정치는 E');
  assert.match(html, /<td>매출액<\/td><td>133\.9조<\/td><td>171\.5조<\/td><td>200\.8조<\/td><td>—<\/td>/, '억원 → 조, 빈 값은 —');
  assert.match(html, /<td>영업이익<\/td><td>57\.2조<\/td>/);
  assert.match(text(html), /PER 9\.82배 · PBR 2\.54배/);
  assert.match(html, /목표가 평균 <b>495,227원<\/b> \(현재가 대비 \+126\.13%\) · 의견 4\.00 \/ 5/, '컨센서스와 현재가 대비');
  assert.match(html, /10\/15 기준 · 증권사 추정치, 참고용/);
  assert.match(html, /SK하이닉스 <b style="color:#e24b4a">\+3\.25%<\/b>/, '동종 업종');
  assert.ok(html.includes('&lt;b&gt;가짜&lt;/b&gt;') && !html.includes('<b>가짜</b>'), '이름은 이스케이프한다');
});

await test('metrics: US stock shows no investor table, consensus range in dollars; ETF shows NAV instead of valuation; loading and failure states', () => {
  const { c, run } = harness(['metricsHtml', 'metricsVolume', 'periodReturns']);
  run(helpers());
  run("quotes.AAPL = { price: 330, currency: 'USD' }; quotes['069500.KS'] = { price: 87025, currency: 'KRW' };");
  c.US = { ...KR_DETAIL, market: 'us', trend: null, ir: null,
    today: { volume: 39767256, at: '2026-10-15T16:00:00-04:00', totalVolume: null, value: '137억 USD', marketValue: '4조 9,912억 USD', foreignRate: null },
    consensus: { target: 324.89, high: 405, low: 215, opinion: 3.7, date: '2026-10-08', currency: 'USD' },
    quarters: { unit: 'USD 백만', cols: [{ title: '26.06', estimate: false }], rows: [{ title: '영업이익(EBIT)', values: [35695] }] } };
  const us = run("metricsHtml({ symbol: 'AAPL', name: '애플' }, US, quotes.AAPL)");
  assert.match(us, /투자자별 매매동향은 국내 종목만 있습니다/);
  assert.doesNotMatch(us, /NXT/, '미국은 NXT 줄이 없다');
  assert.match(text(us), /대금 137억 USD · 시총 4조 9,912억 USD/);
  assert.match(us, /목표가 평균 <b>\$324\.89<\/b> \(현재가 대비 -1\.55%\) · 의견 3\.70 \/ 5 · 최저 \$215\.00 ~ 최고 \$405\.00/);
  assert.match(us, /<td>영업이익\(EBIT\)<\/td><td>35\.7B<\/td>/, 'USD 백만 → B');
  assert.doesNotMatch(us, /실적 발표/, '일정이 없으면 그 줄이 없다');

  c.ETF = { ...KR_DETAIL, kind: 'etf', valuation: [], consensus: null, ir: null, quarters: null, peers: [],
    etf: { nav: 87038.98, deviation: -0.02, issuer: '삼성자산운용(ETF)', baseIndex: '코스피 200', dividendYield: 0.98 } };
  const etf = run("metricsHtml({ symbol: '069500.KS', name: 'KODEX 200' }, ETF, quotes['069500.KS'])");
  assert.match(text(etf), /NAV 87,038\.98 · 괴리율 -0\.02% · 분배율 0\.98% · 코스피 200 · 삼성자산운용\(ETF\)/);
  assert.doesNotMatch(etf, /가치 지표|동종 업종|실적/, '없는 칸은 제목까지 뺀다');
  assert.doesNotMatch(etf, /NXT/, 'ETF 는 NXT 에 없어 NXT 포함 거래량을 적지 않는다');

  assert.match(run("metricsHtml({ symbol: 'AAPL', name: '애플' }, undefined, quotes.AAPL)"), /불러오는 중/);
  const bad = run("metricsHtml({ symbol: 'AAPL', name: '애플' }, { ok: false, error: '<x>' }, quotes.AAPL)");
  assert.match(bad, /지표를 불러오지 못했습니다 \(&lt;x&gt;\)/, '실패 — 이유는 이스케이프');
});

await test('metrics: the button swaps the chart for the panel, hides for indices, fetches on open, reuses for a minute and drops a late reply for another symbol', async () => {
  const { c, run, elements } = harness(['renderMetrics', 'loadMetrics']);
  const asked = [];
  const replies = [];
  c.api.detail = (symbol) => { asked.push(symbol); return new Promise((r) => replies.push(r)); };
  c.metricsHtml = (item, d) => (d ? `${item.symbol}:${d.ok ? d.n : "fail"}` : 'LOADING');
  const settle = () => new Promise((r) => setImmediate(r));
  const btn = () => elements.get('metricsBtn');
  const panel = () => elements.get('metricsView');

  run('renderMetrics();');
  assert.equal(btn().hidden, false, '종목이면 버튼이 있다');
  assert.equal(btn().textContent, '지표', '제목줄의 작은 글자 버튼');
  assert.equal(panel().hidden, true, '처음에는 차트');
  assert.equal(asked.length, 0, '닫혀 있으면 받지 않는다');

  run('metricsOn = true; renderMetrics();');
  assert.equal(panel().hidden, false);
  assert.equal(btn().className, 'mxbtn on');
  assert.equal(btn().textContent, '차트', '열려 있으면 차트로 돌아가는 버튼');
  assert.equal(panel().innerHTML, 'LOADING');
  assert.deepEqual([...asked], ['005930.KS'], '열면 받는다');
  run('renderMetrics();');
  assert.equal(asked.length, 1, '받는 중이면 또 묻지 않는다');
  replies.shift()({ ok: true, n: 1 });
  await settle();
  assert.equal(panel().innerHTML, '005930.KS:1', '받으면 다시 그린다');

  run('renderMetrics();');
  assert.equal(asked.length, 1, '1분 안에는 받은 것을 쓴다');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + 61000; // 하네스 시각 + 61초
  run('renderMetrics();');
  assert.equal(asked.length, 2, '1분이 지나면 다시 받는다');
  assert.equal(panel().innerHTML, '005930.KS:1', '받는 동안은 있던 것을 보인다');
  replies.shift()({ ok: false, error: 'x' });
  await settle();
  assert.equal(panel().innerHTML, '005930.KS:1', '다시 받다 실패하면 있던 것을 둔다');

  // 다른 종목으로 넘어간 뒤 늦게 온 응답은 그 종목 캐시에만 넣고 화면은 고치지 않는다
  run("state.selected = '000660.KS'; renderMetrics();");
  assert.equal(asked.at(-1), '000660.KS');
  run("state.selected = '005930.KS'; renderMetrics();");
  replies.shift()({ ok: true, n: 7 });
  await settle();
  assert.equal(panel().innerHTML, '005930.KS:1', '고른 종목이 아니면 화면을 고치지 않는다');
  run("state.selected = '000660.KS'; renderMetrics();");
  assert.equal(panel().innerHTML, '000660.KS:7', '그 종목으로 돌아오면 받아 둔 것을 쓴다');

  run("state.selected = '^KS11'; renderMetrics();");
  assert.equal(btn().hidden, true, '지수는 버튼이 없다');
  assert.equal(panel().hidden, true, '지수로 가면 차트로 돌아간다');
  run("state.selected = '005930.KS'; metricsOn = false; renderMetrics();");
  assert.equal(panel().hidden, true);
  assert.equal(btn().className, 'mxbtn');
  assert.equal(btn().textContent, '지표');
  // 상세를 그릴 때(종목 바꾸기 · 30초 갱신 · 삭제)마다 지표 화면도 고른 종목에 맞춘다
  assert.match(realFunction('renderDetail'), /\n  renderMetrics\(\);/, 'renderDetail 이 renderMetrics 를 부른다');
  c.Date.now = realNow;
});

// 시장 순위(헤더의 순위 버튼이 여는 패널). 데이터는 main 의 naver:rank(tests/rank.mjs) — 렌더러는 목록을 그리고,
// 국내 / 미국과 탭을 바꾸고, 누르면 관심종목에 넣거나 그 종목으로 간다.
const KR_RANK = { ok: true, market: 'kr', kind: 'up', filtered: true, at: '2026-10-16T14:22:23+09:00', items: [
  { symbol: '005930.KS', name: '삼성전자', price: 219000, pct: 4.29, value: 3043864000000, cap: 1280335015152000, currency: 'KRW' },
  { symbol: '196170.KQ', name: '<i>알테오젠</i>', price: 239500, pct: -1.5, value: 101876000000, cap: 16682400000000, currency: 'KRW' },
  { symbol: '000001.KS', name: '보합', price: 1000, pct: 0, value: 1e9, cap: 1e11, currency: 'KRW' }] };

await test('rank: list shows rank, name with a check for watchlist stocks, price, colored change and trading value; the note says the basis and filter', () => {
  const { c, run } = harness(['rankHtml']);
  run(helpers());
  c.D = KR_RANK;
  const html = run("rankHtml(D, 'kr', 'up')");
  assert.equal((html.match(/class="hit rrow"/g) || []).length, 3);
  assert.match(html, /<div class="hit rrow" data-i="0"><span class="rk">1<\/span><span class="hname"><span class="rin" title="관심종목에 있음">✓<\/span>삼성전자<\/span><span class="rpx">219,000<\/span><span class="rpct" style="color:#e24b4a">\+4\.29%<\/span><span class="rval">3\.0조<\/span><\/div>/,
    '관심종목에 있으면 ✓, 거래대금 원 → 조');
  assert.match(html, /<span class="hname">&lt;i&gt;알테오젠&lt;\/i&gt;<\/span>/, '이름은 이스케이프한다, 관심종목이 아니면 ✓ 없음');
  assert.match(html, /<span class="rpct" style="color:#185fa5">-1\.50%<\/span><span class="rval">1,019억<\/span>/, '1조 미만은 억');
  assert.match(html, /<span class="rpct">0\.00%<\/span>/, '보합은 색 없음');
  assert.match(text(html), /^10\/16 14:22 기준 · 일반 주식만\(ETF · ETN · 우선주 제외\) · 거래대금 10억 원 이상 · 코스피 \+ 코스닥1/,
    '기준 문구는 목록 맨 위 — 열자마자 보인다(스크롤해야 보이면 지난 장 순위인지 모른다)');
  assert.ok(html.indexOf('rnote') < html.indexOf('rrow'), '기준 문구가 첫 줄보다 위');
  assert.equal(run(`esc("L'Oreal & <b>")`), 'L&#39;Oreal &amp; &lt;b&gt;', '홑따옴표도 — 속성에 홑따옴표를 쓰는 곳이 생겨도 깨지지 않게');
  c.D = { ...KR_RANK, kind: 'search', filtered: false };
  assert.match(text(run("rankHtml(D, 'kr', 'search')")), /^[^가-힣]*기준 · 네이버 인기 검색 순1/);

  c.D = { ok: true, market: 'us', kind: 'cap', filtered: true, at: '2026-10-15T16:00:00-04:00', items: [
    { symbol: 'NVDA', name: '엔비디아', price: 210.5, pct: -1.84, value: 9348515000, cap: 5235200000000, currency: 'USD' },
    { symbol: 'INDP', name: '인댑터스', price: 3.1, pct: 28.96, value: 12000000, cap: 400000000, currency: 'USD' }] };
  const us = run("rankHtml(D, 'us', 'cap')");
  assert.match(us, /<span class="rpx">210\.50<\/span>.*?<span class="rval">\$5\.2T<\/span>/, '시총 상위 탭은 시총, 달러는 T · B · M');
  assert.match(us, /<span class="rval">\$400M<\/span>/);
  assert.match(text(us), /^10\/16 05:00 기준 · 일반 주식만 · 나스닥 \+ 뉴욕1/, '미국 시각도 한국 시각으로, 시총 상위는 시총으로 거르지 않는다');
  assert.match(text(run("rankHtml(D, 'us', 'value')")), /\$9\.3B/, '다른 탭은 거래대금');
  assert.match(text(run("rankHtml(D, 'us', 'up')")), /^[^가-힣]*기준 · 일반 주식만 · 시총 3억 달러 이상 · 나스닥 \+ 뉴욕1/);

  assert.match(run("rankHtml(undefined, 'kr', 'up')"), /순위를 불러오는 중/);
  assert.match(run("rankHtml({ ok: false, error: '<x>' }, 'kr', 'up')"), /순위를 불러오지 못했습니다 \(&lt;x&gt;\)/);
  c.D = { ...KR_RANK, items: [] };
  assert.match(run("rankHtml(D, 'kr', 'down')"), /조건에 맞는 종목이 없습니다/);
});

await test('rank: market and tab switch fetch only what is shown, reuse it for a minute, and a late reply does not replace another tab', async () => {
  const { c, run, elements } = harness(['renderRank', 'loadRank', 'setRankView']);
  const asked = [];
  const replies = [];
  c.api.rank = (q) => { asked.push(`${q.market}/${q.kind}`); return new Promise((r) => replies.push(r)); };
  c.rankHtml = (d, m, k) => (d ? `${m}/${k}:${d.n}` : `LOADING ${m}/${k}`);
  const settle = () => new Promise((r) => setImmediate(r));
  const list = () => elements.get('rankList').innerHTML;
  const tabs = () => elements.get('rankTabs').innerHTML;

  c.document.getElementById('rank').hidden = true;
  run('renderRank();');
  assert.equal(asked.length, 0, '닫혀 있으면 받지 않는다');

  c.document.getElementById('rank').hidden = false;
  run('renderRank();');
  assert.deepEqual([...asked], ['kr/search'], '처음은 국내 인기 검색');
  assert.equal(list(), 'LOADING kr/search');
  assert.match(tabs(), /<button data-kind="search" class="on">인기 검색<\/button><button data-kind="up">급등<\/button><button data-kind="down">급락<\/button><button data-kind="value">거래대금<\/button><button data-kind="industry">업종<\/button><button data-kind="theme">테마<\/button>/);
  assert.match(elements.get('rankMarket').innerHTML, /<button data-market="kr" class="on">국내<\/button><button data-market="us">미국<\/button>/);
  run('renderRank();');
  assert.equal(asked.length, 1, '받는 중이면 또 묻지 않는다');
  replies.shift()({ ok: true, n: 1 });
  await settle();
  assert.equal(list(), 'kr/search:1');

  run("setRankView('us');");
  assert.equal(asked.at(-1), 'us/up', '미국에는 인기 검색이 없어 첫 탭(급등)으로');
  assert.doesNotMatch(tabs(), /인기 검색/);
  assert.match(tabs(), /<button data-kind="cap">시총 상위<\/button>/);
  run("setRankView('us', 'cap');");
  assert.equal(asked.at(-1), 'us/cap');
  replies.shift()({ ok: true, n: 2 }); // 늦게 온 급등 — 지금 보는 것은 시총 상위
  await settle();
  assert.equal(list(), 'LOADING us/cap', '다른 탭의 늦은 응답은 화면을 바꾸지 않는다');
  replies.shift()({ ok: true, n: 3 });
  await settle();
  assert.equal(list(), 'us/cap:3');
  run("setRankView('us', 'up');");
  assert.equal(list(), 'us/up:2', '받아 둔 탭은 다시 묻지 않는다');
  assert.equal(asked.length, 3);

  run("setRankView('kr');");
  assert.equal(asked.at(-1), 'kr/up', '시장을 바꿔도 지금 탭(급등)이 그 시장에도 있으면 그대로');
  replies.shift()({ ok: true, n: 4 });
  await settle();
  assert.equal(list(), 'kr/up:4');
  run("setRankView('us', 'cap'); setRankView('kr');");
  assert.match(tabs(), /data-kind="search" class="on"/, '그 시장에 없는 탭(시총 상위)이면 첫 탭으로');
  assert.equal(list(), 'kr/search:1', '받아 둔 국내 인기 검색');
  assert.equal(asked.length, 4);
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + 61000; // 하네스 시각 + 61초
  run('renderRank();');
  assert.equal(asked.at(-1), 'kr/search', '1분이 지나면 다시 받는다');
  assert.equal(list(), 'kr/search:1', '받는 동안은 있던 것을 보인다');
  replies.shift()({ ok: false, error: 'x' });
  await settle();
  assert.equal(list(), 'kr/search:1', '다시 받다 실패하면 있던 것을 둔다');
  c.Date.now = realNow;
});

// 국내 업종 · 테마(tests/rank.mjs): 묶음 순위와, 누르면 그 묶음 안의 종목. 묶음 등락률은 평균이라 오른 · 내린 종목 수를 같이 보인다.
await test('rank groups: the industry/theme list shows rank, name, colored change and up/down counts; inside a group the note says how stocks are picked', () => {
  const { c, run } = harness(['rankHtml']);
  run(helpers());
  c.D = { ok: true, market: 'kr', kind: 'industry', groups: [
    { no: 278, name: '반도체와반도체장비', pct: 4.41, count: 173, up: 126, down: 40 },
    { no: 1, name: '<b>x</b>', pct: -1.2, count: 8, up: 2, down: 5 }] };
  const html = run("rankHtml(D, 'kr', 'industry')");
  assert.match(html, /<div class="hit rrow" data-g="0" title="173종목 중 오른 126 · 내린 40 — 누르면 종목"><span class="rk">1<\/span><span class="hname">반도체와반도체장비<\/span><span class="rpct" style="color:#e24b4a">\+4\.41%<\/span><span class="rcnt"><span style="color:#e24b4a">↑126<\/span> <span style="color:#185fa5">↓40<\/span><\/span><\/div>/);
  assert.match(html, /<span class="hname">&lt;b&gt;x&lt;\/b&gt;<\/span><span class="rpct" style="color:#185fa5">-1\.20%<\/span>/, '이름은 이스케이프한다');
  assert.match(text(html), /^네이버 업종 등락률 순 · 5종목 이상 · ↑오른 ↓내린 종목 수1/, '기준 문구가 맨 위');
  assert.match(text(run("rankHtml({ ...D, kind: 'theme' }, 'kr', 'theme')")), /^네이버 테마 등락률 순/);
  c.D = { ok: true, market: 'kr', kind: 'theme', groups: [] };
  assert.match(run("rankHtml(D, 'kr', 'theme')"), /조건에 맞는 테마가 없습니다/);
  c.D = { ...KR_RANK, kind: 'industry' };
  assert.match(text(run("rankHtml(D, 'kr', 'industry')")),
    /^10\/16 14:22 기준 · 등락률 순 · 일반 주식만\(ETF · ETN · 우선주 제외\) · 거래대금 10억 원 이상1/, '묶음 안의 종목 — 급등처럼 거른다');
});

await test('rank groups: clicking a group opens its stocks under a back row, back returns to the cached list, a stock click still picks it, and switching tabs leaves the group', async () => {
  const { c, run, elements } = harness(['renderRank', 'loadRank', 'setRankView', 'rankKey', 'rankClick', 'rankBackHtml']);
  run(helpers());
  const asked = [];
  c.api.rank = async (q) => {
    asked.push(JSON.stringify(q));
    return q.no ? { ok: true, items: [{ symbol: '000660.KS', name: 'SK하이닉스' }] }
      : { ok: true, groups: [{ no: 278, name: '반도체', pct: 4.4, count: 173, up: 126, down: 40 }] };
  };
  c.rankHtml = (d, m, k) => (d ? `${m}/${k}:${d.groups ? 'groups' : 'items'}` : `LOADING ${m}/${k}`);
  const picked = [];
  c.pickRank = async (it) => { picked.push(it.symbol); };
  const settle = () => new Promise((r) => setImmediate(r));
  const list = () => elements.get('rankList').innerHTML;
  // 누른 곳 — closest('[data-x]') 가 그 속성이 있으면 그 요소
  const at = (data) => ({ closest: (sel) => (/\[data-(\w+)\]/.exec(sel)[1] in data ? { dataset: data } : null) });

  c.document.getElementById('rank').hidden = false;
  run("setRankView('kr', 'industry');");
  await settle();
  assert.equal(asked.at(-1), JSON.stringify({ market: 'kr', kind: 'industry' }));
  assert.equal(list(), 'kr/industry:groups');

  c.rankClick(at({ g: '0' }));
  await settle();
  assert.equal(asked.at(-1), JSON.stringify({ market: 'kr', kind: 'industry', no: 278 }), '누른 묶음의 종목을 묻는다');
  assert.match(list(), /^<div class="hit rback" data-back="1" title="업종 목록으로">← <span class="hname">반도체<\/span><span class="rpct" style="color:#e24b4a">\+4\.40%<\/span><span class="rcnt"><span style="color:#e24b4a">↑126<\/span> <span style="color:#185fa5">↓40<\/span><\/span><\/div>kr\/industry:items$/,
    '맨 위에 돌아가는 줄(묶음 이름 · 등락률 · 오른 · 내린)');
  assert.match(elements.get('rankTabs').innerHTML, /data-kind="industry" class="on"/, '탭은 업종 그대로');

  c.rankClick(at({ i: '0' }));
  assert.deepEqual(picked, ['000660.KS'], '묶음 안의 종목도 누르면 관심종목으로');

  c.rankClick(at({ back: '1' }));
  assert.equal(list(), 'kr/industry:groups', '← 는 받아 둔 묶음 목록으로');
  assert.equal(asked.length, 2, '다시 묻지 않는다');

  c.rankClick(at({ g: '0' }));
  run("setRankView('kr', 'theme');");
  await settle();
  assert.equal(asked.at(-1), JSON.stringify({ market: 'kr', kind: 'theme' }), '탭을 바꾸면 묶음 밖 — 테마 목록');
  assert.equal(list(), 'kr/theme:groups');
});

await test('rank: clicking a stock already in the watchlist goes to it; a new one is added and opened; a failed add says so and keeps the panel', async () => {
  const { c, run, elements } = harness(['pickRank']);
  run(source.match(/^const adding = .*$/m)[0]); // 넣는 중인 종목(addSymbol)
  const log = [];
  Object.assign(c, {
    select: async (s) => { log.push(`select ${s}`); },
    closeRank: () => { log.push('close'); },
    addSymbol: async (it) => { log.push(`add ${it.symbol} ${it.name}`); if (it.symbol !== 'BAD') run(`state.watchlist.push({ symbol: '${it.symbol}', name: '${it.name}' });`); },
  });
  await c.pickRank({ symbol: '005930.KS', name: '삼성전자' });
  assert.deepEqual(log.splice(0), ['close', 'select 005930.KS'], '이미 있으면 넣지 않고 그 종목으로');
  await c.pickRank({ symbol: 'NVDA', name: '엔비디아' });
  assert.deepEqual(log.splice(0), ['add NVDA 엔비디아', 'close'], '없으면 넣고(넣으면서 연다) 패널을 닫는다');
  await c.pickRank({ symbol: 'BAD', name: '없는' });
  assert.deepEqual(log.splice(0), ['add BAD 없는'], '못 넣었으면 패널을 둔다');
  assert.match(elements.get('rankMsg').textContent, /없는: 추가하지 못했습니다/);
  assert.equal(elements.get('rankMsg').hidden, false);
  // 같은 줄을 또 눌렀다 — 먼저 누른 것이 넣는 중이면(addSymbol 이 바로 돌아온다) 실패로 적지 않는다
  run("adding.add('AMD'); document.getElementById('rankMsg').textContent = 'AMD 추가하는 중…';");
  await c.pickRank({ symbol: 'AMD', name: 'AMD' });
  assert.deepEqual(log.splice(0), [], '넣는 중이면 아무것도 하지 않는다');
  assert.equal(elements.get('rankMsg').textContent, 'AMD 추가하는 중…');
});

await test('rank: the three panels (search, settings, rank) close each other, and a widget opened from compact folds back only when all are closed', () => {
  const { c, run } = harness(['openPanel', 'closePanel']);
  const folds = [];
  Object.assign(c, { searchEl: { hidden: true }, alertsEl: { hidden: true }, rankEl: { hidden: true },
    setCompact: (on) => { folds.push(on); run(`compact = ${on};`); } });
  run('var compact = true; var expandedForPanel = false;');
  run('openPanel(rankEl);');
  assert.deepEqual(folds.splice(0), [false], '접혀 있으면 펼쳐서 연다');
  assert.equal(c.rankEl.hidden, false);
  run('openPanel(searchEl);');
  assert.equal(c.rankEl.hidden, true, '다른 패널을 열면 순위 패널은 닫힌다');
  assert.equal(c.searchEl.hidden, false);
  run('openPanel(rankEl);');
  assert.equal(c.searchEl.hidden, true, '순위 패널을 열면 검색은 닫힌다');
  c.searchEl.hidden = false; // 둘이 같이 열린 경우(검색에서 종목을 넣는 동안)
  run('closePanel(searchEl);');
  assert.deepEqual(folds.splice(0), [], '순위 패널이 아직 열려 있으면 다시 접지 않는다');
  run('closePanel(rankEl);');
  assert.deepEqual(folds.splice(0), [true], '모두 닫히면 다시 접는다');
  // Esc · 접기 버튼도 순위 패널을 안다
  assert.match(source, /if \(!rankEl\.hidden\) \{\s*if \(e\.key === 'Escape'\) closeRank\(\);\s*return;\s*\}/, 'Esc 로 닫는다');
  assert.match(realFunction('refreshAll'), /\n    renderRank\(\);/, '30초 갱신 때 열린 순위 패널도 고친다(1분 지난 탭을 다시 받는다)');
  assert.match(source, /if \(!searchEl\.hidden \|\| !alertsEl\.hidden \|\| !rankEl\.hidden\) \{\s*expandedForPanel = false;\s*closeSearch\(\);\s*closeAlerts\(\);\s*closeRank\(\);/, '접기를 누르면 모두 닫는다');
});

// 차트만 보기: 버튼 하나로 덧그림(이동평균 · 보조 지표 · 추세선 · 교차 · 가로선 · 기간 배지)을 다 끈다.
// 칩 설정은 그대로라 다시 누르면 돌아온다. 가격과 거래량 막대는 남는다.
await test('plain chart: one switch hides every overlay and keeps price and volume; switching back restores them', async () => {
  const { c, run, elements } = harness(['loadChart', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange', 'maFor']);
  const draws = [];
  const asked = [];
  const periods = [];
  const badges = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async (s) => { asked.push(s); return s === '005930.KS' ? bars : { ok: false, error: 'x' }; },
    err: () => {}, quoteErrText: () => '', renderMaChips: () => {}, curOf: () => 'KRW',
    renderPeriod: (...a) => periods.push(a),
    renderCrossBadge: (x) => badges.push(`cross ${x.length}`), renderTrendBadges: (x) => badges.push(`trend ${x.length}`),
    trendLine: () => ({ from: 0, to: 1 }), breakoutOf: () => false, // 추세선이 늘 하나씩 나오게
    drawChart: (data) => draws.push(data),
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-28T00:00:00Z');
  const N = 45;
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const C = Array.from({ length: N }, (_, i) => 100 + (i % 5));
  const V = Array.from({ length: N }, () => 1000);
  run(`let lastDrawSig = null; quotes['005930.KS'] = { price: ${C[N - 1]}, prevClose: 100, change: 4, live: true,
    daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} },
    dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} },
    recentBars: { times: [${Date.parse('2026-09-09T00:00:00Z')}, ${Date.parse('2026-09-10T00:00:00Z')}], highs: [110, 120], lows: [90, 95] } };
    state.maPeriods = [5]; state.holdings = { '005930.KS': { qty: 1, avg: 101 } };
    state.indicators = cleanIndicators({ bb: true, vwap: true, volAvg: true, prevHL: true, vp: true, rel: true });`);
  const daily = { ok: true, closes: C.slice(-22), times: T.slice(-22), volumes: V.slice(-22),
    opens: C.slice(-22), highs: C.slice(-22), lows: C.slice(-22) };
  const T1 = (s) => Date.parse(`2026-09-10T${s}:00+09:00`);
  const oneDay = { ok: true, closes: [100, 102, 101], times: ['09:00', '09:05', '09:10'].map(T1),
    volumes: [100, 300, 50], opens: [100, 102, 101], highs: [101, 103, 101], lows: [99, 101, 100] };
  const show = async (tf, plain, b) => {
    bars = b;
    asked.length = 0;
    run(`state.timeframe = '${tf}'; state.plainChart = ${plain};`);
    await c.loadChart();
    return draws.at(-1);
  };

  let d = await show('3M', false, daily);
  assert.ok(d.mas.length && d.bands && d.volAvg && d.profile && d.trends.length && d.hLines.length, '켜 둔 덧그림이 다 있다');
  assert.deepEqual([...asked], ['005930.KS', '^KS11']);
  const drawn = draws.length;
  const shownPeriods = periods.length;
  c.document.getElementById('period').hidden = false;

  d = await show('3M', true, daily);
  assert.equal(draws.length, drawn + 1, '켜기만 해도 다시 그린다');
  assert.deepEqual([d.mas.length, d.trends.length, d.crosses.length, d.hLines.length], [0, 0, 0, 0]);
  assert.equal(d.bands, null);
  assert.equal(d.volAvg, null);
  assert.equal(d.vwapLine, null);
  assert.equal(d.profile, false);
  assert.deepEqual([...d.closes], C.slice(-22), '가격은 그대로');
  assert.deepEqual([...d.volumes], V.slice(-22), '거래량 막대는 남는다');
  assert.deepEqual([...asked], ['005930.KS'], '지수 대비를 안 보이므로 지수 차트도 받지 않는다');
  assert.equal(elements.get('period').hidden, true, '기간 · 지수 대비 배지도 숨긴다');
  assert.equal(periods.length, shownPeriods);
  assert.deepEqual(badges.slice(-2), ['cross 0', 'trend 0'], '교차 · 추세 배지도 비운다');
  assert.equal(JSON.stringify(run('state.indicators')),
    '{"bb":true,"vwap":true,"volAvg":true,"prevHL":true,"vp":true,"rel":true,"sar":false}', '칩 설정은 지우지 않는다');
  assert.equal(JSON.stringify(run('state.maPeriods')), '[5]');

  d = await show('1D', true, oneDay);
  assert.equal(d.hLines.length, 0, '1D 의 평단 · 전일 · 전고 · 전저도 끈다');
  assert.equal(d.vwapLine, null);
  assert.equal(d.volAvg, null);
  d = await show('1D', false, oneDay);
  assert.deepEqual([...d.hLines.map((l) => l.label)], ['평단', '전일', '전고', '전저'], '다시 누르면 돌아온다');
  assert.ok(d.vwapLine && d.volAvg);
  d = await show('3M', false, daily);
  assert.ok(d.mas.length && d.bands && d.trends.length, '일봉 덧그림도 돌아온다');

  // 추세선만 있는 화면(이동평균 · 지표 · 평단 없음) — 다른 값이 그대로여도 다시 그려 추세선을 지운다
  run('state.maPeriods = []; state.indicators = cleanIndicators({}); state.holdings = {};');
  d = await show('3M', false, daily);
  assert.equal(d.trends.length, 2, '지지선 · 저항선');
  d = await show('3M', true, daily);
  assert.equal(d.trends.length, 0, '추세선만 있던 화면도 다시 그린다');
});

await test('plain chart: the switch beside the candle/line icon shows its state and hides with the chart', () => {
  const { c, run, elements } = harness(['renderChartMode']);
  c.MODE_ICON = { candle: 'C', line: 'L' };
  run("state.chartMode = 'line'; state.plainChart = false; renderChartMode(30, true);");
  const b = elements.get('plainChart');
  assert.equal(b.hidden, false);
  assert.equal(b.className, '');
  assert.equal(b.title, '차트만 보기 — 이동평균 · 보조 지표 · 기준선 끄기');
  run('state.plainChart = true; renderChartMode(30, true);');
  assert.equal(b.className, 'on');
  assert.equal(b.title, '덧그림 다시 보기');
  assert.match(source, /function clearChart\(\) \{[\s\S]*?getElementById\('plainChart'\)\.hidden = true;[\s\S]*?\n\}/, '차트를 지우면 같이 숨는다');
});

// 정규장 / 전체(장전 · 장후 포함) — 1D · 1W 는 정규장만 보기(state.extHours === false)가 아니면 시간외 봉까지
// 묻는다(main.js 가 미국은 야후 프리 · 애프터, 국내는 NXT 분봉을 붙인다). 두 응답은 캐시에서 따로 둔다.
await test('ext hours: 1D · 1W ask for pre/after-hours bars unless the regular-only view is on, and the cache keeps the two apart', async () => {
  const { c, run } = harness(['fetchChartCached']);
  const asked = [];
  c.api.fetchChart = async (a) => { asked.push(JSON.stringify(a)); return { ok: true, closes: [1], times: [1] }; };
  run('var chartCache = new Map(); var chartTtl = () => 60000; state.extHours = true;');
  const ask = (tf) => c.fetchChartCached('005930.KS', c.chartTf(tf));
  await ask('1W');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '5d', interval: '30m', extended: true }));
  run('state.extHours = false;');
  await ask('1W');
  assert.equal(asked.length, 2, '정규장만 보기는 다른 응답이다 — 받아 둔 전체를 꺼내지 않는다');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '5d', interval: '30m', extended: false }));
  await ask('1D');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '1d', interval: '5m', extended: false }));
  run('state.extHours = true;');
  await ask('1W');
  assert.equal(asked.length, 3, '전체로 돌아오면 받아 둔 것을 쓴다');
  await ask('1M');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '1mo', interval: '1d' }), '일봉은 시간외가 없다');
});

await test('ext hours: the 정규장/전체 switch shows only on 1D · 1W for stocks, names the view and hides with the chart', () => {
  const { c, run, elements } = harness(['renderChartMode']);
  c.MODE_ICON = { candle: 'C', line: 'L' };
  run(`state.watchlist = [{ symbol: '005930.KS', name: '삼성전자' }]; state.selected = '005930.KS';
    state.timeframe = '1W'; state.extHours = true; renderChartMode(0, false);`);
  const b = elements.get('extHours');
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, '전체');
  assert.equal(b.className, '');
  assert.equal(b.title, '전체(장전 · 장후 포함) — 누르면 정규장만');
  run('state.extHours = false; renderChartMode(0, false);');
  assert.equal(b.textContent, '정규장');
  assert.equal(b.className, 'on', '정규장만 보고 있으면 또렷하게 — 빠진 구간이 있다');
  assert.equal(b.title, '정규장만 — 누르면 장전 · 장후까지');
  run("state.timeframe = '1M'; renderChartMode(20, true);");
  assert.equal(b.hidden, true, '일봉은 정규장만 있다');
  run("state.timeframe = '1D'; state.selected = '^KS11'; renderChartMode(0, false);");
  assert.equal(b.hidden, true, '지수 · 환율은 시간외가 없다');
  run("state.selected = '005930.KS'; renderChartMode(0, false);");
  assert.equal(b.hidden, false);
  assert.match(source, /function clearChart\(\) \{[\s\S]*?getElementById\('extHours'\)\.hidden = true;[\s\S]*?\n\}/, '차트를 지우면 같이 숨는다');
});

await test('ext hours: the switch flips the view, saves it and redraws', async () => {
  const { c, run } = harness(['toggleExtHours']);
  const log = [];
  Object.assign(c, { save: () => log.push('save'), loadChart: async () => log.push(`load:${run('state.extHours')}`) });
  run('state.extHours = true;');
  await c.toggleExtHours();
  assert.deepEqual(log.splice(0), ['save', 'load:false']);
  await c.toggleExtHours();
  assert.deepEqual(log.splice(0), ['save', 'load:true']);
});

// NXT 에 없는 종목(DSC인베스트먼트 · ETF)은 정규장 · 전체 응답이 똑같다 — 서명이 같아 다시 그리지 않으면 버튼 글자
// (drawChart → renderChartMode)도 안 바뀌어 눌러도 안 되는 것처럼 보였다(2026-10-22). 캔들/선 · 차트만 보기처럼 서명에 넣는다.
await test('ext hours: switching redraws even when both views return the same bars, so the switch label follows', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const draws = [];
  const t0 = Date.parse('2026-10-22T00:00:00Z');
  const same = { ok: true, closes: [6700, 6620], times: [t0, t0 + 300000], volumes: [1, 1], opens: [6700, 6620], highs: [6700, 6620], lows: [6700, 6620] };
  Object.assign(c, {
    fetchChartCached: async () => same, err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {},
    renderCrossBadge: () => {}, renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run("let lastDrawSig = null; state.timeframe = '1W'; state.indicators = cleanIndicators({}); state.extHours = true;");
  await c.loadChart();
  run('state.extHours = false;');
  await c.loadChart();
  assert.equal(draws.length, 2, '정규장으로 바꾸면 다시 그린다(버튼 글자가 따라온다)');
  await c.loadChart();
  assert.equal(draws.length, 2, '같은 보기의 30초 갱신은 그대로 둔다');
});

await test('ext hours: loadChart asks with the view the switch picked', async () => {
  const { c, run } = harness(['loadChart']);
  const asked = [];
  Object.assign(c, {
    fetchChartCached: async (_s, tf) => { asked.push(tf.extended); return { ok: false, error: 'x' }; },
    err: () => {}, clearChart: () => {},
  });
  run("state.timeframe = '1W'; state.extHours = false;");
  await c.loadChart();
  run('state.extHours = true;');
  await c.loadChart();
  assert.deepEqual(asked, [false, true]);
});

// 기간 배지는 첫 정규장 봉부터 — 1W 전체의 첫 봉은 그날 프리라 그대로 쓰면 정규장 / 전체에 따라 값이 달라진다
await test('ext hours: the period badge starts at the first regular bar, so 정규장 and 전체 show the same return', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const periods = [];
  const t0 = Date.parse('2026-10-14T23:00:00Z'); // 10/15 08:00 KST
  const times = [t0, t0 + 3600000, t0 + 7200000];
  Object.assign(c, {
    fetchChartCached: async () => ({ ok: true, closes: [90, 100, 110], times, volumes: [1, 1, 1],
      opens: [90, 100, 110], highs: [90, 100, 110], lows: [90, 100, 110], ext: ['pre', null, null] }),
    benchReturn: (_b, _g, since) => { periods.push(['since', since]); return null; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (...a) => periods.push(a), renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: () => {},
  });
  run(`let lastDrawSig = null; state.timeframe = '1W'; state.indicators = cleanIndicators({});
    quotes['005930.KS'] = { price: 120, prevClose: 110, change: 10 };`);
  await c.loadChart();
  assert.deepEqual(periods.find((p) => p[0] === 'since'), ['since', times[1]], '지수 대비도 같은 봉부터');
  assert.equal(periods.find((p) => p[0] !== 'since')[0], 100, '프리 봉(90)이 아니라 첫 정규장 봉(100)부터');
});

// 네트워크가 느리면 차트 응답까지 몇 초가 걸린다. 그동안 탭 · 헤더는 새 종목 · 기간인데 차트 · 기간 배지는
// 옛 것이라 "눌러도 데이터가 안 바뀐다"로 보였다(2026-10-15). 다른 화면으로 넘어가면 옛 차트를 먼저 지우고
// 불러오는 중을 띄운다. 같은 화면의 30초 갱신은 지우지 않는다(깜빡이지 않게).
// 같은 종목 · 기간의 갱신이 한 번 실패(야후 429 · 시간 초과)하면 그리던 차트를 두고 오류만 적는다 — 지우면 다음 갱신
// (장 마감 뒤 5분)까지 빈칸이었다. 다른 화면으로 넘어간 뒤의 실패와 장 시작 직후의 빈 응답은 지운다.
await test('slow network: a failed refresh of the same chart keeps it with the error; another screen or an empty reply clears it', async () => {
  const { c, run } = harness(['loadChart']);
  let reply;
  let cleared = 0;
  const errs = [];
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => Date.parse(`2026-09-0${i + 1}T00:00:00Z`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  Object.assign(c, {
    fetchChartCached: async () => reply, err: (m) => errs.push(m), quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: () => {},
    clearChart: () => { cleared++; run('drawnKey = null;'); }, intradayWaitText: () => 'WAIT',
  });
  run("let lastDrawSig = null; state.timeframe = '1M';");
  reply = series([1, 2]);
  await c.loadChart();
  reply = { ok: false, error: 'HTTP 429' };
  await c.loadChart();
  assert.equal(cleared, 0, '같은 화면의 갱신 실패는 차트를 둔다');
  assert.match(errs.at(-1), /차트: HTTP 429$/, '오류는 적는다');

  run("state.timeframe = '3M';");
  await c.loadChart();
  assert.ok(cleared >= 1, '다른 기간으로 넘어간 뒤의 실패는 지운다');

  run("state.timeframe = '1D'; lastDrawSig = null;");
  reply = series([1, 2]);
  await c.loadChart();
  const before = cleared;
  reply = { ok: false, error: '빈 데이터' };
  await c.loadChart();
  assert.equal(cleared, before + 1, '빈 응답(장 시작 직후 1D)은 지운다');
  assert.equal(errs.at(-1), 'WAIT');
});

await test('slow network: switching symbol or period clears the old chart and shows loading until the new one arrives', async () => {
  const { c, run, elements } = harness(['loadChart']);
  const draws = [];
  let cleared = 0;
  let pending = null;
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => Date.parse(`2026-09-0${i + 1}T00:00:00Z`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  Object.assign(c, {
    fetchChartCached: () => new Promise((resolve) => { pending = resolve; }),
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: (d) => draws.push(d),
    clearChart: () => { cleared++; },
  });
  run("let lastDrawSig = null; state.timeframe = '1M';");
  const box = () => elements.get('chartBox').className;
  const settle = () => new Promise((r) => setImmediate(r));

  let load = c.loadChart();
  assert.equal(box(), 'chartbox loading', '처음 그릴 때도 불러오는 중');
  assert.equal(cleared, 0, '지울 차트가 없다');
  pending(series([1, 2]));
  await load;
  assert.equal(draws.length, 1);
  assert.equal(box(), 'chartbox');

  // 같은 화면의 갱신 — 응답을 기다리는 동안에도 차트를 그대로 둔다
  load = c.loadChart();
  await settle();
  assert.equal(cleared, 0, '같은 종목 · 기간이면 지우지 않는다');
  assert.equal(box(), 'chartbox');
  pending(series([1, 3]));
  await load;
  assert.equal(draws.length, 2);

  // 기간을 바꾸면 응답 전에 옛 차트를 지운다
  c.document.getElementById('period').hidden = false;
  run("state.timeframe = '3M';");
  load = c.loadChart();
  await settle();
  assert.equal(cleared, 1, '다른 기간으로 넘어가면 바로 지운다');
  assert.equal(elements.get('period').hidden, true, '옛 기간 배지도 숨긴다');
  assert.equal(box(), 'chartbox loading');
  pending(series([5, 6, 7]));
  await load;
  assert.equal(draws.at(-1).closes.length, 3);
  assert.equal(box(), 'chartbox', '그리면 불러오는 중을 내린다');

  // 종목을 바꿔도 같다. 응답이 늦게 와 버려지는(더 새 요청이 있는) 동안은 불러오는 중을 그대로 둔다
  run("state.selected = '000660.KS';");
  load = c.loadChart();
  await settle();
  assert.equal(cleared, 2, '다른 종목으로 넘어가면 바로 지운다');
  const first = pending;
  run("state.timeframe = '1Y';");
  const load2 = c.loadChart();
  await settle();
  first(series([9, 9]));
  await load;
  assert.equal(box(), 'chartbox loading', '버려진 응답은 불러오는 중을 내리지 않는다');
  assert.equal(draws.length, 3);
  pending({ ok: false, error: '응답 시간 초과' });
  await load2;
  assert.equal(box(), 'chartbox', '실패해도 내린다(오류 문구가 대신 뜬다)');
});

// 지수 비교선(보조 지표 '지수 대비'): 같은 기간 지수를 차트 첫 봉의 종목 가격에서 시작하게 맞춘 선. 배지의 숫자로는
// 언제 벌어졌는지 보이지 않는다. 지수 차트는 배지 때문에 이미 받는다(새 요청 없음).
await test('indicators: index comparison line starts at the stock\'s first price, follows the index by date, ends at the live index', () => {
  const { c, run } = harness(['benchLine', 'alignByDay']);
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const times = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].map(day);
  const closes = [100, 104, 103, 110];
  // 지수에는 9/3 이 없다(휴장 차이) → 그 칸은 비운다. 9/4 는 실시간 지수 2,200 으로
  c.G = { ok: true, times: ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-04'].map(day), closes: [1900, 2000, 2100, 2150] };
  run("quotes['^KS11'] = { price: 2200 };");
  const r = run(`benchLine({ symbol: '^KS11', name: '코스피' }, G, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`);
  assert.equal(r.name, '코스피');
  assert.equal(JSON.stringify(r.data), JSON.stringify([100, 105, null, 110]), '100 × 2100/2000 = 105, 마지막은 실시간 2200/2000');
  // 첫 봉에 지수가 없으면 둘 다 있는 첫 날을 기준으로
  c.G = { ok: true, times: ['2026-09-02', '2026-09-03', '2026-09-04'].map(day), closes: [2000, 2050, 2100] };
  run("delete quotes['^KS11'];");
  const late = run(`benchLine({ symbol: '^KS11', name: '코스피' }, G, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`);
  assert.equal(JSON.stringify(late.data), JSON.stringify([null, 104, 106.6, 109.2]), '9/2 의 104 에서 시작');
  assert.equal(run(`benchLine(null, G, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`), null, '지수 대비가 꺼져 있으면 없다');
  assert.equal(run(`benchLine({ symbol: '^KS11', name: '코스피' }, { ok: false }, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`), null, '지수를 못 받았으면 없다');
});

await test('indicators: loadChart passes the comparison line with the index chart it already fetched, and redraws when only the index moves', async () => {
  const { c, run } = harness(['loadChart', 'benchLine', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange', 'benchReturn', 'benchmarkOf']);
  const draws = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => day(`2026-09-0${i + 1}`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  Object.assign(c, {
    fetchChartCached: async (s) => (s === '^KS11' ? series([2000, 2100]) : series([100, 110])),
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run("let lastDrawSig = null; state.timeframe = '1M'; state.indicators = cleanIndicators({ rel: true }); quotes['005930.KS'] = { price: 110, prevClose: 100, change: 10 };");
  await c.loadChart();
  assert.equal(JSON.stringify(draws.at(-1).benchLine), JSON.stringify({ name: '코스피', data: [100, 105] }));
  run("quotes['^KS11'] = { price: 2300 };");
  await c.loadChart();
  assert.equal(draws.length, 2, '종목은 그대로여도 지수가 움직이면 다시 그린다');
  assert.equal(draws.at(-1).benchLine.data[1], 115);
  run("state.indicators = cleanIndicators({}); lastDrawSig = null;");
  await c.loadChart();
  assert.equal(draws.at(-1).benchLine, null, '끄면 없다');
  run("state.indicators = cleanIndicators({ rel: true }); state.plainChart = true; lastDrawSig = null;");
  await c.loadChart();
  assert.equal(draws.at(-1).benchLine, null, '차트만 보기면 없다');
});

// 지수 대비는 일봉(1M 이상)만 — 날짜로 짝짓기라 1W(30분봉)는 지수 기준이 첫날 마지막 봉, 종목 기준이 첫 봉이 되고
// 비교선은 그날 종가가 그날 모든 봉에 들어가 계단이 됐다(종목 · 지수 모두 +10% 인데 초과 +5.24%p).
await test('indicators: the index comparison is off on 1W — 30-minute bars cannot be matched to the index by date', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const asked = [];
  const draws = [];
  const periods = [];
  const t0 = Date.parse('2026-10-15T00:00:00Z');
  const series = { ok: true, closes: [100, 110], times: [t0, t0 + 1800000], volumes: [1, 1], opens: [100, 110], highs: [100, 110], lows: [100, 110] };
  Object.assign(c, {
    fetchChartCached: async (s) => { asked.push(s); return series; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (...a) => periods.push(a), renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run(`let lastDrawSig = null; state.timeframe = '1W'; state.indicators = cleanIndicators({ rel: true });
    quotes['005930.KS'] = { price: 110, prevClose: 100, change: 10 };`);
  await c.loadChart();
  assert.deepEqual([...asked], ['005930.KS'], '지수 차트를 받지 않는다');
  assert.equal(draws.at(-1).benchLine, null, '비교선 없음');
  assert.equal(periods.at(-1)[2], null, '초과 배지 없음');
});

await test('indicators: the comparison line is a dashed line on the price axis with its own legend entry', () => {
  const { c, run, elements } = harness(['drawChart', 'labelFor', 'renderMaLegend']);
  run(formatting);
  const configs = [];
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, bindChartLeave() {}, maColor: () => '#000', hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  c.document.createElement = () => node();
  c.document.getElementById('maLegend').appendChild = (s) => items.push(s);
  run(`lastProfile = null; state.timeframe = '1M';
    var arg_ = { closes: [100, 110], times: [1, 2], up: true, cur: 'KRW', volumes: [1, 1], highs: [100, 110], lows: [100, 110],
      benchLine: { name: '코스피', data: [100, 105] } };
    drawChart(arg_);`);
  const line = configs.at(-1).data.datasets.find((d) => d.borderColor === '--bench-line');
  assert.ok(line, '지수 선');
  assert.equal(line.yAxisID, 'y');
  assert.ok(line.borderDash && line.borderDash.length === 2, '점선');
  assert.equal(line.spanGaps, true, '지수에 없는 날은 건너 잇는다');
  assert.equal(JSON.stringify(line.data), '[100,105]');
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  assert.equal(elements.get('maLegend').hidden, false);
  assert.deepEqual([...read()], ['코스피=105'], '마우스를 안 올리면 마지막 값');
  assert.match(items[0].title, /코스피 — 차트 첫 봉의 종목 가격에서 시작하게 맞춘 지수/);
  items.length = 0;
  run('hoverIdx = 0; renderMaLegend();');
  assert.deepEqual([...read()], ['코스피=100']);
});

// 툴팁 가격 옆 등락률의 기준. 1D 는 전일 종가(차트의 '전일' 선), 1W(30분봉)는 그 봉 날짜의 앞 거래일 종가(일봉) —
// 바로 앞 30분봉과 견주면 잡음이다. 일봉은 앞 봉 종가(그날 등락률), 첫 봉은 일봉에서 그 앞 거래일 종가. 월봉(전체)의
// 첫 봉은 기준이 없다. 빈 종가(null)는 건너뛴다.
await test('tooltip: change is measured from the previous close — 1D prev close, 1W that day\'s previous daily close, daily bars the bar before', () => {
  const { run } = harness([]);
  const day = (d, h = 0) => Date.parse(`2026-10-${d}T${String(h).padStart(2, '0')}:00:00Z`);
  run(`quotes['005930.KS'] = { prevClose: 100,
    daily: { times: [${day(12)}, ${day(13)}, ${day(14)}, ${day(15)}], closes: [90, null, 95, 99] } };`);
  const bases = (tf, times, closes) => JSON.parse(run(`state.timeframe = '${tf}';
    JSON.stringify(tipBases('005930.KS', ${JSON.stringify(times)}, ${JSON.stringify(closes)}))`));
  assert.deepEqual(bases('1D', [day(16, 1), day(16, 2)], [101, 102]), [100, 100], '1D 는 전일 종가');
  assert.deepEqual(bases('1W', [day(13, 1), day(13, 5), day(14, 1), day(15, 1), day(16, 1)], [1, 2, 3, 4, 5]), [90, 90, 90, 95, 99],
    '1W 는 그날 앞 거래일의 일봉 종가(빈 날은 건너뜀)');
  // 국내 NXT 프리(10/15 08:00 KST)는 UTC 로 전날 23시다 — 한국 날짜로 세야 10/14 종가 기준
  assert.deepEqual(bases('1W', [Date.parse('2026-10-15T08:00:00+09:00'), day(15, 1)], [1, 2]), [95, 95], '국내 1W 프리 봉');
  // 미국 겨울(EST) 애프터 19:30 ET 는 UTC 로 다음 날 — 그날(11/17)의 앞 거래일(11/16) 종가 기준
  run(`state.timeframe = '1W'; quotes.SOXL = { daily: { times: [${Date.parse('2026-11-16T14:30:00Z')}, ${Date.parse('2026-11-17T14:30:00Z')}],
    closes: [200, 210] } };`);
  assert.equal(JSON.stringify(run(`tipBases('SOXL', [${Date.parse('2026-11-17T15:00:00Z')}, ${Date.parse('2026-11-18T00:30:00Z')}], [1, 2])`)),
    '[200,200]', '미국 1W 겨울 애프터 끝 봉');
  assert.deepEqual(bases('1M', [day(14), day(15), day(16)], [95, null, 101]), [90, 95, 95], '일봉은 앞 봉, 첫 봉은 일봉에서');
  assert.deepEqual(bases('전체', [day(14), day(15)], [95, 101]), [null, 95], '월봉의 첫 봉은 기준 없음');
  run("quotes['005930.KS'] = { price: 101 };");
  assert.deepEqual(bases('1D', [day(16, 1)], [101]), [null], '전일 종가가 없으면 없음');
  assert.deepEqual(bases('1M', [day(14), day(15)], [95, 101]), [null, 95], '일봉이 없으면 첫 봉은 없음');
});

await test('tooltip: the price line carries its change in the up/down colour, with open · range · volume below it', () => {
  const { c, run } = harness(['drawChart', 'labelFor', 'plColor']);
  run(helpers());
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {}, hexA: () => 'x', cssVar: (n) => n,
  });
  run(`lastProfile = null; state.timeframe = '1M';
    var arg_ = { closes: [100, 110, 99, 99], times: [1, 2, 3, 4], up: true, cur: 'KRW', volumes: [5, 6, 7, 8],
      opens: [100, 105, 108, 99], highs: [101, 112, 109, 99], lows: [99, 104, 98, 99], tipBases: [null, 100, 110, 99] };
    drawChart(arg_);`);
  const cb = configs.at(-1).options.plugins.tooltip.callbacks;
  const item = (datasetIndex, dataIndex, y, dataset = {}) => ({ datasetIndex, dataIndex, parsed: { y }, dataset });
  assert.equal(cb.label(item(0, 1, 110)), '110 +10.00%');
  assert.equal(cb.labelTextColor(item(0, 1, 110)), run('UP'), '오르면 빨강');
  assert.equal(cb.label(item(0, 2, 99)), '99 -10.00%');
  assert.equal(cb.labelTextColor(item(0, 2, 99)), run('DOWN'), '내리면 파랑');
  assert.equal(cb.label(item(0, 3, 99)), '99 0.00%');
  assert.equal(cb.labelTextColor(item(0, 3, 99)), '--flat', '보합');
  assert.equal(cb.label(item(0, 0, 100)), '100', '기준이 없으면 가격만');
  assert.equal(cb.labelTextColor(item(0, 0, 100)), '--text');
  assert.deepEqual([...cb.label(item(2, 1, 6, { isVolume: true }))], [], '가격 말고는 본문 줄을 만들지 않는다');
  assert.equal(cb.beforeBody, undefined, '가격 줄이 맨 위 — 나머지는 그 아래(footer)');
  const tip = configs.at(-1).options.plugins.tooltip;
  assert.equal(tip.footerColor, '--text', 'footer 는 제 색 — 가격 줄의 등락 색을 물려받지 않는다');
  assert.equal(tip.footerFont.weight, 'normal', '본문처럼 굵지 않게');
  const lines = [...cb.footer([item(0, 1, 110), item(2, 1, 6, { isVolume: true })])];
  assert.deepEqual(lines.filter((l) => !l.startsWith('시 ')), ['고저 104 ~ 112', '거래량 6']);
  assert.ok(lines.every((l) => l === '시 105' || !l.startsWith('시 ')), lines.join(' / '));
  run('arg_.tipBases = undefined; drawChart(arg_);');
  assert.equal(configs.at(-1).options.plugins.tooltip.callbacks.label(item(0, 1, 110)), '110', '기준을 넘기지 않으면 가격만');
});

await test('tooltip: loadChart hands drawChart the base for every bar', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const draws = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  Object.assign(c, {
    fetchChartCached: async () => ({ ok: true, closes: [100, 110], times: [day('2026-09-01'), day('2026-09-02')],
      volumes: [1, 1], opens: [100, 110], highs: [100, 110], lows: [100, 110] }),
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run(`let lastDrawSig = null; state.timeframe = '1M'; state.indicators = cleanIndicators({});
    quotes['005930.KS'] = { price: 110, prevClose: 100, change: 10, daily: { times: [${day('2026-08-31')}], closes: [98] } };`);
  await c.loadChart();
  assert.equal(JSON.stringify(draws.at(-1).tipBases), '[98,100]');
});

// 매물대(보조 지표): drawChart 가 보이는 구간으로 계산해 플러그인에 넘긴다. 플러그인은 오른쪽 끝에서 왼쪽으로 그린다.
await test('indicators: volume profile is computed over the visible range and drawn from the right edge', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'x', cssVar: (n) => n,
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  run(`state.timeframe = '3M';
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_.map((v) => v + 1), lows: C_.map((v) => v - 1),
      profile: true };`);
  run('drawChart(arg_);');
  let p = configs.at(-1).options.plugins.profile.profile;
  assert.equal(p.lo, 99);
  assert.equal(p.hi, 130);
  assert.equal(p.vols.length, 20);
  run('zoom = { start: T_[10], end: T_[19] }; drawChart(arg_);');
  p = configs.at(-1).options.plugins.profile.profile;
  assert.equal(p.lo, 109, '확대하면 그 구간의 매물대');
  assert.equal(p.hi, 120);
  run('zoom = null; arg_.profile = false; drawChart(arg_);');
  assert.equal(configs.at(-1).options.plugins.profile.profile, null, '끄면 넘기지 않는다');
});

await test('indicators: profile plugin bars grow leftward from the right edge, the busiest price darker', () => {
  const { c, run } = harness();
  run(source.slice(mark('const VP_MAX_WIDTH'), mark('// 교차 지점 표식')));
  const plugin = run('profilePlugin');
  const rects = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, set fillStyle(v) { this.fs = v; },
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fs: this.fs }); } };
  c.cssVar = (n) => n;
  const chartStub = { ctx, chartArea: { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 },
    scales: { y: { getPixelForValue: (v) => 100 - v } } };
  plugin.beforeDatasetsDraw(chartStub, {}, { profile: { lo: 0, step: 10, poc: 1, vols: [5, 10, 0, 2.5] } });
  assert.equal(rects.length, 3, '빈 칸은 그리지 않는다');
  assert.deepEqual(rects.map((r) => r.w), [30, 60, 15], '가장 긴 막대가 차트 폭의 30%');
  assert.ok(rects.every((r) => r.x + r.w === 200), '오른쪽 끝에 붙는다');
  assert.deepEqual(rects.map((r) => r.fs), ['--vp-bar', '--vp-poc', '--vp-bar']);
  assert.equal(rects[1].y, 80.5, '칸의 위쪽(가격 20)이 y 80, 1px 틈');
  assert.equal(rects[1].h, 9);
  rects.length = 0;
  plugin.beforeDatasetsDraw(chartStub, {}, { profile: null });
  assert.equal(rects.length, 0);
});

// 가로선(평단 · 전일 · 전고 · 전저 · 프리 · 애프터): 가까운 이름표는 합치고, 범위 밖은 가장자리에 이름 · 값.
await test('horizontal lines: close labels merge instead of vanishing; out-of-range lines go to the edge with their value', () => {
  const { c, run } = harness(['hLineGroups']);
  run(formatting);
  run(source.slice(mark('const HLINE_GAP'), mark('function hLineGroups')));
  run(source.slice(mark('const hLinePlugin = {'), mark('// 마우스를 올린 시점을 세로선으로')));
  const plugin = run('hLinePlugin');
  const strokes = [];
  const texts = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {}, setLineDash() {},
    moveTo(_x, y) { this.at = y; }, lineTo() { strokes.push({ y: this.at, color: this.strokeStyle }); },
    fillText(t, x, y) { texts.push({ t, x, y, color: this.fillStyle }); } };
  c.cssVar = (n) => n;
  // 가격 v 는 y = 200 - v (값이 클수록 위). 차트 안은 y 0~100 → 가격 100~200.
  const chartStub = { ctx, chartArea: { left: 0, right: 300, top: 0, bottom: 100 },
    scales: { y: { getPixelForValue: (v) => 200 - v } } };
  plugin.afterDatasetsDraw(chartStub, {}, { cur: 'KRW', lines: [
    { value: 150, label: '전일', varName: '--prev-line' },
    { value: 145, label: '전고', varName: '--prevhi-line' }, // 5px 아래 — 예전에는 이름표가 빠졌다
    { value: 120, label: '평단', varName: '--avg-line' },
    { value: 230, label: '전고2', varName: '--prevhi-line' }, // 범위 위
    { value: 210, label: '애프터', varName: '--over-line' }, // 범위 위, 더 가깝다
    { value: 60, label: '전저', varName: '--prevlo-line' }, // 범위 아래
  ] });
  assert.deepEqual(strokes.map((s) => s.y), [50, 55, 80], '선은 범위 안의 것만 긋는다');
  assert.deepEqual(strokes.map((s) => s.color), ['--prev-line', '--prevhi-line', '--avg-line']);
  const byText = Object.fromEntries(texts.map((t) => [t.t, t]));
  assert.ok(byText['전일·전고'], `가까운 이름표는 하나로: ${texts.map((t) => t.t).join(' | ')}`);
  assert.equal(byText['전일·전고'].y, 49, '맨 위 선 바로 위에');
  assert.ok(byText['평단']);
  assert.ok(byText['▲ 애프터 210 · 전고2 230'], '범위 위는 위 가장자리에 가까운 것부터, 값과 함께');
  assert.equal(byText['▲ 애프터 210 · 전고2 230'].color, '--over-line', '가장 가까운 선의 색');
  assert.ok(byText['▼ 전저 60'], '범위 아래는 아래 가장자리에');
  assert.equal(byText['▼ 전저 60'].y, 99);
  assert.equal(texts.length, 4, '이름표가 빠지지 않는다');

  // 이름표는 묶음의 첫 선 자리에 그리므로 그 자리에서 10px 이상 떨어진 선은 따로 쓴다(포개지지 않는다)
  assert.deepEqual([...run(`hLineGroups([{ y: 50, text: 'a' }, { y: 58, text: 'b' }, { y: 66, text: 'c' }])`)
    .map((g) => `${g.text}@${g.y}`)], ['a·b@50', 'c@66']);

  // 안쪽 맨 위 선의 이름표와 위 가장자리 표시가 포개질 자리면 그것도 합친다
  texts.length = 0;
  plugin.afterDatasetsDraw(chartStub, {}, { cur: 'KRW', lines: [
    { value: 195, label: '전일', varName: '--prev-line' }, { value: 230, label: '전고', varName: '--prevhi-line' }] });
  assert.deepEqual(texts.map((t) => t.t), ['전일·▲ 전고 230'], '범위 안의 선 이름이 앞, 가장자리 표시가 뒤');

  // 맨 위 경계에 붙은 선(삼성전자 10/15 전저 230,000)의 이름표를 선 위에 그리면 차트 밖으로 나가 잘렸다 —
  // 선 아래에 그리고, 위 가장자리 표시와 가까우면 합친다. 어떤 글자도(높이 9px) 차트 영역 밖으로 나가지 않는다.
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [{}] } }, {}, { cur: 'KRW', lines: [
    { value: 200, label: '전저', varName: '--prevlo-line' }, // y = 0, 맨 위 경계
    { value: 232, label: '전일', varName: '--prev-line' }, { value: 241, label: '전고', varName: '--prevhi-line' }] });
  assert.ok(texts.every((t) => t.y - 9 >= 0 && t.y <= 100), `글자가 차트 안에: ${texts.map((t) => `${t.t}@${t.y}`).join(' | ')}`);
  assert.deepEqual(texts.filter((t) => t.x === 2).map((t) => t.t), ['전저·▲ 전일 232 · 전고 241']);
  assert.equal(texts.find((t) => t.x === 2).color, '--prevlo-line', '색은 범위 안의 선(전저) 것');
  assert.deepEqual(texts.filter((t) => t.x === 298).map((t) => t.t), ['200'], '마우스를 올리면 그 값도 같은 줄 오른쪽에');

  // 마우스를 올린 동안(툴팁 · 십자선이 잡은 봉이 있는 동안)은 값도 — 이평선 범례처럼. 값은 오른쪽 끝
  // (y축 옆)에 따로 적는다: 왼쪽 이름표에 붙이면 커서 왼쪽에 뜨는 툴팁이 그 값을 가렸다.
  const hoverLines = [{ value: 150, label: '전일', varName: '--prev-line' }, { value: 145, label: '전고', varName: '--prevhi-line' },
    { value: 120, label: '평단', varName: '--avg-line' }, { value: 60, label: '전저', varName: '--prevlo-line' }];
  const left = () => texts.filter((t) => t.x === 2).map((t) => t.t).sort();
  const right = () => texts.filter((t) => t.x === 298).map((t) => `${t.t}@${t.y}`).sort();
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [{}] } }, {}, { cur: 'KRW', lines: hoverLines });
  assert.deepEqual(left(), ['▼ 전저 60', '전일·전고', '평단'].sort(), '이름표는 그대로 왼쪽');
  assert.deepEqual(right(), ['150 · 145@49', '120@79'].sort(), '값은 같은 높이의 오른쪽 끝에, 묶음은 묶음대로');
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [] } }, {}, { cur: 'KRW', lines: hoverLines });
  assert.deepEqual(left(), ['▼ 전저 60', '전일·전고', '평단'].sort());
  assert.deepEqual(right(), [], '마우스가 나가면 이름만');
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [{}] } }, {}, { cur: 'USD',
    lines: [{ value: 127.57, label: '전일', varName: '--prev-line' }] });
  assert.deepEqual(texts.filter((t) => t.x === 298).map((t) => t.t), ['127.57'], '값은 그 종목 통화 형식');
});

// 야후 국내 시세는 20분 지연이라 일봉 타임프레임의 마지막 봉이 화면의 다른
// 값들보다 뒤처진다. 상세 캔들은 네이버 실시간이므로, 맞춰주지 않으면 한 화면이
// 서로 다른 순간을 가리킨다. 지나간 봉은 건드리면 안 된다.
await test('daily chart syncs the last bar to the live candle, older bars untouched', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const today = Date.parse('2026-09-10T00:00:00Z'); // 09:00 KST, NOW 와 같은 날
  const bars = { ok: true, closes: [98, 100], times: [today - 86400000, today],
    volumes: [10, 20], opens: [97, 99], highs: [99, 101], lows: [96, 97] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    renderTrendBadges: () => {}, TREND_TF: new Set(), curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  run(`state.timeframe = '3M';
    quotes['005930.KS'] = { price: 105, live: true, session: 'regular', priceSession: 'regular',
      candle: { open: 101, high: 106, low: 95 } };`);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 105], 'last close becomes the live price');
  assert.deepEqual(draws.at(-1).highs, [99, 106], 'last high becomes the live high');
  assert.deepEqual(draws.at(-1).lows, [96, 95], 'last low becomes the live low');
  assert.deepEqual(draws.at(-1).opens, [97, 101], 'opens reach drawChart, last one synced');

  // Toggling chartMode alone must still redraw — nothing else about the
  // fetched bars or quote changed, so the signature has to notice the mode.
  const drawsBeforeToggle = draws.length;
  run("state.chartMode = 'line';");
  await c.loadChart();
  assert.equal(draws.length, drawsBeforeToggle + 1, 'chartMode toggle redraws even with an otherwise identical signature');

  // 마지막 봉이 오늘이 아니면(장 전 · 휴장) 그대로 둔다.
  bars.times = [today - 2 * 86400000, today - 86400000];
  run('lastDrawSig = null;');
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100], 'yesterday bar keeps its own close');
  assert.deepEqual(draws.at(-1).highs, [99, 101]);
  assert.deepEqual(draws.at(-1).lows, [96, 97]);

  // 분봉(1D)의 마지막 봉은 하루가 아니라 5분이라 대상이 아니다.
  bars.times = [today - 86400000, today];
  run("state.timeframe = '1D'; lastDrawSig = null;");
  await c.loadChart();
  assert.deepEqual(draws.at(-1).highs, [99, 101], '1D bars are not day candles');
});

// 직전 판정 가격(alertBase)을 prev 로 두고 한 번 판정한다.
const checkFrom = (c, run, prev) => {
  run(`for (const k in alertBase) delete alertBase[k]; Object.assign(alertBase, ${JSON.stringify(prev)});`);
  c.checkAlerts();
};

await test('alerts use per-symbol trading state; legacy price-only alerts remain compatible', () => {
  const { c, run, notifications } = harness(['checkAlerts']);
  run(formatting);
  run(`state.alerts.targets = {'005930.KS':{up:100},'000660.KS':{up:100}};
    quotes['000660.KS'] = {price:101,session:'after',isTrading:true};`);
  const prev = {'005930.KS':99,'000660.KS':99};
  for (const meta of ["session:'closed',isTrading:false", "session:'unknown',isTrading:null",
    "session:'regular',isTrading:null", "session:'closed'", "open:false"]) {
    run(`quotes['005930.KS'] = {price:101,${meta}};`);
    notifications.length = 0;
    checkFrom(c, run, prev);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /SK하이닉스/);
  }
  for (const meta of ['', ",session:'pre',open:false", ",session:'after',isTrading:true"]) {
    run(`quotes['005930.KS'] = {price:101${meta}};`);
    notifications.length = 0;
    checkFrom(c, run, prev);
    assert.equal(notifications.length, 2);
  }
  notifications.length = 0;
  run('marketOpen = false;');
  checkFrom(c, run, prev);
  assert.equal(notifications.length, 0, 'domestic stocks stay quiet while every domestic market is closed');
  run(`marketOpen = true; state.watchlist = [{symbol:'AAPL',name:'Apple'}];
    state.alerts.targets = {AAPL:{up:100}}; quotes.AAPL = {price:101,session:'unknown',isTrading:null};`);
  checkFrom(c, run, {AAPL:99});
  assert.equal(notifications.length, 1, 'domestic restrictions do not block foreign alerts');
});

await test('alert text shows the stock currency, not always 원', () => {
  const { c, run, notifications } = harness(['checkAlerts']);
  run(formatting);
  run(`state.watchlist = [{symbol:'005930.KS',name:'삼성전자'},{symbol:'AAPL',name:'Apple'}];
    state.alerts.targets = {'005930.KS':{up:300000}, AAPL:{down:180}};
    quotes['005930.KS'] = {price:301000,currency:'KRW'};
    quotes.AAPL = {price:179.5,currency:'USD'};`);
  checkFrom(c, run, {'005930.KS':299000, AAPL:182.25});
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((n) => n.body), [
    '301,000원 (목표 300,000원)',
    '179.50 USD (목표 180.00 USD)',
  ]);
});

// 갱신을 여러 번 돌리며 그때그때의 시세를 넣는다. 알림 판정은 refreshAll 안에서 일어난다.
function alertRun(watchlist, targets) {
  const h = harness(['refreshAll', 'checkAlerts']);
  h.run(formatting);
  let tick = {};
  Object.assign(h.c, {
    loadIndices: async () => [], fetchLive: async () => ({}),
    loadQuote: async (item) => {
      if (tick[item.symbol]) h.run(`quotes[${JSON.stringify(item.symbol)}] = ${JSON.stringify(tick[item.symbol])};`);
    },
    renderList() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {}, renderUpdated() {},
  });
  h.run(`state.watchlist = ${JSON.stringify(watchlist)}; state.alerts.targets = ${JSON.stringify(targets)};`);
  return { ...h, refresh: async (quotesNow) => { tick = quotesNow; await h.c.refreshAll(); } };
}
const krLive = (price) => ({ price, currency: 'KRW', live: true, session: 'regular', isTrading: true });
const krFallback = (price) => ({ price, currency: 'KRW', live: false, session: 'unknown', isTrading: null });

// 네이버가 한 번 실패하면 야후 지연가가 화면에 뜬다. 국내 종목은 그 가격으로 알림을 판정하지
// 않는데, 직전 화면 가격을 기준으로 쓰면 다음 갱신에서 그 지연가가 "직전 가격" 이 된다.
await test('a Naver fallback price in between neither repeats nor swallows a target-price alert', async () => {
  const sam = { symbol: '005930.KS', name: '삼성전자' };
  const a = alertRun([sam], { '005930.KS': { up: 100000 } });
  await a.refresh({ '005930.KS': krLive(99900) });
  await a.refresh({ '005930.KS': krLive(100500) });
  assert.equal(a.notifications.length, 1, '99,900 → 100,500 crosses once');
  await a.refresh({ '005930.KS': krFallback(99800) }); // 야후 20분 지연가
  await a.refresh({ '005930.KS': krLive(100600) });
  assert.equal(a.notifications.length, 1, 'the delayed 99,800 is not a new starting point — no second alert');

  const b = alertRun([sam], { '005930.KS': { up: 100000 } });
  await b.refresh({ '005930.KS': krLive(99900) });
  await b.refresh({ '005930.KS': krFallback(100200) });
  await b.refresh({ '005930.KS': krLive(100300) });
  assert.equal(b.notifications.length, 1, '99,900 → 100,300 between live prices crosses — the delayed 100,200 must not hide it');
});

// 알림이 꺼져 있거나 목표가가 없던 동안에도 기준 가격은 따라간다 — 켜거나 목표가를 넣은
// 직후의 갱신이 그 전에 이미 지나간 통과를 뒤늦게 알리면 안 된다.
await test('turning alerts on, or adding a target, does not report a crossing that happened before', async () => {
  const sam = { symbol: '005930.KS', name: '삼성전자' };
  const a = alertRun([sam], { '005930.KS': { up: 100000 } });
  await a.refresh({ '005930.KS': krLive(99900) }); // 켜진 채로 기준이 생긴다
  a.run('state.alerts.enabled = false;');
  await a.refresh({ '005930.KS': krLive(100500) }); // 꺼져 있는 동안 통과
  a.run('state.alerts.enabled = true;');
  await a.refresh({ '005930.KS': krLive(100600) });
  assert.equal(a.notifications.length, 0, 'enabled after the crossing — nothing to report');

  const b = alertRun([sam], { '005930.KS': { up: 100000 } });
  await b.refresh({ '005930.KS': krLive(99900) }); // 목표가가 있는 채로 기준이 생긴다
  b.run('state.alerts.targets = {};');
  await b.refresh({ '005930.KS': krLive(100500) }); // 목표가를 지운 동안 통과
  b.run("state.alerts.targets = { '005930.KS': { up: 100000 } };");
  await b.refresh({ '005930.KS': krLive(100600) });
  assert.equal(b.notifications.length, 0, 'target added above the price it already passed — no alert');
  await b.refresh({ '005930.KS': krLive(99000) });
  await b.refresh({ '005930.KS': krLive(100100) });
  assert.equal(b.notifications.length, 1, 'a real crossing afterwards still alerts');
});

// 국내 장(정규 · 시간외 · NXT 08:00~20:00)과 미국 정규장(한국 시간 밤)은 겹치지 않는다.
// 국내 종목이 모두 닫혔다고 알림 전체를 끄면 미국 종목 알림은 거의 울릴 수 없다.
await test('US target alerts still fire while every domestic stock is closed', async () => {
  const a = alertRun([{ symbol: '005930.KS', name: '삼성전자' }, { symbol: 'AAPL', name: 'Apple' }],
    { '005930.KS': { up: 300000 }, AAPL: { up: 250 } });
  const closed = (price) => ({ price, currency: 'KRW', live: true, session: 'closed', isTrading: false });
  const us = (price) => ({ price, currency: 'USD', live: false, session: 'unknown', isTrading: null });
  a.run('marketOpen = false;'); // 국내가 모두 닫힘 — pollingIsOpen 이 내는 값
  await a.refresh({ '005930.KS': closed(299000), AAPL: us(249) });
  await a.refresh({ '005930.KS': closed(301000), AAPL: us(251) });
  assert.deepEqual(a.notifications.map((n) => n.title), ['Apple 상한 도달'], 'Apple fires; the closed domestic stock does not');
});

await test('poll timeout always rearms, including first refresh failure', async () => {
  const { c, run, timers, errors } = harness(['pollTick']);
  c.refreshAll = async () => { throw new Error('refresh failed'); };
  run('marketOpen = false;');
  await c.pollTick();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30000);
  assert.equal(errors.length, 1);
  c.refreshAll = async () => { run('marketOpen = false;'); };
  await timers[0].fn();
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 300000);
  c.refreshAll = async () => { run('marketOpen = true;'); };
  await timers[1].fn();
  assert.equal(timers[2].delay, 30000);
});

await test('real refresh failure releases busy and pollTick schedules recovery', async () => {
  const { c, run, timers } = harness(['pollTick', 'refreshAll']);
  c.loadIndices = async () => { throw new Error('index IPC failure'); };
  run('marketOpen = false; isLive = true;');
  await c.pollTick();
  assert.equal(run('busy'), false);
  assert.equal(run('isLive'), false);
  assert.equal(run('marketOpen'), true);
  assert.equal(timers[0].delay, 30000);
});

await test('addSymbol: repeated clicks while the lookup is pending add the symbol once', async () => {
  const { c, run } = harness(['addSymbol']);
  run(source.match(/^const adding = .*$/m)[0]);
  let release;
  const gate = new Promise((r) => { release = r; });
  let fetches = 0;
  Object.assign(c, {
    hint() {}, save() {}, closeSearch() {}, renderList() {}, select: async () => {},
    fetchLive: async () => { fetches++; await gate; return {}; },
  });
  run(`var lookupFails = false;
    async function loadQuote(item) { quotes[item.symbol] = lookupFails ? { error: '없음' } : { price: 1 }; }`);
  const kakao = { symbol: '035720.KS', name: '카카오' };
  const clicks = [c.addSymbol(kakao), c.addSymbol(kakao), c.addSymbol(kakao)];
  release();
  await Promise.all(clicks);
  assert.equal(run(`state.watchlist.filter((i) => i.symbol === '035720.KS').length`), 1);
  assert.equal(fetches, 1);

  // 조회에 실패한 종목도 잠기지 않는다 — 다시 누르면 다시 조회한다
  const naver = { symbol: '035420.KS', name: 'NAVER' };
  run('lookupFails = true;');
  await c.addSymbol(naver);
  run('lookupFails = false;');
  await c.addSymbol(naver);
  assert.equal(run(`state.watchlist.filter((i) => i.symbol === '035420.KS').length`), 1);
});

await test('maFor keeps the in-progress bar when the chart was fetched a moment after the daily data', () => {
  const { c, run } = harness(['maFor']);
  const DAY = 86400000;
  const d0 = Date.parse('2026-09-21T00:00:00Z');
  // 장중 오늘 봉의 시각은 마지막 체결 시각이라 요청마다 초 단위로 다르다 (실측: 01:26:11 / 01:26:12)
  run(`quotes['005930.KS'] = { daily: { closes: [10, 20, 30, 40],
    times: [${d0}, ${d0 + DAY}, ${d0 + 2 * DAY}, ${d0 + 3 * DAY + 5171000}] } };`);
  assert.deepEqual([...c.maFor('005930.KS', [d0 + 2 * DAY, d0 + 3 * DAY + 5172000], 2)], [25, 35]);
  // 일봉에 없는 날은 여전히 비운다
  assert.equal(c.maFor('005930.KS', [d0 + 9 * DAY], 2), null);
});

await test('cleanMaStyles keeps only valid per-period color/width; maWidth falls back to defaults', () => {
  const { run } = harness();
  // 저장값은 믿지 않는다 — 모르는 기간 · 색 형식이 아닌 것 · 범위 밖 굵기 · 숫자가 아닌 굵기는 버린다
  assert.equal(run(`JSON.stringify(cleanMaStyles({
    5: { color: '#FF8800', width: 1.6 },
    20: { color: 'red', width: 9 },
    7: { color: '#123456' },
    60: { width: 0.4 },
    120: { width: '2' },
    240: null,
  }))`), JSON.stringify({ 5: { color: '#ff8800', width: 1.6 } }));
  assert.equal(run('JSON.stringify(cleanMaStyles(null))'), '{}');
  assert.equal(run('JSON.stringify(cleanMaStyles("x"))'), '{}');

  // 바꾼 굵기가 있으면 그 값, 없으면 기본(20 · 40 · 80 은 1.2px, 나머지 1px)
  run('state.maStyles = { 20: { width: 2.4 } };');
  assert.equal(run('maWidth(20)'), 2.4);
  assert.equal(run('maWidth(40)'), 1.2);
  assert.equal(run('maWidth(5)'), 1);
});

await test('zoom is remembered per timeframe and cleared for every timeframe when the symbol changes', () => {
  const { run } = harness(['setTimeframe', 'clearZooms']);
  run("state.timeframe = '3M'; zoom = { start: 1, end: 2 };");
  run("setTimeframe('1D');");
  assert.equal(run('zoom'), null, '1D has no zoom of its own');
  run("setTimeframe('1Y'); zoom = { start: 3, end: 4 };");
  run("setTimeframe('3M');");
  assert.equal(run('JSON.stringify(zoom)'), '{"start":1,"end":2}', '3M zoom comes back');
  run("setTimeframe('1Y');");
  assert.equal(run('JSON.stringify(zoom)'), '{"start":3,"end":4}', '1Y keeps its own zoom');
  run("setTimeframe('1Y');"); // 지금 기간을 다시 눌러도 그대로
  assert.equal(run('JSON.stringify(zoom)'), '{"start":3,"end":4}');

  run('clearZooms();');
  assert.equal(run('zoom'), null);
  run("setTimeframe('3M');");
  assert.equal(run('zoom'), null, 'another symbol forgets every timeframe');
});

await test('empty intraday chart says when Yahoo bars start (open + delay, KST) and how long until then', () => {
  const { c, run } = harness(['intradayEta', 'leftText', 'intradayWaitText']);
  const kst = (hhmm) => Date.parse(`2026-09-29T${hhmm}+09:00`);
  assert.deepEqual({ ...c.intradayEta(kst('09:13:00'), '0900', 20) }, { at: '09:20', minutes: 7 });
  assert.deepEqual({ ...c.intradayEta(kst('09:13:30'), '0900', 20) }, { at: '09:20', minutes: 7 });
  assert.deepEqual({ ...c.intradayEta(kst('09:13:00'), null, 20) }, { at: '09:20', minutes: 7 }); // no Naver value → 09:00
  assert.deepEqual({ ...c.intradayEta(kst('09:40:00'), '1000', 20) }, { at: '10:20', minutes: 40 }); // late-open day
  assert.equal(c.intradayEta(kst('09:25:00'), '0900', 20).minutes <= 0, true);

  assert.equal(c.leftText(7), '약 7분 뒤');
  assert.equal(c.leftText(60), '약 1시간 뒤');
  assert.equal(c.leftText(140), '약 2시간 20분 뒤');

  // the harness clock is 18:30 KST — past 09:20, so a domestic empty chart is "running late"
  run("state.timeframe = '1D';");
  assert.equal(c.intradayWaitText({ symbol: '005930.KS', name: '삼성전자' }, { openTime: '0900' }),
    '삼성전자 1D: 분봉이 늦어지고 있습니다 (보통 09:20쯤 들어옵니다 · 1M 이상은 정상)');
  assert.equal(c.intradayWaitText({ symbol: 'NVDA', name: '엔비디아' }, null),
    '엔비디아 1D: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)');
  // 야후 지수 분봉도 국내 종목처럼 20분 늦다(2026-10-02 실측) — 지수 시세에는 openTime 이 없어 09:00 기준
  assert.equal(c.intradayWaitText({ symbol: '^KS11', name: '코스피' }, {}),
    '코스피 1D: 분봉이 늦어지고 있습니다 (보통 09:20쯤 들어옵니다 · 1M 이상은 정상)');
  // 해외 지수 · 선물 · 금리 · 환율(지수 줄)은 한국 개장과 상관없다 — WTI 1D 가 비면 "09:20쯤" 이라고 했다(2026-10-27)
  for (const [symbol, name] of [['CL=F', 'WTI'], ['NQ=F', '나스닥 선물'], ['^TNX', '미국채 10년'], ['^IXIC', '나스닥'], ['KRW=X', '원/달러']]) {
    assert.equal(c.intradayWaitText({ symbol, name }, {}), `${name} 1D: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`, symbol);
  }
});

await test('indices: selectedItem finds a watchlist row or an index; indexLive matches the stock live shape', () => {
  const { run } = harness();
  assert.equal(run('selectedItem().name'), '삼성전자');
  run("state.selected = '^KS11';");
  assert.equal(run('selectedItem().name'), '코스피');
  assert.equal(run("isIndex('^KQ11')"), true);
  assert.equal(run("isIndex('005930.KS')"), false);
  run("state.selected = 'GONE';");
  assert.equal(run('selectedItem()'), null);

  const kosdaq = `{ code: 'KOSDAQ', name: '코스닥', value: 893.29, change: -1, pct: -0.11,
    open: 893.22, high: 903.88, low: 885.65, isOpen: false, tradedAt: '2026-10-02T15:37:00+09:00' }`;
  const closed = run(`indexLive(${kosdaq})`);
  assert.equal(closed.price, 893.29);
  assert.equal(Math.round(closed.prevClose * 100) / 100, 894.29);
  assert.equal(closed.change, -1);
  assert.equal(JSON.stringify(closed.candle), '{"open":893.22,"high":903.88,"low":885.65}');
  assert.equal(closed.session, 'closed');
  assert.equal(closed.priceSession, 'closed');
  assert.equal(closed.isTrading, false);
  assert.equal(closed.open, false);
  assert.equal(closed.source, 'Naver');
  assert.equal(closed.tradedAt, '2026-10-02T15:37:00+09:00');

  const open = run(`indexLive({ ...${kosdaq}, isOpen: true })`);
  assert.equal(open.session, 'regular');
  assert.equal(open.isTrading, true);
  assert.equal(open.open, true);

  // 시가가 없으면 오늘 캔들을 그리지 않는다
  assert.equal(run(`indexLive({ ...${kosdaq}, open: null }).candle`), null);
  // 전일 대비가 없으면 실시간 값이 없는 것으로 — 야후 값(20분지연)으로 넘어간다
  assert.equal(run(`indexLive({ ...${kosdaq}, change: null })`), undefined);
  assert.equal(run('indexLive(undefined)'), undefined);
});

await test('index numbers keep two decimals like the index line; stocks keep their format', () => {
  const { run } = harness();
  run(formatting);
  assert.equal(run("curOf('^KS11')"), 'pt');
  assert.equal(run("money(7003.74, curOf('^KS11'))"), '7,003.74');
  assert.equal(run("signedMoney(-1, curOf('^KQ11'))"), '-1.00');
  run("quotes['005930.KS'] = { currency: 'KRW' };");
  assert.equal(run("money(271500, curOf('005930.KS'))"), '271,500');
  run("quotes.AAPL = { currency: 'USD' };");
  assert.equal(run("curOf('AAPL')"), 'USD');
});

// 미국채 10년(지수 줄)은 금리라 소수 셋째 자리, 등락은 bp. 선물 · 유가는 다른 지수처럼 포인트(둘째 자리).
await test('the 10-year yield keeps three decimals and moves in bp; futures and oil stay in points', () => {
  const { run } = harness();
  run(formatting);
  assert.equal(run("curOf('^TNX')"), '%');
  assert.equal(run("money(4.97, curOf('^TNX'))"), '4.970');
  assert.equal(run('fmtBp(0.0167)'), '+1.7bp');
  assert.equal(run('fmtBp(-0.06)'), '-6.0bp');
  // 헤더는 현재가 - 전일 종가로 다시 세어 소수 잡음이 낀다 — 지수 줄(네이버 값 그대로)과 같은 글자여야 한다
  assert.equal(run('fmtBp(-0.0225)'), '-2.3bp');
  assert.equal(run('fmtBp(4.965 - (4.965 + 0.0225))'), '-2.3bp');
  assert.equal(run("curOf('NQ=F')"), 'pt');
  assert.equal(run("money(29122.75, curOf('NQ=F'))"), '29,122.75');
  assert.equal(run("curOf('CL=F')"), 'pt');
});

// 지수 줄: 코스피 · 코스닥 → 나스닥 · S&P 500 → 원/달러, 한 장씩. 다섯 개는 340px 한 줄에 들어가지 않는다.
await test('index line shows one page at a time, marks the selected index, and turns pages unless hovered or viewing one', () => {
  const { c, run, elements } = harness(['renderIndices', 'indexPages', 'tickIndices']);
  run(formatting);
  run(source.match(/^let indexItems = .*$/m)[0]);
  run(source.match(/^let indexPage = .*$/m)[0]);
  run(source.match(/^let indexHover = .*$/m)[0]);
  run(source.match(/^let indexManualFor = .*$/m)[0]);
  run(source.match(/^let indexFlipAt = .*$/m)[0]);
  run(source.match(/^const FOLIO_MS = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '005930.KS'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, pct: 0.46 },
    { code: 'KOSDAQ', name: '코스닥', value: 893.29, pct: -0.11 },
    { code: 'NASDAQ', name: '나스닥', value: 26692.87, pct: -1.88 },
    { code: 'SPX', name: 'S&P 500', value: 6600.1, pct: -1.2 },
    { code: 'USDKRW', name: '원/달러', value: 1351.4, pct: 0.63 },
    { code: 'KPI200', name: '코스피200', value: 950, pct: 0 }];`);
  c.renderIndices();
  const box = elements.get('indices');
  const shown = () => [...box.innerHTML.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]).join(' ');
  assert.equal(box.hidden, false);
  assert.equal(shown(), '^KS11 ^KQ11', '첫 장은 국내');
  assert.match(box.innerHTML, /<span class="ix" data-symbol="\^KS11" title="코스피 차트 보기">/);
  assert.match(box.innerHTML, /7,003\.74/);
  assert.doesNotMatch(box.innerHTML, /코스피200/, '모르는 지수는 보이지 않는다');
  c.tickIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '다음 장은 미국');
  assert.match(box.innerHTML, /^<div class="ixpage in">/, '넘길 때는 등장 애니메이션');
  assert.match(box.innerHTML, /26,692\.87/);
  c.tickIndices();
  assert.equal(shown(), 'KRW=X', '그다음은 원/달러');
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '처음으로 돌아온다');
  run('indexHover = true;');
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '마우스를 올리면 멈춘다');
  run("indexHover = false; state.selected = '^GSPC';");
  c.renderIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '보고 있는 지수의 장을 보인다');
  assert.match(box.innerHTML, /<span class="ix on" data-symbol="\^GSPC"/);
  c.tickIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '보는 동안은 넘기지 않는다');
  assert.doesNotMatch(box.innerHTML, /ixpage in/, '같은 장을 4초마다 다시 등장시키지도 않는다(깜빡임)');
  run("state.selected = '005930.KS'; indexItems = indexItems.slice(0, 2);");
  c.renderIndices();
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '미국 지수 · 환율을 못 받으면 한 장 — 넘기지 않는다');
  run('indexItems = [];');
  c.renderIndices();
  assert.equal(box.hidden, true, 'no indices → the line hides (Naver failure)');
});

// 지수 줄 오른쪽 끝의 점 — 몇 번째 장인지 보이고, 누르면 그 장으로 바로 간다(4초씩 기다리지 않게).
await test('index line dots show the page and jump to it; the turn waits a full interval after a click; a viewed index can be paged away from until another pick', () => {
  const { c, run, elements } = harness(['renderIndices', 'indexPages', 'tickIndices', 'flipIndexPage']);
  run(formatting);
  for (const name of ['indexItems', 'indexPage', 'indexHover', 'indexManualFor', 'indexFlipAt']) run(source.match(new RegExp(`^let ${name} = .*$`, 'm'))[0]);
  run(source.match(/^const FOLIO_MS = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '005930.KS'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, pct: 0.46 }, { code: 'KOSDAQ', name: '코스닥', value: 893.29, pct: -0.11 },
    { code: 'NASDAQ', name: '나스닥', value: 26692.87, pct: -1.88 }, { code: 'SPX', name: 'S&P 500', value: 6600.1, pct: -1.2 },
    { code: 'USDKRW', name: '원/달러', value: 1351.4, pct: 0.63 }];`);
  const box = c.document.getElementById('indices');
  const shown = () => [...box.innerHTML.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]).join(' ');
  c.renderIndices();
  assert.match(box.innerHTML, /<\/div><span class="ixdots"><button class="ixdot on" data-page="0" title="코스피 · 코스닥"><\/button><button class="ixdot" data-page="1" title="나스닥 · S&P 500"><\/button><button class="ixdot" data-page="2" title="원\/달러"><\/button><\/span>$/,
    '장 수만큼 점, 지금 장이 진하다, 장의 지수 이름이 툴팁');

  c.flipIndexPage(2);
  assert.equal(shown(), 'KRW=X', '점을 누르면 그 장으로 바로');
  assert.match(box.innerHTML, /^<div class="ixpage in">/);
  assert.match(box.innerHTML, /data-page="2" title="원\/달러"/);
  assert.match(box.innerHTML, /class="ixdot on" data-page="2"/);
  c.tickIndices();
  assert.equal(shown(), 'KRW=X', '누른 뒤 한 번의 간격(4초)은 넘기지 않는다');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + run('FOLIO_MS');
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '간격이 지나면 다시 넘긴다');

  // 지수를 보고 있으면 그 장에 머무는데, 점으로 다른 장을 볼 수 있다 — 30초 갱신으로 다시 그려도 그대로
  run("state.selected = '^GSPC';");
  c.renderIndices();
  assert.equal(shown(), '^IXIC ^GSPC');
  c.flipIndexPage(0);
  c.renderIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '보고 있는 지수가 있어도 고른 장을 둔다');
  // 다른 것을 골랐다가 같은 지수를 다시 고르면 다시 그 지수의 장으로
  run("state.selected = '005930.KS';");
  c.renderIndices();
  run("state.selected = '^GSPC';");
  c.renderIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '고르는 것이 바뀌면 원래 규칙으로');
  c.flipIndexPage(9);
  assert.equal(shown(), '^IXIC ^GSPC', '없는 장은 무시한다');

  run("state.selected = '005930.KS'; indexItems = indexItems.slice(0, 2);");
  c.renderIndices();
  assert.doesNotMatch(box.innerHTML, /ixdots/, '한 장뿐이면 점이 없다');
  c.Date.now = realNow;
  // 줄은 다시 그려지므로 점 누르기는 줄 상자에서 받는다(지수 누르기 — 그 차트 — 보다 먼저)
  assert.match(source, /const dot = e\.target\.closest\('\.ixdot'\);\s*if \(dot\) \{ flipIndexPage\(Number\(dot\.dataset\.page\)\); return; \}/);
});

// 선물 · 유가는 셋째 장, 원/달러 · 미국채 10년은 넷째 장. 선물 · 유가는 10분 늦다는 것을 툴팁에, 금리는 등락을 bp 로.
await test('index line: futures and oil on the third page, the dollar and the 10-year yield (in bp) on the fourth', () => {
  const { c, run, elements } = harness(['renderIndices', 'indexPages', 'tickIndices', 'flipIndexPage']);
  run(formatting);
  for (const name of ['indexItems', 'indexPage', 'indexHover', 'indexManualFor', 'indexFlipAt']) run(source.match(new RegExp(`^let ${name} = .*$`, 'm'))[0]);
  run(source.match(/^const FOLIO_MS = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '005930.KS'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, change: 32.39, pct: 0.46 }, { code: 'KOSDAQ', name: '코스닥', value: 893.29, change: -1, pct: -0.11 },
    { code: 'NASDAQ', name: '나스닥', value: 26692.87, change: -511.51, pct: -1.88 }, { code: 'SPX', name: 'S&P 500', value: 6600.1, change: -80, pct: -1.2 },
    { code: 'NQ', name: '나스닥 선물', value: 29122.75, change: -19.25, pct: -0.07 }, { code: 'WTI', name: 'WTI', value: 100.36, change: 0.89, pct: 0.89 },
    { code: 'USDKRW', name: '원/달러', value: 1351.4, change: 8.5, pct: 0.63 }, { code: 'US10Y', name: '미국채 10년', value: 4.97, change: 0.0167, pct: 0.34 }];`);
  const box = c.document.getElementById('indices');
  const shown = () => [...box.innerHTML.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]).join(' ');
  c.renderIndices();
  assert.match(box.innerHTML, /data-page="2" title="나스닥 선물 · WTI"><\/button><button class="ixdot" data-page="3" title="원\/달러 · 미국채 10년"><\/button><\/span>$/,
    '네 장');
  c.flipIndexPage(2);
  assert.equal(shown(), 'NQ=F CL=F');
  assert.match(box.innerHTML, /title="나스닥 선물 \(10분 지연\) 차트 보기"><span class="ixn">나스닥 선물<\/span><span class="ixv">29,122\.75<\/span><span class="ixp" style="color:#185fa5">-0\.07%<\/span>/);
  assert.match(box.innerHTML, /title="WTI \(10분 지연\) 차트 보기">/);
  c.flipIndexPage(3);
  assert.equal(shown(), 'KRW=X ^TNX');
  assert.match(box.innerHTML, /title="미국채 10년 차트 보기"><span class="ixn">미국채 10년<\/span><span class="ixv">4\.970<\/span><span class="ixp" style="color:#e24b4a">\+1\.7bp<\/span>/,
    '금리는 셋째 자리 · bp, 지연 표시 없음(실시간)');
  assert.match(box.innerHTML, /<span class="ixv">1,351\.40<\/span><span class="ixp" style="color:#e24b4a">\+0\.63%<\/span>/, '원/달러는 그대로 %');
});

await test('choosing an index from a zoomed stock drops every zoom and re-marks the index line', async () => {
  const { c, run } = harness(['select', 'clearZooms']);
  let marks = 0;
  let charts = 0;
  Object.assign(c, {
    save() {}, renderList() {}, renderDetail() {},
    renderIndices: () => { marks++; }, loadChart: async () => { charts++; },
  });
  run("zoom = { start: 1, end: 2 }; zoomByTf['1Y'] = { start: 3, end: 4 };");
  await c.select('^KS11');
  assert.equal(run('state.selected'), '^KS11');
  assert.equal(run('zoom'), null);
  assert.equal(run("zoomByTf['1Y']"), undefined);
  assert.equal(marks, 1);
  assert.equal(charts, 1);
});

await test('refresh builds index quotes from the Naver index line; a missing index falls back to Yahoo', async () => {
  const { c, run } = harness(['refreshAll']);
  const loaded = [];
  Object.assign(c, {
    loadIndices: async () => [{ code: 'KOSPI', name: '코스피', value: 7003.74, change: 32.39, pct: 0.46,
      open: 6938.27, high: 7011.04, low: 6927.88, isOpen: true, tradedAt: '2026-10-02T15:20:00+09:00' }],
    fetchLive: async () => ({}),
    loadQuote: async (item, live) => { loaded.push([item.symbol, live]); },
    renderList() {}, checkAlerts() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {}, renderUpdated() {},
  });
  await c.refreshAll();
  const kospi = loaded.find(([s]) => s === '^KS11');
  assert.equal(kospi[1].price, 7003.74);
  assert.equal(kospi[1].session, 'regular');
  const kosdaq = loaded.find(([s]) => s === '^KQ11');
  assert.ok(kosdaq, 'both indices are loaded every refresh');
  assert.equal(kosdaq[1], undefined, 'no Naver value → loadQuote without live (Yahoo, 20분지연)');
  assert.equal(run('busy'), false);
});

// 갱신 한 번에 목록을 종목 수만큼 다시 만들지 않는다 — 처음 받는 종목만 그때그때(첫 화면이 빨리 차게), 나머지는 끝에 한 번.
// 받는 사이 지운 종목은 시세를 남기지 않는다 — 예전에는 살아 있는 목록을 돌아 지운 종목의 시세가 되살아났다.
await test('refresh redraws the list once (plus once per first-time stock) and keeps no quote for a stock removed mid-refresh', async () => {
  const { c, run } = harness(['refreshAll']);
  let renders = 0;
  const loaded = [];
  Object.assign(c, {
    loadIndices: async () => [], fetchLive: async () => ({}),
    loadQuote: async (item) => {
      if (isIndexSym(item.symbol)) return;
      loaded.push(item.symbol);
      // B 는 받는 사이에 지워진다(지우기가 먼저 끝나고 응답이 뒤에 온다)
      if (item.symbol === 'B') run("state.watchlist = state.watchlist.filter((i) => i.symbol !== 'B'); delete quotes.B;");
      run(`quotes['${item.symbol}'] = { price: 1 };`);
      // A 를 받는 사이 C 가 지워진다 — C 는 묻지도 않는다
      if (item.symbol === 'A') run("state.watchlist = state.watchlist.filter((i) => i.symbol !== 'C');");
    },
    renderList() { renders++; }, checkAlerts() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {}, renderUpdated() {},
  });
  const isIndexSym = (s) => c.isIndex(s); // 지수 줄 기호(^ 지수 · =X 환율 · =F 선물)
  run(`state.watchlist = [{ symbol: 'A', name: 'a' }, { symbol: 'B', name: 'b' }, { symbol: 'C', name: 'c' }, { symbol: 'D', name: 'd' }];
    quotes.A = { price: 0 }; quotes.B = { price: 0 }; quotes.C = { price: 0 }; quotes.D = { price: 0 };`);
  await c.refreshAll();
  assert.deepEqual(loaded, ['A', 'B', 'D'], '갱신 중에 지운 C 는 묻지 않는다');
  assert.equal(run('quotes.B'), undefined, '받는 사이 지운 B 의 시세는 남기지 않는다');
  assert.equal(renders, 1, '이미 있던 줄은 끝에 한 번만 다시 그린다');
  run("state.watchlist.push({ symbol: 'E', name: 'e' });");
  renders = 0;
  await c.refreshAll();
  assert.equal(renders, 2, '처음 받는 종목(E)은 받자마자 한 번 더');
});

await test('index detail: points with two decimals, no currency tag, no sector lookup', () => {
  const { c, run, elements } = harness(['renderDetail']);
  run(formatting);
  let lookups = 0;
  Object.assign(c, {
    sectors: new Map(), loadSector: () => { lookups++; return Promise.resolve(); },
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({ label: '—', color: '#000000' }), cssVar: () => '#000000',
  });
  run(`state.selected = '^KS11'; quotes['^KS11'] = { price: 7003.74, change: 32.39, pct: 0.46,
    live: true, session: 'closed', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, '코스피');
  assert.equal(elements.get('dprice').textContent, '7,003.74');
  assert.match(elements.get('dchg').innerHTML, /\+32\.39/);
  assert.equal(lookups, 0, 'indices have no sector');
  run("state.selected = '005930.KS'; quotes['005930.KS'] = { price: 271500, currency: 'KRW' };");
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, '삼성전자');
  assert.equal(elements.get('dprice').textContent, '271,500');
  assert.equal(lookups, 1, 'stocks still look up their sector');
});

// 미국채 10년을 고르면 헤더도 금리답게 — 이름 옆 단위(%), 셋째 자리, 전일 대비는 bp(등락률은 그 아래 그대로).
await test('yield detail: percent unit tag, three decimals, change in bp over the ratio', () => {
  const { c, run, elements } = harness(['renderDetail']);
  run(formatting);
  Object.assign(c, {
    sectors: new Map(), loadSector: () => Promise.resolve(),
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({ label: '—', color: '#000000' }), cssVar: () => '#000000',
  });
  run(`state.selected = '^TNX'; quotes['^TNX'] = { price: 4.97, change: 0.0167, pct: 0.34,
    live: true, session: 'regular', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, '미국채 10년 (%)');
  assert.equal(elements.get('dprice').textContent, '4.970');
  assert.equal(elements.get('dchg').innerHTML, '+1.7bp<br>+0.34%');
  run(`state.selected = 'CL=F'; quotes['CL=F'] = { price: 100.36, change: 0.89, pct: 0.89,
    live: true, session: 'regular', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, 'WTI', '유가 · 선물은 지수처럼 단위 표시 없이');
  assert.equal(elements.get('dchg').innerHTML, '+0.89<br>+0.89%');
});

// 과열도 배지의 툴팁 — 일봉 RSI 와 주봉 RSI(이번 주 진행 중). 배지 글자 · 색은 일봉 RSI 그대로다.
await test('loadQuote keeps a weekly RSI next to the daily one — the same daily closes grouped Monday to Sunday', async () => {
  const { c, run } = harness(['loadQuote']);
  const t0 = Date.parse('2026-01-05T00:00:00Z'); // 월요일, 국내 일봉 시각
  const times = [];
  const closes = [];
  for (let i = 0; i < 200; i++) {
    const t = t0 + i * 86400000;
    if ([0, 6].includes(new Date(t).getUTCDay())) continue; // 주말 없음
    times.push(t);
    closes.push(Math.round(100 + Math.sin(i / 7) * 10 + i * 0.1));
  }
  c.dailyFor = async () => ({ price: closes.at(-1), closes, times, currency: 'KRW' });
  await c.loadQuote({ symbol: '005930.KS' }, undefined);
  const q = run("quotes['005930.KS']");
  const want = run(`calcRSI(weekCloses(${JSON.stringify(times)}, ${JSON.stringify(closes)}))`);
  assert.ok(want > 0 && want < 100, String(want));
  assert.equal(q.rsiWeek, want, '주간 종가에 같은 RSI');
  assert.notEqual(q.rsiWeek, q.rsi, '일봉 RSI 와는 다른 값');
});

await test('RSI badge tooltip shows daily and weekly RSI; the badge itself stays on daily RSI', () => {
  const { c, run, elements } = harness(['renderDetail']);
  run(formatting);
  Object.assign(c, {
    sectors: new Map(), loadSector: () => Promise.resolve(),
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({ label: '중립', color: '#000000' }), cssVar: () => '#000000', hexA: () => 'x',
  });
  run("state.selected = '005930.KS'; quotes['005930.KS'] = { price: 224500, currency: 'KRW', rsi: 39.0739, rsiWeek: 43.46 };");
  c.renderDetail();
  const b = elements.get('badge');
  assert.equal(b.textContent, '중립 · RSI 39', '배지는 일봉 RSI');
  assert.equal(b.title, '일봉 RSI 39.1 · 주봉 RSI 43.5 (이번 주 진행 중)\n15:30 정규장 종가 기준, 오늘 · 이번 주는 지금 가격 · 과열도는 일봉 RSI');
  run("quotes['005930.KS'].rsiWeek = null;");
  c.renderDetail();
  assert.equal(b.title, '일봉 RSI 39.1\n15:30 정규장 종가 기준, 오늘은 지금 가격 · 과열도는 일봉 RSI', '주봉이 모자라면(최근 상장) 일봉만');
  run("quotes['005930.KS'].rsi = null;");
  c.renderDetail();
  assert.equal(b.title, '', 'RSI 가 없으면 툴팁도 없다');
});

await test('loadChart draws the selected index from its Yahoo symbol in points', async () => {
  const { c, run } = harness(['loadChart']);
  run(formatting);
  const asked = [];
  const draws = [];
  Object.assign(c, {
    fetchChartCached: async (symbol) => {
      asked.push(symbol);
      return { ok: true, closes: [6900, 7000], times: [1, 2], volumes: [1, 2], highs: [6950, 7010], lows: [6890, 6990] };
    },
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {},
    renderCrossBadge: () => {}, renderTrendBadges: () => {}, TREND_TF: new Set(),
    drawChart: (data) => draws.push(data),
  });
  run(`let lastDrawSig = null; state.selected = '^KS11';
    quotes['^KS11'] = { price: 7003.74, prevClose: 6971.35, change: 32.39, live: true, open: false,
      session: 'closed', priceSession: 'closed' };`);
  await c.loadChart();
  assert.deepEqual(asked, ['^KS11']);
  assert.equal(draws.at(-1).cur, 'pt');
  assert.equal(draws.at(-1).hLines.find((l) => l.label === '전일').value, 6971.35);
});

await test('arrow keys from an index go to the first (↓) or last (↑) watchlist row', () => {
  const { c, run } = harness(['moveSelection']);
  const picked = [];
  c.select = (s) => { picked.push(s); return Promise.resolve(); };
  run('document.querySelector = () => null;');
  run("state.selected = '^KS11';");
  c.moveSelection(1);
  c.moveSelection(-1);
  run("state.selected = '005930.KS';"); // 목록 안에서는 지금처럼 한 칸씩, 끝에서 돈다
  c.moveSelection(1);
  c.moveSelection(-1);
  assert.deepEqual(picked, ['005930.KS', '000660.KS', '000660.KS', '000660.KS']);
});

await test('saved selection survives restart when it is an index, even with an empty watchlist', () => {
  const { c } = harness(['validSelection']);
  const wl = [{ symbol: '005930.KS' }, { symbol: '000660.KS' }];
  assert.equal(c.validSelection('^KQ11', wl), '^KQ11');
  assert.equal(c.validSelection('^KQ11', []), '^KQ11');
  assert.equal(c.validSelection('000660.KS', wl), '000660.KS');
  assert.equal(c.validSelection('GONE', wl), '005930.KS');
  assert.equal(c.validSelection('GONE', []), null);
  assert.equal(c.validSelection(undefined, []), null);
});

// 저장된 기간이 지금 빌드에 없으면(손으로 고친 설정, 앞으로 기간 이름을 바꾸거나 뺀 빌드) loadChart 가
// TF[...] 에서 undefined 를 읽어 매 갱신 예외로 끝나고 차트가 조용히 비었다. 다른 저장값처럼 거른다.
await test('a saved timeframe this build does not know falls back to 1D', () => {
  const { c } = harness(['validTimeframe']);
  for (const tf of ['1D', '1W', '1M', '3M', '1Y', '3Y', '전체']) assert.equal(c.validTimeframe(tf), tf);
  for (const tf of ['6M', '5Y', '', undefined, null, 'toString', '__proto__']) assert.equal(c.validTimeframe(tf), '1D', String(tf));
});

await test('indexLive rejects a non-positive value or previous close, like the stock adapter', () => {
  const { run } = harness();
  const base = `{ code: 'KOSPI', name: '코스피', change: 5, pct: 0.1, open: 100, high: 101, low: 99, isOpen: true }`;
  // 빈 closePrice 는 main.js num('') 에서 0 이 된다 — 0 이 실시간 값으로 들어가면 1D 끝점이 0 이라 차트가 눌린다
  assert.equal(run(`indexLive({ ...${base}, value: 0 })`), undefined);
  assert.equal(run(`indexLive({ ...${base}, value: 5 })`), undefined, 'previous close would be 0');
  assert.equal(run(`indexLive({ ...${base}, value: 105 }).prevClose`), 100);
});

// Chart.js 는 order 가 큰 데이터셋부터 그린다(4.5.1: _sortedMetasets 를 order 오름차순으로
// 정렬한 뒤 뒤에서부터 _drawDataset). 추세선이 맨 위에 오려면 다른 어떤 것보다 order 가 작아야 한다.
await test('drawChart draws trend lines on top of every other dataset, and drops them while zoomed', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'rgba(0,0,0,0)', cssVar: () => '#000000',
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  run(`state.timeframe = '3M'; state.maPeriods = [5];
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var trend_ = { data: C_.map((v) => v + 5), slope: 1, from: 0, to: 20, varName: '--res-line', broke: null };
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_, lows: C_,
      mas: [{ p: 5, data: C_ }], trends: [trend_] };`);
  run('drawChart(arg_);');
  let cfg = configs.at(-1);
  const sets = cfg.data.datasets;
  const trendSet = sets.find((d) => Array.isArray(d.borderDash));
  const others = sets.filter((d) => d !== trendSet);
  assert.ok(trendSet, 'trend dataset is drawn');
  assert.ok(others.length >= 4, 'price, high/low band, MA and volume are there to compare against');
  assert.ok(others.every((d) => trendSet.order < d.order),
    `trend order ${trendSet.order} must be below ${others.map((d) => d.order).join(',')}`);

  // 확대 중에는 추세선이 숨는다
  run('zoom = { start: T_[5], end: T_[25] }; drawChart(arg_);');
  cfg = configs.at(-1);
  assert.equal(cfg.data.datasets.some((d) => Array.isArray(d.borderDash)), false);
});

// 야후에는 3년 구간(range=3y)이 없다. 3Y 는 5년치 일봉을 받아 마지막 봉에서 달력 3년
// 전 날짜(UTC 날짜 — maFor · zoomRange 와 같은 규칙)부터 남긴다. 그날 봉은 들어간다.
await test('3Y fetches five years of daily bars and draws only the last three calendar years', async () => {
  const { c, run } = harness(['loadChart']);
  const asked = [];
  const periods = [];
  const draws = [];
  const at = (s) => Date.parse(`${s}T00:00:00Z`);
  let bars;
  Object.assign(c, {
    fetchChartCached: async (symbol, tf) => { asked.push(`${tf.range}/${tf.interval}`); return bars; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (from, to) => periods.push([from, to]),
    renderMaChips: () => {}, renderCrossBadge: () => {}, renderTrendBadges: () => {},
    curOf: () => 'KRW', drawChart: (data) => draws.push(data),
  });
  run(`let lastDrawSig = null; state.timeframe = '3Y';
    quotes['005930.KS'] = { price: 300, live: true, session: 'closed', priceSession: 'closed' };`);
  bars = { ok: true,
    times: ['2023-09-08', '2023-09-11', '2023-09-12', '2026-09-09', '2026-09-10'].map(at),
    closes: [100, 110, 120, 280, 290], opens: [99, 109, 119, 279, 289],
    highs: [101, 111, 121, 281, 291], lows: [98, 108, 118, 278, 288], volumes: [1, 2, 3, 4, 5] };
  // 마지막 봉 2026-09-10 → 2023-09-10(일요일)부터. 금요일 09-08 은 빠지고 월요일 09-11 부터 남는다
  await c.loadChart();
  assert.deepEqual(asked, ['5y/1d']);
  const d = draws.at(-1);
  assert.deepEqual(d.times, ['2023-09-11', '2023-09-12', '2026-09-09', '2026-09-10'].map(at));
  assert.deepEqual(d.closes, [110, 120, 280, 290]);
  assert.deepEqual(d.opens, [109, 119, 279, 289]);
  assert.deepEqual(d.highs, [111, 121, 281, 291]);
  assert.deepEqual(d.lows, [108, 118, 278, 288]);
  assert.deepEqual(d.volumes, [2, 3, 4, 5]);
  assert.deepEqual(periods.at(-1), [110, 300], '3Y 수익률은 잘라 낸 첫 봉에서 잰다');
  assert.equal(bars.closes.length, 5, '캐시에 든 원본은 그대로 둔다(1Y 등과 같은 캐시 규칙)');

  // 정확히 3년 전 같은 날 봉은 들어간다
  bars = { ...bars, times: ['2023-09-08', '2023-09-10', '2023-09-11', '2026-09-09', '2026-09-10'].map(at) };
  run('lastDrawSig = null;');
  await c.loadChart();
  assert.equal(draws.at(-1).closes[0], 110, '2023-09-10 봉부터');

  // 3년이 안 된 종목은 있는 만큼 다 그린다
  bars = { ...bars, times: ['2024-05-02', '2024-05-03', '2025-01-02', '2026-09-09', '2026-09-10'].map(at) };
  run('lastDrawSig = null;');
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [100, 110, 120, 280, 290]);

  // 다른 기간은 받은 그대로다
  run("state.timeframe = '1Y'; lastDrawSig = null;");
  bars = { ...bars, times: ['2023-09-08', '2023-09-11', '2023-09-12', '2026-09-09', '2026-09-10'].map(at) };
  await c.loadChart();
  assert.equal(asked.at(-1), '1y/1d');
  assert.equal(draws.at(-1).closes.length, 5);
});

// 전체 — 야후에 처음부터 끝까지(range=max) 묻는다. 봉 크기는 야후가 기간에 따라 고른다(2026-10-14 실측:
// 삼성전자 · 코스피 월봉, LG에너지솔루션 주봉, AAPL 분기봉). 일 단위 이동평균 · 골든/데드는 맞지 않아 그리지 않는다.
await test('전체 asks Yahoo for the whole history and draws it without daily moving averages', async () => {
  const { c, run } = harness(['loadChart']);
  const asked = [];
  const periods = [];
  const draws = [];
  const chips = [];
  const at = (s) => Date.parse(`${s}T00:00:00Z`);
  const bars = { ok: true, times: ['2000-01-01', '2013-06-01', '2026-10-01'].map(at), closes: [6000, 30000, 237750],
    opens: [5900, 29000, 230000], highs: [6100, 31000, 240000], lows: [5800, 28000, 229000], volumes: [1, 2, 3] };
  Object.assign(c, {
    fetchChartCached: async (symbol, tf) => { asked.push(`${tf.range}/${tf.interval}`); return bars; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (from, to) => periods.push([from, to]),
    renderMaChips: () => chips.push(run('chartBars')), renderCrossBadge: () => {}, renderTrendBadges: () => {},
    curOf: () => 'KRW', drawChart: (data) => draws.push(data),
    maFor: () => { throw new Error('일 단위 이동평균을 월봉에 그리면 안 된다'); },
  });
  run(`let lastDrawSig = null; chartBars = 1219; state.maPeriods = [5, 20, 60]; state.timeframe = '전체';
    quotes['005930.KS'] = { price: 237750, live: true, session: 'regular', priceSession: 'regular', open: true,
      candle: { open: 230000, high: 240000, low: 229000 } };`);
  await c.loadChart();
  assert.deepEqual(asked, ['max/1mo'], '일봉(1d)으로 물으면 일봉용 네이버 빈 날 채우기가 섞인다');
  const d = draws.at(-1);
  assert.deepEqual(d.closes, [6000, 30000, 237750], '받은 봉 그대로 — 끝점을 덧붙이지 않는다(1D 만)');
  // vm 안에서 만든 배열이라 펼쳐서 비교한다(프로토타입이 달라 [] 끼리도 deepEqual 이 실패한다)
  assert.deepEqual([...d.mas], [], '이동평균선 없음');
  assert.deepEqual([...d.crosses], [], '골든/데드 없음');
  assert.deepEqual([...d.trends], [], '추세선 없음');
  assert.deepEqual(d.highs, [6100, 31000, 240000], '마지막 봉을 오늘 캔들로 덮지 않는다(일봉만)');
  assert.equal(run('chartBars'), 0, '이평선 칩은 1D · 1W 처럼 흐려진다');
  assert.deepEqual(chips, [0]);
  assert.deepEqual(periods.at(-1), [6000, 237750], '전체 수익률은 첫 봉부터');
});

// 3Y 는 1Y 처럼 축 라벨이 연/월이다 — 툴팁 제목에는 일까지, 확대하면 월/일 라벨.
await test('3Y labels read like 1Y: YY/MM axis, full date in the tooltip, MM/DD when zoomed', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'rgba(0,0,0,0)', cssVar: () => '#000000',
  });
  const day = 86400000;
  const t0 = Date.parse('2024-03-04T00:00:00Z');
  run(`state.timeframe = '3Y';
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_, lows: C_ };`);
  run('drawChart(arg_);');
  let cfg = configs.at(-1);
  assert.equal(cfg.data.labels[0], '24/03');
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 2, label: cfg.data.labels[2] }]), '24/03/06');
  run('zoom = { start: T_[5], end: T_[25] }; drawChart(arg_);');
  cfg = configs.at(-1);
  assert.equal(cfg.data.labels[5], '03/09', 'zoomed 3Y shows month/day like zoomed 1Y');
  // 전체도 연/월이다 — 26년치를 월/일로 쓰면 해가 바뀌어도 같은 라벨이 된다
  run("zoom = null; state.timeframe = '전체'; drawChart(arg_);");
  cfg = configs.at(-1);
  assert.equal(cfg.data.labels[0], '24/03');
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 2, label: cfg.data.labels[2] }]), '24/03/06');
});

// 3Y 는 봉 하나가 약 0.38px 라 5봉이 2px 남짓이다. 끈 봉 수만 보면 클릭할 때의 손떨림이
// 확대가 된다 — 마우스가 실제로 움직인 거리(6px 이상)도 넘겨야 한다.
await test('drag zoom needs 6px of real mouse travel, so a jittery click on dense 3Y does not zoom', () => {
  const { c, run } = harness(['bindZoom', 'barAt']);
  run(source.match(/^let zoomDrag = .*$/m)[0]);
  run(source.match(/^let lastChart = .*$/m)[0]);
  const on = {};
  const cv = { addEventListener: (k, fn) => { on[k] = fn; }, getBoundingClientRect: () => ({ left: 0 }) };
  c.document.getElementById = (id) => (id === 'chart' ? cv : null);
  c.window = { addEventListener: (k, fn) => { on[k] = fn; } };
  const drawn = [];
  Object.assign(c, { cv_: cv, drawChart: (d) => drawn.push(d), resetZoom: () => {} });
  run(`state.timeframe = '3Y';
    chart = { draw() {}, canvas: cv_, scales: { x: { min: 0, max: 729, getValueForPixel: (px) => px / 0.38 } } };
    lastChart = { times: Array.from({ length: 730 }, (_, i) => i * 86400000) };`);
  c.bindZoom();
  const drag = (x0, x1) => {
    on.mousedown({ button: 0, clientX: x0 });
    on.mousemove({ buttons: 1, clientX: x1 });
    on.mouseup({ clientX: x1 });
  };
  drag(100, 105); // 263 → 276봉, 14봉에 걸치지만 5px
  assert.equal(run('zoom'), null, '5px 손떨림은 확대가 아니다');
  assert.equal(drawn.length, 0);
  drag(100, 106); // 263 → 279봉
  assert.equal(run('JSON.stringify(zoom)'), JSON.stringify({ start: 263 * 86400000, end: 279 * 86400000 }));
  assert.equal(drawn.length, 1);
});

// 일봉(야후)을 실제 refreshAll · loadQuote · dailyFor 로 받는다. 시계는 테스트가 돌린다.
function dailyRun({ yahoo, live = () => ({}) }) {
  const h = harness(['refreshAll', 'loadQuote', 'dailyFor']);
  let clock = NOW;
  h.c.Date = class extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  };
  const calls = [];
  h.c.api.fetchChart = async ({ symbol, range }) => {
    calls.push(symbol);
    return yahoo(symbol, range);
  };
  Object.assign(h.c, {
    loadIndices: async () => [], fetchLive: async () => live(),
    renderList() {}, checkAlerts() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {},
  });
  return { ...h, calls, at: (sec) => { clock = NOW + sec * 1000; }, refresh: () => h.c.refreshAll() };
}
const daily = (price) => ({ ok: true, price, closes: [price - 1000, price], times: [NOW - 86400000, NOW],
  opens: [price, price], highs: [price, price], lows: [price, price], currency: 'KRW' });

// 야후가 응답을 멈추면(8초씩 기다림) 갱신 한 번이 종목 수 × 8초가 되고, 바로 거절(429)하면
// 30초마다 전 종목 5년치를 다시 보낸다. 실패한 종목은 5분 쉬고, 한 차례에 하나가 실패하면
// 캐시가 있는 나머지는 그 차례를 건너뛴다.
await test('a failing Yahoo daily fetch is retried at most once per refresh, and each symbol rests 5 minutes', async () => {
  let up = true;
  const d = dailyRun({ yahoo: (s) => (up ? daily(100000) : { ok: false, error: 'HTTP 429' }) });
  d.run(`state.watchlist = [{symbol:'005930.KS',name:'삼성전자'},{symbol:'000660.KS',name:'SK하이닉스'},
    {symbol:'035420.KS',name:'NAVER'}];`);
  const all = 3 + d.run('INDICES.length'); // 종목 3 + 지수 줄
  await d.refresh(); // 0초 — 다 받는다
  assert.equal(d.calls.length, all);
  up = false;
  d.calls.length = 0;
  for (const sec of [120, 150, 180, 210]) { d.at(sec); await d.refresh(); } // 캐시 만료(60초) 뒤 네 번
  assert.equal(d.calls.length, 4, `one request per refresh, not ${all} — got ${d.calls.join(',')}`);
  assert.equal(new Set(d.calls).size, 4, 'each refresh tries a different symbol — the failed ones rest');
  up = true;
  d.calls.length = 0;
  d.at(210 + 301); await d.refresh(); // 마지막 실패에서 5분 지남 — 모두 다시 받는다
  assert.equal(d.calls.length, all, 'after the rest every symbol fetches again');
  assert.ok(!d.run("quotes['005930.KS'].stale"), 'fresh again');
});

// 네트워크가 끊기면 dailyFor 는 몇 시간 전 캐시를 돌려준다. 그 값을 "20분지연 <지금 시각>" 으로
// 보여 주면 묵은 가격이 정상 지연 시세처럼 보인다 — 실제로 받은 시각과 함께 "갱신 실패" 로 보인다.
// 실시간(네이버)이 있으면 가격은 새것이라 그대로다(일봉은 RSI · 이동평균 · 52주에만 쓴다).
await test('a cached price shown because Yahoo failed says so, with the time it was actually fetched', async () => {
  let up = true;
  let naver = false;
  const d = dailyRun({
    yahoo: () => (up ? daily(250000) : { ok: false, error: 'fetch failed' }),
    live: () => (naver ? { '005930': { price: 251000, prevClose: 249000, open: true, session: 'regular',
      priceSession: 'regular', isTrading: true, source: 'Naver' } } : {}),
  });
  d.run("state.watchlist = [{symbol:'005930.KS',name:'삼성전자'}];");
  await d.refresh(); // 18:30:00 KST 에 받음
  up = false;
  d.at(3 * 3600); // 세 시간 뒤, 네트워크 끊김
  await d.refresh();
  const q = d.run("quotes['005930.KS']");
  assert.equal(q.price, 250000);
  assert.equal(q.stale, true);
  assert.equal(q.fetchedAt, NOW, 'fetchedAt is when the cache was filled, not now');
  d.c.renderUpdated();
  const header = d.elements.get('updated');
  assert.match(header.innerHTML, /갱신 실패<\/span> 18:30:00/, header.innerHTML);
  assert.match(header.title, /마지막으로 받은 값/);

  naver = true; // 네이버는 되고 야후만 안 될 때
  d.at(3 * 3600 + 30);
  await d.refresh();
  const q2 = d.run("quotes['005930.KS']");
  assert.equal(q2.price, 251000);
  assert.ok(!q2.stale, 'a live price is fresh even if the daily series is old');
  d.c.renderUpdated();
  assert.doesNotMatch(header.innerHTML, /갱신 실패/);
});

// 삭제 · 되돌리기 · 추가를 실제 함수로 돌린다. 네트워크(시세 · 차트)는 테스트가 막아 두고 푼다.
function undoRun(extra = []) {
  const h = harness(['removeSymbol', 'undoRemove', 'addSymbol', 'showUndo', 'hideUndo', 'select', ...extra]);
  h.run(source.match(/^const UNDO_MS = .*$/m)[0]);
  h.run(source.match(/^let undoSnap = .*$/m)[0]);
  h.run(source.match(/^let undoTimer = .*$/m)[0]);
  h.run(source.match(/^const adding = .*$/m)[0]);
  let gate = null;
  const charts = [];
  Object.assign(h.c, {
    save() {}, renderList() {}, renderDetail() {}, renderIndices() {}, clearZooms() {}, hint() {}, closeSearch() {},
    renderFolio: async () => {}, fetchLive: async () => ({}),
    loadQuote: async (item) => {
      if (gate) await gate.promise;
      h.run(`quotes[${JSON.stringify(item.symbol)}] = { price: 100, change: 1 };`);
    },
    loadChart: async () => { charts.push(h.run('state.selected && !!quotes[state.selected]')); },
    clearChart() {},
  });
  const hold = () => { let open; gate = { promise: new Promise((r) => { open = r; }) }; return () => { gate = null; open(); }; };
  return { ...h, charts, hold };
}
const SAM = { symbol: '005930.KS', name: '삼성전자' };
const HYNIX = { symbol: '000660.KS', name: 'SK하이닉스' };

// 지운 종목을 6초 안에 다시 추가하고 되돌리기를 누르면 같은 종목이 두 줄이 됐다 — 보유 합계가
// 두 배, 목표가 알림도 두 번. 다시 추가하면 보유는 이미 지워진 뒤라, 되돌리기는 줄은 그대로 두고
// 비어 있는 목표가 · 보유를 되살린다. 추가가 아직 조회 중일 때 되돌려도 마찬가지다.
await test('undo after re-adding the same stock restores its holding and target without a second row', async () => {
  const a = undoRun();
  a.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };
    state.alerts.targets = { '005930.KS': { up: 300000 } };`);
  await a.c.removeSymbol('005930.KS');
  await a.c.addSymbol(SAM);
  await a.c.undoRemove();
  assert.deepEqual(a.run("state.watchlist.map((i) => i.symbol).join()"), '000660.KS,005930.KS', 'one row each');
  assert.equal(a.run("state.holdings['005930.KS'].avg"), 200000, 'the holding comes back');
  assert.equal(a.run("state.alerts.targets['005930.KS'].up"), 300000, 'the target comes back');

  // 추가가 조회를 기다리는 사이 되돌리기 — 되돌리기가 먼저 줄을 넣고, 추가는 뒤늦게 끝난다
  const b = undoRun();
  b.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';`);
  await b.c.removeSymbol('005930.KS');
  const open = b.hold();
  const adding = b.c.addSymbol(SAM);
  const undoing = b.c.undoRemove();
  open();
  await Promise.all([adding, undoing]);
  assert.equal(b.run("state.watchlist.map((i) => i.symbol).join()"), '005930.KS,000660.KS', 'still one row each');
});

// 선택 중이던 종목을 지웠다 되돌리면 select → loadChart 가 시세를 다시 받기 전에 돈다. 시세가 없으면
// 이동평균 · 교차 배지 · 색(늘 빨강)이 빠진 채 그려지고 다음 갱신(장 마감 후 5분)까지 남았다.
await test('undoing a selected stock redraws its chart once its quote is back', async () => {
  const a = undoRun();
  a.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '005930.KS';`);
  await a.c.removeSymbol('005930.KS');
  a.charts.length = 0;
  await a.c.undoRemove();
  assert.equal(a.run('state.selected'), '005930.KS');
  assert.equal(a.charts.at(-1), true, `the last chart draw sees the quote — draws: ${JSON.stringify(a.charts)}`);
});

// 마지막 종목을 지울 때 그 종목의 차트 요청이 진행 중이면, 응답이 뒤늦게 와 지운 종목의 차트가
// 빈 헤더("—") 아래 다시 그려졌다. 차트를 지우면 그 전에 시작한 요청도 무효다.
await test('removing the last stock while its chart is loading leaves no chart behind', async () => {
  const a = undoRun(['loadChart', 'clearChart']);
  a.run(source.match(/^let lastChart = .*$/m)[0]);
  a.run(source.match(/^let hoverIdx = .*$/m)[0]);
  a.run('let lastDrawSig = null;');
  delete a.c.loadChart; delete a.c.clearChart; // 진짜 loadChart · clearChart 를 쓴다
  a.run(formatting);
  let release;
  const draws = [];
  Object.assign(a.c, {
    fetchChartCached: () => new Promise((r) => {
      release = () => r({ ok: true, closes: [1, 2, 3], times: [1, 2, 3], volumes: [1, 1, 1] });
    }),
    err() {}, quoteErrText: () => '', renderPeriod() {}, renderMaChips() {}, renderCrossBadge() {},
    renderTrendBadges() {}, renderMaLegend() {}, drawChart: (d) => draws.push(d),
  });
  a.run(`state.watchlist = ${JSON.stringify([SAM])}; state.selected = '005930.KS'; state.timeframe = '1M';`);
  const loading = a.run('loadChart()');
  await a.c.removeSymbol('005930.KS');
  release();
  await loading;
  assert.equal(a.run('state.selected'), null);
  assert.equal(draws.length, 0, 'the late response for the removed stock is dropped');
});

// 설정 패널을 Esc 로 닫으면 패널만 닫혀야 한다. 패널의 Esc 처리가 이벤트를 문서까지 올려
// 보내면, 문서 쪽 단축키는 그때 이미 패널이 닫혀 있어 Esc 를 "위젯 접기" 로 처리한다.
// 입력칸은 문서 쪽이 원래 무시하므로 버튼(다크 · 라이트)에 포커스가 있을 때 생긴다.
await test('Esc closes the settings panel only — it does not also fold the widget', () => {
  const { c, run } = harness();
  let docKey = null;
  const folds = [];
  c.document.addEventListener = (type, fn) => { if (type === 'keydown') docKey = fn; };
  Object.assign(c, {
    searchEl: { hidden: true },
    rankEl: { hidden: true }, // 순위 패널(닫힘) — 문서 쪽 키 처리가 먼저 본다
    alertsEl: { hidden: false },
    closeAlerts: () => { c.alertsEl.hidden = true; },
    setCompact: (on) => folds.push(on),
    compact: false,
  });
  const listener = source.slice(mark("document.addEventListener('keydown', (e) => {"));
  run(listener.slice(0, listener.indexOf('\n});') + 4));
  run(source.match(/^\s*alertsEl\.onkeydown = .*$/m)[0]);
  // 패널 → 문서 순서로 올라간다. 패널이 전파를 멈추면 문서까지 가지 않는다
  const press = (key, target) => {
    let stopped = false;
    const e = { key, target, preventDefault() {}, stopPropagation() { stopped = true; } };
    c.alertsEl.onkeydown(e);
    if (!stopped) docKey(e);
  };
  press('Escape', { tagName: 'BUTTON' }); // 라이트 버튼을 누른 뒤 Esc
  assert.equal(c.alertsEl.hidden, true, 'the panel closes');
  assert.deepEqual(folds, [], 'the widget does not fold as well');

  // 패널이 닫힌 뒤의 Esc 는 패널을 거치지 않고 문서로 간다 — 지금처럼 접기다
  docKey({ key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.deepEqual(folds, [true]);
});

// 수렴 배지는 실데이터에서 아직 뜬 적이 없다 — 깨져도 "안 뜨는 게 정상" 처럼 보인다.
// 지지 100 + i · 저항 b − i 는 (b − 100) / 2 봉에서 만나고, 마지막 봉은 59 다.
await test('trend badges: convergence counts up from the last bar, hides when past or too far, and gives way to a breakout', () => {
  const { c, run, elements } = harness(['renderTrendBadges']);
  run(formatting);
  const toggled = [];
  for (const id of ['breakout', 'converge']) {
    c.document.getElementById(id).classList = { toggle: (k, on) => toggled.push([id, k, on]) };
  }
  const brk = elements.get('breakout');
  const conv = elements.get('converge');
  const ln = (varName, b, slope, broke = null) =>
    ({ varName, slope, from: 0, data: Array.from({ length: 60 }, (_, i) => b + slope * i), broke });
  const shown = (b) => {
    c.renderTrendBadges([ln('--sup-line', 100, 1), ln('--res-line', b, -1)], 60, []);
    return conv.hidden ? null : conv.textContent;
  };
  assert.equal(shown(222.6), '수렴 3거래일', '61.3봉 → 2.3봉 뒤 → 올림 3');
  assert.equal(shown(242), '수렴 12거래일 · 약 2주', '71봉 → 12거래일 ≈ 16.8일');
  assert.equal(shown(218), null, '마지막 봉(59)에서 이미 만났다');
  assert.equal(shown(200), null, '벌어지는 중 — 교차점이 과거(50봉)');
  assert.equal(shown(718), '수렴 250거래일 · 약 50주', '309봉 → 250거래일까지는 말한다');
  assert.equal(shown(720), null, '251거래일 — 사실상 평행선');
  assert.equal(brk.hidden, true);

  // 돌파가 있으면 수렴(여기선 12거래일)은 숨고 돌파만 말한다. 57봉 = 09-07 09:00 KST, 지금 09-10
  const times = [];
  times[57] = Date.parse('2026-09-07T00:00:00Z');
  c.renderTrendBadges([ln('--sup-line', 100, 1),
    ln('--res-line', 242, -1, { at: 57, gap: 9, pct: 0.0523 })], 60, times);
  assert.equal(conv.hidden, true);
  assert.equal(brk.hidden, false);
  assert.equal(brk.textContent, '저항 돌파 +5.23% · 3일 전');
  assert.deepEqual(toggled.at(-1), ['breakout', 'sup', false]);
});

// 추세 점검 줄 — 계산은 backtest.js(tests/backtest.mjs), 여기서는 그리기 · 캐시 · 숨김만 본다.
// 결과 모양을 고정하려고 trendCheck 를 바꿔 끼운다. 마지막 묶음만 진짜 계산을 돌린다.
const TREND = () => ({
  cut: false,
  rule: { start: 59, strat: { total: 0.41, cagr: 0.074, mdd: 0.18, entries: 12, trades: 24, inShare: 0.52 },
    hold: { total: 0.63, cagr: 0.108, mdd: 0.39 }, on: true, since: Date.parse('2026-08-07T00:00:00Z'),
    from: Date.parse('2022-01-04T00:00:00Z'), to: Date.parse('2026-09-09T00:00:00Z'),
    below: 124, verdict: 'same', nullMdd: 0.21, count: 200 },
  fast: { entries: 41, trades: 82, total: 0.12 },
  regime: { cls: 'up', up: true, at: Date.parse('2026-09-09T00:00:00Z'), fallback: false, count: 1000,
    days: 214, episodes: 9, windows: 10, med: 0.021, rise: 0.61, allMed: 0.008, allRise: 0.53, diff: 0.013,
    halves: [0.01, 0.02], verdict: 'same', lo: -0.044, hi: 0.036, paths: 200 },
});
const trendDaily = (n) => ({ closes: Array.from({ length: n }, (_, i) => 100 * 1.002 ** i),
  times: Array.from({ length: n }, (_, i) => Date.parse('2024-01-01T00:00:00Z') + i * 86400000) });

await test('trend check: one line + tooltip, verdict colour, hidden without data', () => {
  const { c, run, elements } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  let result = TREND();
  c.trendCheck = () => result;

  c.renderTrendCheck(null);
  assert.equal(el.hidden, true, '선택 없음');
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, true, '일봉을 아직 못 받음');

  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false);
  // 08-07 09:00 KST → 09-10 (하네스 시각) = 34일
  assert.equal(el.innerHTML, '정배열·20선↑ · 20선>60선 34일째 · 5년: <span>구분 안 됨</span>');
  const tip = el.title.split('\n');
  for (const line of [
    '20/60 규칙 — 20일선이 60일선 위면 보유, 아래면 정리',
    '종가로 판단 → 다음 날 종가에 체결 · 왕복 비용 0.25%',
    '기간 2022-01-04 ~ 2026-09-09',
    '규칙: 누적 +41.0% · 연 +7.4% · 최대 낙폭 -18.0% · 보유 52%',
    '그냥 보유: 누적 +63.0% · 연 +10.8% · 최대 낙폭 -39.0%',
    '시점만 밀어 만든 가짜 타이밍 200개 중 규칙보다 누적이 낮은 것 124개 → 구분 안 됨 (198개 이상이면 나음 · 2개 이하면 못함)',
    '가짜 타이밍의 최대 낙폭 중앙값 -21.0% (낙폭이 작은 건 덜 들고 있어서일 수 있음)',
    '진입 12회',
    '5/20 같은 규칙: 진입 41회 · 비용 합계 약 10% · 누적 +12.0%',
    '지금: 정배열(5>20>60>120) · 20일선 상승 — 09/09 종가 기준',
    '같은 상태였던 날 214일 (9구간 · 겹치지 않는 20일 묶음 10개)',
    '20거래일 뒤 중앙값 +2.1% · 오른 비율 61% (다음 날 종가 매수, 비용 차감)',
    '평소: +0.8% · 53% → 차이 +1.3%p',
    '가짜 주가 200개의 차이 범위 -4.4%p ~ +3.6%p 안 → 구분 안 됨',
  ]) assert.ok(tip.includes(line), `툴팁에 "${line}"`);
  // 우연과 예측력 — 2026-10-13 재검증: 효과 없는 규칙에서 판정이 4~5% 나오고, 앞 5년 순위로 뒤 5년 순위를 맞히지 못했다
  assert.deepEqual(tip.slice(-3), [
    '나음·못함은 규칙이 쓸모없어도 판정마다 20번에 1번꼴로 우연히 나옵니다',
    '지난 기간의 설명입니다 — 10년치로 해 보니 앞 5년 결과로 뒤 5년을 맞히지 못했습니다',
    '배당·세금·환전 제외 · 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽습니다 · 과거 통계이며 매매 권유가 아닙니다',
  ]);

  // 판정 색 — 나음 빨강(UP), 못함 파랑(DOWN). 새 결과를 보려면 캐시를 비운다.
  const redraw = (patch) => {
    result = TREND(); patch(result);
    run("delete trendCache['005930.KS'];");
    c.renderTrendCheck({ symbol: '005930.KS' });
    return el;
  };
  assert.match(redraw((r) => { r.rule.verdict = 'better'; r.rule.below = 199; }).innerHTML,
    /5년: <span style="color:#e24b4a">나음<\/span>$/);
  assert.match(redraw((r) => { r.rule.verdict = 'worse'; r.rule.below = 1; }).innerHTML,
    /5년: <span style="color:#185fa5">못함<\/span>$/);
  // 순위는 개수로 — "상위 99%" 가 못함에도 구분 안 됨에도 나왔다
  assert.ok(el.title.includes('시점만 밀어 만든 가짜 타이밍 200개 중 규칙보다 누적이 낮은 것 1개 → 못함 (198개 이상이면 나음 · 2개 이하면 못함)'));
  assert.ok(!el.title.includes('상위'));
  assert.ok(redraw((r) => { r.rule.verdict = 'better'; r.rule.below = 200; }).title.includes('낮은 것 200개 → 나음'));

  // 표본 부족 · 칸 넓히기 · 범위 밖인데 구분 안 됨
  redraw((r) => { r.rule.verdict = 'few'; r.rule.strat.entries = 4; r.rule.on = false; });
  assert.equal(el.innerHTML, '정배열·20선↑ · 20선<60선 34일째 · 5년: <span>표본 부족</span>');
  assert.ok(el.title.includes('진입 4회 — 적어서 판정하지 않음'));
  assert.ok(!el.title.includes('가짜 타이밍'));
  redraw((r) => { r.regime.verdict = 'few'; r.regime.fallback = true; r.regime.cls = 'mixDown'; r.regime.up = false; });
  assert.ok(el.innerHTML.startsWith('혼조·20선↓ · '));
  assert.ok(el.title.includes('지금: 혼조(20일선이 60일선 아래) · 20일선 하락 — 09/09 종가 기준'));
  assert.ok(el.title.includes('같은 배열·방향인 날이 적어 배열만으로 봄'));
  assert.ok(el.title.includes('같은 상태였던 날이 적어 판정하지 않음'));
  assert.ok(!el.title.includes('평소:'));
  // 판정은 빼도 표본이 얼마나 작았는지는 보인다 (스펙: 차이 · 범위 줄만 뺀다)
  assert.ok(el.title.includes('같은 상태였던 날 214일 (9구간 · 겹치지 않는 20일 묶음 10개)'));
  assert.ok(el.title.includes('20거래일 뒤 중앙값 +2.1% · 오른 비율 61% (다음 날 종가 매수, 비용 차감)'));
  assert.ok(!el.title.includes('가짜 주가'));
  redraw((r) => { Object.assign(r.regime, { verdict: 'few', days: 0, episodes: 0, windows: 0, med: null, rise: null, diff: null }); });
  assert.ok(el.title.includes('같은 상태였던 날 0일 (0구간 · 겹치지 않는 20일 묶음 0개)'));
  assert.ok(!el.title.includes('20거래일 뒤 중앙값'), '하루도 없으면 중앙값이 없다');
  redraw((r) => { r.regime.diff = 0.05; });
  assert.ok(el.title.includes('밖 → 구분 안 됨 (앞·뒤 절반의 방향이 달라)'));

  // 차이와 범위 끝이 소수 한 자리로 같게 보이면 왜 안/밖인지 안 보인다 — 그때만 둘째 자리까지.
  // 신한지주 2026-10-13: 차이 +3.18%p · 위쪽 끝 +3.21%p 가 둘 다 "+3.2%p" 로 나왔다.
  redraw((r) => { Object.assign(r.regime, { diff: 0.0318, lo: -0.0312, hi: 0.0321 }); });
  assert.ok(el.title.includes('평소: +0.8% · 53% → 차이 +3.18%p'));
  assert.ok(el.title.includes('가짜 주가 200개의 차이 범위 -3.12%p ~ +3.21%p 안 → 구분 안 됨'));
  redraw((r) => { Object.assign(r.regime, { diff: -0.0438, lo: -0.0442 }); });
  assert.ok(el.title.includes('평소: +0.8% · 53% → 차이 -4.38%p'));
  assert.ok(el.title.includes('가짜 주가 200개의 차이 범위 -4.42%p ~ +3.60%p 안 → 구분 안 됨'), '아래쪽 끝도');

  // Windows 의 Chromium 은 툴팁을 1024자에서 자른다(ui/views/corewm/tooltip_state_manager.cc kMaxTooltipLength).
  // 줄이 가장 길어지는 경우(이상 봉 뒤부터 · 배열만으로 봄 · 범위 밖인데 구분 안 됨 · 큰 숫자)에도 끝의 안내까지 보여야 한다.
  const longest = redraw((r) => {
    r.cut = true;
    Object.assign(r.regime, { fallback: true, diff: 0.05 });
    Object.assign(r.rule.strat, { total: 15.197, cagr: 0.251, mdd: 0.623 });
    Object.assign(r.rule.hold, { total: 17.664, cagr: 0.349, mdd: 0.541 });
  }).title;
  assert.ok(longest.length <= 1024 && longest.endsWith('매매 권유가 아닙니다'), `툴팁 ${longest.length}자`);

  // 줄의 기간은 실제로 쓴 기간이다 — 상장 2~5년 종목, 이상 봉 뒤부터 쓴 종목이 "5년" 으로 읽히지 않게
  assert.ok(redraw((r) => { r.rule.from = Date.parse('2024-09-09T00:00:00Z'); }).innerHTML.endsWith(' · 2년: <span>구분 안 됨</span>'));
  assert.ok(redraw((r) => { r.rule.from = Date.parse('2023-09-09T00:00:00Z'); }).innerHTML.endsWith(' · 3년: <span>구분 안 됨</span>'));
  // 문턱은 backtest.js 의 BT_JUMP(35%) — 상한가 · 하한가(±30%)는 자르지 않는다
  assert.ok(redraw((r) => { r.cut = true; }).title.includes('기간 2022-01-04 ~ 2026-09-09 (하루 35% 넘게 움직인 봉 뒤부터)'));

  // 짧은 종목은 숨기고, 이상 봉은 말한다
  assert.equal(redraw(() => {}).hidden, false);
  result = null; run("delete trendCache['005930.KS'];"); c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, true, '500봉 미만');
  result = { error: 'data' }; run("delete trendCache['005930.KS'];"); c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, '추세 점검: 데이터 확인 필요');
  assert.match(el.title, /^하루에 35% 넘게 움직인 봉이 있습니다/);
});

await test('trend check: recomputes only when the last confirmed bar changes; cost by market', () => {
  const { c, run } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  const calls = [];
  c.trendCheck = (symbol, closes, times, opts) => { calls.push({ symbol, n: closes.length, opts }); return TREND(); };
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  c.renderTrendCheck({ symbol: '005930.KS' }); // 30초 갱신
  run("dailyCache['005930.KS'].closes[599] *= 1.01;"); // 장중에는 마지막 봉만 움직인다
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(calls.length, 1, '마지막 확정 봉이 그대로면 다시 계산하지 않는다');
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(601))};`); // 다음 날 봉이 하나 늘었다
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(calls.length, 2);
  assert.deepEqual({ ...calls[0].opts }, { domestic: true, cost: 0.0025 });

  run(`dailyCache['^KS11'] = ${JSON.stringify(trendDaily(600))}; dailyCache['AAPL'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '^KS11' });
  assert.deepEqual({ ...calls.at(-1).opts }, { domestic: false, cost: 0.001 });
  assert.ok(el.title.includes('왕복 비용 0.10% (지수는 ETF 로 따라간다고 봄)'));
  c.renderTrendCheck({ symbol: 'AAPL' });
  assert.deepEqual({ ...calls.at(-1).opts }, { domestic: false, cost: 0.001 });
  assert.ok(el.title.includes('왕복 비용 0.10%') && !el.title.includes('지수는'));
});

// 추세 점검 계산이 예외를 내면 renderDetail 이 거기서 끊겨 합계 줄 · 차트까지 그 갱신에서 빠졌다.
// 줄만 숨기고 넘어가며, 같은 봉으로는 30초마다 다시 계산하지 않는다(실패도 캐시).
await test('trend check: a calculation error hides the line instead of stopping the refresh', () => {
  const { c, run, errors } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  let calls = 0;
  c.trendCheck = () => { calls++; throw new Error('boom'); };
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  assert.doesNotThrow(() => c.renderTrendCheck({ symbol: '005930.KS' }));
  assert.equal(el.hidden, true);
  assert.equal(errors.length, 1, 'console.error 로 남긴다');
  c.renderTrendCheck({ symbol: '005930.KS' }); // 30초 갱신
  assert.equal(calls, 1, '같은 확정 봉이면 다시 계산하지 않는다');
  c.trendCheck = () => TREND();
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(601))};`); // 다음 날 봉
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false, '새 확정 봉이 오면 다시 해 본다');
});

await test('trend check: real backtest on a steady climb says 정배열 and 표본 부족', () => {
  const { run, c } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  const el = c.document.getElementById('trendCheck');
  // 오르기만 하면 진입이 1회라 판정하지 않는다. 일수는 60일선이 처음 생긴 봉(2024-02-29)부터 하네스 시각까지.
  // 봉을 달력 하루 간격으로 만들어 쓴 기간이 538일 — 줄에는 "1년" 으로 나온다.
  assert.equal(el.innerHTML, '정배열·20선↑ · 20선>60선 924일째 · 1년: <span>표본 부족</span>');
  assert.ok(el.title.includes('진입 1회 — 적어서 판정하지 않음'));
});

// 보유 — 어떤 종목을 들고 있는지 목록에서 보이고, 상세에서 바로 넣고 고치며, 합계 줄이 무엇의 합인지 말한다.
// 이 하네스에는 진짜 DOM 이 없다. 그리는 글자와 상태만 보고, 버튼 · 키 연결은 tests/holdings.mjs(앱)가 본다.
const HOLD_FNS = ['parseAmount', 'amountText', 'holdingFrom', 'holdingPl', 'plColor', 'holdSub', 'renderHolding',
  'holdForm', 'startHoldEdit', 'saveHoldEdit', 'cancelHoldEdit', 'clearHolding', 'setHolding', 'redrawHolding'];
const holdHarness = (extra = []) => {
  const h = harness([...HOLD_FNS, ...extra]);
  h.run(formatting);
  const saved = [];
  Object.assign(h.c, { cssVar: () => '#888888', esc: String, save: () => saved.push(1), renderList() {},
    renderDetail: () => h.c.redrawHolding(), loadChart: async () => {} });
  if (!extra.includes('renderFolio')) h.c.renderFolio = async () => {};
  return { ...h, saved };
};

await test('holdings: amounts accept commas; both quantity and average price must be positive', () => {
  const { c } = holdHarness();
  assert.equal(c.parseAmount('206,000'), 206000);
  assert.equal(c.parseAmount(' 1,234.5 '), 1234.5);
  assert.ok(Number.isNaN(c.parseAmount('')));
  assert.ok(Number.isNaN(c.parseAmount('abc')));
  assert.deepEqual({ ...c.holdingFrom('10', '206,000') }, { qty: 10, avg: 206000 });
  assert.deepEqual({ ...c.holdingFrom('0.5', '182.35') }, { qty: 0.5, avg: 182.35 });
  for (const [q, a] of [['10', ''], ['', '100'], ['0', '100'], ['-1', '100'], ['1e400', '100'], ['10', '0']]) {
    assert.equal(c.holdingFrom(q, a), null, `${q} / ${a}`);
  }
  assert.equal(c.amountText(206000), '206,000');
  assert.equal(c.amountText(182.35), '182.35');
  assert.equal(c.amountText(0.5), '0.5');
});

await test('holdings: list row shows quantity and my return only for held stocks', () => {
  const { c, run } = holdHarness();
  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 } }; quotes['005930.KS'] = { price: 225000 };`);
  assert.equal(c.holdSub('005930.KS'), '<span class="hsub">10주 · <b style="color:#e24b4a">손익 +12.50%</b></span>');
  assert.equal(c.holdSub('000660.KS'), '', '보유가 아니면 아무것도 붙이지 않는다');
  run(`quotes['005930.KS'] = {};`);
  assert.equal(c.holdSub('005930.KS'), '<span class="hsub">10주</span>', '현재가가 없으면 수량만');
});

// 설정 백업 · 복원 — 설정 패널 맨 아래의 내보내기 · 불러오기. 파일 창 · 확인 창은 main 이 띄운다(tests/backup.mjs).
await test('backup: export saves the latest settings first and says what it saved; import reloads on success and explains a failure', async () => {
  const { c, elements } = harness(['exportBackup', 'importBackup']);
  const log = [];
  let reply;
  Object.assign(c, {
    save: async () => { log.push('save'); },
    location: { reload: () => log.push('reload') },
  });
  c.api.backupExport = async () => { log.push('export'); return reply; };
  c.api.backupImport = async () => { log.push('import'); return reply; };
  const msg = () => elements.get('backupMsg').textContent;

  reply = { ok: true, path: 'C:\\x\\stock-widget-backup-2026-10-16.json', counts: { watchlist: 5, holdings: 2, targets: 1 } };
  await c.exportBackup();
  assert.deepEqual(log.splice(0), ['save', 'export'], '마지막 변경까지 저장한 뒤 내보낸다');
  assert.equal(msg(), '저장했습니다 — stock-widget-backup-2026-10-16.json (관심종목 5개 · 보유 2개 · 목표가 1개)');
  reply = { ok: false, canceled: true };
  await c.exportBackup();
  assert.equal(msg(), '', '창을 닫았으면 아무 말도 하지 않는다');
  reply = { ok: false, error: '권한 없음' };
  await c.exportBackup();
  assert.equal(msg(), '저장하지 못했습니다 (권한 없음)');
  log.length = 0;

  reply = { ok: true, counts: { watchlist: 3, holdings: 1, targets: 0 }, before: 'C:\\x\\before.json' };
  await c.importBackup();
  assert.deepEqual(log.splice(0), ['import', 'reload'], '바꿨으면 처음부터 다시 그린다(시작할 때 설정을 거르는 규칙을 그대로 탄다)');
  reply = { ok: false, canceled: true };
  await c.importBackup();
  assert.deepEqual(log.splice(0), ['import']);
  assert.equal(msg(), '', '취소했으면 아무 말도 하지 않는다');
  reply = { ok: false, error: '백업 파일이 아닙니다(아는 설정이 없음)' };
  await c.importBackup();
  assert.equal(msg(), '불러오지 못했습니다 (백업 파일이 아닙니다(아는 설정이 없음))');
  assert.deepEqual(log.splice(0), ['import'], '실패하면 다시 그리지 않는다');
});

// 관심종목 일정 — 실적 발표(국내) · 배당락(미국)이 14일 안이면 이름 옆에 작게 D-day. 지표 화면을 열어야만 보이던 것.
await test('events: list chip counts days by the Korean date, shows the nearest event within 14 days, and skips past ones', () => {
  const { c, run } = harness(['eventBadge', 'eventChip']);
  c.esc = (s) => String(s).replace(/</g, '&lt;');
  const at = (kst) => Date.parse(`${kst}+09:00`);
  run(`eventCache.set('005930.KS', { at: 0, events: [{ kind: 'ir', title: '2026년 3분기 경영실적 발표', date: '2026-10-29' }] });
    eventCache.set('AAPL', { at: 0, events: [{ kind: 'exdiv', title: '배당락일', date: '2026-10-16' }] });
    eventCache.set('X', { at: 0, events: [{ kind: 'ir', title: '지난 일정', date: '2026-10-01' }, { kind: 'ir', title: '<b>먼 일정</b>', date: '2026-11-30' }] });`);
  const badge = (s, kst) => run(`JSON.stringify(eventBadge('${s}', ${at(kst)}))`);
  assert.equal(badge('005930.KS', '2026-10-16T09:00:00'), JSON.stringify({ label: '실적 D-13', title: '2026년 3분기 경영실적 발표 · 10/29' }));
  assert.equal(badge('005930.KS', '2026-10-15T23:59:00'), JSON.stringify({ label: '실적 D-14', title: '2026년 3분기 경영실적 발표 · 10/29' }), '14일까지');
  assert.equal(badge('005930.KS', '2026-10-14T23:59:00'), 'null', '15일 남으면 아직 없다');
  assert.equal(badge('005930.KS', '2026-10-16T00:01:00'), JSON.stringify({ label: '실적 D-13', title: '2026년 3분기 경영실적 발표 · 10/29' }),
    '한국 날짜로 센다(00:01 KST 는 UTC 로 전날)');
  assert.equal(badge('005930.KS', '2026-10-29T15:00:00'), JSON.stringify({ label: '실적 D-day', title: '2026년 3분기 경영실적 발표 · 10/29' }));
  assert.equal(badge('005930.KS', '2026-10-30T09:00:00'), 'null', '지난 일정은 없다');
  assert.equal(badge('AAPL', '2026-10-16T10:00:00'), JSON.stringify({ label: '배당락 D-day', title: '배당락일 · 10/16' }));
  assert.equal(badge('X', '2026-10-16T10:00:00'), 'null', '지난 것과 먼 것뿐이면 없다');
  assert.equal(badge('NONE', '2026-10-16T10:00:00'), 'null', '아직 안 받았으면 없다');
  run(`eventCache.get('X').events.push({ kind: 'exdiv', title: '배당락일', date: '2026-10-25' }, { kind: 'ir', title: '<b>가까운</b>', date: '2026-10-20' });`);
  assert.equal(JSON.parse(badge('X', '2026-10-16T10:00:00')).label, '실적 D-4', '가장 가까운 것');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => at('2026-10-16T10:00:00');
  assert.equal(run("eventChip('X')"), '<span class="evchip" title="&lt;b>가까운&lt;/b> · 10/20">실적 D-4</span>', '제목은 이스케이프');
  assert.equal(run("eventChip('NONE')"), '');
  c.Date.now = realNow;
  // 목록 줄은 이름 옆에 칩을 둔다(이름은 말줄임, 칩은 늘 보인다)
  assert.match(realFunction('renderList'), /<span class="nrow"><span class="name">\$\{esc\(item\.name\)\}<\/span>\$\{eventChip\(item\.symbol\)\}<\/span>/);
});

await test('events: the watchlist schedule is fetched one stock at a time, kept for six hours, retried after a failure, and redraws the list once', async () => {
  const { c, run } = harness(['loadEvents']);
  const asked = [];
  const fail = new Set(['000660.KS']);
  let lists = 0;
  c.api.events = async (s) => { asked.push(s); return fail.has(s) ? { ok: false, error: 'x' } : { ok: true, events: [{ kind: 'ir', title: s, date: '2026-10-29' }] }; };
  c.renderList = () => { lists++; };
  run("state.watchlist.push({ symbol: '^KS11', name: '코스피' });");
  await c.loadEvents();
  assert.deepEqual([...asked], ['005930.KS', '000660.KS'], '목록 순서대로, 지수는 묻지 않는다');
  assert.equal(lists, 1, '받은 것이 있으면 목록을 한 번 다시 그린다');
  assert.equal(run("eventCache.has('000660.KS')"), false, '실패는 기억하지 않는다');
  asked.length = 0;
  await c.loadEvents();
  assert.deepEqual([...asked], ['000660.KS'], '받아 둔 종목은 6시간 동안 다시 묻지 않고, 실패한 종목만 다시');
  assert.equal(lists, 1, '새로 받은 것이 없으면 다시 그리지 않는다');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + 6 * 3600000;
  asked.length = 0;
  fail.clear();
  await c.loadEvents();
  assert.deepEqual([...asked], ['005930.KS', '000660.KS'], '6시간이 지나면 다시');
  assert.equal(lists, 2);
  c.Date.now = realNow;
  // 받는 중에 또 부르면(30초 갱신이 겹치면) 그냥 돌아간다
  const pending = [];
  c.api.events = (s) => { asked.push(s); return new Promise((r) => pending.push(() => r({ ok: true, events: [] }))); };
  run('eventCache.clear();');
  asked.length = 0;
  const first = c.loadEvents();
  await c.loadEvents();
  assert.deepEqual([...asked], ['005930.KS'], '겹쳐 부르면 묻지 않는다');
  while (pending.length) { pending.shift()(); await new Promise((r) => setImmediate(r)); }
  await first;
  assert.match(realFunction('refreshAll'), /loadEvents\(\)\.catch\(console\.error\);/, '갱신마다 부르되 기다리지 않는다');
});

await test('holdings: detail adds, validates, edits, cancels and deletes; refresh keeps typed values', () => {
  const { c, run, elements, saved } = holdHarness();
  run(`quotes['005930.KS'] = { price: 225000 }; quotes['000660.KS'] = { price: 1520000 };`);
  c.renderHolding('005930.KS', 225000);
  const el = elements.get('hold');
  assert.equal(el.hidden, false);
  assert.equal(el.innerHTML, '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>');
  c.renderHolding('^KS11', 7000);
  assert.equal(el.hidden, true, '지수는 보유할 수 없다');

  run(`state.selected = '005930.KS';`);
  c.startHoldEdit('005930.KS');
  assert.equal(el.hidden, false);
  for (const s of ['class="hq"', 'placeholder="수량" value=""', 'class="ha"', 'placeholder="평단가" value=""',
    'data-act="save">저장', 'data-act="cancel">취소']) assert.ok(el.innerHTML.includes(s), s);
  assert.ok(!el.innerHTML.includes('삭제'), '새로 넣을 때는 지울 것이 없다');

  // 30초 갱신이 칸을 다시 그리면 치던 값이 날아간다
  el.innerHTML = 'TYPED';
  c.renderHolding('005930.KS', 226000);
  assert.equal(el.innerHTML, 'TYPED');

  c.saveHoldEdit('10', '');
  assert.equal(run(`state.holdings['005930.KS']`), undefined, '평단가가 없으면 저장하지 않는다');
  assert.equal(saved.length, 0);
  assert.ok(el.innerHTML.includes('<span class="hmsg">수량과 평단가를 모두 0보다 큰 숫자로 넣어 주세요</span>'));
  assert.ok(el.innerHTML.includes('placeholder="수량" value="10"'), '친 값은 남긴다');

  c.saveHoldEdit('10', '200,000');
  assert.deepEqual({ ...run(`state.holdings['005930.KS']`) }, { qty: 10, avg: 200000 });
  assert.equal(saved.length, 1);
  assert.equal(el.innerHTML, '<span class="hqty">10주</span><span>평단 200,000</span><span>평가 2,250,000</span>'
    + '<span class="hpl" style="color:#e24b4a">+250,000 (+12.50%)</span>'
    + '<button type="button" class="hedit" data-act="edit" title="보유 고치기">✎</button>');

  c.startHoldEdit('005930.KS');
  assert.ok(el.innerHTML.includes('placeholder="수량" value="10"') && el.innerHTML.includes('placeholder="평단가" value="200,000"'));
  assert.ok(el.innerHTML.includes('data-act="del">삭제'));
  c.saveHoldEdit('0', '200,000');
  assert.deepEqual({ ...run(`state.holdings['005930.KS']`) }, { qty: 10, avg: 200000 }, '잘못 넣어도 있던 보유는 지우지 않는다');
  assert.equal(saved.length, 1);
  c.cancelHoldEdit();
  assert.ok(el.innerHTML.startsWith('<span class="hqty">10주</span>'), 'Esc · 취소는 그대로 둔다');

  // 다른 종목을 고르면 입력은 취소된다
  c.startHoldEdit('005930.KS');
  c.renderHolding('000660.KS', 1520000);
  assert.equal(el.innerHTML, '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>');
  c.renderHolding('005930.KS', 225000);
  assert.ok(el.innerHTML.startsWith('<span class="hqty">'), '돌아와도 입력 칸이 아니다');

  c.clearHolding('005930.KS');
  assert.equal(run(`state.holdings['005930.KS']`), undefined);
  assert.equal(el.innerHTML, '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>');
});

await test('holdings: folio names its numbers and steps through total and each holding', async () => {
  const { c, run, elements } = holdHarness(['folioLines', 'renderFolio', 'showFolio', 'tickFolio']);
  c.usdKrw = async () => 1380;
  run(`state.watchlist.push({ symbol: 'AAPL', name: 'AAPL' });
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 }, '000660.KS': { qty: 2, avg: 1600000 }, AAPL: { qty: 5, avg: 180 } };
    quotes['005930.KS'] = { price: 225000 }; quotes['000660.KS'] = { price: 1520000 };
    quotes.AAPL = { price: 200, currency: 'USD' };`);
  await c.renderFolio();
  const box = elements.get('folio');
  const line = (cls, fn, fv, color, fp) => `<div class="${cls}"><span class="fn">${fn}</span><span class="fv">평가 ${fv}</span>`
    + `<span class="fp" style="color:${color}">손익 ${fp}</span></div>`;
  const UP = '#e24b4a', DOWN = '#185fa5';
  // 6,670,000 = 2,250,000 + 3,040,000 + $1,000 × 1,380 · 손익 228,000 / 6,442,000
  assert.equal(box.hidden, false);
  assert.equal(box.innerHTML, line('fline', '보유 3종목', '6,670,000', UP, '+228,000 (+3.54%)'));
  assert.equal(box.title, ['보유 3종목 · 평가 6,670,000 · 손익 +228,000 (+3.54%)',
    '삼성전자 10주 · 평가 2,250,000 · 손익 +250,000 (+12.50%)',
    'SK하이닉스 2주 · 평가 3,040,000 · 손익 -160,000 (-5.00%)',
    'AAPL 5주 · 평가 1,000.00 · 손익 +100.00 (+11.11%)',
    '환율 1,380원/$ (미국 주식은 이 값으로 합계에 넣음)'].join('\n'));

  c.tickFolio();
  assert.equal(box.innerHTML, line('fline in', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'));
  c.tickFolio();
  assert.equal(box.innerHTML, line('fline in', 'SK하이닉스 2주', '3,040,000', DOWN, '-160,000 (-5.00%)'));
  c.tickFolio();
  assert.equal(box.innerHTML, line('fline in', 'AAPL 5주', '1,000.00', UP, '+100.00 (+11.11%)'), '해외 종목은 달러로');
  c.tickFolio();
  assert.ok(box.innerHTML.includes('보유 3종목'), '다시 합계');

  run('folioHover = true;');
  c.tickFolio();
  assert.ok(box.innerHTML.includes('보유 3종목'), '마우스가 올라가 있으면 넘기지 않는다');
  run('folioHover = false;');
  c.tickFolio();
  await c.renderFolio(); // 30초 갱신
  assert.equal(box.innerHTML, line('fline', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'), '갱신해도 차례를 지킨다');

  // 하나뿐이면 그 종목 줄만 — "보유 1종목" 으로는 무엇을 들고 있는지 모른다
  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };`);
  await c.renderFolio();
  assert.equal(box.innerHTML, line('fline', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'));
  c.tickFolio();
  assert.equal(box.innerHTML, line('fline', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'));

  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 }, AAPL: { qty: 5, avg: 180 } };`);
  c.usdKrw = async () => null;
  await c.renderFolio();
  assert.equal(box.innerHTML, '<div class="fline"><span class="fn">보유 2종목</span>'
    + '<span class="fv">환율을 받지 못해 합계를 낼 수 없습니다</span></div>', '틀린 합계를 내놓지 않는다');

  run('state.holdings = {};');
  await c.renderFolio();
  assert.equal(box.hidden, true);
});

// 오늘 손익 — 보유 수량 × (현재가 - 전일 종가). 340px 줄에 이름 · 평가 · 손익 · 오늘 넷은 들어가지 않아(만 · 억으로
// 줄여도 넘쳤다) 오늘이 있으면 평가는 툴팁으로 뺀다. 전일 종가를 못 받은 종목이 섞이면 지금처럼 평가를 보인다.
await test('holdings: folio shows today\'s gain beside the total gain, moving the value into the tooltip', async () => {
  const { c, run, elements } = holdHarness(['folioLines', 'renderFolio', 'showFolio', 'tickFolio']);
  c.usdKrw = async () => 1380;
  run(`state.watchlist.push({ symbol: 'AAPL', name: 'AAPL' });
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 }, '000660.KS': { qty: 2, avg: 1600000 }, AAPL: { qty: 5, avg: 180 } };
    quotes['005930.KS'] = { price: 225000, prevClose: 220000 }; quotes['000660.KS'] = { price: 1520000, prevClose: 1500000 };
    quotes.AAPL = { price: 200, prevClose: 198, currency: 'USD' };`);
  await c.renderFolio();
  const box = elements.get('folio');
  const UP = '#e24b4a';
  // 오늘: 50,000 + 40,000 + $10 × 1,380 = 103,800 / 어제 평가 2,200,000 + 3,000,000 + $990 × 1,380 = 6,566,200 → +1.58%
  assert.equal(box.innerHTML, `<div class="fline"><span class="fn">보유 3종목</span><span class="fp" style="color:${UP}">손익 +228,000 (+3.54%)</span>`
    + `<span class="ft" style="color:${UP}">오늘 +103,800 (+1.58%)</span></div>`, '평가 대신 오늘');
  assert.equal(box.title, ['보유 3종목 · 평가 6,670,000 · 손익 +228,000 (+3.54%) · 오늘 +103,800 (+1.58%)',
    '삼성전자 10주 · 평가 2,250,000 · 손익 +250,000 (+12.50%) · 오늘 +50,000 (+2.27%)',
    'SK하이닉스 2주 · 평가 3,040,000 · 손익 -160,000 (-5.00%) · 오늘 +40,000 (+1.33%)',
    'AAPL 5주 · 평가 1,000.00 · 손익 +100.00 (+11.11%) · 오늘 +10.00 (+1.01%)',
    '환율 1,380원/$ (미국 주식은 이 값으로 합계에 넣음)',
    '오늘 = 전일 종가 대비 (장 시작 전에는 지난 장, 미국 프리 · 애프터마켓이면 그 가격)'].join('\n'), '평가는 툴팁에 남는다');
  c.tickFolio();
  c.tickFolio();
  assert.equal(box.innerHTML, '<div class="fline in"><span class="fn">SK하이닉스 2주</span><span class="fp" style="color:#185fa5">손익 -160,000 (-5.00%)</span>'
    + `<span class="ft" style="color:${UP}">오늘 +40,000 (+1.33%)</span></div>`, '종목 줄도 — 누적은 손실이어도 오늘은 이익일 수 있다');
  c.tickFolio();
  assert.match(box.innerHTML, /<span class="ft" style="color:#e24b4a">오늘 \+10\.00 \(\+1\.01%\)<\/span>/, '해외 종목은 달러로');

  // 전일 종가를 못 받은 종목이 있으면 합계의 오늘은 낼 수 없다 — 지금처럼 평가를 보인다. 받은 종목 줄은 오늘이 있다.
  run('delete quotes.AAPL.prevClose; folioAt = 0;');
  await c.renderFolio();
  assert.match(box.innerHTML, /<span class="fn">보유 3종목<\/span><span class="fv">평가 6,670,000<\/span>/);
  assert.doesNotMatch(box.innerHTML, /오늘/);
  assert.match(box.title, /삼성전자 10주 · 평가 2,250,000 · 손익 \+250,000 \(\+12\.50%\) · 오늘 \+50,000 \(\+2\.27%\)/);
  assert.match(box.title, /AAPL 5주 · 평가 1,000\.00 · 손익 \+100\.00 \(\+11\.11%\)$/m, '전일 종가가 없는 종목 줄은 오늘이 없다');

  // 하나뿐이면 그 종목 줄, 변동이 없으면 회색
  run("state.holdings = { '005930.KS': { qty: 10, avg: 200000 } }; quotes['005930.KS'] = { price: 220000, prevClose: 220000 };");
  await c.renderFolio();
  assert.match(box.innerHTML, /<span class="ft" style="color:#888888">오늘 0 \(0\.00%\)<\/span>/);
});

// 상세의 보유 · 52주 · 추세 점검 세 줄은 손잡이 한 줄로 접고 편다. 저장돼 다시 켜도 그대로다.
await test('info fold: the toggle folds hold · 52-week · trend lines and saves the choice', () => {
  const { c, run, elements } = harness(['applyInfoOpen', 'toggleInfo']);
  const saved = [];
  c.save = () => saved.push(run('state.infoOpen'));
  run('state.infoOpen = true;');
  c.applyInfoOpen();
  const btn = elements.get('infoToggle');
  assert.equal(btn.className, 'infotoggle');
  assert.equal(btn.ariaExpanded, 'true');
  assert.equal(btn.title, '보유 · 52주 · 추세 점검 접기');
  c.toggleInfo();
  assert.equal(run('state.infoOpen'), false);
  assert.deepEqual(saved, [false]);
  assert.equal(btn.className, 'infotoggle off', '.off 가 붙으면 CSS 가 세 줄을 숨긴다 (dom-contract)');
  assert.equal(btn.ariaExpanded, 'false');
  assert.equal(btn.title, '누르면 펼칩니다', '보이는 줄이 없으면 안내만');
  c.toggleInfo();
  assert.equal(run('state.infoOpen'), true);
  assert.deepEqual(saved, [false, true]);
  assert.equal(btn.className, 'infotoggle');
  assert.equal(btn.title, '보유 · 52주 · 추세 점검 접기');
});

// 접혀 있을 때 손잡이에 마우스를 올리면 세 줄에 보이던 내용을 툴팁으로 미리 본다.
// 52주는 52주 막대의 툴팁 글자를 그대로 쓴다 — 막대에 올렸을 때와 같은 말이다.
await test('info fold: the folded toggle\'s tooltip previews the visible lines', () => {
  const { c, run, elements } = harness(['infoTip', 'holdingPl']);
  run(formatting);
  run(`state.infoOpen = false; state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };
    quotes['005930.KS'] = { price: 225000 };`);
  const w52 = c.document.getElementById('w52');
  const tc = c.document.getElementById('trendCheck');
  Object.assign(w52, { hidden: false, title: '52주 최저 201,000 · 최고 312,000\n현재 225,000 — 저점 대비 +11.94%, 고점 대비 -27.88%' });
  Object.assign(tc, { hidden: false, textContent: '혼조·20선↓ · 20선>60선 378일째 · 5년: 구분 안 됨' });
  c.infoTip();
  const btn = elements.get('infoToggle');
  assert.equal(btn.title, [
    '보유 10주 · 평단 200,000 · 평가 2,250,000 · 손익 +250,000 (+12.50%)',
    '52주 최저 201,000 · 최고 312,000',
    '현재 225,000 — 저점 대비 +11.94%, 고점 대비 -27.88%',
    '추세 점검 혼조·20선↓ · 20선>60선 378일째 · 5년: 구분 안 됨',
    '', '누르면 펼칩니다'].join('\n'));

  // 숨은 줄은 빼고, 보유가 없으면 보유 줄도 없다. "데이터 확인 필요" 는 머리말이 겹치지 않게.
  run('state.holdings = {};');
  Object.assign(w52, { hidden: true });
  Object.assign(tc, { textContent: '추세 점검: 데이터 확인 필요' });
  c.infoTip();
  assert.equal(btn.title, '추세 점검: 데이터 확인 필요\n\n누르면 펼칩니다');
  // 현재가를 아직 못 받았으면 보유는 수량 · 평단만
  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 } }; quotes['005930.KS'] = {};`);
  Object.assign(tc, { hidden: true });
  c.infoTip();
  assert.equal(btn.title, '보유 10주 · 평단 200,000\n\n누르면 펼칩니다');
  // 지수에는 보유가 없다
  run(`state.selected = '^KS11'; state.holdings['^KS11'] = { qty: 1, avg: 1 };`);
  c.infoTip();
  assert.equal(btn.title, '누르면 펼칩니다');
  run('state.infoOpen = true;');
  c.infoTip();
  assert.equal(btn.title, '보유 · 52주 · 추세 점검 접기');
});

console.log(`PASS: ${passed} session UI test groups`);
