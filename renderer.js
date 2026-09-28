// renderer.js — UI 렌더링, Chart.js 그리기, 30초 폴링.
// 네트워크는 전부 window.api.fetchChart(preload → 메인 프로세스)를 통해서만 나간다.

const UP = '#e24b4a';   // 상승 = 빨강 (한국 관례)
const DOWN = '#185fa5'; // 하락 = 파랑

const TF = {
  '1D': { range: '1d', interval: '5m' },
  '1W': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
};

// 선택 가능한 이동평균 기간(일)
const MA_PERIODS = [5, 10, 20, 40, 60, 80, 120, 240, 360];

// 차트 구간에 비해 지나치게 긴 이동평균은 그리지 않는다.
// 1M(22봉) 차트의 360일선은 거의 수평선인데 y축만 크게 벌려 놓아서
// 정작 주가 움직임이 세로 39%까지 눌린다(삼성전자 실측). 구간 봉 수의 1.5배까지만 허용.
const MA_SPAN = 1.5;

// 기본 굵기가 1.2px 인 기간. 나머지는 1px. 설정에서 선마다 바꿀 수 있다(maStyles).
const MA_THICK = new Set([20, 40, 80]);

// 설정에서 바꾼 이동평균 모양 — state.maStyles = { [기간]: { color: '#rrggbb', width } },
// 바꾼 값만 담는다. 색은 두 테마에 같이 쓰고, 바꾸지 않은 선은 테마별 기본색(--ma-N)이다.
const MA_WIDTH_MIN = 0.5; // 이보다 가늘면 1x 화면에서 선이 끊겨 보인다
const MA_WIDTH_MAX = 3;   // 주가선(2px)보다 굵게도 허용하되, 3M 캔들 몸통(3px)을 넘지 않는 데까지
const maWidth = (p) => state.maStyles?.[p]?.width ?? (MA_THICK.has(p) ? 1.2 : 1);
const maColor = (p) => state.maStyles?.[p]?.color || cssVar(`--ma-${p}`);

// 저장된 값을 믿지 않는다 — 모르는 기간, 색 형식이 아닌 것, 범위 밖이거나 숫자가 아닌
// 굵기는 버린다. 색 고르기(<input type="color">)가 #rrggbb 소문자를 주므로 그 형식만 받는다.
function cleanMaStyles(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const p of MA_PERIODS) {
    const s = raw[p];
    if (!s || typeof s !== 'object') continue;
    const o = {};
    if (typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color)) o.color = s.color.toLowerCase();
    if (typeof s.width === 'number' && s.width >= MA_WIDTH_MIN && s.width <= MA_WIDTH_MAX) {
      o.width = Math.round(s.width * 10) / 10; // 슬라이더 단위(0.1px)
    }
    if (Object.keys(o).length) out[p] = o;
  }
  return out;
}

// 골든/데드크로스를 볼 이동평균 조합.
// 60/80 처럼 가까운 기간끼리는 횡보 구간에서 계속 교차해 신호 가치가 없어 넣지 않는다.
const CROSS_PAIRS = [[5, 20], [20, 60]];
let chartBars = 0; // 현재 차트의 봉 수. 0이면 이동평균을 안 그리는 타임프레임(1D/1W)
// 끌어서 고른 확대 구간 { start, end } — 봉 시각(ms). 번호가 아니라 날짜로 기억해
// 30초 갱신 · 다음 날 새 봉에도 같은 구간이 잡힌다. 3M · 1Y 에서만, 저장하지 않는다.
// loadChart 의 서명이 읽으므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
let zoom = null;
const maFits = (p) => chartBars > 0 && p <= chartBars * MA_SPAN;

// RSI·이동평균 계산용 일봉 시리즈.
// 1Y 차트(243봉)에 MA360 을 끝까지 그리려면 앞으로 360봉이 더 필요해 총 603봉 이상이어야 한다.
// 1년치(243) · 2년치(484) 로는 모자라 5년치(약 1219봉)를 받는다.
const DAILY = { range: '5y', interval: '1d' };

// 5년치는 응답이 커서(종목당 약 80KB) 30초마다 받으면 낭비다.
// 일봉은 장중에 마지막 봉만 움직이므로 캐시하고 가끔만 다시 받는다.
// 현재가는 실시간(네이버)에서 따로 오므로 화면은 30초마다 그대로 갱신된다.
const DAILY_TTL = 30 * 60 * 1000;
const dailyCache = {}; // symbol -> { at, price, closes, times, currency, week52High, week52Low }

let state = { watchlist: [], selected: null, timeframe: '1D' };
const quotes = {}; // symbol -> { price, prevClose, rsi } | { error }
let dragFrom = null; // 순서 변경 드래그 중인 행 인덱스
let chart = null;
let busy = false;
let lastRefreshAt = 0; // 마지막 갱신이 끝난 시각 — ↻ 연타 제한에 쓴다
let chartSeq = 0; // 차트 요청 순번 — 응답이 역순으로 도착해도 마지막 것만 반영
let isLive = false;      // 마지막 갱신이 실시간 시세였는지 (실패 시 Yahoo 20분 지연)
// 전체 관심종목의 거래 상태는 폴링/알림에 쓴다. 헤더는 선택 종목의 상태를 쓴다.
let marketOpen = true;
const SESSION_TEXT = {
  regular: '정규장', pre: '프리마켓', after: '애프터마켓', closed: '장마감', unknown: '확인중',
};
const SESSION_CLASS = { regular: 'live', pre: 'over', after: 'over', closed: 'closed', unknown: 'delay' };
let pollTimer = null;

const POLL_OPEN = 30000;   // 장중 30초
const POLL_CLOSED = 300000; // 장 마감 후 5분 (개장 감지용 최소 확인)

