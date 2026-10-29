// renderer/holdings.js — 보유 종목과 합계 줄.

// --- 보유 종목 ---------------------------------------------------------------------
// 입력 칸의 글자 → 숫자. 쉼표 · 공백은 지운다. 숫자가 아니면 NaN.
function parseAmount(text) {
  const s = String(text ?? '').replace(/[,\s]/g, '');
  return s === '' ? NaN : Number(s);
}

// 입력 칸에 다시 넣을 글자 — 천 단위 쉼표, 소수는 있는 만큼(해외 평단가 182.35 · 소수 주 0.5).
function amountText(v) {
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// 수량 · 평단가 글자로 저장할 보유를 만든다. 둘 다 0보다 큰 유한한 수여야 한다 — 아니면 null.
function holdingFrom(qtyText, avgText) {
  const qty = parseAmount(qtyText);
  const avg = parseAmount(avgText);
  return Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0 ? { qty, avg } : null;
}

// 한 종목의 평가금액 · 손익 · 수익률. 현재가가 없으면 null.
function holdingPl(h, price) {
  if (!h || price == null) return null;
  const cost = h.qty * h.avg;
  const value = h.qty * price;
  return { value, pl: value - cost, pct: cost ? ((value - cost) / cost) * 100 : 0 };
}

function plColor(pl) {
  return pl === 0 ? cssVar('--flat') : (pl > 0 ? UP : DOWN);
}

// 목록 줄의 보유 표시 — 이름 아래 작은 줄 "10주 · 손익 +12.50%". 보유가 아니면 빈 문자열.
// 목록만 봐서는 무엇을 들고 있는지 알 수 없었다.
function holdSub(symbol) {
  const h = state.holdings[symbol];
  if (!h) return '';
  const q = quotes[symbol];
  const r = holdingPl(h, q && q.price);
  return `<span class="hsub">${fmt(h.qty)}주${r ? ` · <b style="color:${plColor(r.pl)}">손익 ${fmtPct(r.pct)}</b>` : ''}</span>`;
}

// 보유를 저장하거나(h) 지우고(null) 보유를 보여 주는 곳을 모두 다시 그린다.
// 차트의 평단 점선은 loadChart 의 서명에 들어 있어 다시 그려진다.
function setHolding(symbol, h) {
  if (h) state.holdings[symbol] = h; else delete state.holdings[symbol];
  save();
  renderList();
  renderDetail();
  renderFolio().catch(console.error); // 환율을 받을 수 있어 async 다 — 띄워만 둔다
  if (symbol === state.selected) loadChart().catch(console.error);
}

function clearHolding(symbol) {
  holdEdit = null;
  setHolding(symbol, null);
}

// --- 보유 종목 합계 ---------------------------------------------------------------
// 달러 종목이 섞이면 그냥 더할 수 없어 원화로 환산한다. 환율은 천천히 움직이므로 30분 캐시.
let fxRate = null;
let fxAt = 0;
const FX_TTL = 30 * 60 * 1000;

async function usdKrw() {
  if (fxRate && Date.now() - fxAt < FX_TTL) return fxRate;
  const r = await api.fxUsdKrw();
  if (r.ok) { fxRate = r.rate; fxAt = Date.now(); }
  return fxRate; // 실패하면 직전 값(없으면 null)
}

// 합계 줄에 차례로 보일 줄들과 툴팁. 보유가 둘 이상이면 합계 → 종목마다 한 줄(목록 순서),
// 하나뿐이면 그 종목 줄만 — "보유 1종목" 으로는 무엇을 들고 있는지 모른다. 종목 줄은 그 종목 통화로 쓴다.
//
// 오늘 손익 = 보유 수량 × (현재가 - 전일 종가), 비율은 어제 평가 대비. 340px 줄에 이름 · 평가 · 손익 · 오늘 넷은
// 들어가지 않아(만 · 억 단위로 줄여도 넘쳤다, 2026-10-16 측정) 오늘이 있으면 평가는 툴팁으로 뺀다. 전일 종가를 못
// 받았으면 오늘을 낼 수 없어 지금처럼 평가를 보인다. 합계의 오늘은 모든 보유의 전일 종가가 있을 때만 낸다.
function folioLines(held, rate) {
  // 툴팁(title)은 글자 그대로 나오므로 종목명은 HTML 쪽에서만 이스케이프한다
  const line = (name, value, pl, pct, cur, day) => {
    const today = day ? `오늘 ${signedMoney(day.pl, cur)} (${fmtPct(day.pct)})` : '';
    return {
      html: `<span class="fn">${esc(name)}</span>${day ? '' : `<span class="fv">평가 ${money(value, cur)}</span>`}`
        + `<span class="fp" style="color:${plColor(pl)}">손익 ${signedMoney(pl, cur)} (${fmtPct(pct)})</span>`
        + (day ? `<span class="ft" style="color:${plColor(day.pl)}">${today}</span>` : ''),
      text: `${name} · 평가 ${money(value, cur)} · 손익 ${signedMoney(pl, cur)} (${fmtPct(pct)})${day ? ` · ${today}` : ''}`,
    };
  };
  const dayOf = (h, q) => (q.prevClose > 0
    ? { pl: (q.price - q.prevClose) * h.qty, pct: ((q.price - q.prevClose) / q.prevClose) * 100 } : null);
  const dayNote = held.some(({ q }) => q.prevClose > 0)
    ? ['오늘 = 전일 종가 대비 (장 시작 전에는 지난 장, 미국 프리 · 애프터마켓이면 그 가격)'] : [];
  const stocks = held.map(({ i, h, q }) => {
    const r = holdingPl(h, q.price);
    return line(`${i.name} ${fmt(h.qty)}주`, r.value, r.pl, r.pct, curOf(i.symbol), dayOf(h, q));
  });
  if (held.length === 1) return { lines: [stocks[0].html], tip: [stocks[0].text, ...dayNote].join('\n') };

  const total = `보유 ${held.length}종목`;
  const foreign = held.some((x) => curOf(x.i.symbol) !== 'KRW');
  if (foreign && !rate) {
    // 환율을 못 받으면 합계가 틀린 값이 되므로 숫자를 내놓지 않는다
    return { lines: [`<span class="fn">${total}</span><span class="fv">환율을 받지 못해 합계를 낼 수 없습니다</span>`,
      ...stocks.map((s) => s.html)], tip: stocks.map((s) => s.text).join('\n') };
  }
  let value = 0; let cost = 0; let prev = 0;
  for (const { i, h, q } of held) {
    const k = curOf(i.symbol) === 'KRW' ? 1 : rate;
    value += q.price * h.qty * k;
    cost += h.avg * h.qty * k;
    prev += (q.prevClose || 0) * h.qty * k;
  }
  const gain = Math.round(value - cost);
  const day = held.every(({ q }) => q.prevClose > 0) && prev > 0
    ? { pl: Math.round(value - prev), pct: ((value - prev) / prev) * 100 } : null;
  const sum = line(total, Math.round(value), gain, cost > 0 ? ((value - cost) / cost) * 100 : 0, 'KRW', day);
  return {
    lines: [sum.html, ...stocks.map((s) => s.html)],
    tip: [sum.text, ...stocks.map((s) => s.text),
      ...(foreign ? [`환율 ${fmt(rate)}원/$ (미국 주식은 이 값으로 합계에 넣음)`] : []), ...dayNote].join('\n'),
  };
}

async function renderFolio() {
  const box = document.getElementById('folio');

  // 수량·평단가가 모두 있고 현재가를 받은 종목만 센다
  const held = state.watchlist
    .map((i) => ({ i, h: state.holdings[i.symbol], q: quotes[i.symbol] }))
    .filter((x) => x.h && x.h.qty > 0 && x.h.avg > 0 && x.q && x.q.price != null);

  if (!held.length) { box.hidden = true; folioView = []; return; }

  // 환율은 둘 이상을 더할 때만 필요하다
  const rate = held.length > 1 && held.some((x) => curOf(x.i.symbol) !== 'KRW') ? await usdKrw() : null;
  const { lines, tip } = folioLines(held, rate);
  folioView = lines;
  if (folioAt >= lines.length) folioAt = 0; // 30초 갱신에도 보던 차례를 지킨다
  box.hidden = false;
  box.title = tip;
  showFolio(false);
}

function showFolio(animate) {
  document.getElementById('folio').innerHTML = `<div class="fline${animate ? ' in' : ''}">${folioView[folioAt]}</div>`;
}

// FOLIO_MS 마다 다음 줄로. 한 줄뿐이거나 마우스가 올라가 있으면 그대로 둔다.
const FOLIO_MS = 4000;
function tickFolio() {
  if (folioHover || folioView.length < 2) return;
  folioAt = (folioAt + 1) % folioView.length;
  showFolio(true);
}

