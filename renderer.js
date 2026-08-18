// renderer.js — UI 렌더링, RSI(14) 계산, Chart.js 그리기, 30초 폴링.
// 네트워크는 전부 window.api.fetchChart(preload → 메인 프로세스)를 통해서만 나간다.

const UP = '#e24b4a';   // 상승 = 빨강 (한국 관례)
const DOWN = '#185fa5'; // 하락 = 파랑

const TF = {
  '1D': { range: '1d', interval: '5m' },
  '1W': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
};

// 선택 가능한 이동평균 기간(일)
const MA_PERIODS = [5, 10, 20, 40, 60, 80, 120, 240, 360];

// 차트 구간에 비해 지나치게 긴 이동평균은 그리지 않는다.
// 1M(22봉) 차트의 360일선은 거의 수평선인데 y축만 크게 벌려 놓아서
// 정작 주가 움직임이 세로 39%까지 눌린다(삼성전자 실측). 구간 봉 수의 1.5배까지만 허용.
const MA_SPAN = 1.5;

// 조금 굵게(1.2px) 그릴 기간. 나머지는 1px.
const MA_THICK = new Set([20, 40, 80]);

// 골든/데드크로스를 볼 이동평균 조합.
// 60/80 처럼 가까운 기간끼리는 횡보 구간에서 계속 교차해 신호 가치가 없어 넣지 않는다.
const CROSS_PAIRS = [[5, 20], [20, 60]];
let chartBars = 0; // 현재 차트의 봉 수. 0이면 이동평균을 안 그리는 타임프레임(1D/1W)
const maFits = (p) => chartBars > 0 && p <= chartBars * MA_SPAN;

// RSI·이동평균 계산용 일봉 시리즈.
// 1Y 차트(243봉)에 MA360 을 끝까지 그리려면 앞으로 360봉이 더 필요해 총 603봉 이상이어야 한다.
// 1년치(243) · 2년치(484) 로는 모자라 5년치(약 1219봉)를 받는다.
const DAILY = { range: '5y', interval: '1d' };

// 5년치는 응답이 커서(종목당 약 80KB) 30초마다 받으면 낭비다.
// 일봉은 장중에 마지막 봉만 움직이므로 캐시하고 가끔만 다시 받는다.
// 현재가는 실시간(네이버)에서 따로 오므로 화면은 30초마다 그대로 갱신된다.
const DAILY_TTL = 30 * 60 * 1000;
const dailyCache = {}; // symbol -> { at, price, closes, times, currency, week52High, week52Low }

let state = { watchlist: [], selected: null, timeframe: '1D' };
const quotes = {}; // symbol -> { price, prevClose, rsi } | { error }
let dragFrom = null; // 순서 변경 드래그 중인 행 인덱스
let chart = null;
let busy = false;
let chartSeq = 0; // 차트 요청 순번 — 응답이 역순으로 도착해도 마지막 것만 반영
let isLive = false;      // 마지막 갱신이 실시간 시세였는지 (실패 시 Yahoo 20분 지연)
let marketOpen = true;   // 장중 여부. 장 마감 후에는 폴링 간격을 늘린다
let pollTimer = null;

const POLL_OPEN = 30000;   // 장중 30초
const POLL_CLOSED = 300000; // 장 마감 후 5분 (개장 감지용 최소 확인)

// --- RSI(14), Wilder smoothing -----------------------------------------------
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

// 과열도 5단계
function levelOf(rsi) {
  if (rsi == null) return { label: '—', color: cssVar('--dot-off') };
  if (rsi >= 80) return { label: '극과열', color: '#c0272d' };
  if (rsi >= 70) return { label: '과열', color: '#e8862a' };
  if (rsi >= 45) return { label: '안정', color: '#2fa15a' };
  if (rsi >= 30) return { label: '주의', color: '#e8862a' };
  return { label: '과매도', color: DOWN };
}

// --- 포맷 ---------------------------------------------------------------------
const fmt = (v) => v == null ? '—'
  : v.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });

const signed = (v) => (v > 0 ? '+' : '') + fmt(v);

// 해외 종목은 통화가 다르다. 원화는 정수, 그 외(USD 등)는 소수 2자리로 보여준다.
const curOf = (symbol) => (quotes[symbol] && quotes[symbol].currency) || 'KRW';
const money = (v, cur) => {
  if (v == null) return '—';
  if (!cur || cur === 'KRW') return fmt(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const signedMoney = (v, cur) => (v > 0 ? '+' : '') + money(v, cur);
// 등락률은 자릿수가 흔들리지 않게 항상 소수 2자리
const fmtPct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';

// 색은 CSS 변수 한 곳에서만 정의한다. 차트도 그리는 시점에 여기서 읽어가므로
// 테마를 바꾸면 같은 값이 따라온다.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// 종목명은 외부 API 응답이라 innerHTML에 그대로 넣지 않는다
const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function labelFor(ms, timeframe) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  if (timeframe === '1D') return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (timeframe === '1W') return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}시`;
  // 1Y는 MM/DD로 쓰면 양 끝이 같은 날짜로 보여 1년 구간이 구분되지 않는다
  if (timeframe === '1Y') return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}`;
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

// --- 리스트 -------------------------------------------------------------------
// 관심종목은 store에서 오므로, 추가/삭제 UI를 붙일 때는
// state.watchlist를 수정하고 save() + renderList()만 호출하면 된다.
function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!state.watchlist.length) {
    list.innerHTML = '<div class="empty">관심종목이 없습니다.<br>상단 ＋ 로 종목을 추가하세요.</div>';
    return;
  }

  state.watchlist.forEach((item, idx) => {
    const q = quotes[item.symbol];
    const row = document.createElement('div');
    row.className = 'row' + (item.symbol === state.selected ? ' on' : '');

    const lv = levelOf(q && q.rsi);
    const up = q && q.change > 0;
    const flat = !q || !q.change;
    const color = flat ? cssVar('--flat') : (up ? UP : DOWN);

    row.innerHTML = `
      <span class="dot" style="background:${lv.color}"></span>
      <span class="name">${esc(item.name)}</span>
      <span class="px" style="color:${color}">${q && q.price != null ? money(q.price, curOf(item.symbol)) : '—'}</span>
      <span class="chg" style="color:${color}">${
        q && q.pct != null ? fmtPct(q.pct) : (q && q.error ? '오류' : '')
      }</span>
      <button class="del" title="삭제">✕</button>`;

    row.onclick = () => select(item.symbol);
    row.querySelector('.del').onclick = (e) => {
      e.stopPropagation(); // 삭제 클릭이 종목 선택으로 이어지지 않게
      removeSymbol(item.symbol);
    };

    // 드래그로 순서 변경
    row.draggable = true;
    row.ondragstart = (e) => {
      dragFrom = idx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx)); // 일부 환경에서 데이터가 없으면 드래그가 시작되지 않는다
      row.classList.add('dragging');
    };
    row.ondragover = (e) => {
      if (dragFrom === null || dragFrom === idx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('dropto');
    };
    row.ondragleave = () => row.classList.remove('dropto');
    row.ondrop = (e) => {
      e.preventDefault();
      row.classList.remove('dropto');
      moveSymbol(dragFrom, idx);
    };
    row.ondragend = () => {
      dragFrom = null;
      for (const r of document.querySelectorAll('#list .row')) r.classList.remove('dragging', 'dropto');
    };

    list.appendChild(row);
  });
}

