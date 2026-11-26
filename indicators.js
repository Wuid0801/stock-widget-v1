// indicators.js — 화면과 무관한 순수 계산.
//
// 브라우저에서는 클래식 스크립트다. index.html 이 렌더러(renderer/*.js)보다 먼저 싣고,
// 최상위 함수 선언이 전역이 되므로 렌더러는 그냥 이름으로 부른다.
// Node(테스트)에서는 CommonJS 로 읽혀 아래 module.exports 가 쓰인다.
//
// 여기에는 DOM · quotes · state · cssVar 를 건드리는 것을 두지 않는다.
// 그것이 이 파일을 테스트에서 통째로 import 할 수 있게 하는 조건이다.

// --- RSI(14), Wilder smoothing -----------------------------------------------
// 지금 RSI 는 봉마다의 RSI(rsiSeries)의 마지막 값 — 계산을 따로 두면 목록의 RSI 와 차트 RSI 선이 갈릴 수 있다.
function calcRSI(closes, period = 14) {
  return closes && closes.length > period ? rsiSeries(closes, period)[closes.length - 1] : null;
}

// 봉마다의 RSI(차트의 RSI 선) — i 번째 값은 처음부터 i 번째 봉까지로 센 RSI 다. 앞 period 봉은 null.
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const rsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = rsi();

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsi();
  }
  return out;
}

// RSI 시그널 — RSI 의 단순 평균. 앞쪽 빈 칸(null)은 건너뛰고 RSI 가 period 개 모인 봉부터.
function rsiSignal(rsi, period = 9) {
  const out = new Array(rsi.length).fill(null);
  const start = rsi.findIndex((v) => v != null);
  if (start < 0) return out;
  sma(rsi.slice(start), period).forEach((v, k) => { out[start + k] = v; });
  return out;
}

// RSI 칸 눈금 — 보이는 RSI · 시그널의 최저~최고에 위아래로 폭의 1/10 여유를 둔 { min, max }. 0~100 이면 RSI 가 대개
// 30~70 에서만 움직여 45px 칸에서 20px 남짓이라 꺾이는 곳이 안 보였다(2026-11-03). 폭은 적어도 RSI_MIN_SPAN — 거의 안
// 움직인 날 잔떨림이 큰 파도로 보이지 않게. 0~100 밖으로는 밀어 넣고, 거의 다 쓰면 0~100 이다.
// ticks 는 숫자를 적을 자리 — 30 · 70 만, 범위에 들 때만(사용자가 정함). 칸 끝(위아래 여유 안)에 붙으면 숫자가 가격 칸 ·
// 날짜 줄로 넘쳐 뺀다.
const RSI_MIN_SPAN = 20;
function rsiScale(values) {
  const v = values.filter((x) => x != null);
  if (!v.length) return { min: 0, max: 100, ticks: [30, 70] };
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = Math.max(hi - lo, RSI_MIN_SPAN);
  const pad = span / 10;
  const half = span / 2 + pad;
  if (half >= 50) return { min: 0, max: 100, ticks: [30, 70] };
  const mid = Math.min(Math.max((lo + hi) / 2, half), 100 - half);
  const min = mid - half;
  const max = mid + half;
  return { min, max, ticks: [30, 70].filter((t) => t >= min + pad && t <= max - pad) };
}

// --- 스토캐스틱 ---------------------------------------------------------------
// K = 최근 period 봉의 고가~저가에서 그 봉 종가의 자리(0~100), D = K 의 dPeriod 봉 평균. K 를 다시 평균하지 않는
// 14 · 1 · 3 이다(토스증권 값, 사용자 확인 2026-11-09). 앞 period - 1 봉은 null, 범위가 0(고가 = 저가)이면 50.
// 종가도 범위에 넣는다 — 오늘 봉처럼 종가와 고 · 저의 출처가 다르면 100 을 넘을 수 있다.
function stochSeries(highs, lows, closes, period = 14, dPeriod = 3) {
  const k = closes.map((c, i) => {
    if (i < period - 1 || !Number.isFinite(c)) return null;
    const hi = Math.max(c, ...highs.slice(i - period + 1, i + 1).filter(Number.isFinite));
    const lo = Math.min(c, ...lows.slice(i - period + 1, i + 1).filter(Number.isFinite));
    return hi > lo ? ((c - lo) / (hi - lo)) * 100 : 50;
  });
  return { k, d: rsiSignal(k, dPeriod) }; // rsiSignal = 앞 빈 칸을 건너뛴 단순 평균
}

