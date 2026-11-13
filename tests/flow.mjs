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
];

let fails = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`OK   ${name}`); }
  catch (error) { fails++; console.log(`FAIL ${name}: ${error.message}`); }
}
console.log(`\n${fails ? 'FAIL' : 'PASS'}: 실패 ${fails}건`);
process.exitCode = fails ? 1 : 0;
