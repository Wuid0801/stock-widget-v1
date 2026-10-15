// indicators.js — 화면과 무관한 순수 계산.
//
// 브라우저에서는 클래식 스크립트다. index.html 이 renderer.js 보다 먼저 싣고,
// 최상위 함수 선언이 전역이 되므로 renderer.js 는 그냥 이름으로 부른다.
// Node(테스트)에서는 CommonJS 로 읽혀 아래 module.exports 가 쓰인다.
//
// 여기에는 DOM · quotes · state · cssVar 를 건드리는 것을 두지 않는다.
// 그것이 이 파일을 테스트에서 통째로 import 할 수 있게 하는 조건이다.

// --- RSI(14), Wilder smoothing -----------------------------------------------
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
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
// 마지막 봉(당일)에 잡혔다. 추세선이 최근 봉을 빼고 선을 만드는 것
// (TREND_LOOKBACK)과 같은 이유다.
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
function candleOf(q) {
  const c = q && q.candle;
  if (!c || !Number.isFinite(c.open) || c.open <= 0) return null;

  const close = q.priceSession === 'regular' || q.regularClose == null
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

// --- 추세선 ---------------------------------------------------------------------
// 저점끼리 이으면 지지선, 고점끼리 이으면 저항선. 3M · 1Y 에서만 그린다 —
// 1M(21봉)은 구간이 짧고, 1D/1W 는 분봉이라 "추세"라고 부를 구간이 아니다.
const TREND_TF = new Set(['3M', '1Y']);

// 이 정도는 걸쳐야 추세라고 부를 수 있다(봉 수).
const TREND_MIN_SPAN = 20;
// 선을 만들 때 빼두는 최근 봉 수. 이 봉들은 껍질에 넣지 않으므로 선을 뚫을 수 있다.
// 마지막 봉까지 넣으면 껍질이 늘 그 봉을 감싸서 선이 정의상 절대 뚫리지 않는다 —
// 돌파가 일어나도 선이 오늘 고가에 다시 맞춰질 뿐이라 돌파를 말할 수 없었다.
const TREND_LOOKBACK = 5;
// 선분 끝점이 피팅 창 끝에서 이보다 멀면 채택하지 않는다. 오래된 선분을 끝까지
// 연장하는 것이 "껍질이 엉뚱한 데를 가리킨다"의 실제 원인이었다 — 상승 뒤 급락
// 구간에서 최장 선분이 상승 구간이라 삼성전자 1Y 저항이 +75% 로 나왔다.
const TREND_MAX_EXTEND = 10;
// 이보다 적게 넘은 것은 돌파로 치지 않는다. 껍질은 원래 선에 닿으므로 스치는 일이
// 흔하다 — 실측에서 Apple 3M 저가가 지지선을 0.035%(11센트) 스쳤다. 실제 돌파는
// 2.6% · 4.2% · 8.5% 로 나와서 0.5~2% 어디를 잡아도 결과가 같다.
const TREND_MIN_BREAK = 0.01;
// 피팅 창 끝에서 선과 실제값이 이만큼 넘게 벌어지면 채택하지 않는다. 이격을 창
// 끝에서 재는 것이 핵심이다 — 그 지점은 제외 구간 앞이라 돌파가 값에 영향을 주지
// 않으므로, 거리 기준을 되살려도 돌파가 걸러지지 않는다. 실측에서 실제 8개 선은
// |이격| ≤ 6.50% 이고 급락 시나리오는 36% · 71% 라 10~30% 어디를 잡아도 같다.
const TREND_MAX_DRIFT = 0.20;

// 볼록 껍질(Andrew monotone chain). 점은 x 오름차순으로 들어온다.
// 피팅 창 안의 모든 봉을 넣는다. 스윙 피벗만 넣으면 피벗이 아닌 봉이 선 아래로
// 삐져나온다 — 실제로 20봉 중 3봉이 최대 17,871원까지 뚫었다.
// (창 밖의 최근 봉이 뚫는 것은 의도한 것이고, 그게 돌파다)
function hull(pts, low) {
  const out = [];
  for (const p of pts) {
    while (out.length >= 2) {
      const a = out[out.length - 2]; const b = out[out.length - 1];
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (low ? cross <= 0 : cross >= 0) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

// 껍질에서 가장 긴 선분이 추세선이다. 마지막 선분을 쓰면 안 된다 —
// 껍질은 기울기가 단조라 마지막이 언제나 가장 가파른 선분이고,
// 그걸 앞으로 연장하면 현재가를 뚫고 올라간다(지지선이 주가 위로 갔다).
//
// 선은 그 선분의 시작점부터 마지막 봉까지만 채우고 앞쪽은 null 로 둔다.
// 카테고리 축이라 봉이 없는 구간으로는 뻗을 수 없고, 뒤로 늘이면 y축만 넓어진다.
function trendLine(values, len, low) {
  const fitEnd = len - TREND_LOOKBACK; // 껍질에 넣는 봉은 [0, fitEnd) 뿐이다
  const pts = [];
  for (let i = 0; i < fitEnd; i++) if (values[i] != null) pts.push([i, values[i]]);
  const h = hull(pts, low);

  let best = null;
  for (let k = 1; k < h.length; k++) {
    const span = h[k][0] - h[k - 1][0];
    if (!best || span > best.span) best = { span, a: h[k - 1], b: h[k] };
  }
  if (!best || best.span < TREND_MIN_SPAN) return null;

  const [x1, y1] = best.a;
  const [x2, y2] = best.b;
  if (fitEnd - 1 - x2 > TREND_MAX_EXTEND) return null;

  const slope = (y2 - y1) / (x2 - x1);
  // 앞으로 연장한 선이 0 이하를 가리키면 그리지 않는다. 0 이하의 가격은 뜻이 없고,
  // 정규 데이터셋이라 y축이 그 값까지 늘어나 눈금에 음수가 찍힌다 — 92% 급락 뒤
  // 반등한 구간에서 지지선 오늘값이 -1,224 로 나왔다. 기울기가 단조라 그려지는
  // 구간의 최솟값은 양 끝 중 하나다.
  const last = y1 + slope * (len - 1 - x1);
  if (Math.min(y1, last) <= 0) return null;

  // 피팅 창의 마지막 실제 점에서 선이 얼마나 벌어졌는지 본다. 창 끝에서 재므로
  // 제외 구간의 돌파는 이 값에 섞이지 않는다.
  const [xEnd, vEnd] = pts[pts.length - 1];
  if (!(vEnd > 0)) return null;
  if (Math.abs((y1 + slope * (xEnd - x1) - vEnd) / vEnd) > TREND_MAX_DRIFT) return null;

  const out = new Array(len).fill(null);
  for (let i = x1; i < len; i++) out[i] = y1 + slope * (i - x1);
  return { data: out, slope, from: x1, to: x2 };
}

// i 봉이 선에서 얼마나 벗어났는지. y <= 0 이면 나눌 때 부호가 뒤집혀 이탈이 아닌 봉을
// 큰 이탈로 보고하므로 아예 뺀다(선 -488 / 저가 2,861 인데 "지지 이탈 +686%").
function excessAt(line, extremes, i, low) {
  const y = line.data[i];
  const v = extremes[i];
  if (y == null || v == null || y <= 0) return null;
  const gap = low ? y - v : v - y;
  return { gap, pct: gap / y };
}

// 뚫은 날 = 빼둔 구간에서 문턱을 처음 넘은 봉, 없으면 null. 이탈이 가장 큰 봉을 고르면
// 안 된다 — 저항선은 내려가고 주가는 오르니 초과폭이 날마다 커져서 늘 최근 봉이 뽑힌다.
// SK하이닉스 실측에서 09-07 에 뚫었는데 배지가 09-10 을 가리켰다.
// 닿기만 한 봉은 돌파가 아니다 — 껍질은 원래 선에 닿는다.
//
// 마지막 봉은 판정에서 뺀다. 그 봉의 고가·저가는 장중에 실시간 값으로 계속
// 덮이므로, 넣으면 배지가 장중에 떴다 사라지고 다음 날 또 뜬다(크로스 배지와
// 같은 이유).
function firstBreak(line, extremes, len, low) {
  for (let i = len - TREND_LOOKBACK; i < len - 1; i++) {
    const e = excessAt(line, extremes, i, low);
    if (e && e.gap > 0 && e.pct >= TREND_MIN_BREAK) return i;
  }
  return null;
}

// 빼둔 최근 봉이 선을 넘었는가. 문턱(TREND_MIN_BREAK)을 처음 넘은 확정 봉(at)을 돌려주고,
// 폭(gap · pct)은 마지막 봉에서 잰다 — 되밀렸으면 음수다.
// 저항은 고가가 선 위로, 지지는 저가가 선 아래로 나간 것이 돌파다.
// 껍질을 피팅 창 [0, len - TREND_LOOKBACK) 의 봉으로만 만들므로 그 봉들은 선을 넘지 않는다
// — 제외 구간만 보면 된다. extremes 는 선을 만든 값 그대로다(저항은 고가, 지지는 저가).
function breakoutOf(line, extremes, len, low) {
  const at = firstBreak(line, extremes, len, low);
  if (at == null) return null;

  // 한 봉 전 계산에서 돌파로 잡은 봉 위로 선이 다시 그어졌으면 끈다. 뚫은 봉도 5봉이
  // 지나면 피팅 창에 들어가 껍질이 그 봉을 지나도록 선을 다시 잡고, 오름세가 이어지면
  // 다음 봉이 새 선을 또 넘는다 — 그대로 두면 배지가 몇 주씩 켜진 채 날짜가 늘
  // "4봉 전"에 머문다. 오래된 돌파는 이미 새 추세의 일부라, 뚫은 뒤 4봉까지만 말한다.
  // 한 봉 전 결과는 이 검사를 거치지 않은 값이다 — 끈 날에도 움직임이 이어지면 계속 끈다.
  const prev = trendLine(extremes, len - 1, low);
  const prevAt = prev && firstBreak(prev, extremes, len - 1, low);
  if (prevAt != null && line.to >= prevAt) return null;

  // 폭은 마지막 봉 기준. "지금 선에서 얼마나 떨어져 있나" 가 알고 싶은 값이고
  // 뚫은 날의 폭은 이미 지난 숫자다. 되밀렸으면 음수로 나온다 — 사건이 아니라 현재 상태다.
  const now = excessAt(line, extremes, len - 1, low) || excessAt(line, extremes, at, low);
  return { at, gap: now.gap, pct: now.pct };
}


// 두 추세선이 만나는 봉 인덱스. 기울기가 같으면 평행이라 만나지 않는다.
// 인덱스는 소수로 나오고, 마지막 봉보다 뒤여야(수렴 중이어야) 의미가 있다.
function meetAt(a, b) {
  if (a.slope === b.slope) return null;
  const ay = a.data[a.from] - a.slope * a.from; // y절편
  const by = b.data[b.from] - b.slope * b.from;
  return (by - ay) / (a.slope - b.slope);
}

// 렌더러에는 contextIsolation 이 걸려 있어 module 이 없다 → 이 줄은 건너뛴다.
if (typeof module !== 'undefined') {
  module.exports = {
    calcRSI, sma, bollinger, vwap, volumeProfile, returnSince, crossings, confirmedCrosses, midnightOf, daysAgo, candleOf, candleGeom,
    CANDLE_MAX_BARS, candleMode, candleWidth, candleBody,
    ZOOM_TF, ZOOM_MIN_BARS, ZOOM_MIN_PX, dragToRange, zoomRange, lastYears,
    TREND_TF, TREND_MIN_SPAN, TREND_LOOKBACK, TREND_MAX_EXTEND, TREND_MIN_BREAK, TREND_MAX_DRIFT,
    hull, trendLine, breakoutOf, meetAt,
  };
}
