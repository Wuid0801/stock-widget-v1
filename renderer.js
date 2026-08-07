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
let chart = null;
let busy = false;
let chartSeq = 0; // 차트 요청 순번 — 응답이 역순으로 도착해도 마지막 것만 반영
let isLive = false; // 마지막 갱신이 실시간 시세였는지 (실패 시 Yahoo 20분 지연)

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

  for (const item of state.watchlist) {
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
    list.appendChild(row);
  }
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

  const lv = levelOf(q && q.rsi);
  badge.textContent = q && q.rsi != null ? `${lv.label} · RSI ${q.rsi.toFixed(0)}` : 'RSI —';
  badge.style.color = lv.color;
  badge.style.background = q && q.rsi != null ? hexA(lv.color, 0.16) : 'rgba(255,255,255,.07)';
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function drawChart(closes, times, up) {
  const color = up ? UP : DOWN;
  if (chart) chart.destroy();

  chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels: times.map((t) => labelFor(t, state.timeframe)),
      datasets: [{
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
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(10,13,18,.94)',
          titleFont: { size: 10 },
          bodyFont: { size: 11 },
          callbacks: { label: (c) => fmt(c.parsed.y) },
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
  };
}

// 실시간 시세 조회 (실패해도 조용히 빈 값 → Yahoo 지연 시세로 동작)
async function fetchLive(symbols) {
  const r = await api.realtimeQuotes(symbols);
  isLive = r.ok;
  return r.ok ? r.quotes : {};
}

async function loadChart() {
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  if (!item) return;

  // 종목/타임프레임을 빠르게 바꾸면 요청이 겹친다. 응답이 뒤늦게 도착한
  // 이전 요청은 버려야 헤더와 차트가 서로 다른 종목을 가리키지 않는다.
  const seq = ++chartSeq;
  const r = await api.fetchChart({ symbol: item.symbol, ...TF[state.timeframe] });
  if (seq !== chartSeq) return;

  if (!r.ok) {
    // 실패 시 이전 차트를 남겨두면 헤더와 다른 종목을 보여주게 되므로 지운다
    if (chart) { chart.destroy(); chart = null; }
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

  drawChart(closes, times, !q || q.change >= 0);
}

async function refreshAll() {
  if (busy) return;
  busy = true;
  try {
    // 실시간 현재가는 한 번에 (요청 1건), 일봉은 rate limit 고려해 종목별 순차
    const liveMap = await fetchLive(state.watchlist.map((i) => i.symbol));
    for (const item of state.watchlist) {
      await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
      renderList();
    }
    err(quoteErrText());
    renderDetail();
    await loadChart();

    // 시세가 실시간인지 20분 지연인지 숨기지 않고 표시한다
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    document.getElementById('updated').innerHTML =
      `<span class="${isLive ? 'live' : 'delay'}">${isLive ? '실시간' : '20분지연'}</span> `
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

// --- 검색 -------------------------------------------------------------------------
const searchEl = document.getElementById('search');
const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const hintEl = document.getElementById('qhint');
let searchSeq = 0;
let searchTimer = null;

const hint = (msg) => { hintEl.textContent = msg || ''; hintEl.hidden = !msg; };

function openSearch() {
  // 접힌 상태에서는 결과를 보여줄 공간이 없으니 먼저 편다
  if (document.querySelector('.widget').classList.contains('compact')) {
    document.getElementById('dock').click();
  }
  searchEl.hidden = false;
  qEl.value = '';
  resultsEl.innerHTML = '';
  hint('종목명 또는 코드를 입력하세요');
  qEl.focus();
}

function closeSearch() {
  clearTimeout(searchTimer);
  searchEl.hidden = true;
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
  // 접기: 관심종목 3행이 딱 들어가는 높이를 실제 DOM에서 재서 메인에 넘긴다
  const dockBtn = document.getElementById('dock');
  let compact = false;
  dockBtn.onclick = () => {
    const bar = document.querySelector('.bar').offsetHeight;
    const row = document.querySelector('#list .row');
    const height = bar + (row ? row.offsetHeight * 3 : 93) + 2; // +2 = 위아래 테두리

    compact = !compact;
    document.querySelector('.widget').classList.toggle('compact', compact);
    dockBtn.classList.toggle('on', compact);
    dockBtn.title = compact ? '원래 크기로' : '우하단으로 접기';
    api.dockWindow(compact, height);
  };

  document.getElementById('min').onclick = () => api.minimizeWindow();
  document.getElementById('close').onclick = () => api.closeWindow();

  document.getElementById('add').onclick = () => (searchEl.hidden ? openSearch() : closeSearch());
  document.getElementById('qclose').onclick = closeSearch;
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
  if (!state.watchlist.some((i) => i.symbol === state.selected)) {
    state.selected = state.watchlist[0] && state.watchlist[0].symbol;
  }

  renderTabs();
  renderList();
  renderDetail();

  await refreshAll();
  setInterval(refreshAll, 30000);
})();
