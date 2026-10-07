// 지지·저항 추세선 회귀 가드 — 앱을 띄우지 않고 indicators.js 의 추세선 계산을
// 검증한다(rsi.mjs 와 같은 방식).
//
// 핵심 성질은 하나다: 추세선은 최근 TREND_LOOKBACK 봉을 빼고 만든다.
// 그래야 그 봉들이 선을 뚫을 수 있고, 뚫렸다는 사실을 말할 수 있다.
// 마지막 봉까지 껍질에 넣으면 껍질이 늘 마지막 봉을 감싸므로 선은 정의상
// 절대 뚫리지 않는다 — 돌파가 일어나도 선이 오늘 고가에 다시 맞춰질 뿐이다.
import * as I from '../indicators.js';

// 스위트는 T.LOOKBACK 같은 짧은 이름을 쓴다. 호출부를 건드리지 않으려고
// 모듈을 그대로 펼치고 상수 별칭만 얹는다.
const T = {
  ...I,
  LOOKBACK: I.TREND_LOOKBACK,
  MIN_SPAN: I.TREND_MIN_SPAN,
  MAX_EXTEND: I.TREND_MAX_EXTEND,
};

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

// --- 데이터 만들기 -------------------------------------------------------------
// 고가가 봉당 100원씩 정확히 내려가는 하락 추세. 전부 한 직선 위에 있어
// 껍질이 구간 전체를 잇는 선분 하나가 된다(연장 거리 0).
const decline = (n) => Array.from({ length: n }, (_, i) => 20000 - 100 * i);

// 결정적 의사난수. Math.random 은 재현이 안 돼 쓰지 않는다.
let seed = 20260828;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

console.log(`설정: LOOKBACK=${T.LOOKBACK} MIN_SPAN=${T.MIN_SPAN} MAX_EXTEND=${T.MAX_EXTEND}\n`);

// --- 1. 제외 구간의 봉은 선을 만드는 데 참여하지 않는다 -------------------------
{
  const N = 50;
  const base = decline(N);
  const plain = T.trendLine(base, N, false);

  const spiked = decline(N);
  spiked[N - 1] = 99999; // 마지막 봉만 터무니없이 높게
  const after = T.trendLine(spiked, N, false);

  check('마지막 봉 고가를 99,999 로 바꿔도 저항선 기울기가 그대로다',
    plain && after && plain.slope === after.slope,
    plain && after ? `${plain.slope} → ${after.slope}` : `plain=${plain} after=${after}`);
}

// --- 2. 돌파해도 선이 오늘 고가에 다시 맞춰지지 않는다 --------------------------
{
  const N = 50;
  const highs = decline(N);
  highs[N - 1] = 16000; // 하락선(오늘값 15,100) 위로 급등
  const line = T.trendLine(highs, N, false);

  check('돌파한 날의 저항선 오늘값이 그날 고가보다 낮다',
    line && line.data[N - 1] < highs[N - 1],
    line ? `선 ${line.data[N - 1]} vs 고가 ${highs[N - 1]}` : 'line=null');
}

// --- 3. 돌파를 감지한다 ---------------------------------------------------------
{
  const N = 50;
  const highs = decline(N);
  highs[N - 2] = 16000; // 확정된 봉에서 뚫었다 (선 15,200 → +5.26%)
  highs[N - 1] = 16100; // 오늘도 선 위에 있다 (선 15,100 → +6.62%)
  const line = T.trendLine(highs, N, false);
  const bo = line && T.breakoutOf && T.breakoutOf(line, highs, N, false);

  check('저항 돌파가 뚫은 확정 봉에서 잡힌다', !!bo && bo.at === N - 2,
    bo ? `at=${bo.at}` : `bo=${bo}`);
  check('돌파 폭은 마지막 봉 기준 1,000원 · 약 6.6% 다',
    !!bo && Math.round(bo.gap) === 1000 && Math.abs(bo.pct - 1000 / 15100) < 1e-9,
    bo ? `gap=${bo.gap} pct=${bo.pct}` : '');
}

