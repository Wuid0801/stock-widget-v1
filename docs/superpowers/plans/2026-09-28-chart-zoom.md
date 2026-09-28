# 차트 끌어서 확대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3M · 1Y 차트를 끌어서 고른 구간을 차트 전체로 펼치고(y축 맞춤), 봉이 충분히 넓어지면 1Y 도 캔들로 그린다.

**Architecture:** 계산(끈 구간 정렬 · 날짜→봉 번호 · 캔들 기준)은 `indicators.js` 순수 함수로 두고 `tests/*.mjs` 로 검증한다. `renderer.js` 는 확대 구간을 날짜 두 개(`zoom`)로 기억하고, `drawChart` 가 그때마다 Chart.js 의 `scales.x.min/max` 로 옮긴다 — y축은 Chart.js 가 보이는 점만으로 다시 잡는다. 끌기는 캔버스 요소에 한 번만 붙인 마우스 이벤트와 선택 상자 플러그인으로 한다.

**Tech Stack:** Electron, Chart.js 4.5.1(`node_modules/chart.js/dist/chart.umd.js`), 순수 Node 테스트 스위트(`node tests/<name>.mjs`, 의존성 없음).

**Spec:** `docs/superpowers/specs/2026-09-28-chart-zoom-design.md`

## Global Constraints

- **앱과 `npm test` 는 실행하지 않는다.** 검증은 `node --check <file>` 과 앱을 띄우지 않는 개별 스위트(`node tests/<name>.mjs`, cross 는 `TZ=Asia/Seoul`)까지만. 끌어서 확대하는 실제 동작은 사용자가 화면에서 본다.
- **주석과 문서는 한국어로 쓴다.** 예외: `tests/session-ui.mjs` 는 기존 테스트 이름이 영어라 그 파일 안에서는 영어를 유지한다.
- **숫자에는 근거를 적는다.** 새 상수(5 · 70 등)에는 왜 그 값인지 주석을 단다.
- **색은 `cssVar` 로 읽는다.** 테마를 바꾸면 따라와야 한다.
- 커밋 메시지는 `<type>(<scope>): <한글 subject>` 형식, 본문도 한글. **`Co-Authored-By` 트레일러는 붙이지 않는다.** subject 는 사용자가 보는 변화를 직관적으로 쓴다.
- 줄 번호는 편집하면서 바뀐다. 위치는 항상 함수 이름이나 마커 주석으로 찾는다. 이 문서의 줄 번호는 2026-09-28 기준 참고값이다.
- **`tests/session-ui.mjs` 는 `renderer.js` 의 `// 과열도 5단계` 마커 앞부분(prelude)과 `loadChart` 등 일부 함수만 vm 에서 돌린다.** `loadChart` 가 새로 읽는 모듈 변수는 반드시 그 마커 **앞**에 선언해야 한다. 아니면 `ReferenceError` 로 스위트가 깨진다. `drawChart` 는 그 하네스에서 스텁이라 안에서 DOM 을 만져도 된다.
- 확대 구간은 저장하지 않는다 — `save()` · main.js `state:set` · `state:get` 은 건드리지 않는다.

## 파일 구조

| 파일 | 책임 | 태스크 |
|---|---|---|
| `indicators.js` | 순수 계산 — `candleMode` 새 기준, `CANDLE_MAX_BARS`, `ZOOM_TF` · `ZOOM_MIN_BARS` · `dragToRange` · `zoomRange` | 1, 2 |
| `tests/candle.mjs` | 바뀐 `candleMode` 검사 | 1 |
| `tests/zoom.mjs` (새 파일) | 끈 구간 · 날짜→봉 번호 검사 | 2 |
| `tests/run.mjs`, `.github/workflows/test.yml` | 스위트 목록에 `zoom` | 2 |
| `renderer.js` | 캔들 판단 호출부, 확대 상태 반영, 끌기 이벤트, 선택 상자 플러그인 | 1, 3, 4 |
| `index.html` | `.chartctl` 묶음, `#zoomReset` 버튼과 스타일 | 3 |
| `README.md`, `docs/DEVELOPMENT.md` | 사용법 한 줄, 동작 원리 | 1, 2, 4 |

---

### Task 1: 캔들 기준을 "보이는 봉 수"로 바꾼다

확대하지 않은 화면에서는 결과가 지금과 같아야 한다(1M · 3M 캔들, 1Y · 1D · 1W 라인). Task 3 이 확대했을 때 보이는 봉 수를 넘긴다.

**Files:**
- Modify: `indicators.js` (`// --- 차트 캔들 ---` 절의 `CANDLE_TF` · `candleMode`, 맨 끝 `module.exports`)
- Modify: `tests/candle.mjs` (`// --- 11. 캔들로 그리는 구간 ---` 블록)
- Modify: `renderer.js` (`drawChart`, `loadChart` 의 `const sig`, `MODE_ICON` 위 주석, `renderChartMode`, `renderTabs`, init 의 `chartMode').onclick`)
- Modify: `docs/DEVELOPMENT.md` (`### 캔들차트` 의 "나머지 구간은 라인입니다" 문단)

**Interfaces:**
- Produces: `candleMode(bars: number, daily: boolean, chartMode: string): boolean`, `CANDLE_MAX_BARS = 70`, `renderChartMode(bars: number, daily: boolean)` (renderer.js). `CANDLE_TF` 는 없어진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/candle.mjs` 에서 `// --- 11. 캔들로 그리는 구간 ---` 부터 그 블록의 닫는 `}` 까지를 통째로 아래로 바꾼다.

