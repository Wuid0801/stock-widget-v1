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

await test('alert text shows the stock currency, not always 원', () => {
  const { c, run, notifications } = harness(['checkAlerts']);
  run(formatting);
  run(`state.watchlist = [{symbol:'005930.KS',name:'삼성전자'},{symbol:'AAPL',name:'Apple'}];
    state.alerts.targets = {'005930.KS':{up:300000}, AAPL:{down:180}};
    quotes['005930.KS'] = {price:301000,currency:'KRW'};
    quotes.AAPL = {price:179.5,currency:'USD'};`);
  c.checkAlerts({'005930.KS':299000, AAPL:182.25});
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((n) => n.body), [
    '301,000원 (목표 300,000원)',
    '179.50 USD (목표 180.00 USD)',
  ]);
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
});

console.log(`PASS: ${passed} session UI test groups`);
