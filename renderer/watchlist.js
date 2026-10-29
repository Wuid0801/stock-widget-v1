// renderer/watchlist.js — 관심종목 목록 — 오늘 캔들 · 일정 칩 · 줄.

// --- 오늘 캔들 -----------------------------------------------------------------
// 선택한 종목의 현재가 오른쪽에 오늘 하루를 캔들로 그린다. 옆의 등락은 전일 종가
// 대비라 "올랐지만 시가보다는 밀렸다" 같은 것이 숫자만으로는 보이지 않는다 —
// 삼성전자 2026-09-22 는 +0.91% 인데 283,000 에 열려 276,500 으로 밀린 음봉이었다.

// 현재가(19px · line-height 1.15)와 같은 높이로 맞춘다.
const CANDLE_W = 9;
const CANDLE_H = 22;

// 꼬리는 가운데 세로선, 몸통은 사각형. 고가 = 저가면 꼬리가 점이라 그리지 않고
// 몸통 1px 만 남긴다. 색은 한국 관례 — 시가보다 오르면 빨강.
function candleSvg(c) {
  const g = candleGeom(c, CANDLE_H);
  const color = c.dir === 'up' ? UP : c.dir === 'down' ? DOWN : cssVar('--flat');
  const mid = CANDLE_W / 2;
  const wick = g.flat ? ''
    : `<line x1="${mid}" y1="0" x2="${mid}" y2="${CANDLE_H}" stroke="${color}"/>`;
  return `<svg width="${CANDLE_W}" height="${CANDLE_H}" viewBox="0 0 ${CANDLE_W} ${CANDLE_H}">`
    + `${wick}<rect x="0" y="${g.bodyTop.toFixed(2)}" width="${CANDLE_W}"`
    + ` height="${g.bodyH.toFixed(2)}" fill="${color}"/></svg>`;
}

// 시가를 못 받은 종목(야후가 안 주는 경우)은 빈 문자열이다. 옆 칸이 없을 뿐
// 현재가 위치는 그대로다.
function candleTag(q, cur) {
  const c = candleOf(q);
  if (!c) return '';
  const t = `시 ${money(c.open, cur)} · 고 ${money(c.high, cur)}`
    + ` · 저 ${money(c.low, cur)} · 종 ${money(c.close, cur)}`;
  return `<span title="${esc(t)}">${candleSvg(c)}</span>`;
}

