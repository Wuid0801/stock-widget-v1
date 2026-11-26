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
      + `<span class="ixp" style="color:${color}">${move}</span>${ix.trend ? ixTrend(ix) : ''}</span>`;
  }).join('')}</div>${dots}`;
}

// 80일선 추세(2026-11-25 사용자 요청) — 받아 둔 5년 일봉의 확정 봉으로. 그 지수 장이 열려 있거나 모르면(실시간 없음) 마지막
// 봉은 움직이는 값이라 빼고, 닫힌 것이 확실하면 마지막 봉(그날 종가)까지 쓴다 — 늘 빼면 한국 낮에 미국 지수가 이미 끝난
// 지난밤 종가를 빼고 그 전날로 판정했다(2026-11-25 실데이터). 일봉이 모자라면 null. 지수 줄은 INDICES 의 trend 인 것만 글자로,
// 시장 지표 화면은 시세가 있는 줄 모두의 툴팁 맨 위에(marketHtml, 2026-11-26 사용자 요청 — 글자로 붙이니 화면이 빽빽했다).
// shortcut: 개장 직후 야후 일봉(20분 늦다)에 오늘 봉이 아직 없으면 어제 봉을 빼 그 몇 분은 하루 앞 판정이다 — 경계에 걸친 날만 바뀐다.
// { label: '하락 20일째', color(상승 · 하락만), head: 상태 · 값 · 시작일 세 줄, rules: 규칙 · 한계 } 또는 null
function ixTrendOf(ix) {
  const d = ix && dailyCache[ix.symbol];
  const len = d && (quotes[ix.symbol]?.isTrading === false ? d.closes.length : d.closes.length - 1);
  const t = d && maTrend(d.closes.slice(0, len), INDEX_TREND_MA, INDEX_TREND_LAG);
  if (!t) return null;
  const day = (i) => { const x = new Date(d.times[i]); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };
  const cur = curOf(ix.symbol);
  const [short, long] = { up: ['상승', '상승 추세'], down: ['하락', '하락 추세'],
    upTry: ['상승전환', '상승 전환 시도'], downTry: ['하락전환', '하락 전환 시도'] }[t.state];
  return {
    label: `${short} ${t.days}일째`,
    color: t.state === 'up' ? UP : t.state === 'down' ? DOWN : null,
    head: [
      `${INDEX_TREND_MA}일선 추세 — ${long}`,
      `${day(len - 1)} 종가 ${money(t.close, cur)} · ${INDEX_TREND_MA}일선 ${money(t.ma, cur)} (1주 전 ${money(t.maLag, cur)})`,
      `${day(len - t.days)}부터 ${t.days}일째`,
    ],
    rules: [
      `상승: 종가가 ${INDEX_TREND_MA}일선 위 · 선이 1주 전보다 높음`,
      `하락: 종가가 ${INDEX_TREND_MA}일선 아래 · 선이 1주 전보다 낮음`,
      `전환 시도: 종가가 ${INDEX_TREND_MA}일선을 뚫었지만 선은 아직 반대 방향`,
      '지금 상태일 뿐 다음 방향을 맞히는 신호가 아님',
    ],
  };
}
function ixTrend(ix) {
  const r = ixTrendOf(ix);
  return r ? `<span class="ixt"${r.color ? ` style="color:${r.color}"` : ''} title="${esc([...r.head, '', ...r.rules].join('\n'))}">${r.label}</span>` : '';
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

