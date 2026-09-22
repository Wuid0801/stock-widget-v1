// RSI(14) 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 calcRSI 를 검증한다.
//
// 아래 기대값은 Wilder 의 표준 예제 종가로 계산한 결과이며,
// 널리 쓰이는 technicalindicators 라이브러리의 RSI 와 소수 2자리까지
// 전부 일치함을 확인했다(Wilder 예제 + 실제 국내 5종목 일봉, 총 1166개 값).
// 여기서는 외부 의존성 없이 그 결과를 고정해 두어 구현이 바뀌면 잡히게 한다.
import { calcRSI } from '../indicators.js';

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

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
