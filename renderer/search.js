// renderer/search.js — 종목 검색.

// --- 검색 -------------------------------------------------------------------------
const searchEl = document.getElementById('search');
const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const hintEl = document.getElementById('qhint');
const alertsEl = document.getElementById('alerts');
const rankEl = document.getElementById('rank');
let searchSeq = 0;
let searchTimer = null;
let expandedForPanel = false; // 접힌 상태에서 패널을 보려고 펼친 것인지 (닫을 때 되접기)

// 검색 · 설정 · 순위 패널은 접힌 상태에서 열면 잠깐 펼쳤다가, 모두 닫히면 다시 접는다. 한 번에 하나만 연다.
function openPanel(el) {
  if (compact) { setCompact(false); expandedForPanel = true; }
  searchEl.hidden = true;
  alertsEl.hidden = true;
  rankEl.hidden = true;
  el.hidden = false;
}

function closePanel(el) {
  el.hidden = true;
  if (expandedForPanel && searchEl.hidden && alertsEl.hidden && rankEl.hidden) {
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

