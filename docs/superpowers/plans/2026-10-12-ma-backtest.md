# 이평선 백테스트 "추세 점검" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 선택한 종목의 5년 일봉으로 "20일선이 60일선 위면 보유" 규칙과 지금 이평 배열의 과거 성적을 계산해, 52주 줄 아래 한 줄 + 툴팁으로 보여 준다.

**Architecture:** 계산은 새 파일 `backtest.js`(화면 없음, indicators.js 와 같은 클래식 스크립트 + `module.exports` 형식)에 둔다. renderer 의 `renderTrendCheck` 가 `dailyCache` 원본으로 `trendCheck` 를 부르고, 결과를 (종목, 마지막 확정 봉)으로 캐시해 30초 갱신 때는 다시 계산하지 않는다. 판정은 우연과 비교한다 — 1번은 판단 열을 돌린 가짜 타이밍 200개, 2번은 등락을 덩어리로 섞은 가짜 주가 200개.

**Tech Stack:** Electron 43 클래식 스크립트(`indicators.js` → `backtest.js` → `renderer.js`), Node 내장 모듈만 쓰는 `.mjs` 테스트 스위트, vm 하네스(`tests/session-ui.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-12-ma-backtest-design.md`

## Global Constraints

- 브랜치 `feat/ma-backtest` (이미 만들어 두었다). 새 의존성 없음. 새 네트워크 요청 없음 — `dailyCache[symbol]` 의 `closes` · `times` 만 쓴다.
- 커밋은 **사용자가 말할 때만** 한다. 메시지는 `type(scope): 한글 subject` + 한글 본문, `Co-Authored-By` 트레일러를 넣지 않는다. 푸시는 사용자가 한다.
- 검증은 `node --check` 와 **앱을 띄우지 않는 스위트**만. 앱 실행 · `npm test` 는 하지 않는다(사용자가 직접 본다).
- 스위트는 `TZ=Asia/Seoul` 로 돌린다(CI 와 같다).
- 작업 사본의 기존 파일은 CRLF 다. 고칠 때는 Edit 도구를 쓴다 — `sed -i` 는 줄 끝을 LF 로 바꾼다. 새 파일은 Write 도구로 만든다.
- Bash 도구는 `\\n` · `\\u` 같은 역슬래시 두 개를 하나로 바꾼다. 역슬래시가 든 코드는 Write · Edit 도구로만 쓴다.
- 코드 주석은 주변처럼 한국어로, 왜 그렇게 하는지를 쓴다.
- 상수(스펙 그대로): 확정 봉 500 미만 계산 안 함 · 국내 하루 ±30% 초과 봉 뒤부터 · 시작 봉 59 · 회전 200개(62칸 이상, 양쪽 끝 1%) · 가짜 주가 200개(덩어리 평균 10일, 칸 있는 경로 100개 미만이면 판정 안 함, 양쪽 끝 2.5% + 앞뒤 절반 부호) · 보유 20거래일 · 진입 5회 미만 표본 부족 · 칸 구간 8개 · 60일 미만이면 방향을 빼고 다시.
- 비용: 국내 종목(`isDomestic`) 왕복 0.25%, 해외 종목 · 지수 0.10%.
- 툴팁 마지막 줄(고정): `배당·세금·환전 제외 · 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽습니다 · 과거 통계이며 매매 권유가 아닙니다`

## Review Focus

1. 액면분할 · 병합을 야후가 아직 반영하지 않은 국내 종목 — 엉뚱한 수익률 대신 이상 봉 뒤부터 계산하거나 "데이터 확인 필요" 를 말한다. → Task 1 (`usableSeries` 국내 +40% 봉).
2. 장중 30초 갱신 · 일봉 30분 재수신 — 마지막 봉만 움직이는 동안 다시 계산하지 않고, 다음 날 봉이 늘면 한 번 다시 한다. → Task 5 (캐시 테스트).
3. 장 전에 일봉 마지막 봉이 어제인 경우 — 그 봉도 빼므로 하루 늦지만, 툴팁의 "MM/DD 종가 기준" 이 실제로 쓴 마지막 봉 날짜를 말한다. → Task 3 (`regime.at` = 쓴 마지막 봉 시각), Task 5 (툴팁 날짜).
4. 긴 문구가 340px 폭을 넘는 경우 — 줄이 두 줄이 되어 차트를 밀지 않고 말줄임된다. → Task 5 (dom-contract 의 `.trendchk` CSS 검사).
5. 종목을 처음 고를 때의 계산 시간 — 한 번에 200ms 를 넘지 않는다(실측 약 50ms). → Task 4 (속도 검사).

---

### Task 1: `backtest.js` 뼈대 — 쓸 수 있는 봉 · 자산 곡선 · 20/60 규칙

**Files:**
- Create: `backtest.js`
- Create: `tests/backtest.mjs`

**Interfaces:**
- Consumes: `sma(closes, period)` (indicators.js — 앞부분은 `null`)
- Produces:
  - `usableSeries(closes, times, domestic)` → `null` | `{ error: 'data' }` | `{ closes, times, cut: boolean }`
  - `equityOf(closes, d, start, cost)` → `{ total, mdd, entries, trades, inShare }`
  - `holdOf(closes, start, cost)` → `{ total, mdd }`
  - `ruleBacktest(closes, times, short, long, cost, start = BT_START)` → `{ start, want: boolean[], strat: { total, mdd, entries, trades, inShare, cagr }, hold: { total, mdd, cagr }, on: boolean, since: ms, from: ms, to: ms }`
  - `seedOf(string)` → uint32, `mulberry32(seed)` → `() => [0, 1)`, `median(number[])` → number | null
  - 상수 `BT_*` (아래 코드)

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `tests/backtest.mjs` 를 Write 도구로 만든다.

```js
// 이평선 백테스트("추세 점검") 계산 가드 — 앱을 띄우지 않고 backtest.js 만 본다.
//
// 지켜야 할 것은 셋이다.
// 1. 미래 값을 쓰지 않는다 — 종가 t 로 판단하고 종가 t+1 에 체결한다. 끝나지 않은 창은 뺀다.
// 2. 우연을 "나음"으로 말하지 않는다 — 무작위 걸음 주가에서 판정이 5% 안팎으로만 나와야 한다.
// 3. 볼 때마다 같다 — 난수는 종목 코드로 정해진다.
import * as B from '../backtest.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// --- 데이터 만들기 -------------------------------------------------------------
const DAY = 86400000;
const day = (i) => Date.UTC(2021, 0, 4) + i * DAY;
const series = (n, f) => ({ c: Array.from({ length: n }, (_, i) => f(i)), t: Array.from({ length: n }, (_, i) => day(i)) });
const last = (a) => a[a.length - 1];
// 표류 없는 무작위 걸음(로그 정규, 일 변동 vol). 시드가 같으면 같은 주가.
function walk(seed, n = 1231, vol = 0.02) {
  const r = B.mulberry32(seed);
  return series(n, (() => { let p = 10000; return (i) => {
    if (i) p *= Math.exp(vol * Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r()));
    return p;
  }; })());
}
// --- 1. 쓸 수 있는 봉 ----------------------------------------------------------
{
  const s = walk(1, 501);
  const u = B.usableSeries(s.c, s.t, false);
  check('마지막 봉을 뺀다 (501봉 → 500봉)', u && u.closes.length === 500 && last(u.closes) === s.c[499]);
  check('500봉이 안 되면 null (500봉 → 499봉)', B.usableSeries(s.c.slice(0, 500), s.t.slice(0, 500), false) === null);

  const j = walk(2, 801);
  for (let i = 100; i < 801; i++) j.c[i] *= 1.4; // 100번 봉에서 +40% — 액면 병합 같은 이상
  const cut = B.usableSeries(j.c, j.t, true);
  check('국내: 이상 봉부터 쓴다', cut && cut.cut && cut.closes.length === 700 && cut.closes[0] === j.c[100],
    cut ? `${cut.closes.length}봉` : String(cut));
  check('해외: 이상 봉 검사를 하지 않는다', B.usableSeries(j.c, j.t, false).closes.length === 800);

  const k = walk(3, 801);
  for (let i = 400; i < 801; i++) k.c[i] *= 1.4;
  check('국내: 이상 봉 뒤로 500봉이 안 남으면 데이터 확인 필요',
    B.usableSeries(k.c, k.t, true)?.error === 'data');
  check('국내: 원래 짧으면 이상 봉이 있어도 null',
    B.usableSeries(k.c.slice(0, 450), k.t.slice(0, 450), true) === null);
}

// --- 2. 다음 날 종가 체결 · 비용 (손으로 센 값) ---------------------------------
{
  // 판단 d[i] 는 종가 i+1 에 체결된다. 비용 0.2% 면 체결마다 0.999 를 곱한다.
  //  t=1 사기(d0)  t=2 +10%  t=3 +10% 후 팔기(d2)  t=5 사기(d4)  t=6 -9.09% 후 마지막이라 팔기
  const closes = [100, 100, 110, 121, 121, 110, 100];
  const r = B.equityOf(closes, [true, true, false, false, true, true, true], 0, 0.002);
  check('누적 = 0.999⁴ × 1.1 − 1', near(r.total, 0.999 ** 4 * 1.1 - 1), String(r.total));
  check('진입 2회 · 체결 4회 · 보유 3/5 구간', r.entries === 2 && r.trades === 4 && near(r.inShare, 0.6));
  check('최대 낙폭은 체결 비용을 반영한 고점 기준', near(r.mdd, 1 - 0.999 ** 2 / 1.1), String(r.mdd));

  const h = B.holdOf(closes, 0, 0.002);
  check('그냥 보유: 종가 1 에 사서 마지막 종가에 판다', near(h.total, 0.999 ** 2 - 1) && near(h.mdd, 1 - 100 / 121));

  // 판단한 날 종가에 체결하는 구현이면 t=2 의 +10% 를 하나 더 먹는다
  check('판단한 날 종가에 체결하지 않는다', !near(r.total, 0.999 ** 4 * 1.21 - 1));
}

// --- 3. 20/60 규칙 -------------------------------------------------------------
{
  const up = series(600, (i) => 100 * 1.002 ** i);
  const bt = B.ruleBacktest(up.c, up.t, 5, 20, 0.0025);
  check('오르기만 하면 보유 상태이고, 5일선이 처음 생긴 날부터다', bt.on === true && bt.since === up.t[19]);
  check('시작은 60일선이 처음 생기는 봉 다음 날', bt.from === up.t[B.BT_START + 1] && bt.to === last(up.t));
  check('오르기만 하면 진입 1회', bt.strat.entries === 1);

  // t 이후 값을 바꿔도 t 까지의 판단은 같다
  const a = walk(4, 700);
  const b = { c: a.c.map((v, i) => (i > 400 ? v * (1 + 0.3 * Math.sin(i)) : v)), t: a.t };
  const wa = B.ruleBacktest(a.c, a.t, 20, 60, 0.0025).want;
  const wb = B.ruleBacktest(b.c, b.t, 20, 60, 0.0025).want;
  check('t 이후 가격을 바꿔도 t 까지의 판단이 같다', wa.slice(0, 401).every((v, i) => v === wb[i]));
}
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd C:/Users/혜성/Desktop/project/stock-widget-v1 && TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `Cannot find module` … `backtest.js` 로 죽는다.

- [ ] **Step 3: `backtest.js` 를 만든다** — Write 도구로. 아래 코드 뒤에 내보내기 블록을 붙인다.

```js
// backtest.js — 이평선 규칙을 지난 일봉에 대 보는 계산("추세 점검"). 화면과 무관하다.
// 화면에서는 index.html 이 indicators.js 다음에 <script> 로 읽어 전역 sma 를 쓰고,
// Node(테스트)에서는 아래 require 로 가져온다.
const btSma = typeof module !== 'undefined' ? require('./indicators.js').sma : sma;

const BT_MIN_BARS = 500;    // 쓸 수 있는 확정 봉이 이보다 적으면(상장 2년 미만) 계산하지 않는다
const BT_JUMP = 0.30;       // 국내 가격제한폭. 이보다 크게 움직인 봉은 액면분할 같은 데이터 이상이다
const BT_START = 59;        // 60일선이 처음 생기는 봉. 20/60 · 5/20 이 같은 날 시작한다
const BT_ROTATIONS = 200;   // 시점만 밀어 만든 가짜 타이밍 수
const BT_ROT_EDGE = 0.01;   // 회전 판정의 양쪽 끝. 회전 200개는 서로 겹쳐 2.5% 로 두면 무작위 걸음 600개에서 7.5% 가 걸렸다 → 1% 에서 5%
const BT_ROT_GAP = 62;      // 이보다 적게 밀면 가짜 규칙이 그 구간 등락을 "본다" (20·60일선 차이는 최근 59일 등락으로 정해진다)
const BT_PATHS = 200;       // 덩어리로 섞어 만든 가짜 주가 수
const BT_MIN_PATHS = 100;   // 칸이 있는 가짜 주가가 이보다 적으면 판정하지 않는다
const BT_BLOCK = 10;        // 섞는 덩어리의 평균 길이(거래일)
const BT_H = 20;            // 국면 조회의 보유 기간(거래일)
const BT_MIN_ENTRIES = 5;   // 진입이 이보다 적으면 판정하지 않는다
const BT_MIN_EPISODES = 8;  // 칸의 구간이 이보다 적거나
const BT_MIN_DAYS = 60;     // 날이 이보다 적으면 20일선 방향을 빼고 본다
const BT_REGIME_START = 119; // 120일선이 처음 생기는 봉

// 종목 코드 → 시드 (FNV-1a 32비트). 볼 때마다 같은 가짜 주가가 나와야 한다.
function seedOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// 32비트 난수 (mulberry32). 0 이상 1 미만.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = Float64Array.from(xs).sort();
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// 계산에 쓸 봉. 마지막 봉은 늘 뺀다 — 장중에는 그 종가가 계속 움직인다(confirmedCrosses 와 같은 이유).
// 국내 종목은 가격제한폭 밖으로 움직인 마지막 봉부터 쓴다.
// 반환: null(짧다 — 줄을 숨긴다) · { error: 'data' }(이상 봉 뒤로 짧다) · { closes, times, cut }
function usableSeries(closes, times, domestic) {
  const end = closes.length - 1;
  if (end < BT_MIN_BARS) return null;
  let from = 0;
  if (domestic) {
    for (let i = 1; i < end; i++) if (Math.abs(closes[i] / closes[i - 1] - 1) > BT_JUMP) from = i;
  }
  if (end - from < BT_MIN_BARS) return { error: 'data' };
  return { closes: closes.slice(from, end), times: times.slice(from, end), cut: from > 0 };
}

// 판단 열 d 로 자산 곡선을 만든다. d[i] 는 종가 i 에서 내린 판단이고 종가 i+1 에 체결한다.
// 현금으로 시작해 마지막 종가에서 판다. 체결할 때마다 비용 절반을 뺀다.
function equityOf(closes, d, start, cost) {
  const n = closes.length;
  const keep = 1 - cost / 2;
  let e = 1, peak = 1, mdd = 0, entries = 0, trades = 0, held = 0, pos = false;
  for (let t = start + 1; t <= n - 1; t++) {
    if (pos) e *= closes[t] / closes[t - 1];          // 구간 (t−1, t]
    const next = t <= n - 2 ? d[t - 1] : false;        // 구간 (t, t+1] 을 들고 있나
    if (next !== pos) { e *= keep; trades++; if (next) entries++; pos = next; }
    if (pos && t <= n - 2) held++;
    if (e > peak) peak = e;
    if (1 - e / peak > mdd) mdd = 1 - e / peak;
  }
  return { total: e - 1, mdd, entries, trades, inShare: held / (n - 2 - start) };
}

// 종가 start+1 에 사서 마지막 종가에 판다.
function holdOf(closes, start, cost) {
  const n = closes.length;
  const keep = 1 - cost / 2;
  let peak = keep, mdd = 0;
  for (let t = start + 1; t <= n - 1; t++) {
    const e = keep * closes[t] / closes[start + 1];
    if (e > peak) peak = e;
    if (1 - e / peak > mdd) mdd = 1 - e / peak;
  }
  return { total: keep * keep * closes[n - 1] / closes[start + 1] - 1, mdd };
}

const yearsOf = (times, start) => (times[times.length - 1] - times[start + 1]) / (365.25 * 86400000);
const cagrOf = (total, years) => Math.pow(1 + total, 1 / years) - 1;

// "단기선이 장기선 위면 보유" 규칙을 그냥 보유와 견준다.
function ruleBacktest(closes, times, short, long, cost, start = BT_START) {
  const a = btSma(closes, short);
  const b = btSma(closes, long);
  const want = closes.map((_, i) => a[i] != null && b[i] != null && a[i] > b[i]);
  const n = closes.length;
  const years = yearsOf(times, start);
  const strat = equityOf(closes, want, start, cost);
  const hold = holdOf(closes, start, cost);
  let s = n - 1;
  while (s > 0 && want[s - 1] === want[n - 1]) s--;
  return {
    start, want,
    strat: { ...strat, cagr: cagrOf(strat.total, years) },
    hold: { ...hold, cagr: cagrOf(hold.total, years) },
    on: want[n - 1], since: times[s], from: times[start + 1], to: times[n - 1],
  };
}
if (typeof module !== 'undefined') {
  module.exports = {
    BT_MIN_BARS, BT_JUMP, BT_START, BT_ROTATIONS, BT_ROT_EDGE, BT_ROT_GAP, BT_PATHS, BT_MIN_PATHS, BT_BLOCK, BT_H,
    BT_MIN_ENTRIES, BT_MIN_EPISODES, BT_MIN_DAYS, BT_REGIME_START,
    seedOf, mulberry32, median, usableSeries, equityOf, holdOf, ruleBacktest,
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --check backtest.js && TZ=Asia/Seoul node tests/backtest.mjs`
Expected: 1~3절 `OK` 15개, 마지막 줄 `PASS: 실패 0건`.

---

### Task 2: 회전 판정 — 가짜 타이밍 200개와 비교

**Files:**
- Modify: `backtest.js` — `ruleBacktest` 뒤, 내보내기 블록 앞
- Modify: `tests/backtest.mjs` — 3절 뒤, 마지막 `console.log` 앞

**Interfaces:**
- Consumes: `equityOf`, `median`, `ruleBacktest` 결과(`want`, `start`, `strat.total`, `strat.entries`)
- Produces: `rotationVerdict(closes, bt, cost, count = BT_ROTATIONS)` → `{ pct: 0~1, verdict: 'better'|'worse'|'same'|'few', nullMdd, count }`

- [ ] **Step 1: 실패하는 테스트를 쓴다** — Edit 도구로 3절 끝(`check('t 이후 가격을 바꿔도 t 까지의 판단이 같다', …);` 다음 줄의 `}`) 뒤에 넣는다.

```js
// --- 4. 회전 판정 --------------------------------------------------------------
{
  // 무작위 걸음에는 규칙이 쓸모 있을 리 없다 → 판정이 1% 끝(양쪽 2%)에 기대 5% 안팎(실측 30/600)
  let hits = 0;
  for (let s = 0; s < 200; s++) {
    const w = walk(1000 + s);
    const u = B.usableSeries(w.c, w.t, false);
    const v = B.rotationVerdict(u.closes, B.ruleBacktest(u.closes, u.times, 20, 60, 0.0025), 0.0025);
    if (v.verdict === 'better' || v.verdict === 'worse') hits++;
  }
  check('무작위 걸음 200개에서 나음/못함이 2 ~ 20개', hits >= 2 && hits <= 20, `${hits}개`);

  // 추세가 이어지는 주가(평균 60일마다 오름 ↔ 내림)에서는 규칙이 나음으로 나와야 한다 (실측 16/20).
  // 120일마다면 5년에 진입이 4회 안팎이라 대부분 표본 부족이 된다.
  let better = 0;
  for (let s = 0; s < 20; s++) {
    const r = B.mulberry32(9000 + s);
    let mu = 0.004, p = 10000;
    const w = series(1231, (i) => {
      if (i) { if (r() < 1 / 60) mu = -mu; p *= Math.exp(mu + 0.01 * Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r())); }
      return p;
    });
    const u = B.usableSeries(w.c, w.t, false);
    if (B.rotationVerdict(u.closes, B.ruleBacktest(u.closes, u.times, 20, 60, 0.0025), 0.0025).verdict === 'better') better++;
  }
  check('추세가 이어지는 주가 20개 중 14개 이상이 나음', better >= 14, `${better}개`);

  const few = series(600, (i) => 100 * 1.002 ** i);
  const bt = B.ruleBacktest(few.c, few.t, 20, 60, 0.0025);
  check('진입 5회 미만이면 표본 부족', B.rotationVerdict(few.c, bt, 0.0025).verdict === 'few');
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `TypeError: B.rotationVerdict is not a function` 로 죽는다.

- [ ] **Step 3: 구현한다** — `ruleBacktest` 함수 뒤에 넣고, 내보내기 목록 끝에 `rotationVerdict` 를 더한다.

```js
// 판단 열을 k 칸 돌려(시점만 엉뚱하게) 다시 돌린 결과들 사이에서 규칙의 순위를 본다.
// 보유 비율 · 매매 횟수는 그대로라 "덜 들고 있어서 낙폭이 작다" 같은 효과가 걸러진다.
function rotationVerdict(closes, bt, cost, count = BT_ROTATIONS) {
  const { want, start } = bt;
  const n = closes.length;
  const m = n - 2 - start;                 // 쓰이는 판단: start … n−3
  const span = m - 2 * BT_ROT_GAP;
  const d = new Array(n);
  let below = 0, same = 0;
  const mdds = [];
  for (let j = 0; j < count; j++) {
    const k = BT_ROT_GAP + Math.round((j * span) / (count - 1));
    for (let x = 0; x < m; x++) d[start + x] = want[start + ((x + k) % m)];
    const r = equityOf(closes, d, start, cost);
    if (r.total < bt.strat.total) below++;
    else if (r.total === bt.strat.total) same++;
    mdds.push(r.mdd);
  }
  const pct = (below + 0.5 * same) / count;
  const verdict = bt.strat.entries < BT_MIN_ENTRIES ? 'few'
    : pct >= 1 - BT_ROT_EDGE ? 'better' : pct <= BT_ROT_EDGE ? 'worse' : 'same';
  return { pct, verdict, nullMdd: median(mdds), count };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --check backtest.js && TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `무작위 걸음 200개에서 나음/못함이 2 ~ 20개  7개`, `추세가 이어지는 주가 20개 중 14개 이상이 나음  16개`, `PASS: 실패 0건`.

- [ ] **Step 5: 변이 확인** — 스크래치 사본에서 `const BT_ROT_GAP = 62;` 를 `0` 으로, 또 `BT_ROT_EDGE` 를 `0.025` 로 바꿔 각각 돌려 본다. 앞의 것은 "추세가 이어지는" 검사가, 뒤의 것은 실측 수가 달라지는지 본다(2.5% 면 무작위 걸음 200개 중 13개 안팎). 원본은 건드리지 않는다.

---

### Task 3: 이평 배열 국면 — 분류 · 칸 통계 · 가짜 주가

**Files:**
- Modify: `backtest.js` — `rotationVerdict` 뒤, 내보내기 블록 앞
- Modify: `tests/backtest.mjs` — 4절 뒤, 마지막 `console.log` 앞

**Interfaces:**
- Consumes: `btSma`, `median`, `mulberry32`
- Produces:
  - `maRegime(closes)` → `{ cls: ('up'|'down'|'mixUp'|'mixDown'|null)[], up: (boolean|null)[] }` (119번 봉부터)
  - `cellStats(closes, cost, key, slope)` → `{ count, days, episodes, windows, med, rise, allMed, allRise, diff, halves: [number|null, number|null] }` — `key` 는 `slope` 이면 `'up+'` 처럼 배열 + `'+'|'-'`, 아니면 배열만
  - `altPath(closes, rng, block = BT_BLOCK)` → number[] (첫 값은 `closes[0]`)
  - `regimeStats(closes, times, cost, rng, paths = BT_PATHS)` → `{ cls, up, at, fallback, count, days, episodes, windows, med, rise, allMed, allRise, diff, halves, verdict, lo?, hi?, paths? }` — `verdict === 'few'` 이면 `lo` · `hi` · `paths` 가 없다. 칸 있는 경로가 100개 미만이면 `lo: null, hi: null`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — Edit 도구로 4절 끝 뒤에 넣는다.

```js
// --- 5. 이평 배열 --------------------------------------------------------------
{
  const cls = (s) => { const g = B.maRegime(s.c); return `${last(g.cls)}${last(g.up) ? '+' : '-'}`; };
  check('오르기만 하면 정배열 · 20선↑', cls(series(400, (i) => 100 * 1.003 ** i)) === 'up+');
  check('내리기만 하면 역배열 · 20선↓', cls(series(400, (i) => 100 * 0.997 ** i)) === 'down-');
  check('오르다 열흘 급락하면 혼조(20>60) · 20선↓',
    cls(series(400, (i) => (i < 390 ? 100 * 1.003 ** i : 100 * 1.003 ** 390 * 0.97 ** (i - 390)))) === 'mixUp-');
  check('내리다 열흘 급등하면 혼조(20≤60) · 20선↑',
    cls(series(400, (i) => (i < 390 ? 100 * 0.997 ** i : 100 * 0.997 ** 390 * 1.03 ** (i - 390)))) === 'mixDown+');
  const g = B.maRegime(series(200, (i) => 100 + i).c);
  check('120일선이 생기기 전에는 분류하지 않는다', g.cls[B.BT_REGIME_START - 1] === null && g.cls[B.BT_REGIME_START] !== null);
}

// --- 6. 국면 조회 --------------------------------------------------------------
{
  const w = walk(5, 900);
  const u = B.usableSeries(w.c, w.t, false);
  const n = u.closes.length;
  const s = B.cellStats(u.closes, 0.0025, 'up', false);
  check('끝나지 않은 20일 창은 뺀다', s.count === n - 2 - B.BT_H - B.BT_REGIME_START + 1, `${s.count}개`);

  // 칸 넓히기 · 표본 부족은 cellStats 결과와 맞아야 한다
  let fallbacks = 0, mismatch = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const x = walk(seed);
    const v = B.usableSeries(x.c, x.t, false);
    const reg = B.maRegime(v.closes);
    const k = v.closes.length - 1;
    const withSlope = B.cellStats(v.closes, 0.0025, `${reg.cls[k]}${reg.up[k] ? '+' : '-'}`, true);
    const small = (q) => q.episodes < B.BT_MIN_EPISODES || q.days < B.BT_MIN_DAYS;
    const g = B.regimeStats(v.closes, v.times, 0.0025, B.mulberry32(seed), 20);
    if (g.fallback !== small(withSlope)) mismatch++;
    if (g.fallback) {
      fallbacks++;
      if ((g.verdict === 'few') !== small(B.cellStats(v.closes, 0.0025, reg.cls[k], false))) mismatch++;
    } else if (g.verdict === 'few') mismatch++;
  }
  check('칸 넓히기 · 표본 부족이 구간 8개 · 60일 기준을 따른다', mismatch === 0, `어긋남 ${mismatch}`);
  check('무작위 걸음 40개 중 칸을 넓힌 경우가 있다 (위 검사가 빈 검사가 아니다)', fallbacks > 0, `${fallbacks}개`);

  // 오래 오르다 마지막 80일 무너지면 지금 칸(역배열)이 과거에 거의 없다
  const col = series(781, (i) => (i < 700 ? 100 * 1.003 ** i : 100 * 1.003 ** 700 * 0.99 ** (i - 700)));
  const cu = B.usableSeries(col.c, col.t, false);
  const rg = B.regimeStats(cu.closes, cu.times, 0.0025, B.mulberry32(1), 20);
  check('지금 칸이 과거에 드물면 표본 부족', rg.cls === 'down' && rg.verdict === 'few' && rg.lo === undefined);

  // 무작위 걸음에서 판정이 드물어야 한다 (실측 2·3·5 / 60, 경로 100개)
  // 범위 폭도 본다 — 가짜 주가를 섞지 않고 실제 주가를 그대로 다시 재면 범위가 0 폭이 되어
  // 판정이 아예 나오지 않는데, 위 검사(8개 이하)는 그것을 통과시킨다. 실측 폭 6~10%p.
  let hits = 0, narrow = Infinity;
  for (let seed = 0; seed < 60; seed++) {
    const x = walk(5000 + seed);
    const v = B.usableSeries(x.c, x.t, false);
    const r = B.regimeStats(v.closes, v.times, 0.0025, B.mulberry32(seed + 7), 100);
    if (r.verdict === 'better' || r.verdict === 'worse') hits++;
    if (r.lo != null) narrow = Math.min(narrow, r.hi - r.lo);
  }
  check('무작위 걸음 60개에서 나음/못함이 8개 이하', hits <= 8, `${hits}개`);
  check('가짜 주가의 차이 범위가 2%p 보다 넓다 (섞어서 다시 잰다)', narrow > 0.02, `가장 좁은 폭 ${(narrow * 100).toFixed(1)}%p`);
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `TypeError: B.maRegime is not a function` 로 죽는다.

- [ ] **Step 3: 구현한다** — `rotationVerdict` 뒤에 넣고, 내보내기 목록 끝에 `maRegime, cellStats, altPath, regimeStats` 를 더한다.

```js
// 날마다 이평 배열(정배열 up · 역배열 down · 혼조 mixUp/mixDown)과 20일선 방향.
function maRegime(closes) {
  const m5 = btSma(closes, 5), m20 = btSma(closes, 20), m60 = btSma(closes, 60), m120 = btSma(closes, 120);
  const cls = new Array(closes.length).fill(null);
  const up = new Array(closes.length).fill(null);
  for (let t = BT_REGIME_START; t < closes.length; t++) {
    const a = m5[t], b = m20[t], c = m60[t], d = m120[t];
    cls[t] = a > b && b > c && c > d ? 'up'
      : a < b && b < c && c < d ? 'down'
      : b > c ? 'mixUp' : 'mixDown';
    up[t] = m20[t] > m20[t - 5];
  }
  return { cls, up };
}

const keyAt = (reg, t, slope) => (slope ? `${reg.cls[t]}${reg.up[t] ? '+' : '-'}` : reg.cls[t]);

// 칸 key 였던 날들의 20거래일 뒤 수익 vs 모든 날. 다음 날 종가에 사서 h 거래일 뒤 종가에 판다.
function cellStats(closes, cost, key, slope) {
  const reg = maRegime(closes);
  const n = closes.length;
  const first = BT_REGIME_START;
  const last = n - 2 - BT_H;               // 끝나지 않은 창은 뺀다
  const mid = (first + last) >> 1;
  const all = [], cell = [], half = [[[], []], [[], []]];
  let episodes = 0, windows = 0, prev = false, counted = -Infinity;
  for (let t = first; t <= last; t++) {
    const r = (closes[t + 1 + BT_H] / closes[t + 1]) * (1 - cost) - 1;
    const h = half[t <= mid ? 0 : 1];
    all.push(r); h[0].push(r);
    const inCell = keyAt(reg, t, slope) === key;
    if (inCell) {
      cell.push(r); h[1].push(r);
      if (!prev) episodes++;
      if (t - counted >= BT_H) { windows++; counted = t; }
    }
    prev = inCell;
  }
  const share = (xs) => xs.filter((x) => x > 0).length / xs.length;
  const med = median(cell), allMed = median(all);
  return {
    count: all.length, days: cell.length, episodes, windows,
    med, rise: cell.length ? share(cell) : null, allMed, allRise: share(all),
    diff: cell.length ? med - allMed : null,
    halves: half.map(([a, c]) => (c.length ? median(c) - median(a) : null)),
  };
}

// 하루하루 등락을 평균 block 일짜리 덩어리로 섞은 가짜 주가(정상 블록 부트스트랩). 첫 종가는 같다.
function altPath(closes, rng, block = BT_BLOCK) {
  const n = closes.length;
  const steps = n - 1;
  const out = new Array(n);
  out[0] = closes[0];
  let j = Math.floor(rng() * steps);
  for (let i = 1; i < n; i++) {
    if (i > 1) j = rng() < 1 / block ? Math.floor(rng() * steps) : (j + 1) % steps;
    out[i] = (out[i - 1] * closes[j + 1]) / closes[j];
  }
  return out;
}

// 지금 이평 국면이 과거에 평소와 다른 20일 뒤 수익으로 이어졌나.
function regimeStats(closes, times, cost, rng, paths = BT_PATHS) {
  const reg = maRegime(closes);
  const n = closes.length;
  const now = { cls: reg.cls[n - 1], up: reg.up[n - 1], at: times[n - 1] };
  let slope = true;
  let key = keyAt(reg, n - 1, true);
  let s = cellStats(closes, cost, key, true);
  if (s.episodes < BT_MIN_EPISODES || s.days < BT_MIN_DAYS) {
    slope = false;
    key = keyAt(reg, n - 1, false);
    s = cellStats(closes, cost, key, false);
  }
  const base = { ...now, fallback: !slope, ...s };
  if (s.episodes < BT_MIN_EPISODES || s.days < BT_MIN_DAYS) return { ...base, verdict: 'few' };

  const diffs = [];
  for (let p = 0; p < paths; p++) {
    const alt = cellStats(altPath(closes, rng), cost, key, slope);
    if (alt.days) diffs.push(alt.diff);
  }
  if (diffs.length < BT_MIN_PATHS) return { ...base, verdict: 'same', lo: null, hi: null, paths: diffs.length };
  const sorted = Float64Array.from(diffs).sort();
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const lo = q(0.025), hi = q(0.975);
  const [h1, h2] = s.halves;
  const verdict = s.diff > hi && h1 > 0 && h2 > 0 ? 'better'
    : s.diff < lo && h1 < 0 && h2 < 0 ? 'worse' : 'same';
  return { ...base, verdict, lo, hi, paths: diffs.length };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --check backtest.js && TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `끝나지 않은 20일 창은 뺀다  759개`, `무작위 걸음 40개 중 칸을 넓힌 경우가 있다 …  4개`, `무작위 걸음 60개에서 나음/못함이 8개 이하  2개`, `PASS: 실패 0건`.

- [ ] **Step 5: 변이 확인** — 스크래치 사본에서 하나씩: `const last = n - 2 - BT_H;` → `n - 1 - BT_H` (끝나지 않은 창 검사가 깨져야 한다), `diffs.push` 앞의 `cellStats(altPath(closes, rng), …)` → `cellStats(closes, …)` (보정 검사가 깨져야 한다 — 가짜 범위가 0 폭이 된다), `regimeStats` 의 반쪽 조건 `h1 > 0 && h2 > 0` 삭제(보정 수가 늘어나는지 본다).

---

### Task 4: 묶음 `trendCheck` · 같은 결과 · 속도 · CI 목록

**Files:**
- Modify: `backtest.js` — `regimeStats` 뒤, 내보내기 블록 앞
- Modify: `tests/backtest.mjs` — 6절 뒤, 마지막 `console.log` 앞
- Modify: `tests/run.mjs` — `ORDER` 에 `'backtest.mjs'` (`'trend.mjs'` 다음)
- Modify: `.github/workflows/test.yml` — 주석과 스위트 목록

**Interfaces:**
- Consumes: Task 1~3 의 모든 함수
- Produces: `trendCheck(symbol, closes, times, { domestic, cost, rotations?, paths? })` → `null` | `{ error: 'data' }` | `{ cut, rule: { start, strat, hold, on, since, from, to, pct, verdict, nullMdd, count }, fast: { entries, trades, total }, regime }` — `rule` 에는 `want` 가 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — Edit 도구로 6절 끝 뒤에 넣는다.

```js
// --- 7. 같은 결과 · 마지막 봉 · 속도 --------------------------------------------
{
  const w = walk(6);
  const opts = { domestic: true, cost: 0.0025 };
  const a = B.trendCheck('005930.KS', w.c, w.t, opts);
  const b = B.trendCheck('005930.KS', w.c, w.t, opts);
  check('같은 종목 · 같은 데이터면 같은 결과', JSON.stringify(a) === JSON.stringify(b));

  const p1 = B.altPath(w.c, B.mulberry32(B.seedOf('005930.KS')));
  const p2 = B.altPath(w.c, B.mulberry32(B.seedOf('000660.KS')));
  check('다른 종목은 다른 가짜 주가', p1.some((v, i) => v !== p2[i]));
  check('가짜 주가의 첫 종가는 실제와 같다', p1[0] === w.c[0]);

  const moved = { c: [...w.c.slice(0, -1), last(w.c) * 1.25], t: w.t };
  check('마지막 봉을 바꿔도 결과가 같다',
    JSON.stringify(B.trendCheck('005930.KS', moved.c, moved.t, opts)) === JSON.stringify(a));
  check('결과에 판단 배열을 싣지 않는다 (캐시가 가볍게)', a.rule.want === undefined);

  const t0 = performance.now();
  B.trendCheck('000660.KS', w.c, w.t, opts);
  const ms = performance.now() - t0;
  check('1,230봉 한 종목이 200ms 안 (실측 약 55ms)', ms < 200, `${ms.toFixed(0)}ms`);
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `TypeError: B.trendCheck is not a function` 로 죽는다.

- [ ] **Step 3: 구현한다** — `regimeStats` 뒤에 넣고, 내보내기 블록을 최종 모양으로 바꾼다.

```js
// 화면이 쓸 값을 한 번에. null 이면 줄을 숨기고, { error: 'data' } 면 "데이터 확인 필요".
function trendCheck(symbol, closes, times, opts) {
  const s = usableSeries(closes, times, opts.domestic);
  if (!s || s.error) return s;
  const bt = ruleBacktest(s.closes, s.times, 20, 60, opts.cost);
  const verdict = rotationVerdict(s.closes, bt, opts.cost, opts.rotations);
  const fast = ruleBacktest(s.closes, s.times, 5, 20, opts.cost);
  const regime = regimeStats(s.closes, s.times, opts.cost, mulberry32(seedOf(symbol)), opts.paths);
  const { want, ...rule } = bt;
  return {
    cut: s.cut,
    rule: { ...rule, ...verdict },
    fast: { entries: fast.strat.entries, trades: fast.strat.trades, total: fast.strat.total },
    regime,
  };
}
if (typeof module !== 'undefined') {
  module.exports = {
    BT_MIN_BARS, BT_JUMP, BT_START, BT_ROTATIONS, BT_ROT_EDGE, BT_ROT_GAP, BT_PATHS, BT_MIN_PATHS, BT_BLOCK, BT_H,
    BT_MIN_ENTRIES, BT_MIN_EPISODES, BT_MIN_DAYS, BT_REGIME_START,
    seedOf, mulberry32, median, usableSeries, equityOf, holdOf, ruleBacktest, rotationVerdict,
    maRegime, cellStats, altPath, regimeStats, trendCheck,
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --check backtest.js && TZ=Asia/Seoul node tests/backtest.mjs`
Expected: `1,230봉 한 종목이 200ms 안 (실측 약 55ms)  4xms` 처럼 200 미만, `PASS: 실패 0건`.

- [ ] **Step 5: 실행 목록에 넣는다** — Edit 도구로.

`tests/run.mjs` 의 `ORDER`:
```js
  'trend.mjs',
  'backtest.mjs',
  'cross.mjs',
```

`.github/workflows/test.yml` 주석 첫 줄들:
```yaml
# 이 열세 개는 Node 내장 모듈과 앱 파일(indicators.js · backtest.js · quote-session.cjs ·
# renderer.js · index.html · main.js)만 쓴다. node_modules 가 필요 없어서 설치 단계가
# 없고, 전부 합쳐 N초 안에 끝난다.
```
`N` 은 Step 6 에서 잰 값을 올림해 쓴다. 스위트 목록 줄:
```yaml
          for f in rsi cross candle zoom trend backtest quote-session session-ui dom-contract state-contract net-timeout single-instance index-main; do
```

- [ ] **Step 6: CI 목록 전체 시간을 잰다**

Run: `cd C:/Users/혜성/Desktop/project/stock-widget-v1 && time (for f in rsi cross candle zoom trend backtest quote-session session-ui dom-contract state-contract net-timeout single-instance index-main; do TZ=Asia/Seoul node "tests/$f.mjs" > /dev/null || echo "FAIL $f"; done)`
Expected: `FAIL` 줄 없음. `real` 값을 Step 5 의 `N` 과 Task 6 의 DEVELOPMENT.md 에 쓴다. (이 시점에는 session-ui · dom-contract 가 아직 새 줄을 모르므로 둘 다 통과해야 한다.)

---

### Task 5: 화면 — `#trendCheck` 줄 · 툴팁 · 캐시

**Files:**
- Modify: `index.html` — `.w52` CSS 뒤, `#w52` 마크업 뒤, `<script src="./indicators.js">` 뒤
- Modify: `renderer.js` — `const dailyCache = {};` 줄 뒤(프렐류드), `renderDetail` 의 `renderW52(...)` 줄 뒤, `renderW52` 함수 뒤
- Modify: `tests/session-ui.mjs` — import, 하네스 `Object.assign`, `renderDetail` 을 쓰는 두 테스트의 스텁, 끝에 세 묶음
- Modify: `tests/dom-contract.mjs` — 끝에 스크립트 순서 · 줄 위치 · CSS 검사

**Interfaces:**
- Consumes: `trendCheck` (전역, backtest.js), `dailyCache`, `isDomestic`, `isIndex`, `daysAgo`, `UP`, `DOWN`
- Produces (renderer 전역): `trendCache` (`symbol -> { key, result }`), `renderTrendCheck(item)`, `costOf(symbol)`, `verdictText(v)`, `trendCheckText(r)`, `trendCheckTip(r, symbol)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/session-ui.mjs` — Edit 도구로 다섯 군데.

1) import 뒤:
```js
import * as indicators from '../indicators.js';
import * as backtest from '../backtest.js';
```
2) 하네스:
```js
  Object.assign(c, indicators, backtest, {
```
3) `renderDetail` 을 쓰는 두 테스트("selected detail updates header …", "index detail: points with two decimals …")의 스텁 줄을 둘 다 바꾼다:
```js
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
```
4) 파일 마지막 줄(`PASS: … session UI test groups` 를 찍는 `console.log`) 바로 앞에:
```js
// 추세 점검 줄 — 계산은 backtest.js(tests/backtest.mjs), 여기서는 그리기 · 캐시 · 숨김만 본다.
// 결과 모양을 고정하려고 trendCheck 를 바꿔 끼운다. 마지막 묶음만 진짜 계산을 돌린다.
const TREND = () => ({
  cut: false,
  rule: { start: 59, strat: { total: 0.41, cagr: 0.074, mdd: 0.18, entries: 12, trades: 24, inShare: 0.52 },
    hold: { total: 0.63, cagr: 0.108, mdd: 0.39 }, on: true, since: Date.parse('2026-08-07T00:00:00Z'),
    from: Date.parse('2022-01-04T00:00:00Z'), to: Date.parse('2026-09-09T00:00:00Z'),
    pct: 0.62, verdict: 'same', nullMdd: 0.21, count: 200 },
  fast: { entries: 41, trades: 82, total: 0.12 },
  regime: { cls: 'up', up: true, at: Date.parse('2026-09-09T00:00:00Z'), fallback: false, count: 1000,
    days: 214, episodes: 9, windows: 10, med: 0.021, rise: 0.61, allMed: 0.008, allRise: 0.53, diff: 0.013,
    halves: [0.01, 0.02], verdict: 'same', lo: -0.044, hi: 0.036, paths: 200 },
});
const trendDaily = (n) => ({ closes: Array.from({ length: n }, (_, i) => 100 * 1.002 ** i),
  times: Array.from({ length: n }, (_, i) => Date.parse('2024-01-01T00:00:00Z') + i * 86400000) });

await test('trend check: one line + tooltip, verdict colour, hidden without data', () => {
  const { c, run, elements } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  let result = TREND();
  c.trendCheck = () => result;

  c.renderTrendCheck(null);
  assert.equal(el.hidden, true, '선택 없음');
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, true, '일봉을 아직 못 받음');

  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false);
  // 08-07 09:00 KST → 09-10 (하네스 시각) = 34일
  assert.equal(el.innerHTML, '정배열·20선↑ · 20/60 보유 34일째 · 5년: <span>구분 안 됨</span>');
  const tip = el.title.split('\n');
  for (const line of [
    '20/60 규칙 — 20일선이 60일선 위면 보유, 아래면 정리',
    '종가로 판단 → 다음 날 종가에 체결 · 왕복 비용 0.25%',
    '기간 2022-01-04 ~ 2026-09-09',
    '규칙: 누적 +41.0% · 연 +7.4% · 최대 낙폭 -18.0% · 보유 52%',
    '그냥 보유: 누적 +63.0% · 연 +10.8% · 최대 낙폭 -39.0%',
    '시점만 밀어 만든 가짜 타이밍 200개 중 상위 38% → 구분 안 됨',
    '가짜 타이밍의 최대 낙폭 중앙값 -21.0% (낙폭이 작은 건 덜 들고 있어서일 수 있음)',
    '진입 12회',
    '5/20 같은 규칙: 진입 41회 · 비용 합계 약 10% · 누적 +12.0%',
    '지금: 정배열(5>20>60>120) · 20일선 상승 — 09/09 종가 기준',
    '같은 상태였던 날 214일 (9구간 · 겹치지 않는 20일 묶음 10개)',
    '20거래일 뒤 중앙값 +2.1% · 오른 비율 61% (다음 날 종가 매수, 비용 차감)',
    '평소: +0.8% · 53% → 차이 +1.3%p',
    '가짜 주가 200개의 차이 범위 -4.4%p ~ +3.6%p 안 → 구분 안 됨',
  ]) assert.ok(tip.includes(line), `툴팁에 "${line}"`);
  assert.equal(tip.at(-1), '배당·세금·환전 제외 · 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽습니다 · 과거 통계이며 매매 권유가 아닙니다');

  // 판정 색 — 나음 빨강(UP), 못함 파랑(DOWN). 새 결과를 보려면 캐시를 비운다.
  const redraw = (patch) => {
    result = TREND(); patch(result);
    run("delete trendCache['005930.KS'];");
    c.renderTrendCheck({ symbol: '005930.KS' });
    return el;
  };
  assert.match(redraw((r) => { r.rule.verdict = 'better'; r.rule.pct = 0.995; }).innerHTML,
    /5년: <span style="color:#e24b4a">나음<\/span>$/);
  assert.match(redraw((r) => { r.rule.verdict = 'worse'; r.rule.pct = 0.004; }).innerHTML,
    /5년: <span style="color:#185fa5">못함<\/span>$/);
  assert.ok(el.title.includes('시점만 밀어 만든 가짜 타이밍 200개 중 상위 100% → 못함'));
  assert.ok(redraw((r) => { r.rule.verdict = 'better'; r.rule.pct = 1; }).title.includes('상위 1% 안 → 나음'));

  // 표본 부족 · 칸 넓히기 · 범위 밖인데 구분 안 됨
  redraw((r) => { r.rule.verdict = 'few'; r.rule.strat.entries = 4; r.rule.on = false; });
  assert.equal(el.innerHTML, '정배열·20선↑ · 20/60 정리 34일째 · 5년: <span>표본 부족</span>');
  assert.ok(el.title.includes('진입 4회 — 적어서 판정하지 않음'));
  assert.ok(!el.title.includes('가짜 타이밍'));
  redraw((r) => { r.regime.verdict = 'few'; r.regime.fallback = true; r.regime.cls = 'mixDown'; r.regime.up = false; });
  assert.ok(el.innerHTML.startsWith('혼조·20선↓ · '));
  assert.ok(el.title.includes('지금: 혼조(20일선이 60일선 아래) · 20일선 하락 — 09/09 종가 기준'));
  assert.ok(el.title.includes('같은 배열·방향인 날이 적어 배열만으로 봄'));
  assert.ok(el.title.includes('같은 상태였던 날이 적어 판정하지 않음'));
  assert.ok(!el.title.includes('평소:'));
  redraw((r) => { r.regime.diff = 0.05; });
  assert.ok(el.title.includes('밖 → 구분 안 됨 (앞·뒤 절반의 방향이 달라)'));

  // 짧은 종목은 숨기고, 이상 봉은 말한다
  assert.equal(redraw(() => {}).hidden, false);
  result = null; run("delete trendCache['005930.KS'];"); c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, true, '500봉 미만');
  result = { error: 'data' }; run("delete trendCache['005930.KS'];"); c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, '추세 점검: 데이터 확인 필요');
  assert.match(el.title, /30% 넘게/);
});

await test('trend check: recomputes only when the last confirmed bar changes; cost by market', () => {
  const { c, run } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  const calls = [];
  c.trendCheck = (symbol, closes, times, opts) => { calls.push({ symbol, n: closes.length, opts }); return TREND(); };
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  c.renderTrendCheck({ symbol: '005930.KS' }); // 30초 갱신
  run("dailyCache['005930.KS'].closes[599] *= 1.01;"); // 장중에는 마지막 봉만 움직인다
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(calls.length, 1, '마지막 확정 봉이 그대로면 다시 계산하지 않는다');
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(601))};`); // 다음 날 봉이 하나 늘었다
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(calls.length, 2);
  assert.deepEqual({ ...calls[0].opts }, { domestic: true, cost: 0.0025 });

  run(`dailyCache['^KS11'] = ${JSON.stringify(trendDaily(600))}; dailyCache['AAPL'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '^KS11' });
  assert.deepEqual({ ...calls.at(-1).opts }, { domestic: false, cost: 0.001 });
  assert.ok(el.title.includes('왕복 비용 0.10% (지수는 ETF 로 따라간다고 봄)'));
  c.renderTrendCheck({ symbol: 'AAPL' });
  assert.deepEqual({ ...calls.at(-1).opts }, { domestic: false, cost: 0.001 });
  assert.ok(el.title.includes('왕복 비용 0.10%') && !el.title.includes('지수는'));
});

await test('trend check: real backtest on a steady climb says 정배열 and 표본 부족', () => {
  const { run, c } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  const el = c.document.getElementById('trendCheck');
  // 오르기만 하면 진입이 1회라 판정하지 않는다. 일수는 데이터 끝(2025-08-23)부터 하네스 시각까지.
  assert.match(el.innerHTML, /^정배열·20선↑ · 20\/60 보유 \d+일째 · 5년: <span>표본 부족<\/span>$/);
  assert.ok(el.title.includes('진입 1회 — 적어서 판정하지 않음'));
});
```

`tests/dom-contract.mjs` — 마지막 `console.log(…PASS…)` 앞에:
```js
// backtest.js 는 indicators.js 의 sma 를 전역으로 쓰고, renderer.js 가 trendCheck 를 부른다.
const backtestTag = html.indexOf('src="./backtest.js"');
check('index.html 이 backtest.js 를 싣는다', backtestTag >= 0);
if (backtestTag >= 0 && indicatorsTag >= 0 && rendererTag >= 0) {
  check('backtest.js 가 indicators.js 뒤, renderer.js 앞에 온다',
    indicatorsTag < backtestTag && backtestTag < rendererTag);
}

// --- 추세 점검 줄 ----------------------------------------------------------------
// 52주 줄과 차트 사이. 차트 아래로 가면 관심종목 목록과 붙어 종목 정보로 읽히지 않는다.
const w52Tag = html.indexOf('id="w52"');
const trendTag = html.indexOf('id="trendCheck"');
const chartTag = html.indexOf('class="chartbox"');
check('#trendCheck 가 있다', trendTag >= 0);
check('#trendCheck 는 52주 줄과 차트 사이에 있다', w52Tag >= 0 && w52Tag < trendTag && trendTag < chartTag);
const trendCss = /\.trendchk\s*\{([^}]*)\}/.exec(html);
check('.trendchk 는 한 줄로 자르고 말줄임한다 (줄이 늘면 차트가 밀린다)',
  !!trendCss && /white-space:\s*nowrap/.test(trendCss[1]) && /text-overflow:\s*ellipsis/.test(trendCss[1]));
```

- [ ] **Step 2: 실패를 확인한다**

Run: `TZ=Asia/Seoul node tests/session-ui.mjs; TZ=Asia/Seoul node tests/dom-contract.mjs`
Expected: session-ui 는 `renderer function renderTrendCheck exists` 로 죽는다. dom-contract 는 `FAIL index.html 이 backtest.js 를 싣는다`, `FAIL #trendCheck 가 있다` 등.

- [ ] **Step 3: index.html** — Edit 도구로 세 군데.

`.w52 .w52bar i { … }` 규칙 뒤, `/* 창을 세로로 늘리면 차트도 같이 커진다.` 주석 앞:
```css
  /* 추세 점검 한 줄. 넘치면 말줄임 — 줄이 늘면 차트가 밀린다 */
  .trendchk { margin-top: 6px; font-size: 9px; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trendchk[hidden] { display: none; }

```
`#w52` 의 닫는 `</div>` 뒤:
```html

      <!-- 추세 점검 — 이평선 규칙을 지난 5년 일봉에 대 본 결과. 자세한 숫자는 툴팁 -->
      <div class="trendchk" id="trendCheck" hidden></div>
```
`<script src="./indicators.js"></script>` 뒤:
```html
  <!-- 추세 점검 계산. indicators.js 의 sma 를 쓰고, renderer.js 가 trendCheck 를 부른다 -->
  <script src="./backtest.js"></script>
```

- [ ] **Step 4: renderer.js** — Edit 도구로 세 군데.

프렐류드, `const dailyCache = {}; // symbol -> …` 줄 바로 뒤 (`'// 과열도 5단계'` 마커 앞이라 하네스가 읽는다):
```js
// 추세 점검 결과 — symbol -> { key, result }. 5년치를 수백 번 다시 돌리는 계산이라(종목당 약 50ms)
// 30초 갱신마다 하지 않고, 계산에 쓰는 마지막 확정 봉이 바뀔 때만 다시 한다(renderTrendCheck).
const trendCache = {};
```
`renderDetail` 안, `renderW52(q && q.week52Low, …);` 줄 바로 뒤:
```js
  renderTrendCheck(item);
```
`renderW52` 함수 뒤, `// 선택 구간의 수익률 배지.` 주석 앞:
```js
// 추세 점검 — 이평선 규칙을 지난 5년 일봉에 대 본 결과(backtest.js). 기간 탭과 상관없이
// 선택한 종목의 일봉 원본(dailyCache)으로 계산한다. quotes[].daily 는 마지막 봉을 현재가로
// 덮은 사본이라 쓰지 않는다. 계산에 쓰는 마지막 확정 봉(끝에서 두 번째)이 바뀔 때만 다시 계산한다.
function renderTrendCheck(item) {
  const el = document.getElementById('trendCheck');
  const d = item && dailyCache[item.symbol];
  if (!d || !d.closes) { el.hidden = true; return; }
  const n = d.closes.length;
  const key = `${n}:${d.times[n - 2]}`;
  let hit = trendCache[item.symbol];
  if (!hit || hit.key !== key) {
    hit = { key, result: trendCheck(item.symbol, d.closes, d.times,
      { domestic: isDomestic(item.symbol), cost: costOf(item.symbol) }) };
    trendCache[item.symbol] = hit;
  }
  const r = hit.result;
  el.hidden = !r;
  if (!r) return;
  if (r.error) {
    el.textContent = '추세 점검: 데이터 확인 필요';
    el.title = '하루에 30% 넘게 움직인 봉이 있습니다. 국내 가격제한폭 밖이라 액면분할 같은 데이터 이상으로 보고\n'
      + '그 뒤만 쓰려 했지만 2년(500봉)이 남지 않아 계산하지 않았습니다.';
    return;
  }
  el.innerHTML = trendCheckText(r);
  el.title = trendCheckTip(r, item.symbol);
}

// 추세 점검의 왕복 비용. 국내 종목은 매도세가 붙어 0.25%, 해외 종목과 지수(ETF 로 따라간다고 본다)는 0.10%.
function costOf(symbol) {
  return isDomestic(symbol) ? 0.0025 : 0.001;
}

function verdictText(v) {
  return { better: '나음', worse: '못함', same: '구분 안 됨', few: '표본 부족' }[v];
}

// 줄 한 줄. 판정 조각만 색을 입힌다 — 나음 빨강, 못함 파랑, 나머지는 줄 색(회색) 그대로.
// 글자는 전부 이 함수가 만든 고정 문구라 innerHTML 로 넣어도 된다.
function trendCheckText(r) {
  const g = r.regime;
  const v = r.rule.verdict;
  const color = v === 'better' ? UP : v === 'worse' ? DOWN : '';
  const regime = `${g.cls === 'up' ? '정배열' : g.cls === 'down' ? '역배열' : '혼조'}·20선${g.up ? '↑' : '↓'}`;
  const state = `20/60 ${r.rule.on ? '보유' : '정리'} ${daysAgo(r.rule.since)}일째`;
  return `${regime} · ${state} · 5년: <span${color ? ` style="color:${color}"` : ''}>${verdictText(v)}</span>`;
}

// 툴팁. 모든 숫자를 비교 대상(그냥 보유 · 평소)과 우연의 범위(가짜 타이밍 · 가짜 주가) 옆에 둔다.
function trendCheckTip(r, symbol) {
  const p = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  const pp = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%p';
  const ymd = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const { rule, fast, regime: g } = r;
  const cost = costOf(symbol);
  const lines = [
    '20/60 규칙 — 20일선이 60일선 위면 보유, 아래면 정리',
    `종가로 판단 → 다음 날 종가에 체결 · 왕복 비용 ${(cost * 100).toFixed(2)}%${isIndex(symbol) ? ' (지수는 ETF 로 따라간다고 봄)' : ''}`,
    `기간 ${ymd(rule.from)} ~ ${ymd(rule.to)}${r.cut ? ' (하루 30% 넘게 움직인 봉 뒤부터)' : ''}`,
    `규칙: 누적 ${p(rule.strat.total)} · 연 ${p(rule.strat.cagr)} · 최대 낙폭 ${p(-rule.strat.mdd)} · 보유 ${Math.round(rule.strat.inShare * 100)}%`,
    `그냥 보유: 누적 ${p(rule.hold.total)} · 연 ${p(rule.hold.cagr)} · 최대 낙폭 ${p(-rule.hold.mdd)}`,
  ];
  if (rule.verdict === 'few') {
    lines.push(`진입 ${rule.strat.entries}회 — 적어서 판정하지 않음`);
  } else {
    const top = Math.round((1 - rule.pct) * 100);
    lines.push(
      `시점만 밀어 만든 가짜 타이밍 ${rule.count}개 중 상위 ${top < 1 ? '1% 안' : `${top}%`} → ${verdictText(rule.verdict)}`,
      `가짜 타이밍의 최대 낙폭 중앙값 ${p(-rule.nullMdd)} (낙폭이 작은 건 덜 들고 있어서일 수 있음)`,
      `진입 ${rule.strat.entries}회`,
    );
  }
  lines.push(`5/20 같은 규칙: 진입 ${fast.entries}회 · 비용 합계 약 ${(fast.trades * cost * 50).toFixed(0)}% · 누적 ${p(fast.total)}`, '');

  const cls = { up: '정배열(5>20>60>120)', down: '역배열(5<20<60<120)',
    mixUp: '혼조(20일선이 60일선 위)', mixDown: '혼조(20일선이 60일선 아래)' }[g.cls];
  lines.push(`지금: ${cls} · 20일선 ${g.up ? '상승' : '하락'} — ${ymd(g.at).slice(5).replace('-', '/')} 종가 기준`);
  if (g.fallback) lines.push('같은 배열·방향인 날이 적어 배열만으로 봄');
  if (g.verdict === 'few') {
    lines.push('같은 상태였던 날이 적어 판정하지 않음');
  } else {
    const out = g.lo != null && (g.diff < g.lo || g.diff > g.hi);
    lines.push(
      `같은 상태였던 날 ${g.days}일 (${g.episodes}구간 · 겹치지 않는 20일 묶음 ${g.windows}개)`,
      `20거래일 뒤 중앙값 ${p(g.med)} · 오른 비율 ${Math.round(g.rise * 100)}% (다음 날 종가 매수, 비용 차감)`,
      `평소: ${p(g.allMed)} · ${Math.round(g.allRise * 100)}% → 차이 ${pp(g.diff)}`,
      g.lo == null ? '가짜 주가가 모자라 판정하지 않음'
        : `가짜 주가 ${g.paths}개의 차이 범위 ${pp(g.lo)} ~ ${pp(g.hi)} ${out ? '밖' : '안'} → ${verdictText(g.verdict)}`
          + (out && g.verdict === 'same' ? ' (앞·뒤 절반의 방향이 달라)' : ''),
    );
  }
  lines.push('', '배당·세금·환전 제외 · 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽습니다 · 과거 통계이며 매매 권유가 아닙니다');
  return lines.join('\n');
}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `node --check renderer.js && TZ=Asia/Seoul node tests/session-ui.mjs && TZ=Asia/Seoul node tests/dom-contract.mjs`
Expected: `PASS: 45 session UI test groups`, dom-contract `PASS: 실패 0건`.

- [ ] **Step 6: 변이 확인** — 스크래치 사본의 renderer.js 에서 하나씩: 캐시 키를 `` `${n}:${d.closes[n - 1]}` `` 로(30초 갱신 검사가 깨져야 한다), `costOf` 를 늘 `0.0025` 로(지수 · 해외 검사가 깨져야 한다), `trendCheckText` 의 `UP` · `DOWN` 을 맞바꿔(색 검사가 깨져야 한다).

---

### Task 6: 문서 — README · DEVELOPMENT.md

**Files:**
- Modify: `README.md` — "무엇을 할 수 있나요" 목록, "### 배지" 절과 "### 차트" 절 사이
- Modify: `docs/DEVELOPMENT.md` — 파일 구조, CI 절, 끝에 "### 추세 점검"

- [ ] **Step 1: README** — Edit 도구로.

"무엇을 할 수 있나요" 의 `- 이동평균선 · 거래량 · 추세선 · 과열도 같은 보조 지표를 차트에 얹습니다` 줄 뒤:
```markdown
- 이동평균선 규칙을 지난 5년에 대 본 **추세 점검**을 보여 줍니다 (과거 통계이며 매매 권유가 아닙니다)
```

`### 차트` 바로 앞(과열도 RSI 표 다음):
```markdown
### 추세 점검

52주 막대 아래의 한 줄은 **이동평균선 규칙을 지난 5년 일봉에 대 본 결과**입니다. 기간 버튼과 상관없이 같은 값이 나옵니다.

`정배열·20선↑ · 20/60 보유 34일째 · 5년: 구분 안 됨`

| 조각 | 뜻 |
|---|---|
| `정배열·20선↑` | 지금 이동평균선의 배열(정배열 5>20>60>120 · 역배열 · 혼조)과 20일선이 오르는지 |
| `20/60 보유 34일째` | "20일선이 60일선 위면 보유, 아래면 정리" 규칙으로는 지금 보유(또는 정리)이고, 그렇게 된 지 34일 |
| `5년: 구분 안 됨` | 그 규칙이 지난 5년 동안 **시점만 엉뚱하게 바꾼 가짜 규칙 200개**보다 나았는지 |

판정은 `나음`(빨강) · `못함`(파랑) · `구분 안 됨` · `표본 부족` 입니다. 한 종목 5년치로는 대부분 **구분 안 됨**이 나오는 게 정상입니다 — "효과 없음"이 아니라 "이 표본으로는 알 수 없다"는 뜻입니다.

마우스를 올리면 자세한 숫자가 나옵니다. 규칙과 그냥 보유의 누적 · 연 수익 · 최대 낙폭, 그리고 지금과 같은 배열이었던 날들의 20거래일 뒤 수익을 평소와 견준 값입니다.

- 그날 종가로 판단하고 **다음 날 종가에 사고판다**고 계산합니다. 오늘 봉은 넣지 않습니다.
- 비용은 국내 종목 왕복 0.25%, 해외 종목 · 지수 0.10% 를 뺍니다. 배당 · 세금 · 환전은 빠져 있습니다.
- 상장한 지 2년이 안 된 종목은 이 줄이 나오지 않습니다.
- 관심종목은 이미 고른(대개 오른) 종목이라 결과가 좋게 나오기 쉽습니다. **과거 통계이며 매매 권유가 아닙니다.**

```

- [ ] **Step 2: DEVELOPMENT.md** — Edit 도구로 세 군데.

파일 구조 블록의 `indicators.js` 줄 뒤:
```
backtest.js           추세 점검 — 이평선 규칙을 지난 일봉에 대 보는 계산 (화면과 무관)
```

CI 절 — 두 문단을 이렇게 바꾼다(`N` 은 Task 4 Step 6 에서 잰 값):
```markdown
푸시와 PR 마다 **앱을 띄우지 않는 열세 개**가 GitHub Actions 에서 돕니다 — `rsi` · `cross` · `candle` · `zoom` · `trend` · `backtest` · `quote-session` · `session-ui` · `dom-contract` · `state-contract` · `net-timeout` · `single-instance` · `index-main`.

이 열세 개는 Node 내장 모듈과 앱 파일(`indicators.js` · `backtest.js` · `quote-session.cjs` · `renderer.js` · `index.html` · `main.js`)만 씁니다. **`node_modules` 가 필요 없어 설치 단계가 없고 N초 안에 끝납니다.** 계산 로직을 옮기거나 고칠 때 회귀를 바로 잡으라고 둔 것입니다. 가장 오래 걸리는 것은 `backtest` 입니다 — 판정이 우연을 "나음"으로 말하지 않는지 무작위 주가 수백 개로 확인합니다.
```

파일 끝(`### RSI 과열도` 절 뒤):
```markdown
### 추세 점검

52주 줄 아래 한 줄(`#trendCheck`)과 툴팁입니다. 계산은 `backtest.js`, 그리기는 `renderTrendCheck` 입니다. 설계와 결정 배경은 `docs/superpowers/specs/2026-10-12-ma-backtest-design.md` 에 있습니다.

**무엇을 계산하나**
- **20/60 규칙** — 20일선이 60일선 위면 보유, 아래면 정리. 누적 · 연 수익 · 최대 낙폭 · 보유 비율을 그냥 보유와 나란히 보입니다. 5/20 은 진입 횟수 · 비용 합계 · 누적 한 줄만 보입니다.
- **이평 배열 국면** — 5·20·60·120일선 배열 4가지 × 20일선 방향 2가지 = 8칸. 오늘과 같은 칸이었던 날들의 20거래일 뒤 수익 중앙값을 모든 날과 견줍니다. 칸에 구간이 8개 미만이거나 60일 미만이면 방향을 빼고 배열만으로 봅니다.

**미래 값을 쓰지 않습니다**
- 마지막 봉은 늘 뺍니다. 장중에는 그 종가가 계속 움직입니다 — 골든 · 데드 배지(`confirmedCrosses`)와 같은 이유이고, 대가도 같아서 하루 늦게 반영됩니다.
- 종가 t 로 판단하고 **종가 t+1 에 체결**합니다. 판단한 날 종가에 체결하면 이미 알고 있는 그날 움직임을 먹습니다.
- `quotes[].daily` 가 아니라 `dailyCache` 원본을 씁니다. `loadQuote` 가 마지막 봉을 현재가로 덮거나 오늘 봉을 덧붙인 사본이기 때문입니다.

**우연과 비교합니다**
- 그냥 보유와 바로 판정하지 않습니다. 덜 들고 있는 규칙은 오르는 종목에서 수익이 낮고 낙폭이 작은 게 당연해서입니다.
- 20/60 은 **판단 열을 62칸 이상 돌린 가짜 타이밍 200개**와 견줍니다. 보유 비율과 매매 횟수는 그대로이고 시점만 엉뚱해집니다. 20일선 − 60일선은 최근 59일 등락으로만 정해지므로 62칸보다 덜 돌리면 가짜 규칙이 자기 구간 등락을 미리 봅니다.
- 판정 끝은 **1%** 입니다. 돌린 200개는 이웃끼리 거의 같아 독립인 비교가 20개 남짓이라, 2.5% 로 두면 무작위 걸음 600개 중 7.5% 가 나음/못함으로 걸렸습니다. 1% 에서 5% 였습니다(2026-10-12 실측).
- 배열 국면은 **하루하루 등락을 평균 10일 덩어리로 섞은 가짜 주가 200개**에서 이평선부터 다시 계산한 차이와 견줍니다. 양쪽 2.5% 밖이면서 앞 · 뒤 절반의 차이 방향이 같을 때만 판정합니다. 무작위 걸음 180개에서 10개(5.6%)가 걸렸습니다.
- 난수는 종목 코드로 시드를 정해(FNV-1a → mulberry32) 볼 때마다 같은 결과가 나옵니다.

**표본**
- 확정 봉 500개(약 2년) 미만이면 계산하지 않습니다. 국내 종목에 하루 ±30% 를 넘는 봉이 있으면 액면분할 같은 데이터 이상으로 보고 그 뒤만 씁니다. 그 뒤로 500개가 안 되면 "데이터 확인 필요" 입니다.
- 진입 5회 미만이면 표본 부족입니다. 5년에 20/60 진입은 보통 10~15회라 승률은 보이지 않습니다.
- 배열 국면 툴팁에는 일수와 함께 "겹치지 않는 20일 묶음 수" 를 적습니다. 214일이라도 서로 독립인 경험은 10번 정도입니다.

**비용과 계산 시점**
- 왕복 비용은 국내 종목 0.25%(매도세 포함), 해외 종목 · 지수 0.10%(지수는 ETF 로 따라간다고 봄). 배당 · 세금 · 환전은 넣지 않습니다.
- 한 종목에 약 50ms 입니다(1,231봉, 2026-10-12 실측). 선택한 종목만, `trendCache` 에 (봉 수, 끝에서 두 번째 봉 시각)으로 캐시해 마지막 확정 봉이 바뀔 때만 다시 계산합니다. 30초 갱신 · 일봉 재수신은 마지막 봉만 움직이므로 다시 계산하지 않습니다.
```

- [ ] **Step 3: 확인한다** — README 표가 깨지지 않았는지, DEVELOPMENT.md 의 `N` 자리를 실측값으로 바꿨는지 Read 도구로 본다.

---

### Task 7: 마무리 검증

- [ ] **Step 1: 문법 · 앱을 띄우지 않는 스위트 14개**

Run: `cd C:/Users/혜성/Desktop/project/stock-widget-v1 && node --check backtest.js && node --check renderer.js && node --check indicators.js && for f in isolation rsi cross candle zoom trend backtest quote-session session-ui dom-contract state-contract net-timeout single-instance index-main; do TZ=Asia/Seoul node "tests/$f.mjs" > /dev/null && echo "ok $f" || echo "FAIL $f"; done`
Expected: `ok` 14줄, `FAIL` 없음.

- [ ] **Step 2: 줄 끝 · 역슬래시 확인**

Run: `git ls-files --eol renderer.js index.html tests/session-ui.mjs tests/dom-contract.mjs tests/run.mjs docs/DEVELOPMENT.md README.md .github/workflows/test.yml && grep -c "join('.n')" renderer.js`
Expected: 기존 파일은 그대로 `w/crlf`. `renderer.js` 에 `join('\n')` 이 1개 (역슬래시가 줄바꿈 문자로 바뀌지 않았다).

- [ ] **Step 3: 사용자에게 넘긴다** — 커밋하지 않고 결과를 보고한다. 사용자가 앱에서 볼 것:
  - 삼성전자 · 미국 종목 · 코스피를 차례로 눌러 줄과 툴팁이 나오는지, 문구가 340px 폭에서 말줄임되는지.
  - 상장 2년 미만 종목에서 줄이 숨는지.
  - 다크 · 라이트 테마에서 판정 색이 읽히는지.
  - 종목을 처음 누를 때 멈칫함이 느껴지지 않는지(약 50ms).
