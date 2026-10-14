// 이평선 백테스트("추세 점검") 계산 가드 — 앱을 띄우지 않고 backtest.js 만 본다.
//
// 지켜야 할 것은 셋이다.
// 1. 미래 값을 쓰지 않는다 — 종가 t 로 판단하고 종가 t+1 에 체결한다. 끝나지 않은 창은 뺀다.
// 2. 우연을 "나음"으로 말하지 않는다 — 무작위 걸음 주가에서 판정이 5% 안팎으로만 나와야 한다.
// 3. 볼 때마다 같다 — 난수는 종목 코드로 정해진다.
import * as B from '../backtest.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// --- 데이터 만들기 -------------------------------------------------------------
const DAY = 86400000;
const day = (i) => Date.UTC(2021, 0, 4) + i * DAY;
const series = (n, f) => ({ c: Array.from({ length: n }, (_, i) => f(i)), t: Array.from({ length: n }, (_, i) => day(i)) });
const last = (a) => a[a.length - 1];
// 표류 없는 무작위 걸음(로그 정규, 일 변동 vol). 시드가 같으면 같은 주가.
function walk(seed, n = 1231, vol = 0.02) {
  const r = B.mulberry32(seed);
  return series(n, (() => { let p = 10000; return (i) => {
    if (i) p *= Math.exp(vol * Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r()));
    return p;
  }; })());
}

// --- 1. 쓸 수 있는 봉 ----------------------------------------------------------
{
  const s = walk(1, 501);
  const u = B.usableSeries(s.c, s.t, false);
  check('마지막 봉을 뺀다 (501봉 → 500봉)', u && u.closes.length === 500 && last(u.closes) === s.c[499]);
  check('500봉이 안 되면 null (500봉 → 499봉)', B.usableSeries(s.c.slice(0, 500), s.t.slice(0, 500), false) === null);

  const j = walk(2, 801);
  for (let i = 100; i < 801; i++) j.c[i] *= 1.4; // 100번 봉에서 +40% — 액면 병합 같은 이상
  const cut = B.usableSeries(j.c, j.t, true);
  check('국내: 이상 봉부터 쓴다', cut && cut.cut && cut.closes.length === 700 && cut.closes[0] === j.c[100],
    cut ? `${cut.closes.length}봉` : String(cut));
  check('해외: 이상 봉 검사를 하지 않는다', B.usableSeries(j.c, j.t, false).closes.length === 800);

  const k = walk(3, 801);
  for (let i = 400; i < 801; i++) k.c[i] *= 1.4;
  check('국내: 이상 봉 뒤로 500봉이 안 남으면 데이터 확인 필요',
    B.usableSeries(k.c, k.t, true)?.error === 'data');
  check('국내: 원래 짧으면 이상 봉이 있어도 null',
    B.usableSeries(k.c.slice(0, 450), k.t.slice(0, 450), true) === null);

  // 진짜 상한가 · 하한가는 이상이 아니다. 야후 실데이터(2026-10-12)에서 에코프로비엠 2023-11-06
  // 230,000 → 299,000(정확히 +30% — 부동소수로는 0.30000000000000004)과 한화오션 2024-11-08
  // 27,800 → 36,200(+30.2% — 야후 전일 종가가 기준가와 한 틱 다르다)이 잘려 "3년" · "데이터 확인 필요" 가 됐다.
  const limit = (from, to) => {
    const x = walk(4, 801);
    const scale = (x.c[299] * to) / from / x.c[300]; // 300번 봉이 299번 봉 대비 from → to 로 움직이게
    for (let i = 300; i < 801; i++) x.c[i] *= scale;
    return B.usableSeries(x.c, x.t, true);
  };
  check('국내: 정확히 +30% 상한가는 자르지 않는다', limit(230000, 299000)?.cut === false);
  check('국내: 기준가와 한 틱 어긋난 +30.2% 도 자르지 않는다', limit(27800, 36200)?.cut === false);
  check('국내: 하한가 -30% 도 자르지 않는다', limit(100000, 70000)?.cut === false);
  check('국내: 1:1 무상증자(-50%)는 자른다', limit(100000, 50000)?.cut === true);

  // 0 이하 · 숫자가 아닌 종가는 빠진 봉처럼 버린다. 해외 종목은 이상 봉 검사가 없어 0 이 그대로 들어가
  // 수익률이 Infinity · NaN 이 되고, 툴팁이 NaN 으로 차며 엉뚱한 "못함" 이 났다(재검증 robust-2).
  for (const bad of [0, -5, NaN, null]) {
    const z = walk(7, 801);
    z.c[300] = bad;
    const u = B.usableSeries(z.c, z.t, false);
    check(`해외: 종가 ${bad} 인 봉은 버린다`, u && u.closes.length === 799 && u.closes.every((c) => Number.isFinite(c) && c > 0)
      && !u.times.includes(z.t[300]), u ? `${u.closes.length}봉` : String(u));
    const r = B.trendCheck('AAPL', z.c, z.t, { domestic: false, cost: 0.001, rotations: 20, paths: 20 });
    const nums = [r.rule.strat.total, r.rule.strat.cagr, r.rule.strat.mdd, r.rule.hold.total, r.rule.nullMdd, r.fast.total];
    check(`해외: 종가 ${bad} 가 섞여도 숫자가 모두 유한하다`, nums.every(Number.isFinite), nums.join(','));
  }
  const zd = walk(8, 801);
  zd.c[300] = 0;
  const ud = B.usableSeries(zd.c, zd.t, true);
  check('국내: 종가 0 은 이상 봉으로 자르지 않고 버린다', ud && ud.cut === false && ud.closes.length === 799,
    JSON.stringify(ud && { 봉: ud.closes?.length, cut: ud.cut, error: ud.error }));
}