// 단순이동평균. 구간이 모자라는 앞부분은 null (Chart.js가 알아서 비워 둔다)
function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 볼린저 밴드 — period 일 평균 ± k 표준편차(모집단 표준편차, 흔한 차트들과 같다). 앞부분은 null.
// 가운데 선은 같은 기간의 이동평균이라 따로 돌려주지 않는다(20일선 칩으로 켠다).
function bollinger(closes, period = 20, k = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / period);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { upper, lower };
}

// VWAP(거래량 가중 평균가) — 대표가 (고 + 저 + 종) / 3 를 거래량으로 가중해 처음부터 누적한다.
// use(i) 가 거짓인 봉(1D 시간외)은 계산에서 빼고 그 칸은 null 이다. 거래량 0 인 봉은 직전 값을 잇는다.
function vwap(highs, lows, closes, volumes, use = () => true) {
  const out = new Array(closes.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!use(i)) continue;
    const v = volumes[i] > 0 ? volumes[i] : 0;
    pv += ((highs[i] + lows[i] + closes[i]) / 3) * v;
    vol += v;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

// 파라볼릭 SAR(와일더). 상승 추세면 SAR 이 봉 아래에서, 하락 추세면 봉 위에서 극값(추세 중 최고 · 최저가)
// 쪽으로 따라온다 — 따라오는 속도(가속)는 극값이 갱신될 때마다 step 씩 max 까지 커진다. 봉이 SAR 을 뚫으면
// 방향이 바뀌고 SAR 은 직전 극값에서 다시 시작한다. SAR 은 앞 두 봉의 저가(상승) · 고가(하락)를 넘지 않는다.
// 첫 방향은 두 봉의 중간값으로 정한다. 돌려주는 값: { sar, up } — 봉마다 SAR 과 상승 추세인지, 첫 봉은 null.
function parabolicSar(highs, lows, step = 0.02, max = 0.2) {
  const n = highs.length;
  const sar = new Array(n).fill(null);
  const up = new Array(n).fill(null);
  if (n < 2) return { sar, up };
  let rising = highs[1] + lows[1] >= highs[0] + lows[0];
  let af = step;
  let ep = rising ? Math.max(highs[0], highs[1]) : Math.min(lows[0], lows[1]);
  let s = rising ? Math.min(lows[0], lows[1]) : Math.max(highs[0], highs[1]);
  sar[1] = s;
  up[1] = rising;
  for (let i = 2; i < n; i++) {
    let next = s + af * (ep - s);
    next = rising ? Math.min(next, lows[i - 1], lows[i - 2]) : Math.max(next, highs[i - 1], highs[i - 2]);
    if (rising ? lows[i] < next : highs[i] > next) {
      rising = !rising;
      next = ep;
      ep = rising ? highs[i] : lows[i];
      af = step;
    } else if (rising ? highs[i] > ep : lows[i] < ep) {
      ep = rising ? highs[i] : lows[i];
      af = Math.min(max, af + step);
    }
    s = next;
    sar[i] = s;
    up[i] = rising;
  }
  return { sar, up };
}

// 매물대(가격대별 거래량). from~to 봉의 거래량을 그 봉의 저가~고가에 고르게 나눠, 그 구간의 최저~최고가를
// bins 칸으로 나눈 칸에 쌓는다. vols 는 아래(낮은 가격) 칸부터, poc 는 가장 많이 쌓인 칸의 번호.
// 가격 폭이 없거나 거래량이 하나도 없으면 null.
function volumeProfile(highs, lows, volumes, from, to, bins = 20) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i <= to; i++) {
    if (lows[i] > 0) lo = Math.min(lo, lows[i]);
    if (highs[i] > 0) hi = Math.max(hi, highs[i]);
  }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vols = new Array(bins).fill(0);
  for (let i = from; i <= to; i++) {
    const v = volumes[i] > 0 ? volumes[i] : 0;
    const h = highs[i];
    const l = lows[i];
    if (!v || !(h > 0) || !(l > 0)) continue;
    if (h <= l) { // 하루 한 가격 — 그 칸에 통째로
      vols[Math.min(bins - 1, Math.floor((l - lo) / step))] += v;
      continue;
    }
    for (let b = 0; b < bins; b++) {
      const overlap = Math.min(h, lo + (b + 1) * step) - Math.max(l, lo + b * step);
      if (overlap > 0) vols[b] += (v * overlap) / (h - l);
    }
  }
  let poc = 0;
  for (let b = 1; b < bins; b++) if (vols[b] > vols[poc]) poc = b;
  return vols[poc] > 0 ? { lo, hi, step, vols, poc } : null;
}

