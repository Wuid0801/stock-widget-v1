// 기법 점검(지표 화면) 계산 — 앱을 띄우지 않고 indicators.js 의 추세 추종 · 모멘텀 · 적립식 · 반등 점검 · 코스톨라니 달걀을 본다.
import { trendFollow, momentum, dcaCost, reboundCheck, eggNext, eggPhase, eggSeries, EGG_SURGE, EGG_HOT, EGG_PANIC, EGG_CONFIRM, EGG_ORDER,
  sma, calcRSI } from '../indicators.js';

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

// --- 추세 추종: 종가가 200일선 위면 보유, 아래면 현금. 일수는 그 상태가 이어진 봉 수(오늘 포함) ---------------------------
{
  const up = Array.from({ length: 250 }, (_, i) => 100 + i);
  const t = trendFollow(up);
  check('오르기만 하면 200일선 위', t && t.above === true);
  check('200일선은 마지막 200봉 평균', near(t.ma, sma(up, 200)[249]));
  check('일수는 200일선이 생긴 봉부터 이어진 수', t.days === 51, String(t.days));
  const down = [...up, ...Array(5).fill(100)];
  const d = trendFollow(down);
  check('크게 빠지면 아래 · 빠진 봉부터 센다', d.above === false && d.days === 5, JSON.stringify(d));
  check('200봉보다 적으면 null', trendFollow(up.slice(0, 199)) === null && trendFollow(null) === null);
  check('종가가 200일선과 같으면 위가 아니다', trendFollow(Array(200).fill(7)).above === false);
  check('기간을 바꿀 수 있다', trendFollow(up.slice(0, 20), 20).days === 1);
}

// --- 모멘텀 12-1: 1개월 전 종가 / 12개월 전 종가 - 1. 날짜는 달력으로(거래일 수가 아니라) ------------------------------
{
  // 2025-06-02 ~ 2026-10-26 평일(09:00 KST = 00:00 UTC), 값은 봉 번호
  const times = [];
  for (let t = Date.UTC(2025, 5, 2); t <= Date.UTC(2026, 9, 26); t += 86400000) if (![0, 6].includes(new Date(t).getUTCDay())) times.push(t);
  const closes = times.map((_, i) => 100 + i);
  const on = (y, m, d) => times.indexOf(Date.UTC(y, m - 1, d));
  // 2026-10-26(월)의 12개월 전 2025-10-26 은 일요일 → 10-24(금), 1개월 전 2026-09-26 은 토요일 → 09-25(금)
  const want = (closes[on(2026, 9, 25)] / closes[on(2025, 10, 24)] - 1) * 100;
  check('그날(없으면 그 앞 거래일) 종가로', near(momentum(times, closes), want), `${momentum(times, closes)} / ${want}`);
  check('거래일 수가 아니라 달력', on(2026, 10, 26) - on(2025, 10, 24) !== 252);
  check('마지막 한 달은 보지 않는다', near(momentum(times, closes.map((v, i) => (i > on(2026, 9, 25) ? 1 : v))), want));
  // 3/31 의 한 달 전은 2/28(토) → 2/27(금), 두 달 전은 1/31(토) → 1/30(금)
  const mar = times.slice(0, on(2026, 3, 31) + 1);
  check('그달에 그날이 없으면 그달 마지막 날', near(momentum(mar, closes, 2, 1), (closes[on(2026, 2, 27)] / closes[on(2026, 1, 30)] - 1) * 100));
  check('12개월 전보다 앞선 봉이 없으면 null', momentum(times.slice(on(2025, 11, 3)), closes.slice(on(2025, 11, 3))) === null
    && momentum(null, null) === null);
  // 미국 일봉(13:30 · 14:30 UTC, 서머타임)도 날짜로 맞춘다
  const us = times.map((t, i) => t + (i % 2 ? 13.5 : 14.5) * 3600000);
  check('봉 시각이 달라도 날짜로', near(momentum(us, closes), want));
  check('기간을 바꿀 수 있다', near(momentum(times, closes, 3, 0), (closes.at(-1) / closes[on(2026, 7, 24)] - 1) * 100));
}