// --- 2. 다음 날 종가 체결 · 비용 (손으로 센 값) ---------------------------------
{
  // 판단 d[i] 는 종가 i+1 에 체결된다. 비용 0.2% 면 체결마다 0.999 를 곱한다.
  //  t=1 사기(d0)  t=2 +10%  t=3 +10% 후 팔기(d2)  t=5 사기(d4)  t=6 -9.09% 후 마지막이라 팔기
  const closes = [100, 100, 110, 121, 121, 110, 100];
  const r = B.equityOf(closes, [true, true, false, false, true, true, true], 0, 0.002);
  check('누적 = 0.999⁴ × 1.1 − 1', near(r.total, 0.999 ** 4 * 1.1 - 1), String(r.total));
  check('진입 2회 · 체결 4회 · 보유 3/5 구간', r.entries === 2 && r.trades === 4 && near(r.inShare, 0.6));
  check('최대 낙폭은 체결 비용을 반영한 고점 기준', near(r.mdd, 1 - 0.999 ** 2 / 1.1), String(r.mdd));

  const h = B.holdOf(closes, 0, 0.002);
  check('그냥 보유: 종가 1 에 사서 마지막 종가에 판다', near(h.total, 0.999 ** 2 - 1) && near(h.mdd, 1 - 100 / 121));

  // 판단한 날 종가에 체결하는 구현이면 t=2 의 +10% 를 하나 더 먹는다
  check('판단한 날 종가에 체결하지 않는다', !near(r.total, 0.999 ** 4 * 1.21 - 1));
}

