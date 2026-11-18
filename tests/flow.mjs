import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const settle = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
const market = { ok: true,
  spotFlows: [{ date: '20261111', foreign: -100, final: true }, { date: '20261112', foreign: 0, final: false }],
  futFlows: [{ date: '20261112', foreign: 500, final: false }],
  intraday: {
    spot: [{ t: Date.parse('2026-11-12T09:00:00+09:00'), foreign: 0, individual: 100, institution: -100 },
      { t: Date.parse('2026-11-12T09:05:00+09:00'), foreign: -30, individual: 130, institution: -100 }],
    fut: [{ t: Date.parse('2026-11-12T09:05:00+09:00'), foreign: 25 }],
  }, errors: {},
};
// 외국인 수급의 긴 이력(market:flowHistory, 다음 금융) — 마지막 날 2026-11-13 에서 1M · 3M · 1Y · 3Y 를 자른다
const history = { ok: true, errors: {},
  spotFlows: [['20250110', 5], ['20251114', -40], ['20260814', 30], ['20261014', 10], ['20261015', -20], ['20261112', 70], ['20261113', -100]]
    .map(([date, foreign]) => ({ date, foreign, final: true })),
  futFlows: [{ date: '20261113', foreign: 9, final: true }] };
const stock = { ok: true, market: 'kr', trend: [
  { date: '20261112', foreign: 0, organ: null, individual: 50 },
  { date: '20261111', foreign: -20, organ: 30, individual: -10 },
] };