// --- 적립식: 최근 12달(이번 달 포함) 매달 첫 거래일 종가에 같은 금액 → 평균 단가(조화평균) --------------------------
{
  // 2025-09-01 ~ 2026-10-29 평일 일봉(09:00 KST = 00:00 UTC). 값은 그달 번호로 — 달마다 첫 거래일 종가가 다르다.
  const times = [];
  for (let t = Date.UTC(2025, 8, 1); t <= Date.UTC(2026, 9, 29); t += 86400000) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) times.push(t);
  }
  const mon = (t) => new Date(t).getUTCFullYear() * 12 + new Date(t).getUTCMonth();
  const closes = times.map((t, i) => 100 + (mon(t) % 12) * 10 + (i % 3)); // 달 안에서도 조금씩 다르다
  const r = dcaCost(times, closes);
  const firsts = times.map((t, i) => (i > 0 && mon(t) !== mon(times[i - 1]) && mon(t) >= mon(times.at(-1)) - 11 ? closes[i] : null))
    .filter((v) => v != null);
  check('12달 — 2025-11 ~ 2026-10 첫 거래일마다 한 번', r && r.buys === 12 && firsts.length === 12, JSON.stringify(r));
  check('평균 단가는 같은 금액이라 조화평균', near(r.avg, 12 / firsts.reduce((s, v) => s + 1 / v, 0)));
  check('지금 가격 대비(%)', near(r.pct, (closes.at(-1) / r.avg - 1) * 100));
  // 2025-11-01 은 토요일 — 첫 거래일은 11-03(월)
  const nov = times.findIndex((t) => mon(t) === 2025 * 12 + 10);
  check('주말로 시작하는 달은 첫 평일', new Date(times[nov]).getUTCDate() === 3);
  const late = times.findIndex((t) => mon(t) === 2025 * 12 + 10);
  check('첫 달부터 시작하는 시계열은 null — 그달 첫 거래일인지 모른다', dcaCost(times.slice(late), closes.slice(late)) === null);
  check('달 수를 바꿀 수 있다', dcaCost(times, closes, 3).buys === 3);
  check('봉이 없으면 null', dcaCost([], []) === null && dcaCost(null, null) === null);
}

// --- 반등 점검: 60거래일 고점에서 15% 넘게 빠진 뒤 반등 중일 때만 ---------------------------------------------
{
  // 39봉 95 → 고점 100 → 10봉에 걸쳐 80 까지 → 10봉에 걸쳐 90 까지 (60봉)
  const closes = [...Array(39).fill(95), 100, ...Array.from({ length: 10 }, (_, i) => 98 - i * 2), ...Array.from({ length: 10 }, (_, i) => 81 + i)];
  const vols = closes.map((_, i) => (i <= 39 ? 1000 : i <= 49 ? 2000 : 900));
  vols[59] = 99999; // 진행 중인 마지막 봉은 거래량에서 뺀다
  const r = reboundCheck(closes, vols);
  check('고점 · 저점', r && r.high === 100 && r.low === 80, JSON.stringify(r));
  check('하락폭 -20%', near(r.dropPct, -20));
  check('되돌림 = 저점에서 오른 폭 / 고점~저점 폭', near(r.retrace, 50));
  check('20일선 위아래 · RSI', r.aboveMa20 === (90 > sma(closes, 20)[59]) && near(r.ma20, sma(closes, 20)[59]) && r.rsi === calcRSI(closes));
  check('반등 거래량 = 저점 뒤 확정된 봉 평균 / 하락 구간 평균', near(r.volRatio, 900 / 2000), String(r.volRatio));
  check('거래량이 없으면 그 값만 빈다', reboundCheck(closes, null).volRatio === null);
  const shallow = closes.map((v) => (v < 100 ? 100 - (100 - v) / 3 : v)); // 고점에서 -6.7% 까지만
  check('덜 빠졌으면 null', reboundCheck(shallow, vols) === null);
  const falling = [...Array(10).fill(95), ...closes.slice(0, 50)]; // 60봉, 마지막이 저점 80
  check('아직 저점(마지막 봉이 최저)이면 null', falling.length === 60 && falling.at(-1) === 80 && reboundCheck(falling, null) === null);
  check('봉이 60개보다 적으면 null', reboundCheck(closes.slice(1), vols) === null);
  check('기간 · 하락폭을 바꿀 수 있다', reboundCheck(closes.slice(-30), vols.slice(-30), 30, 15) !== null
    && reboundCheck(closes, vols, 60, 25) === null);
}

