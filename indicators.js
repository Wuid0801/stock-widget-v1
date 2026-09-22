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

// 렌더러에는 contextIsolation 이 걸려 있어 module 이 없다 → 이 줄은 건너뛴다.
if (typeof module !== 'undefined') {
  module.exports = { calcRSI, sma, crossings, confirmedCrosses, midnightOf, daysAgo };
}