// --- 3b. 마지막 봉에서만 뚫은 것은 아직 돌파가 아니다 ---------------------------
// 마지막 봉은 장중에 고가·저가가 계속 움직인다(실시간 값으로 덮어쓴다). 그 봉으로
// 돌파를 판정하면 배지가 장중에 떴다 사라지고, 무효가 되면 다음 날 또 뜬다 —
// 크로스 배지에서 같은 이유로 확정 봉만 보기로 했다.
{
  const N = 50;
  const highs = decline(N);
  highs[N - 1] = 16000; // 오늘만 선 위로 (+5.96%)
  const line = T.trendLine(highs, N, false);
  const bo = line && T.breakoutOf && T.breakoutOf(line, highs, N, false);
  check('오늘 봉만 뚫었으면 돌파로 보고하지 않는다', !!line && bo === null,
    bo ? `at=${bo.at} pct=${(bo.pct * 100).toFixed(2)}%` : (line ? '' : 'line=null'));
}

// --- 4. 뚫지 않았으면 돌파가 아니다 ---------------------------------------------
{
  const N = 50;
  const highs = decline(N); // 마지막 봉도 정확히 선 위에 있다(gap 0)
  const line = T.trendLine(highs, N, false);
  const bo = line && T.breakoutOf && T.breakoutOf(line, highs, N, false);
  check('선에 닿기만 하고 넘지 않으면 돌파가 아니다', line && bo === null,
    bo ? `gap=${bo.gap}` : '');
}

// --- 5. 지지선도 같은 성질을 갖는다 ---------------------------------------------
{
  const N = 50;
  const lows = decline(N);
  lows[N - 2] = 14000; // 하락 지지선(그 봉 값 15,200) 아래로 이탈
  const line = T.trendLine(lows, N, true);
  const bo = line && T.breakoutOf && T.breakoutOf(line, lows, N, true);

  check('지지선 이탈이 잡히고 선은 저가에 맞춰지지 않는다',
    !!line && !!bo && bo.at === N - 2 && line.data[N - 2] > lows[N - 2],
    line ? `선 ${line.data[N - 2]} vs 저가 ${lows[N - 2]}` : 'line=null');
}

// --- 6. 최근까지 유효하지 않은 선분은 채택하지 않는다 ---------------------------
// 50봉 상승 뒤 급락. 위쪽 껍질의 최장 선분은 상승 구간이라 끝점이 한참 과거에
// 있고, 그걸 끝까지 연장하면 실제 고가보다 한참 위를 가리킨다(1Y 저항 +75% 사례).
{
  const N = 76;
  const highs = Array.from({ length: N }, (_, i) => (i <= 50 ? 10000 + 200 * i : 20000 - 400 * (i - 50)));
  const line = T.trendLine(highs, N, false);
  check('상승 뒤 급락 구간에서는 저항선을 채택하지 않는다', line === null,
    line ? `채택됨 (끝점 ${line.to}봉, 창 끝 ${N - 1 - T.LOOKBACK}봉, 오늘값 ${Math.round(line.data[N - 1])})` : '');
}

// --- 6b. 끝점에서 피팅 창 끝까지 10봉 넘게 연장하지 않는다 -----------------------
// 0~30봉은 봉당 -100 인 한 직선이고, 31봉부터는 그 선의 95% 로 내려앉는다. 최장 선분은
// 0→30 이라 연장 거리는 창 끝(N - LOOKBACK - 1)까지로 정해진다. 창끝 이격은 5.3% 라
// 다른 검사는 다 통과하고 이 검사만 걸린다.
{
  const sag = (n) => Array.from({ length: n }, (_, i) => (i <= 30 ? 20000 - 100 * i : 0.95 * (20000 - 100 * i)));
  const ten = T.trendLine(sag(46), 46, false);    // 창 끝 40봉 → 10봉 연장
  const eleven = T.trendLine(sag(47), 47, false); // 창 끝 41봉 → 11봉 연장
  check('끝점에서 창 끝까지 10봉이면 그리고 11봉이면 그리지 않는다',
    !!ten && ten.to === 30 && eleven === null,
    `10봉 ${ten ? `${ten.from}→${ten.to}` : 'null'} · 11봉 ${eleven ? `${eleven.from}→${eleven.to}` : 'null'}`);
}

