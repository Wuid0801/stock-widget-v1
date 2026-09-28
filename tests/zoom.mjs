// 끌어서 확대 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 구간 계산을 검증한다
// (candle.mjs · trend.mjs 와 같은 방식).
//
// 두 가지를 고정한다.
//
// 1. 끈 방향과 상관없이 앞뒤가 맞고, 5봉 미만은 확대하지 않는다(클릭 · 손떨림 · 취소).
// 2. 날짜로 기억한 구간이 30초 갱신 · 다음 날 새 봉 · 마지막 봉 시각 변화에도
//    같은 봉을 가리킨다.
import * as Z from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('dragToRange 를 indicators.js 가 내보낸다', typeof Z.dragToRange === 'function');
check('zoomRange 를 indicators.js 가 내보낸다', typeof Z.zoomRange === 'function');
if (typeof Z.dragToRange !== 'function' || typeof Z.zoomRange !== 'function') {
  console.log('\n필요한 함수가 없어 이후 검사를 건너뜁니다.');
  process.exit(1);
}

// --- 1. 끈 구간 -----------------------------------------------------------------
{
  check('왼쪽에서 오른쪽', same(Z.dragToRange(10, 20), { from: 10, to: 20 }));
  check('오른쪽에서 왼쪽으로 끌어도 같다', same(Z.dragToRange(20, 10), { from: 10, to: 20 }));
  check('4봉은 확대하지 않는다', Z.dragToRange(10, 13) === null);
  check('5봉은 확대한다', same(Z.dragToRange(10, 14), { from: 10, to: 14 }));
  check('제자리 클릭은 확대하지 않는다', Z.dragToRange(7, 7) === null);
  check('ZOOM_MIN_BARS 는 5', Z.ZOOM_MIN_BARS === 5);
  check('ZOOM_TF 는 3M · 1Y 둘뿐이다',
    Z.ZOOM_TF.size === 2 && Z.ZOOM_TF.has('3M') && Z.ZOOM_TF.has('1Y'));
}

// --- 2. 날짜 → 봉 번호 -----------------------------------------------------------
// 야후 KRX 일봉은 00:00 UTC(09:00 KST)에 찍힌다. 장중 마지막 봉만 시각이 마지막
// 체결 시각이라 갱신마다 바뀐다(실측 01:26:11 / 01:26:12).
const DAY = 86400000;
const d0 = Date.parse('2026-06-01T00:00:00Z');
const days = (n) => Array.from({ length: n }, (_, i) => d0 + i * DAY);
{
  const times = days(30);
  check('날짜 구간을 봉 번호로 바꾼다',
    same(Z.zoomRange(times, times[5], times[14]), { from: 5, to: 14 }));

  const next = [...times, d0 + 30 * DAY]; // 다음 날 새 봉이 뒤에 붙었다
  check('새 봉이 붙어도 같은 구간',
    same(Z.zoomRange(next, times[5], times[14]), { from: 5, to: 14 }));

  const shifted = times.slice(1); // 1Y 창이 하루 밀려 맨 앞 봉이 빠졌다
  check('앞 봉이 빠지면 번호만 당겨진다',
    same(Z.zoomRange(shifted, times[5], times[14]), { from: 4, to: 13 }));

  const live = [...times.slice(0, 29), d0 + 29 * DAY + 5171000];  // 확대할 때 01:26:11
  const later = [...times.slice(0, 29), d0 + 29 * DAY + 5200000]; // 다음 갱신 01:26:40
  check('마지막 봉 시각이 바뀌어도 그 봉이 구간에 남는다',
    same(Z.zoomRange(later, live[20], live[29]), { from: 20, to: 29 }));

  check('데이터에 없는 구간이면 null',
    Z.zoomRange(times, d0 + 100 * DAY, d0 + 120 * DAY) === null);
  check('남는 봉이 5개 미만이면 null', Z.zoomRange(times, times[27], d0 + 40 * DAY) === null);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails ? 1 : 0);
