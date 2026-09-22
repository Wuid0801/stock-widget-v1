# indicators.js 분리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `renderer.js` 의 순수 계산 함수 12개와 `TREND_*` 상수를 `indicators.js` 로 옮겨, 테스트가 소스를 문자열로 잘라 쓰지 않고 `import` 하게 만든다.

**Architecture:** `indicators.js` 는 클래식 스크립트다. `index.html` 이 `renderer.js` 보다 먼저 싣고, 최상위 함수 선언이 전역이 되므로 `renderer.js` 의 호출부는 바뀌지 않는다. 파일 끝의 가드형 `module.exports` 덕분에 Node 테스트는 같은 파일을 CommonJS 로 import 한다.

**Tech Stack:** Electron 클래식 스크립트(브라우저), CommonJS(Node), 테스트는 `node tests/*.mjs` 로 도는 순수 ESM 스크립트.

**Spec:** `docs/superpowers/specs/2026-09-22-indicators-module-design.md`

## Global Constraints

- **동작은 바뀌지 않는다.** 함수 본문과 주석을 **한 글자도 고치지 않고** 옮긴다. 주석은 왜 그 숫자인지를 담은 실측 기록이라 전부 따라간다.
- **기존 단언(assert / check 의 조건식)을 고치지 않는다.** 고쳐야 할 것이 생기면 순수 이동이 아니라는 뜻이니 멈추고 보고한다. 단, 슬라이싱 방식을 설명하던 **라벨 문자열**은 바꿔도 된다.
- **앱과 `npm test` 는 실행하지 않는다.** 사용자가 직접 확인한다. 검증은 `node --check` 와 앱을 띄우지 않는 개별 스위트(`node tests/<name>.mjs`)까지만.
- **줄 번호는 이동하면서 바뀐다.** 위치는 항상 마커 주석이나 함수 이름으로 찾는다. 이 문서의 줄 번호는 2026-09-22 기준 참고값이다.
- 커밋 메시지는 `<type>(<scope>): <한글 subject>` 형식, 본문도 한글. `Co-Authored-By` 트레일러는 붙이지 않는다.

---

### Task 1: `indicators.js` 를 만들고 RSI · SMA 를 옮긴다

이 태스크가 방식 전체를 증명한다 — 파일 생성, 스크립트 태그, 가드형 export, 테스트 import, 그리고 `session-ui` 하네스 주입까지.

**Files:**
- Create: `indicators.js`
- Modify: `renderer.js` (`function calcRSI` 블록, `function sma` 블록 삭제)
- Modify: `index.html` (`<script src="./renderer.js">` 앞에 한 줄)
- Modify: `tests/rsi.mjs` (앞부분 슬라이싱 → import)
- Modify: `tests/session-ui.mjs` (하네스 주입, 115줄 `harness(['loadQuote', 'calcRSI'])` 에서 `calcRSI` 제거)

**Interfaces:**
- Produces: `indicators.js` 가 `calcRSI(closes, period = 14) → number|null` 과 `sma(closes, period) → (number|null)[]` 을 전역 및 `module.exports` 로 내보낸다. 이후 태스크는 같은 파일 끝의 `module.exports` 객체에 이름을 추가한다.

- [ ] **Step 1: 옮길 블록 두 개의 정확한 범위를 확인한다**

```bash
grep -n "^// --- RSI(14)\|^// 과열도 5단계\|^// 단순이동평균\|^// 차트 시각(times)" renderer.js
```

기대: 네 줄이 나온다. 옮길 범위는
- **RSI 블록**: `// --- RSI(14), Wilder smoothing ---...` 부터 `function calcRSI` 의 닫는 `}` 까지 (`// 과열도 5단계` 바로 앞까지)
- **SMA 블록**: `// 단순이동평균. 구간이 모자라는 앞부분은 null ...` 부터 `function sma` 의 닫는 `}` 까지 (`// 차트 시각(times)...` 바로 앞까지)

`levelOf`(과열도 5단계)와 `maFor`(차트 시각)는 **남긴다**.

- [ ] **Step 2: `indicators.js` 를 만든다**

