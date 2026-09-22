// Deterministic renderer session tests. No Electron, network, timers, or source patches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const prelude = source.slice(0, source.indexOf('// --- RSI(14)'));
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

await test('loadQuote carries metadata, zero close delta, timestamp, and delayed fallback', async () => {
  const { c, run } = harness(['loadQuote', 'calcRSI']);
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
  // loadChart calls these on every render (candleOf/daysAgo once it reaches 1M),
  // so pull the real ones in.
  const { c, run } = harness(['loadChart', 'confirmedCrosses', 'candleOf', 'daysAgo', 'midnightOf']);
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
  const { c, run } = harness(['loadChart', 'confirmedCrosses', 'candleOf', 'daysAgo', 'midnightOf']);
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
      candle: { open: 99, high: 106, low: 95 } };`);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 105], 'last close becomes the live price');
  assert.deepEqual(draws.at(-1).highs, [99, 106], 'last high becomes the live high');
  assert.deepEqual(draws.at(-1).lows, [96, 95], 'last low becomes the live low');

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

await test('alerts use per-symbol trading state; legacy price-only alerts remain compatible', () => {
  const { c, run, notifications } = harness(['checkAlerts']);
  c.fmt = String;
  run(`state.alerts.targets = {'005930.KS':{up:100},'000660.KS':{up:100}};
    quotes['000660.KS'] = {price:101,session:'after',isTrading:true};`);
  const prev = {'005930.KS':99,'000660.KS':99};
  for (const meta of ["session:'closed',isTrading:false", "session:'unknown',isTrading:null",
    "session:'regular',isTrading:null", "session:'closed'", "open:false"]) {
    run(`quotes['005930.KS'] = {price:101,${meta}};`);
    notifications.length = 0;
    c.checkAlerts(prev);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /SK하이닉스/);
  }
  for (const meta of ['', ",session:'pre',open:false", ",session:'after',isTrading:true"]) {
    run(`quotes['005930.KS'] = {price:101${meta}};`);
    notifications.length = 0;
    c.checkAlerts(prev);
    assert.equal(notifications.length, 2);
  }
  notifications.length = 0;
  run('marketOpen = false;');
  c.checkAlerts(prev);
  assert.equal(notifications.length, 0, 'legacy global disable is respected');
  run(`marketOpen = true; state.watchlist = [{symbol:'AAPL',name:'Apple'}];
    state.alerts.targets = {AAPL:{up:100}}; quotes.AAPL = {price:101,session:'unknown',isTrading:null};`);
  c.checkAlerts({AAPL:99});
  assert.equal(notifications.length, 1, 'domestic restrictions do not block foreign alerts');
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

console.log(`PASS: ${passed} session UI test groups`);
