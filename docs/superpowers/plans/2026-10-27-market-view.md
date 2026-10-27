# 시장 지표 화면 · 데드캣 점검 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지수 줄을 대표 6개로 줄이고, 시장 순위 패널에 모든 시장 지표와 데드캣 점검(긍정 · 중립 · 위험)을 보이는 "지표" 화면을 더한다.

**Architecture:** 지수 줄 항목과 고를 수 있는 시장 항목은 renderer 의 `INDICES` 하나로 두고 `page` 가 있는 것만 줄에 오른다. 패널의 시장 버튼에 `mk`(지표)를 더해 `renderRank` 가 그 화면을 그린다. 새 데이터(외국인 수급 · 지수 일별 종가 · HY OAS)는 main 의 `market:extras` 한 요청으로 받고, 판정은 새 순수 모듈 `market-check.js` 가 한다.

**Tech Stack:** Electron(main · preload · renderer 클래식 스크립트), Node 22 테스트(가짜 electron · vm 하네스), 네이버 · 야후 · FRED 공개 응답.

**Spec:** `docs/superpowers/specs/2026-10-27-market-view-design.md`

## Global Constraints

- 앱(Electron)을 띄우거나 `npm test` 를 돌리지 않는다 — 앱을 띄우지 않는 스위트만 `node tests/<이름>.mjs` 로 돌린다(사용자가 앱을 직접 확인).
- 기존 파일은 CRLF 를 지킨다(편집은 `scratchpad/edlib.cjs` 처럼 정확히 한 번 나오는 문자열 바꾸기, 또는 Edit 도구).
- 커밋은 단계(1 · 2 · 3)가 끝날 때 한 번씩, 메시지는 `type(scope): 한글 subject` + 한글 본문, Co-Authored-By 없음. 브랜치 `feat/market-view`. 병합 · push 는 하지 않는다.
- 주석 · 문구 · 테스트 이름은 주변 코드처럼 한국어, 실측 날짜를 단다.
- 판정은 참고용이다 — 요약은 개수만, "데드캣이다/아니다" 같은 결론 문구를 쓰지 않는다.
- 기준 숫자(스펙 ③ 그대로): 외국인 현물 2거래일 연속 · SOX 20거래일, 최저의 3% · 원/달러 +1% · VIX 5일 +15%, 하루 +10% · HY OAS +0.25%p · 미국채 ±10bp 안정, +20bp 위험 · 비교는 5거래일 전.
- 수급 값은 네이버 표기 그대로(단위 없이) 쓴다 — 네이버 화면도 단위를 적지 않는다(2026-10-27 확인). 판정은 부호만 쓴다.

## Review Focus

1. 휴장일 · 미래 날짜로 수급을 물으면 네이버가 오류 대신 `0` 을 준다(2026-10-27 실측: 10/25 토 · 10/28 모두 0) — 수급은 네이버 일봉에 있는 날짜로만 묻고, 0 인 날을 "순매도 아님/순매수 아님" 으로 세지 않는다. → Task 3 테스트 `수급은 거래일만 묻는다`.
2. 18:00 전 오늘 수급은 잠정치 — 판정에 쓰면 장중 값으로 연속 일수가 흔들린다. 시각은 PC 시간대와 상관없이 한국 시각으로 센다. → Task 3 테스트 `final 은 한국 18:00`, Task 5 테스트 `잠정치는 판정에 쓰지 않는다`.
3. FRED CSV 의 빈 값 줄(휴일)과 `.` 값 — 0 이나 NaN 으로 읽으면 5영업일 비교가 틀어진다. → Task 3 테스트 `FRED 빈 값 · 점은 건너뛴다`.
4. 출처 하나가 실패해도 나머지 줄과 판정은 그대로(요약 분모에서만 빠진다). → Task 3 · Task 6 테스트.
5. 30초 갱신마다 지표 화면을 다시 쓰면 내려 둔 스크롤이 튄다 — 같은 HTML 이면 다시 쓰지 않는 `rankShown` 규칙을 지표 화면도 따른다. → Task 2 테스트 `같은 내용이면 다시 쓰지 않는다`.

---

