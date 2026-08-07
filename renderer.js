// renderer.js — UI 렌더링, RSI(14) 계산, Chart.js 그리기, 30초 폴링.
// 네트워크는 전부 window.api.fetchChart(preload → 메인 프로세스)를 통해서만 나간다.

const UP = '#e24b4a';   // 상승 = 빨강 (한국 관례)
const DOWN = '#185fa5'; // 하락 = 파랑

const TF = {
  '1D': { range: '1d', interval: '5m' },
  '1W': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
};

// RSI 계산 및 리스트 가격/등락에 쓰는 일봉 시리즈 (충분한 표본을 위해 1년치)
const DAILY = { range: '1y', interval: '1d' };

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
  if (rsi == null) return { label: '—', color: '#4a5261' };
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
// 등락률은 자릿수가 흔들리지 않게 항상 소수 2자리
const fmtPct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';

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
    const color = flat ? '#9aa4b5' : (up ? UP : DOWN);

    row.innerHTML = `
      <span class="dot" style="background:${lv.color}"></span>
      <span class="name">${esc(item.name)}</span>
      <span class="px" style="color:${color}">${q && q.price != null ? fmt(q.price) : '—'}</span>
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
    const color = i.pct === 0 ? '#9aa4b5' : (i.pct > 0 ? UP : DOWN);
    return `<span class="ix"><span class="ixn">${esc(i.name)}</span>`
      + `<span class="ixv">${i.value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      + `<span class="ixp" style="color:${color}">${fmtPct(i.pct)}</span></span>`;
  }).join('');
}

// --- 상세 + 차트 ---------------------------------------------------------------
function renderDetail() {
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  const q = item && quotes[item.symbol];

  document.getElementById('dname').textContent = item ? item.name : '—';
  document.getElementById('dprice').textContent = q && q.price != null ? fmt(q.price) : '—';

  const chgEl = document.getElementById('dchg');
  const badge = document.getElementById('badge');

  if (q && q.change != null) {
    const color = q.change === 0 ? '#9aa4b5' : (q.change > 0 ? UP : DOWN);
    chgEl.style.color = color;
    chgEl.innerHTML = `${signed(q.change)}<br>${fmtPct(q.pct)}`;
  } else {
    chgEl.textContent = '';
  }

  renderHolding(item && item.symbol, q && q.price);
  renderW52(q && q.week52Low, q && q.week52High, q && q.price);

  const lv = levelOf(q && q.rsi);
  badge.textContent = q && q.rsi != null ? `${lv.label} · RSI ${q.rsi.toFixed(0)}` : 'RSI —';
  badge.style.color = lv.color;
  badge.style.background = q && q.rsi != null ? hexA(lv.color, 0.16) : 'rgba(255,255,255,.07)';
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
  const color = pl === 0 ? '#9aa4b5' : (pl > 0 ? UP : DOWN);

  el.hidden = false;
  el.innerHTML = `<span class="hqty">${fmt(h.qty)}주</span>`
    + `<span>평단 ${fmt(h.avg)}</span>`
    + `<span>평가 ${fmt(value)}</span>`
    + `<span class="hpl" style="color:${color}">${signed(pl)} (${fmtPct(pct)})</span>`;
}

// 52주 저점~고점 사이에서 현재가가 어디쯤인지. Yahoo meta 값이라 추가 요청이 없다.
function renderW52(low, high, price) {
  const box = document.getElementById('w52');
  if (!low || !high || high <= low || price == null) { box.hidden = true; return; }

  const pos = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  box.hidden = false;
  document.getElementById('w52lo').textContent = fmt(low);
  document.getElementById('w52hi').textContent = fmt(high);
  document.getElementById('w52mark').style.left = `${pos}%`;
  box.title = `52주 최저 ${fmt(low)} · 최고 ${fmt(high)}\n`
    + `현재 ${fmt(price)} — 저점 대비 ${fmtPct(((price - low) / low) * 100)}, `
    + `고점 대비 ${fmtPct(((price - high) / high) * 100)}`;
}