옮길 두 블록을 그대로 찍어 확인한다(각 출력의 **마지막 줄은 다음 블록의 머리말이므로 제외**한다).

```bash
sed -n '/^\/\/ --- RSI(14)/,/^\/\/ 과열도 5단계/p' renderer.js
sed -n '/^\/\/ 단순이동평균/,/^\/\/ 차트 시각(times)/p' renderer.js
```

머리말을 쓰고, 위 두 블록을 **한 글자도 고치지 않고** 순서대로 붙인 뒤, 파일 끝에 export 를 둔다.

```js
// indicators.js — 화면과 무관한 순수 계산.
//
// 브라우저에서는 클래식 스크립트다. index.html 이 renderer.js 보다 먼저 싣고,
// 최상위 함수 선언이 전역이 되므로 renderer.js 는 그냥 이름으로 부른다.
// Node(테스트)에서는 CommonJS 로 읽혀 아래 module.exports 가 쓰인다.
//
// 여기에는 DOM · quotes · state · cssVar 를 건드리는 것을 두지 않는다.
// 그것이 이 파일을 테스트에서 통째로 import 할 수 있게 하는 조건이다.

// (여기에 RSI 블록과 SMA 블록을 renderer.js 에서 그대로 옮겨 붙인다)

// 렌더러에는 contextIsolation 이 걸려 있어 module 이 없다 → 이 줄은 건너뛴다.
if (typeof module !== 'undefined') module.exports = { calcRSI, sma };
```

- [ ] **Step 3: `renderer.js` 에서 두 블록을 지운다**

잘라낸 자리에는 아무것도 남기지 않는다(빈 줄 하나로 정리). 호출부(`loadQuote` 의 `calcRSI(closes)`, `maFor` 의 `sma(d.closes, period)`)는 **건드리지 않는다.**

- [ ] **Step 4: 중복 정의가 남지 않았는지 확인한다**

```bash
grep -n "^function calcRSI\|^function sma" renderer.js indicators.js
```

기대: `indicators.js` 에만 각각 하나씩. `renderer.js` 에는 없다.

- [ ] **Step 5: `index.html` 에 스크립트를 추가한다**

`<script src="./renderer.js"></script>` **바로 앞** 줄에 넣는다.

```html
  <!-- 순수 계산. renderer.js 가 전역으로 쓰므로 반드시 먼저 싣는다 -->
  <script src="./indicators.js"></script>
```

- [ ] **Step 6: `tests/rsi.mjs` 를 import 로 바꾼다**

지울 것 — 앞부분의 슬라이싱 일체:

```js
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './_paths.mjs';

const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');
const body = src.slice(src.indexOf('function calcRSI'), src.indexOf('// 과열도 5단계'));
if (!body) { console.log('FAIL: renderer.js 에서 calcRSI 를 찾지 못함'); process.exit(1); }
const calcRSI = new Function(`${body}; return calcRSI;`)();
```

넣을 것:

```js
import { calcRSI } from '../indicators.js';
```

머리말 첫 줄의 `renderer.js 의 calcRSI 만 떼어내 검증한다` 도 `indicators.js 의 calcRSI 를 검증한다` 로 고친다. **`CLOSES` 이하 기대값과 `check(...)` 조건식은 손대지 않는다.**

- [ ] **Step 7: rsi 스위트를 돌린다**

```bash
node tests/rsi.mjs
```

기대: 이전과 같은 목록이 그대로 `PASS: 실패 0건`.

- [ ] **Step 8: `session-ui` 하네스에 indicators 를 주입한다**

`tests/session-ui.mjs` 맨 위 import 들 옆에 추가:

```js
import * as indicators from '../indicators.js';
```

`harness()` 안에서 `const c = vm.createContext({ ... });` **바로 다음 줄**에 추가:

```js
  // 계산 함수는 통째로 넣는다 — 이름을 하나씩 나열하면 새 함수를 부를 때마다
  // ReferenceError 가 나고 목록을 손으로 늘려야 한다.
  Object.assign(c, indicators);
```

- [ ] **Step 9: `calcRSI` 를 이름 목록에서 뺀다**

`tests/session-ui.mjs` 115줄 근처:

```js
  const { c, run } = harness(['loadQuote', 'calcRSI']);
```

