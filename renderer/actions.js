// renderer/actions.js — 조작 — 종목 고르기 · 추가 · 삭제 · 되돌리기 · 키보드 · 접기.

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
  maStyles: state.maStyles,
  chartMode: state.chartMode,
  plainChart: state.plainChart,
  infoOpen: state.infoOpen,
  indicators: state.indicators,
  extHours: state.extHours,
});

// 저장된 선택이 관심종목도 지수도 아니면 첫 관심종목. 관심종목이 비어 있으면 null —
// undefined 를 그대로 저장하면 electron-store 가 거부한다.
function validSelection(selected, watchlist) {
  if (watchlist.some((i) => i.symbol === selected) || isIndex(selected)) return selected;
  return (watchlist[0] && watchlist[0].symbol) || null;
}

// 저장된 기간이 이 빌드에 없으면 1D. 손으로 고친 설정이나, 기간 이름을 바꾸거나 뺀 빌드가 남긴 값이면
// loadChart 가 TF[...] 에서 undefined 를 읽어 매 갱신 예외로 끝나고 차트가 조용히 빈다.
function validTimeframe(tf) {
  return Object.hasOwn(TF, tf) ? tf : '1D';
}

async function select(symbol) {
  if (symbol !== state.selected) clearZooms(); // 다른 종목에 같은 날짜 구간은 뜻이 없다
  state.selected = symbol;
  save();
  renderList();
  renderIndices(); // 지수를 골랐거나 지수에서 종목으로 왔으면 강조가 옮겨 간다
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

  // 원래 자리에 다시 끼워 넣는다 (그 사이 목록이 짧아졌으면 끝에). 6초 안에 검색으로 다시
  // 추가했으면 줄은 이미 있다 — 두 줄이 되면 보유 합계가 두 배, 목표가 알림도 두 번이다. 그때는
  // 줄은 그대로 두고 비어 있는 목표가 · 보유만 되살린다(다시 추가해도 이 둘은 돌아오지 않는다).
  if (!state.watchlist.some((i) => i.symbol === s.item.symbol)) {
    state.watchlist.splice(Math.min(s.index, state.watchlist.length), 0, s.item);
  }
  if (s.target && !state.alerts.targets[s.item.symbol]) state.alerts.targets[s.item.symbol] = s.target;
  if (s.holding && !state.holdings[s.item.symbol]) state.holdings[s.item.symbol] = s.holding;
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
  // 위 select 의 차트는 시세가 돌아오기 전에 그려져 이동평균 · 교차 배지 · 색(늘 빨강)이 빠졌다.
  // 시세가 생겼으니 다시 그린다 — 안 그리면 다음 갱신(장 마감 후 5분)까지 그대로다.
  if (state.selected === s.item.symbol) await loadChart();
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
    clearZooms(); // 다른 종목으로 넘어간다 — select() 를 거치지 않으므로 여기서 푼다
  }
  save();
  renderList();
  renderDetail();
  // 환율을 받아올 수 있어 async 다. 여기서 기다리면 차트 갱신이 늦어지므로 띄워만 두되,
  // 실패를 삼키지는 않는다(그냥 두면 unhandled rejection).
  renderFolio().catch(console.error);

  if (state.selected) await loadChart();
  else clearChart();
}

// 목록에 넣는 건 조회가 끝난 뒤라, 그 사이 같은 결과를 또 누르면 목록 중복 검사를
// 매번 통과해 같은 종목이 여러 줄 생긴다. 조회 중인 종목은 다시 눌러도 무시한다.
const adding = new Set();