// 드래그로 관심종목 순서 변경
function moveSymbol(from, to) {
  if (from === null || to === null || from === to) return;
  const [moved] = state.watchlist.splice(from, 1);
  state.watchlist.splice(to, 0, moved);
  save();
  renderList();
}

// --- 코스피/코스닥 지수 -----------------------------------------------------------
// 개별 종목이 빠질 때 시장 전체 흐름인지 바로 알 수 있게 한 줄로 보여준다.
async function loadIndices() {
  const box = document.getElementById('indices');
  const r = await api.indices();
  if (!r.ok) { box.hidden = true; return; } // 실패하면 조용히 숨긴다(핵심 기능이 아님)

  box.hidden = false;
  box.innerHTML = r.items.map((i) => {
    const color = i.pct === 0 ? cssVar('--flat') : (i.pct > 0 ? UP : DOWN);
    return `<span class="ix"><span class="ixn">${esc(i.name)}</span>`
      + `<span class="ixv">${i.value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      + `<span class="ixp" style="color:${color}">${fmtPct(i.pct)}</span></span>`;
  }).join('');
}

// --- 보유 종목 합계 ---------------------------------------------------------------
// 달러 종목이 섞이면 그냥 더할 수 없어 원화로 환산한다. 환율은 천천히 움직이므로 30분 캐시.
let fxRate = null;
let fxAt = 0;
const FX_TTL = 30 * 60 * 1000;

async function usdKrw() {
  if (fxRate && Date.now() - fxAt < FX_TTL) return fxRate;
  const r = await api.fxUsdKrw();
  if (r.ok) { fxRate = r.rate; fxAt = Date.now(); }
  return fxRate; // 실패하면 직전 값(없으면 null)
}

async function renderFolio() {
  const box = document.getElementById('folio');

  // 수량·평단가가 모두 있고 현재가를 받은 종목만 센다
  const held = state.watchlist
    .map((i) => ({ i, h: state.holdings[i.symbol], q: quotes[i.symbol] }))
    .filter((x) => x.h && x.h.qty > 0 && x.h.avg > 0 && x.q && x.q.price != null);

  if (!held.length) { box.hidden = true; return; }

  const foreign = held.some((x) => curOf(x.i.symbol) !== 'KRW');
  const rate = foreign ? await usdKrw() : null;
  if (foreign && !rate) {
    // 환율을 못 받으면 합계가 틀린 값이 되므로 숫자를 내놓지 않는다
    box.hidden = false;
    box.innerHTML = '<span class="fn">보유</span><span class="fv">환율을 받지 못해 합계를 낼 수 없습니다</span>';
    return;
  }

  let value = 0; let cost = 0;
  for (const { i, h, q } of held) {
    const k = curOf(i.symbol) === 'KRW' ? 1 : rate;
    value += q.price * h.qty * k;
    cost += h.avg * h.qty * k;
  }

  const gain = value - cost;
  const pct = cost > 0 ? (gain / cost) * 100 : 0;
  const color = gain === 0 ? cssVar('--flat') : (gain > 0 ? UP : DOWN);

  box.hidden = false;
  box.innerHTML = `<span class="fn">보유 ${held.length}종목</span>`
    + `<span class="fv">${fmt(Math.round(value))}</span>`
    + (foreign ? `<span class="fx">$${fmt(Math.round(rate))}</span>` : '')
    + `<span class="fp" style="color:${color}">${signed(Math.round(gain))} (${fmtPct(pct)})</span>`;
}

// --- 상세 + 차트 ---------------------------------------------------------------
function renderDetail() {
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  const q = item && quotes[item.symbol];

  const cur = item ? curOf(item.symbol) : 'KRW';
  document.getElementById('dprice').textContent = money(q && q.price, cur);
  // 원화가 아니면 어느 통화인지 이름 옆에 표시
  document.getElementById('dname').textContent = item
    ? (cur === 'KRW' ? item.name : `${item.name} (${cur})`) : '—';

  const chgEl = document.getElementById('dchg');
  const badge = document.getElementById('badge');

  if (q && q.change != null) {
    const color = q.change === 0 ? cssVar('--flat') : (q.change > 0 ? UP : DOWN);
    chgEl.style.color = color;
    chgEl.innerHTML = `${signedMoney(q.change, cur)}<br>${fmtPct(q.pct)}`;
  } else {
    chgEl.textContent = '';
  }

  renderHolding(item && item.symbol, q && q.price);
  renderW52(q && q.week52Low, q && q.week52High, q && q.price, cur);

  const lv = levelOf(q && q.rsi);
  badge.textContent = q && q.rsi != null ? `${lv.label} · RSI ${q.rsi.toFixed(0)}` : 'RSI —';
  badge.style.color = lv.color;
  badge.style.background = q && q.rsi != null ? hexA(lv.color, 0.16) : cssVar('--chip');
}

// 보유 수량·평단가를 입력해 둔 종목이면 평가손익을 보여준다.
function renderHolding(symbol, price) {
  const el = document.getElementById('hold');
  const h = state.holdings[symbol];
  if (!h || price == null) { el.hidden = true; return; }

  const cost = h.qty * h.avg;
  const value = h.qty * price;
  const pl = value - cost;
  const pct = cost ? (pl / cost) * 100 : 0;
  const color = pl === 0 ? cssVar('--flat') : (pl > 0 ? UP : DOWN);

  el.hidden = false;
  const cur = curOf(symbol);
  el.innerHTML = `<span class="hqty">${fmt(h.qty)}주</span>`
    + `<span>평단 ${money(h.avg, cur)}</span>`
    + `<span>평가 ${money(value, cur)}</span>`
    + `<span class="hpl" style="color:${color}">${signedMoney(pl, cur)} (${fmtPct(pct)})</span>`;
}

// 52주 저점~고점 사이에서 현재가가 어디쯤인지. Yahoo meta 값이라 추가 요청이 없다.
function renderW52(low, high, price, cur) {
  const box = document.getElementById('w52');
  if (!low || !high || high <= low || price == null) { box.hidden = true; return; }

  const pos = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  box.hidden = false;
  document.getElementById('w52lo').textContent = money(low, cur);
  document.getElementById('w52hi').textContent = money(high, cur);
  document.getElementById('w52mark').style.left = `${pos}%`;
  box.title = `52주 최저 ${money(low, cur)} · 최고 ${money(high, cur)}\n`
    + `현재 ${money(price, cur)} — 저점 대비 ${fmtPct(((price - low) / low) * 100)}, `
    + `고점 대비 ${fmtPct(((price - high) / high) * 100)}`;
}

// 선택 구간의 수익률 배지. 1D는 위의 일간 등락과 같은 값이라 표시하지 않는다.
function renderPeriod(first, last) {
  const el = document.getElementById('period');
  if (state.timeframe === '1D' || !first || last == null) { el.hidden = true; return; }

  const pct = ((last - first) / first) * 100;
  const color = pct === 0 ? cssVar('--flat') : (pct > 0 ? UP : DOWN);
  el.hidden = false;
  el.textContent = `${state.timeframe} ${fmtPct(pct)}`;
  el.style.color = color;
  el.style.background = hexA(color, 0.16);
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// 이동평균선 범례. 실제로 그린 선만, 기간 숫자 뒤에 그 색을 붙여 보여준다.
// 차트에 마우스를 올리면 그 시점의 값까지 같이 보여준다(툴팁 대신 여기에 띄운다).
let hoverIdx = null;
function renderMaLegend() {
  const box = document.getElementById('maLegend');
  const mas = (lastChart && lastChart.mas) || [];
  box.hidden = mas.length === 0;
  box.innerHTML = '';
  for (const m of mas) {
    const v = hoverIdx == null ? null : m.data[hoverIdx];
    const s = document.createElement('span');
    s.title = `${m.p}일 이동평균`;

    s.append(String(m.p));
    // 값 칸은 비어 있어도 자리를 잡아둔다. 마우스가 올라올 때마다 폭이 변하면
    // 범례가 한 줄에서 두 줄로 접히면서 아래 차트가 들썩인다.
    const val = document.createElement('b');
    val.textContent = v == null ? '' : money(v, lastChart.cur);
    s.appendChild(val);

    const i = document.createElement('i');
    i.style.background = cssVar(m.varName);
    s.appendChild(i);
    box.appendChild(s);
  }
}

// 거래량은 자릿수가 커서 그대로 두면 툴팁이 길어진다
const fmtVol = (v) => {
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`;
  return v.toLocaleString();
};

// 가로 기준선(보유 평단가 · 전일 종가). 데이터셋으로 넣으면 값이 차트 범위 밖일 때
// y축이 통째로 늘어나므로, 축과 무관하게 캔버스에 직접 그리고 범위를 벗어나면 생략한다.
const hLinePlugin = {
  id: 'hLine',
  afterDatasetsDraw(c, _args, opts) {
    const lines = opts.lines || [];
    if (!lines.length) return;
    const area = c.chartArea;
    const ctx = c.ctx;

    for (const ln of lines) {
      const y = c.scales.y.getPixelForValue(ln.value);
      if (y < area.top || y > area.bottom) continue;

      const color = cssVar(ln.varName);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(ln.label, area.left + 2, y - 1);
      ctx.restore();
    }
  },
};

// 마우스를 올린 시점을 세로선으로 짚어준다. 툴팁만으로는 x축 어디인지 눈으로 따라가야 한다.
// 툴팁이 잡고 있는 요소를 그대로 쓰므로 표시 위치가 어긋나지 않는다.
const crosshairPlugin = {
  id: 'crosshair',
  afterDatasetsDraw(c) {
    const active = c.tooltip && c.tooltip.getActiveElements ? c.tooltip.getActiveElements() : [];
    if (!active.length) return;

    const area = c.chartArea;
    const x = active[0].element.x;
    if (x < area.left || x > area.right) return;

    const ctx = c.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar('--crosshair');
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// 가장 최근 교차를 배지로. 차트를 보지 않고 목록만 넘겨도 알 수 있게.
function renderCrossBadge(crosses, times) {
  const el = document.getElementById('cross');
  const last = crosses[crosses.length - 1];
  if (!last) { el.hidden = true; return; }

  const days = Math.round((Date.now() - times[last.i]) / 86400000);
  el.hidden = false;
  el.textContent = `${last.pair} ${last.golden ? '골든' : '데드'} · ${days <= 0 ? '오늘' : `${days}일 전`}`;
  el.classList.toggle('up', last.golden);
  el.classList.toggle('down', !last.golden);
}

// 단기선이 장기선을 뚫은 지점. 위로 뚫으면 골든, 아래로 뚫으면 데드.
function crossings(short, long) {
  const out = [];
  for (let i = 1; i < short.length; i++) {
    const s0 = short[i - 1]; const l0 = long[i - 1];
    const s1 = short[i]; const l1 = long[i];
    if (s0 == null || l0 == null || s1 == null || l1 == null) continue;
    if (s0 <= l0 && s1 > l1) out.push({ i, y: s1, golden: true });
    else if (s0 >= l0 && s1 < l1) out.push({ i, y: s1, golden: false });
  }
  return out;
}

// 교차 지점 표식. 골든은 선 아래에 ▲, 데드는 선 위에 ▼.
// 평단가 점선과 마찬가지로 축을 건드리지 않도록 캔버스에 직접 그린다.
const crossMarkPlugin = {
  id: 'crossMark',
  afterDatasetsDraw(c, _args, opts) {
    const list = opts.list || [];
    if (!list.length) return;
    const area = c.chartArea;
    const ctx = c.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip(); // 축 눈금 위로 삐져나가지 않게

    for (const k of list) {
      const x = c.scales.x.getPixelForValue(k.i);
      const y = c.scales.y.getPixelForValue(k.y);
      const dir = k.golden ? 1 : -1; // 골든은 아래쪽, 데드는 위쪽
      const tip = y + dir * 6;
      ctx.fillStyle = k.golden ? UP : DOWN;
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x - 3.5, tip + dir * 5);
      ctx.lineTo(x + 3.5, tip + dir * 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  },
};

// 차트를 벗어나면 범례를 기간 숫자만 남은 상태로 되돌린다.
// 캔버스는 다시 만들어지지 않으므로 한 번만 붙인다.
let leaveBound = false;
function bindChartLeave() {
  if (leaveBound) return;
  leaveBound = true;
  document.getElementById('chart').addEventListener('mouseleave', () => {
    if (hoverIdx === null) return;
    hoverIdx = null;
    renderMaLegend();
  });
}

let lastChart = null;
function drawChart(arg) {
  lastChart = arg;
  const {
    closes, times, up, mas = [], cur = 'KRW',
    volumes = [], highs = [], lows = [], hLines = [], crosses = [],
  } = arg;
  const color = up ? UP : DOWN;
  hoverIdx = null;
  renderMaLegend(); // 테마를 바꿔도 여기서 다시 그려지므로 색이 따라온다
  if (chart) chart.destroy();
  bindChartLeave();

  // 거래량 막대는 차트 아래 1/4 만 쓰도록 별도 y축을 최댓값의 4배로 잡는다
  const maxVol = volumes.length ? Math.max(...volumes) : 0;

  chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    plugins: [hLinePlugin, crossMarkPlugin, crosshairPlugin],
    data: {
      labels: times.map((t) => labelFor(t, state.timeframe)),
      datasets: [{
        label: '',
        data: closes,
        yAxisID: 'y',
        order: 2, // 거래량 막대(0)·고저 밴드(1)보다 뒤에 그려서 위로 올라온다
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 8,
        tension: 0.15,
        fill: true,
        backgroundColor: (ctx) => {
          const area = ctx.chart.chartArea;
          if (!area) return 'transparent';
          // 채움이 진하면 그 안에 들어간 이동평균선이 묻힌다.
          // 위쪽만 옅게 남기고 아래 절반은 빠르게 비워 이평선이 지나갈 자리를 만든다.
          const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, hexA(color, 0.38));
          g.addColorStop(0.55, hexA(color, 0.12));
          g.addColorStop(1, hexA(color, 0));
          return g;
        },
      },
      // 고가~저가 밴드. 종가 하나만 그리면 하루에 얼마나 흔들렸는지가 안 보인다.
      // 위(고가) 데이터셋이 fill:'+1' 로 바로 다음(저가)까지 채운다 → 배열에서 붙어 있어야 한다.
      ...(highs.length ? [{
        label: '',
        data: highs,
        yAxisID: 'y',
        order: 1,
        borderWidth: 0,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.15,
        fill: '+1',
        backgroundColor: hexA(color, 0.16),
      }, {
        label: '',
        data: lows,
        yAxisID: 'y',
        order: 1,
        borderWidth: 0,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.15,
        fill: false,
      }] : []),
      // 이동평균선 (일봉 타임프레임에서만 전달된다).
      // 전부 80% 불투명도. 주가선은 2px 라 여러 개를 켜도 굵기로 먼저 읽힌다.
      ...mas.map((m) => ({
        data: m.data,
        yAxisID: 'y',
        order: 3,
        borderColor: hexA(cssVar(m.varName), 0.8),
        borderWidth: MA_THICK.has(m.p) ? 1.2 : 1,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
      })),
      // 거래량. label 이 빈 문자열이라 툴팁 본문에는 줄이 생기지 않고,
      // 값은 beforeBody 에서 주가 밑에 따로 붙인다.
      ...(maxVol > 0 ? [{
        type: 'bar',
        label: '',
        isVolume: true,
        data: volumes,
        yAxisID: 'yVol',
        order: 0, // 가장 먼저 = 밴드·주가선·이평선 뒤에
        backgroundColor: hexA(color, 0.2),
        borderWidth: 0,
        barPercentage: 1,
        categoryPercentage: 1,
      }] : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      // 가리키는 시점의 이동평균 값을 범례에 띄운다(툴팁을 늘리지 않기 위해)
      onHover: (_e, els) => {
        const idx = els.length ? els[0].index : null;
        if (idx === hoverIdx) return;
        hoverIdx = idx;
        renderMaLegend();
      },
      plugins: {
        // 범례는 띄우지 않는다. 이동평균을 여러 개 켜면 두 줄로 늘어나
        // 150px 짜리 차트에서 35px 가까이 잡아먹는다.
        // 어느 선이 무엇인지는 설정의 색 있는 칩과 툴팁이 알려준다.
        legend: { display: false },
        hLine: { lines: hLines },
        crossMark: { list: crosses },
        tooltip: {
          // 이동평균 값은 툴팁이 아니라 위쪽 범례에 띄운다.
          // 툴팁은 켠 이평선 수만큼 세로로 늘어나서, 9개면 197px 까지 커져
          // 150px 짜리 차트를 통째로 덮었다. 지금은 날짜·주가·거래량 3줄로 고정된다.
          displayColors: false,
          backgroundColor: cssVar('--tooltip'),
          titleColor: cssVar('--text'),
          bodyColor: cssVar('--text'),
          borderColor: cssVar('--border'),
          borderWidth: 1,
          titleFont: { size: 10 },
          bodyFont: { size: 11 },
          callbacks: {
            // 내용은 전부 beforeBody 로 올린다(본문은 비운다).
            beforeBody: (items) => {
              const lines = [];
              const p = items.find((i) => i.datasetIndex === 0);
              if (p) lines.push(money(p.parsed.y, cur));

              const i = p ? p.dataIndex : -1;
              const hi = highs[i]; const lo = lows[i];
              if (hi != null && lo != null && hi !== lo) {
                lines.push(`고저 ${money(lo, cur)} ~ ${money(hi, cur)}`);
              }

              const v = items.find((x) => x.dataset.isVolume);
              if (v && v.parsed.y) lines.push(`거래량 ${fmtVol(v.parsed.y)}`);
              return lines;
            },
            // 빈 배열을 주면 Chart.js 가 그 줄을 통째로 건너뛴다 → 본문이 비고 높이가 고정된다
            label: () => [],
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: cssVar('--mute'), font: { size: 9 }, maxTicksLimit: 4, maxRotation: 0, autoSkip: true },
        },
        y: {
          position: 'right',
          grid: { color: cssVar('--grid') },
          ticks: { color: cssVar('--mute'), font: { size: 9 }, maxTicksLimit: 4, callback: (v) => money(v, cur) },
        },
        // 거래량 전용 축. 최댓값의 4배를 천장으로 잡아 막대가 아래 1/4 만 차지한다.
        yVol: {
          display: false,
          beginAtZero: true,
          max: maxVol * 4,
          grid: { display: false },
        },
      },
    },
  });
}

// --- 데이터 로딩 ----------------------------------------------------------------
const err = (msg) => { document.getElementById('err').textContent = msg || ''; };

// 시세 조회에 실패한 종목이 있으면 그 메시지, 없으면 빈 문자열
function quoteErrText() {
  const failed = state.watchlist.filter((i) => quotes[i.symbol] && quotes[i.symbol].error);
  return failed.length ? `${failed.length}개 종목 조회 실패: ${quotes[failed[0].symbol].error}` : '';
}

// 일봉 1년치로 현재가/전일종가/RSI를 만든다.
// meta.chartPreviousClose는 "range 시작 직전" 종가라 일간 등락에 쓸 수 없다 → closes[len-2] 사용.
// 일봉 시리즈를 캐시에서 꺼낸다. 만료됐으면 다시 받고, 실패하면 있던 캐시를 그대로 쓴다.
async function dailyFor(symbol, ttl) {
  const cached = dailyCache[symbol];
  if (cached && Date.now() - cached.at < ttl) return cached;

  const r = await api.fetchChart({ symbol, ...DAILY });
  if (!r.ok) return cached || { error: r.error };

  dailyCache[symbol] = {
    at: Date.now(),
    price: r.price,
    closes: r.closes,
    times: r.times,
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
  };
  return dailyCache[symbol];
}

async function loadQuote(item, live) {
  // 실시간 가격이 따로 오면 일봉은 오래 캐시해도 된다.
  // 실시간이 없으면(폴백) 일봉의 가격을 그대로 쓰므로 짧게만 캐시한다.
  const r = await dailyFor(item.symbol, live ? DAILY_TTL : 60000);
  if (!r || r.error) {
    quotes[item.symbol] = { error: r ? r.error : '조회 실패' };
    return;
  }

  const closes = r.closes.slice();
  let price = r.price;
  let prevClose = closes.length >= 2 ? closes[closes.length - 2] : price;

  if (live) {
    // 현재가/전일종가는 실시간 값으로 교체하고, 마지막 일봉 종가도 현재가로 맞춰
    // RSI가 20분 지난 값으로 계산되지 않게 한다
    price = live.price;
    prevClose = live.prevClose;
    if (closes.length) closes[closes.length - 1] = price;
  }

  const change = price - prevClose;
  quotes[item.symbol] = {
    price,
    prevClose,
    change,
    pct: prevClose ? (change / prevClose) * 100 : 0,
    rsi: calcRSI(closes),
    live: !!live,
    open: !!(live && live.open),
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
    // 이동평균 계산용. 1M 차트는 23봉뿐이라 자체 데이터로는 20일선이 끝부분만 그려진다.
    // 이미 받아둔 1년치를 그대로 재활용해 추가 요청 없이 앞구간까지 채운다.
    daily: { times: r.times, closes },
  };
}

// 단순이동평균. 구간이 모자라는 앞부분은 null (Chart.js가 알아서 비워 둔다)
function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 차트 시각(times)에 맞춰 일봉 이동평균을 끌어온다. 일봉이 아닌 타임프레임은 대상 아님.
function maFor(symbol, times, period) {
  const d = quotes[symbol] && quotes[symbol].daily;
  if (!d || d.closes.length < period) return null;

  const values = sma(d.closes, period);
  const byTime = new Map();
  for (let i = 0; i < d.times.length; i++) byTime.set(d.times[i], values[i]);

  const out = times.map((t) => (byTime.has(t) ? byTime.get(t) : null));
  return out.some((v) => v != null) ? out : null;
}

// 실시간 시세 조회 (실패해도 조용히 빈 값 → Yahoo 지연 시세로 동작)
async function fetchLive(symbols) {
  const r = await api.realtimeQuotes(symbols);
  isLive = r.ok;
  if (r.ok) {
    // 실시간 응답에 장 상태가 들어있다. 못 받았으면(폴백) 장중으로 보고 평소 간격을 유지한다.
    const list = Object.values(r.quotes);
    if (list.length) marketOpen = list.some((q) => q.open);
  }
  return r.ok ? r.quotes : {};
}

// 차트 응답 캐시. 종목·타임프레임을 오갈 때마다 같은 걸 다시 받으면
// 매번 네트워크 왕복을 기다리게 된다. 1D(5분봉)만 폴링 주기와 같은 30초로 두고
// 나머지는 5분 — 일봉이 30초마다 바뀔 일은 없다.
const chartCache = new Map(); // `symbol|range|interval` -> { at, ttl, r }
const chartTtl = (interval) => (interval === '5m' ? 30000 : 5 * 60 * 1000);

async function fetchChartCached(symbol, tf) {
  const key = `${symbol}|${tf.range}|${tf.interval}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.r;

  const r = await api.fetchChart({ symbol, ...tf });
  if (!r.ok) return r; // 실패는 캐시하지 않는다 (다음 시도에서 바로 다시 받게)

  // 만료된 항목을 치워 캐시가 무한정 늘지 않게 한다
  const now = Date.now();
  for (const [k, v] of chartCache) if (now - v.at >= v.ttl) chartCache.delete(k);

  chartCache.set(key, { at: now, ttl: chartTtl(tf.interval), r });
  return r;
}

let lastDrawSig = null; // 내용이 그대로면 다시 그리지 않는다

async function loadChart() {
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  if (!item) { document.getElementById('period').hidden = true; return; }

  // 종목/타임프레임을 빠르게 바꾸면 요청이 겹친다. 응답이 뒤늦게 도착한
  // 이전 요청은 버려야 헤더와 차트가 서로 다른 종목을 가리키지 않는다.
  const seq = ++chartSeq;
  const r = await fetchChartCached(item.symbol, TF[state.timeframe]);
  if (seq !== chartSeq) return;

  if (!r.ok) {
    // 실패 시 이전 차트를 남겨두면 헤더와 다른 종목을 보여주게 되므로 지운다
    if (chart) { chart.destroy(); chart = null; }
    lastChart = null;
    lastDrawSig = null;
    renderMaLegend();
    renderCrossBadge([], []);
    document.getElementById('period').hidden = true;
    err(`${item.name} 차트: ${r.error}`);
    return;
  }

  err(quoteErrText());
  const q = quotes[item.symbol];
  const closes = r.closes.slice();
  const times = r.times.slice();

  // Yahoo 1D 봉은 20분 전에서 끊긴다. 장중 실시간이면 현재가를 끝점으로 이어붙여
  // 차트 끝과 위에 표시된 현재가가 어긋나 보이지 않게 한다.
  if (state.timeframe === '1D' && q && q.live && q.open) {
    closes.push(q.price);
    times.push(Date.now());
  }

  // 1D 외에는 "일간 등락"만 보여주면 탭과 안 맞는다. 해당 구간 수익률도 같이 표시.
  renderPeriod(r.closes[0], q && q.price != null ? q.price : closes[closes.length - 1]);

  // 이동평균선은 일봉 타임프레임(1M/3M/1Y)에서만 의미가 있다.
  // 1D(5분봉)/1W(30분봉)에 "5일선"을 그리면 이름과 실제가 안 맞는다.
  const daily = TF[state.timeframe].interval === '1d';
  const bars = daily ? r.times.length : 0;
  if (bars !== chartBars) { chartBars = bars; renderMaChips(); } // 켤 수 있는 기간이 바뀐다

  const mas = [];
  for (const p of state.maPeriods) {
    if (!maFits(p)) continue; // 구간에 비해 너무 긴 선은 y축만 벌리므로 건너뛴다
    const data = maFor(item.symbol, times, p);
    if (data) mas.push({ p, data, varName: `--ma-${p}` });
  }

  // 골든/데드크로스. 양쪽 이평선이 실제로 그려지는 조합만 본다
  // (설정 칩에서 5·20·60 을 다 켜둬야 두 쌍 모두 나온다).
  const byPeriod = new Map(mas.map((m) => [m.p, m.data]));
  const crosses = [];
  for (const [s, l] of CROSS_PAIRS) {
    const a = byPeriod.get(s); const b = byPeriod.get(l);
    if (!a || !b) continue;
    for (const c of crossings(a, b)) crosses.push({ ...c, pair: `${s}/${l}` });
  }
  crosses.sort((x, y) => x.i - y.i);
  renderCrossBadge(crosses, times);

  // 1D 는 현재가를 끝에 이어붙였으므로 봉 단위 배열들보다 한 칸 길다 → 마지막 칸을 채운다
  const pad = (src, fill) => {
    const a = src ? src.slice(0, closes.length) : [];
    while (a.length < closes.length) a.push(typeof fill === 'function' ? fill(a.length) : fill);
    return a;
  };
  const volumes = pad(r.volumes, 0);
  const highs = pad(r.highs, (i) => closes[i]);
  const lows = pad(r.lows, (i) => closes[i]);

  const held = state.holdings[item.symbol];
  const up = !q || q.change >= 0;

  // 가로 기준선. 전일 종가는 장중(1D)에만 의미가 있다 —
  // 일봉 차트에서는 마지막에서 두 번째 점일 뿐이라 기준선이 될 이유가 없다.
  const hLines = [];
  if (held && held.avg > 0) hLines.push({ value: held.avg, label: '평단', varName: '--avg-line' });
  if (state.timeframe === '1D' && q && q.prevClose != null) {
    hLines.push({ value: q.prevClose, label: '전일', varName: '--prev-line' });
  }

  // 30초마다 캐시에서 같은 데이터가 나오면 다시 그릴 이유가 없다.
  // 다시 그리면 차트가 통째로 재생성돼 마우스를 올려둔 범례 값도 같이 지워진다.
  const sig = `${item.symbol}|${state.timeframe}|${closes.length}`
    + `|${closes[closes.length - 1]}|${up}|${mas.map((m) => m.p).join()}`
    + `|${hLines.map((l) => l.value).join()}`;
  if (sig === lastDrawSig) return;
  lastDrawSig = sig;

  drawChart({
    closes, times, up, mas, cur: curOf(item.symbol),
    volumes, highs, lows, crosses, hLines,
  });
}

async function refreshAll() {
  if (busy) return;
  busy = true;
  try {
    await loadIndices();

    // 목표가 "통과" 판정을 위해 갱신 전 가격을 기억해 둔다
    const prevPrices = {};
    for (const i of state.watchlist) prevPrices[i.symbol] = quotes[i.symbol] && quotes[i.symbol].price;

    // 실시간 현재가는 한 번에 (요청 1건), 일봉은 rate limit 고려해 종목별 순차
    const liveMap = await fetchLive(state.watchlist.map((i) => i.symbol));
    for (const item of state.watchlist) {
      await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
      renderList();
    }
    checkAlerts(prevPrices);
    err(quoteErrText());
    renderDetail();
    await renderFolio();
    await loadChart();

    // 시세가 실시간인지 20분 지연인지 숨기지 않고 표시한다
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    document.getElementById('updated').innerHTML =
      `<span class="${!isLive ? 'delay' : marketOpen ? 'live' : 'closed'}">`
      + `${!isLive ? '20분지연' : marketOpen ? '실시간' : '장마감'}</span> `
      + `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  } finally {
    busy = false;
  }
}

// --- 조작 -----------------------------------------------------------------------
const save = () => api.setState({
  watchlist: state.watchlist,
  selected: state.selected,
  timeframe: state.timeframe,
  alerts: state.alerts,
  holdings: state.holdings,
  theme: state.theme,
  opacity: state.opacity,
  maPeriods: state.maPeriods,
});

async function select(symbol) {
  state.selected = symbol;
  save();
  renderList();
  renderDetail();
  await loadChart();
}

// --- 관심종목 추가/삭제 -----------------------------------------------------------
// 삭제는 관심종목만이 아니라 직접 입력한 목표가·보유(수량·평단가)까지 같이 지운다.
// 평단가는 다른 데서 복원되지 않으므로, 막는 대신 잠깐 되돌릴 기회를 준다.
// 실수는 보통 한 번이라 마지막 하나만 기억한다.
const UNDO_MS = 6000;
let undoSnap = null;
let undoTimer = null;

function hideUndo() {
  clearTimeout(undoTimer);
  undoSnap = null;
  document.getElementById('undo').hidden = true;
}

function showUndo(snap) {
  undoSnap = snap;
  document.getElementById('undoText').textContent = `${snap.item.name} 삭제됨`;
  document.getElementById('undo').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, UNDO_MS);
}

async function undoRemove() {
  const s = undoSnap;
  if (!s) return;
  hideUndo();

  // 원래 자리에 다시 끼워 넣는다 (그 사이 목록이 짧아졌으면 끝에)
  state.watchlist.splice(Math.min(s.index, state.watchlist.length), 0, s.item);
  if (s.target) state.alerts.targets[s.item.symbol] = s.target;
  if (s.holding) state.holdings[s.item.symbol] = s.holding;
  save();

  renderList();
  if (s.wasSelected) await select(s.item.symbol);

  // 시세 캐시도 지웠으므로 그 종목만 다시 받는다.
  // refreshAll 은 폴링이 도는 중이면 busy 로 그냥 빠져나가 값이 한참 비어 보인다.
  const live = await fetchLive([s.item.symbol]);
  await loadQuote(s.item, live[s.item.symbol.split('.')[0]]);
  renderList();
  renderDetail();
  await renderFolio();
}

async function removeSymbol(symbol) {
  const index = state.watchlist.findIndex((i) => i.symbol === symbol);
  const item = state.watchlist[index];
  if (!item) return;
  showUndo({
    item,
    index,
    target: state.alerts.targets[symbol],
    holding: state.holdings[symbol],
    wasSelected: state.selected === symbol,
  });

  state.watchlist = state.watchlist.filter((i) => i.symbol !== symbol);
  delete quotes[symbol];
  delete state.alerts.targets[symbol]; // 지운 종목의 목표가가 남지 않게
  delete state.holdings[symbol];

  // 보고 있던 종목을 지웠으면 첫 종목으로 옮긴다
  if (state.selected === symbol) {
    state.selected = state.watchlist.length ? state.watchlist[0].symbol : null;
  }
  save();
  renderList();
  renderDetail();
  renderFolio();

  if (state.selected) await loadChart();
  else if (chart) {
    chart.destroy(); chart = null; lastChart = null; lastDrawSig = null;
    renderMaLegend(); renderCrossBadge([], []);
  }
}

async function addSymbol(item) {
  if (state.watchlist.some((i) => i.symbol === item.symbol)) return;

  // 네이버에는 있어도 Yahoo에 없는 종목이 있다 → 먼저 조회해보고 되는 것만 추가
  hint('추가하는 중…');
  const liveMap = await fetchLive([item.symbol]);
  await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
  if (quotes[item.symbol].error) {
    hint(`${item.name}: Yahoo에서 조회되지 않습니다 (${quotes[item.symbol].error})`);
    delete quotes[item.symbol];
    return;
  }

  state.watchlist.push({ symbol: item.symbol, name: item.name });
  save();
  closeSearch();
  renderList();
  await select(item.symbol);
}

// --- 키보드 ------------------------------------------------------------------------
// 항상 떠 있는 작은 창이라 매번 행을 마우스로 조준하는 게 번거롭다.
// 입력 중이거나 패널(검색·설정)이 열려 있으면 그쪽이 우선이라 아무것도 하지 않는다.
function moveSelection(step) {
  const list = state.watchlist;
  if (!list.length) return;

  const cur = list.findIndex((i) => i.symbol === state.selected);
  const next = cur < 0 ? list[0] : list[(cur + step + list.length) % list.length];
  select(next.symbol).then(() => {
    const row = document.querySelector('#list .row.on');
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!searchEl.hidden || !alertsEl.hidden) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    if (!undoSnap) return;
    e.preventDefault();
    undoRemove();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  const tabs = Object.keys(TF); // 1~5 → 1D · 1W · 1M · 3M · 1Y
  if (e.key >= '1' && e.key <= String(tabs.length)) {
    const key = tabs[Number(e.key) - 1];
    if (key === state.timeframe) return;
    state.timeframe = key;
    save();
    renderTabs();
    loadChart();
    return;
  }

  if (e.key === 'Escape') setCompact(!compact);
});

// --- 접기/펴기 ---------------------------------------------------------------------
let compact = false;

// 관심종목 3행이 딱 들어가는 높이를 실제 DOM에서 재서 메인에 넘긴다
// (배율·폰트에 따라 행 높이가 달라지므로 픽셀 상수를 쓰지 않는다)
function setCompact(on) {
  const bar = document.querySelector('.bar').offsetHeight;
  const idx = document.getElementById('indices');
  const idxH = idx.hidden ? 0 : idx.offsetHeight; // 지수 줄은 접어도 계속 보여준다
  const folio = document.getElementById('folio');
  const folioH = folio.hidden ? 0 : folio.offsetHeight; // 보유 합계도 접힌 상태에서 계속 보여준다
  const row = document.querySelector('#list .row');
  const height = bar + idxH + folioH + (row ? row.offsetHeight * 3 : 93) + 2; // +2 = 위아래 테두리

  compact = on;
  document.querySelector('.widget').classList.toggle('compact', on);
  const btn = document.getElementById('dock');
  btn.classList.toggle('on', on);
  btn.title = on ? '원래 크기로' : '우하단으로 접기';
  api.dockWindow(on, height);
}

// --- 검색 -------------------------------------------------------------------------
const searchEl = document.getElementById('search');
const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const hintEl = document.getElementById('qhint');
const alertsEl = document.getElementById('alerts');
let searchSeq = 0;
let searchTimer = null;
let expandedForPanel = false; // 접힌 상태에서 패널을 보려고 펼친 것인지 (닫을 때 되접기)

// 검색·알림 패널은 접힌 상태에서 열면 잠깐 펼쳤다가, 모두 닫히면 다시 접는다
function openPanel(el) {
  if (compact) { setCompact(false); expandedForPanel = true; }
  searchEl.hidden = true;
  alertsEl.hidden = true;
  el.hidden = false;
}

function closePanel(el) {
  el.hidden = true;
  if (expandedForPanel && searchEl.hidden && alertsEl.hidden) {
    expandedForPanel = false;
    setCompact(true);
  }
}

const hint = (msg) => { hintEl.textContent = msg || ''; hintEl.hidden = !msg; };

function openSearch() {
  openPanel(searchEl);
  qEl.value = '';
  resultsEl.innerHTML = '';
  hint('종목명 또는 코드를 입력하세요');
  qEl.focus();
}

function closeSearch() {
  clearTimeout(searchTimer);
  closePanel(searchEl);
}

async function runSearch() {
  const query = qEl.value.trim();
  if (!query) { resultsEl.innerHTML = ''; hint('종목명 또는 코드를 입력하세요'); return; }

  const seq = ++searchSeq;
  hint('검색 중…');
  const r = await api.search(query);
  if (seq !== searchSeq) return; // 늦게 도착한 이전 검색 결과는 버린다

  resultsEl.innerHTML = '';
  if (!r.ok) { hint(`검색 실패: ${r.error}`); return; }
  if (!r.items.length) { hint('결과가 없습니다'); return; }

  hint('');
  for (const it of r.items) {
    const dup = state.watchlist.some((w) => w.symbol === it.symbol);
    const el = document.createElement('div');
    el.className = 'hit' + (dup ? ' dup' : '');
    el.innerHTML = `<span class="hname">${esc(it.name)}</span>`
      + `<span class="hmeta">${esc(it.symbol.split('.')[0])} · ${esc(it.market)}${dup ? ' · 추가됨' : ''}</span>`;
    if (!dup) el.onclick = () => addSymbol(it);
    resultsEl.appendChild(el);
  }
}

// --- 테마 -------------------------------------------------------------------------
// 색은 CSS 변수라 data-theme 만 바꾸면 화면은 즉시 따라온다.
// 차트는 그릴 때 값을 읽어가므로 한 번 다시 그려준다(네트워크 재요청 없음).
function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  for (const b of document.querySelectorAll('#themeSeg button')) {
    b.classList.toggle('on', b.dataset.theme === state.theme);
  }
  if (lastChart) drawChart(lastChart);
  renderList();
  renderDetail();
  renderMaChips(); // 칩 색도 테마를 따라간다
}

// 평소(마우스가 벗어났을 때) 불투명도. preview=true 면 hover 중에도 그 값으로 보여준다.
let previewTimer = null;
function applyOpacity(pct, preview = false) {
  const v = Math.min(100, Math.max(30, Number(pct) || 74));
  state.opacity = v;
  document.documentElement.style.setProperty('--idle-opacity', String(v / 100));
  document.getElementById('opacityVal').textContent = `${v}%`;
  document.getElementById('opacity').value = String(v);

  if (!preview) return;
  // 조절하는 동안에는 마우스가 위젯 위에 있어 hover 로 또렷해진다.
  // 잠깐 hover 를 무시해 실제 진하기를 보여주고, 손을 떼면 원래대로.
  const w = document.querySelector('.widget');
  w.classList.add('preview');
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => w.classList.remove('preview'), 900);
}