// --- 코스톨라니 달걀(해석): 순서를 기억해 한 칸씩 — 방향(20일선 vs 60일선) · 거래량 20일/60일 · RSI ---------------------
{
  check('순서는 A1 → A2 → A3 → B1 → B2 → B3', EGG_ORDER.join(' ') === 'A1 A2 A3 B1 B2 B3');
  // 한 걸음(eggNext) — 규칙 표 그대로
  const x = (o) => ({ up: true, ratio: 1.1, rsi: 50, upRun: 1, dnRun: 0, armed: false, ...o });
  const steps = [
    // [지금, 그 봉, 다음, 뜻]
    [null, x({}), 'A2', '처음: 상승 + 거래량 증가'], [null, x({ ratio: 0.9 }), 'A1', '처음: 상승 + 감소'],
    [null, x({ rsi: EGG_HOT }), 'A3', '처음: 상승 + 과열'], [null, x({ up: false, ratio: 0.9 }), 'B1', '처음: 하락 + 감소'],
    [null, x({ up: false }), 'B2', '처음: 하락 + 증가'], [null, x({ up: false, rsi: EGG_PANIC }), 'B3', '처음: 하락 + 투매'],
    ['A1', x({}), 'A2', 'A1 → A2 거래량 증가'], ['A1', x({ ratio: 0.9 }), 'A1', 'A1 거래량 감소면 그대로'],
    ['A1', x({ ratio: EGG_SURGE }), 'A3', '과열(거래량)은 A2 를 건너뛴다'], ['A1', x({ up: false, dnRun: 5 }), 'A1', '잠깐 내린 것은 그대로'],
    ['A1', x({ up: false, dnRun: EGG_CONFIRM }), 'B1', `과열 없이 ${EGG_CONFIRM}거래일 내리면 B1`],
    ['A2', x({ ratio: 0.5 }), 'A2', 'A2 → A1 로 되돌아가지 않는다'], ['A2', x({ rsi: 70 }), 'A3', 'A2 → A3 과열(RSI)'],
    ['A2', x({ up: false, dnRun: EGG_CONFIRM - 1 }), 'A2', '확인 전'], ['A2', x({ up: false, dnRun: EGG_CONFIRM }), 'B1', '과열 없이 꺾인 꼭대기'],
    ['A3', x({ rsi: 50, ratio: 0.8 }), 'A3', '식어도 상승 중이면 A3'], ['A3', x({ up: false, dnRun: 1, armed: true }), 'B1', 'A3 → B1 20일선이 아래로'],
    ['A3', x({ up: false, dnRun: 1 }), 'A3', '상승을 지나지 않은 A3 는 아래로 간 것만으로 B1 이 아니다'],
    ['A3', x({ up: false, dnRun: EGG_CONFIRM }), 'B1', '대신 그만큼 내리면 B1'],
    ['B1', x({ up: false }), 'B2', 'B1 → B2 하락 중 거래량 증가'], ['B1', x({ up: false, ratio: 0.9 }), 'B1', '감소면 그대로'],
    ['B1', x({ up: true, ratio: 1.2, upRun: 3 }), 'B1', '반등 중 거래량 증가는 B2 가 아니다'],
    ['B1', x({ up: false, rsi: 30 }), 'B3', '투매(RSI)는 B2 를 건너뛴다'], ['B1', x({ upRun: EGG_CONFIRM }), 'A1', `투매 없이 ${EGG_CONFIRM}거래일 오르면 A1`],
    ['B2', x({ up: false, ratio: 0.5 }), 'B2', 'B2 → B1 로 되돌아가지 않는다'], ['B2', x({ upRun: 5 }), 'B2', '짧은 반등은 그대로(하락장 중의 반등)'],
    ['B2', x({ rsi: 28 }), 'B3', '투매는 20일선이 아직 위여도 B3'], ['B2', x({ upRun: EGG_CONFIRM }), 'A1', '투매 없이 돌아선 바닥'],
    ['B3', x({ up: false }), 'B3', '하락 중이면 B3'], ['B3', x({ upRun: 5 }), 'B3', '하락을 지나지 않은 B3 는 위인 것만으로 A1 이 아니다'],
    ['B3', x({ upRun: 1, armed: true }), 'A1', 'B3 → A1 20일선이 다시 위로'],
  ];
  const bad = steps.filter(([st, o, want]) => eggNext(st, o) !== want);
  check(`한 걸음 규칙 ${steps.length}가지`, bad.length === 0, bad.map(([st, , want, why]) => `${st}→${want}(${why})`).join(' / '));

  // 이어서 — 오름(과열) → 내림 → 하락장 중의 반등(20일선이 잠깐 위) → 급락(투매, 20일선 아직 위) → 낮은 데서 횡보 → 다시 오름
  const c = [];
  let p = 100;
  const push = (n, f) => { for (let i = 0; i < n; i++) { p = f(i, p); c.push(p); } };
  push(90, (i, v) => v + (i % 2 ? -0.6 : 1.4));
  push(45, (i, v) => v + (i % 2 ? 0.8 : -1.8));
  push(25, (i, v) => v + (i % 2 ? -0.5 : 2.6));
  push(6, (i, v) => v * 0.94);
  push(25, (i, v) => v + (i % 2 ? 0.4 : -0.5));
  push(60, (i, v) => v + (i % 2 ? -0.4 : 1.2));
  const s = eggSeries(c, c.map(() => 100));
  const path = [];
  s.forEach((e, i) => { if (e && (!path.length || path.at(-1).phase !== e.phase)) path.push({ i, ...e }); });
  check('한 바퀴: A3 → B1 → B2 → B3 → A1 → A2 → A3', path.map((e) => e.phase).join(' ') === 'A3 B1 B2 B3 A1 A2 A3', path.map((e) => `${e.i}:${e.phase}`).join(' '));
  const forward = path.slice(1).every((e, k) => [1, 2, 3].includes((EGG_ORDER.indexOf(e.phase) - EGG_ORDER.indexOf(path[k].phase) + 6) % 6));
  check('되돌아가지 않는다', forward);
  const b3 = path.find((e) => e.phase === 'B3');
  const a1 = path.find((e) => e.phase === 'A1');
  check('하락장 중의 반등(20일선 잠깐 위)은 A1 이 아니다', s.slice(path[2].i, b3.i).some((e) => e.up));
  check('투매는 20일선이 아직 위일 때 왔다', b3.up === true && b3.rsi <= EGG_PANIC, JSON.stringify(b3));
  check('A1 은 20일선이 한 번 내려갔다 다시 올라선 뒤', s.slice(b3.i, a1.i).some((e) => !e.up) && a1.up && a1.i > b3.i + 1);

  // 지금 국면 · 방향(eggPhase) — 직전 국면 · 이어진 봉 수(오늘 포함) · 달걀 순서의 다음
  const e = eggPhase(c, c.map(() => 100));
  const last = path.at(-1);
  check('지금은 A3, 직전 A2, 다음 B1', e.phase === 'A3' && e.prev === 'A2' && e.next === 'B1', JSON.stringify(e));
  check('일수는 바뀐 봉부터 오늘까지', e.days === c.length - last.i);
  check('B3 다음은 다시 A1', eggPhase(c.slice(0, a1.i), c.slice(0, a1.i).map(() => 100)).next === 'A1');
  check('봉마다의 국면은 그 봉까지로 센 eggPhase 와 같다',
    [60, 120, b3.i, a1.i, c.length - 1].every((i) => s[i].phase === eggPhase(c.slice(0, i + 1), c.slice(0, i + 1).map(() => 100)).phase));
  // 처음 셀 수 있는 봉 — 60일선과 거래량 있는 날 60개
  const rise = Array.from({ length: 61 }, (_, i) => 100 + i * 0.25 + (i % 2 ? -1 : 0)); // 톱니(+1.25 / -0.75)라 RSI 가 70 아래
  const vols = (v) => [...Array(40).fill(100), ...Array(20).fill(v), 1e9]; // 마지막 봉(진행 중)은 뺀다
  const first = eggPhase(rise, vols(130));
  check('처음 봉은 그날 값으로(상승 + 증가 = A2) · 직전 없음', first && first.phase === 'A2' && first.prev === null && first.days === 1, JSON.stringify(first));
  check('비율 = 최근 20봉 평균 / 60봉 평균', near(first.ratio, 130 / ((40 * 100 + 20 * 130) / 60)));
  check('거래량이 없는 지수(0)는 null', eggPhase(rise, rise.map(() => 0)) === null);
  check('봉이 모자라면 null', eggPhase(rise.slice(1), vols(130).slice(1)) === null && eggPhase(rise, null) === null);
  check('거래량 0 인 날은 빼고 센다', eggPhase([...rise, 158], [...vols(130).slice(0, 60), 0, 1e9]).ratio === first.ratio);
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
