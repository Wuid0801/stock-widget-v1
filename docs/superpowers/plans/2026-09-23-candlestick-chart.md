# 1M · 3M 캔들차트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1M · 3M 일봉 차트를 종가 라인 대신 캔들로 그리고, 타임프레임 줄의 토글 버튼으로 라인과 오갈 수 있게 한다.

**Architecture:** 커스텀 Chart.js 플러그인이 `beforeDatasetsDraw` 에서 캔버스에 직접 그린다. 기존 종가 라인과 고가~저가 밴드 데이터셋은 **지우지 않고 투명하게** 남겨, y축 범위와 인덱스 기반 툴팁·호버가 지금 코드 그대로 돌게 한다.

**Tech Stack:** Chart.js 4 (UMD, `node_modules` 에서 직접 로드), Electron 클래식 스크립트, 테스트는 `node tests/*.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-23-candlestick-chart-design.md`

## Global Constraints

- **앱과 `npm test` 는 실행하지 않는다.** 검증은 `node --check` 와 앱을 띄우지 않는 개별 스위트(`node tests/<name>.mjs`)까지만. 화면 확인은 사용자가 직접 한다.
- **주석과 문서는 한국어로 쓴다.** 예외: `tests/session-ui.mjs` 는 기존 주석이 영어라 그 파일 안에서는 영어를 유지한다.
- **숫자에는 근거를 적는다.** 이 저장소의 주석은 왜 그 값인지를 담은 실측 기록이다. 새 상수에도 같은 기준을 지킨다.
- **색은 `cssVar` 로 읽는다.** `UP`(#e24b4a) · `DOWN`(#185fa5) · `--flat` 은 이미 정의돼 있고, 테마를 바꾸면 따라와야 한다.
- 커밋 메시지는 `<type>(<scope>): <한글 subject>` 형식, 본문도 한글. `Co-Authored-By` 트레일러는 붙이지 않는다.
- 줄 번호는 편집하면서 바뀐다. 위치는 항상 함수 이름이나 마커 주석으로 찾는다. 이 문서의 줄 번호는 2026-09-23 기준 참고값이다.

---

### Task 1: 기하 순수 함수 둘

**Files:**
- Modify: `indicators.js` (함수 둘 추가, `module.exports` 에 이름 셋 추가)
- Test: `tests/candle.mjs`

**Interfaces:**
- Produces:
  - `candleWidth(spacing) → number` — 카테고리 간격(px)을 받아 몸통 폭(정수 px)
  - `candleBody(yOpen, yClose) → { top: number, h: number }` — 시가·종가의 y픽셀을 받아 몸통의 위치와 높이
  - `CANDLE_TF` — `new Set(['1M', '3M'])`
  - `candleMode(timeframe, chartMode) → boolean` — 이 조합에서 캔들로 그리는가

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/candle.mjs` 의 맨 아래, `console.log(\`\n${fails ? ...` 줄 **앞**에 붙인다.

```js
// --- 9. 차트 캔들 기하 ----------------------------------------------------------
// 화면의 미니 캔들(candleGeom)은 값 범위를 고정 높이에 맞추지만, 차트 캔들은
// Chart.js 가 준 y픽셀을 그대로 쓴다. 그래서 계산이 다르다.
{
  check('간격의 70% 를 몸통 폭으로 쓴다 (3M: 4.3px 간격 → 3px)',
    C.candleWidth(4.3) === 3, `${C.candleWidth(4.3)}px`);
  check('1M 은 간격이 넓다 (12.7px → 9px)',
    C.candleWidth(12.7) === 9, `${C.candleWidth(12.7)}px`);

  check('아무리 좁아도 1px 은 남는다', C.candleWidth(0.5) === 1, `${C.candleWidth(0.5)}px`);
  check('간격이 0 이어도 1px (0 나누기 방어)', C.candleWidth(0) === 1);
  check('간격이 NaN 이어도 1px', C.candleWidth(NaN) === 1);
  check('아무리 넓어도 12px 을 넘지 않는다 (봉 몇 개짜리 구간)',
    C.candleWidth(100) === 12, `${C.candleWidth(100)}px`);
}

// --- 10. 몸통의 위치와 높이 -----------------------------------------------------
// y픽셀은 값이 클수록 작다(위가 0). 시가·종가 어느 쪽이 위든 top 은 더 작은 값이다.
{
  const up = C.candleBody(120, 80); // 시가 아래, 종가 위 → 양봉
  check('양봉은 종가 y 가 top', up.top === 80 && up.h === 40, JSON.stringify(up));

  const down = C.candleBody(80, 120); // 음봉
  check('음봉은 시가 y 가 top', down.top === 80 && down.h === 40, JSON.stringify(down));

  const doji = C.candleBody(100, 100);
  check('도지는 높이 1px 로 남는다 (사라지지 않는다)',
    doji.top === 100 && doji.h === 1, JSON.stringify(doji));

  const tiny = C.candleBody(100, 100.4);
  check('0.4px 차이도 1px 로 올린다', tiny.h === 1, `${tiny.h}px`);
}

// --- 11. 캔들로 그리는 구간 -----------------------------------------------------
{
  check('3M 은 캔들', C.candleMode('3M', 'candle') === true);
  check('1M 도 캔들', C.candleMode('1M', 'candle') === true);
  check('1Y 는 봉이 1.2px 라 라인', C.candleMode('1Y', 'candle') === false);
  check('1D 는 분봉이라 라인', C.candleMode('1D', 'candle') === false);
  check('1W 도 분봉이라 라인', C.candleMode('1W', 'candle') === false);

  check('line 을 고르면 3M 도 라인', C.candleMode('3M', 'line') === false);
  // 저장값에 모르는 문자열이 들어 있어도 기본값(캔들)으로 본다
  check('모르는 값은 캔들로 본다', C.candleMode('3M', undefined) === true);
  check('CANDLE_TF 는 1M · 3M 둘뿐이다',
    C.CANDLE_TF.size === 2 && C.CANDLE_TF.has('1M') && C.CANDLE_TF.has('3M'));
}
```

- [ ] **Step 2: 돌려서 실패를 확인한다**

```bash
node tests/candle.mjs
```

기대: `C.candleWidth is not a function` 으로 죽는다.

- [ ] **Step 3: `indicators.js` 에 함수를 넣는다**

`candleGeom` 함수 **다음**, `// --- 추세선` 앞에 붙인다.

```js
// --- 차트 캔들 -----------------------------------------------------------------
// 위의 candleGeom 은 값 범위를 고정 높이(22px)에 맞춘다. 차트는 반대로 Chart.js 의
// y축이 픽셀을 주므로, 여기서는 그 픽셀만 가지고 몸통을 만든다.

// 캔들로 그리는 타임프레임. 창이 340px 라 차트 영역이 약 280px 인데, 1Y(243봉)는
// 봉 하나가 1.2px 라 몸통도 꼬리도 구분되지 않는다. 1D(5분봉) · 1W(30분봉)은
// 분봉이라 "일봉 캔들" 과 뜻이 다르다.
const CANDLE_TF = new Set(['1M', '3M']);

// 저장값이 'line' 일 때만 라인이다. 모르는 값이 들어 있으면 기본값(캔들)으로 본다.
function candleMode(timeframe, chartMode) {
  return chartMode !== 'line' && CANDLE_TF.has(timeframe);
}

// 몸통 폭. 간격을 다 쓰면 캔들끼리 붙어 경계가 사라지므로 70% 만 쓴다.
// 3M(65봉)은 간격 4.3px → 3px, 1M(22봉)은 12.7px → 9px 이다. 위로는 12px 에서
// 멈춘다 — 봉이 몇 개뿐인 구간에서 캔들이 막대그래프처럼 뚱뚱해지지 않게.
function candleWidth(spacing) {
  if (!(spacing > 0)) return 1;
  return Math.max(1, Math.min(12, Math.round(spacing * 0.7)));
}

// 몸통의 위치와 높이. y픽셀은 값이 클수록 작으므로 top 은 둘 중 작은 쪽이다.
// 시가 = 종가인 도지는 높이 0 이라 그냥 그리면 사라진다 → 최소 1px.
function candleBody(yOpen, yClose) {
  return { top: Math.min(yOpen, yClose), h: Math.max(1, Math.abs(yClose - yOpen)) };
}
```

- [ ] **Step 4: export 에 이름을 더한다**

`indicators.js` 끝의 `module.exports` 를 통째로 바꾼다.

```js
if (typeof module !== 'undefined') {
  module.exports = {
    calcRSI, sma, crossings, confirmedCrosses, midnightOf, daysAgo, candleOf, candleGeom,
    CANDLE_TF, candleMode, candleWidth, candleBody,
    TREND_TF, TREND_MIN_SPAN, TREND_LOOKBACK, TREND_MAX_EXTEND, TREND_MIN_BREAK, TREND_MAX_DRIFT,
    hull, trendLine, breakoutOf, meetAt,
  };
}
```

- [ ] **Step 5: 돌려서 통과를 확인한다**

```bash
node --check indicators.js && node tests/candle.mjs
```

기대: 기존 29개에 더해 새 검사까지 전부 `OK`, `전부 통과`.

- [ ] **Step 6: 커밋**

```bash
git add indicators.js tests/candle.mjs
git commit -m "feat(candle): 차트 캔들 기하 함수를 추가한다

candleWidth 는 카테고리 간격의 70% 를 몸통 폭으로 쓴다(1~12px). candleBody 는
시가·종가의 y픽셀에서 몸통 위치와 높이를 만들고, 도지가 사라지지 않게 최소 1px 을
보장한다. candleMode 는 1M · 3M 에서만 캔들로 그린다고 답한다 — 1Y 는 봉 하나가
1.2px 라 구분되지 않고 1D · 1W 는 분봉이다.

아직 아무 데서도 부르지 않는다. 그리는 것은 다음 단계다."
```

---

### Task 2: `opens` 를 차트까지 나른다

**Files:**
- Modify: `renderer.js` (`loadChart` 의 `pad` 구간과 오늘 봉 동기화, `drawChart` 의 인자 분해)
- Test: `tests/session-ui.mjs`

**Interfaces:**
- Consumes: Task 1 의 함수는 아직 쓰지 않는다.
- Produces: `drawChart(arg)` 가 `arg.opens` 를 받는다 — `closes` 와 같은 길이의 숫자 배열. `loadChart` 가 `opens` 를 넘긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/session-ui.mjs` 의 `daily chart syncs the last bar to the live candle...` 테스트 안, `assert.deepEqual(draws.at(-1).lows, [96, 95], 'last low becomes the live low');` **다음 줄**에 붙인다.

```js
  assert.deepEqual(draws.at(-1).opens, [97, 99], 'opens reach drawChart, last one synced');
```

그리고 같은 테스트의 `quotes['005930.KS']` 설정에서 `candle` 의 `open` 이 `99` 이므로, 마지막 봉 시가는 그대로 `99` 다(피드 시가와 라이브 시가가 같은 경우). **바뀌는 것을 보려면** 그 줄의 `candle` 을 다음으로 고친다.

```js
      candle: { open: 101, high: 106, low: 95 } };`);
```

그러면 기대값도 바뀐다 — 위에서 붙인 줄을 다음으로 쓴다.

```js
  assert.deepEqual(draws.at(-1).opens, [97, 101], 'opens reach drawChart, last one synced');
```

`candle.open` 을 101 로 올려도 `candleOf` 의 클램프가 `high` 를 건드리지 않는다(101 < 106). 그 아래 `highs` · `lows` 기대값은 그대로다.

- [ ] **Step 2: 돌려서 실패를 확인한다**

```bash
node tests/session-ui.mjs
```

기대: `opens reach drawChart, last one synced` 에서 `actual: undefined` 로 실패.

- [ ] **Step 3: `loadChart` 가 `opens` 를 만든다**

`const volumes = pad(r.volumes, 0);` 가 있는 자리를 찾는다. `highs` · `lows` 와 나란히 한 줄을 더한다.

```js
  const volumes = pad(r.volumes, 0);
  const opens = pad(r.opens, (i) => closes[i]);
  const highs = pad(r.highs, (i) => closes[i]);
  const lows = pad(r.lows, (i) => closes[i]);
```

- [ ] **Step 4: 오늘 봉 동기화에 시가를 넣는다**

바로 아래 `const todayBar = daily ? candleOf(q) : null;` 블록에 한 줄을 더한다.

```js
  const todayBar = daily ? candleOf(q) : null;
  if (todayBar && daysAgo(times[times.length - 1]) === 0) {
    const i = closes.length - 1;
    closes[i] = todayBar.close;
    opens[i] = todayBar.open;
    highs[i] = todayBar.high;
    lows[i] = todayBar.low;
  }
```

- [ ] **Step 5: `drawChart` 로 넘긴다**

`loadChart` 끝의 `drawChart({ ... })` 호출에서 `volumes, highs, lows,` 를 찾아 `opens` 를 끼운다.

```js
    volumes, opens, highs, lows, crosses, hLines, trends,
```

- [ ] **Step 6: `drawChart` 가 받는다**

`function drawChart(arg) {` 의 인자 분해에 기본값과 함께 더한다.

```js
  const {
    closes, times, up, mas = [], cur = 'KRW',
    volumes = [], opens = [], highs = [], lows = [], hLines = [], crosses = [], trends = [],
  } = arg;
```

- [ ] **Step 7: 돌려서 통과를 확인한다**

```bash
node --check renderer.js && node tests/session-ui.mjs && node tests/candle.mjs
```

기대: 전부 통과. `session-ui` 는 `PASS: 10 session UI test groups`.

- [ ] **Step 8: 커밋**

```bash
git add renderer.js tests/session-ui.mjs
git commit -m "feat(chart): 시가를 차트까지 나른다

opens 를 고가·저가와 똑같이 pad 하고, 오늘 봉 실시간 동기화에도 시가를 포함한다.
candleOf 가 이미 세션 규칙과 클램프를 거친 시가를 주므로 한 줄이면 된다.

drawChart 가 받기만 하고 아직 쓰지 않는다. 그리는 것은 다음 단계다."
```

---

### Task 3: 캔들을 그린다

이 단계가 끝나면 1M · 3M 에서 캔들이 실제로 보인다. 토글은 아직 없고 항상 캔들이다.

**Files:**
- Modify: `renderer.js` (`candlePlugin` 신규, `drawChart` 의 플러그인 등록·투명 분기)

**Interfaces:**
- Consumes: Task 1 의 `candleMode` · `candleWidth` · `candleBody`, Task 2 의 `arg.opens`.
- Produces: `candlePlugin` — Chart.js 플러그인 객체, `id: 'candle'`. 옵션은 `{ opens, highs, lows, closes }` 네 배열이고, 비어 있으면 아무것도 그리지 않는다.

- [ ] **Step 1: 플러그인을 만든다**

`renderer.js` 의 `const crossMarkPlugin = {` **앞**에 붙인다(그리는 순서가 반대라는 것을 주석으로 붙여 둔다).

```js
// 캔들. 몸통은 시가~종가, 꼬리는 저가~고가. 색은 시가 대비다 — 전일 종가 대비인
// 헤더 등락률과 다를 수 있고, 그 차이가 캔들을 보는 이유다.
//
// beforeDatasetsDraw 라 이동평균선·추세선 **아래**에 깔린다. crossMarkPlugin 이
// afterDatasetsDraw(위)인 것과 반대다 — 표식은 덮어야 보이고 캔들은 덮으면 선을
// 가린다.
//
// y축 범위는 투명하게 남겨 둔 고가~저가 밴드 데이터셋이 잡아 준다. 캔버스에만
// 그리면 꼬리 끝이 축 밖으로 나가 말없이 잘린다(추세선 주석의 그 문제다).
const candlePlugin = {
  id: 'candle',
  beforeDatasetsDraw(c, _args, opts) {
    const { opens = [], highs = [], lows = [], closes = [] } = opts || {};
    if (!opens.length) return;

    const sx = c.scales.x; const sy = c.scales.y;
    const area = c.chartArea;
    const ctx = c.ctx;
    const w = candleWidth(sx.width / Math.max(1, opens.length));
    const flat = cssVar('--flat');

    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip(); // 축 눈금 위로 삐져나가지 않게

    for (let i = 0; i < opens.length; i++) {
      const o = opens[i]; const h = highs[i]; const l = lows[i]; const cl = closes[i];
      if (o == null || h == null || l == null || cl == null) continue;

      const color = cl > o ? UP : cl < o ? DOWN : flat;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;

      // 꼬리는 1px 세로선. +0.5 는 캔버스 격자에 맞춰 흐려지지 않게 하는 것이다.
      const cx = Math.round(sx.getPixelForValue(i));
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, sy.getPixelForValue(h));
      ctx.lineTo(cx + 0.5, sy.getPixelForValue(l));
      ctx.stroke();

      const b = candleBody(sy.getPixelForValue(o), sy.getPixelForValue(cl));
      ctx.fillRect(cx - Math.floor(w / 2), b.top, w, b.h);
    }
    ctx.restore();
  },
};
```

- [ ] **Step 2: 플러그인을 등록한다**

`drawChart` 안의 `plugins: [hLinePlugin, crossMarkPlugin, crosshairPlugin],` 를 바꾼다.

```js
    plugins: [candlePlugin, hLinePlugin, crossMarkPlugin, crosshairPlugin],
```

- [ ] **Step 3: 캔들 모드를 판단하고 옵션을 넘긴다**

`drawChart` 안, `const color = up ? UP : DOWN;` 다음 줄에 더한다.

```js
  // 시가가 없으면(야후가 안 주는 종목) 캔들을 그릴 수 없다.
  const candles = candleMode(state.timeframe, state.chartMode) && opens.length > 0;
```

그리고 `plugins: {` 블록의 `crossMark: { list: crosses },` 다음에 더한다.

```js
        candle: candles ? { opens, highs, lows, closes } : {},
```

- [ ] **Step 4: 캔들 모드에서 라인과 밴드를 투명하게 한다**

0번 데이터셋의 `borderColor: color,` 를 바꾼다.

```js
        borderColor: candles ? 'transparent' : color,
```

같은 데이터셋의 `backgroundColor: (ctx) => {` 함수 첫 줄에 한 줄을 더한다(그라데이션 채움을 끈다).

```js
        backgroundColor: (ctx) => {
          if (candles) return 'transparent'; // 캔들 위에 채움이 겹치면 몸통이 흐려진다
          const area = ctx.chart.chartArea;
```

고가~저가 밴드의 `backgroundColor: hexA(color, 0.16),` 를 바꾼다.

```js
        backgroundColor: candles ? 'transparent' : hexA(color, 0.16),
```

> 밴드 데이터셋 자체는 **지우지 않는다.** y축이 꼬리 끝까지 범위를 잡는 것이 그 두 데이터셋 덕분이다.

- [ ] **Step 5: 구문과 스위트를 확인한다**

```bash
node --check renderer.js && node --check indicators.js
for f in rsi cross candle trend quote-session session-ui dom-contract; do printf "%-14s " "$f"; node tests/$f.mjs >/dev/null 2>&1 && echo PASS || echo FAIL; done
```

기대: 구문 통과, 일곱 줄 모두 `PASS`. 이 단계의 그림은 자동 검증 대상이 아니다 — 사용자가 눈으로 본다.

- [ ] **Step 6: 커밋**

```bash
git add renderer.js
git commit -m "feat(chart): 1M · 3M 을 캔들로 그린다

커스텀 플러그인이 beforeDatasetsDraw 에서 캔버스에 직접 그린다. 이동평균선·추세선
아래에 깔려야 선이 묻히지 않아서 before 다 — 위에 그리는 crossMark 와 반대다.

종가 라인과 고저 밴드 데이터셋은 지우지 않고 투명하게 둔다. y축이 꼬리 끝까지
범위를 잡는 것이 그 데이터셋 덕분이고, 인덱스 기반 호버라 툴팁도 그대로 돈다.

색은 시가 대비다. 헤더 등락률(전일 종가 대비)과 다를 수 있고 그 차이가 캔들을
보는 이유다."
```

---

### Task 4: 토글 버튼과 상태 저장

**Files:**
- Modify: `renderer.js` (`renderTabs`, `save`, 초기화 기본값)
- Modify: `main.js` (`state:set` 허용목록)
- Modify: `index.html` (비활성 버튼 CSS)
- Create: `tests/state-contract.mjs`
- Modify: `tests/run.mjs` (스위트 등록), `.github/workflows/test.yml` (CI 목록)

**Interfaces:**
- Consumes: Task 1 의 `CANDLE_TF`, Task 3 의 `candles` 분기(이미 `state.chartMode` 를 읽는다).
- Produces: `state.chartMode` — `'candle'` 또는 `'line'`. 저장되고 재실행 시 복원된다.

- [ ] **Step 1: 실패하는 계약 테스트를 쓴다**

`tests/state-contract.mjs` 를 새로 만든다.

```js
// 저장 계약 가드 — 앱을 띄우지 않고 renderer.js 와 main.js 의 키 목록만 맞춰 본다.
//
// renderer.js 의 save() 가 보내는 키를 main.js 의 state:set 허용목록이 받아주지
// 않으면 store.set 이 호출되지 않는다. 예외도 로그도 없이 그 설정만 저장되지
// 않고, 앱을 껐다 켜야만 드러난다. 새 설정을 추가할 때 한쪽만 고치기 쉬워서
// 여기서 막는다.
import fs from 'node:fs';

const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// save() 가 api.setState 로 보내는 키
const saveStart = renderer.indexOf('const save = () => api.setState({');
const saveEnd = renderer.indexOf('});', saveStart);
check('renderer.js 에서 save() 를 찾았다', saveStart >= 0 && saveEnd > saveStart);

// main.js 의 허용목록 — [...].includes(k) 형태
const allowList = /\[([^\]]*)\]\.includes\(k\)/.exec(main);
check('main.js 에서 state:set 허용목록을 찾았다', !!allowList);

if (saveStart >= 0 && saveEnd > saveStart && allowList) {
  const sent = [...renderer.slice(saveStart, saveEnd).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const allowed = [...allowList[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);

  check('save() 가 보내는 키가 하나 이상이다', sent.length > 0, sent.join(' '));

  const missing = sent.filter((k) => !allowed.includes(k));
  check('save() 가 보내는 키를 main.js 가 전부 받는다', missing.length === 0,
    missing.length ? `허용목록에 없음: ${missing.join(' ')}` : `${sent.length}개 확인`);

  // 반대쪽도 본다. 허용목록에만 있는 키는 죽은 항목이다.
  const unsent = allowed.filter((k) => !sent.includes(k));
  check('허용목록에 보내지 않는 키가 없다', unsent.length === 0,
    unsent.length ? `save() 가 안 보냄: ${unsent.join(' ')}` : '');

  check('chartMode 가 양쪽에 있다',
    sent.includes('chartMode') && allowed.includes('chartMode'));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: 돌려서 실패를 확인한다**

```bash
node tests/state-contract.mjs
```

기대: `FAIL chartMode 가 양쪽에 있다`, `실패 1건`. 나머지 검사는 통과해야 한다 — 통과하지 않으면 정규식이 현재 코드와 안 맞는 것이니 거기부터 고친다.

- [ ] **Step 3: `renderer.js` 의 `save()` 에 키를 더한다**

```js
const save = () => api.setState({
  watchlist: state.watchlist,
  selected: state.selected,
  timeframe: state.timeframe,
  alerts: state.alerts,
  holdings: state.holdings,
  theme: state.theme,
  opacity: state.opacity,
  maPeriods: state.maPeriods,
  chartMode: state.chartMode,
});
```

- [ ] **Step 4: `main.js` 의 허용목록에 키를 더한다**

`ipcMain.handle('state:set', ...)` 안의 `includes(k)` 줄을 바꾼다.

```js
    if (['watchlist', 'selected', 'timeframe', 'alerts', 'holdings', 'theme', 'opacity', 'maPeriods', 'chartMode'].includes(k)) store.set(k, v);
```

- [ ] **Step 5: 초기화 기본값을 넣는다**

`renderer.js` 의 `state.maPeriods = Array.isArray(state.maPeriods)` 블록 **다음**에 붙인다.

```js
  // 저장값에 없거나 모르는 값이면 캔들로 시작한다
  state.chartMode = state.chartMode === 'line' ? 'line' : 'candle';
```

- [ ] **Step 6: 돌려서 통과를 확인한다**

```bash
node --check renderer.js && node --check main.js && node tests/state-contract.mjs
```

기대: 전부 `OK`, `PASS: 실패 0건`.

- [ ] **Step 7: 토글 버튼을 그린다**

`renderTabs()` 안, `box.innerHTML = '';` **다음**에 붙인다(타임프레임 버튼 왼쪽에 온다).

```js
  // 라인 / 캔들 토글. 1M · 3M 밖에서는 흐리게 — 이동평균 칩이 구간에 안 맞을 때
  // 흐려지고 title 로 이유를 말하는 것과 같은 방식이다.
  const fits = CANDLE_TF.has(state.timeframe);
  const t = document.createElement('button');
  t.type = 'button';
  t.textContent = '캔들';
  t.disabled = !fits;
  t.className = fits && state.chartMode === 'candle' ? 'on' : '';
  t.title = fits
    ? '라인 / 캔들 전환'
    : `${state.timeframe} 는 라인으로 그립니다 — 캔들은 1M · 3M 에서만`;
  t.onclick = async () => {
    state.chartMode = state.chartMode === 'candle' ? 'line' : 'candle';
    save();
    renderTabs();
    await loadChart();
  };
  box.appendChild(t);
```

- [ ] **Step 8: 비활성 상태 CSS 를 넣는다**

`index.html` 의 `.tf button.on { ... }` **다음** 줄에 붙인다.

```css
  .tf button:disabled { opacity: .38; cursor: default; }
  .tf button:disabled:hover { color: var(--dim); }
```

- [ ] **Step 9: 줄이 접히지 않는지 폭을 잰다**

그 줄은 이미 빡빡하다 — `renderTrendBadges` 주석에 "폭 340px 에 배지가 셋 이상 들어가면 줄이 접힌다"고 적혀 있다. 버튼을 하나 더했으니 실제 폭을 재야 한다.

`index.html` 을 브라우저로 열고(앱이 아니라 정적 파일이다) 콘솔에서 잰다. 배지가 전부 보이는 최악의 경우를 만들어 놓고 잰다.

```js
document.querySelector('.widget').style.width = '342px';
for (const id of ['period', 'cross', 'breakout', 'converge']) {
  const el = document.getElementById(id);
  el.hidden = false;
  el.textContent = { period: '3M +12.34%', cross: '5/20 골든 · 3일 전',
    breakout: '저항 돌파 +8.46% · 1일 전', converge: '수렴 12거래일 · 약 3주' }[id];
}
const meta = document.querySelector('.meta');
({ 높이: meta.getBoundingClientRect().height, 한줄인가: meta.getBoundingClientRect().height < 30 })
```

기대: `한줄인가: true`. `false` 면 `.tf` 줄이 아니라 이동평균 범례 줄(`#maLegend`)로 버튼을 옮기고, 그 이유를 커밋 메시지에 적는다.

> 이 저장소는 배지가 셋 이상이면 원래 접힌다고 적어 두었으므로, **버튼을 넣기 전과 후를 비교**한다. 원래도 접히던 조합이면 버튼 탓이 아니다 — 버튼을 지운 상태로 한 번 더 재서 확인한다.

- [ ] **Step 10: 새 스위트를 러너와 CI 에 등록한다**

`tests/run.mjs` 의 `ORDER` 배열에서 `'dom-contract.mjs',` 다음에 더한다.

```js
  'dom-contract.mjs',
  'state-contract.mjs',
```

`.github/workflows/test.yml` 의 `for f in ...` 줄을 바꾼다.

```bash
          for f in rsi cross candle trend quote-session session-ui dom-contract state-contract; do
```

- [ ] **Step 11: 전부 돌린다**

```bash
node --check renderer.js && node --check main.js
for f in rsi cross candle trend quote-session session-ui dom-contract state-contract; do printf "%-14s " "$f"; node tests/$f.mjs >/dev/null 2>&1 && echo PASS || echo FAIL; done
```

기대: 여덟 줄 모두 `PASS`.

- [ ] **Step 12: 커밋**

```bash
git add renderer.js main.js index.html tests/state-contract.mjs tests/run.mjs .github/workflows/test.yml
git commit -m "feat(chart): 라인 / 캔들 토글 버튼을 넣는다

타임프레임 줄 왼쪽에 버튼 하나. 1M · 3M 밖에서는 흐리게 비활성이고 title 이 이유를
말한다 — 이동평균 칩과 같은 방식이다. 선택은 저장돼 재실행 시 복원된다.

state-contract 스위트를 추가했다. renderer.js 의 save() 가 보내는 키를 main.js 의
허용목록이 받아주지 않으면 store.set 이 호출되지 않는데, 예외도 로그도 없이 그
설정만 저장되지 않고 앱을 껐다 켜야만 드러난다. 양쪽을 맞춰 보게 했다."
```

---

### Task 5: 툴팁과 문서

**Files:**
- Modify: `renderer.js` (툴팁 `beforeBody`)
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3 의 `candles` 불리언과 `opens` 배열.

- [ ] **Step 1: 툴팁에 시가를 더한다**

`drawChart` 의 `beforeBody` 콜백에서 종가 줄 다음, 고저 줄 앞에 넣는다.

```js
            beforeBody: (items) => {
              const lines = [];
              const p = items.find((i) => i.datasetIndex === 0);
              if (p) lines.push(money(p.parsed.y, cur));

              const i = p ? p.dataIndex : -1;
              // 캔들은 시가 대비로 색이 갈리므로 시가가 없으면 몸통의 근거가 안 보인다.
              if (candles && opens[i] != null) lines.push(`시 ${money(opens[i], cur)}`);

              const hi = highs[i]; const lo = lows[i];
              if (hi != null && lo != null && hi !== lo) {
                lines.push(`고저 ${money(lo, cur)} ~ ${money(hi, cur)}`);
              }
```

- [ ] **Step 2: 구문과 스위트를 확인한다**

```bash
node --check renderer.js
for f in rsi cross candle trend quote-session session-ui dom-contract state-contract; do printf "%-14s " "$f"; node tests/$f.mjs >/dev/null 2>&1 && echo PASS || echo FAIL; done
```

- [ ] **Step 3: README 에 절을 더한다**

`### 오늘 캔들` 절 **앞**, `- **검색** — ...` 줄 다음에 넣는다.

```markdown
### 캔들차트

**1M · 3M 에서 캔들로 그립니다.** 몸통은 시가~종가, 세로선은 저가~고가입니다. 색은 상세의 오늘 캔들과 같은 규칙 — 시가보다 오르면 빨강, 내리면 파랑, 같으면 회색입니다. 타임프레임 버튼 왼쪽의 `캔들` 버튼으로 종가 라인과 오갈 수 있고, 선택은 저장됩니다.

나머지 구간은 라인입니다. 창이 340px 라 차트 영역이 약 280px 인데, 1Y(243봉)는 봉 하나가 **1.2px** 라 몸통도 꼬리도 구분되지 않습니다. 1D(5분봉)·1W(30분봉)은 분봉이라 "일봉 캔들"과 뜻이 다릅니다. 그 구간에서는 버튼이 흐리게 비활성이고, 마우스를 올리면 이유가 나옵니다 — 이동평균선이 구간에 비해 길면 자동으로 빠지는 것과 같은 방침입니다.

캔들 모드에서는 종가 라인과 고가~저가 밴드를 감춥니다. 꼬리가 이미 고저를 말하므로 밴드는 중복이고, 라인은 캔들 위에 겹칩니다. 이동평균선·추세선·거래량·기준선은 그대로 있습니다.

> **왜 데이터셋을 지우지 않고 감추는가**
> 감춘 밴드가 y축 범위를 잡아 줍니다. 캔들은 캔버스에 직접 그리므로 축이 그 존재를 모릅니다 — 지우면 꼬리 끝이 축 밖으로 나가 말없이 잘립니다(추세선에서 겪은 그 문제입니다).
> 종가 데이터셋도 값만 남겨 둡니다. 호버가 좌표가 아니라 인덱스로 도는 덕에 툴팁과 이동평균 범례가 그대로 동작합니다.

툴팁에는 캔들 모드일 때 `시 279,000` 한 줄이 더 붙습니다. 몸통 색이 시가 대비라, 시가가 없으면 왜 그 방향인지 알 수 없기 때문입니다.
```

- [ ] **Step 4: 테스트 절에 새 스위트를 적는다**

README 의 `### CI` 절에서 스위트 이름을 나열한 문장을 고친다.

```markdown
푸시와 PR 마다 **앱을 띄우지 않는 여덟 개**가 GitHub Actions 에서 돕니다 — `rsi` · `cross` · `candle` · `trend` · `quote-session` · `session-ui` · `dom-contract` · `state-contract`.
```

- [ ] **Step 5: 커밋**

```bash
git add renderer.js README.md
git commit -m "feat(chart): 캔들 툴팁에 시가를 넣고 문서를 쓴다

몸통 색이 시가 대비라 시가가 없으면 툴팁만 보고는 방향의 근거를 알 수 없다.
캔들 모드에서만 한 줄 붙는다.

README 에 캔들차트 절을 넣었다 — 왜 1M · 3M 뿐인지(1Y 는 봉 하나가 1.2px),
그리고 왜 데이터셋을 지우지 않고 감추는지(y축 범위와 인덱스 호버)."
```

- [ ] **Step 6: 사용자에게 넘긴다**

화면은 자동 검증 대상이 아니다. 무엇을 봐 달라고 할지 정리해 보고한다. 최소한 이것들이다.

- 1M · 3M 에서 캔들이 보이는가, 몸통·꼬리가 구분되는가 (**3M 은 몸통이 3px 이라 특히 확인이 필요하다** — 못 쓸 정도면 3M 을 범위에서 뺀다)
- 이동평균선·추세선이 캔들 **위**에 그려지는가
- `캔들` 버튼이 1D · 1W · 1Y 에서 흐리고, 마우스를 올리면 이유가 나오는가
- 버튼을 눌러 라인으로 바꾸고 **앱을 껐다 켰을 때 라인이 유지되는가** (허용목록이 빠지면 여기서만 드러난다)
- 툴팁에 `시 ...` 줄이 캔들 모드에서만 나오는가
- 다크·라이트 테마 양쪽에서 색이 맞는가