// 주봉 종가 — 일봉을 월~일 주로 묶어 주마다 마지막 거래일 종가(이번 주는 진행 중인 마지막 값). 날짜는 UTC 날짜다 —
// 국내 일봉(00:00 UTC) · 미국 일봉(13:30/14:30 UTC) 모두 그 시장 날짜 안이다(이동평균과 같다). 1970-01-01 이
// 목요일이라 일 번호에 3을 더하면 월요일에 주가 바뀐다. 빈 종가는 건너뛴다. 주봉 RSI 는 이것에 calcRSI 를 쓴다.
function weekCloses(times, closes) {
  const out = [];
  let week = null;
  for (let i = 0; i < times.length; i++) {
    if (!(closes[i] > 0)) continue;
    const w = Math.floor((Math.floor(times[i] / 86400000) + 3) / 7);
    if (w === week) out[out.length - 1] = closes[i];
    else { out.push(closes[i]); week = w; }
  }
  return out;
}

// from 시점부터 last 까지의 수익률(%). 기준은 from 과 같은 날이거나 그 앞의 마지막 봉(UTC 날짜로 맞춘다 —
// 이동평균 · 볼린저와 같다). 그런 봉이 없으면(시계열이 더 늦게 시작) 첫 봉.
function returnSince(times, closes, from, last) {
  if (!times || !times.length || !(last > 0)) return null;
  const dayOf = (t) => Math.floor(t / 86400000);
  let base = closes[0];
  for (let i = 0; i < times.length && dayOf(times[i]) <= dayOf(from); i++) base = closes[i];
  return base > 0 ? ((last - base) / base) * 100 : null;
}

// 단기선이 장기선을 뚫은 지점. 위로 뚫으면 골든, 아래로 뚫으면 데드.
function crossings(short, long) {
  const out = [];
  for (let i = 1; i < short.length; i++) {
    const s0 = short[i - 1]; const l0 = long[i - 1];
    const s1 = short[i]; const l1 = long[i];
    if (s0 == null || l0 == null || s1 == null || l1 == null) continue;
    if (s0 <= l0 && s1 > l1) out.push({ i, y: s1, golden: true });
    else if (s0 >= l0 && s1 < l1) out.push({ i, y: s1, golden: false });
  }
  return out;
}

// 마지막 봉의 교차는 말하지 않는다. loadQuote 가 마지막 일봉 종가를 현재가로
// 덮어쓰므로(closes[closes.length - 1] = price) 그 봉의 이평선은 30초 폴링마다
// 움직인다. 종가로 확정되기 전이라 장중에 생겼다 사라질 수 있고, 무효가 되면
// 다음 날 다시 "오늘"로 뜬다 — 삼성전자 2026-09-22 장중 실측에서 5/20 골든이
// 마지막 봉(당일)에 잡혔다.
// 대가는 하루 늦음이다: 당일 교차는 다음 거래일에 "1일 전"으로 처음 뜬다.
function confirmedCrosses(crosses, len) {
  return crosses.filter((c) => c.i < len - 1);
}