## 1단계 — 지수 줄 6개 · VIX · SOX · 지표 화면

### Task 1: 지수 줄 6개(세 장)와 VIX · SOX 항목

**Files:**
- Modify: `main.js` — `US_INDICES` · `quote:indices` 해외 지수 주소
- Modify: `renderer.js` — `INDICES`, `indexPages`
- Test: `tests/index-main.mjs`, `tests/session-ui.mjs`

**Interfaces:**
- Produces: `quote:indices` 항목 `code: 'VIX'`(이름 `VIX`) · `code: 'SOX'`(이름 `SOX`). `INDICES` 에 `{ symbol: '^VIX', code: 'VIX', name: 'VIX', overseas: true }`, `{ symbol: '^SOX', code: 'SOX', name: 'SOX', overseas: true }`. 지수 줄 항목만 `page`: 0 코스피 · 코스닥, 1 나스닥 · S&P 500, 2 나스닥 선물(`NQ=F`) · 원/달러(`KRW=X`). WTI(`CL=F`) · 미국채(`^TNX`) · VIX · SOX 는 `page` 없음.

- [ ] **Step 1: 실패하는 테스트**
  - `tests/index-main.mjs`: 해외 지수 응답에 `.VIX`(`indexName: 'VIX'`, `closePrice: '18.39'`, `fluctuationsRatio: '-5.45'`) · `.SOX` 를 섞어 `quote:indices` → 코드 순서 `['KOSPI','KOSDAQ','NASDAQ','SPX','VIX','SOX', …]`, 요청 주소가 `/worldstock/index/.IXIC,.INX,.VIX,.SOX` 한 번. 테스트 이름 `VIX · SOX 는 나스닥 · S&P 500 과 한 요청으로`.
  - `tests/session-ui.mjs`: 기존 `index line: futures and oil on the third page…` 테스트를 바꾼다 — 여덟 항목 + VIX · SOX 를 `indexItems` 에 넣으면 점이 세 개, `data-page="2"` 의 제목이 `나스닥 선물 · 원/달러`, 줄 어디에도 `CL=F` · `^TNX` · `^VIX` · `^SOX` 가 없다. 이름 `index line: six items on three pages; WTI · 10-year · VIX · SOX stay selectable but off the line`.
- [ ] **Step 2: 실패 확인** — `node tests/index-main.mjs` · `node tests/session-ui.mjs` 가 위 두 검사에서 실패.
- [ ] **Step 3: 구현** — `US_INDICES` 에 `.VIX` · `.SOX` 를 더하고 주소를 `.IXIC,.INX,.VIX,.SOX` 로. `INDICES` 를 Interfaces 대로 바꾸고 `indexPages` 가 `ix.page == null` 을 건너뛴다. `INDICES` · 지수 줄 위 주석을 세 장 기준으로 고친다.
- [ ] **Step 4: 통과 확인** — 두 스위트 PASS. 앱을 띄우지 않는 21개 전체도 PASS(`for f in rsi cross … search; do node tests/$f.mjs; done`). 실제 네트워크로 `quote:indices` 를 한 번 불러(스크래치 스크립트) `.IXIC,.INX,.VIX,.SOX` 넷이 모두 오는지 본다.

### Task 2: 패널의 지표 화면(지수 항목)

**Files:**
- Modify: `renderer.js` — `RANK_TABS` 옆 상수, `renderRank`, `setRankView`, `rankClick`
- Modify: `index.html` — 지표 줄 CSS(`.mgroup`, `.mrow .mval`, `.mrow .md5`, `.mrow .mnote`)
- Modify: `docs/DEVELOPMENT.md`, `README.md` — 지수 줄 세 장 · 지표 화면
- Test: `tests/session-ui.mjs`