// --- 3. 20/60 규칙 -------------------------------------------------------------
{
  const up = series(600, (i) => 100 * 1.002 ** i);
  const bt = B.ruleBacktest(up.c, up.t, 5, 20, 0.0025);
  check('오르기만 하면 보유 상태이고, 5일선이 처음 생긴 날부터다', bt.on === true && bt.since === up.t[19]);
  check('시작은 60일선이 처음 생기는 봉 다음 날', bt.from === up.t[B.BT_START + 1] && bt.to === last(up.t));
  check('오르기만 하면 진입 1회', bt.strat.entries === 1);

  // t 이후 값을 바꿔도 t 까지의 판단은 같다
  const a = walk(4, 700);
  const b = { c: a.c.map((v, i) => (i > 400 ? v * (1 + 0.3 * Math.sin(i)) : v)), t: a.t };
  const wa = B.ruleBacktest(a.c, a.t, 20, 60, 0.0025).want;
  const wb = B.ruleBacktest(b.c, b.t, 20, 60, 0.0025).want;
  check('t 이후 가격을 바꿔도 t 까지의 판단이 같다', wa.slice(0, 401).every((v, i) => v === wb[i]));
}

// --- 4. 회전 판정 --------------------------------------------------------------
{
  // 무작위 걸음에는 규칙이 쓸모 있을 리 없다 → 판정이 1% 끝(양쪽 2%)에 기대 5% 안팎(실측 30/600)
  // 툴팁은 순위를 개수로 보인다("200개 중 규칙보다 낮았던 것 N개"). 판정이 그 개수의 경계(198개 이상 나음 ·
  // 2개 이하 못함)와 어긋나면 "197개 → 나음" 같은 모순이 화면에 나온다.
  let hits = 0, offEdge = 0;
  const edge = Math.floor(B.BT_ROTATIONS * B.BT_ROT_EDGE);
  for (let s = 0; s < 200; s++) {
    const w = walk(1000 + s);
    const u = B.usableSeries(w.c, w.t, false);
    const v = B.rotationVerdict(u.closes, B.ruleBacktest(u.closes, u.times, 20, 60, 0.0025), 0.0025);
    if (v.verdict === 'better' || v.verdict === 'worse') hits++;
    if (v.verdict !== 'few' && v.verdict !== (v.below >= v.count - edge ? 'better' : v.below <= edge ? 'worse' : 'same')) offEdge++;
  }
  check('무작위 걸음 200개에서 나음/못함이 2 ~ 20개', hits >= 2 && hits <= 20, `${hits}개`);
  check('판정이 "규칙보다 낮았던 가짜 타이밍 개수" 경계와 맞는다', offEdge === 0, `어긋남 ${offEdge}`);

  // 추세가 이어지는 주가(평균 60일마다 오름 ↔ 내림)에서는 규칙이 나음으로 나와야 한다 (실측 16/20).
  // 120일마다면 5년에 진입이 4회 안팎이라 대부분 표본 부족이 된다.
  let better = 0;
  for (let s = 0; s < 20; s++) {
    const r = B.mulberry32(9000 + s);
    let mu = 0.004, p = 10000;
    const w = series(1231, (i) => {
      if (i) { if (r() < 1 / 60) mu = -mu; p *= Math.exp(mu + 0.01 * Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r())); }
      return p;
    });
    const u = B.usableSeries(w.c, w.t, false);
    if (B.rotationVerdict(u.closes, B.ruleBacktest(u.closes, u.times, 20, 60, 0.0025), 0.0025).verdict === 'better') better++;
  }
  check('추세가 이어지는 주가 20개 중 14개 이상이 나음', better >= 14, `${better}개`);

  const few = series(600, (i) => 100 * 1.002 ** i);
  const bt = B.ruleBacktest(few.c, few.t, 20, 60, 0.0025);
  check('진입 5회 미만이면 표본 부족', B.rotationVerdict(few.c, bt, 0.0025).verdict === 'few');
}