async function addSymbol(item) {
  if (adding.has(item.symbol) || state.watchlist.some((i) => i.symbol === item.symbol)) return;
  adding.add(item.symbol);
  try {
    // 네이버에는 있어도 Yahoo에 없는 종목이 있다 → 먼저 조회해보고 되는 것만 추가
    hint('추가하는 중…');
    const liveMap = await fetchLive([item.symbol]);
    await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
    if (quotes[item.symbol].error) {
      hint(`${item.name}: Yahoo에서 조회되지 않습니다 (${quotes[item.symbol].error})`);
      delete quotes[item.symbol];
      return;
    }

    // 조회를 기다리는 사이 되돌리기로 같은 종목이 이미 돌아왔으면 또 넣지 않는다
    if (!state.watchlist.some((i) => i.symbol === item.symbol)) {
      state.watchlist.push({ symbol: item.symbol, name: item.name });
    }
    save();
    closeSearch();
    renderList();
    await select(item.symbol);
  } finally {
    adding.delete(item.symbol); // 실패해도 풀어야 다시 누를 수 있다
  }
}

// --- 키보드 ------------------------------------------------------------------------
// 항상 떠 있는 작은 창이라 매번 행을 마우스로 조준하는 게 번거롭다.
// 입력 중이거나 패널(검색·설정)이 열려 있으면 그쪽이 우선이라 아무것도 하지 않는다.
function moveSelection(step) {
  const list = state.watchlist;
  if (!list.length) return;

  const cur = list.findIndex((i) => i.symbol === state.selected);
  // 지수를 보고 있으면(목록에 없음) ↓ 는 첫 줄, ↑ 는 마지막 줄
  const next = cur < 0 ? list[step > 0 ? 0 : list.length - 1] : list[(cur + step + list.length) % list.length];
  select(next.symbol).then(() => {
    const row = document.querySelector('#list .row.on');
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // 순위 패널에는 입력 칸이 없어 Esc 를 여기서 받는다(검색 · 설정은 패널이 받는다)
  if (!rankEl.hidden) {
    if (e.key === 'Escape') closeRank();
    return;
  }
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

  const tabs = Object.keys(TF); // 1~7 → 1D · 1W · 1M · 3M · 1Y · 3Y · 전체
  if (e.key >= '1' && e.key <= String(tabs.length)) {
    const key = tabs[Number(e.key) - 1];
    if (key === state.timeframe) return;
    pickTimeframe(key);
    return;
  }

  if (e.key === 'Escape') setCompact(!compact);
});

// --- 보유 · 52주 · 추세 점검 접기 ---------------------------------------------------
// 세 줄의 hidden 은 각자 그리는 함수가 정하므로 손잡이의 .off 만 바꾸고, 숨기는 것은 CSS 형제 선택자다.
function applyInfoOpen() {
  const btn = document.getElementById('infoToggle');
  btn.className = state.infoOpen ? 'infotoggle' : 'infotoggle off';
  btn.ariaExpanded = String(state.infoOpen);
  infoTip();
}

// 손잡이 툴팁. 접혀 있으면 세 줄에 보이던 내용을 글자로 미리 보인다 — 숨은 줄은 뺀다. 52주는 막대의
// 툴팁 글자를 그대로 쓴다(막대에 올렸을 때와 같은 말). renderDetail 이 갱신마다 다시 쓴다.
function infoTip() {
  const btn = document.getElementById('infoToggle');
  if (state.infoOpen) { btn.title = '보유 · 52주 · 추세 점검 접기'; return; }
  const lines = [];
  const symbol = state.selected;
  const h = state.holdings[symbol];
  if (h && !isIndex(symbol)) {
    const cur = curOf(symbol);
    const q = quotes[symbol];
    const r = holdingPl(h, q && q.price);
    lines.push(`보유 ${fmt(h.qty)}주 · 평단 ${money(h.avg, cur)}`
      + (r ? ` · 평가 ${money(r.value, cur)} · 손익 ${signedMoney(r.pl, cur)} (${fmtPct(r.pct)})` : ''));
  }
  const w52 = document.getElementById('w52');
  if (!w52.hidden && w52.title) lines.push(w52.title);
  const tc = document.getElementById('trendCheck');
  const trend = !tc.hidden && tc.textContent;
  if (trend) lines.push(trend.startsWith('추세 점검') ? trend : `추세 점검 ${trend}`);
  btn.title = (lines.length ? `${lines.join('\n')}\n\n` : '') + '누르면 펼칩니다';
}

function toggleInfo() {
  state.infoOpen = !state.infoOpen;
  save();
  applyInfoOpen();
}

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