→

```js
  const { c, run } = harness(['loadQuote']);
```

- [ ] **Step 10: 구문 검사와 스위트를 돌린다**

```bash
node --check indicators.js && node --check renderer.js && node tests/rsi.mjs && node tests/session-ui.mjs
```

기대: 셋 다 통과. `session-ui` 는 `PASS: 9 session UI test groups`.

- [ ] **Step 11: 커밋**

```bash
git add indicators.js renderer.js index.html tests/rsi.mjs tests/session-ui.mjs
git commit -m "refactor(indicators): RSI·SMA 를 indicators.js 로 옮긴다

테스트가 renderer.js 를 문자열로 잘라 쓰던 것을 import 로 바꾼다. 브라우저는
클래식 스크립트로 먼저 싣고(전역), Node 는 가드형 module.exports 로 읽는다.
renderer.js 의 호출부는 바뀌지 않는다.

session-ui 하네스는 계산 함수를 통째로 주입한다 — 이름 목록을 나열하면 새
함수를 부를 때마다 ReferenceError 가 나고 목록을 손으로 늘려야 한다."
```

---

### Task 2: 크로스 블록을 옮긴다

**Files:**
- Modify: `indicators.js` (블록 추가, export 추가)
- Modify: `renderer.js` (블록 삭제)
- Modify: `tests/cross.mjs` (슬라이싱 → import)
- Modify: `tests/session-ui.mjs` (`harness([...])` 두 곳에서 이름 제거, `daysAgo` 시간 고정)

**Interfaces:**
- Consumes: Task 1 의 `indicators.js` 와 그 끝의 `module.exports` 객체.
- Produces: `crossings(short, long) → {i, y, golden}[]`, `confirmedCrosses(crosses, len) → 같은 배열의 부분집합`, `midnightOf(ms) → number`, `daysAgo(ms, now = Date.now()) → number`.

- [ ] **Step 1: 옮길 범위를 확인한다**

```bash
grep -n "^// 단기선이 장기선을 뚫은 지점\|^// --- 추세선" renderer.js
```

이 두 줄 **사이 전체**가 대상이다 — `crossings` · `confirmedCrosses` · `midnightOf` · `daysAgo` 와 각각의 주석. `// --- 추세선` 줄은 포함하지 않는다.

- [ ] **Step 2: 블록을 `indicators.js` 로 옮긴다**

먼저 그대로 찍어 확인한다(마지막 줄 `// --- 추세선 ...` 은 제외).

```bash
sed -n '/^\/\/ 단기선이 장기선을 뚫은 지점/,/^\/\/ --- 추세선/p' renderer.js
```

`indicators.js` 의 SMA 블록 다음, `module.exports` 앞에 붙인다. `renderer.js` 에서는 지운다. 호출부(`renderCrossBadge` 의 `daysAgo(...)`, `renderTrendBadges` 의 `daysAgo(...)`, `loadChart` 의 `crossings(...)` · `confirmedCrosses(...)` · `daysAgo(...)`)는 건드리지 않는다.

- [ ] **Step 3: export 에 이름을 더한다**

```js
if (typeof module !== 'undefined') {
  module.exports = { calcRSI, sma, crossings, confirmedCrosses, midnightOf, daysAgo };
}
```

- [ ] **Step 4: 중복이 없는지 확인한다**

```bash
grep -n "^function crossings\|^function confirmedCrosses\|^function midnightOf\|^function daysAgo" renderer.js indicators.js
```

기대: `indicators.js` 에만 넷.

- [ ] **Step 5: `tests/cross.mjs` 를 import 로 바꾼다**

지울 것:

```js
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './_paths.mjs';

// renderer.js 의 이 두 주석이 잘라내기 경계다. 옮기면 여기도 같이 고쳐야 한다.
const START = '// 단기선이 장기선을 뚫은 지점';
const END = '// --- 추세선 ---';

const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a < 0 || b < 0) { console.log('FAIL: renderer.js 에서 교차 블록을 찾지 못함'); process.exit(1); }

const X = new Function(`${src.slice(a, b)}
  return {
    crossings,
    confirmedCrosses: typeof confirmedCrosses === 'function' ? confirmedCrosses : null,
    daysAgo: typeof daysAgo === 'function' ? daysAgo : null,
  };`)();
```

