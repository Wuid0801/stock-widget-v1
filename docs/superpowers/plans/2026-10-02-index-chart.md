# 코스피 · 코스닥 지수 차트 Implementation Plan

> **완료된 계획입니다.** 구현은 끝났고 아래 체크박스는 갱신하지 않았습니다 — 남은 작업이 아닙니다(2026-10-21 확인).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상단 지수 줄의 코스피 · 코스닥을 누르면 관심종목처럼 "선택"되어 상세 헤더와 차트가 그 지수로 바뀐다.

**Architecture:** 지수를 야후 기호(`^KS11` · `^KQ11`)로 부르고 `state.selected` 에 종목처럼 넣는다. 선택 대상을 찾는 곳(`renderDetail` · `loadChart`)은 `selectedItem()` 하나로 관심종목 또는 지수를 받는다. 지수 시세는 이미 30초마다 받는 네이버 지수 실시간 값을 종목 실시간 시세 모양(`indexLive`)으로 바꿔 기존 `loadQuote` 에 넣으므로 RSI · 52주 · 이동평균 · 차트가 종목과 같은 경로로 동작한다.

**Tech Stack:** Electron 43 (main · preload · renderer, `contextIsolation`), Chart.js 4.5.1, 클래식 스크립트 `renderer.js`, Node 내장 모듈만 쓰는 `.mjs` 테스트 스위트.

**Spec:** `docs/superpowers/specs/2026-10-02-index-chart-design.md`

## Global Constraints

- 브랜치 `feat/index-chart`. 새 의존성 없음.
- 커밋 메시지: `type(scope): 한글 subject` + 한글 본문. `Co-Authored-By` 트레일러를 넣지 않는다.
- 검증은 `node --check` 와 **앱을 띄우지 않는 스위트**만. 앱 실행 · `npm test` 는 하지 않는다(사용자가 직접 본다).
- 스위트는 `TZ=Asia/Seoul` 로 돌린다(CI 와 같다).
- 작업 사본의 파일들은 CRLF 다. 고칠 때는 Edit 도구를 쓴다 — `sed -i` 는 줄 끝을 LF 로 바꾼다.
- 코드 주석은 주변처럼 한국어로, 왜 그렇게 하는지를 쓴다.
- 지수 기호: 코스피 `^KS11` (네이버 `KOSPI`), 코스닥 `^KQ11` (네이버 `KOSDAQ`).
- 지수의 통화 자리는 `'pt'`. `money` 가 원화가 아니면 소수 둘째 자리로 쓴다.

## Review Focus

1. 네이버 지수 응답에 일부 값(전일 대비 · 시가 등)이 빠진 경우 — 값은 그대로 보이고 빠진 값은 `null`, 전일 대비가 없으면 실시간 없이(야후 20분지연) 다룬다. → Task 1 (`quote:indices` 빠진 값 `null`), Task 2 (`indexLive` 가 `undefined`).
2. 네이버 지수 조회가 실패한 동안 지수를 보고 있는 경우 — 지수 줄은 숨고 헤더는 야후 값으로 계속 보인다. → Task 3 (`refreshAll` 이 받지 못한 지수를 `loadQuote(지수, undefined)` 로).
3. 종목을 확대해 둔 상태에서 지수를 누르는 경우 — 확대가 모든 기간에서 풀린다. → Task 3 (`select` 테스트).
4. 네이버가 모르는 지수 코드를 함께 보내는 경우 — 줄에는 보이되 누를 수 없다. → Task 3 (`renderIndices` 테스트).
5. 관심종목이 비어 있고 지수를 보던 중 재시작하는 경우 — 지수가 그대로 선택된다. → Task 4 (`validSelection` 테스트).

---

### Task 1: `main.js` — 지수 응답 필드와 `^` 기호

**Files:**
- Modify: `main.js` — `ipcMain.handle('quote:indices', …)` (지금 314행 부근), `const SYMBOL_RE` (지금 408행 부근)
- Create: `tests/index-main.mjs`
- Create: `tests/fixtures/naver-index-20261002.json`
- Modify: `tests/run.mjs` (`ORDER`), `.github/workflows/test.yml`, `docs/DEVELOPMENT.md` (CI 절의 스위트 수 · 목록)

**Interfaces:**
- Produces: `api.indices()` 결과 `{ ok: true, items: [{ code, name, value, change, pct, open, high, low, isOpen, tradedAt }] }` — `code` 는 `'KOSPI'` · `'KOSDAQ'`, `change` · `open` · `high` · `low` 는 숫자 또는 `null`, `isOpen` 은 boolean, `tradedAt` 은 ISO 문자열 또는 `null`. 키 순서도 이대로.
- Produces: `yf:chart` 가 `'^KS11'` · `'^KQ11'` 을 받는다.