// 선택 구간의 수익률 배지. 1D는 위의 일간 등락과 같은 값이라 표시하지 않는다.
function renderPeriod(first, last) {
  const el = document.getElementById('period');
  if (state.timeframe === '1D' || !first || last == null) { el.hidden = true; return; }

  const pct = ((last - first) / first) * 100;
  const color = pct === 0 ? '#9aa4b5' : (pct > 0 ? UP : DOWN);
  el.hidden = false;
  el.textContent = `${state.timeframe} ${fmtPct(pct)}`;
  el.style.color = color;
  el.style.background = hexA(color, 0.16);
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function drawChart(closes, times, up, mas = []) {
  const color = up ? UP : DOWN;
  if (chart) chart.destroy();

  chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels: times.map((t) => labelFor(t, state.timeframe)),
      datasets: [{
        label: '',
        data: closes,
        borderColor: color,
        borderWidth: 1.4,
        pointRadius: 0,
        pointHitRadius: 8,
        tension: 0.15,
        fill: true,
        backgroundColor: (ctx) => {
          const area = ctx.chart.chartArea;
          if (!area) return 'transparent';
          const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, hexA(color, 0.38));
          g.addColorStop(1, hexA(color, 0));
          return g;
        },
      },
      // 이동평균선 (일봉 타임프레임에서만 전달된다)
      ...mas.map((m) => ({
        label: m.label,
        data: m.data,
        borderColor: m.color,
        borderWidth: 1,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
      })),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        // 이동평균선이 있을 때만 어느 선인지 알려주는 작은 범례를 띄운다
        legend: {
          display: mas.length > 0,
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 9, boxHeight: 2, padding: 6,
            font: { size: 9 }, color: '#8a94a6',
            filter: (item) => !!item.text,
          },
        },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(10,13,18,.94)',
          titleFont: { size: 10 },
          bodyFont: { size: 11 },
          callbacks: {
            label: (c) => (c.dataset.label ? `${c.dataset.label} ${fmt(c.parsed.y)}` : fmt(c.parsed.y)),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#6f7a8c', font: { size: 9 }, maxTicksLimit: 4, maxRotation: 0, autoSkip: true },
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(255,255,255,.06)' },
          ticks: { color: '#6f7a8c', font: { size: 9 }, maxTicksLimit: 4, callback: fmt },
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
async function loadQuote(item, live) {
  const r = await api.fetchChart({ symbol: item.symbol, ...DAILY });
  if (!r.ok) {
    quotes[item.symbol] = { error: r.error };
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

async function loadChart() {
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  if (!item) { document.getElementById('period').hidden = true; return; }

  // 종목/타임프레임을 빠르게 바꾸면 요청이 겹친다. 응답이 뒤늦게 도착한
  // 이전 요청은 버려야 헤더와 차트가 서로 다른 종목을 가리키지 않는다.
  const seq = ++chartSeq;
  const r = await api.fetchChart({ symbol: item.symbol, ...TF[state.timeframe] });
  if (seq !== chartSeq) return;

  if (!r.ok) {
    // 실패 시 이전 차트를 남겨두면 헤더와 다른 종목을 보여주게 되므로 지운다
    if (chart) { chart.destroy(); chart = null; }
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

  // 이동평균선은 일봉 타임프레임(1M/1Y)에서만 의미가 있다.
  // 1D(5분봉)/1W(30분봉)에 "5일선"을 그리면 이름과 실제가 안 맞는다.
  const mas = [];
  if (TF[state.timeframe].interval === '1d') {
    const ma5 = maFor(item.symbol, times, 5);
    const ma20 = maFor(item.symbol, times, 20);
    if (ma5) mas.push({ label: '5일', data: ma5, color: '#d8a13f' });
    if (ma20) mas.push({ label: '20일', data: ma20, color: '#6f8fd6' });
  }

  drawChart(closes, times, !q || q.change >= 0, mas);
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
});

async function select(symbol) {
  state.selected = symbol;
  save();
  renderList();
  renderDetail();
  await loadChart();
}

// --- 관심종목 추가/삭제 -----------------------------------------------------------
async function removeSymbol(symbol) {
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

  if (state.selected) await loadChart();
  else if (chart) { chart.destroy(); chart = null; }
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

// --- 접기/펴기 ---------------------------------------------------------------------
let compact = false;

// 관심종목 3행이 딱 들어가는 높이를 실제 DOM에서 재서 메인에 넘긴다
// (배율·폰트에 따라 행 높이가 달라지므로 픽셀 상수를 쓰지 않는다)
function setCompact(on) {
  const bar = document.querySelector('.bar').offsetHeight;
  const idx = document.getElementById('indices');
  const idxH = idx.hidden ? 0 : idx.offsetHeight; // 지수 줄은 접어도 계속 보여준다
  const row = document.querySelector('#list .row');
  const height = bar + idxH + (row ? row.offsetHeight * 3 : 93) + 2; // +2 = 위아래 테두리

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

// --- 목표가 알림 -------------------------------------------------------------------
// 알림은 기본 꺼짐. 사용자가 "알림 사용"을 켜야만 실제로 알린다.
function openAlerts() {
  openPanel(alertsEl);
  renderAlerts();
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

  document.getElementById('add').onclick = () => (searchEl.hidden ? openSearch() : closeSearch());
  document.getElementById('qclose').onclick = closeSearch;

  document.getElementById('bell').onclick = () => (alertsEl.hidden ? openAlerts() : closeAlerts());
  document.getElementById('alertClose').onclick = closeAlerts;
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
  if (!state.watchlist.some((i) => i.symbol === state.selected)) {
    state.selected = state.watchlist[0] && state.watchlist[0].symbol;
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
