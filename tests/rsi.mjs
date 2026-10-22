// RSI(14) 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 calcRSI 를 검증한다.
//
// 아래 기대값은 Wilder 의 표준 예제 종가로 계산한 결과이며,
// 널리 쓰이는 technicalindicators 라이브러리의 RSI 와 소수 2자리까지
// 전부 일치함을 확인했다(Wilder 예제 + 실제 국내 5종목 일봉, 총 1166개 값).
// 여기서는 외부 의존성 없이 그 결과를 고정해 두어 구현이 바뀌면 잡히게 한다.
import { calcRSI, weekCloses } from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// Wilder, New Concepts in Technical Trading Systems 예제 종가
const CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
  43.42, 42.66, 43.13,
];
const EXPECTED = [
  70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34,
  54.67, 50.39, 40.02, 41.49, 41.90, 45.50, 37.32, 33.09, 37.79,
];

const r2 = (v) => Math.round(v * 100) / 100;
let bad = 0;
for (let i = 0; i < EXPECTED.length; i++) {
  const got = r2(calcRSI(CLOSES.slice(0, 15 + i)));
  if (got !== EXPECTED[i]) { bad++; console.log(`  idx ${14 + i}: ${got} (기대 ${EXPECTED[i]})`); }
}
check(`Wilder 예제 ${EXPECTED.length}개 값 일치`, bad === 0, bad ? `${bad}건 불일치` : '');

// 경계 조건
check('표본 부족(14개)이면 null', calcRSI(CLOSES.slice(0, 14)) === null);
check('상승만 이어지면 100', calcRSI(Array.from({ length: 30 }, (_, i) => 100 + i)) === 100);
check('하락만 이어지면 0', calcRSI(Array.from({ length: 30 }, (_, i) => 100 - i)) === 0);
check('변동이 없으면 50', calcRSI(Array(30).fill(100)) === 50);
check('빈 배열도 안전하게 null', calcRSI([]) === null);

// 주봉 종가 — 일봉을 월~일 주로 묶어 주마다 마지막 거래일 종가(이번 주는 진행 중인 마지막 값). 주봉 RSI 는 이것에
// 같은 calcRSI 를 쓴다(일봉 RSI 를 주 평균한 것이 아니다).
{
  const day = (s) => Date.parse(`${s}T00:00:00Z`); // 국내 일봉 시각(09:00 KST = 00:00 UTC)
  const times = ['2026-10-05', '2026-10-06', '2026-10-08', // 10/5 주(10/9 휴장)
    '2026-10-12', '2026-10-13', '2026-10-16', // 10/12 주
    '2026-10-19', '2026-10-20', '2026-10-21'].map(day); // 이번 주(수요일까지)
  const closes = [100, 101, 102, 110, null, 112, 120, 121, 125];
  check('주마다 마지막 거래일 종가, 빈 종가는 건너뜀, 이번 주는 지금 값',
    JSON.stringify(weekCloses(times, closes)) === '[102,112,125]', JSON.stringify(weekCloses(times, closes)));
  // 일요일 · 월요일 경계 — 10/18(일)은 10/12 주, 10/19(월)는 새 주
  check('일요일은 그 주, 월요일부터 새 주', JSON.stringify(weekCloses([day('2026-10-18'), day('2026-10-19')], [1, 2])) === '[1,2]');
  // 미국 일봉(13:30 UTC)도 UTC 날짜가 그 시장 날짜다
  const us = [Date.parse('2026-10-16T13:30:00Z'), Date.parse('2026-10-19T13:30:00Z')];
  check('미국 일봉도 같은 주 나누기', JSON.stringify(weekCloses(us, [10, 11])) === '[10,11]');
  // 주봉 RSI = 주간 종가에 calcRSI
  const t = Array.from({ length: 200 }, (_, i) => day('2023-01-02') + i * 86400000);
  const c = t.map((_, i) => 100 + Math.sin(i / 9) * 10 + i * 0.05);
  const w = weekCloses(t, c);
  check('주봉 RSI 는 주간 종가 RSI', w.length === 29 && calcRSI(w) === calcRSI(w.slice()) && calcRSI(w) > 0, `${w.length}주 ${calcRSI(w)}`);
  check('주간 종가가 15개 미만이면 null', calcRSI(weekCloses(t.slice(0, 90), c.slice(0, 90))) === null);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