- [ ] **Step 1: 픽스처를 만든다**

`tests/fixtures/naver-index-20261002.json` (2026-10-02 15:37 KST 실제 응답에서 필요한 필드만 남긴 것):

```json
{
  "datas": [
    {
      "itemCode": "KOSPI",
      "stockName": "코스피",
      "closePrice": "7,003.74",
      "closePriceRaw": "7003.74",
      "compareToPreviousClosePrice": "32.39",
      "compareToPreviousClosePriceRaw": "32.39",
      "compareToPreviousPrice": { "code": "2", "text": "상승", "name": "RISING" },
      "fluctuationsRatio": "0.46",
      "fluctuationsRatioRaw": "0.46",
      "openPrice": "6,938.27",
      "openPriceRaw": "6938.27",
      "highPrice": "7,011.04",
      "highPriceRaw": "7011.04",
      "lowPrice": "6,927.88",
      "lowPriceRaw": "6927.88",
      "marketStatus": "CLOSE",
      "localTradedAt": "2026-10-02T15:37:00+09:00"
    },
    {
      "itemCode": "KOSDAQ",
      "stockName": "코스닥",
      "closePrice": "893.29",
      "closePriceRaw": "893.29",
      "compareToPreviousClosePrice": "-1.00",
      "compareToPreviousClosePriceRaw": "-1.00",
      "compareToPreviousPrice": { "code": "5", "text": "하락", "name": "FALLING" },
      "fluctuationsRatio": "-0.11",
      "fluctuationsRatioRaw": "-0.11",
      "openPrice": "893.22",
      "openPriceRaw": "893.22",
      "highPrice": "903.88",
      "highPriceRaw": "903.88",
      "lowPrice": "885.65",
      "lowPriceRaw": "885.65",
      "marketStatus": "CLOSE",
      "localTradedAt": "2026-10-02T15:37:00+09:00"
    }
  ]
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`tests/index-main.mjs`:

```js
// main.js 의 지수 쪽 — 앱을 띄우지 않고 가짜 electron 으로 main.js 를 불러 본다.
//
// 1) 차트 요청의 기호 검사가 야후 지수 기호(^KS11 코스피 · ^KQ11 코스닥)를 받는다.
//    ^ 는 맨 앞 한 번만 — 그 밖의 모양은 지금처럼 URL 에 닿기 전에 거절한다.
// 2) quote:indices 가 지수 헤더에 필요한 값(전일 대비 · 시 · 고 · 저 · 장 상태 · 시각)을 꺼낸다.
//    저장해 둔 네이버 응답(2026-10-02 15:37, 장 마감 직후 — 코스피 상승 · 코스닥 하락)을 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/naver-index-20261002.json', import.meta.url), 'utf8'));

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// electron 은 필요한 만큼만 흉내 낸다. 창은 만들지 않는다(whenReady 가 끝나지 않는다).
const handlers = {};
const electron = {
  app: { getPath: () => '', whenReady: () => new Promise(() => {}), on() {}, requestSingleInstanceLock: () => true },
  BrowserWindow: class {}, screen: {}, globalShortcut: {}, Notification: {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
};
const modules = {
  electron,
  'electron-store': class { get() {} set() {} },
  path,
  './quote-session.cjs': createRequire(import.meta.url)('../quote-session.cjs'),
};
const require = (m) => {
  if (!(m in modules)) throw new Error(`main.js 가 예상하지 못한 모듈을 부른다: ${m}`);
  return modules[m];
};

// 지수 주소면 픽스처, 아니면 봉 하나짜리 야후 차트를 돌려준다. 받은 주소를 기록한다.
let indexBody = fixture;
const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(String(url));
  const body = String(url).includes('/index/') ? indexBody : {
    chart: { result: [{ timestamp: [1], indicators: { quote: [{ close: [100] }] },
      meta: { regularMarketPrice: 100, currency: 'KRW' } }] },
  };
  return { ok: true, status: 200, json: async () => body };
};

new Function('require', 'process', 'fetch', 'AbortSignal', src)(
  require, { env: {}, platform: 'test' }, fakeFetch, AbortSignal);

// --- 차트 요청의 기호 ---------------------------------------------------------
for (const symbol of ['^KS11', '^KQ11', '005930.KS', 'AAPL', 'BRK-B']) {
  fetched.length = 0;
  const r = await handlers['yf:chart']({}, { symbol, range: '1d', interval: '5m' });
  check(`${symbol} 차트 요청을 받는다`,
    r.ok === true && fetched.some((u) => u.includes(`/chart/${encodeURIComponent(symbol)}?`)),
    JSON.stringify(r).slice(0, 80));
}
for (const symbol of ['^^KS11', 'KS11^', '^', '^.KS', '^KS11/../x', '']) {
  fetched.length = 0;
  const r = await handlers['yf:chart']({}, { symbol, range: '1d', interval: '5m' });
  check(`${JSON.stringify(symbol)} 는 거절한다`,
    r.ok === false && r.error === '잘못된 요청' && fetched.length === 0, JSON.stringify(r));
}

