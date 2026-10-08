// Deterministic renderer session tests. No Electron, network, timers, or source patches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as indicators from '../indicators.js';

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
  Object.assign(c, indicators, {
    daysAgo: (ms, now = NOW) => indicators.daysAgo(ms, now),
  });
  const names = ['quoteSession', 'tradingState', 'isDomestic', 'pollingIsOpen', 'priceSessionOf',
    'renderUpdated', ...extra];
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
    isTrading:false,regularClose:102,fromClose:0,market:'NXT',source:'Naver',tradedAt:'2026-09-10T09:29:00Z'};
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
    renderHolding: () => {}, renderW52: () => {}, candleTag: () => '',
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
    renderHolding: () => {}, renderW52: () => {}, candleTag: () => '',
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
  for (const tf of ['1D', '1W', '1M', '3M', '1Y', '3Y']) assert.equal(c.validTimeframe(tf), tf);
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

console.log(`PASS: ${passed} session UI test groups`);
