// 현재가 옆 "오늘 캔들" 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 캔들 계산을
// 검증한다(trend.mjs · cross.mjs 와 같은 방식).
//
// 두 가지를 고정한다.
//
// 1. 종가는 세션이 고른다. 시간외 가격으로 정규장 캔들의 꼬리를 늘리면 안 되므로
//    정규장 밖에서는 확정된 정규장 종가를 쓴다. 반대로 장중에는 고가·저가가 현재가
//    보다 한 틱 늦게 올 수 있어 몸통이 제 꼬리를 뚫고 나간다 — 조여서 막는다.
//
// 2. 몸통은 최소 1px 이고 주어진 높이 안에 들어온다. 도지(시가 = 종가)는 높이 0 이라
//    그냥 그리면 사라지고, 종가가 저가와 같으면 몸통이 아래로 삐져나간다.
import * as C from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const near = (v, want, eps = 0.01) => Math.abs(v - want) < eps;

check('candleOf 를 indicators.js 가 내보낸다', C.candleOf != null);
check('candleGeom 을 indicators.js 가 내보낸다', C.candleGeom != null);
if (!C.candleOf || !C.candleGeom) {
  console.log('\n필요한 함수가 없어 이후 검사를 건너뜁니다.');
  process.exit(1);
}

const H = 16;
// 장중 종목 하나. candle 은 피드에서 온 정규장 시·고·저다.
const live = (candle, price, extra = {}) => ({
  candle, price, priceSession: 'regular', regularClose: null, ...extra,
});

// --- 1. 값이 없으면 그리지 않는다 -----------------------------------------------
{
  check('quote 자체가 없으면 null', C.candleOf(null) === null);
  check('candle 이 없으면 null', C.candleOf({ price: 100 }) === null);
  check('시가가 없으면 null (야후가 시가를 안 준 경우)',
    C.candleOf(live({ high: 110, low: 90 }, 100)) === null);
  check('시가가 0 이면 null', C.candleOf(live({ open: 0, high: 110, low: 90 }, 100)) === null);
  check('현재가가 없으면 null',
    C.candleOf(live({ open: 100, high: 110, low: 90 }, null)) === null);
}

// --- 2. 장대양봉 ---------------------------------------------------------------
{
  const c = C.candleOf(live({ open: 100, high: 110, low: 99 }, 109));
  check('오르면 up', c.dir === 'up', `${c.open} → ${c.close}`);
  const g = C.candleGeom(c, H);
  check('몸통이 16px 중 12px 넘게 찬다', g.bodyH > 12, `${g.bodyH.toFixed(2)}px`);
  check('몸통 위가 고가 쪽(2px 안)에 붙는다', g.bodyTop < 2, `top ${g.bodyTop.toFixed(2)}`);
  check('꼬리를 그린다', g.flat === false);
}

// --- 3. 도지 — 시가 = 종가 -----------------------------------------------------
{
  const c = C.candleOf(live({ open: 100, high: 105, low: 95 }, 100));
  check('시가 = 종가면 flat', c.dir === 'flat');
  const g = C.candleGeom(c, H);
  check('몸통 높이가 1px 로 남는다 (사라지지 않는다)', g.bodyH === 1, `${g.bodyH}px`);
  check('몸통이 가운데에 온다', near(g.bodyTop, 8), `top ${g.bodyTop}`);
}

// --- 4. 윗꼬리 — 종가가 저가와 같다 --------------------------------------------
{
  const c = C.candleOf(live({ open: 100, high: 120, low: 100 }, 101));
  const g = C.candleGeom(c, H);
  check('몸통이 아래로 삐져나가지 않는다 (top + h <= 16)',
    g.bodyTop + g.bodyH <= H + 0.001, `top ${g.bodyTop.toFixed(2)} + ${g.bodyH.toFixed(2)}`);
  check('몸통이 맨 아래에 붙는다', near(g.bodyTop, 15), `top ${g.bodyTop.toFixed(2)}`);
}

// --- 5. 고가 = 저가 — 하루 내내 한 가격 ----------------------------------------
{
  const c = C.candleOf(live({ open: 100, high: 100, low: 100 }, 100));
  const g = C.candleGeom(c, H);
  check('폭이 0 이면 flat 로 알린다 (0 나누기 없음)', g.flat === true);
  check('flat 도 1px 몸통을 가진다', g.bodyH === 1);
  check('flat 몸통이 가운데에 온다', near(g.bodyTop, 7.5), `top ${g.bodyTop}`);
}

// --- 6. 장중 클램프 — 고가가 현재가보다 늦게 온다 -------------------------------
{
  const c = C.candleOf(live({ open: 274000, high: 281500, low: 273000 }, 283000));
  check('현재가가 피드 고가를 넘으면 고가를 현재가까지 올린다',
    c.high === 283000, `고 ${c.high}`);
  const g = C.candleGeom(c, H);
  check('그래서 몸통이 꼬리 안에 있다', g.bodyTop >= 0 && g.bodyTop + g.bodyH <= H + 0.001);

  const d = C.candleOf(live({ open: 274000, high: 281500, low: 273000 }, 271000));
  check('현재가가 피드 저가보다 낮으면 저가를 내린다', d.low === 271000, `저 ${d.low}`);
  check('내려간 만큼 음봉이다', d.dir === 'down');
}