// --- 지수 응답 -------------------------------------------------------------------
const r = await handlers['quote:indices']({});
check('지수 응답을 읽는다', r.ok === true && r.items?.length === 2, JSON.stringify(r).slice(0, 120));
const [kospi, kosdaq] = r.items || [];
check('코스피 항목', same(kospi, {
  code: 'KOSPI', name: '코스피', value: 7003.74, change: 32.39, pct: 0.46,
  open: 6938.27, high: 7011.04, low: 6927.88, isOpen: false, tradedAt: '2026-10-02T15:37:00+09:00',
}), JSON.stringify(kospi));
check('하락한 지수는 전일 대비가 음수다', kosdaq?.change === -1 && kosdaq?.pct === -0.11, JSON.stringify(kosdaq));

// 빠진 값은 0 이 아니라 null — 0 이면 시가 0 캔들 · 전일 대비 0 으로 잘못 그린다
indexBody = { datas: [{ ...fixture.datas[0], openPrice: undefined, openPriceRaw: undefined,
  compareToPreviousClosePrice: undefined, compareToPreviousClosePriceRaw: undefined, marketStatus: 'OPEN' }] };
const partial = await handlers['quote:indices']({});
const p = partial.items?.[0];
check('빠진 값은 null 이다', p && p.open === null && p.change === null && p.value === 7003.74, JSON.stringify(p));
check('장이 열려 있으면 isOpen', p?.isOpen === true, JSON.stringify(p));

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 3: 실패를 확인한다**

Run: `node tests/index-main.mjs`
Expected: FAIL — `^KS11` · `^KQ11` 거절, `코스피 항목` 에 `code` · `change` 등이 없음, `빠진 값은 null` 실패.

- [ ] **Step 4: `SYMBOL_RE` 를 넓힌다**

`main.js`:

```js
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/;
```
를
```js
// 지수는 야후 기호가 ^ 로 시작한다(^KS11 코스피 · ^KQ11 코스닥). 맨 앞 한 번만 받는다.
const SYMBOL_RE = /^\^?[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/;
```
로.

- [ ] **Step 5: `quote:indices` 가 새 값을 담는다**

`main.js` 의 `quote:indices` 핸들러에서

```js
  const num = (v) => Number(String(v ?? '').replace(/,/g, ''));
```
아래에
```js
  // 지수 헤더용 값. 빠진 값은 0 이 아니라 null — 0 이면 시가 0 캔들, 전일 대비 0 이 된다.
  const opt = (v) => {
    const s = String(v ?? '').replace(/,/g, '').trim();
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) ? n : null;
  };
```
를 더하고,

```js
    const items = (json.datas || []).map((d) => ({
      name: d.stockName,
      value: num(d.closePriceRaw ?? d.closePrice),
      pct: num(d.fluctuationsRatioRaw ?? d.fluctuationsRatio),
    })).filter((i) => Number.isFinite(i.value) && Number.isFinite(i.pct));
```
를
```js
    const items = (json.datas || []).map((d) => ({
      code: d.itemCode,
      name: d.stockName,
      value: num(d.closePriceRaw ?? d.closePrice),
      // 지수도 종목처럼 내리면 음수다(2026-10-02 코스닥 -1.00 실측)
      change: opt(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice),
      pct: num(d.fluctuationsRatioRaw ?? d.fluctuationsRatio),
      open: opt(d.openPriceRaw ?? d.openPrice),
      high: opt(d.highPriceRaw ?? d.highPrice),
      low: opt(d.lowPriceRaw ?? d.lowPrice),
      isOpen: d.marketStatus === 'OPEN',
      tradedAt: d.localTradedAt || null,
    })).filter((i) => Number.isFinite(i.value) && Number.isFinite(i.pct));
```
로.

- [ ] **Step 6: 통과를 확인한다**

Run: `node --check main.js && node tests/index-main.mjs && node tests/net-timeout.mjs && node tests/single-instance.mjs`
Expected: 셋 다 마지막 줄 `PASS: 실패 0건`.

- [ ] **Step 7: 스위트 목록에 넣는다**

`tests/run.mjs` 의 `ORDER` 에서 `'single-instance.mjs',` 다음 줄에 `'index-main.mjs',`.

