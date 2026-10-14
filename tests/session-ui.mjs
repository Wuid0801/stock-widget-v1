// Deterministic renderer session tests. No Electron, network, timers, or source patches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as indicators from '../indicators.js';
import * as backtest from '../backtest.js';

const source = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const prelude = source.slice(0, source.indexOf('// 과열도 5단계'));
// 가격 포맷(fmt · money · curOf …). 화살표 함수라 realFunction 으로 못 꺼내 구획째 넣는다.
const formatting = source.slice(source.indexOf('// --- 포맷'), source.indexOf('// 색은 CSS 변수'));
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
  });
  const names = ['quoteSession', 'tradingState', 'isDomestic', 'pollingIsOpen', 'priceSessionOf',
    'renderUpdated', 'intradayEnd', 'kstClockMs', 'infoTip', ...extra];
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

await test('index line marks the selected index and only known indices are clickable', () => {
  const { c, run, elements } = harness(['renderIndices']);
  run(formatting);
  run(source.match(/^let indexItems = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '^KQ11'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, pct: 0.46 },
    { code: 'KOSDAQ', name: '코스닥', value: 893.29, pct: -0.11 },
    { code: 'KPI200', name: '코스피200', value: 950, pct: 0 }];`);
  c.renderIndices();
  const box = elements.get('indices');
  assert.equal(box.hidden, false);
  assert.match(box.innerHTML, /<span class="ix" data-symbol="\^KS11" title="코스피 차트 보기">/);
  assert.match(box.innerHTML, /<span class="ix on" data-symbol="\^KQ11" title="코스닥 차트 보기">/);
  assert.match(box.innerHTML, /<span class="ix"><span class="ixn">코스피200/, 'unknown index is shown but not clickable');
  assert.match(box.innerHTML, /7,003\.74/);
  run('indexItems = [];');
  c.renderIndices();
  assert.equal(box.hidden, true, 'no indices → the line hides (Naver failure)');
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
    candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
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
    candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {},
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
  await d.refresh(); // 0초 — 다 받는다(종목 3 + 지수 2)
  assert.equal(d.calls.length, 5);
  up = false;
  d.calls.length = 0;
  for (const sec of [120, 150, 180, 210]) { d.at(sec); await d.refresh(); } // 캐시 만료(60초) 뒤 네 번
  assert.equal(d.calls.length, 4, `one request per refresh, not 5 — got ${d.calls.join(',')}`);
  assert.equal(new Set(d.calls).size, 4, 'each refresh tries a different symbol — the failed ones rest');
  up = true;
  d.calls.length = 0;
  d.at(210 + 301); await d.refresh(); // 마지막 실패에서 5분 지남 — 모두 다시 받는다
  assert.equal(d.calls.length, 5, 'after the rest every symbol fetches again');
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
    alertsEl: { hidden: false },
    closeAlerts: () => { c.alertsEl.hidden = true; },
    setCompact: (on) => folds.push(on),
    compact: false,
  });
  const listener = source.slice(source.indexOf("document.addEventListener('keydown', (e) => {"));
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
  assert.equal(el.innerHTML, '정배열·20선↑ · 20/60 보유 34일째 · 5년: <span>구분 안 됨</span>');
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
  assert.equal(el.innerHTML, '정배열·20선↑ · 20/60 정리 34일째 · 5년: <span>표본 부족</span>');
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

await test('trend check: real backtest on a steady climb says 정배열 and 표본 부족', () => {
  const { run, c } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  const el = c.document.getElementById('trendCheck');
  // 오르기만 하면 진입이 1회라 판정하지 않는다. 일수는 60일선이 처음 생긴 봉(2024-02-29)부터 하네스 시각까지.
  // 봉을 달력 하루 간격으로 만들어 쓴 기간이 538일 — 줄에는 "1년" 으로 나온다.
  assert.equal(el.innerHTML, '정배열·20선↑ · 20/60 보유 924일째 · 1년: <span>표본 부족</span>');
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
  Object.assign(tc, { hidden: false, textContent: '혼조·20선↓ · 20/60 보유 378일째 · 5년: 구분 안 됨' });
  c.infoTip();
  const btn = elements.get('infoToggle');
  assert.equal(btn.title, [
    '보유 10주 · 평단 200,000 · 평가 2,250,000 · 손익 +250,000 (+12.50%)',
    '52주 최저 201,000 · 최고 312,000',
    '현재 225,000 — 저점 대비 +11.94%, 고점 대비 -27.88%',
    '추세 점검 혼조·20선↓ · 20/60 보유 378일째 · 5년: 구분 안 됨',
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