**Interfaces:**
- Consumes: Task 1 의 `INDICES`.
- Produces:
  - `const MARKET_GROUPS = [['국내', ['KOSPI', 'KOSDAQ', 'FUT', 'SPOT', 'FUTFLOW']], ['미국', ['NASDAQ', 'SPX', 'NQ', 'SOX']], ['위험 · 자금', ['VIX', 'US10Y', 'HYOAS', 'USDKRW', 'WTI']]]` — prelude(`// 과열도 5단계` 앞)에 둔다.
  - `function marketRow(key)` → `null`(데이터 없음) 또는 `{ key, name, symbol (없으면 null — 누를 수 없음), value, cur, pct, d5, d5Unit ('%' | 'bp'), note, verdict, detail, spark }`. 이 Task 에서는 `INDICES` 코드만 채우고 나머지 키는 `null`. `verdict` · `detail` · `spark` 는 Task 6 이 채운다(지금은 `undefined`).
  - `function marketHtml()` → 묶음 제목 줄 + 줄들의 HTML. 줄은 `<div class="hit rrow mrow" data-sym="^KS11">`(누를 수 없는 줄은 `data-sym` 없이 `class="rrow mrow mfix"`).
  - `rankView.market === 'mk'` 이면 `renderRank` 가 탭 줄(`#rankTabs`)을 숨기고 `marketHtml()` 을 쓴다. 시장 버튼은 `[['kr','국내'],['us','미국'],['mk','지표']]`.
- 값 규칙: 값은 실시간 지수 줄 값(`indexItems` 의 `value`), 없으면 `quotes[symbol].price`. `pct` 는 오늘 등락률(금리 줄은 `fmtBp(change)`). 5일 변화는 `quotes[symbol].daily.closes` 의 `closes[closes.length - 6]` 대비 — `%`, 금리(`cur === '%'`)는 bp. 일봉이 6개 미만이면 `null`(화면 `—`).

- [ ] **Step 1: 실패하는 테스트** (`tests/session-ui.mjs`, 하네스에 `marketRow` · `marketHtml` · `renderRank` · `setRankView` · `rankClick` 을 넣는다)
  - `market panel: 지표 lists every index item in three groups and picks one on click` — `setRankView('mk')` 뒤 `#rankMarket` 에 `data-market="mk"` 가 `on`, `#rankTabs` 가 `hidden`, 목록에 묶음 제목 `국내` · `미국` · `위험 · 자금` 순서, `^VIX` · `^SOX` · `CL=F` · `^TNX` 줄이 있다. 미국채 줄의 등락이 `+1.7bp`, 5일 변화가 bp. 줄을 누르면(`rankClick`) 패널이 닫히고 `select('^VIX')` 가 불린다(하네스에서 `select` · `closeRank` 는 기록하는 가짜).
  - `market panel: 5-day change uses the close five bars back; fewer than six closes shows —` — `quotes['^SOX'].daily.closes = [100,101,102,103,104,105]`, 지금 값 110 → `+10.00%`. 다섯 개면 `—`.
  - `market panel: same content is not rewritten (scroll stays)` — 같은 데이터로 `renderRank` 두 번이면 `#rankList.innerHTML` 이 다시 쓰이지 않는다(쓰기 횟수를 세는 가짜 요소).
- [ ] **Step 2: 실패 확인** — `node tests/session-ui.mjs` 에서 위 세 개 실패.
- [ ] **Step 3: 구현** — `setRankView` 가 `'mk'` 를 받으면 `rankView = { market: 'mk', kind: null, group: null }`. `rankClick` 맨 앞에서 `[data-sym]` 줄이면 `closeRank(); select(sym)`. CSS 는 기존 `.rrow` 열 너비에 맞춘다(값 · 등락 · 5일 · 메모). 문서: DEVELOPMENT.md 의 지수 줄 설명(세 장)과 새 절 "시장 지표 화면", README 의 지수 줄 문장.
- [ ] **Step 4: 통과 확인** — `node tests/session-ui.mjs` PASS, 21개 전체 PASS.
- [ ] **Step 5: 커밋(1단계)**

```bash
git checkout -b feat/market-view   # Task 1 시작 전에
git add main.js renderer.js index.html tests/index-main.mjs tests/session-ui.mjs docs/DEVELOPMENT.md README.md docs/superpowers/specs/2026-10-27-market-view-design.md docs/superpowers/plans/2026-10-27-market-view.md
git commit -F <메시지 파일>   # feat(market): 지수 줄을 대표 6개로 줄이고 시장 순위 패널에 지표 화면을 더한다
```