// 표시할 이동평균 기간 선택. 켜진 칩은 실제 선 색을 그대로 띠어 차트와 대조하기 쉽다.
function renderMaChips() {
  const box = document.getElementById('maChips');
  box.innerHTML = '';

  for (const p of MA_PERIODS) {
    const on = state.maPeriods.includes(p);
    const fits = maFits(p);
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(p);
    b.title = fits
      ? `${p}일 이동평균`
      : `${p}일 이동평균 — ${state.timeframe} 구간에는 너무 길어 지금은 그리지 않습니다`;
    if (on) {
      const c = cssVar(`--ma-${p}`);
      b.className = fits ? 'on' : 'on off';
      b.style.color = c;
      b.style.borderColor = c;
      b.style.background = hexA(c, 0.14);
    } else if (!fits) {
      b.className = 'off';
    }
    b.onclick = () => {
      state.maPeriods = on
        ? state.maPeriods.filter((x) => x !== p)
        : [...state.maPeriods, p].sort((x, y) => x - y);
      save();
      renderMaChips();
      loadChart();
    };
    box.appendChild(b);
  }
}

// --- 목표가 알림 -------------------------------------------------------------------
// 알림은 기본 꺼짐. 사용자가 "알림 사용"을 켜야만 실제로 알린다.
function openAlerts() {
  openPanel(alertsEl);
  renderAlerts();
  renderMaChips();
}

