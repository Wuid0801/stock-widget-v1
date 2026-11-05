// renderer/indices.js — 위쪽 지수 줄.

// --- 지수 줄 ---------------------------------------------------------------------
// 개별 종목이 빠질 때 시장 전체 흐름인지 바로 알 수 있게 한 줄로 보여준다.
// 누르면 그 지수를 관심종목처럼 고른다(select) — 헤더 · 차트가 지수로 바뀐다.
// 여섯 개(코스피 · 코스닥, 나스닥 · S&P 500, 나스닥 선물 · 원/달러)는 한 줄에 들어가지 않아 장(INDICES 의 page)을
// 보유 합계 줄처럼 FOLIO_MS 마다 넘긴다. 마우스를 올리면 멈추고, 보고 있는 지수가 있으면 그 장에 머문다.
let indexItems = []; // 마지막으로 받은 지수 항목 — 선택만 바뀔 때 강조를 다시 그리는 데 쓴다
let indexPage = 0;   // 지금 보이는 장(indexPages 의 번호)
let indexHover = false;
let indexManualFor = null; // 점으로 장을 골랐을 때 보고 있던 것 — 그동안은 보고 있는 지수의 장으로 끌어오지 않는다
let indexFlipAt = 0;       // 점으로 넘긴 시각 — 그 뒤 한 간격(FOLIO_MS)은 자동으로 넘기지 않는다

async function loadIndices() {
  const r = await api.indices();
  indexItems = r.ok ? r.items : []; // 실패하면 조용히 숨긴다(핵심 기능이 아님)
  renderIndices();
  return indexItems;
}

// 받은 항목을 장으로 — INDICES 순서대로, 항목이 하나도 없는 장은 뺀다. 모르는 지수 · page 없는 항목(시장 지표 화면 것)은
// 보이지 않는다.
function indexPages() {
  const pages = [];
  for (const ix of INDICES) {
    if (ix.page == null) continue;
    const it = indexItems.find((i) => i.code === ix.code);
    if (!it) continue;
    const page = pages.find((p) => p.no === ix.page);
    if (page) page.items.push({ ix, it });
    else pages.push({ no: ix.page, items: [{ ix, it }] });
  }
  return pages;
}

function renderIndices(animate = false) {
  const box = document.getElementById('indices');
  const pages = indexPages();
  box.hidden = !pages.length;
  if (!pages.length) { box.innerHTML = ''; return; }
  const shown = pages.findIndex((p) => p.items.some(({ ix }) => ix.symbol === state.selected));
  if (indexManualFor !== null && indexManualFor !== state.selected) indexManualFor = null; // 다른 것을 골랐다
  if (shown >= 0 && indexManualFor === null) indexPage = shown; // 보고 있는 지수의 장(점으로 다른 장을 골랐으면 그대로)
  indexPage %= pages.length;
  // 오른쪽 끝의 점 — 몇 번째 장인지 보이고 누르면 그 장으로(4초씩 기다리지 않게). 한 장뿐이면 없다.
  const dots = pages.length < 2 ? '' : `<span class="ixdots">${pages.map((p, i) => `<button class="ixdot${i === indexPage ? ' on' : ''}" `
    + `data-page="${i}" title="${p.items.map(({ ix }) => ix.name).join(' · ')}"></button>`).join('')}</span>`;
  box.innerHTML = `<div class="ixpage${animate ? ' in' : ''}">${pages[indexPage].items.map(({ ix, it }) => {
    const color = plColor(it.pct);
    const cls = ix.symbol === state.selected ? 'ix on' : 'ix';
    const move = ix.cur === '%' && it.change != null ? fmtBp(it.change) : fmtPct(it.pct); // 금리는 bp
    return `<span class="${cls}" data-symbol="${ix.symbol}" title="${ix.name}${ix.delayMin ? ` (${ix.delayMin}분 지연)` : ''} 차트 보기">`
      + `<span class="ixn">${esc(ix.name)}</span><span class="ixv">${money(it.value, curOf(ix.symbol))}</span>`
      + `<span class="ixp" style="color:${color}">${move}</span></span>`;
  }).join('')}</div>${dots}`;
}

// FOLIO_MS 마다 다음 장으로. 한 장뿐이거나, 마우스가 올라가 있거나, 보고 있는 지수가 이 줄에 있으면 그대로.
function tickIndices() {
  const pages = indexPages();
  if (indexHover || pages.length < 2) return;
  if (Date.now() - indexFlipAt < FOLIO_MS) return; // 점으로 막 넘겼다 — 누르자마자 넘어가지 않게
  if (pages.some((p) => p.items.some(({ ix }) => ix.symbol === state.selected))) return;
  indexPage = (indexPage + 1) % pages.length;
  renderIndices(true);
}

// 점을 누르면 그 장으로. 지수를 보고 있어도 다른 장을 볼 수 있고, 다른 것을 고르면 원래 규칙(보고 있는 지수의
// 장)으로 돌아간다. 없는 장 번호는 무시한다.
function flipIndexPage(n) {
  if (!(n >= 0 && n < indexPages().length)) return;
  indexPage = n;
  indexManualFor = state.selected;
  indexFlipAt = Date.now();
  renderIndices(true);
}

