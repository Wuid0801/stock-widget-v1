# 계산 함수를 `indicators.js` 로 분리

**날짜**: 2026-09-22
**상태**: 설계 승인됨, 구현 전

## 문제

테스트 5개가 `renderer.js` 를 **문자열로 잘라** 씁니다.

| 스위트 | 의존하는 것 |
|---|---|
| `trend` `cross` `candle` | `// --- 오늘 캔들` 같은 **주석 문자열** 경계 |
| `rsi` | `function calcRSI` ~ `// 과열도 5단계` 사이 |
| `session-ui` | 파일 앞 61줄(prelude) + `harness([...])` 의 함수 이름 목록 |

두 가지 방식으로 깨집니다.

1. **주석을 옮기면** 잘라내기 경계를 잃고 `FAIL: 블록을 찾지 못함` 이 납니다.
2. **`loadChart`·`renderDetail` 이 새 함수를 부르면** 그 함수가 vm 컨텍스트에 없어
   `ReferenceError` 가 납니다. 고치려면 매번 `harness([...])` 목록을 손으로 늘려야 합니다.

2번은 2026-09-22 하루에만 세 번 발생했습니다 — `confirmedCrosses`(loadChart),
`candleTag`(renderDetail), `candleOf`(loadChart). 셋 다 테스트 파일을 고쳐서 넘겼습니다.

## 목표

- 계산 함수를 테스트가 **import 해서** 쓰게 한다. 주석 경계와 이름 목록을 없앤다.
- 동작은 바뀌지 않는다. 기존 단언을 그대로 두고 전부 통과해야 한다.
- `renderer.js` 가 약 235줄 줄어든다(현재 1,913줄).

## 비목표

- `renderer.js` 자체를 import 가능하게 만들기. `session-ui` 는 여전히 `loadChart` ·
  `renderDetail` 을 문자열로 꺼냅니다 — 이번 작업은 **계산 쪽 절반만** 없앱니다.
- 번들러 도입, ES 모듈 전환, 파일 추가 분할.
- 계산 로직 수정. 순수하게 이동만 합니다.

## 접근

### 채택: 클래식 스크립트 + 가드형 `module.exports`

`indicators.js` 를 `renderer.js` 보다 먼저 `<script>` 로 싣습니다. 클래식 스크립트의
최상위 함수 선언은 전역이 되므로 **`renderer.js` 의 호출부는 한 줄도 바뀌지 않습니다.**
파일 끝에 다음을 둡니다.

```js
if (typeof module !== 'undefined') module.exports = { calcRSI, sma, /* ... */ };
```

렌더러에는 `contextIsolation: true` · `nodeIntegration: false` 라 `module` 이 없으므로
이 줄은 건너뜁니다. Node 는 CommonJS 로 읽어 named import 를 허용합니다.

**검증 완료**: 가드형(`if` 안의) `module.exports` 도 `import { calcRSI } from './x.js'`
가 동작합니다(2026-09-22 실측). 저장소에 이미 같은 패턴이 있습니다 —
`quote-session.cjs` 를 `main.js` 는 `require`, `tests/quote-session.mjs` 는 named import
로 씁니다.

### 기각: ES 모듈 전환

`main.js` 가 `win.loadFile('index.html')` 을 쓰므로 `file://` 입니다. Chromium 은
`file://` 에서 모듈 스크립트를 CORS 로 막습니다. 커스텀 프로토콜 등록과 `loadURL`
변경이 필요합니다 — 메인 프로세스를 건드리고 패키징 경로 위험이 생깁니다. 지금
문제를 푸는 데 그만한 값이 아닙니다.

### 기각: 번들러(esbuild)

지금은 `npm start` 가 곧 실행입니다. 빌드 단계가 끼어들어 개발 루프가 느려집니다.
3,000줄 프로젝트에 과합니다.

## 무엇이 옮겨가나

순수도는 기계적으로 확인했습니다(DOM · `quotes` · `state` · `cssVar` · `chartBars`
참조 여부).

### `indicators.js` 로 이동

| 함수 | 줄수 | 쓰는 곳 |
|---|---:|---|
| `calcRSI` | 20 | `loadQuote` |
| `sma` | 10 | `maFor` |
| `crossings` | 11 | `loadChart` |
| `confirmedCrosses` | 3 | `loadChart` |
| `midnightOf` | 5 | `daysAgo` |
| `daysAgo` | 3 | `renderCrossBadge` · `renderTrendBadges` · `loadChart` |
| `candleOf` | 14 | `candleTag` · `loadChart` |
| `candleGeom` | 8 | `candleSvg` |
| `hull` | 13 | `trendLine` |
| `trendLine` | 35 | `loadChart` |
| `breakoutOf` | 32 | `loadChart` |
| `meetAt` | 6 | `renderTrendBadges` |