```js
// --- 11. 캔들로 그리는 구간 -----------------------------------------------------
// 기준은 기간 이름이 아니라 화면에 보이는 봉 수다. 확대하지 않은 화면에서는 예전
// 기간 기준(1M · 3M 만 캔들)과 결과가 같아야 한다.
{
  check('3M(62봉) 은 캔들', C.candleMode(62, true, 'candle') === true);
  check('1M(22봉) 도 캔들', C.candleMode(22, true, 'candle') === true);
  check('1Y(243봉) 는 봉이 1.2px 라 라인', C.candleMode(243, true, 'candle') === false);
  check('1D(5분봉 78개) 는 분봉이라 라인', C.candleMode(78, false, 'candle') === false);
  // 1W 는 30분봉 약 65개로 70 안쪽이지만 분봉이라 라인이어야 한다 — daily 가 걸러야 한다
  check('1W(30분봉 65개) 도 분봉이라 라인', C.candleMode(65, false, 'candle') === false);

  // 1Y 를 확대해 좁히면 캔들이 된다
  check('70봉까지는 캔들', C.candleMode(70, true, 'candle') === true);
  check('71봉부터 라인', C.candleMode(71, true, 'candle') === false);
  check('CANDLE_MAX_BARS 는 70', C.CANDLE_MAX_BARS === 70);
  check('봉이 없으면 라인', C.candleMode(0, true, 'candle') === false);

  check('line 을 고르면 3M 도 라인', C.candleMode(62, true, 'line') === false);
  // 저장값에 모르는 문자열이 들어 있어도 기본값(캔들)으로 본다
  check('모르는 값은 캔들로 본다', C.candleMode(62, true, undefined) === true);
}
```

- [ ] **Step 2: 실패하는지 확인한다**

Run: `node tests/candle.mjs`
Expected: 마지막 줄 `FAIL: 실패 N건` (N ≥ 1). 예: `FAIL 3M(62봉) 은 캔들` — 옛 `candleMode(timeframe, chartMode)` 는 `CANDLE_TF.has(62)` 가 false 다.

- [ ] **Step 3: `indicators.js` 를 고친다**

아래 블록을 찾아서

```js
// 캔들로 그리는 타임프레임. 창이 340px 라 차트 영역이 약 280px 인데, 1Y(243봉)는
// 봉 하나가 1.2px 라 몸통도 꼬리도 구분되지 않는다. 1D(5분봉) · 1W(30분봉)은
// 분봉이라 "일봉 캔들" 과 뜻이 다르다.
const CANDLE_TF = new Set(['1M', '3M']);

// 저장값이 'line' 일 때만 라인이다. 모르는 값이 들어 있으면 기본값(캔들)으로 본다.
function candleMode(timeframe, chartMode) {
  return chartMode !== 'line' && CANDLE_TF.has(timeframe);
}
```

아래로 바꾼다.

```js
// 캔들로 그릴 수 있는 최대 봉 수. 창이 340px 라 차트 영역이 약 280px 이고, 3M 이
// 62~66봉(간격 약 4.3px → 몸통 3px)이다. 그보다 촘촘하면 몸통과 꼬리가 구분되지
// 않는다 — 1Y(243봉)는 봉 하나가 1.2px 다. 70 은 3M 을 넉넉히 덮는 값이다.
const CANDLE_MAX_BARS = 70;

// 캔들로 그릴지. 기간 이름이 아니라 화면에 보이는 봉 수로 정한다 — 1Y 도 확대해
// 70봉 이하로 좁히면 캔들이 된다. 분봉(1D · 1W)은 "일봉 캔들" 과 뜻이 달라 늘 라인이다.
// 저장값이 'line' 일 때만 라인이다. 모르는 값이 들어 있으면 기본값(캔들)으로 본다.
function candleMode(bars, daily, chartMode) {
  return chartMode !== 'line' && daily && bars > 0 && bars <= CANDLE_MAX_BARS;
}
```

맨 끝 `module.exports` 에서 `CANDLE_TF, candleMode, candleWidth, candleBody,` 를 `CANDLE_MAX_BARS, candleMode, candleWidth, candleBody,` 로 바꾼다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node tests/candle.mjs`
Expected: 마지막 줄 `PASS: 실패 0건`

- [ ] **Step 5: `renderer.js` 의 호출부를 새 인자에 맞춘다**

(a) `drawChart` 안에서

```js
  const candles = candleMode(state.timeframe, state.chartMode) && opens.length > 0;
```

를 아래로 바꾼다.

```js
  const daily = TF[state.timeframe].interval === '1d';
  const candles = candleMode(closes.length, daily, state.chartMode) && opens.length > 0;
  renderChartMode(closes.length, daily); // 전환 아이콘도 같은 기준으로 보인다
```

(b) `loadChart` 의 `const sig = ...` 바로 위 주석에서

```js
  // 토글은 chartMode 만 바꾸므로 candleMode 결과(drawChart 가 캔들 여부를 정하는
  // 것과 같은 식)도 서명에 넣어야 다시 그려진다. 종가가 같아도 두 폴링 사이 고가·
```

를

```js
  // 토글은 chartMode 만 바꾸므로 chartMode 도 서명에 넣어야 다시 그려진다(캔들
  // 여부는 drawChart 가 보이는 봉 수로 정한다). 종가가 같아도 두 폴링 사이 고가·
```

로 바꾸고, 서명 안의 줄

```js
    + `|${candleMode(state.timeframe, state.chartMode)}`
```

를

```js
    + `|${state.chartMode}`
```

로 바꾼다.

(c) `MODE_ICON` 위 주석의 두 줄

```js
// 되는지를 말한다. 캔들을 그리지 않는 기간(1D · 1W · 1Y)에는 차트 위에 띄워 봐야
// 방해라 숨긴다. 선은 반 픽셀에 두어 1px 로 또렷하게 찍히게 했다.
```

를

```js
// 되는지를 말한다. 캔들로 그릴 수 없는 화면(분봉이거나 보이는 봉이 70개 초과)에는
// 차트 위에 띄워 봐야 방해라 숨긴다. 선은 반 픽셀에 두어 1px 로 또렷하게 찍히게 했다.
```

로 바꾼다.

(d) `renderChartMode` 를 통째로 아래로 바꾼다. 보이는 봉 수는 `drawChart` 만 알므로 거기서 넘겨받는다.

```js
function renderChartMode(bars, daily) {
  const b = document.getElementById('chartMode');
  const candle = state.chartMode === 'candle';
  b.hidden = !candleMode(bars, daily, 'candle'); // 캔들로 그릴 수 있는 화면에서만
  b.innerHTML = MODE_ICON[candle ? 'candle' : 'line'];
  b.title = candle ? '라인으로 보기' : '캔들로 보기';
}
```

(e) `renderTabs` 안의 줄

```js
  renderChartMode(); // 기간이 바뀌면 보일지 말지도 바뀐다
