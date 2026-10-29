// 기법 점검(지표 화면) 계산 — 앱을 띄우지 않고 indicators.js 의 추세 추종 · 모멘텀 · 적립식 · 반등 점검 · 코스톨라니 달걀을 본다.
import { trendFollow, momentum, dcaCost, reboundCheck, eggPhase, eggSeries, EGG_SURGE, EGG_ORDER, sma, calcRSI } from '../indicators.js';

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

// --- 모멘텀 12-1: 최근 21거래일을 뺀 252거래일 수익률(%) ----------------------------------------------------
{
  const c = Array.from({ length: 253 }, (_, i) => 100 + i);
  check('253봉이면 첫 봉 → 21봉 전', near(momentum(c), (331 / 100 - 1) * 100), String(momentum(c)));
  check('252봉 이하면 null', momentum(c.slice(0, 252)) === null && momentum(null) === null);
  check('마지막 한 달은 보지 않는다', near(momentum([...c.slice(0, 232), ...Array(21).fill(1)]), momentum(c)));
  check('기간을 바꿀 수 있다', near(momentum([10, 11, 12, 20], 3, 1), 20));
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

// --- 코스톨라니 달걀(해석): 20일선 vs 60일선 × 거래량 20일 평균 / 60일 평균 ---------------------------------------
{
  const rise = Array.from({ length: 61 }, (_, i) => 100 + i);
  const fall = rise.slice().reverse();
  // 확정된 봉 60개: 앞 40봉 100, 최근 20봉 v. 마지막(61번째) 봉은 진행 중이라 뺀다
  const vols = (v) => [...Array(40).fill(100), ...Array(20).fill(v), 1e9];
  const e = eggPhase(rise, vols(130));
  check('상승 + 거래량 증가 = A2', e && e.phase === 'A2' && e.up === true, JSON.stringify(e));
  check('비율 = 최근 20봉 평균 / 60봉 평균', near(e.ratio, 130 / ((40 * 100 + 20 * 130) / 60)));
  check('상승 + 거래량 감소 = A1', eggPhase(rise, vols(80)).phase === 'A1');
  check(`상승 + 거래량 급증(${EGG_SURGE}배 이상) = A3`, eggPhase(rise, vols(300)).phase === 'A3');
  check('하락 = B1 · B2 · B3', eggPhase(fall, vols(80)).phase === 'B1' && eggPhase(fall, vols(130)).phase === 'B2'
    && eggPhase(fall, vols(300)).phase === 'B3');
  check('거래량이 없는 지수(0)는 null', eggPhase(rise, rise.map(() => 0)) === null);
  check('봉이 모자라면 null', eggPhase(rise.slice(1), vols(130).slice(1)) === null && eggPhase(rise, null) === null);
  check('거래량 0 인 날은 빼고 센다', eggPhase([...rise, 161], [...vols(130).slice(0, 60), 0, 1e9]).phase === 'A2');

  // 방향 — 직전 국면 → 지금 국면 · 이어진 봉 수 · 달걀 순서의 다음 국면
  check('처음 셀 수 있는 봉이면 직전 국면이 없다', e.prev === null && e.days === 1 && e.next === 'A3', JSON.stringify(e));
  // 100봉 오르다 30봉 내린다. 거래량은 늘 같아 비율 1(증가) — A2 에서 20일선이 60일선 밑으로 내려간 봉부터 B2
  const turn = [...Array.from({ length: 100 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 199 - (i + 1) * 3)];
  const flat = turn.map(() => 100);
  const t = eggPhase(turn, flat);
  const m20 = sma(turn, 20); const m60 = sma(turn, 60);
  const flip = m20.findLastIndex((v, i) => v > m60[i]); // 마지막으로 위였던 봉
  check('A2 → B2', t.prev === 'A2' && t.phase === 'B2', JSON.stringify(t));
  check('일수는 바뀐 봉부터 오늘까지', t.days === turn.length - 1 - flip, `${t.days} / ${turn.length - 1 - flip}`);
  check('다음은 달걀 순서로 B3', t.next === 'B3');
  check('B3 다음은 다시 A1', eggPhase(fall, vols(300)).next === 'A1');
  check('순서는 A1 → A2 → A3 → B1 → B2 → B3', EGG_ORDER.join(' ') === 'A1 A2 A3 B1 B2 B3');
  // 봉마다의 국면은 그 봉까지의 일봉으로 센 지금 국면과 같다
  const wave = Array.from({ length: 160 }, (_, i) => 100 + 20 * Math.sin(i / 9) + i * 0.1);
  const wv = wave.map((_, i) => 100 + 60 * Math.abs(Math.sin(i / 7)));
  const s = eggSeries(wave, wv);
  const same = [60, 61, 90, 120, 159].every((i) => (s[i] && s[i].phase) === (eggPhase(wave.slice(0, i + 1), wv.slice(0, i + 1)) || {}).phase);
  check('eggSeries[i] = 그 봉까지로 센 eggPhase', same && s[59] === null && s[60] !== null);
  check('파도 모양이면 국면이 여러 번 바뀐다', new Set(s.filter(Boolean).map((x) => x.phase)).size >= 3,
    [...new Set(s.filter(Boolean).map((x) => x.phase))].join(','));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