넣을 것 — `X.` 로 시작하는 호출부를 전부 그대로 두기 위해 네임스페이스로 받는다:

```js
import * as X from '../indicators.js';
```

머리말의 `renderer.js 의 교차 계산만 떼어내 검증한다` 는 `indicators.js 의 교차 계산을 검증한다` 로 고친다.

- [ ] **Step 6: 존재 확인 검사의 라벨만 고친다**

```js
check('confirmedCrosses 가 renderer.js 에 있다', X.confirmedCrosses != null);
check('daysAgo 가 renderer.js 에 있다', X.daysAgo != null);
```

→ 라벨만 바꾸고 조건식은 그대로 둔다(export 에서 이름이 빠지면 여전히 잡힌다).

```js
check('confirmedCrosses 를 indicators.js 가 내보낸다', X.confirmedCrosses != null);
check('daysAgo 를 indicators.js 가 내보낸다', X.daysAgo != null);
```

바로 아래의 `필요한 함수가 없어 이후 검사를 건너뜁니다` 분기도 그대로 둔다.

- [ ] **Step 7: cross 스위트를 돌린다**

```bash
node tests/cross.mjs
```

기대: 18개 `OK` 와 `전부 통과`.

- [ ] **Step 8: `session-ui` 의 `daysAgo` 시간을 하네스 시각에 고정한다**

주입된 `daysAgo` 는 vm 밖에서 만들어진 함수라 기본 인자의 `Date.now()` 가 하네스의 `FixedDate` 가 아니라 **실제 현재 시각**을 읽는다. 그대로 두면 `loadChart` 의 "마지막 봉이 오늘인가" 판정이 어긋나 일봉 동기화 테스트가 깨진다.

Task 1 Step 8 에서 넣은 줄을 다음으로 바꾼다:

```js
  // 계산 함수는 통째로 넣는다 — 이름을 하나씩 나열하면 새 함수를 부를 때마다
  // ReferenceError 가 나고 목록을 손으로 늘려야 한다.
  // daysAgo 만 기본 인자를 하네스 시각으로 묶는다. 주입된 함수는 vm 밖에서
  // 만들어져 Date.now() 가 FixedDate 가 아니라 진짜 지금을 읽는다.
  Object.assign(c, indicators, {
    daysAgo: (ms, now = NOW) => indicators.daysAgo(ms, now),
  });
```

- [ ] **Step 9: 이름 목록에서 넷을 뺀다**

`tests/session-ui.mjs` 의 `harness([...])` 두 곳(현재 184줄·231줄):

```js
  const { c, run } = harness(['loadChart', 'confirmedCrosses', 'candleOf', 'daysAgo', 'midnightOf']);
```

→ (`candleOf` 는 Task 3 에서 뺀다)

```js
  const { c, run } = harness(['loadChart', 'candleOf']);
```

두 곳 위의 설명 주석도 남은 이름에 맞게 줄인다.

- [ ] **Step 10: 구문 검사와 스위트를 돌린다**

```bash
node --check indicators.js && node --check renderer.js && node tests/cross.mjs && node tests/session-ui.mjs
```

기대: 전부 통과.

- [ ] **Step 11: 커밋**

```bash
git add indicators.js renderer.js tests/cross.mjs tests/session-ui.mjs
git commit -m "refactor(indicators): 크로스 계산을 indicators.js 로 옮긴다

crossings · confirmedCrosses · midnightOf · daysAgo 와 주석을 그대로 옮긴다.
cross 스위트는 주석 경계를 찾는 대신 import 한다.

주입된 daysAgo 는 기본 인자의 Date.now() 가 하네스의 FixedDate 를 못 보므로
session-ui 에서 시각을 묶어 넣는다."
```

---

### Task 3: 캔들 계산을 옮긴다

**Files:**
- Modify: `indicators.js` · `renderer.js` · `tests/candle.mjs` · `tests/session-ui.mjs`

**Interfaces:**
- Consumes: Task 2 까지의 `indicators.js`.
- Produces: `candleOf(q) → {open, high, low, close, dir}|null`, `candleGeom(c, h) → {flat, bodyTop, bodyH}`.