// 과열도 5단계
function levelOf(rsi) {
  if (rsi == null) return { label: '—', color: cssVar('--dot-off') };
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

// 해외 종목은 통화가 다르다. 원화는 정수, 그 외(USD 등)는 소수 2자리로 보여준다.
const curOf = (symbol) => (quotes[symbol] && quotes[symbol].currency) || 'KRW';
const money = (v, cur) => {
  if (v == null) return '—';
  if (!cur || cur === 'KRW') return fmt(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const signedMoney = (v, cur) => (v > 0 ? '+' : '') + money(v, cur);
// 등락률은 자릿수가 흔들리지 않게 항상 소수 2자리
const fmtPct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';

// 색은 CSS 변수 한 곳에서만 정의한다. 차트도 그리는 시점에 여기서 읽어가므로
// 테마를 바꾸면 같은 값이 따라온다.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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

  state.watchlist.forEach((item, idx) => {
    const q = quotes[item.symbol];
    const row = document.createElement('div');
    row.className = 'row' + (item.symbol === state.selected ? ' on' : '');

    const lv = levelOf(q && q.rsi);
    const up = q && q.change > 0;
    const flat = !q || !q.change;
    const color = flat ? cssVar('--flat') : (up ? UP : DOWN);

    row.innerHTML = `
      <span class="dot" style="background:${lv.color}"></span>
      <span class="name">${esc(item.name)}</span>
      <span class="px" style="color:${color}">${q && q.price != null ? money(q.price, curOf(item.symbol)) : '—'}</span>
      <span class="chg" style="color:${color}">${
        q && q.pct != null ? fmtPct(q.pct) : (q && q.error ? '오류' : '')
      }</span>
      <button class="del" title="삭제">✕</button>`;

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

    list.appendChild(row);
  });
}

// 드래그로 관심종목 순서 변경
function moveSymbol(from, to) {
  if (from === null || to === null || from === to) return;
  const [moved] = state.watchlist.splice(from, 1);
  state.watchlist.splice(to, 0, moved);
  save();
  renderList();
}

// --- 코스피/코스닥 지수 -----------------------------------------------------------
// 개별 종목이 빠질 때 시장 전체 흐름인지 바로 알 수 있게 한 줄로 보여준다.
async function loadIndices() {
  const box = document.getElementById('indices');
  const r = await api.indices();
  if (!r.ok) { box.hidden = true; return; } // 실패하면 조용히 숨긴다(핵심 기능이 아님)

  box.hidden = false;
  box.innerHTML = r.items.map((i) => {
    const color = i.pct === 0 ? cssVar('--flat') : (i.pct > 0 ? UP : DOWN);
    return `<span class="ix"><span class="ixn">${esc(i.name)}</span>`
      + `<span class="ixv">${i.value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      + `<span class="ixp" style="color:${color}">${fmtPct(i.pct)}</span></span>`;
  }).join('');
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

async function renderFolio() {
  const box = document.getElementById('folio');

  // 수량·평단가가 모두 있고 현재가를 받은 종목만 센다
  const held = state.watchlist
    .map((i) => ({ i, h: state.holdings[i.symbol], q: quotes[i.symbol] }))
    .filter((x) => x.h && x.h.qty > 0 && x.h.avg > 0 && x.q && x.q.price != null);

  if (!held.length) { box.hidden = true; return; }

  const foreign = held.some((x) => curOf(x.i.symbol) !== 'KRW');
  const rate = foreign ? await usdKrw() : null;
  if (foreign && !rate) {
    // 환율을 못 받으면 합계가 틀린 값이 되므로 숫자를 내놓지 않는다
    box.hidden = false;
    box.innerHTML = '<span class="fn">보유</span><span class="fv">환율을 받지 못해 합계를 낼 수 없습니다</span>';
    return;
  }

  let value = 0; let cost = 0;
  for (const { i, h, q } of held) {
    const k = curOf(i.symbol) === 'KRW' ? 1 : rate;
    value += q.price * h.qty * k;
    cost += h.avg * h.qty * k;
  }

  const gain = value - cost;
  const pct = cost > 0 ? (gain / cost) * 100 : 0;
  const color = gain === 0 ? cssVar('--flat') : (gain > 0 ? UP : DOWN);

  box.hidden = false;
  box.innerHTML = `<span class="fn">보유 ${held.length}종목</span>`
    + `<span class="fv">${fmt(Math.round(value))}</span>`
    + (foreign ? `<span class="fx">$${fmt(Math.round(rate))}</span>` : '')
    + `<span class="fp" style="color:${color}">${signed(Math.round(gain))} (${fmtPct(pct)})</span>`;
}

// --- 업종 -----------------------------------------------------------------------
// Yahoo 값을 영어 그대로 쓴다. 번역하지 않으니 11개짜리 sector 대신
// 150개가 넘는 industry 를 쓸 수 있다 — 훨씬 구체적이다.
// (Technology 면 삼성전자·SK하이닉스가 한 칸인데, industry 로는
//  Consumer Electronics 와 Semiconductors 로 갈린다)
// 거래소 업종("전기/전자")과는 분류 자체가 다르다. GICS 기준이다.
//
// 업종은 바뀌지 않으므로 한 번 받으면 세션 내내 재사용한다.
// null 도 캐시한다 — ETF 처럼 값이 없는 종목을 볼 때마다 다시 묻지 않기 위해.
const sectors = new Map();

async function sectorFor(symbol) {
  if (sectors.has(symbol)) return sectors.get(symbol);
  const r = await api.sector(symbol);
  // 실패는 캐시하지 않는다(일시적 오류일 수 있다). 값 없음(null)은 캐시한다.
  if (!r.ok) return null;
  const name = r.industry || r.sector || null;
  sectors.set(symbol, name);
  return name;
}

// 종목명 옆 회색 업종. 조회가 늦게 와도 그 사이 다른 종목을 고르면 버린다.
async function loadSector(item) {
  const el = document.getElementById('dsector');
  const name = await sectorFor(item.symbol);
  if (state.selected !== item.symbol) return;
  el.textContent = name || '';
}

// --- 상세 + 차트 ---------------------------------------------------------------
// isTrading 이 없는 이전 응답도 세션/open 으로 판정한다.
function quoteSession(q) {
  if (!q || q.error) return 'unknown';
  if (Object.prototype.hasOwnProperty.call(SESSION_TEXT, q.session)) return q.session;
  if (q.open === true) return 'regular';
  if (q.open === false) return 'closed';
  return 'unknown';
}

function tradingState(q) {
  if (!q || q.error) return null;
  if (q.isTrading !== undefined) return typeof q.isTrading === 'boolean' ? q.isTrading : null;
  const session = quoteSession(q);
  if (session === 'unknown') return null;
  return session !== 'closed';
}

function isDomestic(symbol) {
  return /^[A-Za-z0-9]{1,10}\.(KS|KQ)$/i.test(symbol) || /^\d{6}$/.test(symbol);
}

function pollingIsOpen(symbols, liveMap) {
  const domestic = symbols.filter(isDomestic);
  // 해외만 있거나 국내 응답이 하나라도 비었으면 짧은 간격으로 재확인한다.
  return !domestic.length || domestic.some((symbol) =>
    tradingState(liveMap[symbol] || liveMap[symbol.split('.')[0]]) !== false);
}

function priceSessionOf(q) {
  return q && (q.priceSession || q.session) || 'unknown';
}

function renderUpdated() {
  const q = quotes[state.selected];
  const session = quoteSession(q);
  const el = document.getElementById('updated');
  const fetched = q && q.fetchedAt != null ? new Date(q.fetchedAt) : null;
  const validFetched = fetched && Number.isFinite(fetched.getTime());
  const p = (n) => String(n).padStart(2, '0');
  const time = validFetched
    ? `${p(fetched.getHours())}:${p(fetched.getMinutes())}:${p(fetched.getSeconds())}` : '';
  const delayed = q && !q.error && q.price != null && q.live === false;
  el.innerHTML = `<span class="${q && q.live ? SESSION_CLASS[session] : 'delay'}">`
    + `${delayed ? '20분지연' : SESSION_TEXT[session]}</span> ${time}`;
  const source = q && !q.error && q.price != null
    ? `${q.live ? '실시간' : '20분지연'} · ${q.source || (q.live ? 'Naver' : 'Yahoo')}`
    : '확인 불가';
  el.title = `소스: ${source}${q && q.market ? ` · ${q.market}` : ''}`
    + `\n세션: ${SESSION_TEXT[session]}`
    + `\n조회 완료: ${validFetched ? fetched.toISOString() : '확인 불가'}`
    + `\n시세 시각: ${q && q.tradedAt || '확인 불가'}`;
}

function renderDetail() {
  renderUpdated();
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  const q = item && quotes[item.symbol];

  const cur = item ? curOf(item.symbol) : 'KRW';
  document.getElementById('dprice').textContent = money(q && q.price, cur);
  document.getElementById('dcandle').innerHTML = candleTag(q, cur);
  // 원화가 아니면 어느 통화인지 이름 옆에 표시
  document.getElementById('dname').textContent = item
    ? (cur === 'KRW' ? item.name : `${item.name} (${cur})`) : '—';

  // 업종은 네트워크를 타므로 종목이 바뀌면 일단 비우고 채워 넣는다.
  // 이전 종목의 업종이 새 종목 이름 옆에 잠깐 남으면 잘못된 정보가 된다.
  const secEl = document.getElementById('dsector');
  const cached = item && sectors.get(item.symbol);
  secEl.textContent = cached || '';
  if (item && !sectors.has(item.symbol)) loadSector(item).catch(console.error);

  const chgEl = document.getElementById('dchg');
  const badge = document.getElementById('badge');

  if (q && q.change != null) {
    const color = q.change === 0 ? cssVar('--flat') : (q.change > 0 ? UP : DOWN);
    chgEl.style.color = color;
    chgEl.innerHTML = `${signedMoney(q.change, cur)}<br>${fmtPct(q.pct)}`;
  } else {
    chgEl.textContent = '';
  }

  // 시간외(장후)에는 정규장 종가 대비 이동폭을 한 줄 더 붙인다. 위 두 줄은 전일
  // 종가 기준이라(네이버가 주는 기준) 시간외에서 얼마나 움직였는지는 안 보인다.
  // main.js 가 장후 가격과 검증된 당일 종가가 있을 때만 채운다 (종료 후에도 유지).
  const closeEl = document.getElementById('dclose');
  closeEl.hidden = !(q && q.fromClose != null);
  closeEl.textContent = q && q.fromClose != null ? `종가대비 ${signedMoney(q.fromClose, cur)}` : '';

  renderHolding(item && item.symbol, q && q.price);
  renderW52(q && q.week52Low, q && q.week52High, q && q.price, cur);

  const lv = levelOf(q && q.rsi);
  badge.textContent = q && q.rsi != null ? `${lv.label} · RSI ${q.rsi.toFixed(0)}` : 'RSI —';
  badge.style.color = lv.color;
  badge.style.background = q && q.rsi != null ? hexA(lv.color, 0.16) : cssVar('--chip');
}

// 보유 수량·평단가를 입력해 둔 종목이면 평가손익을 보여준다.
function renderHolding(symbol, price) {
  const el = document.getElementById('hold');
  const h = state.holdings[symbol];
  if (!h || price == null) { el.hidden = true; return; }

  const cost = h.qty * h.avg;
  const value = h.qty * price;
  const pl = value - cost;
  const pct = cost ? (pl / cost) * 100 : 0;
  const color = pl === 0 ? cssVar('--flat') : (pl > 0 ? UP : DOWN);

  el.hidden = false;
  const cur = curOf(symbol);
  el.innerHTML = `<span class="hqty">${fmt(h.qty)}주</span>`
    + `<span>평단 ${money(h.avg, cur)}</span>`
    + `<span>평가 ${money(value, cur)}</span>`
    + `<span class="hpl" style="color:${color}">${signedMoney(pl, cur)} (${fmtPct(pct)})</span>`;
}

// 52주 저점~고점 사이에서 현재가가 어디쯤인지. Yahoo meta 값이라 추가 요청이 없다.
function renderW52(low, high, price, cur) {
  const box = document.getElementById('w52');
  if (!low || !high || high <= low || price == null) { box.hidden = true; return; }

  const pos = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  box.hidden = false;
  document.getElementById('w52lo').textContent = money(low, cur);
  document.getElementById('w52hi').textContent = money(high, cur);
  document.getElementById('w52mark').style.left = `${pos}%`;
  box.title = `52주 최저 ${money(low, cur)} · 최고 ${money(high, cur)}\n`
    + `현재 ${money(price, cur)} — 저점 대비 ${fmtPct(((price - low) / low) * 100)}, `
    + `고점 대비 ${fmtPct(((price - high) / high) * 100)}`;
}

// 선택 구간의 수익률 배지. 1D는 위의 일간 등락과 같은 값이라 표시하지 않는다.
function renderPeriod(first, last) {
  const el = document.getElementById('period');
  if (state.timeframe === '1D' || !first || last == null) { el.hidden = true; return; }

  const pct = ((last - first) / first) * 100;
  const color = pct === 0 ? cssVar('--flat') : (pct > 0 ? UP : DOWN);
  el.hidden = false;
  el.textContent = `${state.timeframe} ${fmtPct(pct)}`;
  el.style.color = color;
  el.style.background = hexA(color, 0.16);
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// 이동평균선 범례. 실제로 그린 선만, 기간 숫자 뒤에 그 색을 붙여 보여준다.
// 차트에 마우스를 올리면 그 시점의 값까지 같이 보여준다(툴팁 대신 여기에 띄운다).
let hoverIdx = null;
function renderMaLegend() {
  const box = document.getElementById('maLegend');
  const mas = (lastChart && lastChart.mas) || [];
  // 확대 중에는 추세선을 그리지 않으므로(drawChart) 범례에서도 뺀다. drawChart 가
  // zoom 을 먼저 정리한 뒤 이 함수를 부르므로 zoom 이 있으면 확대된 화면이다.
  const trends = (lastChart && !zoom && lastChart.trends) || [];
  box.hidden = mas.length === 0 && trends.length === 0;
  box.innerHTML = '';

  // 값 칸은 비어 있어도 자리를 잡아둔다. 마우스가 올라올 때마다 폭이 변하면
  // 범례가 한 줄에서 두 줄로 접히면서 아래 차트가 들썩인다.
  const add = (label, value, color, title, dashed) => {
    const s = document.createElement('span');
    s.title = title;
    s.append(label);
    const val = document.createElement('b');
    val.textContent = value == null ? '' : money(value, lastChart.cur);
    s.appendChild(val);
    const i = document.createElement('i');
    i.style.background = color;
    if (dashed) i.className = 'dash';
    s.appendChild(i);
    box.appendChild(s);
  };

  for (const m of mas) {
    add(String(m.p), hoverIdx == null ? null : m.data[hoverIdx],
      maColor(m.p), `${m.p}일 이동평균`);
  }
  // 추세선은 마우스를 안 올렸을 때 마지막 봉(오늘) 값을 보여준다.
  // 이동평균과 달리 개수가 둘로 고정이라 늘 떠 있어도 줄이 넘치지 않는다.
  for (const t of trends) {
    const sup = t.varName === '--sup-line';
    const i = hoverIdx == null ? t.data.length - 1 : hoverIdx;
    add(sup ? '지지' : '저항', t.data[i], cssVar(t.varName),
      sup ? '저점을 잇는 지지선' : '고점을 잇는 저항선', true);
  }
}

// 거래량은 자릿수가 커서 그대로 두면 툴팁이 길어진다
const fmtVol = (v) => {
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`;
  return v.toLocaleString();
};

// 가로 기준선(보유 평단가 · 전일 종가). 데이터셋으로 넣으면 값이 차트 범위 밖일 때
// y축이 통째로 늘어나므로, 축과 무관하게 캔버스에 직접 그리고 범위를 벗어나면 생략한다.
const hLinePlugin = {
  id: 'hLine',
  afterDatasetsDraw(c, _args, opts) {
    const lines = opts.lines || [];
    if (!lines.length) return;
    const area = c.chartArea;
    const ctx = c.ctx;
    const drawnAt = []; // 이미 라벨을 찍은 y 좌표

    for (const ln of lines) {
      const y = c.scales.y.getPixelForValue(ln.value);
      if (y < area.top || y > area.bottom) continue;

      const color = cssVar(ln.varName);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();

      // 선끼리 가까우면 글자가 포개진다. 선은 그리고 라벨만 생략한다.
      if (!drawnAt.some((prev) => Math.abs(prev - y) < 10)) {
        drawnAt.push(y);
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(ln.label, area.left + 2, y - 1);
      }
      ctx.restore();
    }
  },
};

// 마우스를 올린 시점을 세로선으로 짚어준다. 툴팁만으로는 x축 어디인지 눈으로 따라가야 한다.
// 툴팁이 잡고 있는 요소를 그대로 쓰므로 표시 위치가 어긋나지 않는다.
const crosshairPlugin = {
  id: 'crosshair',
  afterDatasetsDraw(c) {
    const active = c.tooltip && c.tooltip.getActiveElements ? c.tooltip.getActiveElements() : [];
    if (!active.length) return;

    const area = c.chartArea;
    const x = active[0].element.x;
    if (x < area.left || x > area.right) return;

    const ctx = c.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar('--crosshair');
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// 가장 최근 교차를 배지로. 차트를 보지 않고 목록만 넘겨도 알 수 있게.
function renderCrossBadge(crosses, times) {
  const el = document.getElementById('cross');
  const last = crosses[crosses.length - 1];
  if (!last) { el.hidden = true; return; }

  const days = daysAgo(times[last.i]);
  el.hidden = false;
  // 확정 봉만 보므로 가장 가까운 교차도 최소 1일 전이다 — "오늘"은 나오지 않는다.
  el.textContent = `${last.pair} ${last.golden ? '골든' : '데드'} · ${days}일 전`;
  el.classList.toggle('up', last.golden);
  el.classList.toggle('down', !last.golden);
}

// 추세선 배지 둘 — 돌파와 수렴.
//
// 돌파가 있으면 수렴은 표시하지 않는다. 한쪽이 이미 끝난 선인데 두 선이 만나는
// 시점을 말하면 틀린 정보가 되고, 폭 340px 에 배지가 셋 이상 들어가면 줄이 접힌다.
//
// 수렴은 삼각수렴까지 남은 거래일이다. 벌어지는 중이면 교차점이 과거로 나오는데,
// 그건 "이미 지났다"가 아니라 값 자체가 의미 없는 경우라 표시하지 않는다.
function renderTrendBadges(trends, len, times = []) {
  const brk = document.getElementById('breakout');
  const el = document.getElementById('converge');
  brk.hidden = true;
  el.hidden = true;

  // 양쪽이 다 뚫렸으면 더 크게 벗어난 쪽만 보여준다(배지 하나로 고정).
  const hit = trends.filter((t) => t.broke).sort((a, b) => b.broke.pct - a.broke.pct)[0];
  if (hit) {
    const isSup = hit.varName === '--sup-line';
    // 크로스 배지와 같은 방식으로 실제 달력 일수를 쓴다.
    const days = daysAgo(times[hit.broke.at]);
    brk.hidden = false;
    brk.classList.toggle('sup', isSup);
    brk.textContent = `${isSup ? '지지 이탈' : '저항 돌파'} ${fmtPct(hit.broke.pct * 100)}`
      + ` · ${days}일 전`; // 크로스 배지와 같이 확정 봉만 보므로 "오늘"은 없다
    return;
  }

  const sup = trends.find((t) => t.varName === '--sup-line');
  const res = trends.find((t) => t.varName === '--res-line');
  if (!sup || !res) return;

  const at = meetAt(sup, res);
  if (at == null) return;
  // 교차점은 소수로 나온다. 올림이라 "n거래일"은 "마지막 봉에서 n 번째 봉 안에 만난다".
  // 반올림하면 0.6(거의 붙음)과 1.4(다음 봉에도 안 만남)가 똑같이 1 이 된다.
  const bars = Math.ceil(at - (len - 1));
  if (bars <= 0 || bars > 250) return; // 1년 밖은 사실상 평행선이다

  // 봉은 거래일이다. 달력으로는 대략 7/5 배 — 공휴일은 반영하지 못한다.
  const weeks = Math.round((bars * 7) / 5 / 7);
  el.hidden = false;
  el.textContent = `수렴 ${bars}거래일${weeks >= 2 ? ` · 약 ${weeks}주` : ''}`;
}

// 캔들. 몸통은 시가~종가, 꼬리는 저가~고가. 색은 시가 대비다 — 전일 종가 대비인
// 헤더 등락률과 다를 수 있고, 그 차이가 캔들을 보는 이유다.
//
// beforeDatasetsDraw 라 이동평균선·추세선 **아래**에 깔린다. crossMarkPlugin 이
// afterDatasetsDraw(위)인 것과 반대다 — 표식은 덮어야 보이고 캔들은 덮으면 선을
// 가린다.
//
// y축 범위는 투명하게 남겨 둔 고가~저가 밴드 데이터셋이 잡아 준다. 캔버스에만
// 그리면 꼬리 끝이 축 밖으로 나가 말없이 잘린다(추세선 주석의 그 문제다).
const candlePlugin = {
  id: 'candle',
  beforeDatasetsDraw(c, _args, opts) {
    const { opens = [], highs = [], lows = [], closes = [] } = opts || {};
    if (!opens.length) return;

    const sx = c.scales.x; const sy = c.scales.y;
    const area = c.chartArea;
    const ctx = c.ctx;
    // 봉 간격 = 이웃한 두 봉의 픽셀 거리. 확대하면 전체 봉 수가 아니라 보이는 봉
    // 수로 나눈 값이 되어야 해서 폭 ÷ 봉 수로는 안 된다. 구간 밖 봉은 아래 clip 이 자른다.
    const step = opens.length > 1
      ? Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0)) : sx.width;
    const w = candleWidth(step);
    const flat = cssVar('--flat');

    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip(); // 축 눈금 위로 삐져나가지 않게

    for (let i = 0; i < opens.length; i++) {
      const o = opens[i]; const h = highs[i]; const l = lows[i]; const cl = closes[i];
      if (o == null || h == null || l == null || cl == null) continue;

      const color = cl > o ? UP : cl < o ? DOWN : flat;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;

      // 꼬리는 1px 세로선. +0.5 는 캔버스 격자에 맞춰 흐려지지 않게 하는 것이다.
      const cx = Math.round(sx.getPixelForValue(i));
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, sy.getPixelForValue(h));
      ctx.lineTo(cx + 0.5, sy.getPixelForValue(l));
      ctx.stroke();

      const b = candleBody(sy.getPixelForValue(o), sy.getPixelForValue(cl));
      ctx.fillRect(cx - Math.floor(w / 2), b.top, w, b.h);
    }
    ctx.restore();
  },
};

// 교차 지점 표식. 골든은 선 아래에 ▲, 데드는 선 위에 ▼.
// 평단가 점선과 마찬가지로 축을 건드리지 않도록 캔버스에 직접 그린다.
const crossMarkPlugin = {
  id: 'crossMark',
  afterDatasetsDraw(c, _args, opts) {
    const list = opts.list || [];
    if (!list.length) return;
    const area = c.chartArea;
    const ctx = c.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip(); // 축 눈금 위로 삐져나가지 않게

    for (const k of list) {
      const x = c.scales.x.getPixelForValue(k.i);
      const y = c.scales.y.getPixelForValue(k.y);
      const dir = k.golden ? 1 : -1; // 골든은 아래쪽, 데드는 위쪽
      const tip = y + dir * 6;
      ctx.fillStyle = k.golden ? UP : DOWN;
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x - 3.5, tip + dir * 5);
      ctx.lineTo(x + 3.5, tip + dir * 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  },
};

// 끄는 중인 확대 구간 { a, b, key } — 봉 번호(누른 곳, 지금 마우스), key 는 누른 시점의
// "종목|기간"(dragKey()). 끌기 이벤트가 쓰고 아래 zoomBoxPlugin 이 읽는다. 끄는 동안에는
// chart.draw() 로 다시 그리기만 해서 가볍다.
let zoomDrag = null;

// 끄는 동안의 선택 상자. 양 끝 봉이 상자 안에 다 들어오게 반 칸씩 넓힌다.
// 툴팁보다 먼저 그려야 툴팁이 상자에 물들지 않는다 — afterDraw 가 아니라 afterDatasetsDraw.
const zoomBoxPlugin = {
  id: 'zoomBox',
  afterDatasetsDraw(c) {
    if (!zoomDrag) return;
    const sx = c.scales.x;
    const area = c.chartArea;
    const half = Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0)) / 2;
    const x1 = Math.max(area.left, sx.getPixelForValue(Math.min(zoomDrag.a, zoomDrag.b)) - half);
    const x2 = Math.min(area.right, sx.getPixelForValue(Math.max(zoomDrag.a, zoomDrag.b)) + half);
    const ctx = c.ctx;
    ctx.save();
    ctx.fillStyle = cssVar('--accent-bg');
    ctx.fillRect(x1, area.top, Math.max(1, x2 - x1), area.height);
    ctx.restore();
  },
};

// 차트를 벗어나면 범례를 기간 숫자만 남은 상태로 되돌린다.
// 캔버스는 다시 만들어지지 않으므로 한 번만 붙인다.
let leaveBound = false;
function bindChartLeave() {
  if (leaveBound) return;
  leaveBound = true;
  document.getElementById('chart').addEventListener('mouseleave', () => {
    if (hoverIdx === null) return;
    hoverIdx = null;
    renderMaLegend();
  });
}

let lastChart = null;

// 차트를 지울 때 딸린 상태까지 한 번에 정리한다.
// 흩어 두면 상태가 하나 늘 때마다 여러 곳을 고쳐야 하고, 빠뜨리면 유령 값이 남는다.
function clearChart() {
  if (chart) { chart.destroy(); chart = null; }
  lastChart = null;
  lastDrawSig = null;
  hoverIdx = null;
  renderMaLegend();
  renderCrossBadge([], []);
  renderTrendBadges([], 0);
  document.getElementById('chartMode').hidden = true; // 차트가 없으면 전환할 것도 없다
  document.getElementById('zoomReset').hidden = true; // 차트가 없으면 풀 확대도 없다
}

function drawChart(arg) {
  lastChart = arg;
  const {
    closes, times, up, mas = [], cur = 'KRW',
    volumes = [], opens = [], highs = [], lows = [], hLines = [], crosses = [], trends = [],
  } = arg;
  const color = up ? UP : DOWN;
  // 빠진 시가는 main.js 와 pad 가 종가로 채운다(그 봉은 회색 십자). opens 를 아예 안
  // 넘기는 호출만 라인으로 그린다.
  const daily = TF[state.timeframe].interval === '1d';
  // 확대 구간(3M · 1Y). 날짜로 기억해 둔 것을 지금 봉 번호로 바꾼다 — 구간이
  // 사라졌으면(5봉 미만) 전체 보기로 돌아간다.
  const zr = zoom && ZOOM_TF.has(state.timeframe) ? zoomRange(times, zoom.start, zoom.end) : null;
  if (!zr) zoom = null;
  const bars = zr ? zr.to - zr.from + 1 : closes.length; // 화면에 보이는 봉 수
  const candles = candleMode(bars, daily, state.chartMode) && opens.length > 0;
  renderChartMode(bars, daily); // 전환 아이콘도 같은 기준으로 보인다
  document.getElementById('zoomReset').hidden = !zr;
  hoverIdx = null;
  renderMaLegend(); // 테마를 바꿔도 여기서 다시 그려지므로 색이 따라온다
  if (chart) chart.destroy();
  bindChartLeave();

  // 거래량 막대는 차트 아래 1/4 만 쓰도록 별도 y축을 최댓값의 4배로 잡는다.
  // 확대 중에는 보이는 구간의 최댓값으로 — 전체 최댓값이면 막대가 납작해진다.
  const shownVol = zr ? volumes.slice(zr.from, zr.to + 1) : volumes;
  const maxVol = shownVol.length ? Math.max(...shownVol) : 0;

  chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    plugins: [candlePlugin, hLinePlugin, crossMarkPlugin, crosshairPlugin, zoomBoxPlugin],
    data: {
      // 1Y 를 확대하면 몇 주 · 몇 달만 보이므로 연/월 라벨로는 눈금이 같은 값으로
      // 반복된다(26/03 · 26/03 · 26/04). 그때는 1M · 3M 과 같은 월/일로 쓴다.
      labels: times.map((t) => labelFor(t, zr && state.timeframe === '1Y' ? '3M' : state.timeframe)),
      datasets: [{
        label: '',
        data: closes,
        yAxisID: 'y',
        order: 2, // 거래량 막대(0)·고저 밴드(1)보다 뒤에 그려서 위로 올라온다
        borderColor: candles ? 'transparent' : color,
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 8,
        tension: 0.15,
        fill: true,
        backgroundColor: (ctx) => {
          if (candles) return 'transparent'; // 캔들 위에 채움이 겹치면 몸통이 흐려진다
          const area = ctx.chart.chartArea;
          if (!area) return 'transparent';
          // 채움이 진하면 그 안에 들어간 이동평균선이 묻힌다.
          // 위쪽만 옅게 남기고 아래 절반은 빠르게 비워 이평선이 지나갈 자리를 만든다.
          const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          g.addColorStop(0, hexA(color, 0.38));
          g.addColorStop(0.55, hexA(color, 0.12));
          g.addColorStop(1, hexA(color, 0));
          return g;
        },
      },
      // 고가~저가 밴드. 종가 하나만 그리면 하루에 얼마나 흔들렸는지가 안 보인다.
      // 위(고가) 데이터셋이 fill:'+1' 로 바로 다음(저가)까지 채운다 → 배열에서 붙어 있어야 한다.
      ...(highs.length ? [{
        label: '',
        data: highs,
        yAxisID: 'y',
        order: 1,
        borderWidth: 0,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.15,
        fill: '+1',
        backgroundColor: candles ? 'transparent' : hexA(color, 0.16),
      }, {
        label: '',
        data: lows,
        yAxisID: 'y',
        order: 1,
        borderWidth: 0,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.15,
        fill: false,
      }] : []),
      // 이동평균선 (일봉 타임프레임에서만 전달된다).
      // 전부 80% 불투명도. 주가선은 2px 라 여러 개를 켜도 굵기로 먼저 읽힌다.
      ...mas.map((m) => ({
        data: m.data,
        yAxisID: 'y',
        order: 3,
        borderColor: hexA(maColor(m.p), 0.8),
        borderWidth: maWidth(m.p),
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
      })),
      // 지지·저항 추세선 (3M · 1Y 에서만 전달된다).
      // 점선 1px — 이동평균과 헷갈리지 않게 하고, 선이 하나 더 늘어도 눌리지 않게 한다.
      // 정규 데이터셋이라 y축이 알아서 범위에 넣는다. 캔버스에 직접 그리면
      // 기울어진 선의 양 끝이 축 밖으로 나가 말없이 잘린다(시간외 선에서 겪음).
      // 확대 중에는 숨긴다. "지금"을 말하는 선(최근 5봉을 빼고 만들어 오늘 값 · 돌파를
      // 계산)이고, 과거 구간 가격에서 먼 선이 y축을 다시 벌려 확대 효과를 깎는다.
      ...(zr ? [] : trends).map((t) => ({
        data: t.data,
        yAxisID: 'y',
        order: 3,
        borderColor: cssVar(t.varName),
        borderWidth: 1.6,
        borderDash: [5, 3],
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0,
        fill: false,
        spanGaps: false,
      })),
      // 거래량. label 이 빈 문자열이라 툴팁 본문에는 줄이 생기지 않고,
      // 값은 beforeBody 에서 주가 밑에 따로 붙인다.
      ...(maxVol > 0 ? [{
        type: 'bar',
        label: '',
        isVolume: true,
        data: volumes,
        yAxisID: 'yVol',
        order: 0, // 가장 먼저 = 밴드·주가선·이평선 뒤에
        backgroundColor: hexA(color, 0.2),
        borderWidth: 0,
        barPercentage: 1,
        categoryPercentage: 1,
      }] : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      // 가리키는 시점의 이동평균 값을 범례에 띄운다(툴팁을 늘리지 않기 위해)
      onHover: (_e, els) => {
        const idx = els.length ? els[0].index : null;
        if (idx === hoverIdx) return;
        hoverIdx = idx;
        renderMaLegend();
      },
      plugins: {
        // 범례는 띄우지 않는다. 이동평균을 여러 개 켜면 두 줄로 늘어나
        // 150px 짜리 차트에서 35px 가까이 잡아먹는다.
        // 어느 선이 무엇인지는 설정의 색 있는 칩과 툴팁이 알려준다.
        legend: { display: false },
        hLine: { lines: hLines },
        crossMark: { list: crosses },
        candle: candles ? { opens, highs, lows, closes } : {},
        tooltip: {
          // 이동평균 값은 툴팁이 아니라 위쪽 범례에 띄운다.
          // 툴팁은 켠 이평선 수만큼 세로로 늘어나서, 9개면 197px 까지 커져
          // 150px 짜리 차트를 통째로 덮었다. 지금은 날짜·주가·거래량 3줄로 고정된다.
          displayColors: false,
          backgroundColor: cssVar('--tooltip'),
          titleColor: cssVar('--text'),
          bodyColor: cssVar('--text'),
          borderColor: cssVar('--border'),
          borderWidth: 1,
          titleFont: { size: 10 },
          bodyFont: { size: 11 },
          callbacks: {
            // 1Y 는 축 라벨이 연/월(YY/MM)이라 제목에 일이 없으면 어느 날을 가리키는지
            // 모른다 — 끌어서 구간을 고를 때 특히. 1Y 만 일까지 보인다.
            title: (items) => {
              const it = items[0];
              if (!it) return '';
              if (state.timeframe !== '1Y') return it.label;
              const d = new Date(times[it.dataIndex]);
              const p = (n) => String(n).padStart(2, '0');
              return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
            },
            // 내용은 전부 beforeBody 로 올린다(본문은 비운다).
            beforeBody: (items) => {
              const lines = [];
              const p = items.find((i) => i.datasetIndex === 0);
              if (p) lines.push(money(p.parsed.y, cur));

              const i = p ? p.dataIndex : -1;
              // 캔들은 시가 대비로 색이 갈리므로 시가가 없으면 몸통의 근거가 안 보인다.
              if (candles && opens[i] != null) lines.push(`시 ${money(opens[i], cur)}`);

              const hi = highs[i]; const lo = lows[i];
              if (hi != null && lo != null && hi !== lo) {
                lines.push(`고저 ${money(lo, cur)} ~ ${money(hi, cur)}`);
              }

              const v = items.find((x) => x.dataset.isVolume);
              if (v && v.parsed.y) lines.push(`거래량 ${fmtVol(v.parsed.y)}`);
              return lines;
            },
            // 빈 배열을 주면 Chart.js 가 그 줄을 통째로 건너뛴다 → 본문이 비고 높이가 고정된다
            label: () => [],
          },
        },
      },
      scales: {
        x: {
          // 확대 구간. y축은 Chart.js 가 이 구간 안의 점만으로 다시 잡는다 —
          // DatasetController.getMinMax 가 다른 축의 사용자 범위(getUserBounds) 밖
          // 점을 건너뛴다(4.5.1 에서 확인). 투명 고저 밴드가 꼬리까지 범위를 잡는다.
          min: zr ? zr.from : undefined,
          max: zr ? zr.to : undefined,
          grid: { display: false },
          ticks: { color: cssVar('--mute'), font: { size: 9 }, maxTicksLimit: 4, maxRotation: 0, autoSkip: true },
        },
        y: {
          position: 'right',
          grid: { color: cssVar('--grid') },
          ticks: { color: cssVar('--mute'), font: { size: 9 }, maxTicksLimit: 4, callback: (v) => money(v, cur) },
        },
        // 거래량 전용 축. 최댓값의 4배를 천장으로 잡아 막대가 아래 1/4 만 차지한다.
        yVol: {
          display: false,
          beginAtZero: true,
          max: maxVol * 4,
          grid: { display: false },
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
// 일봉 시리즈를 캐시에서 꺼낸다. 만료됐으면 다시 받고, 실패하면 있던 캐시를 그대로 쓴다.
async function dailyFor(symbol, ttl) {
  const cached = dailyCache[symbol];
  if (cached && Date.now() - cached.at < ttl) return cached;

  const r = await api.fetchChart({ symbol, ...DAILY });
  if (!r.ok) return cached || { error: r.error };

  const last = r.closes.length - 1;
  dailyCache[symbol] = {
    at: Date.now(),
    price: r.price,
    closes: r.closes,
    times: r.times,
    // 목록의 오늘 캔들용 폴백(해외 종목·네이버 실패). 마지막 봉만 쓰므로
    // 시·고·저 배열 전체를 들고 있지 않는다 — 5년치면 종목당 세 배다.
    candle: { open: r.opens?.[last], high: r.highs?.[last], low: r.lows?.[last] },
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
  };
  return dailyCache[symbol];
}

async function loadQuote(item, live) {
  // 실시간 가격이 따로 오면 일봉은 오래 캐시해도 된다.
  // 실시간이 없으면(폴백) 일봉의 가격을 그대로 쓰므로 짧게만 캐시한다.
  const r = await dailyFor(item.symbol, live ? DAILY_TTL : 60000);
  if (!r || r.error) {
    quotes[item.symbol] = { error: r ? r.error : '조회 실패', fetchedAt: Date.now() };
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
    session: live ? quoteSession(live) : 'unknown',
    priceSession: priceSessionOf(live),
    isTrading: tradingState(live),
    regularClose: live && live.regularClose != null ? live.regularClose : null,
    // 오늘 캔들. 실시간이 정규장 시·고·저를 함께 주면 그것을 쓰고(30초마다 최신),
    // 없으면 일봉 마지막 봉에서 가져온다 — 가격과 같은 폴백 순서다.
    candle: (live && live.candle) || r.candle || null,
    market: live && live.market || null,
    source: live && live.source || (live ? 'Naver' : 'Yahoo'),
    tradedAt: live && live.tradedAt || null,
    fetchedAt: Date.now(),
    // 장후 가격의 검증된 당일 정규장 종가 대비 이동폭. 종료 후에도 유지한다.
    // 0 도 뜻이 있는 값이라(움직이지 않음) || 로 뭉개면 안 된다.
    fromClose: live && live.fromClose != null ? live.fromClose : null,
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
    // 이동평균 계산용. 1M 차트는 23봉뿐이라 자체 데이터로는 20일선이 끝부분만 그려진다.
    // 이미 받아둔 1년치를 그대로 재활용해 추가 요청 없이 앞구간까지 채운다.
    daily: { times: r.times, closes },
  };
}

// 차트 시각(times)에 맞춰 일봉 이동평균을 끌어온다. 일봉이 아닌 타임프레임은 대상 아님.
function maFor(symbol, times, period) {
  const d = quotes[symbol] && quotes[symbol].daily;
  if (!d || d.closes.length < period) return null;

  // 시각이 아니라 날짜로 짝짓는다. 장중 오늘 봉의 시각은 마지막 체결 시각이라
  // 일봉과 차트를 받은 순간마다 달라서(실측 1초 차), 정확히 맞추면 오늘 값이 빠진다.
  // UTC 날짜를 쓰는 건 한국(00:00~06:30 UTC)·미국(13:30~21:00 UTC) 장이 모두 하루 안에
  // 들어가서다 — 한국 날짜로 자르면 미국 장이 자정을 넘겨 오늘 봉이 이틀로 갈린다.
  const dayOf = (t) => Math.floor(t / 86400000);
  const values = sma(d.closes, period);
  const byDay = new Map();
  for (let i = 0; i < d.times.length; i++) byDay.set(dayOf(d.times[i]), values[i]);

  const out = times.map((t) => (byDay.has(dayOf(t)) ? byDay.get(dayOf(t)) : null));
  return out.some((v) => v != null) ? out : null;
}

// 실시간 시세 조회 (실패해도 조용히 빈 값 → Yahoo 지연 시세로 동작)
async function fetchLive(symbols) {
  // 실패/빈 응답이 직전의 장마감 상태를 남겨 폴링을 늦추지 않게 한다.
  isLive = false;
  marketOpen = true;
  try {
    const r = await api.realtimeQuotes(symbols);
    if (!r || !r.ok || !r.quotes) return {};
    isLive = true;
    const requested = new Set(symbols);
    const all = [...new Set([...state.watchlist.map((i) => i.symbol), ...symbols])];
    const combined = {};
    for (const symbol of all) {
      combined[symbol] = requested.has(symbol)
        ? r.quotes[symbol] || r.quotes[symbol.split('.')[0]] : quotes[symbol];
    }
    marketOpen = pollingIsOpen(all, combined);
    return r.quotes;
  } catch (e) {
    console.error('실시간 시세 조회 실패', e);
    return {};
  }
}

// 차트 응답 캐시. 종목·타임프레임을 오갈 때마다 같은 걸 다시 받으면
// 매번 네트워크 왕복을 기다리게 된다. 1D(5분봉)만 폴링 주기와 같은 30초로 두고
// 나머지는 5분 — 일봉이 30초마다 바뀔 일은 없다.
const chartCache = new Map(); // `symbol|range|interval` -> { at, ttl, r }
const chartTtl = (interval) => (interval === '5m' ? 30000 : 5 * 60 * 1000);

async function fetchChartCached(symbol, tf) {
  const key = `${symbol}|${tf.range}|${tf.interval}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.r;

  const r = await api.fetchChart({ symbol, ...tf });
  if (!r.ok) return r; // 실패는 캐시하지 않는다 (다음 시도에서 바로 다시 받게)

  // 만료된 항목을 치워 캐시가 무한정 늘지 않게 한다
  const now = Date.now();
  for (const [k, v] of chartCache) if (now - v.at >= v.ttl) chartCache.delete(k);

  chartCache.set(key, { at: now, ttl: chartTtl(tf.interval), r });
  return r;
}

let lastDrawSig = null; // 내용이 그대로면 다시 그리지 않는다

async function loadChart() {
  const item = state.watchlist.find((i) => i.symbol === state.selected);
  if (!item) { document.getElementById('period').hidden = true; return; }

  // 종목/타임프레임을 빠르게 바꾸면 요청이 겹친다. 응답이 뒤늦게 도착한
  // 이전 요청은 버려야 헤더와 차트가 서로 다른 종목을 가리키지 않는다.
  const seq = ++chartSeq;
  const tf = TF[state.timeframe];
  const r = await fetchChartCached(item.symbol, tf);
  if (seq !== chartSeq) return;

  if (!r.ok) {
    // 실패 시 이전 차트를 남겨두면 헤더와 다른 종목을 보여주게 되므로 지운다
    clearChart();
    document.getElementById('period').hidden = true;
    // 장 시작 직후엔 Yahoo가 한국 분봉을 아직 안 채워 빈 응답이 온다.
    // 일봉(1M 이상)은 정상이므로 고장이 아니라는 걸 알려준다.
    const intraday = tf.interval !== '1d';
    err(intraday && r.error === '빈 데이터'
      ? `${item.name} ${state.timeframe}: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`
      : `${item.name} 차트: ${r.error}`);
    return;
  }

  err(quoteErrText());
  const q = quotes[item.symbol];
  const closes = r.closes.slice();
  const times = r.times.slice();

  // Yahoo 1D 봉은 20분 전에서 끊긴다. 장중 실시간이면 현재가를 끝점으로 이어붙여
  // 차트 끝과 위에 표시된 현재가가 어긋나 보이지 않게 한다.
  if (state.timeframe === '1D' && q && q.live && q.open && q.session === 'regular') {
    closes.push(q.price);
    times.push(Date.now());
  }

  // 1D 외에는 "일간 등락"만 보여주면 탭과 안 맞는다. 해당 구간 수익률도 같이 표시.
  renderPeriod(r.closes[0], q && q.price != null ? q.price : closes[closes.length - 1]);

  // 이동평균선은 일봉 타임프레임(1M/3M/1Y)에서만 의미가 있다.
  // 1D(5분봉)/1W(30분봉)에 "5일선"을 그리면 이름과 실제가 안 맞는다.
  const daily = tf.interval === '1d';
  const bars = daily ? r.times.length : 0;
  if (bars !== chartBars) { chartBars = bars; renderMaChips(); } // 켤 수 있는 기간이 바뀐다

  const mas = [];
  for (const p of state.maPeriods) {
    if (!maFits(p)) continue; // 구간에 비해 너무 긴 선은 y축만 벌리므로 건너뛴다
    const data = maFor(item.symbol, times, p);
    if (data) mas.push({ p, data }); // 색 · 굵기는 그릴 때 maColor · maWidth 로 읽는다(설정에서 바뀐다)
  }

  // 골든/데드크로스. 양쪽 이평선이 실제로 그려지는 조합만 본다
  // (설정 칩에서 5·20·60 을 다 켜둬야 두 쌍 모두 나온다).
  const byPeriod = new Map(mas.map((m) => [m.p, m.data]));
  const found = [];
  for (const [s, l] of CROSS_PAIRS) {
    const a = byPeriod.get(s); const b = byPeriod.get(l);
    if (!a || !b) continue;
    for (const c of crossings(a, b)) found.push({ ...c, pair: `${s}/${l}` });
  }
  found.sort((x, y) => x.i - y.i);
  // 배지와 차트 표식(▲▼)이 같은 목록을 쓴다 — 확정 전 교차를 한쪽만 숨기면
  // 배지는 옛 교차를 말하는데 차트에는 오늘 표식이 찍혀 서로 어긋난다.
  const crosses = confirmedCrosses(found, times.length);
  renderCrossBadge(crosses, times);

  // 1D 는 현재가를 끝에 이어붙였으므로 봉 단위 배열들보다 한 칸 길다 → 마지막 칸을 채운다
  const pad = (src, fill) => {
    const a = src ? src.slice(0, closes.length) : [];
    while (a.length < closes.length) a.push(typeof fill === 'function' ? fill(a.length) : fill);
    return a;
  };
  const volumes = pad(r.volumes, 0);
  const opens = pad(r.opens, (i) => closes[i]);
  const highs = pad(r.highs, (i) => closes[i]);
  const lows = pad(r.lows, (i) => closes[i]);

  // 야후 국내 시세는 20분 지연이라 오늘 봉이 화면의 다른 값들보다 뒤처진다 —
  // 상세 캔들(네이버 실시간)과 같은 값으로 마지막 봉을 맞춘다. 맞추지 않으면
  // 한 화면이 서로 다른 순간을 가리킨다(2026-09-22 삼성전자 저가 274,500 vs
  // 274,000). 덕분에 일봉 차트 끝점도 헤더 현재가와 어긋나지 않는다.
  // 마지막 봉이 오늘이 아니면(장 전 · 휴장) 건드리지 않는다 — 지나간 봉에
  // 오늘 값을 쓰면 없던 고가·저가가 생긴다.
  const todayBar = daily ? candleOf(q) : null;
  if (todayBar && daysAgo(times[times.length - 1]) === 0) {
    const i = closes.length - 1;
    closes[i] = todayBar.close;
    opens[i] = todayBar.open;
    highs[i] = todayBar.high;
    lows[i] = todayBar.low;
  }

  // 추세선은 3M · 1Y 에서만. 검사를 통과 못 한 쪽은 빠지므로
  // 지지선만, 저항선만, 또는 둘 다 없는 상태가 정상이다.
  const trends = [];
  if (TREND_TF.has(state.timeframe)) {
    const len = closes.length;
    const sup = trendLine(lows, len, true);
    const res = trendLine(highs, len, false);
    // 선을 만들 때 빼둔 최근 봉이 그 선을 뚫었는지 같이 담는다.
    if (sup) trends.push({ ...sup, varName: '--sup-line', broke: breakoutOf(sup, lows, len, true) });
    if (res) trends.push({ ...res, varName: '--res-line', broke: breakoutOf(res, highs, len, false) });
  }
  renderTrendBadges(trends, closes.length, times);

  const held = state.holdings[item.symbol];
  const up = !q || q.change >= 0;

  // 가로 기준선. 전일 종가는 장중(1D)에만 의미가 있다 —
  // 일봉 차트에서는 마지막에서 두 번째 점일 뿐이라 기준선이 될 이유가 없다.
  const hLines = [];
  if (held && held.avg > 0) hLines.push({ value: held.avg, label: '평단', varName: '--avg-line' });
  if (state.timeframe === '1D' && q) {
    if (q.prevClose != null) {
      hLines.push({ value: q.prevClose, label: '전일', varName: '--prev-line' });
    }
    // 시간외 가격은 별도 기준선이다. 종료 후에도 마지막 가격의 출처를 유지한다.
    // 시간외 한 점을 정규장 5분봉에 붙이면 시간 간격이 왜곡된다.
    const origin = priceSessionOf(q);
    if ((origin === 'after' || origin === 'pre') && q.price != null) {
      hLines.push({ value: q.price, label: origin === 'after' ? '애프터' : '프리', varName: '--over-line' });
    }
  }

  // 30초마다 캐시에서 같은 데이터가 나오면 다시 그릴 이유가 없다.
  // 다시 그리면 차트가 통째로 재생성돼 마우스를 올려둔 범례 값도 같이 지워진다.
  // 토글은 chartMode 만 바꾸므로 chartMode 도 서명에 넣어야 다시 그려진다(캔들
  // 여부는 drawChart 가 보이는 봉 수로 정한다). 종가가 같아도 두 폴링 사이 고가·
  // 저가만 바뀌면 오늘 캔들의 몸통·꼬리가 옛 값으로 남으므로 마지막 봉의 시가·
  // 고가·저가도 함께 본다.
  const sig = `${item.symbol}|${state.timeframe}|${closes.length}`
    + `|${closes[closes.length - 1]}|${up}|${mas.map((m) => m.p).join()}`
    + `|${hLines.map((l) => `${l.label}:${l.value}`).join()}`
    + `|${state.chartMode}`
    // 확대 · 되돌리기는 drawChart 로 바로 그린다. 서명에 확대 구간을 넣어 두면 그 뒤 첫
    // 갱신에서 차트를 한 번 더 만들지만(hover 범례가 한 번 지워진다), 서명이 늘 화면 상태를
    // 담아 토글 때처럼 "서명에 빠져 다시 안 그려지는" 일이 생기지 않는다.
    + `|${zoom ? `${zoom.start}-${zoom.end}` : ''}`
    + `|${opens[opens.length - 1]}|${highs[highs.length - 1]}|${lows[lows.length - 1]}`;
  if (sig === lastDrawSig) return;
  lastDrawSig = sig;

  drawChart({
    closes, times, up, mas, cur: curOf(item.symbol),
    volumes, opens, highs, lows, crosses, hLines, trends,
  });
}

async function refreshAll() {
  if (busy) return;
  busy = true;
  try {
    await loadIndices();

    // 목표가 "통과" 판정을 위해 갱신 전 가격을 기억해 둔다
    const prevPrices = {};
    for (const i of state.watchlist) prevPrices[i.symbol] = quotes[i.symbol] && quotes[i.symbol].price;

    // 실시간 현재가는 한 번에 (요청 1건), 일봉은 rate limit 고려해 종목별 순차
    const liveMap = await fetchLive(state.watchlist.map((i) => i.symbol));
    for (const item of state.watchlist) {
      await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
      renderList();
    }
    checkAlerts(prevPrices);
    err(quoteErrText());
    renderDetail();
    await renderFolio();
    await loadChart();

    renderUpdated();
  } finally {
    busy = false;
    lastRefreshAt = Date.now(); // 실패로 끝나도 센다 — 실패할 때 더 두드리지 않게
  }
}

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
});

async function select(symbol) {
  if (symbol !== state.selected) zoom = null; // 다른 종목에 같은 날짜 구간은 뜻이 없다
  state.selected = symbol;
  save();
  renderList();
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

  // 원래 자리에 다시 끼워 넣는다 (그 사이 목록이 짧아졌으면 끝에)
  state.watchlist.splice(Math.min(s.index, state.watchlist.length), 0, s.item);
  if (s.target) state.alerts.targets[s.item.symbol] = s.target;
  if (s.holding) state.holdings[s.item.symbol] = s.holding;
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
    zoom = null; // 다른 종목으로 넘어간다 — select() 를 거치지 않으므로 여기서 푼다
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

    state.watchlist.push({ symbol: item.symbol, name: item.name });
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
  const next = cur < 0 ? list[0] : list[(cur + step + list.length) % list.length];
  select(next.symbol).then(() => {
    const row = document.querySelector('#list .row.on');
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
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

  const tabs = Object.keys(TF); // 1~5 → 1D · 1W · 1M · 3M · 1Y
  if (e.key >= '1' && e.key <= String(tabs.length)) {
    const key = tabs[Number(e.key) - 1];
    if (key === state.timeframe) return;
    state.timeframe = key;
    zoom = null; // 다른 기간의 날짜 구간은 뜻이 없다
    save();
    renderTabs();
    loadChart();
    return;
  }

  if (e.key === 'Escape') setCompact(!compact);
});

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

// --- 검색 -------------------------------------------------------------------------
const searchEl = document.getElementById('search');
const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const hintEl = document.getElementById('qhint');
const alertsEl = document.getElementById('alerts');
let searchSeq = 0;
let searchTimer = null;
let expandedForPanel = false; // 접힌 상태에서 패널을 보려고 펼친 것인지 (닫을 때 되접기)

// 검색·알림 패널은 접힌 상태에서 열면 잠깐 펼쳤다가, 모두 닫히면 다시 접는다
function openPanel(el) {
  if (compact) { setCompact(false); expandedForPanel = true; }
  searchEl.hidden = true;
  alertsEl.hidden = true;
  el.hidden = false;
}

function closePanel(el) {
  el.hidden = true;
  if (expandedForPanel && searchEl.hidden && alertsEl.hidden) {
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

// --- 테마 -------------------------------------------------------------------------
// 색은 CSS 변수라 data-theme 만 바꾸면 화면은 즉시 따라온다.
// 차트는 그릴 때 값을 읽어가므로 한 번 다시 그려준다(네트워크 재요청 없음).
function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  for (const b of document.querySelectorAll('#themeSeg button')) {
    b.classList.toggle('on', b.dataset.theme === state.theme);
  }
  if (lastChart) drawChart(lastChart);
  renderList();
  renderDetail();
  renderMaChips(); // 칩 색도 테마를 따라간다
}

// 평소(마우스가 벗어났을 때) 불투명도. preview=true 면 hover 중에도 그 값으로 보여준다.
let previewTimer = null;
function applyOpacity(pct, preview = false) {
  const v = Math.min(100, Math.max(30, Number(pct) || 74));
  state.opacity = v;
  document.documentElement.style.setProperty('--idle-opacity', String(v / 100));
  document.getElementById('opacityVal').textContent = `${v}%`;
  document.getElementById('opacity').value = String(v);

  if (!preview) return;
  // 조절하는 동안에는 마우스가 위젯 위에 있어 hover 로 또렷해진다.
  // 잠깐 hover 를 무시해 실제 진하기를 보여주고, 손을 떼면 원래대로.
  const w = document.querySelector('.widget');
  w.classList.add('preview');
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => w.classList.remove('preview'), 900);
}

// 표시할 이동평균 기간 선택. 켜진 칩은 실제 선 색을 그대로 띠어 차트와 대조하기 쉽다.
function renderMaChips() {
  const box = document.getElementById('maChips');
  box.innerHTML = '';

  for (const p of MA_PERIODS) {
    const on = state.maPeriods.includes(p);
    const fits = maFits(p);
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(p);
    b.title = fits
      ? `${p}일 이동평균`
      : `${p}일 이동평균 — ${state.timeframe} 구간에는 너무 길어 지금은 그리지 않습니다`;
    if (on) {
      const c = maColor(p);
      b.className = fits ? 'on' : 'on off';
      b.style.color = c;
      b.style.borderColor = c;
      b.style.background = hexA(c, 0.14);
    } else if (!fits) {
      b.className = 'off';
    }
    b.onclick = () => {
      state.maPeriods = on
        ? state.maPeriods.filter((x) => x !== p)
        : [...state.maPeriods, p].sort((x, y) => x - y);
      save();
      renderMaChips();
      loadChart();
    };
    box.appendChild(b);
  }
  renderMaStyleRows();
}

// 켜 둔 이동평균선마다 색 · 굵기 한 줄. 끈 선은 바꿀 이유가 없어 보이지 않는다.
// 움직이는 동안은 이미 받은 데이터로 다시 그리기만 하고(테마 변경과 같은 경로, 네트워크
// 없음), 손을 뗄 때 한 번 저장한다. 끄는 도중에 이 줄들을 다시 만들면 슬라이더가 끊기므로
// 칩과 줄은 손을 뗀 뒤에만 다시 그린다.
function renderMaStyleRows() {
  const box = document.getElementById('maStyles');
  box.innerHTML = '';
  for (const p of state.maPeriods) {
    const row = document.createElement('div');
    row.className = 'marow';

    const name = document.createElement('span');
    name.className = 'maname';
    name.textContent = `${p}일`;
    name.style.color = maColor(p);

    const color = document.createElement('input');
    color.type = 'color';
    color.value = maColor(p);
    color.title = `${p}일선 색`;

    const width = document.createElement('input');
    width.type = 'range';
    width.min = String(MA_WIDTH_MIN);
    width.max = String(MA_WIDTH_MAX);
    width.step = '0.1';
    width.value = String(maWidth(p));
    width.title = `${p}일선 굵기`;

    // 굵기 숫자는 눌러서 직접 고친다. Enter · 다른 곳 클릭으로 확정, Esc 는 취소.
    // 범위 밖이면 끝값으로 조이고, 숫자가 아니면 원래 값으로 돌린다.
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'mawidth';
    num.min = String(MA_WIDTH_MIN);
    num.max = String(MA_WIDTH_MAX);
    num.step = '0.1';
    num.value = maWidth(p).toFixed(1);
    num.title = `${p}일선 굵기 — 눌러서 직접 입력 (${MA_WIDTH_MIN}~${MA_WIDTH_MAX}px)`;
    const unit = document.createElement('span');
    unit.className = 'maunit';
    unit.textContent = 'px';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '↺';
    reset.title = '기본 색 · 굵기로';
    reset.disabled = !state.maStyles[p];

    const set = (patch, done) => {
      state.maStyles = { ...state.maStyles, [p]: { ...state.maStyles[p], ...patch } };
      name.style.color = maColor(p);
      num.value = maWidth(p).toFixed(1);
      width.value = String(maWidth(p));
      reset.disabled = false;
      if (lastChart) drawChart(lastChart);
      if (done) { save(); renderMaChips(); }
    };
    color.oninput = () => set({ color: color.value }, false);
    color.onchange = () => set({ color: color.value }, true);
    width.oninput = () => set({ width: Number(width.value) }, false);
    width.onchange = () => set({ width: Number(width.value) }, true);
    num.onchange = () => {
      const v = Number(num.value);
      if (num.value.trim() === '' || !Number.isFinite(v)) { num.value = maWidth(p).toFixed(1); return; }
      const w = Math.round(Math.min(MA_WIDTH_MAX, Math.max(MA_WIDTH_MIN, v)) * 10) / 10;
      set({ width: w }, true);
    };
    num.onkeydown = (e) => {
      if (e.key === 'Enter') num.blur(); // blur 가 change 를 부른다
      if (e.key === 'Escape') {
        e.stopPropagation(); // 위젯 접기(Esc)로 번지지 않게
        num.value = maWidth(p).toFixed(1);
        num.blur();
      }
    };
    reset.onclick = () => {
      const { [p]: _gone, ...rest } = state.maStyles;
      state.maStyles = rest;
      save();
      renderMaChips();
      if (lastChart) drawChart(lastChart);
    };

    row.append(name, color, width, num, unit, reset);
    box.appendChild(row);
  }
}

// --- 목표가 알림 -------------------------------------------------------------------
// 알림은 기본 꺼짐. 사용자가 "알림 사용"을 켜야만 실제로 알린다.
function openAlerts() {
  openPanel(alertsEl);
  renderAlerts();
  renderMaChips();
}

const closeAlerts = () => closePanel(alertsEl);

function renderAlerts() {
  const on = state.alerts.enabled;
  document.getElementById('alertOn').checked = on;
  alertsEl.classList.toggle('off', !on);
  document.getElementById('alertHint').textContent = on
    ? '장중에 목표가를 통과하면 알립니다 (통과 시 1회)'
    : '알림이 꺼져 있습니다. 위 "사용"을 켜야 동작합니다.';

  const alertBox = document.getElementById('alertRows');
  const holdBox = document.getElementById('holdRows');
  alertBox.innerHTML = '';
  holdBox.innerHTML = '';

  if (!state.watchlist.length) {
    alertBox.innerHTML = '<div class="empty">관심종목이 없습니다.</div>';
    return;
  }

  // 두 섹션 모두 "종목명 + 숫자 입력 2칸" 형태라 한 함수로 만든다.
  const buildRow = (item, fields, onSave) => {
    const row = document.createElement('div');
    row.className = 'arow';
    row.innerHTML = `<span class="aname">${esc(item.name)}</span>`
      + fields.map((f) => `<input class="${f.cls}" type="number" placeholder="${f.ph}"`
        + ` value="${f.value != null ? f.value : ''}" />`).join('');
    for (const f of fields) row.querySelector(`.${f.cls}`).onchange = onSave(row);
    return row;
  };

  for (const item of state.watchlist) {
    const t = state.alerts.targets[item.symbol] || {};
    alertBox.appendChild(buildRow(item, [
      { cls: 'up', ph: '상한', value: t.up },
      { cls: 'dn', ph: '하한', value: t.down },
    ], (row) => () => {
      const up = parseFloat(row.querySelector('.up').value);
      const down = parseFloat(row.querySelector('.dn').value);
      const next = {};
      if (Number.isFinite(up)) next.up = up;
      if (Number.isFinite(down)) next.down = down;
      if (Object.keys(next).length) state.alerts.targets[item.symbol] = next;
      else delete state.alerts.targets[item.symbol];
      save();
    }));

    const h = state.holdings[item.symbol] || {};
    holdBox.appendChild(buildRow(item, [
      { cls: 'qty', ph: '수량', value: h.qty },
      { cls: 'avg', ph: '평단가', value: h.avg },
    ], (row) => () => {
      const qty = parseFloat(row.querySelector('.qty').value);
      const avg = parseFloat(row.querySelector('.avg').value);
      // 수량과 평단가가 모두 있어야 평가손익을 낼 수 있다
      if (Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0) {
        state.holdings[item.symbol] = { qty, avg };
      } else {
        delete state.holdings[item.symbol];
      }
      save();
      renderDetail();
      renderFolio().catch(console.error); // 동기 콜백이라 await 할 수 없다
    }));
  }
}

// 목표가 "통과" 시에만 알린다. 이전 가격이 없는 첫 갱신은 기준만 잡고 넘어가므로
// 앱을 켜자마자 이미 목표가를 넘긴 종목이 무더기로 울리지 않는다.
function checkAlerts(prevPrices) {
  if (!state.alerts.enabled || !marketOpen) return;

  for (const item of state.watchlist) {
    const t = state.alerts.targets[item.symbol];
    const q = quotes[item.symbol];
    const prev = prevPrices[item.symbol];
    if (!t || !q || q.error || prev == null) continue;
    // 세션 정보가 전혀 없는 기존 가격 전용 테스트/호출은 그대로 지원한다.
    const hasSession = q.isTrading !== undefined || q.session !== undefined || q.open !== undefined;
    if (isDomestic(item.symbol) && hasSession && tradingState(q) !== true) continue;

    if (t.up != null && prev < t.up && q.price >= t.up) {
      api.notify({ title: `${item.name} 상한 도달`, body: `${fmt(q.price)}원 (목표 ${fmt(t.up)}원)` });
    }
    if (t.down != null && prev > t.down && q.price <= t.down) {
      api.notify({ title: `${item.name} 하한 도달`, body: `${fmt(q.price)}원 (목표 ${fmt(t.down)}원)` });
    }
  }
}

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
    zoomDrag = { a: i, b: i, key: dragKey() };
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
  window.addEventListener('mouseup', () => {
    if (!zoomDrag) return;
    const r = zoomDrag.key === dragKey() ? dragToRange(zoomDrag.a, zoomDrag.b) : null;
    zoomDrag = null;
    if (!r || !lastChart) { // 5봉 미만(클릭 · 도로 좁혀 취소)이거나, 끄는 도중 종목 · 기간이 바뀐 것
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
      zoom = null; // 다른 기간의 날짜 구간은 뜻이 없다
      save();
      renderTabs();
      await loadChart();
    };
    box.appendChild(b);
  }
}

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
  document.getElementById('dock').onclick = () => {
    // 패널이 열린 채로 직접 접기를 누르면 패널만 닫고, 복귀 예약은 취소한다
    if (!searchEl.hidden || !alertsEl.hidden) {
      expandedForPanel = false;
      closeSearch();
      closeAlerts();
    }
    setCompact(!compact);
  };

  document.getElementById('min').onclick = () => api.minimizeWindow();
  document.getElementById('close').onclick = () => api.closeWindow();
  document.getElementById('refresh').onclick = refreshNow;
  document.getElementById('undoBtn').onclick = () => undoRemove();

  document.getElementById('add').onclick = () => (searchEl.hidden ? openSearch() : closeSearch());
  document.getElementById('qclose').onclick = closeSearch;

  document.getElementById('bell').onclick = () => (alertsEl.hidden ? openAlerts() : closeAlerts());
  document.getElementById('alertClose').onclick = closeAlerts;
  for (const b of document.querySelectorAll('#themeSeg button')) {
    b.onclick = () => { applyTheme(b.dataset.theme); save(); };
  }
  const opEl = document.getElementById('opacity');
  opEl.oninput = () => applyOpacity(opEl.value, true); // 끄는 동안 미리보기
  opEl.onchange = () => save();                       // 손을 뗄 때만 저장
  document.getElementById('alertOn').onchange = (e) => {
    state.alerts.enabled = e.target.checked;
    save();
    renderAlerts();
  };
  alertsEl.onkeydown = (e) => { if (e.key === 'Escape') closeAlerts(); };
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
  if (!state.alerts) state.alerts = { enabled: false, targets: {} };
  if (!state.alerts.targets) state.alerts.targets = {};
  if (!state.holdings) state.holdings = {};
  // 저장된 값에 모르는 기간이 섞여 있으면 걸러낸다
  state.maPeriods = Array.isArray(state.maPeriods)
    ? state.maPeriods.filter((p) => MA_PERIODS.includes(p)).sort((a, b) => a - b)
    : [5, 20, 60];
  // 저장값에 없거나 모르는 값이면 캔들로 시작한다
  state.chartMode = state.chartMode === 'line' ? 'line' : 'candle';
  // 이동평균 색 · 굵기 — 잘못된 값은 버리고 기본으로 그린다(applyTheme 가 칩을 그리기 전에)
  state.maStyles = cleanMaStyles(state.maStyles);
  applyTheme(state.theme);
  applyOpacity(state.opacity);
  renderMaChips();
  if (!state.watchlist.some((i) => i.symbol === state.selected)) {
    // 관심종목이 비어 있으면 undefined 가 되는데, 그대로 저장하면 electron-store 가 거부한다
    state.selected = (state.watchlist[0] && state.watchlist[0].symbol) || null;
  }

  document.getElementById('chartMode').onclick = async () => {
    state.chartMode = state.chartMode === 'candle' ? 'line' : 'candle';
    save();
    await loadChart(); // 서명에 chartMode 가 있어 다시 그려지고, drawChart 가 아이콘도 바꾼다
  };
  document.getElementById('zoomReset').onclick = resetZoom;
  bindZoom();
  renderTabs();
  renderList();
  renderDetail();

  // 장 마감 후에는 값이 바뀌지 않으므로 폴링 간격을 늘린다 (밤새 켜둬도 요청이 거의 없음).
  // 완전히 멈추면 개장을 감지하지 못하므로 5분마다 한 번은 확인한다.
  await pollTick();
})();