// 봉 시각과 지금 사이의 달력 일수. 봉 시각은 장 시작 시각이라(KRX 일봉은
// 09:00 KST) 밀리초 차이를 반올림하면 12시간을 넘기는 21:00 에 하루가 더
// 세어졌다 — 그날 뚫은 것이 밤에 "1일 전"이 됐다. 날짜끼리 비교한다.
function midnightOf(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function daysAgo(ms, now = Date.now()) {
  return Math.round((midnightOf(now) - midnightOf(ms)) / 86400000);
}

// 시·고·저는 정규장 값이고, 종가는 세션이 고른다. 시간외 가격을 종가로 쓰면
// 정규장 캔들의 꼬리가 시간외까지 늘어난다 — 정규장 밖에서는 확정된 정규장
// 종가를 쓰고, 아직 못 받았으면 현재가로 버틴다.
// 마지막에 고가·저가를 시가·종가로 조인다. 네이버 고저가 현재가보다 한 틱 늦게
// 오는 순간이 있어, 그대로 두면 몸통이 제 꼬리를 뚫고 나간다.
// venue(일봉 차트의 캔들 기준): 'integrated' 는 통합 시 · 고 · 저에 종가는 지금 마지막 체결(애프터 포함 — 증권사 앱의 통합
// 캔들), 'krx' 는 KRX 시 · 고 · 저(krxCandle)에 위 종가 규칙. 주지 않으면 지금까지처럼 통합 시 · 고 · 저에 위 종가 규칙(헤더 캔들).
function candleOf(q, venue) {
  const c = q && (venue === 'krx' ? q.krxCandle || q.candle : q.candle);
  if (!c || !Number.isFinite(c.open) || c.open <= 0) return null;

  const close = venue === 'integrated' || q.priceSession === 'regular' || q.regularClose == null
    ? q.price
    : q.regularClose;
  if (!Number.isFinite(close) || close <= 0) return null;

  const open = c.open;
  const high = Math.max(Number.isFinite(c.high) ? c.high : -Infinity, open, close);
  const low = Math.min(Number.isFinite(c.low) && c.low > 0 ? c.low : Infinity, open, close);
  return { open, high, low, close, dir: close > open ? 'up' : close < open ? 'down' : 'flat' };
}

// 저가~고가를 높이 h 에 채운다. 몸통은 최소 1px — 도지(시가 = 종가)는 높이가
// 0 이라 그냥 그리면 아무것도 안 보인다. 종가가 저가와 같으면 그 1px 이 아래로
// 삐져나가므로 안쪽으로 당긴다.
function candleGeom(c, h) {
  const span = c.high - c.low;
  if (!(span > 0)) return { flat: true, bodyTop: (h - 1) / 2, bodyH: 1 }; // 하루 한 가격
  const y = (v) => ((c.high - v) / span) * h;
  const top = y(Math.max(c.open, c.close));
  const bodyH = Math.max(1, y(Math.min(c.open, c.close)) - top);
  return { flat: false, bodyTop: Math.min(top, h - bodyH), bodyH };
}

// --- 차트 캔들 -----------------------------------------------------------------
// 위의 candleGeom 은 값 범위를 고정 높이(22px)에 맞춘다. 차트는 반대로 Chart.js 의
// y축이 픽셀을 주므로, 여기서는 그 픽셀만 가지고 몸통을 만든다.

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

// --- 끌어서 확대 ------------------------------------------------------------------
// 3M · 1Y · 3Y 차트에서 끌어서 고른 구간을 차트 전체로 펼친다.

// 확대를 허용하는 기간. 1M(약 22봉)은 확대할 일이 거의 없고, 1D · 1W 는 분봉이라
// 끝에 실시간 점이 붙는 등 다르게 동작한다.
const ZOOM_TF = new Set(['3M', '1Y', '3Y']);

// 이보다 좁게 끌면 확대하지 않는다. 클릭 · 손떨림과 구분하고, 끌다가 도로 좁히면
// 취소가 된다. 5봉은 거래일 한 주다 — 1Y(봉 약 1.2px)에서 약 6px, 3M(약 4.3px)에서는
// 약 22px 라 클릭할 때의 흔들림(1~3px)보다 넉넉히 크다.
const ZOOM_MIN_BARS = 5;
// 마우스가 이만큼은 움직여야 확대한다. 3Y(봉 약 0.38px)는 5봉이 2px 남짓이라 봉 수만
// 보면 클릭 · 더블클릭의 손떨림이 확대가 된다. 6px 은 1Y 의 5봉 폭이라 3M · 1Y 는
// 봉 수 기준과 같고, 3Y 는 약 16봉(3주)부터 확대된다.
const ZOOM_MIN_PX = 6;

// 끈 두 지점(봉 번호)을 앞뒤로 정렬한다. 오른쪽에서 왼쪽으로 끌어도 같다.
// px 는 누른 곳에서 놓은 곳까지 마우스가 움직인 거리(왼쪽이면 음수).
function dragToRange(a, b, px) {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return to - from + 1 >= ZOOM_MIN_BARS && Math.abs(px) >= ZOOM_MIN_PX ? { from, to } : null;
}

// 날짜로 기억해 둔 구간을 지금 데이터의 봉 번호로 바꾼다. 30초마다 다시 그리고 다음
// 날엔 봉이 하나 늘어 번호가 밀리므로, 번호가 아니라 날짜로 기억한다.
// 비교는 UTC 날짜로 한다(renderer/data.js maFor 와 같은 규칙) — 장중 마지막 봉의 시각은
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

// --- 3Y 구간 ---------------------------------------------------------------------
// 야후에는 3년 구간(range=3y)이 없어서 5년치 일봉을 받아 자른다. 마지막 봉에서 달력으로
// years 년 전 날짜부터 남기고, 그날 봉도 넣는다. 날짜는 UTC 로 센다(zoomRange 와 같은
// 이유 — 장중 마지막 봉의 시각은 마지막 체결 시각이라 갱신마다 바뀐다).
// 응답 r 은 차트 캐시에 그대로 들어 있으므로 고치지 않고 잘린 사본을 돌려준다.
// 상장한 지 years 년이 안 됐으면 받은 그대로다.
function lastYears(r, years) {
  const end = new Date(r.times[r.times.length - 1]);
  const from = Date.UTC(end.getUTCFullYear() - years, end.getUTCMonth(), end.getUTCDate()) / 86400000;
  const k = r.times.findIndex((t) => Math.floor(t / 86400000) >= from);
  if (k <= 0) return r;
  const cut = (a) => (a ? a.slice(k) : a);
  return {
    ...r,
    closes: cut(r.closes), times: cut(r.times), opens: cut(r.opens),
    highs: cut(r.highs), lows: cut(r.lows), volumes: cut(r.volumes),
  };
}

// --- 기법 점검(지표 화면) --------------------------------------------------------
// 일봉 종가(오늘 봉은 현재가) · 거래량으로 흔히 쓰는 기법의 지금 상태를 센다. 매매 신호가 아니라 참고용이다.
// volumes 는 closes 와 같은 봉끼리 짝지은 배열이다(없는 날은 null). 마지막 봉은 진행 중일 수 있어 거래량에서는 뺀다.

// 추세 추종 — 종가가 period 일선 위면 보유, 아래면 현금으로 보는 규칙. days 는 그 상태가 이어진 봉 수(오늘 포함).
// 봉이 period 개보다 적으면 null.
function trendFollow(closes, period = 200) {
  if (!closes || closes.length < period) return null;
  const ma = sma(closes, period);
  const n = closes.length - 1;
  const above = closes[n] > ma[n];
  let days = 0;
  for (let i = n; i >= 0 && ma[i] != null && (closes[i] > ma[i]) === above; i--) days++;
  return { above, ma: ma[n], days };
}

// 이동평균 추세(지수 줄, 2026-11-25 사용자 요청) — 종가가 period 일선 위 · 아래와 그 선이 lag 봉 전보다 높은지로 넷.
// up: 위 · 오름, down: 아래 · 내림, upTry: 위인데 선은 아직 내림, downTry: 아래인데 선은 아직 오름. 같으면 아래 · 내림.
// days 는 그 상태가 이어진 봉 수(마지막 봉 포함). 봉이 period + lag 개보다 적으면 null.
function maTrend(closes, period = 80, lag = 5) {
  if (!closes || closes.length < period + lag) return null;
  const ma = sma(closes, period);
  const stateAt = (i) => {
    const above = closes[i] > ma[i];
    const rising = ma[i] > ma[i - lag];
    return above ? (rising ? 'up' : 'upTry') : (rising ? 'downTry' : 'down');
  };
  const n = closes.length - 1;
  const state = stateAt(n);
  let days = 0;
  for (let i = n; i - lag >= 0 && ma[i - lag] != null && stateAt(i) === state; i--) days++;
  return { state, days, close: closes[n], ma: ma[n], maLag: ma[n - lag] };
}

// ms 의 n 달 전 같은 날(UTC 날짜로, 시각은 그대로). 그달에 그날이 없으면(3/31 의 한 달 전) 그달 마지막 날.
// 모멘텀과 지표 화면의 기간 수익률(1 · 3개월 · 1년)이 같은 날짜를 쓰게 여기 하나만 둔다(2026-11-05 까지 두 벌).
function monthsBack(ms, n) {
  const d = new Date(ms);
  const want = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(Math.min(want, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.getTime();
}

// 모멘텀 12-1 — 최근 skip 달을 뺀 long 달 수익률(%) = skip 달 전 종가 / long 달 전 종가 - 1. 마지막 한 달은 단기 되돌림이
// 섞여 빼는 것이 흔한 정의다. 그날(없으면 그 앞의 마지막 봉) 종가이고 날짜는 마지막 봉의 UTC 날짜에서 달로 센다 — 거래일
// 수로 세면 국내는 1년 거래일이 244일 남짓이라 252봉 전이 12개월보다 열흘 넘게 앞이었다(2026-10-29 하이닉스 279.8% ·
// 달력 216.3%). 날짜는 monthsBack. long 달 전보다 앞선 봉이 없으면 null.
function momentum(times, closes, long = 12, skip = 1) {
  if (!times || times.length < 2) return null;
  const n = times.length - 1;
  const dayOf = (t) => Math.floor(t / 86400000);
  const back = (m) => dayOf(monthsBack(times[n], m));
  const at = (day) => { let k = -1; for (let i = 0; i <= n && dayOf(times[i]) <= day; i++) k = i; return k; };
  const from = at(back(long));
  const to = at(back(skip));
  return from >= 0 && closes[from] > 0 && closes[to] > 0 ? (closes[to] / closes[from] - 1) * 100 : null;
}

// 적립식 — 최근 months 달(이번 달 포함) 매달 첫 거래일 종가에 같은 금액을 샀을 때의 평균 단가(같은 금액이라 조화평균)와
// 마지막 종가 대비(%). 달은 봉 시각의 UTC 날짜로 가른다(국내 일봉 00:00 UTC = 09:00 KST, 미국 13:30 UTC — 그 시장 날짜).
// 첫 달 앞의 봉이 없으면(그달 첫 거래일인지 모른다 — 최근 상장) null.
function dcaCost(times, closes, months = 12) {
  if (!times || times.length < 2) return null;
  const mon = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const n = times.length - 1;
  const first = mon(times[n]) - (months - 1);
  if (mon(times[0]) >= first) return null;
  let buys = 0;
  let inv = 0;
  for (let i = 1; i <= n; i++) {
    const m = mon(times[i]);
    if (m >= first && m !== mon(times[i - 1]) && closes[i] > 0) { buys++; inv += 1 / closes[i]; }
  }
  if (!buys) return null;
  const avg = buys / inv;
  return { avg, buys, pct: (closes[n] / avg - 1) * 100 };
}

// 반등 점검(데드캣) — 최근 lookback 봉의 최고 종가에서 drop(%) 넘게 빠진 뒤(그 뒤의 최저 종가) 반등 중일 때만.
// 되돌림(%) = 저점에서 오른 폭 / 고점~저점 폭. 20일선 위아래 · RSI(14) · 반등 거래량(저점 뒤 확정된 봉의 평균 / 고점 뒤
// 저점까지의 평균 — 하락만큼 힘이 실렸는지). 덜 빠졌거나 아직 저점이면(마지막 봉이 최저) null.
function reboundCheck(closes, volumes, lookback = 60, drop = 15) {
  if (!closes || closes.length < lookback) return null;
  const n = closes.length - 1;
  let hi = n - lookback + 1;
  for (let i = hi; i <= n; i++) if (closes[i] > closes[hi]) hi = i;
  let lo = hi;
  for (let i = hi; i <= n; i++) if (closes[i] < closes[lo]) lo = i;
  const dropPct = (closes[lo] / closes[hi] - 1) * 100;
  if (dropPct > -drop || !(closes[n] > closes[lo])) return null;
  const avg = (from, to) => {
    const v = (volumes || []).slice(from, to).filter((x) => x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const down = avg(hi + 1, lo + 1);
  const up = avg(lo + 1, n);
  const ma20 = closes.length >= 20 ? sma(closes, 20)[n] : null;
  return {
    high: closes[hi], low: closes[lo], dropPct,
    retrace: ((closes[n] - closes[lo]) / (closes[hi] - closes[lo])) * 100,
    ma20, aboveMa20: ma20 != null ? closes[n] > ma20 : null,
    rsi: calcRSI(closes),
    volRatio: down && up ? up / down : null,
  };
}

// 코스톨라니 달걀(해석) — 상승장 · 하락장은 저마다 수정 → 동행 → 과장 세 국면을 차례로 지나고 그다음은 반대편이다
// (A1 → A2 → A3 → B1 → B2 → B3 → 다시 A1). 그래서 국면은 그날 값만으로 붙이지 않고 순서를 기억해 한 칸씩 나아간다 —
// 그날 값만으로 붙였더니 하락장 중의 반등이 A1(바닥 뒤 상승 초기)이 되어 삼성전자가 A1 → B1 로 보였다(2026-10-29).
// 판정에 쓰는 값: 방향(20일선이 60일선 위면 상승), 거래량 흐름(확정된 봉의 20일 평균 / 60일 평균), RSI(14).
// 원래 이론에는 숫자 기준이 없어 아래 기준은 해석이다.
//   A1 → A2  거래량 증가(1배 이상, 상승 중)      A2 → A3  과열(RSI EGG_HOT 이상 또는 거래량 EGG_SURGE 배 이상)
//   A3 → B1  20일선이 60일선 아래로              B1 → B2  거래량 증가(하락 중)
//   B2 → B3  투매(RSI EGG_PANIC 이하 또는 거래량 EGG_SURGE 배 이상)    B3 → A1  20일선이 60일선 위로
// 과열 · 투매는 칸을 건너뛰어 바로 간다(A1 → A3, B1 → B3). 과열 없이 EGG_CONFIRM 거래일 넘게 내리면 B1, 투매 없이 그만큼
// 오르면 A1 로 넘어간다(꼭대기 · 바닥이 늘 과열 · 투매로 끝나지는 않는다). 되돌아가지는 않는다(A2 → A1 같은 흔들림 없음).
// 과열 · 투매는 이동평균보다 먼저 온다 — B3 에 든 날 20일선이 아직 60일선 위였으면(삼성전자 10/15 RSI 28) 그 위를 A1 의
// 근거로 쓰지 않고, 한 번 아래로 내려갔다 다시 올라서야 A1 이다(armed). A3 도 같다.
const EGG_SURGE = 1.5;
const EGG_HOT = 70;
const EGG_PANIC = 30;
const EGG_CONFIRM = 20;
const EGG_ORDER = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']; // 달걀을 도는 순서 — B3 다음은 다시 A1

// 달걀 한 걸음 — 지금 국면 st(처음이면 null)와 그 봉의 x = { up, ratio, rsi, upRun, dnRun, armed } 로 다음 국면.
// upRun · dnRun 은 방향이 이어진 봉 수, armed 는 A3 · B3 에 든 뒤 그 방향(A3 는 상승, B3 는 하락)을 한 번 지났는지.
function eggNext(st, x) {
  const hot = x.rsi >= EGG_HOT || x.ratio >= EGG_SURGE;
  const panic = x.rsi <= EGG_PANIC || x.ratio >= EGG_SURGE;
  if (st == null) return x.up ? (hot ? 'A3' : x.ratio < 1 ? 'A1' : 'A2') : (panic ? 'B3' : x.ratio < 1 ? 'B1' : 'B2');
  if (st === 'A1') return hot ? 'A3' : x.up && x.ratio >= 1 ? 'A2' : x.dnRun >= EGG_CONFIRM ? 'B1' : st;
  if (st === 'A2') return hot ? 'A3' : x.dnRun >= EGG_CONFIRM ? 'B1' : st;
  if (st === 'A3') return (x.armed && !x.up) || x.dnRun >= EGG_CONFIRM ? 'B1' : st;
  if (st === 'B1') return panic ? 'B3' : !x.up && x.ratio >= 1 ? 'B2' : x.upRun >= EGG_CONFIRM ? 'A1' : st;
  if (st === 'B2') return panic ? 'B3' : x.upRun >= EGG_CONFIRM ? 'A1' : st;
  return (x.armed && x.up) || x.upRun >= EGG_CONFIRM ? 'A1' : st; // B3
}

// 봉마다의 국면 { phase, up, ratio, rsi } — 셀 수 있는 첫 봉부터 eggNext 로 나아간다. 거래량은 그 봉 앞까지(그 봉은 진행 중일
// 수 있어 뺀다), 0 인 날(휴장 · 빈 봉 · 거래량이 없는 지수)은 뺀다. 60일선 · 거래량 있는 날 60개가 모이기 전은 null.
function eggSeries(closes, volumes) {
  const out = new Array(closes ? closes.length : 0).fill(null);
  if (!closes || !volumes) return out;
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const rsi = rsiSeries(closes);
  const sum = [0]; // 그 봉 앞까지 거래량이 있는 날들의 누적합
  let st = null;
  let upRun = 0;
  let dnRun = 0;
  let armed = false;
  for (let i = 0; i < closes.length; i++) {
    if (i > 0 && volumes[i - 1] > 0) sum.push(sum[sum.length - 1] + volumes[i - 1]);
    const k = sum.length - 1;
    if (ma60[i] == null || k < 60) continue;
    const ratio = ((sum[k] - sum[k - 20]) / 20) / ((sum[k] - sum[k - 60]) / 60);
    const up = ma20[i] > ma60[i];
    upRun = up ? upRun + 1 : 0;
    dnRun = up ? 0 : dnRun + 1;
    if ((st === 'A3' && up) || (st === 'B3' && !up)) armed = true;
    const next = eggNext(st, { up, ratio, rsi: rsi[i], upRun, dnRun, armed });
    if (next !== st) armed = false;
    st = next;
    out[i] = { phase: st, up, ratio, rsi: rsi[i] };
  }
  return out;
}

// 지금 국면과 방향 — prev 는 마지막으로 바뀌기 전 국면(받은 일봉 안에서 바뀐 적이 없으면 null), days 는 지금 국면이
// 이어진 봉 수(오늘 포함), next 는 달걀 순서의 다음 국면(이론상 — 실제로는 건너뛰거나 거꾸로 가기도 한다).
function eggPhase(closes, volumes) {
  const s = eggSeries(closes, volumes);
  const n = s.length - 1;
  if (n < 0 || !s[n]) return null;
  let j = n;
  while (j >= 0 && s[j] && s[j].phase === s[n].phase) j--;
  return { ...s[n], prev: j >= 0 && s[j] ? s[j].phase : null, days: n - j,
    next: EGG_ORDER[(EGG_ORDER.indexOf(s[n].phase) + 1) % EGG_ORDER.length] };
}

// 렌더러에는 contextIsolation 이 걸려 있어 module 이 없다 → 이 줄은 건너뛴다.
if (typeof module !== 'undefined') {
  module.exports = {
    calcRSI, rsiSeries, rsiSignal, RSI_MIN_SPAN, rsiScale, stochSeries, weekCloses, sma, bollinger, vwap, parabolicSar, volumeProfile, returnSince, monthsBack, crossings, confirmedCrosses, midnightOf, daysAgo, candleOf, candleGeom,
    CANDLE_MAX_BARS, candleMode, candleWidth, candleBody,
    ZOOM_TF, ZOOM_MIN_BARS, ZOOM_MIN_PX, dragToRange, zoomRange, lastYears,
    trendFollow, maTrend, momentum, dcaCost, reboundCheck, EGG_SURGE, EGG_HOT, EGG_PANIC, EGG_CONFIRM, EGG_ORDER, eggNext, eggSeries, eggPhase,
  };
}
