// renderer/detail.js — 상세 — 업종 · 장 상태 · 이름 · 가격 · 갱신 시각.

// --- 업종 -----------------------------------------------------------------------
// 네이버 한글 업종(국내 업종 · 해외 업종)을 먼저 쓰고, 네이버에 없으면 야후 영어 업종이다
// (main.js yf:sector). 야후만 쓸 때는 영어였고 21/99종목이 비어 있었다.
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

// 업종별로 묶어 보려면(설정의 묶기 '업종별', shownList) 관심종목 모두의 업종이 있어야 한다 — 평소에는 고른 종목 것만 받는다.
// 아직 없는 것만 차례로 받고(한꺼번에 몰아 묻지 않게) 다 받으면 목록을 다시 그린다. 그동안은 '기타' 묶음에 있다.
// 실패는 기억하지 않아(sectorFor) 다음에 업종별을 누르거나 앱을 켤 때 다시 묻는다.
let sectorsLoading = false;
async function loadSectors() {
  if (sectorsLoading) return;
  sectorsLoading = true;
  try {
    for (const i of state.watchlist.filter((x) => !sectors.has(x.symbol))) await sectorFor(i.symbol).catch(() => null);
  } finally {
    sectorsLoading = false;
  }
  renderList();
}

// 종목명 옆 회색 업종. 조회가 늦게 와도 그 사이 다른 종목을 고르면 버린다.
async function loadSector(item) {
  const el = document.getElementById('dsector');
  const name = await sectorFor(item.symbol);
  if (state.listGroup === 'sector') renderList(); // 업종별로 묶어 보는 중이면 새로 안 업종의 묶음으로(새로 넣은 종목)
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

// 검색이 국내와 미국만 보이므로 국내도 지수도 아니면 미국 종목이다.
function isUs(symbol) {
  return !isDomestic(symbol) && !isIndex(symbol);
}

// 미국 종목과 미국 지수 · 환율. 야후 시세가 늦지 않고, 하루가 한국 날짜와 다르다 —
// 20분지연 표시 · 일봉 맞추기 · 1D 끝점 맞추기를 하지 않고, 날짜는 UTC(뉴욕)로 센다.
function isOverseas(symbol) {
  return isUs(symbol) || INDICES.some((i) => i.symbol === symbol && i.overseas);
}

function pollingIsOpen(symbols, liveMap) {
  // 국내 · 미국 모두 네이버 실시간의 거래 상태를 본다. 하나라도 거래 중이거나 응답이 비었으면
  // (실패 · 네이버에 없는 미국 종목) 짧은 간격으로 재확인한다.
  return !symbols.length || symbols.some((symbol) =>
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
  const fallback = q && !q.error && q.price != null && q.live === false;
  // 야후는 국내 종목 · 지수만 20분 늦다. 미국 종목은 늦지 않지만 정규장 가격뿐이라 세션을 모른다.
  const delayed = fallback && !isOverseas(state.selected);
  // 야후까지 실패해 캐시 값을 보이는 중이면 시각은 실제로 받은 때다(fetchedAt) — 지금 시각을 붙이면
  // 몇 시간 묵은 가격이 정상적인 20분 지연 시세처럼 보인다.
  const stale = fallback && q.stale;
  // 선물 · 유가(지수 줄)는 거래소가 늦게 준다(INDICES 의 delayMin) — 거래 중에 정규장 · 실시간으로 보이지 않게
  const lag = q && q.live && session === 'regular' ? INDICES.find((i) => i.symbol === state.selected)?.delayMin : null;
  el.innerHTML = `<span class="${q && q.live && !lag ? SESSION_CLASS[session] : 'delay'}">`
    + `${stale ? '갱신 실패' : q && q.error ? '조회 실패' : lag ? `${lag}분지연` : delayed ? '20분지연' : SESSION_TEXT[session]}</span> ${time}`;
  const source = q && !q.error && q.price != null
    ? `${q.live ? (lag ? `${lag}분 지연` : '실시간') : stale ? '마지막으로 받은 값' : delayed ? '20분지연' : '정규장 가격'}`
      + ` · ${q.source || (q.live ? 'Naver' : 'Yahoo')}`
    : '확인 불가';
  el.title = `소스: ${source}${q && q.market ? ` · ${q.market}` : ''}`
    + `\n세션: ${SESSION_TEXT[session]}`
    + `\n조회 완료: ${validFetched ? fetched.toISOString() : '확인 불가'}`
    + `\n시세 시각: ${q && q.tradedAt || '확인 불가'}`;
}

function renderDetail() {
  renderUpdated();
  const item = selectedItem(); // 관심종목 또는 지수
  const q = item && quotes[item.symbol];

  const cur = item ? curOf(item.symbol) : 'KRW';
  document.getElementById('dprice').textContent = money(q && q.price, cur);
  document.getElementById('dcandle').innerHTML = candleTag(q, cur);
  // 원화가 아니면 어느 통화인지 이름 옆에 표시
  document.getElementById('dname').textContent = item
    ? (cur === 'KRW' || cur === 'pt' ? item.name : `${item.name} (${cur})`) : '—';

  // 업종은 네트워크를 타므로 종목이 바뀌면 일단 비우고 채워 넣는다.
  // 이전 종목의 업종이 새 종목 이름 옆에 잠깐 남으면 잘못된 정보가 된다.
  const secEl = document.getElementById('dsector');
  const cached = item && sectors.get(item.symbol);
  secEl.textContent = cached || '';
  // 지수는 업종이 없다
  if (item && !isIndex(item.symbol) && !sectors.has(item.symbol)) loadSector(item).catch(console.error);
  // 국내 종목의 시장 — 업종 오른쪽(2026-11-18 사용자 요청). 야후 기호 끝으로 안다(.KS 코스피 · .KQ 코스닥 — 검색 결과의 표시와 같은 규칙)
  const venue = item && /\.(KS|KQ)$/i.exec(item.symbol);
  document.getElementById('dmarket').textContent = venue ? (venue[1].toUpperCase() === 'KQ' ? '코스닥' : '코스피') : '';

  const chgEl = document.getElementById('dchg');
  const badge = document.getElementById('badge');

  if (q && q.change != null) {
    chgEl.style.color = plColor(q.change);
    chgEl.innerHTML = `${cur === '%' ? fmtBp(q.change) : signedMoney(q.change, cur)}<br>${fmtPct(q.pct)}`; // 금리는 bp
  } else {
    chgEl.textContent = '';
  }

  // 시간외(장후)에는 정규장 종가 대비 이동폭을 한 줄 더 붙인다. 위 두 줄은 전일
  // 종가 기준이라(네이버가 주는 기준) 시간외에서 얼마나 움직였는지는 안 보인다.
  // main.js 가 장후 가격과 검증된 당일 종가가 있을 때만 채운다 (종료 후에도 유지).
  const closeEl = document.getElementById('dclose');
  closeEl.hidden = !(q && q.fromClose != null);
  closeEl.textContent = q && q.fromClose != null ? `종가대비 ${signedMoney(q.fromClose, cur)}` : '';

  document.getElementById('infoToggle').hidden = !item; // 고른 것이 없으면 접을 것도 없다
  renderHolding(item && item.symbol, q && q.price);
  renderW52(q && q.week52Low, q && q.week52High, q && q.price, cur);
  renderTrendCheck(item);
  infoTip(); // 접혀 있으면 위 세 줄의 새 내용을 손잡이 툴팁에 옮긴다

  const lv = levelOf(q && q.rsi);
  badge.textContent = q && q.rsi != null ? `${lv.label} · RSI ${q.rsi.toFixed(0)}` : 'RSI —';
  // 툴팁에 일봉 · 주봉 RSI 를 함께 — 주봉은 이번 주가 진행 중인 값이다(최근 상장이라 15주가 안 되면 없다)
  // 툴팁 문체(2026-11-02): 값 / RSI 뜻 / 단계 — 검증 — 기준
  badge.title = q && q.rsi != null
    ? `일봉 RSI ${q.rsi.toFixed(1)}${q.rsiWeek != null ? ` · 주봉 RSI ${q.rsiWeek.toFixed(1)} (이번 주 진행 중)` : ''}\n`
      + 'RSI = 최근 14거래일 오른 폭과 내린 폭의 비율(0~100)\n'
      + '과열도(일봉 RSI): 30 미만 과매도 · 30~70 보통 · 70 이상 과열\n\n'
      + `${RSI_EVIDENCE}\n\n`
      + `기준: 15:30 정규장 종가 (${q.rsiWeek != null ? '오늘 · 이번 주는' : '오늘은'} 지금 가격)`
    : '';
  badge.style.color = lv.color;
  badge.style.background = q && q.rsi != null ? hexA(lv.color, 0.16) : cssVar('--chip');
  renderMetrics(); // 지표 보기가 열려 있으면 고른 종목 것으로(1분이 지났으면 다시 받는다)
}