- [ ] **Step 1: 옮길 것과 남길 것을 가른다**

```bash
grep -n "^function candleOf\|^function candleGeom\|^function candleSvg\|^const CANDLE_W\|^const CANDLE_H" renderer.js
```

- **옮긴다**: `function candleOf` 와 그 앞의 주석 블록(`// 시·고·저는 정규장 값이고...` 부터), `function candleGeom` 과 그 앞의 주석 블록(`// 저가~고가를 높이 h 에 채운다...` 부터).
- **남긴다**: `// --- 오늘 캔들` 머리말, `CANDLE_W` · `CANDLE_H`, `candleSvg`(cssVar 를 쓴다), `candleTag`.

- [ ] **Step 2: 옮기고 export 에 더한다**

옮길 두 조각을 그대로 찍어 확인한다(각 출력의 마지막 줄은 제외).

```bash
sed -n '/^\/\/ 시·고·저는 정규장 값이고/,/^\/\/ 저가~고가를 높이 h/p' renderer.js
sed -n '/^\/\/ 저가~고가를 높이 h/,/^\/\/ 꼬리는 가운데 세로선/p' renderer.js
```

첫 출력이 `candleOf`, 둘째가 `candleGeom` 이다. `candleSvg` 부터는 남긴다.

```js
if (typeof module !== 'undefined') {
  module.exports = {
    calcRSI, sma, crossings, confirmedCrosses, midnightOf, daysAgo, candleOf, candleGeom,
  };
}
```

- [ ] **Step 3: 중복이 없는지 확인한다**

```bash
grep -n "^function candleOf\|^function candleGeom" renderer.js indicators.js
```

기대: `indicators.js` 에만 둘. `renderer.js` 에는 `candleSvg` · `candleTag` 만 남는다.

- [ ] **Step 4: `tests/candle.mjs` 를 import 로 바꾼다**

지울 것:

```js
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './_paths.mjs';

// renderer.js 의 이 두 주석이 잘라내기 경계다. 옮기면 여기도 같이 고쳐야 한다.
const START = '// --- 오늘 캔들';
const END = '// --- 리스트';

const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a < 0 || b < 0) { console.log('FAIL: renderer.js 에서 캔들 블록을 찾지 못함'); process.exit(1); }

const C = new Function(`${src.slice(a, b)}
  return {
    candleOf: typeof candleOf === 'function' ? candleOf : null,
    candleGeom: typeof candleGeom === 'function' ? candleGeom : null,
  };`)();
```

넣을 것:

```js
import * as C from '../indicators.js';
```

존재 확인 두 줄의 라벨을 고친다(조건식은 그대로).

```js
check('candleOf 를 indicators.js 가 내보낸다', C.candleOf != null);
check('candleGeom 을 indicators.js 가 내보낸다', C.candleGeom != null);
```

머리말 첫 줄도 `indicators.js 의 캔들 계산을 검증한다` 로 고친다.

- [ ] **Step 5: candle 스위트를 돌린다**

```bash
node tests/candle.mjs
```

기대: 29개 `OK` 와 `전부 통과`.

- [ ] **Step 6: `session-ui` 이름 목록에서 `candleOf` 를 뺀다**

두 곳 모두:

```js
  const { c, run } = harness(['loadChart', 'candleOf']);
```

→

```js
  const { c, run } = harness(['loadChart']);
```

위의 설명 주석(`loadChart calls these on every render ...`)은 이제 맞지 않으므로 지운다.

- [ ] **Step 7: 구문 검사와 스위트를 돌린다**

```bash
node --check indicators.js && node --check renderer.js && node tests/candle.mjs && node tests/session-ui.mjs
```

- [ ] **Step 8: 커밋**

```bash
git add indicators.js renderer.js tests/candle.mjs tests/session-ui.mjs
git commit -m "refactor(indicators): 캔들 계산을 indicators.js 로 옮긴다

candleOf · candleGeom 만 옮긴다. candleSvg 는 cssVar 로 테마 색을 읽고
candleTag 는 money · esc 를 쓰므로 renderer.js 에 남는다.

session-ui 의 harness 이름 목록에서 계산 함수가 모두 빠졌다."
```