// --- 5. 이평 배열 --------------------------------------------------------------
{
  const cls = (s) => { const g = B.maRegime(s.c); return `${last(g.cls)}${last(g.up) ? '+' : '-'}`; };
  check('오르기만 하면 정배열 · 20선↑', cls(series(400, (i) => 100 * 1.003 ** i)) === 'up+');
  check('내리기만 하면 역배열 · 20선↓', cls(series(400, (i) => 100 * 0.997 ** i)) === 'down-');
  check('오르다 열흘 급락하면 혼조(20>60) · 20선↓',
    cls(series(400, (i) => (i < 390 ? 100 * 1.003 ** i : 100 * 1.003 ** 390 * 0.97 ** (i - 390)))) === 'mixUp-');
  check('내리다 열흘 급등하면 혼조(20≤60) · 20선↑',
    cls(series(400, (i) => (i < 390 ? 100 * 0.997 ** i : 100 * 0.997 ** 390 * 1.03 ** (i - 390)))) === 'mixDown+');
  const g = B.maRegime(series(200, (i) => 100 + i).c);
  check('120일선이 생기기 전에는 분류하지 않는다', g.cls[B.BT_REGIME_START - 1] === null && g.cls[B.BT_REGIME_START] !== null);
}

// --- 6. 국면 조회 --------------------------------------------------------------
{
  const w = walk(5, 900);
  const u = B.usableSeries(w.c, w.t, false);
  const n = u.closes.length;
  const s = B.cellStats(u.closes, 0.0025, 'up', false);
  check('끝나지 않은 20일 창은 뺀다', s.count === n - 2 - B.BT_H - B.BT_REGIME_START + 1, `${s.count}개`);

  // 칸 넓히기 · 표본 부족은 cellStats 결과와 맞아야 한다
  let fallbacks = 0, mismatch = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const x = walk(seed);
    const v = B.usableSeries(x.c, x.t, false);
    const reg = B.maRegime(v.closes);
    const k = v.closes.length - 1;
    const withSlope = B.cellStats(v.closes, 0.0025, `${reg.cls[k]}${reg.up[k] ? '+' : '-'}`, true);
    const small = (q) => q.episodes < B.BT_MIN_EPISODES || q.days < B.BT_MIN_DAYS;
    const g = B.regimeStats(v.closes, v.times, 0.0025, B.mulberry32(seed), 20);
    if (g.fallback !== small(withSlope)) mismatch++;
    if (g.fallback) {
      fallbacks++;
      if ((g.verdict === 'few') !== small(B.cellStats(v.closes, 0.0025, reg.cls[k], false))) mismatch++;
    } else if (g.verdict === 'few') mismatch++;
  }
  check('칸 넓히기 · 표본 부족이 구간 8개 · 60일 기준을 따른다', mismatch === 0, `어긋남 ${mismatch}`);
  check('무작위 걸음 40개 중 칸을 넓힌 경우가 있다 (위 검사가 빈 검사가 아니다)', fallbacks > 0, `${fallbacks}개`);

  // 오래 오르다 마지막 80일 무너지면 지금 칸(역배열)이 과거에 거의 없다
  const col = series(781, (i) => (i < 700 ? 100 * 1.003 ** i : 100 * 1.003 ** 700 * 0.99 ** (i - 700)));
  const cu = B.usableSeries(col.c, col.t, false);
  const rg = B.regimeStats(cu.closes, cu.times, 0.0025, B.mulberry32(1), 20);
  check('지금 칸이 과거에 드물면 표본 부족', rg.cls === 'down' && rg.verdict === 'few' && rg.lo === undefined);

  // 무작위 걸음에서 판정이 드물어야 한다 (실측 2·3·5 / 60, 경로 100개)
  // 범위 폭도 본다 — 가짜 주가를 섞지 않고 실제 주가를 그대로 다시 재면 범위가 0 폭이 되어
  // 판정이 아예 나오지 않는데, 위 검사(8개 이하)는 그것을 통과시킨다. 실측 폭 6~10%p.
  let hits = 0, narrow = Infinity;
  for (let seed = 0; seed < 60; seed++) {
    const x = walk(5000 + seed);
    const v = B.usableSeries(x.c, x.t, false);
    const r = B.regimeStats(v.closes, v.times, 0.0025, B.mulberry32(seed + 7), 100);
    if (r.verdict === 'better' || r.verdict === 'worse') hits++;
    if (r.lo != null) narrow = Math.min(narrow, r.hi - r.lo);
  }
  check('무작위 걸음 60개에서 나음/못함이 8개 이하', hits <= 8, `${hits}개`);
  check('가짜 주가의 차이 범위가 2%p 보다 넓다 (섞어서 다시 잰다)', narrow > 0.02, `가장 좁은 폭 ${(narrow * 100).toFixed(1)}%p`);

  // 범위는 양쪽 2.5% — 가짜 주가 200개면 위아래로 5개씩 밖에 있어야 한다. 위쪽 끝을 97.5% 자리(sorted[195])로
  // 잡으면 위로는 4개만 밖에 남아 나음이 못함보다 나기 어렵다(신한지주 2026-10-12: 대칭이면 나음).
  // 같은 시드로 가짜 주가를 다시 만들어 범위 밖 개수를 직접 센다. 경로 100개(위 검사)는 양쪽 2개씩이라 이것을 못 잡는다.
  const x = walk(5003);
  const v = B.usableSeries(x.c, x.t, false);
  const g = B.regimeStats(v.closes, v.times, 0.0025, B.mulberry32(11), 200);
  const rng = B.mulberry32(11), diffs = [];
  for (let p = 0; p < 200; p++) {
    const alt = B.cellStats(B.altPath(v.closes, rng), 0.0025, g.fallback ? g.cls : `${g.cls}${g.up ? '+' : '-'}`, !g.fallback);
    if (alt.days) diffs.push(alt.diff);
  }
  const below = diffs.filter((d) => d < g.lo).length, above = diffs.filter((d) => d > g.hi).length;
  const k = Math.floor(0.025 * g.paths);
  check('가짜 주가 차이 범위 밖이 위아래 같은 개수 (200개면 5개씩)',
    g.paths === diffs.length && g.paths > 150 && below === k && above === k, `경로 ${g.paths} · 아래 ${below} · 위 ${above}`);
}

