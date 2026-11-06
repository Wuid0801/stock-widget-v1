// renderer/format.js — 가격 · 등락률 · 거래량 글자와 색.

// --- 포맷 ---------------------------------------------------------------------
const fmt = (v) => v == null ? '—'
  : v.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });

// 해외 종목은 통화가 다르다. 원화는 정수, 그 외(USD 등)는 소수 2자리로 보여준다.
// 지수는 통화가 아니라 포인트다. money 는 원화가 아니면 소수 둘째 자리로 쓰므로 'pt' 를 주면
// 헤더 · 오늘 캔들 안내 · 52주 · 차트 축 · 툴팁이 상단 지수 줄처럼 7,003.74 로 나온다. 금리(INDICES 의 cur '%')는
// 하루에 0.01~0.1 움직여 둘째 자리로는 잘 보이지 않는다 — 셋째 자리까지(4.965).
const curOf = (symbol) => (isIndex(symbol) ? INDICES.find((i) => i.symbol === symbol).cur || 'pt'
  : (quotes[symbol] && quotes[symbol].currency) || 'KRW');
const money = (v, cur) => {
  if (v == null) return '—';
  if (!cur || cur === 'KRW') return fmt(v);
  const digits = cur === '%' ? 3 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const signedMoney = (v, cur) => (v > 0 ? '+' : '') + money(v, cur);
// 등락률은 자릿수가 흔들리지 않게 항상 소수 2자리
const fmtPct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
// 금리의 등락은 bp(0.01%p) — 4.953 → 4.970 은 +1.7bp. 금리가 몇 % 변했는지(+0.34%)보다 이것을 본다.
// 헤더의 전일 대비는 현재가 - 전일 종가로 다시 센 값이라 -0.0225 가 -0.02249999… 가 되어 지수 줄(-2.3bp)과 갈렸다
// (-2.2bp, 2026-10-26) — 네이버 금리의 자릿수(0.0001 = 0.01bp)에서 먼저 반올림한다.
const fmtBp = (v) => (v > 0 ? '+' : '') + (Math.round(v * 1e4) / 100).toFixed(1) + 'bp';
// 날짜 'YYYYMMDD'(또는 'YYYY-MM-DD') → 'MM/DD', 시각 ms → 'MM/DD HH:MM'(이 PC 시각) — 순위 · 지표 화면이 같이 쓴다.
const mmdd = (s) => { const n = String(s).replace(/\D/g, ''); return `${n.slice(4, 6)}/${n.slice(6, 8)}`; };
const stamp = (ms) => {
  const t = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}/${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
};

// 색은 CSS 변수 한 곳에서만 정의한다. 차트도 그리는 시점에 여기서 읽어가므로
// 테마를 바꾸면 같은 값이 따라온다.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// 종목명은 외부 API 응답이라 innerHTML에 그대로 넣지 않는다
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function labelFor(ms, timeframe) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  if (timeframe === '1D') return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (timeframe === '1W') return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}시`;
  // 1Y · 3Y 는 MM/DD로 쓰면 양 끝이 같은 날짜로 보여 1년 구간이 구분되지 않는다
  if (YEAR_TF.has(timeframe)) return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}`;
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