`.github/workflows/test.yml`:
- `# 이 열한 개는 Node 내장 모듈과 앱 파일(indicators.js · quote-session.cjs ·` → `# 이 열두 개는 Node 내장 모듈과 앱 파일(indicators.js · quote-session.cjs ·`
- `state-contract net-timeout single-instance; do` → `state-contract net-timeout single-instance index-main; do`

`docs/DEVELOPMENT.md` CI 절:
- `**앱을 띄우지 않는 열한 개**가` → `**앱을 띄우지 않는 열두 개**가`
- `` `net-timeout` · `single-instance`. `` → `` `net-timeout` · `single-instance` · `index-main`. ``
- `이 열한 개는 Node 내장 모듈과` → `이 열두 개는 Node 내장 모듈과`

- [ ] **Step 8: 커밋**

```bash
git add main.js tests/index-main.mjs tests/fixtures/naver-index-20261002.json tests/run.mjs .github/workflows/test.yml docs/DEVELOPMENT.md
git commit -m "feat(index): 지수 응답에 전일 대비 · 시고저 · 장 상태를 담고 ^ 기호 차트를 받는다" -m "지수 헤더를 종목처럼 채우려면 지금 버리던 값들이 필요하다. quote:indices 가 code · change · open · high · low · isOpen · tradedAt 을 더 담는다(새 요청 없음). 빠진 값은 0 이 아니라 null. 차트 요청의 기호 검사가 야후 지수 기호(^KS11 · ^KQ11)를 받도록 맨 앞 ^ 하나를 허용한다. tests/index-main.mjs 를 CI 에 넣었다."
```

---

### Task 2: 지수를 고를 수 있는 항목으로 — 모델

**Files:**
- Modify: `renderer.js` — prelude(파일 맨 앞 ~ `// 과열도 5단계` 마커 앞)에 `INDICES` · `isIndex` · `selectedItem` · `indexLive`. `const YAHOO_KR_DELAY_MIN = 20;` 다음, `let state = …` 앞에 넣는다. 포맷 구획의 `const curOf`.
- Test: `tests/session-ui.mjs`

**Interfaces:**
- Consumes: Task 1 의 지수 항목 `{ code, name, value, change, pct, open, high, low, isOpen, tradedAt }`.
- Produces:
  - `INDICES: Array<{ symbol: '^KS11'|'^KQ11', code: 'KOSPI'|'KOSDAQ', name: '코스피'|'코스닥' }>`
  - `isIndex(symbol: string): boolean`
  - `selectedItem(): { symbol, name } | null` — 관심종목 항목 또는 `INDICES` 항목
  - `indexLive(n): object | undefined` — 키: `price, prevClose, change, candle({open,high,low}|null), open, session, priceSession, isTrading, source, tradedAt`
  - `curOf(symbol)` 가 지수면 `'pt'`

