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

// 렌더러에는 contextIsolation 이 걸려 있어 module 이 없다 → 이 줄은 건너뛴다.
if (typeof module !== 'undefined') {
  module.exports = {
    calcRSI, sma, crossings, confirmedCrosses, midnightOf, daysAgo, candleOf, candleGeom,
  };
}