```

을 지운다(이제 `drawChart` 가 그린다).

(f) init 의 `document.getElementById('chartMode').onclick` 안에서 `renderChartMode();` 줄을 지운다. 남는 모양:

```js
  document.getElementById('chartMode').onclick = async () => {
    state.chartMode = state.chartMode === 'candle' ? 'line' : 'candle';
    save();
    await loadChart(); // 서명에 chartMode 가 있어 다시 그려지고, drawChart 가 아이콘도 바꾼다
  };
```

- [ ] **Step 6: 남은 옛 이름이 없는지 확인한다**

Run: `grep -n "CANDLE_TF\|candleMode(state.timeframe\|renderChartMode()" renderer.js indicators.js tests/*.mjs`
Expected: 출력 없음

- [ ] **Step 7: 문법 검사와 스위트**

Run:
```bash
node --check renderer.js && node --check indicators.js && for s in rsi cross candle trend quote-session session-ui dom-contract state-contract; do printf '%-15s ' $s; TZ=Asia/Seoul node tests/$s.mjs 2>&1 | tail -1; done
```
Expected: 여덟 줄 모두 `PASS` 로 시작

- [ ] **Step 8: 개발 문서를 고친다**

`docs/DEVELOPMENT.md` 의 `### 캔들차트` 에서

```
나머지 구간은 라인입니다. 창이 340px 라 차트 영역이 약 280px 인데, 1Y(243봉)는 봉 하나가 **1.2px** 라 몸통도 꼬리도 구분되지 않습니다. 1D(5분봉)·1W(30분봉)은 분봉이라 "일봉 캔들"과 뜻이 다릅니다. 그 구간에서는 전환 아이콘이 숨습니다. 차트 위에 흐린 아이콘을 띄워 봐야 방해만 되기 때문입니다.
```

를 아래로 바꾼다.

```
나머지 구간은 라인입니다. 창이 340px 라 차트 영역이 약 280px 인데, 1Y(243봉)는 봉 하나가 **1.2px** 라 몸통도 꼬리도 구분되지 않습니다. 1D(5분봉)·1W(30분봉)은 분봉이라 "일봉 캔들"과 뜻이 다릅니다. 그 구간에서는 전환 아이콘이 숨습니다. 차트 위에 흐린 아이콘을 띄워 봐야 방해만 되기 때문입니다.

기준은 기간 이름이 아니라 **화면에 보이는 봉 수**입니다(`CANDLE_MAX_BARS` = 70, 3M 의 62~66봉을 덮는 값). 확대하지 않은 화면에서는 1M · 3M 만 캔들이 되고, 1Y 를 끌어서 70봉 이하로 좁히면 캔들이 됩니다.
```

- [ ] **Step 9: 커밋**

```bash
git add indicators.js tests/candle.mjs renderer.js docs/DEVELOPMENT.md
git commit -m "refactor(chart): 캔들 기준을 기간 이름에서 보이는 봉 수로 바꾼다" -m "1M · 3M 만 캔들이던 규칙을 보이는 봉 70개 이하로 옮긴다. 확대하지 않은 화면에서는 결과가 같다(1M 22봉 · 3M 62봉 캔들, 1Y 243봉 라인, 분봉 라인). 끌어서 확대하면 1Y 도 좁힌 구간이 캔들로 그려지게 하려는 준비다. 70 은 3M(62~66봉, 몸통 3px)을 덮는 값이다."
```

---

### Task 2: 확대 구간 계산과 스위트

**Files:**
- Modify: `indicators.js` (Task 1 의 `candleBody` 함수 뒤, `// 볼록 껍질` 또는 추세선 절 앞 — 캔들 절 끝에 새 절로)
- Create: `tests/zoom.mjs`
- Modify: `tests/run.mjs` (`ORDER` 배열), `.github/workflows/test.yml` (주석과 `for f in ...` 목록)
- Modify: `docs/DEVELOPMENT.md` (`### CI` 두 문단)

**Interfaces:**
- Consumes: 없음
- Produces: `ZOOM_TF: Set<string>` (`'3M'`, `'1Y'`), `ZOOM_MIN_BARS = 5`, `dragToRange(a: number, b: number): {from, to} | null`, `zoomRange(times: number[] /* ms */, start: number, end: number): {from, to} | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/zoom.mjs` 를 새로 만든다.

```js
// 끌어서 확대 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 구간 계산을 검증한다
// (candle.mjs · trend.mjs 와 같은 방식).
//
// 두 가지를 고정한다.
//
// 1. 끈 방향과 상관없이 앞뒤가 맞고, 5봉 미만은 확대하지 않는다(클릭 · 손떨림 · 취소).
// 2. 날짜로 기억한 구간이 30초 갱신 · 다음 날 새 봉 · 마지막 봉 시각 변화에도
//    같은 봉을 가리킨다.
import * as Z from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('dragToRange 를 indicators.js 가 내보낸다', typeof Z.dragToRange === 'function');
check('zoomRange 를 indicators.js 가 내보낸다', typeof Z.zoomRange === 'function');
if (typeof Z.dragToRange !== 'function' || typeof Z.zoomRange !== 'function') {
  console.log('\n필요한 함수가 없어 이후 검사를 건너뜁니다.');
  process.exit(1);
}

// --- 1. 끈 구간 -----------------------------------------------------------------
{
  check('왼쪽에서 오른쪽', same(Z.dragToRange(10, 20), { from: 10, to: 20 }));
  check('오른쪽에서 왼쪽으로 끌어도 같다', same(Z.dragToRange(20, 10), { from: 10, to: 20 }));
  check('4봉은 확대하지 않는다', Z.dragToRange(10, 13) === null);
  check('5봉은 확대한다', same(Z.dragToRange(10, 14), { from: 10, to: 14 }));
  check('제자리 클릭은 확대하지 않는다', Z.dragToRange(7, 7) === null);
  check('ZOOM_MIN_BARS 는 5', Z.ZOOM_MIN_BARS === 5);
  check('ZOOM_TF 는 3M · 1Y 둘뿐이다',
    Z.ZOOM_TF.size === 2 && Z.ZOOM_TF.has('3M') && Z.ZOOM_TF.has('1Y'));
}