상수도 함께: `TREND_TF` · `TREND_MIN_SPAN` · `TREND_LOOKBACK` · `TREND_MAX_EXTEND` ·
`TREND_MIN_BREAK` · `TREND_MAX_DRIFT`.

주석이 로직보다 긴 파일이라 실제 이동량은 약 235줄입니다(블록 여섯을 실제로 세어 확인). **주석은 전부 따라갑니다** —
이 저장소에서 주석은 왜 그 숫자인지를 담은 실측 기록입니다.

### `renderer.js` 에 남는 것

| 함수 | 남는 이유 |
|---|---|
| `levelOf` | `cssVar` |
| `maFor` | `quotes` 전역 |
| `candleSvg` | `cssVar` |
| `candleTag` | `candleSvg` · `money` · `esc` |
| `render*` `draw*` `load*` | DOM · 전역 상태 |

`CROSS_PAIRS` · `MA_PERIODS` · `MA_SPAN` · `MA_THICK` 는 어떤 선을 그릴지에 대한
화면 정책이라 `renderer.js` 에 둡니다. 옮기는 함수 중 이것들을 쓰는 것은 없습니다.

## 파일별 변경

| 파일 | 변경 |
|---|---|
| `indicators.js` | 신규. 위 함수·상수 + 가드형 `module.exports` |
| `renderer.js` | 해당 블록 삭제. 호출부 변경 없음 |
| `index.html` | `renderer.js` 앞에 `<script src="./indicators.js"></script>` |
| `tests/rsi.mjs` `tests/trend.mjs` `tests/cross.mjs` `tests/candle.mjs` | 슬라이싱 앞부분을 named import 로 교체. 단언은 그대로 |
| `tests/session-ui.mjs` | 하네스에 `Object.assign(c, await import('../indicators.js'))`. `harness([...])` 목록 세 곳에서 계산 함수 이름 제거 — 115줄 `calcRSI`, 184·231줄 `confirmedCrosses` `candleOf` `daysAgo` `midnightOf` |

패키징은 `package.json` 의 `build.files` 가 `**/*` 라 새 파일이 자동 포함됩니다.

## 테스트 전략

동작이 바뀌지 않는 이동이므로 **기존 단언을 하나도 고치지 않습니다.** 고쳐야 할 것이
생기면 순수 이동이 아니라는 뜻이니 멈추고 확인합니다.

성공 기준:

1. `node --check indicators.js` · `node --check renderer.js` 통과
2. 앱을 띄우지 않는 7개 스위트 전부 통과 — `rsi` `trend` `cross` `candle`
   `quote-session` `session-ui` `dom-contract`
3. `rsi` `trend` `cross` `candle` 에 `indexOf` · `new Function` · `START`/`END` 상수가
   남아 있지 않다
4. `session-ui` 의 `harness([...])` 호출에 계산 함수 이름이 남아 있지 않다

Electron 을 띄우는 스위트(`chart-integrity` · `watchlist` · `moving-average` 등)와
앱 실행 확인은 사용자가 직접 합니다.

## 위험

| 위험 | 완화 |
|---|---|
| `indicators.js` 가 `renderer.js` 보다 늦게 로드 | `<script>` 순서가 실행 순서를 보장한다. 게다가 모든 호출은 함수 안이라 로드 시점에 실행되지 않는다 |
| 이동 중 함수를 빠뜨리거나 중복 정의 | `node --check` 는 중복을 잡지 못한다 → 이동 후 `renderer.js` 에 같은 이름이 남아 있지 않은지 grep 으로 확인 |
| `.js` 확장자와 CommonJS 해석 | `package.json` 에 `"type": "module"` 이 없으므로 `.js` 는 CommonJS 다. `quote-session.cjs` 와 같은 방식으로 import 된다 |
| 설치본에 파일 누락 | `build.files` 가 `**/*` 라 포함된다 |

## 이 작업이 끝나도 남는 것

`session-ui` 는 계속 `renderer.js` 를 문자열로 잘라 `loadChart` · `renderDetail` ·
`loadQuote` 를 꺼냅니다. 그 함수들이 **새 DOM 렌더 함수**를 부르기 시작하면 여전히
`harness([...])` 목록을 고쳐야 합니다. 계산 함수에 대해서만 이 문제가 사라집니다.