## 2단계 — 외국인 수급 · 코스피200 선물 · HY OAS

### Task 3: `market:extras` (main) · 코스피200 선물 값

**Files:**
- Modify: `main.js` — 새 함수들과 `ipcMain.handle('market:extras', …)`, 국내 지수 주소에 `FUT`
- Modify: `preload.js` — `marketExtras: () => ipcRenderer.invoke('market:extras')`
- Create: `tests/market.mjs` (가짜 electron · `Date` 주입, `tests/extended-chart.mjs` 와 같은 틀)
- Modify: `tests/net-timeout.mjs`(`CALLS` 에 `'market:extras': []`), `tests/index-main.mjs`, `tests/run.mjs`(스위트 목록), `.github/workflows/test.yml`(목록에 `market`), `docs/DEVELOPMENT.md`(스위트 수 스물두 개 · 데이터 표)

**Interfaces:**
- Produces (`market:extras` 응답): `{ ok, spotFlows, futFlows, kospiDays, futDays, hyOas, at }`
  - `spotFlows` · `futFlows`: `[{ date: 'YYYYMMDD', foreign: number, inst: number, personal: number, final: boolean }]` 오름차순, 최근 10거래일 — 실패면 `null`.
  - `kospiDays` · `futDays`: `[{ date: 'YYYYMMDD', close: number }]` 오름차순, 최근 30일(달력) — 실패면 `null`.
  - `hyOas`: `[{ date: 'YYYYMMDD', value: number }]` 오름차순, 최근 60개 — 실패면 `null`.
  - `ok` 는 다섯 부분이 모두 실패했을 때만 `false`(`error` 와 함께). `at` 은 ISO 시각.
- `quote:indices` 국내 지수 주소 `KOSPI,KOSDAQ,FUT` — 항목 `code: 'FUT'`, `name` 은 응답의 `stockName`.
- 주소(2026-10-27 실측):
  - 수급 `https://m.stock.naver.com/api/index/{KOSPI|FUT}/trend?bizdate=YYYYMMDD` → `{ bizdate, personalValue, foreignValue, institutionalValue }`(`'+4,080'` 꼴 문자열)
  - 일별 종가 `https://api.stock.naver.com/chart/domestic/index/{KOSPI|FUT}/day?startDateTime=YYYYMMDD&endDateTime=YYYYMMDD` → `[{ localDate, closePrice, … }]`(장중에는 오늘 행 포함)
  - HY OAS `https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2` → `observation_date,BAMLH0A0HYM2` 머리 줄 + `날짜,값`(휴일은 값이 빈 줄)
- 함수(이름 고정): `parseFlowValue(v) → number | null`, `naverFlow(path, date, now)`(지난 날 · 확정 값은 `'경로|날짜'` 로 기억), `naverIndexCloses(path, now)`, `fredHyOas(now)`(6시간 기억, 실패는 기억하지 않음). `final` 은 `date < kstDay(now) || kstClock(now) >= '1800'`.
- 수급 날짜는 `kospiDays` 의 마지막 10개 날짜다(휴일 · 미래 날짜를 묻지 않는다). `kospiDays` 가 실패하면 수급도 `null`.

- [ ] **Step 1: 실패하는 테스트** (`tests/market.mjs`)
  - `수급은 거래일만 묻는다` — 일별 종가가 `20261023, 20261026, 20261027` 이면 수급 요청은 그 세 날짜뿐(10/24 · 10/25 없음), 값 `'+4,080'` → `4080`, `'-9,811'` → `-9811`, `''` → `null`.
  - `final 은 한국 18:00` — `NOW = 2026-10-27T17:59+09:00` 이면 10/27 `final: false`, 18:00 이면 `true`. 지난 날은 두 번째 호출에서 다시 묻지 않고(요청 기록), 오늘 잠정은 다시 묻는다.
  - `FRED 빈 값 · 점은 건너뛴다` — `2026-10-21,3.27` · `2026-10-22,` · `2026-10-23,.` · `2026-10-24,3.40` → `[{date:'20261021',value:3.27},{date:'20261024',value:3.40}]`. 6시간 안에는 다시 묻지 않는다.
  - `출처 하나가 실패해도 나머지는 온다` — FRED 가 500 이면 `hyOas: null` 이고 나머지 · `ok: true`. 모두 실패면 `ok: false`.
  - `모양이 다른 수급 응답은 그날을 뺀다` — `{ detailCode: 'invalid' }` 면 그 날짜 줄이 없다.
  - `tests/index-main.mjs`: `코스피200 선물은 코스피 · 코스닥과 한 요청으로` — 주소 `/domestic/index/KOSPI,KOSDAQ,FUT`, 응답에 `FUT` 를 섞으면 항목 `FUT`.