// --- 7. 시간외 — 정규장 캔들을 늘리지 않는다 ------------------------------------
{
  const c = C.candleOf({
    candle: { open: 270000, high: 281500, low: 269000 },
    price: 290000, priceSession: 'after', regularClose: 274000,
  });
  check('종가로 확정된 정규장 종가를 쓴다', c.close === 274000, `종 ${c.close}`);
  check('시간외 가격이 고가를 늘리지 않는다', c.high === 281500, `고 ${c.high}`);

  // 확정 종가를 아직 못 받았으면(콜드 스타트) 현재가로 버틴다.
  const d = C.candleOf({
    candle: { open: 270000, high: 281500, low: 269000 },
    price: 290000, priceSession: 'after', regularClose: null,
  });
  check('확정 종가가 없으면 현재가로 대체한다', d.close === 290000, `종 ${d.close}`);
  check('그때는 고가도 현재가까지 따라 올라간다', d.high === 290000, `고 ${d.high}`);
}

// --- 8. 장 마감 후 정규장 가격 --------------------------------------------------
// session 은 closed 인데 priceSession 이 regular 인 상태가 정상으로 존재한다
// (session-ui.mjs 의 ['closed','regular'] 조합). 그때 현재가가 그날 종가다.
{
  const c = C.candleOf({
    candle: { open: 270000, high: 281500, low: 269000 },
    price: 280000, priceSession: 'regular', regularClose: null,
  });
  check('마감 후에도 정규장 가격이면 그것이 종가다', c.close === 280000);
}

// --- 9. 차트 캔들 기하 ----------------------------------------------------------
// 화면의 미니 캔들(candleGeom)은 값 범위를 고정 높이에 맞추지만, 차트 캔들은
// Chart.js 가 준 y픽셀을 그대로 쓴다. 그래서 계산이 다르다.
{
  check('간격의 70% 를 몸통 폭으로 쓴다 (3M: 4.3px 간격 → 3px)',
    C.candleWidth(4.3) === 3, `${C.candleWidth(4.3)}px`);
  check('1M 은 간격이 넓다 (12.7px → 9px)',
    C.candleWidth(12.7) === 9, `${C.candleWidth(12.7)}px`);

  check('아무리 좁아도 1px 은 남는다', C.candleWidth(0.5) === 1, `${C.candleWidth(0.5)}px`);
  check('간격이 0 이어도 1px (0 나누기 방어)', C.candleWidth(0) === 1);
  check('간격이 NaN 이어도 1px', C.candleWidth(NaN) === 1);
  check('아무리 넓어도 12px 을 넘지 않는다 (봉 몇 개짜리 구간)',
    C.candleWidth(100) === 12, `${C.candleWidth(100)}px`);
}

// --- 10. 몸통의 위치와 높이 -----------------------------------------------------
// y픽셀은 값이 클수록 작다(위가 0). 시가·종가 어느 쪽이 위든 top 은 더 작은 값이다.
{
  const up = C.candleBody(120, 80); // 시가 아래, 종가 위 → 양봉
  check('양봉은 종가 y 가 top', up.top === 80 && up.h === 40, JSON.stringify(up));

  const down = C.candleBody(80, 120); // 음봉
  check('음봉은 시가 y 가 top', down.top === 80 && down.h === 40, JSON.stringify(down));

  const doji = C.candleBody(100, 100);
  check('도지는 높이 1px 로 남는다 (사라지지 않는다)',
    doji.top === 100 && doji.h === 1, JSON.stringify(doji));

  const tiny = C.candleBody(100, 100.4);
  check('0.4px 차이도 1px 로 올린다', tiny.h === 1, `${tiny.h}px`);
}

// --- 11. 캔들로 그리는 구간 -----------------------------------------------------
{
  check('3M 은 캔들', C.candleMode('3M', 'candle') === true);
  check('1M 도 캔들', C.candleMode('1M', 'candle') === true);
  check('1Y 는 봉이 1.2px 라 라인', C.candleMode('1Y', 'candle') === false);
  check('1D 는 분봉이라 라인', C.candleMode('1D', 'candle') === false);
  check('1W 도 분봉이라 라인', C.candleMode('1W', 'candle') === false);

  check('line 을 고르면 3M 도 라인', C.candleMode('3M', 'line') === false);
  // 저장값에 모르는 문자열이 들어 있어도 기본값(캔들)으로 본다
  check('모르는 값은 캔들로 본다', C.candleMode('3M', undefined) === true);
  check('CANDLE_TF 는 1M · 3M 둘뿐이다',
    C.CANDLE_TF.size === 2 && C.CANDLE_TF.has('1M') && C.CANDLE_TF.has('3M'));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails ? 1 : 0);