const closeAlerts = () => closePanel(alertsEl);

function renderAlerts() {
  const on = state.alerts.enabled;
  document.getElementById('alertOn').checked = on;
  alertsEl.classList.toggle('off', !on);
  document.getElementById('alertHint').textContent = on
    ? '장중에 목표가를 통과하면 알립니다 (통과 시 1회)'
    : '알림이 꺼져 있습니다. 위 "사용"을 켜야 동작합니다.';

  const alertBox = document.getElementById('alertRows');
  const holdBox = document.getElementById('holdRows');
  alertBox.innerHTML = '';
  holdBox.innerHTML = '';

  if (!state.watchlist.length) {
    alertBox.innerHTML = '<div class="empty">관심종목이 없습니다.</div>';
    return;
  }

  // 두 섹션 모두 "종목명 + 숫자 입력 2칸" 형태라 한 함수로 만든다.
  const buildRow = (item, fields, onSave) => {
    const row = document.createElement('div');
    row.className = 'arow';
    row.innerHTML = `<span class="aname">${esc(item.name)}</span>`
      + fields.map((f) => `<input class="${f.cls}" type="number" placeholder="${f.ph}"`
        + ` value="${f.value != null ? f.value : ''}" />`).join('');
    for (const f of fields) row.querySelector(`.${f.cls}`).onchange = onSave(row);
    return row;
  };

  for (const item of state.watchlist) {
    const t = state.alerts.targets[item.symbol] || {};
    alertBox.appendChild(buildRow(item, [
      { cls: 'up', ph: '상한', value: t.up },
      { cls: 'dn', ph: '하한', value: t.down },
    ], (row) => () => {
      const up = parseFloat(row.querySelector('.up').value);
      const down = parseFloat(row.querySelector('.dn').value);
      const next = {};
      if (Number.isFinite(up)) next.up = up;
      if (Number.isFinite(down)) next.down = down;
      if (Object.keys(next).length) state.alerts.targets[item.symbol] = next;
      else delete state.alerts.targets[item.symbol];
      save();
    }));

    const h = state.holdings[item.symbol] || {};
    holdBox.appendChild(buildRow(item, [
      { cls: 'qty', ph: '수량', value: h.qty },
      { cls: 'avg', ph: '평단가', value: h.avg },
    ], (row) => () => {
      const qty = parseFloat(row.querySelector('.qty').value);
      const avg = parseFloat(row.querySelector('.avg').value);
      // 수량과 평단가가 모두 있어야 평가손익을 낼 수 있다
      if (Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0) {
        state.holdings[item.symbol] = { qty, avg };
      } else {
        delete state.holdings[item.symbol];
      }
      save();
      renderDetail();
      renderFolio();
    }));
  }
}

