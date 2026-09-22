// 현재가 옆 "오늘 캔들" 회귀 가드 — 앱을 띄우지 않고 renderer.js 의 캔들 계산만
// 떼어내 검증한다(trend.mjs · cross.mjs 와 같은 방식).
//
// 두 가지를 고정한다.
//
// 1. 종가는 세션이 고른다. 시간외 가격으로 정규장 캔들의 꼬리를 늘리면 안 되므로
//    정규장 밖에서는 확정된 정규장 종가를 쓴다. 반대로 장중에는 고가·저가가 현재가
//    보다 한 틱 늦게 올 수 있어 몸통이 제 꼬리를 뚫고 나간다 — 조여서 막는다.
//
// 2. 몸통은 최소 1px 이고 주어진 높이 안에 들어온다. 도지(시가 = 종가)는 높이 0 이라
//    그냥 그리면 사라지고, 종가가 저가와 같으면 몸통이 아래로 삐져나간다.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './_paths.mjs';

// renderer.js 의 이 두 주석이 잘라내기 경계다. 옮기면 여기도 같이 고쳐야 한다.
const START = '// --- 오늘 캔들';
const END = '// --- 리스트';

const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a < 0 || b < 0) { console.log('FAIL: renderer.js 에서 캔들 블록을 찾지 못함'); process.exit(1); }

const C = new Function(`${src.slice(a, b)}
  return {
    candleOf: typeof candleOf === 'function' ? candleOf : null,
    candleGeom: typeof candleGeom === 'function' ? candleGeom : null,
  };`)();

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const near = (v, want, eps = 0.01) => Math.abs(v - want) < eps;

check('candleOf 가 renderer.js 에 있다', C.candleOf != null);
check('candleGeom 가 renderer.js 에 있다', C.candleGeom != null);
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

console.log(`\n${fails ? `${fails}개 실패` : '전부 통과'}`);
process.exit(fails ? 1 : 0);
