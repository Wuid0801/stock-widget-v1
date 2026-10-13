// backtest.js — 이평선 규칙을 지난 일봉에 대 보는 계산("추세 점검"). 화면과 무관하다.
// 화면에서는 index.html 이 indicators.js 다음에 <script> 로 읽어 전역 sma 를 쓰고,
// Node(테스트)에서는 아래 require 로 가져온다.
const btSma = typeof module !== 'undefined' ? require('./indicators.js').sma : sma;

const BT_MIN_BARS = 500;    // 쓸 수 있는 확정 봉이 이보다 적으면(상장 2년 미만) 계산하지 않는다
// 국내 가격제한폭은 ±30% 지만 문턱은 35% 다. 진짜 상한가 · 하한가 날이 30% 를 조금 넘게 나온다 —
// 정확히 +30% 도 부동소수로는 0.30000000000000004 이고, 야후 전일 종가가 기준가와 한 틱 달라 +30.2% 가
// 되기도 한다(에코프로비엠 2023-11-06, 한화오션 2024-11-08 실측). 이보다 크게 움직인 봉은 액면분할 ·
// 병합 · 큰 무상증자처럼 야후가 반영하지 않은 데이터 이상이다. 0.5주 무상증자(-33%)는 놓친다.
const BT_JUMP = 0.35;
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
// 국내 종목은 가격제한폭 밖으로(BT_JUMP 초과) 움직인 마지막 봉부터 쓴다.
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
