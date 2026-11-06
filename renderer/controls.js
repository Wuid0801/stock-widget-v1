// renderer/controls.js — 차트 조작 — 라인/캔들 · 확대 · 기간 탭 · 차트 왼쪽 위 버튼.

// 라인 / 캔들 전환 아이콘(차트 왼쪽 위). 그림은 지금 모드를, title 은 누르면 어떻게
// 되는지를 말한다. 캔들로 그릴 수 없는 화면(분봉이거나 보이는 봉이 70개 초과)에는
// 차트 위에 띄워 봐야 방해라 숨긴다. 선은 반 픽셀에 두어 1px 로 또렷하게 찍히게 했다.
const MODE_ICON = {
  candle: '<svg viewBox="0 0 14 12" width="14" height="12" aria-hidden="true">'
    + '<path d="M4.5 1v2M4.5 8v3M10.5 2v3M10.5 8v2" stroke="currentColor"/>'
    + '<rect x="3" y="3" width="3" height="5" fill="currentColor"/>'
    + '<rect x="9" y="5" width="3" height="3" fill="currentColor"/></svg>',
  line: '<svg viewBox="0 0 14 12" width="14" height="12" aria-hidden="true">'
    + '<polyline points="1,9 5,4.5 8.5,7 13,2" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>',
};

// 전체 보기로. 이미 받은 데이터로 다시 그린다 — 네트워크 요청 없음(테마 변경과 같은 경로).
function resetZoom() {
  if (!zoom) return;
  zoom = null;
  if (lastChart) drawChart(lastChart);
}

// 기간을 바꾼다. 떠나는 기간의 확대는 기억해 두고, 돌아오는 기간의 확대를 되살린다 —
// 1D 를 잠깐 보고 3M 으로 돌아올 때마다 다시 끌지 않게. 기간 버튼과 숫자 단축키가 같이 쓴다.
function setTimeframe(key) {
  zoomByTf[state.timeframe] = zoom;
  state.timeframe = key;
  zoom = zoomByTf[key] || null;
}

// 기간 버튼 · 숫자 단축키 — 기간을 바꾸고 저장한 뒤 탭과 차트를 다시 그린다(두 곳에 같은 네 줄이 따로 있었다).
function pickTimeframe(key) {
  setTimeframe(key);
  save();
  renderTabs();
  return loadChart();
}

// 종목이 바뀌면 모든 기간의 확대를 버린다 — 다른 종목에 같은 날짜 구간은 뜻이 없다.
function clearZooms() {
  zoom = null;
  for (const k of Object.keys(zoomByTf)) delete zoomByTf[k];
}

// 화면 x 좌표 → 봉 번호. 차트 밖으로 끌면 보이는 구간 끝에서 멈춘다.
// category 축이라 getValueForPixel 이 봉 번호를 주고, sx.min / max 는 보이는 구간의 끝이다.
function barAt(clientX) {
  const sx = chart.scales.x;
  const px = clientX - chart.canvas.getBoundingClientRect().left;
  return Math.min(sx.max, Math.max(sx.min, Math.round(sx.getValueForPixel(px))));
}

// 누른 채 좌우로 끌면 상자가 따라오고, 놓으면 그 구간이 차트 전체로 펼쳐진다.
// 마우스가 지나가거나 휠을 굴리는 것으로는 절대 확대하지 않는다 — 항상 떠 있는
// 창이라 마우스가 차트 위를 자주 지나간다.
// 이벤트는 캔버스 요소에 한 번만 붙인다. drawChart 는 같은 캔버스에 차트를 새로
// 만들므로, 끄는 도중 30초 갱신이 와도 상자가 끊기지 않는다.
function bindZoom() {
  const cv = document.getElementById('chart');
  // 끄는 동안 ↑↓ · 숫자 키로 종목 · 기간이 바뀌면 누른 점과 지금 점이 서로 다른 차트의
  // 봉 번호가 된다 — 그런 끌기는 취소한다. 30초 갱신은 같은 종목 · 기간이라 그대로 이어진다.
  const dragKey = () => `${state.selected}|${state.timeframe}`;
  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !chart || !lastChart || !ZOOM_TF.has(state.timeframe)) return;
    const i = barAt(e.clientX);
    zoomDrag = { a: i, b: i, x: e.clientX, key: dragKey() };
  });
  // 차트 밖으로 나가도 따라가도록 window 에서 받는다
  window.addEventListener('mousemove', (e) => {
    if (!zoomDrag || !chart) return;
    // 버튼이 이미 떨어졌는데 mouseup 을 못 받은 경우(Alt+Tab 등) — 끌기를 버린다
    if (!(e.buttons & 1)) { zoomDrag = null; chart.draw(); return; }
    if (zoomDrag.key !== dragKey()) { zoomDrag = null; chart.draw(); return; }
    const i = barAt(e.clientX);
    if (i === zoomDrag.b) return;
    zoomDrag.b = i;
    chart.draw();
  });
  window.addEventListener('mouseup', (e) => {
    if (!zoomDrag) return;
    const r = zoomDrag.key === dragKey() ? dragToRange(zoomDrag.a, zoomDrag.b, e.clientX - zoomDrag.x) : null;
    zoomDrag = null;
    // 5봉 · 6px 미만(클릭 · 손떨림 · 도로 좁혀 취소)이거나, 끄는 도중 종목 · 기간이 바뀐 것
    if (!r || !lastChart) {
      if (chart) chart.draw(); // 상자만 지운다
      return;
    }
    zoom = { start: lastChart.times[r.from], end: lastChart.times[r.to] };
    drawChart(lastChart);
  });
  cv.addEventListener('dblclick', resetZoom);
}