- [ ] **Step 2: 실패 확인** — `node tests/market.mjs` · `node tests/index-main.mjs` 실패(핸들러 없음).
- [ ] **Step 3: 구현** — Interfaces 대로. 다섯 부분은 `Promise.allSettled` 로 따로. 네이버 요청은 `naverJson`, FRED 는 `netFetch` + `res.text()`. 선물 · 현물 수급은 같은 날짜 목록으로 묻는다.
- [ ] **Step 4: 통과 확인** — `node tests/market.mjs` · `index-main` · `net-timeout` · `state-contract`(preload · main · renderer 계약 — renderer 가 `api.marketExtras` 를 아직 안 부르면 "내보내는 함수는 renderer 가 모두 쓴다" 가 실패하므로 Task 4 와 함께 통과시킨다) PASS. 실제 네트워크로 `market:extras` · `quote:indices`(`KOSPI,KOSDAQ,FUT` 셋 다 오는지)를 한 번 불러 본다(스크래치 스크립트).

### Task 4: 지표 화면의 수급 · 선물 · HY OAS 줄

**Files:**
- Modify: `renderer.js` — `marketExtras` 캐시, `loadMarket`, `marketRow` 의 `FUT` · `SPOT` · `FUTFLOW` · `HYOAS`
- Modify: `docs/DEVELOPMENT.md`, `README.md`
- Test: `tests/session-ui.mjs`

**Interfaces:**
- Consumes: Task 3 의 응답 모양, `indexItems` 의 `FUT` 항목.
- Produces: prelude 에 `let marketExtras = null; // { at, d }` · `let marketLoading = false;`. `async function loadMarket()` — 지표 화면이 열려 있을 때 `renderRank` 가 부른다, `RANK_TTL`(1분)이 지났을 때만, 받는 중이면 또 묻지 않고, 실패하면 있던 성공 값을 둔다(`loadRank` 와 같다).
- 줄 규칙:
  - `FUT`: 값 · 등락률은 `indexItems` 의 `FUT`, 메모 `20분 지연`, 5일 변화는 `futDays` 의 6번째 앞 종가 대비, `symbol: null`.
  - `SPOT` · `FUTFLOW`: 값은 마지막 확정일의 `foreign`(부호 · 천 단위 쉼표, 단위 없음), 5일 변화 자리에 `N일 연속 순매수` / `N일 연속 순매도`(확정일 끝에서 같은 부호가 이어진 수, 0 인 날에서 끊는다), 메모에 확정 아닌 오늘이 있으면 `오늘 잠정 +4,080`. `symbol: null`.
  - `HYOAS`: 값 `3.38%`(소수 둘째), 5일 변화는 다섯 줄 앞 대비 bp, 메모 `10/23 기준`(마지막 날짜). `symbol: null`.

- [ ] **Step 1: 실패하는 테스트**
  - `market panel: flows show the last final day, the streak, and today's provisional value` — 확정 `-9811, -6827, +2100, +3300` · 오늘 잠정 `+4080` → 값 `+3,300`, `2일 연속 순매수`, `오늘 잠정 +4,080`.
  - `market panel: KOSPI 200 futures says 20분 지연 and cannot be clicked; HY OAS shows the date it is from` — `FUT` 줄에 `data-sym` 없음 · `20분 지연`, `HYOAS` 줄 `3.38%` · `10/23 기준`.
  - `market panel: extras load once a minute while open, keep the last good answer on failure` — `api.marketExtras` 호출 수 · 실패 뒤에도 이전 값.
