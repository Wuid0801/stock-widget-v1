// RSI(14) 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 calcRSI 를 검증한다.
//
// 아래 기대값은 Wilder 의 표준 예제 종가로 계산한 결과이며,
// 널리 쓰이는 technicalindicators 라이브러리의 RSI 와 소수 2자리까지
// 전부 일치함을 확인했다(Wilder 예제 + 실제 국내 5종목 일봉, 총 1166개 값).
// 여기서는 외부 의존성 없이 그 결과를 고정해 두어 구현이 바뀌면 잡히게 한다.
import { calcRSI, weekCloses, rsiSeries, rsiSignal, sma, rsiScale, RSI_MIN_SPAN } from '../indicators.js';

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

// 봉마다의 RSI(차트의 RSI 선) — 같은 와일더 계산이라 i 번째 값은 처음부터 i 번째 봉까지의 calcRSI 다. 앞 14봉은 빈 칸.
{
  const s = rsiSeries(CLOSES);
  check('봉 수 그대로', s.length === CLOSES.length);
  check('앞 14봉은 null', s.slice(0, 14).every((v) => v === null));
  check('봉마다 calcRSI 와 같다', s.slice(14).every((v, k) => v === calcRSI(CLOSES.slice(0, 15 + k))));
  check('15개 미만이면 전부 null', rsiSeries(CLOSES.slice(0, 14)).every((v) => v === null) && rsiSeries([]).length === 0);
  check('변동이 없으면 50 · 상승만이면 100', rsiSeries(Array(20).fill(7))[19] === 50
    && rsiSeries(Array.from({ length: 20 }, (_, i) => i))[19] === 100);
  // 시간외 빈 칸을 채운 평평한 봉(직전 종가 그대로)은 평균 상승 · 하락을 같은 비율로 줄여 RSI 를 움직이지 않는다
  const flat = rsiSeries([...CLOSES, ...Array(5).fill(CLOSES.at(-1))]);
  check('평평한 봉은 RSI 를 바꾸지 않는다', flat.slice(-6).every((v) => Math.abs(v - s.at(-1)) < 1e-9));
}

// RSI 시그널 — RSI 의 단순 평균(기본 9봉). RSI 의 빈 칸은 건너뛰고 RSI 가 9개 모인 봉부터.
{
  const r = rsiSeries(CLOSES);
  const g = rsiSignal(r);
  check('봉 수 그대로', g.length === r.length);
  check('RSI 가 9개 모이기 전(22봉)은 null', g.slice(0, 22).every((v) => v === null) && g[22] != null);
  const want = sma(r.slice(14), 9);
  check('RSI 의 9봉 평균', g.slice(14).every((v, k) => (v === null ? want[k] === null : Math.abs(v - want[k]) < 1e-9)));
  check('기간을 바꿀 수 있다', rsiSignal(r, 6)[19] != null && rsiSignal(r, 6)[18] === null);
  check('RSI 가 없으면 전부 null', rsiSignal([null, null]).every((v) => v === null));
}

// RSI 칸 눈금 — 보이는 RSI · 시그널의 최저~최고에 맞춘다. 0~100 이면 30~70 에서만 움직여 45px 칸에서 선이 납작했다.
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const ticks = (s) => JSON.stringify(s.ticks);
  const s = rsiScale([null, 39.2, 50, 66.4, null, 45]);
  const pad = (66.4 - 39.2) / 10;
  check('최저 · 최고에 폭의 1/10 여유', near(s.min, 39.2 - pad) && near(s.max, 66.4 + pad), JSON.stringify(s));
  check('눈금 숫자는 최저 · 최고 자리(반올림)', ticks(s) === '[39,66]', ticks(s));
  const flat = rsiScale([48, 53]);
  check('거의 안 움직이면 폭은 RSI_MIN_SPAN(가운데 기준)', RSI_MIN_SPAN === 20
    && near(flat.max - flat.min, RSI_MIN_SPAN * 1.2) && near((flat.min + flat.max) / 2, 50.5), JSON.stringify(flat));
  check('그때 눈금 숫자는 그 폭의 양 끝', ticks(flat) === '[41,61]', ticks(flat));
  const low = rsiScale([2, 12]);
  check('0 밑으로 내려가지 않는다(폭은 그대로 위로 민다)', low.min === 0 && near(low.max, 24), JSON.stringify(low));
  const high = rsiScale([95, 99]);
  check('100 위로 올라가지 않는다', high.max === 100 && near(high.min, 76), JSON.stringify(high));
  const wide = rsiScale([8, 95]);
  check('거의 다 쓰면 0~100 에 30 · 70', wide.min === 0 && wide.max === 100 && ticks(wide) === '[30,70]', JSON.stringify(wide));
  const in70 = rsiScale([40, 90]);
  check('30 · 70 이 범위 안이고 끝 숫자와 떨어져 있으면 그 숫자도', ticks(in70) === '[40,70,90]', ticks(in70));
  const by70 = rsiScale([45, 78]);
  check('끝 숫자와 칸의 1/4 안으로 붙으면 30 · 70 숫자는 뺀다(겹친다)', ticks(by70) === '[45,78]', ticks(by70));
  check('값이 없으면 0~100', JSON.stringify(rsiScale([null, null])) === JSON.stringify({ min: 0, max: 100, ticks: [30, 70] }));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