---

### Task 4: 추세선 블록을 옮긴다

**Files:**
- Modify: `indicators.js` · `renderer.js` · `tests/trend.mjs`

**Interfaces:**
- Consumes: Task 3 까지의 `indicators.js`.
- Produces: `TREND_TF`(Set) · `TREND_MIN_SPAN` · `TREND_LOOKBACK` · `TREND_MAX_EXTEND` · `TREND_MIN_BREAK` · `TREND_MAX_DRIFT` 상수와 `hull(pts, low)` · `trendLine(extremes, len, low)` · `breakoutOf(line, extremes, len, low)` · `meetAt(a, b)`.

- [ ] **Step 1: 옮길 범위를 확인한다**

```bash
grep -n "^// --- 추세선\|^function meetAt\|^// 추세선 배지 둘" renderer.js
```

`// --- 추세선 ---...` 머리말부터 `function meetAt` 의 닫는 `}` 까지가 대상이다. `// 추세선 배지 둘 — 돌파와 수렴.` 부터는 `renderTrendBadges` 의 것이라 **남긴다**.

- [ ] **Step 2: 옮기고 export 에 더한다**

블록을 그대로 찍어 확인한다(마지막 줄 `// 추세선 배지 둘 ...` 은 제외).

```bash
sed -n '/^\/\/ --- 추세선/,/^\/\/ 추세선 배지 둘/p' renderer.js
```

```js
if (typeof module !== 'undefined') {
  module.exports = {
    calcRSI, sma, crossings, confirmedCrosses, midnightOf, daysAgo, candleOf, candleGeom,
    TREND_TF, TREND_MIN_SPAN, TREND_LOOKBACK, TREND_MAX_EXTEND, TREND_MIN_BREAK, TREND_MAX_DRIFT,
    hull, trendLine, breakoutOf, meetAt,
  };
}
```

- [ ] **Step 3: 중복이 없는지 확인한다**

```bash
grep -n "^const TREND_\|^function hull\|^function trendLine\|^function breakoutOf\|^function meetAt" renderer.js indicators.js
```

기대: `indicators.js` 에만. `renderer.js` 의 `loadChart` 는 `TREND_TF.has(state.timeframe)` 를 그대로 쓴다.

- [ ] **Step 4: `tests/trend.mjs` 를 import 로 바꾼다**

지울 것:

```js
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './_paths.mjs';

// renderer.js 의 이 두 주석이 잘라내기 경계다. 옮기면 여기도 같이 고쳐야 한다.
const START = 'const TREND_TF';
const END = '// 두 추세선이 만나는 봉 인덱스';

const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a < 0 || b < 0) { console.log('FAIL: renderer.js 에서 추세선 블록을 찾지 못함'); process.exit(1); }

const T = new Function(`${src.slice(a, b)}
  return {
    hull, trendLine,
    breakoutOf: typeof breakoutOf === 'function' ? breakoutOf : null,
    LOOKBACK: typeof TREND_LOOKBACK !== 'undefined' ? TREND_LOOKBACK : null,
    MIN_SPAN: typeof TREND_MIN_SPAN !== 'undefined' ? TREND_MIN_SPAN : null,
    MAX_EXTEND: typeof TREND_MAX_EXTEND !== 'undefined' ? TREND_MAX_EXTEND : null,
  };`)();
```

넣을 것 — 스위트가 `T.LOOKBACK` 처럼 짧은 이름을 쓰므로 그 껍데기만 유지한다. `T.hull` 등 호출부는 전부 그대로 둔다.

```js
import * as I from '../indicators.js';

// 스위트는 T.LOOKBACK 같은 짧은 이름을 쓴다. 호출부를 건드리지 않으려고
// 모듈을 그대로 펼치고 상수 별칭만 얹는다.
const T = {
  ...I,
  LOOKBACK: I.TREND_LOOKBACK,
  MIN_SPAN: I.TREND_MIN_SPAN,
  MAX_EXTEND: I.TREND_MAX_EXTEND,
};
```