// --- 7. 구간이 짧으면 채택하지 않는다 -------------------------------------------
// decline(N) 은 한 직선이라 선분이 피팅 창 전체다 — 0 부터 N - LOOKBACK - 1 봉까지.
{
  const short = T.trendLine(decline(25), 25, false);  // 0→19, 19봉
  const enough = T.trendLine(decline(26), 26, false); // 0→20, 20봉
  check('선분이 19봉이면 그리지 않고 20봉이면 그린다',
    short === null && !!enough && enough.to - enough.from === 20,
    `19봉 ${short ? '채택됨' : 'null'} · 20봉 ${enough ? `span ${enough.to - enough.from}` : 'null'}`);
}

// --- 8. 껍질 성질: 피팅 구간 안에서는 아무 봉도 선을 넘지 않는다 ----------------
{
  const N = 60;
  const highs = Array.from({ length: N }, (_, i) => Math.round(18000 - 80 * i + (rnd() - 0.5) * 600));
  const line = T.trendLine(highs, N, false);
  let over = 0;
  if (line) {
    for (let i = line.from; i <= N - 1 - T.LOOKBACK; i++) if (highs[i] > line.data[i] + 1e-9) over++;
  }
  check('피팅 구간 안에서 저항선을 넘는 봉이 없다', !!line && over === 0,
    line ? `${over}봉 초과` : 'line=null');
}

// --- 9. 스치듯 넘은 것은 돌파가 아니다 -----------------------------------------
// 실측에서 Apple 3M 저가가 지지선을 0.035%(11센트) 스쳤다. 그걸 "이탈" 로 띄우면
// 배지에 0.0% 가 찍힌다 — 안 보이는 것보다 그럴듯한데 틀린 숫자가 나쁘다.
{
  const N = 50;
  const highs = decline(N);
  highs[N - 2] = 15215; // 선 15,200 대비 +0.10% (확정 봉이라 판정 대상이다)
  const line = T.trendLine(highs, N, false);
  const bo = line && T.breakoutOf && T.breakoutOf(line, highs, N, false);
  check('선을 0.1% 스친 것은 돌파가 아니다', !!line && bo === null,
    bo ? `pct=${(bo.pct * 100).toFixed(3)}%` : (line ? '' : 'line=null'));
}

// --- 10. 값이 0 이하로 내려가는 선은 그리지 않는다 -----------------------------
// 급락 종목에서 지지선을 앞으로 연장하면 주가가 음수인 지점을 가리킬 수 있다.
// 0 이하의 가격은 뜻이 없고, 정규 데이터셋이라 y축이 그 값까지 늘어나 눈금에
// 음수가 찍힌다. 예전 ±10% 검사가 우연히 막아주던 것이라 대체 규칙이 필요하다.
{
  const N = 62; // 3M
  const bottom = 800; // 50봉 만에 10,000 → 800 (92% 급락) 뒤 반등
  const lows = [];
  for (let i = 0; i < N; i++) {
    lows.push(Math.round(i <= 50
      ? 10000 - ((10000 - bottom) * i) / 50
      : bottom + ((i - 50) * (10000 - bottom)) / 50 * 1.6));
  }
  const line = T.trendLine(lows, N, true);
  const drawn = line ? line.data.filter((v) => v != null) : [];
  const worst = drawn.length ? Math.min(...drawn) : null;
  check('92% 급락 구간에서 음수로 내려가는 지지선은 채택하지 않는다',
    line === null || worst > 0,
    line ? `오늘값 ${Math.round(line.data[N - 1])}, 최솟값 ${Math.round(worst)}` : '');
}

// --- 10b. 오늘값이 0 이하인 선은 이 검사가 거른다 ---------------------------------
// 위 급락 사례는 창끝 이격 검사에도 걸려서 0 이하 검사를 따로 지키지 못한다. 여기서는
// 피팅 창(0~24봉)이 봉당 -100 인 한 직선이라 이격 0 · 연장 0 이고, 선은 마지막 봉(29봉)
// 에서 a − 2,900 이 된다. 빼둔 봉은 500 으로 받쳐 선 위에 둔다.
{
  const N = 30;
  const lows = (a) => Array.from({ length: N }, (_, i) => Math.max(a - 100 * i, 500));
  const zero = T.trendLine(lows(2900), N, true);
  const above = T.trendLine(lows(3000), N, true);
  check('오늘값이 정확히 0 이면 그리지 않고 100 이면 그린다',
    zero === null && !!above && Math.abs(above.data[N - 1] - 100) < 1e-9,
    `0 → ${zero ? '채택됨' : 'null'} · 100 → ${above ? Math.round(above.data[N - 1]) : 'null'}`);
}