prelude 에 두는 이유: `loadChart` 가 `selectedItem` 을 부르고, `tests/session-ui.mjs` 는 prelude 와 이름으로 꺼낸 함수만 실행한다 — `selectedItem` 이 prelude 밖이면 기존 `loadChart` 테스트가 전부 `ReferenceError` 로 깨진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/session-ui.mjs` 의 마지막 `console.log(\`PASS: …\`)` 앞에:

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node tests/session-ui.mjs`
Expected: FAIL — `selectedItem is not defined`.

- [ ] **Step 3: prelude 에 지수 모델을 넣는다**

`renderer.js` 에서 `const YAHOO_KR_DELAY_MIN = 20;` 다음, `let state = { watchlist: [], selected: null, timeframe: '1D' };` 앞에:

```js
// 상단 지수 줄의 코스피 · 코스닥. 누르면 관심종목처럼 "선택"되어 헤더 · 차트가 지수로 바뀐다.
// 기호는 야후 것이다(차트 · 일봉을 야후에서 받는다). code 는 네이버 지수 응답의 itemCode.
// loadChart 가 selectedItem 을 부르므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
const INDICES = [
  { symbol: '^KS11', code: 'KOSPI', name: '코스피' },
  { symbol: '^KQ11', code: 'KOSDAQ', name: '코스닥' },
];

function isIndex(symbol) {
  return INDICES.some((i) => i.symbol === symbol);
}

// 지금 보고 있는 대상 — 관심종목이면 그 항목, 지수면 지수 항목, 둘 다 아니면 null.
function selectedItem() {
  return state.watchlist.find((i) => i.symbol === state.selected)
    || INDICES.find((i) => i.symbol === state.selected) || null;
}

// 네이버 지수 항목 → 종목 실시간 시세(quote-session.cjs normalizeQuote)와 같은 모양.
// loadQuote 에 그대로 넣으면 RSI · 52주 · 이동평균 · 1D 끝점 · 오늘 봉 맞추기가 종목과 똑같이
// 동작한다. 지수에는 프리 · 애프터마켓이 없어 열려 있으면 정규장, 아니면 장마감이다.
// 전일 대비가 없으면 실시간 값이 없는 것으로 친다 — loadQuote 가 야후 값(20분지연)을 쓴다.
function indexLive(n) {
  if (!n || !Number.isFinite(n.value) || !Number.isFinite(n.change)) return undefined;
  const session = n.isOpen ? 'regular' : 'closed';
  return {
    price: n.value,
    prevClose: n.value - n.change,
    change: n.change,
    candle: n.open > 0 ? { open: n.open, high: n.high, low: n.low } : null,
    open: !!n.isOpen,
    session,
    priceSession: session,
    isTrading: !!n.isOpen,
    source: 'Naver',
    tradedAt: n.tradedAt || null,
  };
}
```

- [ ] **Step 4: `curOf` 가 지수면 `'pt'`**

`renderer.js` 포맷 구획:

```js
const curOf = (symbol) => (quotes[symbol] && quotes[symbol].currency) || 'KRW';
```
를
```js
// 지수는 통화가 아니라 포인트다. money 는 원화가 아니면 소수 둘째 자리로 쓰므로 'pt' 를 주면
// 헤더 · 오늘 캔들 안내 · 52주 · 차트 축 · 툴팁이 상단 지수 줄처럼 7,003.74 로 나온다.
const curOf = (symbol) => (isIndex(symbol) ? 'pt' : (quotes[symbol] && quotes[symbol].currency) || 'KRW');
```
로.

- [ ] **Step 5: 통과를 확인한다**

Run: `node --check renderer.js && TZ=Asia/Seoul node tests/session-ui.mjs`
Expected: 마지막 줄 `PASS: 18 session UI test groups`.

- [ ] **Step 6: 커밋**

```bash
git add renderer.js tests/session-ui.mjs
git commit -m "feat(index): 지수를 고를 수 있는 항목으로 — 선택 대상 · 지수 시세 모양 · 포인트 표기" -m "INDICES(^KS11 코스피 · ^KQ11 코스닥), isIndex, selectedItem(관심종목 또는 지수), indexLive(네이버 지수 → 종목 실시간 시세 모양)를 prelude 에 둔다. 전일 대비가 없으면 실시간 없이(야후 20분지연). curOf 는 지수면 'pt' 를 돌려 money 가 소수 둘째 자리로 쓴다."
```

---

### Task 3: 상단 지수를 누르면 헤더 · 차트가 그 지수로

**Files:**
- Modify: `renderer.js` — `loadIndices` (지금 253행 부근), `refreshAll`, `select`, `renderDetail`, `loadChart` 첫 줄, `init` 의 버튼 연결부
- Modify: `index.html` — `.indices .ixp` 스타일 다음
- Test: `tests/session-ui.mjs`

**Interfaces:**
- Consumes: `INDICES`, `isIndex`, `selectedItem`, `indexLive`, `curOf` (Task 2), `api.indices()` 항목의 `code` (Task 1).
- Produces:
  - `let indexItems = [];` (한 줄 선언 — 테스트가 정규식 `/^let indexItems = .*$/m` 로 꺼낸다)
  - `loadIndices(): Promise<Array<지수 항목>>` — 받은 항목을 돌려준다(실패면 `[]`)
  - `renderIndices(): void` — `#indices` 를 그린다. 알려진 지수만 `data-symbol` · `title`, 선택된 지수는 `class="ix on"`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/session-ui.mjs` 의 마지막 `console.log(\`PASS: …\`)` 앞에:

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `TZ=Asia/Seoul node tests/session-ui.mjs`
Expected: FAIL — `renderer function renderIndices exists` 단언 실패(아직 함수가 없음).

- [ ] **Step 3: 지수 줄을 받기와 그리기로 나눈다**

`renderer.js` 의

```js
// --- 코스피/코스닥 지수 -----------------------------------------------------------
// 개별 종목이 빠질 때 시장 전체 흐름인지 바로 알 수 있게 한 줄로 보여준다.
async function loadIndices() {
  const box = document.getElementById('indices');
  const r = await api.indices();
  if (!r.ok) { box.hidden = true; return; } // 실패하면 조용히 숨긴다(핵심 기능이 아님)

  box.hidden = false;
  box.innerHTML = r.items.map((i) => {
    const color = i.pct === 0 ? cssVar('--flat') : (i.pct > 0 ? UP : DOWN);
    return `<span class="ix"><span class="ixn">${esc(i.name)}</span>`
      + `<span class="ixv">${i.value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      + `<span class="ixp" style="color:${color}">${fmtPct(i.pct)}</span></span>`;
  }).join('');
}
```
를
```js
// --- 코스피/코스닥 지수 -----------------------------------------------------------
// 개별 종목이 빠질 때 시장 전체 흐름인지 바로 알 수 있게 한 줄로 보여준다.
// 누르면 그 지수를 관심종목처럼 고른다(select) — 헤더 · 차트가 지수로 바뀐다.
let indexItems = []; // 마지막으로 받은 네이버 지수 항목 — 선택만 바뀔 때 강조를 다시 그리는 데 쓴다