function renderChartMode(bars, daily) {
  const b = document.getElementById('chartMode');
  const candle = state.chartMode === 'candle';
  b.hidden = !candleMode(bars, daily, 'candle'); // 캔들로 그릴 수 있는 화면에서만
  b.innerHTML = MODE_ICON[candle ? 'candle' : 'line'];
  b.title = candle ? '라인으로 보기' : '캔들로 보기';
  // 옆의 차트만 보기 버튼 — 덧그림(이동평균 · 보조 지표 · 기준선)이 보이면 또렷하게, 차트만 보기로 껐으면 흐리게.
  // RSI 칸 · 정규장/전체 버튼처럼 켜져 있으면 또렷하다.
  const p = document.getElementById('plainChart');
  p.hidden = false;
  p.className = state.plainChart ? '' : 'on';
  p.title = state.plainChart ? '덧그림 다시 보기' : '차트만 보기 — 이동평균 · 보조 지표 · 기준선 끄기';
  // 정규장 / 전체(장전 · 장후 포함) — 시간외를 받을 수 있는 기간(1D · 1W)의 종목만. 지수 · 환율은 시간외가 없다.
  // 글자는 지금 보는 것이고, 전체(시간외를 켠 것)면 RSI 칸 버튼처럼 또렷하게 — 켜져 있으면 또렷, 꺼져 있으면 흐리게.
  const e = document.getElementById('extHours');
  const item = selectedItem();
  const full = state.extHours !== false;
  e.hidden = !TF[state.timeframe].extended || !item || isIndex(item.symbol);
  e.textContent = full ? '전체' : '정규장';
  e.className = full ? 'on' : '';
  e.title = full ? '전체(장전 · 장후 포함) — 누르면 정규장만' : '정규장만 — 누르면 장전 · 장후까지';
  // RSI 칸 켜고 끄기 — RSI 를 그릴 수 있는 기간(RSI_TF)에서만. 차트만 보기는 보조 지표를 다 끄므로 숨긴다. 켜져 있으면 또렷하게.
  const s = document.getElementById('rsiPane');
  const rsiOn = !!(state.indicators && state.indicators.rsi);
  s.hidden = state.plainChart === true || !RSI_TF.has(state.timeframe);
  s.className = rsiOn ? 'on' : '';
  s.title = rsiOn ? 'RSI 칸 끄기' : 'RSI 칸 켜기 — 차트 아래에 RSI · 시그널';
  // RSI 크게 보기 — RSI 칸이 보일 때만(RSI 버튼이 보이고 켜져 있을 때). 켜져 있으면 또렷하게.
  const t = document.getElementById('rsiTall');
  t.hidden = s.hidden || !rsiOn;
  t.className = rsiTall ? 'on' : '';
  t.title = rsiTall ? 'RSI 원래 크기로' : 'RSI 크게 보기 — RSI 칸을 2배로(관심종목 목록이 그만큼 줄어든다)';
}

// RSI 크게 보기 버튼 — RSI 칸을 RSI_PANE ↔ RSI_TALL 로. 차트 상자가 그만큼 커져 가격 칸은 그대로, 관심종목 목록이 줄어든다
// (사용자가 정함). 저장하지 않는다(앱을 다시 켜면 꺼짐). 데이터는 그대로라 받지 않고 상자 높이만 맞춰 다시 그린다 —
// 받는 중(loading)이면 불러오는 중 표시는 둔다.
function toggleRsiTall() {
  rsiTall = !rsiTall;
  const box = document.getElementById('chartBox');
  box.className = chartBoxClass(/\bloading\b/.test(box.className));
  if (lastChart) drawChart(lastChart);
}

// 정규장 / 전체 버튼. 응답이 달라 다시 받는다(캐시는 둘을 따로 둔다 — fetchChartCached).
async function toggleExtHours() {
  state.extHours = state.extHours === false;
  save();
  await loadChart();
}

// RSI 칸 버튼 — 설정의 RSI 칩과 같은 값을 바꾼다(칩도 다시 그린다). 차트 상자 높이는 loadChart 가 chartBoxClass 로 맞춘다.
async function toggleRsiPane() {
  state.indicators = { ...state.indicators, rsi: !state.indicators.rsi };
  save();
  renderIndChips();
  await loadChart();
}

function renderTabs() {
  const box = document.getElementById('tf');
  box.innerHTML = '';
  for (const key of Object.keys(TF)) {
    const b = document.createElement('button');
    b.textContent = key;
    b.className = key === state.timeframe ? 'on' : '';
    b.onclick = () => pickTimeframe(key);
    box.appendChild(b);
  }
}