// 목표가 "통과" 시에만 알린다. 이전 가격이 없는 첫 갱신은 기준만 잡고 넘어가므로
// 앱을 켜자마자 이미 목표가를 넘긴 종목이 무더기로 울리지 않는다.
function checkAlerts(prevPrices) {
  if (!state.alerts.enabled || !marketOpen) return;

  for (const item of state.watchlist) {
    const t = state.alerts.targets[item.symbol];
    const q = quotes[item.symbol];
    const prev = prevPrices[item.symbol];
    if (!t || !q || q.error || prev == null) continue;

    if (t.up != null && prev < t.up && q.price >= t.up) {
      api.notify({ title: `${item.name} 상한 도달`, body: `${fmt(q.price)}원 (목표 ${fmt(t.up)}원)` });
    }
    if (t.down != null && prev > t.down && q.price <= t.down) {
      api.notify({ title: `${item.name} 하한 도달`, body: `${fmt(q.price)}원 (목표 ${fmt(t.down)}원)` });
    }
  }
}

function renderTabs() {
  const box = document.getElementById('tf');
  box.innerHTML = '';
  for (const key of Object.keys(TF)) {
    const b = document.createElement('button');
    b.textContent = key;
    b.className = key === state.timeframe ? 'on' : '';
    b.onclick = async () => {
      state.timeframe = key;
      save();
      renderTabs();
      await loadChart();
    };
    box.appendChild(b);
  }
}

