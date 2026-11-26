// 골든/데드크로스 배지 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 교차 계산을
// 검증한다(trend.mjs · rsi.mjs 와 같은 방식).
//
// 핵심 성질은 둘이다.
//
// 1. 마지막 봉의 교차는 말하지 않는다. loadQuote 가 마지막 일봉 종가를 현재가로
//    덮어쓰므로(closes[closes.length - 1] = price) 그 봉의 이평선은 30초 폴링마다
//    움직인다. 종가로 확정되기 전이라 장중에 생겼다 사라지고, 무효가 되면 다음 날
//    다시 "오늘"로 뜬다 — 삼성전자에서 어제도 오늘도 "오늘"로 뜬 것이 이것이다.
//
// 2. 날짜는 달력 일수로 센다. 봉 시각은 장 시작(KRX 일봉은 09:00 KST)이므로
//    밀리초 차이를 반올림하면 21:00 을 넘는 순간 하루가 더 세어졌다.
import * as X from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// 단순이동평균. indicators.js 의 sma 와 같은 식 — 여기서는 입력을 만드는 도구다.
const sma = (closes, p) => {
  const out = new Array(closes.length).fill(null);
  let s = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i];
    if (i >= p) s -= closes[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
};

const KST = 'Asia/Seoul';
const d = (iso, hhmm = '09:00') => new Date(`${iso}T${hhmm}:00+09:00`).getTime();

// --- 0. 준비 확인 ---------------------------------------------------------------
check('confirmedCrosses 를 indicators.js 가 내보낸다', X.confirmedCrosses != null);
check('daysAgo 를 indicators.js 가 내보낸다', X.daysAgo != null);
if (!X.confirmedCrosses || !X.daysAgo) {
  console.log('\n필요한 함수가 없어 이후 검사를 건너뜁니다.');
  process.exit(1);
}

// --- 1. crossings 기본 동작 -----------------------------------------------------
{
  const short = [1, 1, 3, 3, 1];
  const long = [2, 2, 2, 2, 2];
  const out = X.crossings(short, long);
  check('위로 뚫으면 골든, 아래로 뚫으면 데드',
    out.length === 2 && out[0].i === 2 && out[0].golden === true
    && out[1].i === 4 && out[1].golden === false,
    JSON.stringify(out.map((c) => `${c.i}:${c.golden ? '골든' : '데드'}`)));

  check('한쪽이 null 인 구간은 교차로 세지 않는다',
    X.crossings([1, null, 3], [2, 2, 2]).length === 0);
}

// --- 2. 마지막 봉의 교차는 확정이 아니다 ----------------------------------------
{
  const crosses = [{ i: 3, golden: false }, { i: 7, golden: true }];
  check('마지막 봉(i = len-1)의 교차는 빠진다',
    X.confirmedCrosses(crosses, 8).length === 1
    && X.confirmedCrosses(crosses, 8)[0].i === 3);

  check('마지막 직전 봉의 교차는 남는다',
    X.confirmedCrosses(crosses, 9).length === 2);

  check('빈 목록도 그대로 빈 목록이다', X.confirmedCrosses([], 8).length === 0);
}

// --- 3. 실데이터: 삼성전자 2026-08-18 ~ 09-22 종가 -----------------------------
// 야후 005930.KS 일봉 실측(2026-09-22 장중 수집). 26봉이라 20일선은 09-14 부터,
// 따라서 5/20 교차는 09-15 이후 구간에서만 판정된다.
{
  const closes = [
    268500, 247500, 271000, 281500, 257000, 257000, 261500, 266000, 257000,
    260000, 261000, 250500, 250000, 255500, 270000, 269500, 269500, 269000,
    259500, 249000, 248500, 253500, 252500, 261000, 274000, 280250,
  ];
  const dates = [
    '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-24',
    '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31',
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07',
    '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14',
    '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21',
    '2026-09-22',
  ];
  const times = dates.map((iso) => d(iso));
  const len = closes.length;

  const raw = X.crossings(sma(closes, 5), sma(closes, 20));
  const at = (c) => dates[c.i];

  check('실데이터에서 교차는 09-15 데드 · 09-22 골든 둘이다',
    raw.length === 2 && at(raw[0]) === '2026-09-15' && raw[0].golden === false
    && at(raw[1]) === '2026-09-22' && raw[1].golden === true,
    raw.map((c) => `${at(c)} ${c.golden ? '골든' : '데드'}`).join(', '));

  // 09-22 은 마지막 봉이고 그 종가는 현재가로 덮인 미확정값이다.
  check('마지막 봉(09-22)의 골든은 확정 목록에서 빠진다',
    X.confirmedCrosses(raw, len).every((c) => at(c) !== '2026-09-22'));

  const last = X.confirmedCrosses(raw, len).slice(-1)[0];
  check('배지가 가리키는 교차는 09-15 데드다',
    last && at(last) === '2026-09-15' && last.golden === false,
    last ? `${at(last)} ${last.golden ? '골든' : '데드'}` : '(없음)');

  // 보고된 증상: 어제도 오늘도 "오늘". 확정 목록에는 당일 봉이 없으므로
  // "오늘"이 나올 수 없다.
  check('확정 교차의 날짜 라벨은 09-22 장중에 "오늘"이 되지 않는다',
    X.daysAgo(times[last.i], d('2026-09-22', '14:00')) === 7,
    `${X.daysAgo(times[last.i], d('2026-09-22', '14:00'))}일 전`);
}

// --- 4. 날짜는 달력 일수다 (21:00 회귀 가드) ------------------------------------
{
  const bar = d('2026-09-22'); // 09:00 KST 봉

  check('같은 날 10:00 에는 0일', X.daysAgo(bar, d('2026-09-22', '10:00')) === 0);
  check('같은 날 20:59 에도 0일', X.daysAgo(bar, d('2026-09-22', '20:59')) === 0);
  // 예전에는 (now - bar)/86400000 을 반올림해 12시간을 넘기는 21:00 에 1 이 되었다.
  check('같은 날 21:30 에도 0일 (반올림 회귀)',
    X.daysAgo(bar, d('2026-09-22', '21:30')) === 0,
    `${X.daysAgo(bar, d('2026-09-22', '21:30'))}일`);
  check('같은 날 23:59 에도 0일', X.daysAgo(bar, d('2026-09-22', '23:59')) === 0);

  check('다음 날 00:01 에는 1일', X.daysAgo(bar, d('2026-09-23', '00:01')) === 1);
  check('다음 날 22:00 에도 1일 (반올림 회귀)',
    X.daysAgo(bar, d('2026-09-23', '22:00')) === 1,
    `${X.daysAgo(bar, d('2026-09-23', '22:00'))}일`);

  check('주말을 건너뛴 금요일 봉은 월요일에 3일',
    X.daysAgo(d('2026-09-18'), d('2026-09-21', '10:00')) === 3);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails ? 1 : 0);