// --- 2. 날짜 → 봉 번호 -----------------------------------------------------------
// 야후 KRX 일봉은 00:00 UTC(09:00 KST)에 찍힌다. 장중 마지막 봉만 시각이 마지막
// 체결 시각이라 갱신마다 바뀐다(실측 01:26:11 / 01:26:12).
const DAY = 86400000;
const d0 = Date.parse('2026-06-01T00:00:00Z');
const days = (n) => Array.from({ length: n }, (_, i) => d0 + i * DAY);
{
  const times = days(30);
  check('날짜 구간을 봉 번호로 바꾼다',
    same(Z.zoomRange(times, times[5], times[14]), { from: 5, to: 14 }));

  const next = [...times, d0 + 30 * DAY]; // 다음 날 새 봉이 뒤에 붙었다
  check('새 봉이 붙어도 같은 구간',
    same(Z.zoomRange(next, times[5], times[14]), { from: 5, to: 14 }));

  const shifted = times.slice(1); // 1Y 창이 하루 밀려 맨 앞 봉이 빠졌다
  check('앞 봉이 빠지면 번호만 당겨진다',
    same(Z.zoomRange(shifted, times[5], times[14]), { from: 4, to: 13 }));

  const live = [...times.slice(0, 29), d0 + 29 * DAY + 5171000];  // 확대할 때 01:26:11
  const later = [...times.slice(0, 29), d0 + 29 * DAY + 5200000]; // 다음 갱신 01:26:40
  check('마지막 봉 시각이 바뀌어도 그 봉이 구간에 남는다',
    same(Z.zoomRange(later, live[20], live[29]), { from: 20, to: 29 }));

  check('데이터에 없는 구간이면 null',
    Z.zoomRange(times, d0 + 100 * DAY, d0 + 120 * DAY) === null);
  check('남는 봉이 5개 미만이면 null', Z.zoomRange(times, times[27], d0 + 40 * DAY) === null);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: 실패하는지 확인한다**

Run: `node tests/zoom.mjs`
Expected: `FAIL dragToRange 를 indicators.js 가 내보낸다` 와 "필요한 함수가 없어 이후 검사를 건너뜁니다." 후 종료 코드 1

- [ ] **Step 3: `indicators.js` 에 구간 계산을 넣는다**

`candleBody` 함수 바로 뒤(그 함수의 닫는 `}` 다음 빈 줄)에 새 절을 넣는다.

```js
// --- 끌어서 확대 ------------------------------------------------------------------
// 3M · 1Y 차트에서 끌어서 고른 구간을 차트 전체로 펼친다.

// 확대를 허용하는 기간. 1M(약 22봉)은 확대할 일이 거의 없고, 1D · 1W 는 분봉이라
// 끝에 실시간 점이 붙는 등 다르게 동작한다.
const ZOOM_TF = new Set(['3M', '1Y']);

// 이보다 좁게 끌면 확대하지 않는다. 클릭 · 손떨림과 구분하고, 끌다가 도로 좁히면
// 취소가 된다.
const ZOOM_MIN_BARS = 5;

// 끈 두 지점(봉 번호)을 앞뒤로 정렬한다. 오른쪽에서 왼쪽으로 끌어도 같다.
function dragToRange(a, b) {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return to - from + 1 >= ZOOM_MIN_BARS ? { from, to } : null;
}

// 날짜로 기억해 둔 구간을 지금 데이터의 봉 번호로 바꾼다. 30초마다 다시 그리고 다음
// 날엔 봉이 하나 늘어 번호가 밀리므로, 번호가 아니라 날짜로 기억한다.
// 비교는 UTC 날짜로 한다(renderer.js maFor 와 같은 규칙) — 장중 마지막 봉의 시각은
// 마지막 체결 시각이라 갱신마다 바뀌어, 시각으로 비교하면 그 봉이 구간 밖으로 밀려난다.
function zoomRange(times, start, end) {
  const dayOf = (t) => Math.floor(t / 86400000);
  const s = dayOf(start);
  const e = dayOf(end);
  let from = -1;
  let to = -1;
  for (let i = 0; i < times.length; i++) {
    const d = dayOf(times[i]);
    if (d < s || d > e) continue;
    if (from < 0) from = i;
    to = i;
  }
  return from >= 0 && to - from + 1 >= ZOOM_MIN_BARS ? { from, to } : null;
}
```

맨 끝 `module.exports` 의 `CANDLE_MAX_BARS, candleMode, candleWidth, candleBody,` 줄 바로 뒤에 한 줄을 더한다.

```js
    ZOOM_TF, ZOOM_MIN_BARS, dragToRange, zoomRange,
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `node tests/zoom.mjs`
Expected: 마지막 줄 `PASS: 실패 0건`

- [ ] **Step 5: 스위트 목록에 넣는다**

(a) `tests/run.mjs` 의 `ORDER` 에서 `'candle.mjs',` 줄 바로 뒤에 `'zoom.mjs',` 를 넣는다.

(b) `.github/workflows/test.yml`
- 주석 `# 이 여덟은 Node 내장 모듈과 앱 파일(indicators.js · quote-session.cjs ·` 의 `여덟` 을 `아홉` 으로.
- `for f in rsi cross candle trend quote-session session-ui dom-contract state-contract; do` 를 `for f in rsi cross candle zoom trend quote-session session-ui dom-contract state-contract; do` 로.

(c) `docs/DEVELOPMENT.md` 의 `### CI`
- `푸시와 PR 마다 **앱을 띄우지 않는 여덟 개**가 GitHub Actions 에서 돕니다 — \`rsi\` · \`cross\` · \`candle\` · \`trend\` ·` 에서 `여덟 개` → `아홉 개`, `` `candle` · `` 뒤에 `` `zoom` · `` 를 넣는다.
- 다음 문단 첫머리 `이 여덟은` → `이 아홉은`.

- [ ] **Step 6: 문법 검사와 스위트**

Run:
```bash
node --check indicators.js && for s in rsi cross candle zoom trend quote-session session-ui dom-contract state-contract; do printf '%-15s ' $s; TZ=Asia/Seoul node tests/$s.mjs 2>&1 | tail -1; done
```
Expected: 아홉 줄 모두 `PASS` 로 시작

- [ ] **Step 7: 커밋**

```bash
git add indicators.js tests/zoom.mjs tests/run.mjs .github/workflows/test.yml docs/DEVELOPMENT.md
git commit -m "feat(zoom): 끌어서 고른 구간과 날짜 구간을 봉 번호로 바꾸는 계산을 넣는다" -m "dragToRange 는 끈 방향과 상관없이 앞뒤를 맞추고 5봉 미만은 확대하지 않는다(클릭 · 손떨림 · 취소). zoomRange 는 날짜로 기억한 구간을 지금 데이터의 봉 번호로 바꾼다 — 30초 갱신과 다음 날 새 봉에도 같은 구간을 가리키고, 비교를 UTC 날짜로 해 장중 마지막 봉 시각이 바뀌어도 그 봉이 빠지지 않는다. tests/zoom.mjs 를 CI 스위트에 넣었다(여덟 → 아홉)."
```

---

### Task 3: 확대 상태를 차트에 반영한다

이 태스크가 끝나면 `zoom` 에 값이 있을 때 차트가 그 구간으로 그려지고 `전체` 버튼으로 풀린다. 끌어서 `zoom` 을 채우는 조작은 Task 4 다.

**Files:**
- Modify: `renderer.js` (prelude 의 `let chartBars` 근처, `candlePlugin`, `drawChart`, `loadChart` 의 `const sig`, `select`, `renderTabs` 의 기간 버튼 onclick, keydown 의 기간 단축키, init)
- Modify: `index.html` (`#chartMode` 스타일 블록, `.chartbox` 마크업)
- Modify: `docs/DEVELOPMENT.md` (`### 캔들차트` 절 다음에 새 절)

**Interfaces:**
- Consumes: `candleMode(bars, daily, chartMode)`, `renderChartMode(bars, daily)` (Task 1), `ZOOM_TF`, `zoomRange(times, start, end)` (Task 2)
- Produces: 모듈 변수 `zoom: {start: number, end: number} | null` (봉 시각 ms, prelude 에 선언), `resetZoom(): void`, DOM `#zoomReset` 버튼과 `.chartctl` 묶음

- [ ] **Step 1: `zoom` 을 prelude 에 선언한다**

`renderer.js` 에서

```js
let chartBars = 0; // 현재 차트의 봉 수. 0이면 이동평균을 안 그리는 타임프레임(1D/1W)
```

바로 아래 줄에 넣는다.

```js
// 끌어서 고른 확대 구간 { start, end } — 봉 시각(ms). 번호가 아니라 날짜로 기억해
// 30초 갱신 · 다음 날 새 봉에도 같은 구간이 잡힌다. 3M · 1Y 에서만, 저장하지 않는다.
// loadChart 의 서명이 읽으므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
let zoom = null;
```

Run: `node -e "const s=require('fs').readFileSync('renderer.js','utf8');console.log(s.indexOf('let zoom = null')<s.indexOf('// 과열도 5단계'))"`
Expected: `true`

- [ ] **Step 2: `candlePlugin` 의 봉 간격을 픽셀 거리로 바꾼다**

`candlePlugin` 안의

```js
    const w = candleWidth(sx.width / Math.max(1, opens.length));
```

를 아래로 바꾼다.

```js
    // 봉 간격 = 이웃한 두 봉의 픽셀 거리. 확대하면 전체 봉 수가 아니라 보이는 봉
    // 수로 나눈 값이 되어야 해서 폭 ÷ 봉 수로는 안 된다. 구간 밖 봉은 아래 clip 이 자른다.
    const step = opens.length > 1
      ? Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0)) : sx.width;
    const w = candleWidth(step);
```

- [ ] **Step 3: `drawChart` 가 확대 구간을 쓰게 한다**

(a) Task 1 에서 넣은 세 줄

```js
  const daily = TF[state.timeframe].interval === '1d';
  const candles = candleMode(closes.length, daily, state.chartMode) && opens.length > 0;
  renderChartMode(closes.length, daily); // 전환 아이콘도 같은 기준으로 보인다
```

을 아래로 바꾼다.

```js
  const daily = TF[state.timeframe].interval === '1d';
  // 확대 구간(3M · 1Y). 날짜로 기억해 둔 것을 지금 봉 번호로 바꾼다 — 구간이
  // 사라졌으면(5봉 미만) 전체 보기로 돌아간다.
  const zr = zoom && ZOOM_TF.has(state.timeframe) ? zoomRange(times, zoom.start, zoom.end) : null;
  if (!zr) zoom = null;
  const bars = zr ? zr.to - zr.from + 1 : closes.length; // 화면에 보이는 봉 수
  const candles = candleMode(bars, daily, state.chartMode) && opens.length > 0;
  renderChartMode(bars, daily); // 전환 아이콘도 같은 기준으로 보인다
  document.getElementById('zoomReset').hidden = !zr;
```

(b) 거래량 최댓값 두 줄

```js
  // 거래량 막대는 차트 아래 1/4 만 쓰도록 별도 y축을 최댓값의 4배로 잡는다
  const maxVol = volumes.length ? Math.max(...volumes) : 0;
```

을 아래로 바꾼다.

```js
  // 거래량 막대는 차트 아래 1/4 만 쓰도록 별도 y축을 최댓값의 4배로 잡는다.
  // 확대 중에는 보이는 구간의 최댓값으로 — 전체 최댓값이면 막대가 납작해진다.
  const shownVol = zr ? volumes.slice(zr.from, zr.to + 1) : volumes;
  const maxVol = shownVol.length ? Math.max(...shownVol) : 0;
```

(c) 추세선 데이터셋의 `...trends.map((t) => ({` 를 `...(zr ? [] : trends).map((t) => ({` 로 바꾸고, 바로 위 주석 블록(`// 지지·저항 추세선 (3M · 1Y 에서만 전달된다).` 로 시작하는 네 줄) 끝에 두 줄을 더한다.

```js
      // 확대 중에는 숨긴다. "지금"을 말하는 선(최근 5봉을 빼고 만들어 오늘 값 · 돌파를
      // 계산)이고, 과거 구간 가격에서 먼 선이 y축을 다시 벌려 확대 효과를 깎는다.
```

(d) `scales` 의 `x: {` 블록

```js
        x: {
          grid: { display: false },
```

을 아래로 바꾼다.

```js
        x: {
          // 확대 구간. y축은 Chart.js 가 이 구간 안의 점만으로 다시 잡는다 —
          // DatasetController.getMinMax 가 다른 축의 사용자 범위(getUserBounds) 밖
          // 점을 건너뛴다(4.5.1 에서 확인). 투명 고저 밴드가 꼬리까지 범위를 잡는다.
          min: zr ? zr.from : undefined,
          max: zr ? zr.to : undefined,
          grid: { display: false },
```

- [ ] **Step 4: 다시 그리기 서명에 확대 구간을 넣는다**

`loadChart` 의 서명 안에서 Task 1 이 넣은 줄

```js
    + `|${state.chartMode}`
```

바로 뒤에 한 줄을 넣는다.

```js
    + `|${zoom ? `${zoom.start}-${zoom.end}` : ''}` // 확대 · 되돌리기는 drawChart 로 바로 그리지만, 서명도 그린 것을 말하게 둔다
```

- [ ] **Step 5: 기간 · 종목이 바뀌면 확대를 푼다**

(a) `renderTabs` 의 기간 버튼 onclick

```js
    b.onclick = async () => {
      state.timeframe = key;
```

을

```js
    b.onclick = async () => {
      state.timeframe = key;
      zoom = null; // 다른 기간의 날짜 구간은 뜻이 없다
```

로 바꾼다.

(b) keydown 의 기간 단축키(`const tabs = Object.keys(TF); // 1~5 → ...` 아래)에서

```js
    if (key === state.timeframe) return;
    state.timeframe = key;
```

를

```js
    if (key === state.timeframe) return;
    state.timeframe = key;
    zoom = null; // 다른 기간의 날짜 구간은 뜻이 없다
```

로 바꾼다.

(c) `select` 의 첫 줄 `state.selected = symbol;` 앞에 한 줄을 넣는다.

```js
  if (symbol !== state.selected) zoom = null; // 다른 종목에 같은 날짜 구간은 뜻이 없다
```

- [ ] **Step 6: `resetZoom` 과 `전체` 버튼**

(a) `renderer.js` 의 `function renderChartMode(bars, daily) {` 바로 위에 넣는다.

```js
// 전체 보기로. 이미 받은 데이터로 다시 그린다 — 네트워크 요청 없음(테마 변경과 같은 경로).
function resetZoom() {
  if (!zoom) return;
  zoom = null;
  if (lastChart) drawChart(lastChart);
}
```

(b) init 의 `document.getElementById('chartMode').onclick = async () => {` 블록 바로 아래에 넣는다.

```js
  document.getElementById('zoomReset').onclick = resetZoom;
```

(c) `index.html` 의 `.chartbox` 줄

```html
      <div class="chartbox"><canvas id="chart"></canvas><button id="chartMode" type="button" hidden></button></div>
```

을 아래로 바꾼다.

```html
      <div class="chartbox"><canvas id="chart"></canvas><span class="chartctl"><button id="chartMode" type="button" hidden></button><button id="zoomReset" type="button" title="전체 기간 보기" hidden>전체</button></span></div>
```

(d) `index.html` 의 `#chartMode` 스타일 블록

```css
  #chartMode {
    position: absolute; top: 4px; left: 4px; z-index: 1;
    display: flex; align-items: center; justify-content: center; width: 20px; height: 18px;
```

을 아래로 바꾼다(절대 위치를 묶음으로 옮긴다).

```css
  /* 차트 왼쪽 위 버튼 묶음 — 라인/캔들 전환과 확대 풀기. 하나가 숨으면 나머지가
     빈자리 없이 왼쪽으로 붙는다(확대했어도 70봉을 넘으면 캔들 아이콘은 숨는다). */
  .chartctl { position: absolute; top: 4px; left: 4px; z-index: 1; display: flex; gap: 3px; }
  #chartMode {
    display: flex; align-items: center; justify-content: center; width: 20px; height: 18px;
```

그리고 `#chartMode[hidden] { display: none; }` 줄 바로 아래에 넣는다.

```css
  #zoomReset {
    height: 18px; padding: 0 6px; border: 1px solid var(--field-border); border-radius: 4px;
    background: var(--tooltip); color: var(--dim); font-size: 10px; cursor: pointer; opacity: .6;
  }
  #zoomReset:hover { opacity: 1; color: var(--text-3); }
```

- [ ] **Step 7: 문법 검사, 스위트, 빠진 곳 확인**

Run:
```bash
node --check renderer.js && for s in rsi cross candle zoom trend quote-session session-ui dom-contract state-contract; do printf '%-15s ' $s; TZ=Asia/Seoul node tests/$s.mjs 2>&1 | tail -1; done
grep -c 'id="zoomReset"' index.html; grep -n "getElementById('zoomReset')" renderer.js; grep -n "zoom = null" renderer.js
```
Expected: 아홉 줄 모두 `PASS`. `id="zoomReset"` 1개. `getElementById('zoomReset')` 가 `drawChart` 와 init 두 곳. `zoom = null` 이 선언 · `drawChart` · `resetZoom` · 기간 버튼 · 기간 단축키 · `select` 에 있다.

- [ ] **Step 8: 개발 문서에 확대 절을 쓴다 (그리기 · 상태)**

`docs/DEVELOPMENT.md` 에서 `### 오늘 캔들` 제목 바로 위(즉 `### 캔들차트` 절의 끝)에 새 절을 넣는다.

```markdown
### 끌어서 확대

**3M · 1Y 에서** 차트를 끌어 고른 구간을 차트 전체로 펼칩니다(`ZOOM_TF`).

**y축은 저절로 그 구간에 맞춰집니다.** x축에 `scales.x.min` / `max` 로 봉 번호를 넣으면, Chart.js 4.5.1 의 `DatasetController.getMinMax` 가 그 범위 밖 점을 건너뛰고 y 범위를 잡습니다. 투명하게 남긴 고가~저가 밴드가 여전히 꼬리까지 범위를 잡아 줍니다. 거래량 축은 최댓값을 직접 넣으므로(`max: maxVol * 4`) 확대 중에는 보이는 구간의 최대 거래량으로 다시 계산합니다 — 그대로 두면 막대가 납작해집니다.

**캔들 기준은 보이는 봉 수입니다**(위 "캔들차트"). 1Y 도 70봉 이하로 좁히면 캔들이 됩니다. `candlePlugin` 의 몸통 폭은 이웃한 두 봉의 픽셀 거리로 정합니다 — 폭 ÷ 전체 봉 수로는 확대했을 때 몸통이 그대로 가늘게 남습니다.

**확대 중에는 지지 · 저항 추세선을 숨깁니다.** 추세선은 "지금"을 말하는 선(최근 5봉을 빼고 만들어 오늘 값 · 돌파를 계산)이고, 정규 데이터셋이라 과거 구간 가격에서 먼 선이 y축을 다시 벌려 확대 효과를 깎습니다. 이동평균선 · ▲▼ 교차 표식 · 평단 점선은 그대로 그리고 구간 밖은 잘립니다. 배지(RSI · 기간 수익률 · 골든/데드 · 돌파 · 수렴)는 전체 기간 기준 그대로입니다.

**확대 구간은 봉 번호가 아니라 날짜로 기억합니다**(`zoom = { start, end }`, `zoomRange`). 30초마다 다시 그리고 다음 날엔 봉이 늘어 번호가 밀리기 때문입니다. 비교는 UTC 날짜로 합니다(`maFor` 와 같은 규칙) — 장중 마지막 봉의 시각은 마지막 체결 시각이라 갱신마다 바뀌어, 시각으로 비교하면 마지막 봉을 넣어 확대해도 다음 갱신에서 그 봉이 빠집니다. 그 구간이 5봉 미만이 되면 전체 보기로 돌아갑니다.

| 동작 | 확대 |
|---|---|
| 기간 버튼 · 기간 단축키 | 풀림 |
| 다른 종목 선택 | 풀림 |
| 캔들/라인 전환 · 테마 · 30초 갱신 · ↻ | 유지 |
| 앱 재실행 | 풀림 (저장하지 않음) |

확대 · 되돌리기는 네트워크 요청 없이 `drawChart(lastChart)` 로 다시 그립니다. `loadChart` 의 다시 그리기 서명에도 확대 구간을 넣어 둡니다 — 캔들 토글 때 서명에 모드가 빠져 다시 안 그려지던 버그를 되풀이하지 않으려는 것입니다.
```

- [ ] **Step 9: 커밋**

```bash
git add renderer.js index.html docs/DEVELOPMENT.md
git commit -m "feat(zoom): 확대 구간을 차트에 반영하고 전체 버튼으로 풀게 한다" -m "zoom(날짜 구간)이 있으면 drawChart 가 x축을 그 구간으로 좁히고, y축은 Chart.js 가 보이는 점만으로 다시 잡는다. 거래량 축은 보이는 구간의 최댓값으로 다시 계산하고, \"지금\"을 말하는 추세선은 숨긴다. 캔들 판단과 전환 아이콘은 보이는 봉 수를 따른다. 기간 · 종목이 바뀌면 풀리고, 차트 왼쪽 위 전체 버튼으로도 푼다. 끌어서 구간을 고르는 조작은 다음 커밋이다."
```

---

### Task 4: 끌어서 구간을 고른다

**Files:**
- Modify: `renderer.js` (`crossMarkPlugin` 뒤에 `zoomBoxPlugin`, `drawChart` 의 `plugins` 배열, `resetZoom` 뒤에 끌기 코드, init)
- Modify: `README.md` ("화면 읽는 법 → 차트" 목록)
- Modify: `docs/DEVELOPMENT.md` (Task 3 의 `### 끌어서 확대` 절 첫 문단 뒤)

**Interfaces:**
- Consumes: `zoom`, `resetZoom()` (Task 3), `dragToRange(a, b)`, `ZOOM_TF` (Task 2), 모듈 변수 `chart` · `lastChart`
- Produces: 모듈 변수 `zoomDrag: {a: number, b: number} | null`, `zoomBoxPlugin`, `bindZoom()`

- [ ] **Step 1: 끌기 상태와 선택 상자 플러그인**

`renderer.js` 에서 `crossMarkPlugin` 정의(`const crossMarkPlugin = {` … `};`)가 끝난 바로 뒤에 넣는다.

```js
// 끄는 중인 확대 구간 { a, b } — 봉 번호(누른 곳, 지금 마우스). 끌기 이벤트가 쓰고
// 아래 zoomBoxPlugin 이 읽는다. 끄는 동안에는 chart.draw() 로 다시 그리기만 해서 가볍다.
let zoomDrag = null;

// 끄는 동안의 선택 상자. 양 끝 봉이 상자 안에 다 들어오게 반 칸씩 넓힌다.
const zoomBoxPlugin = {
  id: 'zoomBox',
  afterDraw(c) {
    if (!zoomDrag) return;
    const sx = c.scales.x;
    const area = c.chartArea;
    const half = Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0)) / 2;
    const x1 = Math.max(area.left, sx.getPixelForValue(Math.min(zoomDrag.a, zoomDrag.b)) - half);
    const x2 = Math.min(area.right, sx.getPixelForValue(Math.max(zoomDrag.a, zoomDrag.b)) + half);
    const ctx = c.ctx;
    ctx.save();
    ctx.fillStyle = cssVar('--accent-bg');
    ctx.fillRect(x1, area.top, Math.max(1, x2 - x1), area.height);
    ctx.restore();
  },
};
```

`drawChart` 의

```js
    plugins: [candlePlugin, hLinePlugin, crossMarkPlugin, crosshairPlugin],
```

를

```js
    plugins: [candlePlugin, hLinePlugin, crossMarkPlugin, crosshairPlugin, zoomBoxPlugin],
```

로 바꾼다.

- [ ] **Step 2: 끌기 이벤트**

Task 3 의 `resetZoom` 함수 바로 뒤에 넣는다.

```js
// 화면 x 좌표 → 봉 번호. 차트 밖으로 끌면 보이는 구간 끝에서 멈춘다.
// category 축이라 getValueForPixel 이 봉 번호를 주고, sx.min / max 는 보이는 구간의 끝이다.
function barAt(clientX) {
  const sx = chart.scales.x;
  const px = clientX - chart.canvas.getBoundingClientRect().left;
  return Math.min(sx.max, Math.max(sx.min, Math.round(sx.getValueForPixel(px))));
}

// 누른 채 좌우로 끌면 상자가 따라오고, 놓으면 그 구간이 차트 전체로 펼쳐진다.
// 마우스가 지나가거나 휠을 굴리는 것으로는 절대 확대하지 않는다 — 항상 떠 있는
// 창이라 마우스가 차트 위를 자주 지나간다.
// 이벤트는 캔버스 요소에 한 번만 붙인다. drawChart 는 같은 캔버스에 차트를 새로
// 만들므로, 끄는 도중 30초 갱신이 와도 상자가 끊기지 않는다.
function bindZoom() {
  const cv = document.getElementById('chart');
  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !chart || !lastChart || !ZOOM_TF.has(state.timeframe)) return;
    const i = barAt(e.clientX);
    zoomDrag = { a: i, b: i };
  });
  // 차트 밖으로 나가도 따라가도록 window 에서 받는다
  window.addEventListener('mousemove', (e) => {
    if (!zoomDrag || !chart) return;
    const i = barAt(e.clientX);
    if (i === zoomDrag.b) return;
    zoomDrag.b = i;
    chart.draw();
  });
  window.addEventListener('mouseup', () => {
    if (!zoomDrag) return;
    const r = dragToRange(zoomDrag.a, zoomDrag.b);
    zoomDrag = null;
    if (!r || !lastChart) { // 5봉 미만 — 클릭이거나, 끌다가 도로 좁혀 취소한 것
      if (chart) chart.draw(); // 상자만 지운다
      return;
    }
    zoom = { start: lastChart.times[r.from], end: lastChart.times[r.to] };
    drawChart(lastChart);
  });
  cv.addEventListener('dblclick', resetZoom);
}
```

- [ ] **Step 3: init 에서 한 번 붙인다**

init 의 `document.getElementById('zoomReset').onclick = resetZoom;` 바로 아래에 넣는다.

```js
  bindZoom();
```

- [ ] **Step 4: 문법 검사와 스위트**

Run:
```bash
node --check renderer.js && for s in rsi cross candle zoom trend quote-session session-ui dom-contract state-contract; do printf '%-15s ' $s; TZ=Asia/Seoul node tests/$s.mjs 2>&1 | tail -1; done
grep -n "bindZoom()" renderer.js; grep -n "zoomBoxPlugin\]" renderer.js
```
Expected: 아홉 줄 모두 `PASS`. `bindZoom()` 이 정의와 init 두 곳, `zoomBoxPlugin]` 이 `drawChart` 의 plugins 한 곳.

- [ ] **Step 5: README 에 사용법을 넣는다**

`README.md` "화면 읽는 법 → 차트" 목록에서

```
- **캔들** (1M · 3M) — 몸통은 시가(그날 첫 가격)~종가(마지막 가격), 세로선은 그날의 최저~최고가입니다. 시가보다 오르면 빨강, 내리면 파랑입니다. 차트 왼쪽 위의 작은 아이콘을 누르면 선 그래프와 바꿀 수 있습니다.
```

를 아래 두 줄로 바꾼다.

```
- **캔들** (1M · 3M, 1Y 는 확대했을 때) — 몸통은 시가(그날 첫 가격)~종가(마지막 가격), 세로선은 그날의 최저~최고가입니다. 시가보다 오르면 빨강, 내리면 파랑입니다. 차트 왼쪽 위의 작은 아이콘을 누르면 선 그래프와 바꿀 수 있습니다.
- **확대** (3M · 1Y) — 차트를 누른 채 좌우로 끌면 그 구간만 크게 보입니다. 차트를 더블클릭하거나 왼쪽 위 `전체` 를 누르면 돌아옵니다.
```

- [ ] **Step 6: 개발 문서에 조작을 적는다**

`docs/DEVELOPMENT.md` 의 `### 끌어서 확대` 첫 문단(`**3M · 1Y 에서** 차트를 끌어 고른 구간을 ...`) 바로 뒤에 넣는다.

```markdown
누른 채 좌우로 끌면 반투명 상자(`zoomBoxPlugin`)가 따라오고, 놓으면 그 구간이 펼쳐집니다. **5봉 미만으로 끌면 확대하지 않습니다**(`ZOOM_MIN_BARS`) — 클릭 · 손떨림과 구분하고, 끌다가 도로 좁히면 취소가 됩니다. 되돌리기는 더블클릭이나 `전체` 버튼입니다. 왼쪽 버튼만 끌기로 치고, 마우스가 지나가거나 휠을 굴리는 것으로는 절대 확대하지 않습니다 — 항상 떠 있는 창이라 마우스가 차트 위를 자주 지나가기 때문입니다.

이벤트는 캔버스 요소(`#chart`)에 한 번만 붙이고(`bindZoom`), 끄는 동안의 움직임과 놓기는 `window` 에서 받아 차트 밖으로 나가도 끝에서 멈춥니다. `drawChart` 는 같은 캔버스에 차트를 새로 만들므로 끄는 도중 30초 갱신이 와도 상자가 끊기지 않습니다.
```

- [ ] **Step 7: 커밋**

```bash
git add renderer.js README.md docs/DEVELOPMENT.md
git commit -m "feat(zoom): 3M · 1Y 차트를 끌어서 구간을 고르면 그 구간만 크게 보인다" -m "누른 채 좌우로 끌면 반투명 상자가 따라오고, 놓으면 그 구간이 차트 전체로 펼쳐진다. 5봉 미만은 확대하지 않아 클릭 · 손떨림과 구분되고 도로 좁히면 취소가 된다. 더블클릭이나 전체 버튼으로 돌아온다. 휠이나 지나가는 마우스로는 확대하지 않는다 — 항상 떠 있는 창이라 실수로 걸리기 쉽다. 이벤트를 캔버스에 한 번만 붙여 끄는 도중 30초 갱신이 와도 끊기지 않는다."
```

---

## 사용자 확인 항목 (구현 후, 화면에서)

- 3M · 1Y 에서 끌면 상자가 따라오고, 놓으면 그 구간으로 펼쳐지며 y축이 그 구간 가격에 맞춰지는지
- 1Y 를 70봉 이하로 좁히면 캔들이 되고 왼쪽 위에 캔들/라인 아이콘이 나타나는지
- `전체` 버튼 · 더블클릭으로 돌아오는지, 기간 · 종목을 바꾸면 풀리는지
- 확대한 채 30초 갱신 · ↻ · 테마 변경 뒤에도 같은 구간이 유지되는지
- 확대 중 추세선이 숨고, 이동평균선 · ▲▼ 표식은 보이는지, 거래량 막대가 납작하지 않은지
- 1M · 1D · 1W 에서는 끌어도 아무 일이 없는지
- 짧게 클릭하거나 살짝 끌면 확대되지 않는지
