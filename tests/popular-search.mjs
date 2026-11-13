import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const popular = { ok: true, items: [
  { symbol: '005930.KS', name: '삼성전자', currency: 'KRW' },
  { symbol: '000660.KS', name: 'SK하이닉스', currency: 'KRW' },
] };
const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

function harness(rankReply = async () => popular) {
  const elements = new Map();
  const calls = [];
  const selections = [];
  const additions = [];
  const element = () => ({
    hidden: true, value: '', textContent: '', children: [], className: '',
    get innerHTML() { return this.markup || ''; },
    set innerHTML(value) { this.markup = value; this.children = []; },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
    focus() {},
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element,
  };
  const api = {
    rank: async (request) => { calls.push(request); return rankReply(); },
    search: async (query) => ({ ok: true, items: [{ symbol: 'AAPL', name: query, market: 'NASDAQ' }] }),
  };
  const context = vm.createContext({ document, api, console, setTimeout, clearTimeout,
    compact: false, setCompact() {}, select: async (symbol) => selections.push(symbol),
    addSymbol: async (item) => additions.push(item),
  });
  for (const file of ['indicators.js', 'backtest.js', 'market-check.js', ...['state', 'format', 'rank', 'search'].map((name) => `renderer/${name}.js`)]) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  }
  const run = (script) => vm.runInContext(script, context);
  return { context, run, api, calls, selections, additions, get: document.getElementById,
    hits: () => document.getElementById('results').children };
}

const tests = [
  ['검색창 진입과 빈 검색은 인기 목록을 표시하고 순위 캐시를 공유한다', async () => {
    const app = harness();
    app.run('openSearch()');
    await settle();
    assert.deepEqual(app.hits().map((hit) => hit.innerHTML.includes('삼성전자')), [true, false]);
    assert.equal(app.calls.length, 1);
    app.run('closeSearch(); openSearch()');
    await settle();
    assert.equal(app.calls.length, 1);
    app.get('q').value = '애플';
    await app.run('runSearch()');
    assert.match(app.hits()[0].innerHTML, /애플/);
    app.get('q').value = '';
    await app.run('runSearch()');
    assert.match(app.hits()[0].innerHTML, /삼성전자/);
  }],
  ['진행 중인 순위 요청이 있어도 완료 후 인기 검색을 표시한다', async () => {
    let finish;
    const app = harness(() => new Promise((resolve) => { finish = resolve; }));
    app.run("loadRank('kr', 'search'); openSearch()");
    assert.equal(app.calls.length, 1);
    finish(popular);
    await settle();
    assert.match(app.hits()[0].innerHTML, /삼성전자/);
  }],
  ['늦은 인기 검색은 입력한 검색 결과를 덮어쓰지 않는다', async () => {
    let finish;
    const app = harness(() => new Promise((resolve) => { finish = resolve; }));
    app.run('openSearch()');
    app.get('q').value = '애플';
    await app.run('runSearch()');
    finish(popular);
    await settle();
    assert.match(app.hits()[0].innerHTML, /애플/);
  }],
  ['검색을 비우거나 닫으면 지연 검색 응답을 무시한다', async () => {
    const app = harness();
    app.run('openSearch()');
    await settle();
    let finish;
    app.api.search = () => new Promise((resolve) => { finish = resolve; });
    app.get('q').value = '애플';
    const pending = app.run('runSearch()');
    app.get('q').value = '';
    await app.run('runSearch()');
    finish({ ok: true, items: [{ symbol: 'AAPL', name: '옛 결과', market: 'NASDAQ' }] });
    await pending;
    assert.match(app.hits()[0].innerHTML, /삼성전자/);
    app.get('q').value = '애플';
    const closed = app.run('runSearch()');
    app.run('closeSearch()');
    const before = app.hits().map((hit) => hit.innerHTML);
    finish({ ok: true, items: [{ symbol: 'AAPL', name: '닫은 뒤 결과', market: 'NASDAQ' }] });
    await closed;
    assert.deepEqual(app.hits().map((hit) => hit.innerHTML), before);
  }],
  ['인기 검색 실패와 빈 목록은 안내하고 일반 검색은 계속 가능하다', async () => {
    for (const reply of [{ ok: false, error: '연결 실패' }, { ok: true, items: [] }]) {
      const app = harness(async () => reply);
      app.run('openSearch()');
      await settle();
      assert.equal(app.hits().length, 0);
      assert.match(app.get('qhint').textContent, /인기 검색/);
      app.get('q').value = '애플';
      await app.run('runSearch()');
      assert.match(app.hits()[0].innerHTML, /애플/);
    }
  }],
  ['이미 추가한 인기 종목은 이동하고 새 종목은 추가한다', async () => {
    const app = harness();
    app.run("state.watchlist = [{symbol: '005930.KS', name: '삼성전자'}]; openSearch()");
    await settle();
    assert.match(app.hits()[0].innerHTML, /추가됨/);
    await app.hits()[0].onclick();
    assert.deepEqual(app.selections, ['005930.KS']);
    app.run('openSearch()');
    await settle();
    await app.hits()[1].onclick();
    assert.equal(app.additions[0].symbol, '000660.KS');
  }],
];

let fails = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`OK   ${name}`); }
  catch (error) { fails++; console.log(`FAIL ${name}: ${error.message}`); }
}
console.log(`\n${fails ? 'FAIL' : 'PASS'}: 실패 ${fails}건`);
process.exitCode = fails ? 1 : 0;