- [ ] **Step 2: 실패 확인** — `node tests/session-ui.mjs` 에서 위 세 개 실패.
- [ ] **Step 3: 구현** — Interfaces 대로. `renderRank` 의 `mk` 분기에서 `loadMarket()` 을 부른다(시장 순위 탭이 `loadRank` 를 부르는 자리와 같은 조건).
- [ ] **Step 4: 통과 확인** — 22개 전체(`market` 포함) PASS.
- [ ] **Step 5: 커밋(2단계)** — `feat(market): 지표 화면에 외국인 현물 · 선물 수급, 코스피200 선물, 미국 HY OAS 를 더한다` (Task 3 · 4 파일 전부).

## 3단계 — 데드캣 점검

### Task 5: `market-check.js` 판정

**Files:**
- Create: `market-check.js` (클래식 스크립트 + `module.exports`, `backtest.js` 와 같은 틀)
- Test: `tests/market.mjs` 에 절 하나 더(순수 함수 — `createRequire('../market-check.js')`)

**Interfaces:**
- Produces: `const CHECK = { LOOKBACK: 5, SPOT_STREAK: 2, SOX_DAYS: 20, SOX_NEAR_LOW: 0.03, USD_RISK: 0.01, VIX_RISK_5D: 0.15, VIX_RISK_DAY: 10, OAS_RISK: 0.25, TNX_CALM_BP: 10, TNX_RISK_BP: 20 }`;
  `function marketChecks(input) → [{ key, verdict: 'good' | 'neutral' | 'risk' | null, detail: string }]`, `key` 순서 `['spot', 'futures', 'sox', 'usdkrw', 'vix', 'hyoas', 'us10y']`.
  `input = { spotFlows, futFlows, kospiDays, futDays, hyOas, sox, usdkrw, vix, us10y }` — 앞 다섯은 Task 3 모양, 뒤 넷은 `{ now: number, closes: number[], dayPct: number | null }`(일봉 오름차순, 없으면 `null`).
- 규칙(스펙 ③): "5거래일 전" = `closes[closes.length - 1 - CHECK.LOOKBACK]`. SOX 의 "직전 20거래일" = `closes.slice(-21, -1)` — 긍정 `now > max`, 위험 `now <= min * (1 + 0.03)`. 수급은 `final` 인 줄만, 현물 긍정 = 마지막 두 확정일 모두 `foreign > 0`, 현물 위험 = 마지막 확정일 `foreign < 0` 이고 그날 코스피(`kospiDays` 그날 종가 > 앞날 종가) 상승. 선물 긍정 = 마지막 확정일 선물 상승(`futDays`) 이고 `foreign > 0`, 선물 위험 = 그날 코스피 상승이고 선물 `foreign < 0`. HY OAS 는 다섯 줄 앞 대비 차이(%p). 미국채는 `(now - base) * 100` bp. 데이터가 모자라면 `verdict: null`, `detail` 은 `데이터 부족`.
- `detail` 은 근거 숫자 한 줄(예: `5거래일 전 1,318.40 → 지금 1,331.20 (+0.97%)`).

- [ ] **Step 1: 실패하는 테스트** — 규칙마다 긍정 · 중립 · 위험 · 판정 불가 경계 한 벌씩. 반드시 넣을 경계값:
  - 원/달러 `base 1000`: `now 1000` → good, `1009.99` → neutral, `1010` → risk.
  - VIX `base 20`: `19.9` → good, `22.99` neutral, `23` risk(+15%), `dayPct 10` 이면 `now 20.5` 여도 risk.
  - HY OAS `3.10 → 3.10` neutral(축소 아님), `3.09` good, `3.35` risk(+0.25), 행 5개뿐이면 null.
  - 미국채 `base 4.90`: `5.00`(+10bp) good, `5.09` neutral, `5.10`(+20bp) risk.
  - SOX 직전 20개 `[100..119]`, `now 120` good, `now 103` risk(최저 100 의 3% 이내), `now 110` neutral, 일봉 20개뿐이면 null.
  - 현물 `[{-1,f},{+1,f},{+2,f},{+5,잠정}]` → good(잠정치는 판정에 쓰지 않는다 — 마지막 두 확정이 +1 · +2), `[{+1,f},{-3,f}]` 이고 그날 코스피 상승 → risk.
