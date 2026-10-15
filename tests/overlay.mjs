// 보조 지표(볼린저 밴드 · VWAP · 파라볼릭 SAR …) 계산 — 앱을 띄우지 않고 indicators.js 를 검증한다.
// 기대값은 손으로 셀 수 있는 작은 예로 고정했다.
import { bollinger, vwap, volumeProfile, returnSince, parabolicSar } from '../indicators.js';

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

// --- 매물대 ----------------------------------------------------------------------
{
  // 가격 100~110 을 10칸(칸마다 1). 첫 봉 100~110 거래량 1000 → 칸마다 100.
  // 둘째 봉 105~107 거래량 600 → 105~106, 106~107 칸에 300씩. 셋째 봉은 108 한 가격에 50.
  let p = volumeProfile([110, 107, 108], [100, 105, 108], [1000, 600, 50], 0, 2, 10);
  check('구간의 최저~최고가를 칸으로 나눈다', p.lo === 100 && p.hi === 110 && near(p.step, 1));
  check('봉의 거래량을 그 봉의 저가~고가에 고르게 나눈다',
    near(p.vols[0], 100) && near(p.vols[5], 400) && near(p.vols[6], 400) && near(p.vols[9], 100), JSON.stringify(p.vols));
  check('한 가격뿐인 봉은 그 칸에 통째로', near(p.vols[8], 150), String(p.vols[8]));
  check('가장 많이 쌓인 칸(같으면 아래 칸)', p.poc === 5, String(p.poc));

  p = volumeProfile([110, 107, 108], [100, 105, 108], [1000, 600, 50], 1, 2, 10);
  check('보이는 구간(from~to)만 본다 — 확대하면 그 구간의 매물대', p.lo === 105 && p.hi === 108, `${p.lo}~${p.hi}`);
  check('최고가 한 가격은 맨 위 칸', near(p.vols[9], 50), JSON.stringify(p.vols));

  check('가격 폭이 없으면 null', volumeProfile([5, 5], [5, 5], [10, 10], 0, 1, 10) === null);
  check('거래량이 하나도 없으면 null', volumeProfile([10, 12], [9, 11], [0, 0], 0, 1, 10) === null);
}

// --- 같은 기간 수익률(지수 대비) ----------------------------------------------------
{
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const times = ['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-07'].map(day);
  const closes = [100, 102, 104, 110];
  check('종목 첫 봉과 같은 날 지수 봉부터', near(returnSince(times, closes, day('2026-09-02'), 112.2), 10));
  // 9/3 봉이 없다 → 9/2(102)부터: 107.1 / 102 = +5%
  check('같은 날이 없으면(휴장 차이) 그 앞의 마지막 봉부터', near(returnSince(times, closes, day('2026-09-03'), 107.1), 5));
  // 시각이 달라도 날짜로 맞춘다 — 지수 봉이 13:30 UTC(미국 일봉)에 찍혀 있고 종목 첫 봉이 그날 00:00 UTC 여도 그날 봉부터
  const late = times.map((t) => t + 13.5 * 3600000);
  check('시각이 아니라 날짜로 맞춘다', near(returnSince(late, closes, day('2026-09-02'), 112.2), 10));
  check('지수 시계열이 더 늦게 시작하면 첫 봉부터', near(returnSince(times, closes, day('2026-08-01'), 110), 10));
  check('마지막 값이 없으면 null', returnSince(times, closes, day('2026-09-02'), null) === null);
}

// --- 파라볼릭 SAR ----------------------------------------------------------------
{
  // 손으로 센 예(가속 0.02 · 최대 0.2).
  // 1: 중간값 10 ≥ 9 라 상승으로 시작 — 극값 11, SAR 은 앞 두 봉의 저가 8
  // 2: 8 + .02(11-8) = 8.06 → 앞 두 저가(9 · 8)를 넘지 않게 8. 고가 12 가 새 극값 → 가속 .04
  // 3: 8 + .04(12-8) = 8.16. 고가 13 → 극값 13, 가속 .06
  // 4: 8.16 + .06(13-8.16) = 8.4504 인데 저가 7 이 뚫었다 → 하락 전환, SAR 은 직전 극값 13, 극값 7, 가속 .02
  // 5: 13 + .02(7-13) = 12.88 → 앞 두 고가(9 · 13)보다 낮을 수 없어 13. 저가 6 → 극값 6, 가속 .04
  // 6: 13 + .04(6-13) = 12.72
  const h = [10, 11, 12, 13, 9, 8.5, 8];
  const l = [8, 9, 10, 11, 7, 6, 5];
  const s = parabolicSar(h, l);
  check('첫 봉은 비운다', s.sar[0] === null && s.up[0] === null);
  const want = [8, 8, 8.16, 13, 13, 12.72];
  check('손으로 센 값', want.every((v, i) => near(s.sar[i + 1], v)), JSON.stringify(s.sar));
  check('방향 — 넷째 봉에서 하락 전환', JSON.stringify(s.up) === '[null,true,true,true,false,false,false]', JSON.stringify(s.up));

  // 가속은 0.2 에서 멈춘다: 계속 오르면 SAR 은 직전 SAR + 0.2 × (직전 고가 - 직전 SAR)
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = parabolicSar(up, up.map((v) => v - 1));
  check('가속 상한 0.2', near(r.sar[25], r.sar[24] + 0.2 * (up[24] - r.sar[24])), `${r.sar[25]}`);
  check('계속 오르면 전환이 없다', r.up.slice(1).every((u) => u === true));
  check('봉이 하나뿐이면 아무것도 없다', parabolicSar([1], [1]).sar.every((v) => v === null));
  // 둘째 봉의 중간값이 낮으면 하락으로 시작 — 극값은 두 저가 중 낮은 것, SAR 은 두 고가 중 높은 것
  const dn = parabolicSar([12, 11], [10, 9]);
  check('하락으로 시작', dn.up[1] === false && near(dn.sar[1], 12), JSON.stringify(dn));
}

console.log(fails ? `\nFAIL: ${fails}건` : '\nPASS: 실패 0건');
process.exit(fails ? 1 : 0);
