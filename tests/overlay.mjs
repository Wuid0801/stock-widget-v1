// 보조 지표(볼린저 밴드 · VWAP) 계산 — 앱을 띄우지 않고 indicators.js 를 검증한다.
// 기대값은 손으로 셀 수 있는 작은 예로 고정했다.
import { bollinger, vwap } from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;

// --- 볼린저 밴드 -----------------------------------------------------------------
{
  // 1..5 의 평균 3, 모집단 표준편차 √2 → 3 ± 2√2
  const b = bollinger([1, 2, 3, 4, 5], 5, 2);
  check('구간이 모자란 앞 네 칸은 비운다', b.upper.slice(0, 4).every((v) => v === null) && b.lower.slice(0, 4).every((v) => v === null));
  check('평균 ± k × 모집단 표준편차', near(b.upper[4], 3 + 2 * Math.SQRT2) && near(b.lower[4], 3 - 2 * Math.SQRT2),
    `${b.upper[4]} / ${b.lower[4]}`);

  const flat = bollinger(new Array(25).fill(100), 20, 2);
  check('움직임이 없으면 위 · 아래가 평균과 같다', near(flat.upper[24], 100) && near(flat.lower[24], 100));

  // 구간이 한 칸씩 밀린다: [2..6] 의 평균 4
  const slide = bollinger([1, 2, 3, 4, 5, 6], 5, 1);
  check('다음 칸은 다음 다섯 봉으로', near(slide.upper[5], 4 + Math.SQRT2) && near(slide.lower[5], 4 - Math.SQRT2));
  check('기본값은 20일 ± 2', bollinger(new Array(19).fill(1)).upper.every((v) => v === null)
    && bollinger(new Array(20).fill(1)).upper[19] === 1);
}

// --- VWAP ------------------------------------------------------------------------
{
  // 대표가 (고 + 저 + 종) / 3: 첫 봉 (12 + 9 + 9) / 3 = 10, 둘째 봉 (21 + 18 + 21) / 3 = 20
  const highs = [12, 21, 30, 40];
  const lows = [9, 18, 30, 40];
  const closes = [9, 21, 30, 40];
  let v = vwap(highs, lows, closes, [100, 300, 0, 100]);
  check('첫 봉은 그 봉의 대표가', near(v[0], 10), String(v[0]));
  check('거래량으로 가중한 누적 평균', near(v[1], (10 * 100 + 20 * 300) / 400), String(v[1]));
  check('거래량 0 인 봉은 직전 값을 잇는다', near(v[2], v[1]), String(v[2]));
  check('다음 봉부터 다시 누적', near(v[3], (10 * 100 + 20 * 300 + 40 * 100) / 500), String(v[3]));

  // 시간외 봉(use 거짓)은 계산에서 빼고 그 칸은 비운다
  v = vwap(highs, lows, closes, [100, 300, 0, 100], (i) => i !== 0 && i !== 3);
  check('뺀 봉의 칸은 null', v[0] === null && v[3] === null);
  check('뺀 봉의 거래량은 평균에 들어가지 않는다', near(v[1], 20) && near(v[2], 20), `${v[1]} ${v[2]}`);

  v = vwap([1, 2], [1, 2], [1, 2], [0, 0]);
  check('거래량이 아직 없으면 비운다', v.every((x) => x === null));
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
