// renderer/start.js — 갱신 주기(pollTick · refreshNow)와 시작(init) — 저장된 상태를 읽고 이벤트를 달고 첫 화면을 그린다.

// 갱신이 예외로 끝나도 다음 조회를 예약한다 (첫 조회도 같은 경로).
async function pollTick() {
  try {
    await refreshAll();
  } catch (e) {
    isLive = false;
    marketOpen = true;
    console.error('시세 갱신 실패', e);
  } finally {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollTick, marketOpen ? POLL_OPEN : POLL_CLOSED);
  }
}

// 상단 ↻ — 자동 갱신을 지금 한 번 돌리고, 다음 자동 갱신은 누른 시점부터 다시 센다.
// 장 마감 후 5분 간격일 때 기다리지 않게 하려는 것이라 캐시(차트 5분 · 일봉 30분)는
// 그대로 쓴다. 현재가와 오늘 봉은 매번 실시간으로 받는다.
//
// 갱신이 끝난 뒤(자동 갱신 포함) 5초는 쉰다. 한 번에 네이버 요청이 3개(지수 · KRX ·
// NXT) 나가고 캐시가 없어서, 연타하면 끝날 때마다 곧바로 다시 요청한다. 비공식 API 라
// 한도를 모르고, 막히면 20분 지연 폴백으로 넘어가 일봉을 1분마다 다시 받게 된다.
// 5초는 "방금 받은 값"을 사람이 다시 원할 일이 거의 없는 간격이다.
const REFRESH_REST = 5000;
let restTimer = null;

// 쉬는 동안 아이콘을 흐리게 — 눌러도 반응이 없는 이유가 보이게 한다
function restRefresh(ms) {
  const b = document.getElementById('refresh');
  b.classList.add('rest');
  clearTimeout(restTimer);
  restTimer = setTimeout(() => b.classList.remove('rest'), ms);
}

async function refreshNow() {
  if (busy) return; // 갱신이 도는 중(자동 갱신이면 곧 끝난다)
  const wait = REFRESH_REST - (Date.now() - lastRefreshAt);
  if (wait > 0) { restRefresh(wait); return; }

  const b = document.getElementById('refresh');
  b.classList.add('spin');
  try {
    await pollTick();
  } finally {
    b.classList.remove('spin');
    restRefresh(REFRESH_REST);
  }
}