// --- 관심종목 일정 ----------------------------------------------------------------
// 목록 이름 옆의 일정 칩 — 가장 가까운 일정이 EVENT_DAYS 안이면 '실적 D-3' · '배당락 D-day'. 지표 화면을 열어야만
// 보이던 것. 날짜는 한국 날짜로 센다(네이버가 주는 D-day 숫자는 받은 날 기준이라 날을 넘기면 틀린다). 지난 일정은 없다.
function eventBadge(symbol, nowMs = Date.now()) {
  const hit = eventCache.get(symbol);
  if (!hit || !hit.events) return null;
  const today = Math.floor((nowMs + 9 * 3600000) / 86400000);
  let best = null;
  for (const e of hit.events) {
    const t = Date.parse(`${e.date}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    const dd = Math.floor(t / 86400000) - today;
    if (dd < 0 || dd > EVENT_DAYS) continue;
    if (!best || dd < best.dd) best = { ...e, dd };
  }
  if (!best) return null;
  return { label: `${best.kind === 'ir' ? '실적' : '배당락'} ${best.dd === 0 ? 'D-day' : `D-${best.dd}`}`,
    title: `${best.title} · ${best.date.slice(5).replace('-', '/')}` };
}

function eventChip(symbol) {
  const b = eventBadge(symbol);
  return b ? `<span class="evchip" title="${esc(b.title)}">${b.label}</span>` : '';
}

// 관심종목의 일정을 받는다(main 의 naver:events — 국내 실적 발표일 · 미국 배당락일). 갱신마다 부르되 기다리지 않고,
// 6시간이 지난 종목만 목록 순서대로 하나씩 받는다(한꺼번에 몰리지 않게). 실패한 종목은 기억하지 않아 다음 갱신에
// 다시 묻는다. 받는 중에 또 불리면(30초 갱신이 겹치면) 그냥 돌아간다. 새로 받은 것이 있으면 목록을 한 번 다시 그린다.
async function loadEvents() {
  if (eventsBusy) return;
  eventsBusy = true;
  let changed = false;
  try {
    for (const item of [...state.watchlist]) {
      if (isIndex(item.symbol)) continue;
      const hit = eventCache.get(item.symbol);
      if (hit && Date.now() - hit.at < EVENT_TTL) continue;
      let r = null;
      try { r = await api.events(item.symbol); } catch { /* 다음 갱신에 다시 */ }
      if (r && r.ok) { eventCache.set(item.symbol, { at: Date.now(), events: r.events || [] }); changed = true; }
    }
  } finally {
    eventsBusy = false;
  }
  if (changed) renderList();
}

// --- 리스트 -------------------------------------------------------------------
// 관심종목은 store에서 오므로, 추가/삭제 UI를 붙일 때는
// state.watchlist를 수정하고 save() + renderList()만 호출하면 된다.
// 줄은 종목이나 순서가 바뀔 때만 새로 만들고, 시세 · 일정 · 보유 · 선택이 바뀌면 있는 줄의 내용만 고친다. 예전에는 부를
// 때마다 줄을 통째로 새로 만들어, 마우스를 올려 둔 줄의 hover(배경 · ✕)가 꺼졌다 켜지며 깜빡였다 — 시작할 때는 종목마다
// 그려 몇 초 동안 여러 번, 그 뒤로도 30초 갱신마다 한 번(2026-10-29).
function renderList() {
  const list = document.getElementById('list');

  if (!state.watchlist.length) {
    list.innerHTML = '<div class="empty">관심종목이 없습니다.<br>상단 ＋ 로 종목을 추가하세요.</div>';
    return;
  }

  let rows = [...list.querySelectorAll('.row')];
  if (rows.length !== state.watchlist.length || rows.some((r, i) => r.dataset.symbol !== state.watchlist[i].symbol)) {
    list.innerHTML = '';
    rows = state.watchlist.map((item, idx) => list.appendChild(listRow(item, idx)));
  }

  state.watchlist.forEach((item, i) => {
    const row = rows[i];
    const q = quotes[item.symbol];
    const lv = levelOf(q && q.rsi);
    const up = q && q.change > 0;
    const flat = !q || !q.change;
    const color = flat ? cssVar('--flat') : (up ? UP : DOWN);

    row.classList.toggle('on', item.symbol === state.selected); // className 을 덮지 않는다 — 끌기 중 표시가 남게
    row.querySelector('.dot').style.background = lv.color;
    // 이름 칸은 바뀔 때만 새로 넣는다 — 일정 칩에 마우스를 올려 둔 채 갱신되면 칩의 툴팁이 닫힌다
    const nm = `<span class="nrow"><span class="name">${esc(item.name)}</span>${eventChip(item.symbol)}</span>${holdSub(item.symbol)}`;
    if (row.nmHtml !== nm) { row.querySelector('.nm').innerHTML = nm; row.nmHtml = nm; }
    const px = row.querySelector('.px');
    px.textContent = q && q.price != null ? money(q.price, curOf(item.symbol)) : '—';
    px.style.color = color;
    const chg = row.querySelector('.chg');
    chg.textContent = q && q.pct != null ? fmtPct(q.pct) : (q && q.error ? '오류' : '');
    chg.style.color = color;
  });
}

// 목록 한 줄의 틀과 동작(누르기 · 지우기 · 끌어서 순서 바꾸기). 내용은 renderList 가 채운다.
function listRow(item, idx) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.symbol = item.symbol;
  row.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="px"></span><span class="chg"></span>'
    + '<button class="del" title="삭제">✕</button>';

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
  return row;
}

// 드래그로 관심종목 순서 변경
function moveSymbol(from, to) {
  if (from === null || to === null || from === to) return;
  const [moved] = state.watchlist.splice(from, 1);
  state.watchlist.splice(to, 0, moved);
  save();
  renderList();
}