function harness() {
  const elements = new Map();
  const drawings = [];
  const requests = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, {
      open: false, hidden: true, textContent: '', innerHTML: '', value: '', disabled: false,
      get options() { return this.innerHTML.match(/<option/g) || []; }, // select 의 options — 그린 <option> 수만큼
      setAttribute(name, value) { this[name] = value; },
      showModal() { this.open = true; },
      close() { this.open = false; if (this.onclose) this.onclose(); },
      focus() {},
    });
    return elements.get(id);
  };
  class FakeChart {
    constructor(canvas, config) { this.config = config; drawings.push(this); }
    destroy() { this.destroyed = true; }
  }
  const api = {
    marketExtras: async () => { requests.push('market'); return market; },
    detail: async (symbol) => { requests.push(symbol); return stock; },
    flowHistory: async () => { requests.push('history'); return history; },
    intradayPast: async () => ({ days: {} }),
  };
  const context = vm.createContext({ document: { getElementById: get }, api, console,
    getComputedStyle: () => ({ getPropertyValue: () => '#aaaaaa' }), Chart: FakeChart,
    selectedItem: () => null,
  });
  for (const file of ['indicators.js', 'backtest.js', 'market-check.js', ...['state', 'format', 'rank', 'metrics'].map((name) => `renderer/${name}.js`)]) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  }
  const flowPath = new URL('../renderer/flow.js', import.meta.url);
  if (fs.existsSync(flowPath)) vm.runInContext(fs.readFileSync(flowPath, 'utf8'), context);
  const run = (script) => vm.runInContext(script, context);
  return { context, run, get, drawings, requests, api,
    data: (view, data) => { context.inputView = view; context.inputData = data; return run('flowData(inputView, inputData)'); },
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const tests = [
  ['일별 수급은 날짜 오름차순·억 원·0·잠정을 보존한다', () => {
    const app = harness();
    const input = { ...market, spotFlows: [...market.spotFlows].reverse() };
    const data = app.data({ kind: 'daily', key: 'SPOT' }, input);
    assert.equal(data.unit, '억 원');
    assert.deepEqual(plain(data.datasets[0].data), [-100, 0]);
    assert.deepEqual(plain(data.labels), ['11/11', '11/12 잠정']);
    assert.equal(input.spotFlows[0].date, '20261112');
    assert.deepEqual(plain(app.data({ kind: 'daily', key: 'FUTFLOW' }, market).datasets[0].data), [500]);
  }],
  ['종목 수급은 KRX 주식 수 세 주체를 표시하고 결측치를 0으로 바꾸지 않는다', () => {
    const app = harness();
    const data = app.data({ kind: 'stock', symbol: '005930.KS', name: '삼성전자' }, stock);
    assert.equal(data.unit, '주');
    assert.match(data.note, /KRX/);
    assert.deepEqual(plain(data.datasets.map((series) => [series.label, series.data])), [
      ['외국인', [-20, 0]], ['기관', [30, null]], ['개인', [-10, 50]],
    ]);
    const extended = { ...stock, trend: Array.from({ length: 25 }, (_, index) => ({ date: `202610${String(index + 1).padStart(2, '0')}`, foreign: index })) };
    assert.equal(app.data({ kind: 'stock' }, extended).labels.length, 20);
  }],
  ['장중 수급은 현물·선물·주체와 한국 기준 시각을 구분한다', () => {
    const app = harness();
    const data = app.data({ kind: 'intraday', key: 'INTRA_FOREIGN', venue: 'spot' }, market);
    assert.deepEqual(plain(data.labels), ['09:00', '09:05']);
    assert.deepEqual(plain(data.datasets[0].data), [0, -30]);
    assert.match(data.note, /2026-11-12/);
    assert.match(data.note, /잠정/);
    const future = app.data({ kind: 'intraday', key: 'INTRA_FOREIGN', venue: 'fut' }, market);
    assert.deepEqual(plain(future.datasets[0].data), [25]);
    assert.match(future.title, /선물/);
    assert.deepEqual(plain(app.data({ kind: 'intraday', key: 'INTRA_INST', venue: 'spot' }, market).datasets[0].data), [-100, -100]);
  }],
  ['빈 데이터·부분 실패·미지원 주체를 구분한다', () => {
    const app = harness();
    assert.equal(app.data({ kind: 'daily', key: 'SPOT' }, { ok: true, spotFlows: [] }).labels.length, 0);
    assert.match(app.data({ kind: 'daily', key: 'SPOT' }, { ok: true, errors: { spotFlows: 'HTTP 500' } }).error, /500/);
    assert.match(app.data({ kind: 'stock' }, { ok: false, error: '연결 실패' }).error, /연결 실패/);
    assert.equal(app.data({ kind: 'intraday', key: 'INTRA_PROGRAM' }, market).labels.length, 0);
  }],
  ['확대 창은 캐시를 재사용하고 선택 종목과 가격 차트를 변경하지 않는다', async () => {
    const app = harness();
    app.context.snapshot = market;
    app.run("state.selected = '005930.KS'; state.timeframe = '3M'; marketExtras = {at: Date.now(), d: snapshot}; openFlow({kind:'daily', key:'SPOT'})");
    assert.equal(app.get('flowDialog').open, true);
    assert.equal(app.requests.length, 0);
    assert.equal(app.drawings.length, 1);
    assert.equal(app.drawings[0].config.options.scales.y.beginAtZero, true);
    assert.equal(app.run('state.selected'), '005930.KS');
    assert.equal(app.run('state.timeframe'), '3M');
    app.run('closeFlow()');
    assert.equal(app.get('flowDialog').open, false);
    assert.equal(app.drawings[0].destroyed, true);
  }],
  ['조회 중 보기를 바꾸면 새 보기만 갱신하며 중복 요청을 보내지 않는다', async () => {
    const app = harness();
    let finish;
    app.api.marketExtras = () => { app.requests.push('market'); return new Promise((resolve) => { finish = resolve; }); };
    app.run("openFlow({kind:'daily', key:'SPOT'}); openFlow({kind:'daily', key:'FUTFLOW'})");
    assert.equal(app.requests.length, 1);
    assert.match(app.get('flowStatus').textContent, /불러오는 중/);
    finish(market);
    await settle();
    assert.match(app.get('flowTitle').textContent, /선물/);
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [500]);
  }],
  ['닫은 뒤 응답은 차트를 만들지 않고 다시 열면 캐시로 표시한다', async () => {
    const app = harness();
    let finish;
    app.api.detail = () => new Promise((resolve) => { finish = resolve; });
    app.run("openFlow({kind:'stock', symbol:'005930.KS', name:'삼성전자'}); closeFlow()");
    finish(stock);
    await settle();
    assert.equal(app.drawings.length, 0);
    app.run("openFlow({kind:'stock', symbol:'005930.KS', name:'삼성전자'})");
    assert.equal(app.drawings.length, 1);
  }],
  ['조회 실패 후 재시도하며 현물에서 빈 선물로 전환하면 옛 차트를 지운다', async () => {
    const app = harness();
    app.api.marketExtras = async () => ({ ok: false, error: 'HTTP 503' });
    app.run("openFlow({kind:'daily', key:'SPOT'})");
    await settle();
    assert.match(app.get('flowStatus').textContent, /503/);
    app.api.marketExtras = async () => ({ ...market, intraday: { ...market.intraday, fut: null } });
    await app.run('refreshFlow()');
    assert.equal(app.drawings.length, 1);
    app.run("openFlow({kind:'intraday', key:'INTRA_FOREIGN', venue:'spot'})");
    app.get('flowVenue').value = 'fut';
    app.run("flowView.venue = document.getElementById('flowVenue').value; renderFlow()");
    assert.equal(app.get('flowPlot').hidden, true);
    assert.equal(app.drawings.at(-1).destroyed, true);
    assert.match(app.get('flowStatus').textContent, /데이터가 없습니다/);
  }],
  ['장중 수급 — 앱이 모아 둔 날이 있으면 날짜를 골라 그날 것을 그린다(2026-11-18)', async () => {
    const app = harness();
    const past = { spot: [{ t: Date.parse('2026-11-11T09:01:00+09:00'), foreign: 10 }, { t: Date.parse('2026-11-11T15:30:00+09:00'), foreign: -40 }], fut: [] };
    app.api.intradayPast = async () => ({ days: { 20261110: past, 20261111: past, bad: past } });
    app.context.snapshot = market;
    app.run("bindFlow(); marketExtras = {at: Date.now(), d: snapshot}; openFlow({kind:'intraday', key:'INTRA_FOREIGN'})");
    const pick = app.get('flowDay');
    assert.equal(pick.hidden, true, '받기 전에는 숨긴다');
    await settle();
    assert.equal(pick.hidden, false);
    assert.equal(pick.innerHTML, '<option value="">오늘</option><option value="20261111">11/11</option><option value="20261110">11/10</option>', '최근 날이 위, 모양이 다른 키는 뺀다');
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [0, -30], '처음은 오늘(지표 화면의 값)');
    pick.onchange({ target: { value: '20261111' } });
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [10, -40]);
    assert.deepEqual(plain(app.drawings.at(-1).config.data.labels), ['09:01', '15:30']);
    assert.equal(app.requests.length, 0, '지난 날은 다시 받지 않는다');
    app.get('flowVenue').onchange({ target: { value: 'fut' } });
    assert.match(app.get('flowStatus').textContent, /데이터가 없습니다/, '그날 선물이 없으면 빈 차트');
    pick.onchange({ target: { value: '' } });
    app.get('flowVenue').onchange({ target: { value: 'spot' } });
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [0, -30], '오늘로 돌아온다');
    app.run("openFlow({kind:'daily', key:'SPOT'})");
    assert.equal(pick.hidden, true, '일별 수급에는 없다');
  }],
  ['프로그램 — 앱이 모아 둔 날별 값에 아직 모으지 않은 날의 지금 값(잠정)을 붙여 막대로(2026-11-18)', async () => {
    const app = harness();
    app.api.intradayPast = async () => ({ days: {}, program: { 20261110: -120.4, 20261111: 705 } });
    app.context.snapshot = { ...market, intraday: { ...market.intraday, program: 33.3, programDay: '20261112' } };
    app.run("bindFlow(); flowRange = '1M'; marketExtras = {at: Date.now(), d: snapshot}; openFlow({kind:'program', key:'INTRA_PROGRAM'})");
    await settle();
    const chart = app.drawings.at(-1).config;
    assert.equal(chart.type, 'bar');
    assert.deepEqual(plain(chart.data.labels), ['11/10', '11/11', '11/12 잠정'], '마지막으로 고른 기간(1M)으로 자르지 않는다');
    assert.deepEqual(plain(chart.data.datasets[0].data), [-120.4, 705, 33.3]);
    assert.equal(app.get('flowTitle').textContent, '프로그램 매매 일별 · 코스피');
    assert.equal(app.get('flowRange').hidden, true, '기간 버튼 없음 — 모아 둔 날 모두');
    assert.equal(app.get('flowVenue').hidden, true);
    assert.equal(app.requests.length, 0);
    app.context.snapshot2 = { ...market, intraday: { ...market.intraday, program: 1, programDay: '20261111' } };
    app.run('marketExtras = {at: Date.now(), d: snapshot2}; renderFlow()');
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [-120.4, 705], '이미 모아 둔 날이면 지금 값을 붙이지 않는다');
  }],
  ['장중 수급 — 모아 둔 날이 없으면 날짜 칸을 숨긴다', async () => {
    const app = harness();
    app.context.snapshot = market;
    app.run("marketExtras = {at: Date.now(), d: snapshot}; openFlow({kind:'intraday', key:'INTRA_FOREIGN'})");
    await settle();
    assert.equal(app.get('flowDay').hidden, true);
  }],
  ['일별 수급의 기간 — 마지막 날에서 그 개월 수만큼만, 1Y · 3Y 는 연/월 이름표', () => {
    const app = harness();
    const of = (range) => app.data({ kind: 'daily', key: 'SPOT', range }, history);
    assert.deepEqual(plain(of('1M').datasets[0].data), [10, -20, 70, -100], '10/13 까지는 뺀다(한 달치)');
    assert.deepEqual(plain(of('1M').labels), ['10/14', '10/15', '11/12', '11/13']);
    assert.match(of('1M').note, /다음 금융/);
    assert.equal(of('3M').labels.length, 5);
    assert.deepEqual(plain(of('1Y').labels), ['25/11', '26/08', '26/10', '26/10', '26/11', '26/11'], '가격 차트처럼 YY/MM');
    assert.deepEqual(plain(of('1Y').dates).slice(0, 2), ['2025-11-14', '2026-08-14'], '툴팁 제목은 날짜 전체');
    assert.equal(of('3Y').labels.length, 7);
    assert.equal(of('10d').labels.length, 7, '10일은 받은 그대로(자르지 않는다)');
    assert.match(of('10d').note, /네이버/);
    assert.equal(app.data({ kind: 'daily', key: 'SPOT' }, history).labels.length, 7, '기간이 없으면 10일처럼');
    assert.deepEqual(plain(app.data({ kind: 'daily', key: 'FUTFLOW', range: '1Y' }, history).datasets[0].data), [9]);
  }],
  ['기간 버튼 — 1M 이상은 긴 이력을 고를 때만 받고, 10일은 지표 화면의 값을 그대로 쓴다', async () => {
    const app = harness();
    app.context.snapshot = market;
    app.run("bindFlow(); marketExtras = {at: Date.now(), d: snapshot}; openFlow({kind:'daily', key:'SPOT'})");
    assert.equal(app.requests.length, 0, '10일은 받아 둔 값');
    assert.equal(app.get('flowRange').hidden, false);
    assert.equal(app.get('flowRange').innerHTML, '<button type="button" data-range="10d" class="on">10일</button><button type="button" data-range="1M">1M</button>'
      + '<button type="button" data-range="3M">3M</button><button type="button" data-range="1Y">1Y</button><button type="button" data-range="3Y">3Y</button>');
    const pick = (range) => app.get('flowRange').onclick({ target: { closest: () => ({ dataset: { range } }) } });
    pick('1M');
    assert.deepEqual(app.requests, ['history']);
    assert.match(app.get('flowStatus').textContent, /불러오는 중/);
    await settle();
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [10, -20, 70, -100]);
    assert.match(app.get('flowNote').textContent, /다음 금융/);
    assert.match(app.get('flowRange').innerHTML, /data-range="1M" class="on"/);
    pick('3Y');
    assert.deepEqual(app.requests, ['history'], '기간만 바꾸면 다시 받지 않는다');
    assert.equal(app.drawings.at(-1).config.data.labels.length, 7);
    assert.equal(app.drawings.at(-1).config.data.datasets[0].barPercentage, undefined, '막대가 적으면 틈을 둔다');
    pick('모르는 기간');
    assert.match(app.get('flowRange').innerHTML, /data-range="3Y" class="on"/, '모르는 기간은 무시');
    app.run("closeFlow(); openFlow({kind:'daily', key:'FUTFLOW'})");
    assert.match(app.get('flowRange').innerHTML, /data-range="3Y" class="on"/, '마지막으로 고른 기간으로 연다');
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [9]);
    pick('10d');
    assert.deepEqual(plain(app.drawings.at(-1).config.data.datasets[0].data), [500], '10일은 다시 지표 화면의 값(네이버)');
    assert.match(app.get('flowNote').textContent, /네이버/);
    app.run("openFlow({kind:'intraday', key:'INTRA_FOREIGN'})");
    assert.equal(app.get('flowRange').hidden, true, '장중 · 종목 수급에는 기간 버튼이 없다');
    assert.equal(app.get('flowRange').innerHTML, '');
  }],
  ['긴 이력을 다시 받다 실패하면 있던 것을 그리고 이유를 적는다, 막대가 많으면 틈 없이', async () => {
    const app = harness();
    const many = { ok: true, errors: {}, spotFlows: Array.from({ length: 40 }, (_, i) => ({ date: `202610${String(i % 28 + 1).padStart(2, '0')}`, foreign: i, final: true }))
      .filter((row, i, all) => all.findIndex((x) => x.date === row.date) === i), futFlows: [] };
    app.api.flowHistory = async () => many;
    app.run("openFlow({kind:'daily', key:'SPOT', range:'3Y'})");
    assert.equal(app.drawings.length, 0, '아직 못 받았다');
    await settle();
    assert.equal(app.drawings.length, 1);
    app.api.flowHistory = async () => ({ ok: false, error: 'HTTP 503' });
    await app.run('loadFlowHistory()');
    assert.match(app.get('flowStatus').textContent, /503.*이전 데이터를 표시합니다/);
    assert.equal(app.get('flowPlot').hidden, false);
    app.api.flowHistory = async () => ({ ...many, spotFlows: Array.from({ length: 31 }, (_, i) => ({ date: String(20260101 + i), foreign: i, final: true })) });
    await app.run('loadFlowHistory()');
    assert.equal(app.drawings.at(-1).config.data.datasets[0].barPercentage, 1, '30개가 넘으면 막대를 붙인다(흐려지지 않게)');
    assert.equal(app.get('flowStatus').hidden, true);
  }],
];

let fails = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`OK   ${name}`); }
  catch (error) { fails++; console.log(`FAIL ${name}: ${error.message}`); }
}
console.log(`\n${fails ? 'FAIL' : 'PASS'}: 실패 ${fails}건`);
process.exitCode = fails ? 1 : 0;
