// market-check.js — 데드캣 바운스 점검(시장 지표 화면). 반등이 진짜인지 볼 때 흔히 보는 일곱 지표를 숫자 기준으로 판정한다.
// 경험칙을 옮긴 참고용이다 — 매매 판단을 대신하지 않는다. 화면과 무관한 순수 함수이고, index.html 이 <script> 로 읽어
// 전역 marketChecks 를 쓰며 Node(테스트)에서는 require 로 가져온다.
// 기준은 설계 docs/superpowers/specs/2026-10-27-market-view-design.md ③ (2026-10-27 사용자가 정함).
const CHECK = {
  LOOKBACK: 5,        // "5거래일 전" — 일봉의 마지막 봉 앞 다섯 번째 종가
  SPOT_STREAK: 2,     // 외국인 현물이 이만큼 연속 순매수(확정일)면 긍정
  SOX_DAYS: 20,       // SOX 의 저항 · 지지를 보는 직전 거래일 수
  SOX_NEAR_LOW: 0.03, // 지금 값이 직전 최저 종가의 이 비율 안이면 저점 재시험
  USD_RISK: 0.01,     // 원/달러가 5거래일 전보다 이만큼 오르면 급등
  VIX_RISK_5D: 0.15,  // VIX 가 5거래일 전보다 이만큼 오르면 재상승
  VIX_RISK_DAY: 10,   // VIX 가 하루에 이만큼(%) 오르면 급등
  OAS_RISK: 0.25,     // HY OAS 가 5영업일 전보다 이만큼(%p) 넓어지면 확대
  TNX_CALM_BP: 10,    // 미국채 10년의 5거래일 변화가 이 안(bp)이면 안정
  TNX_RISK_BP: 20,    // 미국채 10년이 5거래일 동안 이만큼(bp) 오르면 급등
};
// 경계값은 부동소수 오차에도 같은 쪽으로 — 23 / 20 - 1 은 0.1499…, 5.10 - 4.90 은 0.1999… 다
const MC_EPS = 1e-9;