// --- 11. 선 값이 0 이하일 때 돌파를 오판하지 않는다 -----------------------------
// gap / y 로 비율을 재므로 y 가 음수면 부호가 뒤집힌다. 저가가 선보다 한참 위에
// 있는데도(이탈이 아닌데도) 큰 이탈로 보고하던 실측 사례가 있었다.
{
  const N = 50;
  // 선은 제외 구간(45~49봉)에서 음수, 저가는 그보다 훨씬 위(=이탈 아님)
  const data = Array.from({ length: N }, (_, i) => 1000 - 30 * i);
  const lows = Array(N).fill(2000);
  const bo = T.breakoutOf && T.breakoutOf({ data, from: 0 }, lows, N, true);
  check('선 값이 음수인 구간에서 이탈로 오판하지 않는다', bo === null,
    bo ? `at=${bo.at} 선 ${data[bo.at]} vs 저가 ${lows[bo.at]} → pct=${(bo.pct * 100).toFixed(2)}%` : '');
}

// --- 12. 피팅 창 끝에서 실제값과 크게 벌어진 선은 채택하지 않는다 ---------------
// 0 을 넘더라도 현재가에서 한참 떨어진 선은 정보가 아니다. 이격을 피팅 창 끝에서
// 재는 게 핵심이다 — 그 지점은 제외 구간 앞이라 돌파가 값에 영향을 주지 않는다.
// 실측: 실제 8개 선은 |이격| ≤ 6.50%, 급락 시나리오는 36% · 71%.
{
  const cases = [[4000, '60%'], [2000, '80%']];
  for (const [bottom, label] of cases) {
    const N = 62;
    const lows = [];
    for (let i = 0; i < N; i++) {
      lows.push(Math.round(i <= 50
        ? 10000 - ((10000 - bottom) * i) / 50
        : bottom + ((i - 50) * (10000 - bottom)) / 50 * 1.6));
    }
    const line = T.trendLine(lows, N, true);
    const at = N - T.LOOKBACK - 1;
    const drift = line ? (line.data[at] - lows[at]) / lows[at] : null;
    check(`${label} 급락 구간의 지지선은 창끝 이격이 커서 채택하지 않는다`, line === null,
      line ? `채택됨 (창끝 이격 ${(drift * 100).toFixed(2)}%, 오늘값 ${Math.round(line.data[N - 1])})` : '');
  }
}

// --- 13. 날짜는 처음 넘은 봉, 폭은 마지막 봉 기준 --------------------------------
// 배지가 "저항 돌파 +N% · M일 전" 이라 M 은 뚫은 날이어야 한다. 예전에는 이탈이
// 가장 큰 봉을 골랐는데, 저항선은 내려가고 주가는 오르니 초과폭이 날마다 커져서
// 늘 최근 봉이 뽑혔다 — SK하이닉스 실측에서 09-07 에 뚫었는데 09-10 을 가리켰다.
// 폭은 반대로 마지막 봉 기준이어야 "지금 얼마나 위에 있나" 가 된다.
{
  const N = 50;
  const highs = Array.from({ length: N }, (_, i) => 100000 - 1800 * i);
  const line = T.trendLine(highs, N, false);
  if (!line) { check('급한 저항선이 채택된다(선행 조건)', false, 'line=null'); }
  else {
    const h2 = highs.slice();
    h2[45] = line.data[45] + 1200; // 선 19,000 → 6.32% (여기서 처음 뚫었다)
    h2[47] = line.data[47] * 1.08; // 선 15,400 → 8% (확정 봉 중에서는 이탈이 여기가 더 크다)
    h2[49] = line.data[49] + 1000; // 선 11,800 → 8.47% (마지막 봉이라 날짜 후보가 아니고, 폭만 잰다)
    const bo = T.breakoutOf(line, h2, N, false);
    check('날짜는 처음 넘은 45봉이다', !!bo && bo.at === 45,
      bo ? `at=${bo.at}` : 'bo=null');
    check('폭은 마지막 봉 기준 8.47% 다', !!bo && Math.abs(bo.pct - 1000 / line.data[49]) < 1e-9,
      bo ? `${(bo.pct * 100).toFixed(2)}%` : '');
  }
}