async function loadIndices() {
  const r = await api.indices();
  indexItems = r.ok ? r.items : []; // 실패하면 조용히 숨긴다(핵심 기능이 아님)
  renderIndices();
  return indexItems;
}

function renderIndices() {
  const box = document.getElementById('indices');
  box.hidden = !indexItems.length;
  box.innerHTML = indexItems.map((i) => {
    const ix = INDICES.find((x) => x.code === i.code); // 모르는 지수는 보이기만 하고 누를 수 없다
    const color = i.pct === 0 ? cssVar('--flat') : (i.pct > 0 ? UP : DOWN);
    const cls = ix && ix.symbol === state.selected ? 'ix on' : 'ix';
    const attrs = ix ? ` data-symbol="${ix.symbol}" title="${ix.name} 차트 보기"` : '';
    return `<span class="${cls}"${attrs}><span class="ixn">${esc(i.name)}</span>`
      + `<span class="ixv">${i.value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      + `<span class="ixp" style="color:${color}">${fmtPct(i.pct)}</span></span>`;
  }).join('');
}
```
로.

- [ ] **Step 4: `refreshAll` 이 지수 시세를 만든다**

`refreshAll` 안의

```js
    await loadIndices();
```
를
```js
    const indexNow = await loadIndices();
```
로, 그리고

```js
    for (const item of state.watchlist) {
      await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
      renderList();
    }
```
바로 다음에
```js
    // 지수도 종목과 같은 시세로 만든다 — 누르면 바로 뜨게 둘 다. 네이버 지수를 못 받았으면
    // 실시간 없이 들어가 야후 값(20분지연)이 된다(종목 폴백과 같다).
    for (const ix of INDICES) await loadQuote(ix, indexLive(indexNow.find((n) => n.code === ix.code)));
```
를 넣는다.

- [ ] **Step 5: `select` 가 지수 줄 강조를 다시 그린다**

`select` 의

```js
  renderList();
  renderDetail();
  await loadChart();
```
를
```js
  renderList();
  renderIndices(); // 지수를 골랐거나 지수에서 종목으로 왔으면 강조가 옮겨 간다
  renderDetail();
  await loadChart();
```
로.

- [ ] **Step 6: `renderDetail` · `loadChart` 가 `selectedItem()` 을 쓴다**

`renderDetail` 의

```js
  const item = state.watchlist.find((i) => i.symbol === state.selected);
```
를
```js
  const item = selectedItem(); // 관심종목 또는 지수
```
로,

```js
  document.getElementById('dname').textContent = item
    ? (cur === 'KRW' ? item.name : `${item.name} (${cur})`) : '—';
```
를
```js
  document.getElementById('dname').textContent = item
    ? (cur === 'KRW' || cur === 'pt' ? item.name : `${item.name} (${cur})`) : '—';
```
로,

```js
  if (item && !sectors.has(item.symbol)) loadSector(item).catch(console.error);
```
를
```js
  // 지수는 업종이 없다
  if (item && !isIndex(item.symbol) && !sectors.has(item.symbol)) loadSector(item).catch(console.error);
```
로 바꾼다.

`loadChart` 첫 줄

```js
  const item = state.watchlist.find((i) => i.symbol === state.selected);
```
를
```js
  const item = selectedItem(); // 관심종목 또는 지수
```
로.

- [ ] **Step 7: 지수 줄 클릭을 연결한다**

`init` 의 `document.getElementById('undoBtn').onclick = () => undoRemove();` 다음 줄에:

```js
  // 지수 줄은 30초마다 다시 그려지므로 항목이 아니라 줄에 한 번만 붙인다
  document.getElementById('indices').onclick = (e) => {
    const el = e.target.closest('.ix[data-symbol]');
    if (el) select(el.dataset.symbol);
  };
```

- [ ] **Step 8: 지수 항목 스타일**

`index.html` 의 `.indices .ixp { font-variant-numeric: tabular-nums; }` 다음 줄에:

```css
  /* 누르면 그 지수 차트. 보고 있는 지수는 목록 선택 줄(.row.on)과 같은 색.
     안쪽 여백만큼 바깥 여백을 빼서 줄 높이와 간격은 그대로 둔다. */
  .indices .ix[data-symbol] { cursor: pointer; margin: -2px -4px; padding: 2px 4px; border-radius: 4px; }
  .indices .ix[data-symbol]:hover { background: var(--hover); }
  .indices .ix.on { background: var(--sel); box-shadow: inset 0 -1px 0 var(--accent); }
```

- [ ] **Step 9: 통과를 확인한다**

Run: `node --check renderer.js && TZ=Asia/Seoul node tests/session-ui.mjs && node tests/dom-contract.mjs`
Expected: `PASS: 23 session UI test groups`, `PASS: 실패 0건`.

- [ ] **Step 10: 커밋**

```bash
git add renderer.js index.html tests/session-ui.mjs
git commit -m "feat(index): 상단 지수를 누르면 헤더 · 차트가 그 지수로 바뀐다" -m "지수 줄을 받기(loadIndices)와 그리기(renderIndices)로 나누고, 알려진 지수에 data-symbol 을 달아 누르면 select 한다. 보고 있는 지수는 목록 선택 줄과 같은 색. refreshAll 이 두 지수 모두 indexLive → loadQuote 로 시세를 만든다(네이버 실패면 야후 20분지연). renderDetail · loadChart 는 selectedItem 으로 관심종목 또는 지수를 받고, 지수는 업종을 묻지 않고 통화 표시를 붙이지 않는다."
```

---

### Task 4: 키보드 · 재시작 선택 · 분봉 안내 · 문서

**Files:**
- Modify: `renderer.js` — `moveSelection`, `intradayWaitText`, `select` 위에 `validSelection` 추가, `init` 의 선택 검사
- Modify: `README.md` — `### 종목 다루기`
- Modify: `docs/DEVELOPMENT.md` — 데이터 소스 표, `### 캔들차트` 앞에 `### 지수 차트`
- Test: `tests/session-ui.mjs`

**Interfaces:**
- Consumes: `isIndex` (Task 2).
- Produces: `validSelection(selected: string|null|undefined, watchlist: Array<{symbol}>): string|null`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/session-ui.mjs` 의 마지막 `console.log(\`PASS: …\`)` 앞에:

```js
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
```

그리고 기존 `'empty intraday chart says when Yahoo bars start …'` 테스트의 마지막 단언

```js
  assert.equal(c.intradayWaitText({ symbol: 'NVDA', name: '엔비디아' }, null),
    '엔비디아 1D: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)');
```
다음 줄에:

```js
  // 야후 지수 분봉도 국내 종목처럼 20분 늦다(2026-10-02 실측) — 지수 시세에는 openTime 이 없어 09:00 기준
  assert.equal(c.intradayWaitText({ symbol: '^KS11', name: '코스피' }, {}),
    '코스피 1D: 분봉이 늦어지고 있습니다 (보통 09:20쯤 들어옵니다 · 1M 이상은 정상)');
```

- [ ] **Step 2: 실패를 확인한다**

Run: `TZ=Asia/Seoul node tests/session-ui.mjs`
Expected: FAIL — `moveSelection` 의 `picked` 가 `['005930.KS', '005930.KS', …]` (↑ 도 첫 줄로 감).

- [ ] **Step 3: `moveSelection`**

```js
  const cur = list.findIndex((i) => i.symbol === state.selected);
  const next = cur < 0 ? list[0] : list[(cur + step + list.length) % list.length];
```
를
```js
  const cur = list.findIndex((i) => i.symbol === state.selected);
  // 지수를 보고 있으면(목록에 없음) ↓ 는 첫 줄, ↑ 는 마지막 줄
  const next = cur < 0 ? list[step > 0 ? 0 : list.length - 1] : list[(cur + step + list.length) % list.length];
```
로.

- [ ] **Step 4: `validSelection` 과 시작할 때 선택 검사**

`renderer.js` 의 `async function select(symbol) {` 바로 위에:

```js
// 저장된 선택이 관심종목도 지수도 아니면 첫 관심종목. 관심종목이 비어 있으면 null —
// undefined 를 그대로 저장하면 electron-store 가 거부한다.
function validSelection(selected, watchlist) {
  if (watchlist.some((i) => i.symbol === selected) || isIndex(selected)) return selected;
  return (watchlist[0] && watchlist[0].symbol) || null;
}

```

`init` 의

```js
  if (!state.watchlist.some((i) => i.symbol === state.selected)) {
    // 관심종목이 비어 있으면 undefined 가 되는데, 그대로 저장하면 electron-store 가 거부한다
    state.selected = (state.watchlist[0] && state.watchlist[0].symbol) || null;
  }
```
를
```js
  state.selected = validSelection(state.selected, state.watchlist); // 지수를 보던 중이면 그대로
```
로.

- [ ] **Step 5: `intradayWaitText`**

```js
  if (!isDomestic(item.symbol)) return `${head}: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`;
```
를
```js
  // 지수도 야후 분봉이 국내 종목처럼 20분 늦다. isDomestic 은 그대로 둔다 — 폴링 · 알림이 쓴다.
  if (!isDomestic(item.symbol) && !isIndex(item.symbol)) return `${head}: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`;
```
로.

- [ ] **Step 6: 통과를 확인한다**

Run: `node --check renderer.js && TZ=Asia/Seoul node tests/session-ui.mjs`
Expected: `PASS: 25 session UI test groups`.

- [ ] **Step 7: 문서**

`README.md` 의 `### 종목 다루기` 목록 끝(`- **창 옮기기·크기** …` 다음 줄)에:

```markdown
- **지수 차트** — 위쪽의 코스피·코스닥을 누르면 아래 헤더와 차트가 그 지수로 바뀝니다. 종목 줄을 누르면 돌아옵니다.
```

`docs/DEVELOPMENT.md` 데이터 소스 표의

```markdown
| 코스피 · 코스닥 지수 | Naver 실시간 | 두 지수 1회 요청 |
```
를
```markdown
| 코스피 · 코스닥 지수 | Naver 실시간 | 두 지수 1회 요청. 지수 차트 · RSI · 52주는 Yahoo `^KS11` · `^KQ11` |
```
로, 그리고 `### 캔들차트` 바로 앞에:

```markdown
### 지수 차트

상단 지수 줄의 코스피 · 코스닥을 누르면 관심종목처럼 **선택**됩니다(`select`). 헤더와 차트가 지수로 바뀌고, 종목 줄을 누르면 돌아옵니다. 지수는 야후 기호(`^KS11` · `^KQ11`)로 `state.selected` 에 들어가 저장되므로 재시작해도 그대로입니다(`validSelection`). 선택 대상은 `selectedItem()` 이 관심종목 또는 지수로 돌려줍니다.

지수 시세는 따로 만들지 않습니다. 이미 30초마다 받는 네이버 지수 값을 종목 실시간 시세 모양으로 바꿔(`indexLive`) `loadQuote` 에 넣으므로 RSI · 52주 · 이동평균 · 1D 끝점 · 오늘 봉 맞추기가 종목과 같은 경로입니다. 지수에는 프리 · 애프터마켓이 없어 장이 열려 있으면 정규장, 아니면 장마감입니다. 네이버 지수를 못 받으면 지수 줄은 숨고, 지수를 보던 중이면 헤더는 야후 값으로 "20분지연" 이 붙습니다.

| 지수에서 다른 점 | 이유 |
|---|---|
| 숫자는 소수 둘째 자리 (`curOf` → `'pt'`) | 원화 규칙이면 7,004 처럼 반올림된다. `money` 는 원화가 아니면 둘째 자리로 쓴다 |
| 업종 · 보유 · 평단선 · 종가대비 · 목표가 알림 없음 | 지수에는 해당 값이 없다(보유 · 목표가는 관심종목에만 입력) |
| ↓ 첫 종목 · ↑ 마지막 종목 | 지수는 목록 밖이라 위아래가 없다 |
| 분봉 대기 안내는 국내처럼 09:20 | 야후 지수 분봉도 20분 늦다(2026-10-02 실측). `isDomestic` 은 폴링 · 알림이 써서 그대로 둔다 |

접힌 상태에서 누르면 종목 줄처럼 선택만 바뀌고, 펼치면 지수 차트가 보입니다. 확대 구간은 대상이 바뀌면 모두 풀립니다.
```

- [ ] **Step 8: 전체 확인**

Run:
```bash
for f in main.js renderer.js indicators.js preload.js quote-session.cjs; do node --check $f || echo "SYNTAX FAIL $f"; done
for f in isolation rsi cross candle zoom trend quote-session session-ui dom-contract state-contract net-timeout single-instance index-main; do printf '%-16s ' $f; TZ=Asia/Seoul node "tests/$f.mjs" 2>&1 | tail -1; done
```
Expected: 문법 오류 없음, 모든 줄이 `PASS`.

- [ ] **Step 9: 커밋**

```bash
git add renderer.js tests/session-ui.mjs README.md docs/DEVELOPMENT.md
git commit -m "feat(index): 지수에서 ↑↓ · 재시작 선택 유지 · 분봉 안내, 문서" -m "지수를 보다가 ↓ 는 첫 종목, ↑ 는 마지막 종목으로 간다. 시작할 때 선택 검사를 validSelection 으로 빼서 지수 선택도 받아들인다(관심종목이 비어 있어도). 야후 지수 분봉도 20분 늦어 분봉 대기 안내를 국내처럼 한다. README 와 개발 문서에 지수 차트를 적었다."
```