// --- 7. 같은 결과 · 마지막 봉 · 속도 --------------------------------------------
{
  const w = walk(6);
  const opts = { domestic: true, cost: 0.0025 };
  const a = B.trendCheck('005930.KS', w.c, w.t, opts);
  const b = B.trendCheck('005930.KS', w.c, w.t, opts);
  check('같은 종목 · 같은 데이터면 같은 결과', JSON.stringify(a) === JSON.stringify(b));

  const p1 = B.altPath(w.c, B.mulberry32(B.seedOf('005930.KS')));
  const p2 = B.altPath(w.c, B.mulberry32(B.seedOf('000660.KS')));
  check('다른 종목은 다른 가짜 주가', p1.some((v, i) => v !== p2[i]));
  check('가짜 주가의 첫 종가는 실제와 같다', p1[0] === w.c[0]);

  const moved = { c: [...w.c.slice(0, -1), last(w.c) * 1.25], t: w.t };
  check('마지막 봉을 바꿔도 결과가 같다',
    JSON.stringify(B.trendCheck('005930.KS', moved.c, moved.t, opts)) === JSON.stringify(a));
  check('결과에 판단 배열을 싣지 않는다 (캐시가 가볍게)', a.rule.want === undefined);

  // 한 번만 재면 기계가 잠깐 바쁠 때 튄다 — 2026-10-13 에 221~383ms 가 나왔고 이전 커밋도 나란히 그만큼 느렸다.
  // 위 세 번으로 데운 뒤 다섯 번 재서 가장 빠른 값을 본다. 튀는 건 한두 번이지만 느려진 코드는 다섯 번 다 느리다.
  // 문턱 300ms 는 실측의 6~7배 — 열 배 느려진 코드(실측 510ms 대)는 잡고, 몇 배 느려진 기계는 넘긴다.
  let ms = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    B.trendCheck('000660.KS', w.c, w.t, opts);
    ms = Math.min(ms, performance.now() - t0);
  }
  check('1,230봉 한 종목이 300ms 안 (다섯 번 중 가장 빠른 값, 실측 약 45ms)', ms < 300, `${ms.toFixed(0)}ms`);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