// --- 시작 -----------------------------------------------------------------------
(async function init() {
  bindFlow();
  document.getElementById('dock').onclick = () => {
    // 패널이 열린 채로 직접 접기를 누르면 패널만 닫고, 복귀 예약은 취소한다
    if (!searchEl.hidden || !alertsEl.hidden || !rankEl.hidden) {
      expandedForPanel = false;
      closeSearch();
      closeAlerts();
      closeRank();
    }
    setCompact(!compact);
  };

  document.getElementById('min').onclick = () => api.minimizeWindow();
  document.getElementById('close').onclick = () => api.closeWindow();
  document.getElementById('refresh').onclick = refreshNow;
  document.getElementById('undoBtn').onclick = () => undoRemove();
  // 지수 줄은 30초마다 다시 그려지므로 항목이 아니라 줄에 한 번만 붙인다
  document.getElementById('indices').onclick = (e) => {
    const dot = e.target.closest('.ixdot');
    if (dot) { flipIndexPage(Number(dot.dataset.page)); return; }
    const el = e.target.closest('.ix[data-symbol]');
    if (el) select(el.dataset.symbol);
  };
  // 지수 줄의 장 넘기기 — 마우스를 올리면 멈춘다(누르려는 사이 넘어가지 않게)
  document.getElementById('indices').onmouseenter = () => { indexHover = true; };
  document.getElementById('indices').onmouseleave = () => { indexHover = false; };
  setInterval(tickIndices, FOLIO_MS);

  document.getElementById('add').onclick = () => (searchEl.hidden ? openSearch() : closeSearch());
  document.getElementById('qclose').onclick = closeSearch;

  document.getElementById('bell').onclick = () => (alertsEl.hidden ? openAlerts() : closeAlerts());
  document.getElementById('rankBtn').onclick = () => (rankEl.hidden ? openRank() : closeRank());
  document.getElementById('rankClose').onclick = closeRank;
  // 목록 · 탭은 다시 그려지므로 항목이 아니라 상자에 한 번만 붙인다
  document.getElementById('rankMarket').onclick = (e) => {
    const b = e.target.closest('[data-market]');
    if (b) setRankView(b.dataset.market);
  };
  document.getElementById('rankTabs').onclick = (e) => {
    const b = e.target.closest('[data-kind]');
    if (b) setRankView(rankView.market, b.dataset.kind);
  };
  document.getElementById('rankList').onclick = (e) => rankClick(e.target);
  document.getElementById('rankList').onkeydown = (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-flow-key]')) {
      event.preventDefault();
      rankClick(event.target);
    }
  };
  document.getElementById('alertClose').onclick = closeAlerts;

  // 상세의 보유 자리 — 칸과 버튼은 renderHolding 이 그리고, 누름 · 키는 여기서 한 번만 받는다.
  // Esc 는 입력 칸 안이라 문서의 Esc(위젯 접기)가 무시한다.
  const holdEl = document.getElementById('hold');
  const holdSave = () => {
    saveHoldEdit(holdEl.querySelector('.hq').value, holdEl.querySelector('.ha').value);
    if (holdEdit) holdEl.querySelector('.hq').focus(); // 안내와 함께 다시 그렸다 — 이어서 고치게
  };
  holdEl.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { startHoldEdit(state.selected); holdEl.querySelector('.hq').focus(); }
    else if (act === 'save') holdSave();
    else if (act === 'cancel') cancelHoldEdit();
    else if (act === 'del') clearHolding(state.selected);
  };
  holdEl.onkeydown = (e) => {
    if (!e.target.matches('input')) return;
    if (e.key === 'Enter') holdSave();
    else if (e.key === 'Escape') cancelHoldEdit();
  };
  // 칸을 벗어나면 쉼표를 붙여 보인다
  holdEl.onfocusout = (e) => {
    if (!e.target.matches('input')) return;
    const v = parseAmount(e.target.value);
    if (Number.isFinite(v)) e.target.value = amountText(v);
  };

  // 합계 줄은 보유가 둘 이상이면 합계 → 종목마다 차례로 넘어간다. 마우스를 올리면 멈춘다.
  const folioEl = document.getElementById('folio');
  folioEl.onmouseenter = () => { folioHover = true; };
  folioEl.onmouseleave = () => { folioHover = false; };
  setInterval(tickFolio, FOLIO_MS);
  for (const b of document.querySelectorAll('#themeSeg button')) {
    b.onclick = () => { applyTheme(b.dataset.theme); save(); };
  }
  // 항상 위 — 고정 / 안 고정. 저장하면 main 이 창에 적용한다(state:set)
  for (const b of document.querySelectorAll('#pinSeg button')) {
    b.onclick = () => { state.alwaysOnTop = b.dataset.v === 'true'; save(); markSeg('pinSeg', state.alwaysOnTop); };
  }
  // 관심종목 묶기 — 묶음 순서로 다시 모아 그린 뒤(renderList) 그 순서를 저장한다
  for (const b of document.querySelectorAll('#groupSeg button')) {
    b.onclick = () => { state.listGroup = b.dataset.v; renderList(); save(); markSeg('groupSeg', state.listGroup); };
  }
  document.getElementById('sortBtns').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) pickSort(b.dataset.sort, b.textContent);
  };
  document.getElementById('sortUndo').onclick = undoSort;
  const opEl = document.getElementById('opacity');
  opEl.oninput = () => applyOpacity(opEl.value, true); // 끄는 동안 미리보기
  opEl.onchange = () => save();                       // 손을 뗄 때만 저장
  document.getElementById('backupExport').onclick = () => exportBackup().catch(console.error);
  document.getElementById('backupImport').onclick = () => importBackup().catch(console.error);
  document.getElementById('alertOn').onchange = (e) => {
    state.alerts.enabled = e.target.checked;
    save();
    renderAlerts();
  };
  // 문서의 Esc(위젯 접기)로 번지지 않게 멈춘다 — 이 처리로 패널이 먼저 닫히므로 문서 쪽의
  // "패널이 열려 있으면 무시" 검사를 지나 버린다(다크 · 라이트 버튼에 포커스가 있을 때).
  alertsEl.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAlerts(); } };
  qEl.oninput = () => {
    clearTimeout(searchTimer);
    searchSeq++;
    resultsEl.innerHTML = '';
    if (!qEl.value.trim()) { runSearch(); return; }
    hint('검색 중…');
    searchTimer = setTimeout(runSearch, 300);
  };
  qEl.onkeydown = (e) => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      // 첫 결과를 누른다(이미 있는 종목이면 그 종목으로). 빈 검색창의 인기 목록은 Enter 로 고르지 않는다 — ＋ 를 누르고
      // 실수로 Enter 를 치면 인기 1위가 관심종목에 들어갔다
      const first = qEl.value.trim() ? resultsEl.querySelector('.hit') : null;
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
  // 저장값에 없거나 모르는 값이면 캔들로 시작한다
  state.chartMode = state.chartMode === 'line' ? 'line' : 'candle';
  state.plainChart = state.plainChart === true;
  // 항상 위는 끄기로 저장된 때만 끈다. 관심종목 묶기는 아는 값만(그 밖은 묶지 않음)
  state.alwaysOnTop = state.alwaysOnTop !== false;
  state.listGroup = state.listGroup === 'kr' || state.listGroup === 'us' ? state.listGroup : 'none';
  markSeg('pinSeg', state.alwaysOnTop);
  markSeg('groupSeg', state.listGroup);
  // 정규장 / 전체 — 정규장만 보기로 저장된 때만 정규장
  state.extHours = state.extHours !== false;
  // 국내 일봉 캔들 기준 — KRX 로 저장된 때만 KRX, 그 밖은 통합(증권사 앱의 통합 캔들)
  state.candleVenue = state.candleVenue === 'krx' ? 'krx' : 'integrated';
  // 보유 · 52주 · 추세 점검은 접었다고 저장된 때만 접는다
  state.infoOpen = state.infoOpen !== false;
  applyInfoOpen();
  document.getElementById('infoToggle').onclick = toggleInfo;
  // 이동평균 색 · 굵기 — 잘못된 값은 버리고 기본으로 그린다(applyTheme 가 칩을 그리기 전에)
  state.maStyles = cleanMaStyles(state.maStyles);
  state.indicators = cleanIndicators(state.indicators);
  applyTheme(state.theme); // 이동평균 · 보조 지표 칩도 여기서 그린다
  applyOpacity(state.opacity);
  state.selected = validSelection(state.selected, state.watchlist); // 지수를 보던 중이면 그대로
  state.timeframe = validTimeframe(state.timeframe);

  document.getElementById('chartMode').onclick = async () => {
    state.chartMode = state.chartMode === 'candle' ? 'line' : 'candle';
    save();
    await loadChart(); // 서명에 chartMode 가 있어 다시 그려지고, drawChart 가 아이콘도 바꾼다
  };
  document.getElementById('metricsBtn').onclick = () => {
    metricsOn = !metricsOn;
    renderMetrics();
  };
  // 지표 화면의 동종 업종 종목
  document.getElementById('metricsView').onclick = (e) => {
    if (e.target.closest('[data-stock-flow]')) {
      const item = selectedItem();
      if (item) openFlow({ kind: 'stock', symbol: item.symbol, name: item.name });
      return;
    }
    const p = e.target.closest('[data-peer]');
    if (p) pickPeer(p.dataset.peer, p.dataset.name).catch(console.error);
  };
  document.getElementById('plainChart').onclick = async () => {
    state.plainChart = !state.plainChart;
    save();
    await loadChart(); // 서명에 plainChart 가 있어 다시 그려지고, drawChart 가 버튼 강조도 바꾼다
  };
  document.getElementById('extHours').onclick = () => toggleExtHours().catch(console.error);
  document.getElementById('candleVenue').onclick = () => toggleCandleVenue().catch(console.error);
  // 아래 칸 양옆 ‹ › — 둘 다 RSI ↔ 스토캐스틱
  document.getElementById('paneNav').onclick = (e) => { if (e.target.closest('button')) flipPane().catch(console.error); };
  document.getElementById('rsiTall').onclick = toggleRsiTall;
  document.getElementById('zoomReset').onclick = resetZoom;
  bindZoom();
  renderTabs();
  renderList();
  renderDetail();

  // 첫 차트는 첫 갱신을 기다리지 않고 바로 받는다. 갱신은 관심종목 · 지수 시세를 하나씩 받은 뒤에야 차트를 불러, 첫
  // 실행(캐시가 빈) 때는 차트 자리가 한참 비어 있었다 — 불러오는 중도 그때서야 떴다(2026-11-03). 현재가가 아직 없으면
  // 그 없이 그리고, 갱신 끝의 loadChart 가 현재가 · 전일 기준선을 넣어 다시 그린다(서명이 달라진다).
  loadChart().catch(console.error);

  // 장 마감 후에는 값이 바뀌지 않으므로 폴링 간격을 늘린다 (밤새 켜둬도 요청이 거의 없음).
  // 완전히 멈추면 개장을 감지하지 못하므로 5분마다 한 번은 확인한다.
  await pollTick();
})();