머리말 첫 줄의 `renderer.js 의 추세선 계산만 떼어내 검증한다` 도 `indicators.js 의 추세선 계산을 검증한다` 로 고친다.

- [ ] **Step 5: trend 스위트를 돌린다**

```bash
node tests/trend.mjs
```

기대: 첫 줄에 `설정: LOOKBACK=5 MIN_SPAN=20 MAX_EXTEND=10` 이 그대로 찍히고 `PASS: 실패 0건`.

- [ ] **Step 6: 구문 검사와 스위트를 돌린다**

```bash
node --check indicators.js && node --check renderer.js && node tests/trend.mjs && node tests/session-ui.mjs
```

- [ ] **Step 7: 커밋**

```bash
git add indicators.js renderer.js tests/trend.mjs
git commit -m "refactor(indicators): 추세선 계산을 indicators.js 로 옮긴다

TREND_* 상수 여섯과 hull · trendLine · breakoutOf · meetAt 을 옮긴다.
renderTrendBadges 는 DOM 을 쓰므로 renderer.js 에 남는다."
```

---

### Task 5: 문서를 고치고 성공 기준을 확인한다

**Files:**
- Modify: `README.md` (`## 파일 구조`)
- Modify: `docs/superpowers/plans/2026-09-22-indicators-module.md` (체크박스 정리는 실행자가 진행하며 함)

- [ ] **Step 1: README 파일 구조에 새 파일을 넣는다**

`renderer.js` 줄 **앞**에 추가하고, `renderer.js` 설명에서 RSI 계산을 뺀다.

```
quote-session.cjs     KRX·NXT 가격 선택, 세션 판정, 확인된 정규장 종가 비교
indicators.js         화면과 무관한 순수 계산 — RSI · 이동평균 · 크로스 · 캔들 · 추세선
preload.js            contextBridge로 안전한 IPC만 노출
index.html            마크업 + CSS
renderer.js           UI 렌더링, Chart.js, 30초 폴링
```

- [ ] **Step 2: 성공 기준 3 — 슬라이싱 흔적이 남지 않았는지 확인한다**

```bash
grep -n "new Function\|indexOf('function\|const START\|const END" tests/rsi.mjs tests/trend.mjs tests/cross.mjs tests/candle.mjs
```

기대: **출력 없음**.

- [ ] **Step 3: 성공 기준 4 — 이름 목록에 계산 함수가 없는지 확인한다**

```bash
grep -n "harness(\[" tests/session-ui.mjs
```

기대: 남은 이름이 `fetchLive` `loadQuote` `renderDetail` `loadChart` `checkAlerts` `pollTick` `refreshAll` 뿐이다. `calcRSI` · `confirmedCrosses` · `candleOf` · `daysAgo` · `midnightOf` 는 없다.

- [ ] **Step 4: 성공 기준 1·2 — 구문 검사와 앱을 띄우지 않는 스위트 전부**

```bash
node --check indicators.js && node --check renderer.js && node --check main.js
for f in rsi trend cross candle quote-session session-ui dom-contract; do printf "%-14s " "$f"; node tests/$f.mjs >/dev/null 2>&1 && echo PASS || echo FAIL; done
```

기대: 일곱 줄 모두 `PASS`.

- [ ] **Step 5: `renderer.js` 가 얼마나 줄었는지 기록한다**

```bash
wc -l renderer.js indicators.js
```

설계 문서의 예상은 약 235줄 감소였다. 크게 다르면 옮기다 빠뜨린 것이 없는지 본다.

- [ ] **Step 6: 커밋**

```bash
git add README.md
git commit -m "docs(readme): 파일 구조에 indicators.js 를 넣는다

계산은 indicators.js, 화면은 renderer.js 로 나뉜다."
```

- [ ] **Step 7: 사용자에게 넘긴다**

Electron 을 띄우는 스위트(`chart-integrity` · `watchlist` · `moving-average` · `realtime` · `after-hours` 등)와 `npm start` 확인은 사용자가 직접 한다. 무엇을 봐 달라고 할지 정리해 보고한다 — 이 변경은 동작이 바뀌지 않아야 하므로 **차트 · 배지 · 캔들이 이전과 똑같아 보이면 성공**이다.