// --- 시작 -----------------------------------------------------------------------
(async function init() {
  document.getElementById('dock').onclick = () => {
    // 패널이 열린 채로 직접 접기를 누르면 패널만 닫고, 복귀 예약은 취소한다
    if (!searchEl.hidden || !alertsEl.hidden) {
      expandedForPanel = false;
      closeSearch();
      closeAlerts();
    }
    setCompact(!compact);
  };

  document.getElementById('min').onclick = () => api.minimizeWindow();
  document.getElementById('close').onclick = () => api.closeWindow();
  document.getElementById('undoBtn').onclick = () => undoRemove();

  document.getElementById('add').onclick = () => (searchEl.hidden ? openSearch() : closeSearch());
  document.getElementById('qclose').onclick = closeSearch;

  document.getElementById('bell').onclick = () => (alertsEl.hidden ? openAlerts() : closeAlerts());
  document.getElementById('alertClose').onclick = closeAlerts;
  for (const b of document.querySelectorAll('#themeSeg button')) {
    b.onclick = () => { applyTheme(b.dataset.theme); save(); };
  }
  const opEl = document.getElementById('opacity');
  opEl.oninput = () => applyOpacity(opEl.value, true); // 끄는 동안 미리보기
  opEl.onchange = () => save();                       // 손을 뗄 때만 저장
  document.getElementById('alertOn').onchange = (e) => {
    state.alerts.enabled = e.target.checked;
    save();
    renderAlerts();
  };
  alertsEl.onkeydown = (e) => { if (e.key === 'Escape') closeAlerts(); };
  qEl.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); };
  qEl.onkeydown = (e) => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      const first = resultsEl.querySelector('.hit:not(.dup)');
      if (first) first.click(); else runSearch();
    }
  };

  state = await api.getState();
  if (!state.alerts) state.alerts = { enabled: false, targets: {} };
  if (!state.alerts.targets) state.alerts.targets = {};
  if (!state.holdings) state.holdings = {};
  // 저장된 값에 모르는 기간이 섞여 있으면 걸러낸다
  state.maPeriods = Array.isArray(state.maPeriods)
    ? state.maPeriods.filter((p) => MA_PERIODS.includes(p)).sort((a, b) => a - b)
    : [5, 20, 60];
  applyTheme(state.theme);
  applyOpacity(state.opacity);
  renderMaChips();
  if (!state.watchlist.some((i) => i.symbol === state.selected)) {
    // 관심종목이 비어 있으면 undefined 가 되는데, 그대로 저장하면 electron-store 가 거부한다
    state.selected = (state.watchlist[0] && state.watchlist[0].symbol) || null;
  }

  renderTabs();
  renderList();
  renderDetail();

  // 장 마감 후에는 값이 바뀌지 않으므로 폴링 간격을 늘린다 (밤새 켜둬도 요청이 거의 없음).
  // 완전히 멈추면 개장을 감지하지 못하므로 5분마다 한 번은 확인한다.
  await refreshAll();
  const tick = async () => {
    await refreshAll();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, marketOpen ? POLL_OPEN : POLL_CLOSED);
  };
  pollTimer = setTimeout(tick, marketOpen ? POLL_OPEN : POLL_CLOSED);
})();
