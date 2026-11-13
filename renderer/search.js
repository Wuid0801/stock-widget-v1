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
  clearTimeout(searchTimer);
  searchSeq++;
  openPanel(searchEl);
  qEl.value = '';
  resultsEl.innerHTML = '';
  renderSearchPopular();
  qEl.focus();
}

function closeSearch() {
  clearTimeout(searchTimer);
  searchSeq++;
  closePanel(searchEl);
}

function renderSearchPopular() {
  if (searchEl.hidden || qEl.value.trim()) return;
  const cached = rankCache.get('kr|search');
  const data = cached && cached.d;
  resultsEl.innerHTML = '';
  if (!data) hint('인기 검색을 불러오는 중… · 종목명 또는 코드를 입력하세요');
  else if (!data.ok) hint(`인기 검색 조회 실패: ${data.error || '알 수 없는 오류'} · 직접 검색할 수 있습니다`);
  else if (!data.items.length) hint('인기 검색 목록이 없습니다 · 종목명 또는 코드를 입력하세요');
  else {
    hint('인기 검색 · 네이버');
    renderSearchItems(data.items, true);
  }
  if (!cached || Date.now() - cached.at >= RANK_TTL) loadRank('kr', 'search');
}

function renderSearchItems(items, popular = false) {
  for (const [index, it] of items.entries()) {
    const dup = state.watchlist.some((w) => w.symbol === it.symbol);
    const el = document.createElement('div');
    const market = it.market || (it.symbol.endsWith('.KQ') ? '코스닥' : '코스피');
    el.className = 'hit' + (dup ? ' dup' : '');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML = `${popular ? `<span class="rk">${index + 1}</span>` : ''}<span class="hname">${esc(it.name)}</span>`
      + `<span class="hmeta">${esc(it.symbol.split('.')[0])} · ${esc(market)}${dup ? ' · 추가됨' : ''}</span>`;
    el.onclick = dup ? () => { closeSearch(); return select(it.symbol).catch(console.error); } : () => addSymbol(it);
    el.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
    };
    resultsEl.appendChild(el);
  }
}

async function runSearch() {
  const query = qEl.value.trim();
  const seq = ++searchSeq;
  if (!query) { renderSearchPopular(); return; }

  resultsEl.innerHTML = '';
  hint('검색 중…');
  let r;
  try { r = await api.search(query); }
  catch (error) { r = { ok: false, error: error.message }; }
  if (seq !== searchSeq || searchEl.hidden || qEl.value.trim() !== query) return;

  resultsEl.innerHTML = '';
  if (!r.ok) { hint(`검색 실패: ${r.error}`); return; }
  if (!r.items.length) { hint('결과가 없습니다'); return; }

  hint('');
  renderSearchItems(r.items);
}