- [ ] **Step 2: 실패 확인** — `node tests/market.mjs` 새 절 실패(모듈 없음).
- [ ] **Step 3: 구현** — Interfaces 대로, 화면 코드 없음.
- [ ] **Step 4: 통과 확인** — `node tests/market.mjs` PASS.

### Task 6: 판정 점 · 요약 · 미니 선

**Files:**
- Modify: `index.html` — `<script src="./market-check.js">` 를 `backtest.js` 뒤 · `renderer.js` 앞에, CSS(`.mdot.good|neutral|risk`, `.mspark`, `.msum`)
- Modify: `renderer.js` — `marketCheckInput()`, `marketRow` 의 `verdict` · `detail` · `spark`, `marketHtml` 맨 위 요약 줄, `function sparkSvg(values) → string`
- Modify: `tests/dom-contract.mjs`(스크립트 순서), `tests/isolation.mjs` · `tests/packaged.mjs` · `tests/run.mjs` 의 앱 소스 목록에 `market-check.js`, `tests/session-ui.mjs`(하네스에 `market-check.js` 를 `backtest` 처럼 넣는다)
- Modify: `docs/DEVELOPMENT.md`, `README.md` — 점검 기준 표와 "참고용" 문장

**Interfaces:**
- Consumes: Task 5 `marketChecks` · `CHECK`, Task 4 `marketExtras`, `quotes[sym].daily`, `indexItems`.
- Produces: 판정 key → 줄 key: `spot→SPOT`, `futures→FUTFLOW`, `sox→SOX`, `usdkrw→USDKRW`, `vix→VIX`, `hyoas→HYOAS`, `us10y→US10Y`. 요약 줄 `데드캣 점검 · 긍정 N · 중립 N · 위험 N (참고용)`, `null` 이 있으면 끝에 ` · 판정 M/7`. 점 색: good `#2fa15a`(초록) · neutral `var(--mute)` · risk `#e8862a`(주황) — 헤더의 `.live` · `.delay` 와 같은 색. 요약 줄 `title`: "경험칙을 숫자로 옮긴 참고용입니다 — 매매 판단을 대신하지 않습니다". 미니 선: 줄마다 최근 20개 값(일봉 종가 · 수급 확정 `foreign` · HY OAS) 을 60×14 SVG `polyline`, 값이 2개 미만이면 없음.

- [ ] **Step 1: 실패하는 테스트** (`tests/session-ui.mjs`)
  - `market panel: summary counts verdicts and says how many could be judged` — 판정 `good,good,neutral,risk,null,good,risk` → `긍정 3 · 중립 1 · 위험 2 (참고용) · 판정 6/7`, 결론 문구(`데드캣` 뒤 `이다` 등) 없음.
  - `market panel: each checked row has a dot with its rule detail in the tooltip; others have none` — `VIX` 줄 `mdot risk` · `title` 에 근거, `KOSPI` 줄 점 없음.
  - `sparkSvg draws 20 recent values as a polyline and nothing below two` — `sparkSvg([1,2,3])` 의 `points` 좌표 3쌍, `sparkSvg([1])` 은 `''`.
  - `tests/dom-contract.mjs`: `market-check.js 가 backtest.js 뒤, renderer.js 앞에 온다`.
- [ ] **Step 2: 실패 확인** — 해당 스위트 실패.
- [ ] **Step 3: 구현** — Interfaces 대로. `marketCheckInput()` 은 `sox`/`usdkrw`/`vix`/`us10y` 를 `quotes[sym].daily.closes` 와 지수 줄 값으로 만든다(`vix.dayPct` 는 지수 줄 `pct`).
- [ ] **Step 4: 통과 확인** — 22개 전체 PASS. 실제 네트워크로 `market:extras` 와 판정을 한 번 돌려(스크래치 스크립트, 앱 아님) 일곱 줄이 모두 판정되는지 본다.
- [ ] **Step 5: 커밋(3단계)** — `feat(market): 지표 화면에 데드캣 점검 판정 · 요약 · 20일 미니 선을 더한다`.