// --- 14. 뚫은 뒤 되밀려도 뚫은 날은 그대로 짚는다 --------------------------------
{
  const N = 50;
  const highs = Array.from({ length: N }, (_, i) => 100000 - 1800 * i);
  const line = T.trendLine(highs, N, false);
  const h2 = highs.slice();
  h2[45] = line.data[45] + 1200;  // 뚫음
  h2[49] = line.data[49] - 500;   // 마지막 봉은 선 아래로 되밀림
  const bo = T.breakoutOf(line, h2, N, false);
  check('되밀려도 날짜는 45봉', !!bo && bo.at === 45, bo ? `at=${bo.at}` : 'bo=null');
  check('되밀린 폭은 음수로 나온다', !!bo && bo.pct < 0, bo ? `${(bo.pct * 100).toFixed(2)}%` : '');
}

// --- 16. 돌파한 봉으로 선이 다시 그어지면 배지를 끈다 ---------------------------
// 뚫은 봉도 5봉이 지나면 피팅 창에 들어가고, 껍질이 그 봉을 지나도록 선을 다시 잡는다.
// 오름세가 이어지면 다음 봉이 새 선을 또 넘는다 — 예전에는 그래서 배지가 몇 주씩
// 켜진 채 날짜가 늘 "4봉 전"에 머물렀다. 오래된 돌파는 이미 새 추세의 일부라,
// 뚫은 날부터 4봉(1~4봉 전)까지만 말한다.
{
  // 65봉까지 봉당 80원씩 내려가는 저항(5봉마다 한 번 선에 닿는다), 66봉부터 봉당 250원씩 오른다
  const up = Array.from({ length: 85 }, (_, i) => (i < 66
    ? 20000 - 80 * i - (i % 5 === 0 ? 0 : 300)
    : 20000 - 80 * 66 + 900 + 250 * (i - 66)));
  const down = up.map((v) => 40000 - v); // 뒤집으면 지지선 이탈이다
  for (const [vals, low, name] of [[up, false, '저항'], [down, true, '지지']]) {
    const seen = [];
    for (let len = 68; len <= 84; len++) {
      const line = T.trendLine(vals, len, low);
      const bo = line && T.breakoutOf(line, vals, len, low);
      seen.push(bo ? `${bo.at}봉/${len - 1 - bo.at}` : '-');
    }
    check(`${name}: 뚫은 66봉을 1~4봉 전까지만 짚고, 그 봉으로 선이 다시 그어진 뒤로는 끈다`,
      seen.join(' ') === '66봉/1 66봉/2 66봉/3 66봉/4 - - - - - - - - - - - - -', seen.join(' '));
  }
}

// --- 17. 두 선이 만나는 봉 -----------------------------------------------------
// 수렴 배지가 이 값으로 "수렴 n거래일" 을 말한다. 실데이터에서 아직 한 번도 뜬 적이
// 없어서, 부호가 뒤집혀 배지가 사라져도 화면만으로는 알 수 없다.
// 지지 100 + 10i · 저항 300 − 10i 는 10봉에서 만난다. 시작 봉(from)을 0 이 아니게 둬
// y절편을 data[from] 에서 거꾸로 구하는 계산까지 본다.
{
  const ln = (from, b, slope) => ({ from, slope, data: Array.from({ length: 30 }, (_, i) => (i < from ? null : b + slope * i)) });
  const sup = ln(5, 100, 10);
  const res = ln(2, 300, -10);
  check('수렴하는 두 선은 10봉에서 만난다', T.meetAt(sup, res) === 10 && T.meetAt(res, sup) === 10,
    `${T.meetAt(sup, res)} · ${T.meetAt(res, sup)}`);
  check('기울기가 같으면(평행) 만나지 않는다', T.meetAt(sup, ln(2, 300, 10)) === null);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