const mcNum = (v, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const mcSigned = (v, d, unit) => `${v > 0 ? '+' : ''}${v.toFixed(d)}${unit}`;
// 네이버 지수 수급은 억 원이다(10/23 외국인 선물 +4,514 = 다음 금융 금액 4,514억, 2026-11-02 확인)
const mcFlow = (v) => `${v > 0 ? '+' : ''}${v.toLocaleString('ko-KR')}억`;
const mcDate = (d) => `${d.slice(4, 6)}/${d.slice(6)}`;
const mcNone = (key) => ({ key, verdict: null, detail: '데이터 부족' });
const mcFinal = (flows) => (Array.isArray(flows) ? flows.filter((f) => f && f.final && Number.isFinite(f.foreign)) : []);

// 일봉의 "5거래일 전" 종가. 모자라면 null.
function mcBase(s) {
  const c = s && Array.isArray(s.closes) ? s.closes : null;
  const v = c && c.length > CHECK.LOOKBACK ? c[c.length - 1 - CHECK.LOOKBACK] : null;
  return v > 0 ? v : null;
}

// 그날 종가가 앞 거래일보다 올랐는지 — 일봉에 그날(또는 앞날)이 없으면 null
function mcUp(days, date) {
  if (!Array.isArray(days)) return null;
  const i = days.findIndex((d) => d.date === date);
  return i > 0 ? days[i].close > days[i - 1].close : null;
}

// 외국인 현물: 확정된 마지막 두 날 모두 순매수면 긍정, 마지막 확정일에 코스피가 올랐는데 순매도면 위험. 18:00 전 오늘(잠정)은 안 쓴다.
function mcSpot(flows, kospiDays) {
  const done = mcFinal(flows);
  if (!done.length) return mcNone('spot');
  const tail = done.slice(-CHECK.SPOT_STREAK);
  const last = done[done.length - 1];
  const up = mcUp(kospiDays, last.date);
  const detail = `확정 ${tail.map((f) => `${mcDate(f.date)} ${mcFlow(f.foreign)}`).join(' · ')}`
    + (up == null ? '' : ` · ${mcDate(last.date)} 코스피 ${up ? '상승' : '하락'}`);
  if (tail.length === CHECK.SPOT_STREAK && tail.every((f) => f.foreign > 0)) return { key: 'spot', verdict: 'good', detail };
  if (last.foreign < 0 && up === true) return { key: 'spot', verdict: 'risk', detail };
  return tail.length === CHECK.SPOT_STREAK && up != null ? { key: 'spot', verdict: 'neutral', detail } : mcNone('spot');
}

// 코스피200 선물: 마지막 확정일에 선물이 올랐고 외국인 선물 순매수면 긍정, 코스피가 올랐는데 외국인 선물 순매도면 위험.
function mcFutures(flows, futDays, kospiDays) {
  const done = mcFinal(flows);
  const last = done[done.length - 1];
  if (!last) return mcNone('futures');
  const futUp = mcUp(futDays, last.date);
  const kospiUp = mcUp(kospiDays, last.date);
  const detail = `${mcDate(last.date)} 외국인 선물 ${mcFlow(last.foreign)}`
    + (futUp == null ? '' : ` · 선물 ${futUp ? '상승' : '하락'}`) + (kospiUp == null ? '' : ` · 코스피 ${kospiUp ? '상승' : '하락'}`);
  if (futUp === true && last.foreign > 0) return { key: 'futures', verdict: 'good', detail };
  if (kospiUp === true && last.foreign < 0) return { key: 'futures', verdict: 'risk', detail };
  return futUp != null && kospiUp != null ? { key: 'futures', verdict: 'neutral', detail } : mcNone('futures');
}

// SOX: 지금 값이 직전 20거래일(마지막 봉 앞) 최고 종가를 넘으면 긍정, 최저 종가의 3% 안이면 위험(저점 재시험).
function mcSox(s) {
  const c = s && Array.isArray(s.closes) ? s.closes : null;
  if (!c || c.length < CHECK.SOX_DAYS + 1 || !(s.now > 0)) return mcNone('sox');
  const prior = c.slice(-(CHECK.SOX_DAYS + 1), -1);
  const hi = Math.max(...prior);
  const lo = Math.min(...prior);
  const detail = `직전 ${CHECK.SOX_DAYS}거래일 최고 ${mcNum(hi)} · 최저 ${mcNum(lo)} → 지금 ${mcNum(s.now)}`;
  if (s.now > hi) return { key: 'sox', verdict: 'good', detail };
  if (s.now <= lo * (1 + CHECK.SOX_NEAR_LOW) + MC_EPS) return { key: 'sox', verdict: 'risk', detail };
  return { key: 'sox', verdict: 'neutral', detail };
}

// 원/달러: 5거래일 전보다 보합 · 하락이면 긍정, +1% 이상이면 위험.
function mcUsd(s) {
  const base = mcBase(s);
  if (base == null || !(s.now > 0)) return mcNone('usdkrw');
  const pct = s.now / base - 1;
  const detail = `5거래일 전 ${mcNum(base)} → 지금 ${mcNum(s.now)} (${mcSigned(pct * 100, 2, '%')})`;
  if (pct >= CHECK.USD_RISK - MC_EPS) return { key: 'usdkrw', verdict: 'risk', detail };
  return { key: 'usdkrw', verdict: pct <= MC_EPS ? 'good' : 'neutral', detail };
}

// VIX: 5거래일 전보다 낮으면 긍정, +15% 이상이거나 하루 +10% 이상이면 위험.
function mcVix(s) {
  const base = mcBase(s);
  if (base == null || !(s.now > 0)) return mcNone('vix');
  const pct = s.now / base - 1;
  const day = Number.isFinite(s.dayPct) ? s.dayPct : null;
  const detail = `5거래일 전 ${mcNum(base)} → 지금 ${mcNum(s.now)} (${mcSigned(pct * 100, 2, '%')})`
    + (day == null ? '' : ` · 오늘 ${mcSigned(day, 2, '%')}`);
  if (pct >= CHECK.VIX_RISK_5D - MC_EPS || (day != null && day >= CHECK.VIX_RISK_DAY - MC_EPS)) return { key: 'vix', verdict: 'risk', detail };
  return { key: 'vix', verdict: pct < -MC_EPS ? 'good' : 'neutral', detail };
}

// 미국 HY OAS: 5영업일 전보다 좁아졌으면 긍정, +0.25%p 이상 넓어졌으면 위험. rows 는 FRED 의 { date, value } 오름차순.
function mcOas(rows) {
  if (!Array.isArray(rows) || rows.length <= CHECK.LOOKBACK) return mcNone('hyoas');
  const last = rows[rows.length - 1].value;
  const base = rows[rows.length - 1 - CHECK.LOOKBACK].value;
  if (!Number.isFinite(last) || !Number.isFinite(base)) return mcNone('hyoas');
  const diff = last - base;
  const detail = `5영업일 전 ${mcNum(base)}% → ${mcNum(last)}% (${mcSigned(diff * 100, 1, 'bp')})`;
  if (diff >= CHECK.OAS_RISK - MC_EPS) return { key: 'hyoas', verdict: 'risk', detail };
  return { key: 'hyoas', verdict: diff < -MC_EPS ? 'good' : 'neutral', detail };
}

// 미국채 10년: 5거래일 변화가 ±10bp 안이면 긍정(안정), +20bp 이상이면 위험(급등). 크게 내린 것은 중립이다.
function mcTnx(s) {
  const base = mcBase(s);
  if (base == null || !(s.now > 0)) return mcNone('us10y');
  const bp = (s.now - base) * 100;
  const detail = `5거래일 전 ${mcNum(base, 3)} → 지금 ${mcNum(s.now, 3)} (${mcSigned(bp, 1, 'bp')})`;
  if (bp >= CHECK.TNX_RISK_BP - 1e-6) return { key: 'us10y', verdict: 'risk', detail };
  return { key: 'us10y', verdict: Math.abs(bp) <= CHECK.TNX_CALM_BP + 1e-6 ? 'good' : 'neutral', detail };
}

// 일곱 판정. input = { spotFlows, futFlows, kospiDays, futDays, hyOas, sox, usdkrw, vix, us10y } — 앞 다섯은 main 의 market:extras
// 모양, 뒤 넷은 { now, closes(일봉 오름차순), dayPct }. 데이터가 모자란 항목은 verdict null(판정 불가).
function marketChecks(input = {}) {
  return [
    mcSpot(input.spotFlows, input.kospiDays),
    mcFutures(input.futFlows, input.futDays, input.kospiDays),
    mcSox(input.sox),
    mcUsd(input.usdkrw),
    mcVix(input.vix),
    mcOas(input.hyOas),
    mcTnx(input.us10y),
  ];
}

if (typeof module !== 'undefined') {
  module.exports = { CHECK, marketChecks };
}
