// renderer.js — UI 렌더링, Chart.js 그리기, 30초 폴링.
// 네트워크는 전부 window.api.fetchChart(preload → 메인 프로세스)를 통해서만 나간다.

const UP = '#e24b4a';   // 상승 = 빨강 (한국 관례)
const DOWN = '#185fa5'; // 하락 = 파랑

const TF = {
  // 1D 는 시간외(프리 · 애프터) 봉까지 받는다 — 미국은 야후, 국내는 네이버 NXT 분봉(main.js).
  '1D': { range: '1d', interval: '5m', extended: true },
  '1W': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  // 야후에는 3년 구간이 없다 — 5년치를 받아 loadChart 가 최근 3년만 남긴다(lastYears).
  '3Y': { range: '5y', interval: '1d', years: 3 },
  // 처음부터 끝까지. 봉 크기는 야후가 기간에 따라 고른다(삼성전자 · 코스피 월봉, 최근 상장주 주봉,
  // AAPL 분기봉 — 2026-10-14 실측). 일봉이 아니라 이동평균 · 골든/데드 · 추세선 · 확대는 없다.
  '전체': { range: 'max', interval: '1mo' },
};

// 축 라벨을 연/월(YY/MM)로 쓰는 기간. 툴팁 제목에는 일까지 붙이고, 확대하면 월/일로 쓴다.
const YEAR_TF = new Set(['1Y', '3Y', '전체']);

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

// 보조 지표(설정의 칩, state.indicators). 기본은 모두 꺼짐. varName 은 선 색이자 켜진 칩의 색이다.
const INDICATORS = [
  { key: 'bb', label: '볼린저', varName: '--bb-line', title: '볼린저 밴드 — 20일 평균 ± 2표준편차 (1M · 3M · 1Y · 3Y)' },
  { key: 'vwap', label: 'VWAP', varName: '--vwap-line', title: '거래량 가중 평균가 — 그날 정규장 봉만 (1D)' },
  { key: 'volAvg', label: '거래량 평균', varName: '--vol-avg', title: '거래량 20봉 평균선 · 평균의 2배 넘는 막대 강조 (모든 기간)' },
  { key: 'prevHL', label: '전일 고저', varName: '--prev-line', title: '어제 고가 · 저가 점선 (1D)' },
  { key: 'vp', label: '매물대', varName: '--vp-poc', title: '가격대별 거래량 — 차트 오른쪽 가로 막대, 가장 많이 거래된 가격대는 진하게 (1M · 3M · 1Y · 3Y)' },
  { key: 'rel', label: '지수 대비', varName: '--accent', title: '기간 수익률에서 같은 기간 지수 수익률을 뺀 초과 수익(%p) — 코스피 · 코스닥 · S&P 500 (1M 이상)' },
  { key: 'sar', label: 'SAR', varName: '--sar-up', title: '파라볼릭 SAR — 상승 추세면 봉 아래, 하락 추세면 봉 위에 점. 범례에 지금 방향과 전환 뒤 기간 (1D · 1W · 1M · 3M · 1Y · 3Y)' },
];
const VP_BINS = 20;   // 매물대 가격 칸 수 — 150px 차트에서 한 칸 약 7px
const BB_PERIOD = 20;
const BB_K = 2;
const VOL_AVG = 20;   // 거래량 평균 봉 수
const VOL_SURGE = 2;  // 평균의 몇 배부터 막대를 진하게 칠하나
const SAR_STEP = 0.02; // 파라볼릭 SAR 가속 — 흔한 기본값(와일더)
const SAR_MAX = 0.2;
// 저장된 값을 믿지 않는다 — 아는 키만, true 일 때만 켠다.
const cleanIndicators = (raw) => Object.fromEntries(INDICATORS.map(({ key }) => [key, !!raw && raw[key] === true]));

// 골든/데드크로스를 볼 이동평균 조합.
// 60/80 처럼 가까운 기간끼리는 횡보 구간에서 계속 교차해 신호 가치가 없어 넣지 않는다.
const CROSS_PAIRS = [[5, 20], [20, 60]];
let chartBars = 0; // 현재 차트의 봉 수. 0이면 이동평균을 안 그리는 타임프레임(1D/1W)
// 끌어서 고른 확대 구간 { start, end } — 봉 시각(ms). 번호가 아니라 날짜로 기억해
// 30초 갱신 · 다음 날 새 봉에도 같은 구간이 잡힌다. 3M · 1Y · 3Y 에서만, 저장하지 않는다.
// loadChart 의 서명이 읽으므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
let zoom = null;
// 기간별로 기억해 둔 확대 구간. 1D 를 잠깐 보고 3M 으로 돌아오면 그 구간을 되살린다.
// zoom 은 지금 기간의 것이고, 기간을 떠날 때 여기에 넣어 둔다(setTimeframe).
const zoomByTf = {};
const maFits = (p) => chartBars > 0 && p <= chartBars * MA_SPAN;

// RSI·이동평균 계산용 일봉 시리즈.
// 1Y 차트(243봉)에 MA360 을 끝까지 그리려면 앞으로 360봉이 더 필요해 총 603봉 이상이어야 한다.
// 1년치(243) · 2년치(484) 로는 모자라 5년치(약 1219봉)를 받는다.
const DAILY = { range: '5y', interval: '1d' };

// 5년치는 응답이 커서(종목당 약 80KB) 30초마다 받으면 낭비다.
// 일봉은 장중에 마지막 봉만 움직이므로 캐시하고 가끔만 다시 받는다.
// 현재가는 실시간(네이버)에서 따로 오므로 화면은 30초마다 그대로 갱신된다.
const DAILY_TTL = 30 * 60 * 1000;
const dailyCache = {}; // symbol -> { at, price, closes, times, currency, week52High, week52Low, retryAt? }
// 추세 점검 결과 — symbol -> { key, result }. 5년치를 수백 번 다시 돌리는 계산이라(종목당 약 50ms)
// 30초 갱신마다 하지 않고, 계산에 쓰는 마지막 확정 봉이 바뀔 때만 다시 한다(renderTrendCheck).
const trendCache = {};
// 보유 화면 상태. renderHolding · renderFolio 가 읽으므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
let holdEdit = null;      // 상세에서 입력 중인 보유 { symbol, qty, avg, msg } — 입력 칸의 글자 그대로
let holdFormFor = null;   // 입력 칸을 그려 둔 종목. 30초 갱신이 칸을 다시 그려 치던 값을 지우지 않게
let folioView = [];       // 합계 줄에 차례로 보일 줄(HTML). 보유가 둘 이상이면 첫 줄이 합계
let folioAt = 0;          // 지금 보이는 차례
let folioHover = false;   // 마우스가 올라가 있으면 넘기지 않는다
// 일봉을 받지 못한 종목이 다시 받기까지 쉬는 시간. main.js 의 CLOSE_RETRY 와 같다.
// 쉬지 않으면 야후가 바로 거절(429)할 때 30초마다 전 종목 5년치를 다시 보낸다.
const DAILY_RETRY = 5 * 60 * 1000;
// 갱신 한 차례(refreshAll)에 일봉이 하나라도 실패하면 캐시가 있는 나머지는 그 차례를 건너뛴다.
// 야후가 응답을 멈추면 종목마다 8초씩(FETCH_TIMEOUT) 기다려 갱신 한 번이 1분을 넘기고,
// 그동안 ↻ 도 먹지 않는다 — 한 차례에 한 번만 기다린다.
let dailyRound = 0;
let dailyFailRound = -1;

// 야후 한국 시세가 늦게 오는 분. 실측에서 세 종목 모두 기준 시각이 정확히 20분 전이었다
// (docs/DEVELOPMENT.md "왜 나눠 쓰는가"). 그래서 분봉은 개장 20분 뒤부터 들어온다.
const YAHOO_KR_DELAY_MIN = 20;

// 상단 지수 줄. 누르면 관심종목처럼 "선택"되어 헤더 · 차트가 지수로 바뀐다.
// 기호는 야후 것이다(차트 · 일봉을 야후에서 받는다). code 는 main.js quote:indices 의 code.
// page 가 같은 것끼리 한 장 — 다섯 개는 340px 한 줄에 들어가지 않아 장을 넘긴다(국내 → 미국 → 환율).
// overseas 는 야후 시세가 늦지 않고 하루가 한국 날짜와 다른 것(미국 지수 · 환율) — 미국 종목처럼 다룬다.
// loadChart 가 selectedItem 을 부르므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
const INDICES = [
  { symbol: '^KS11', code: 'KOSPI', name: '코스피', page: 0 },
  { symbol: '^KQ11', code: 'KOSDAQ', name: '코스닥', page: 0 },
  { symbol: '^IXIC', code: 'NASDAQ', name: '나스닥', page: 1, overseas: true },
  { symbol: '^GSPC', code: 'SPX', name: 'S&P 500', page: 1, overseas: true },
  { symbol: 'KRW=X', code: 'USDKRW', name: '원/달러', page: 2, overseas: true },
];

function isIndex(symbol) {
  return INDICES.some((i) => i.symbol === symbol);
}

// 지금 보고 있는 대상 — 관심종목이면 그 항목, 지수면 지수 항목, 둘 다 아니면 null.
function selectedItem() {
  return state.watchlist.find((i) => i.symbol === state.selected)
    || INDICES.find((i) => i.symbol === state.selected) || null;
}

// 네이버 지수 항목 → 종목 실시간 시세(quote-session.cjs normalizeQuote)와 같은 모양.
// loadQuote 에 그대로 넣으면 RSI · 52주 · 이동평균 · 1D 끝점 · 오늘 봉 맞추기가 종목과 똑같이
// 동작한다. 지수에는 프리 · 애프터마켓이 없어 열려 있으면 정규장, 아니면 장마감이다.
// 전일 대비가 없거나, 값 · 전일 종가가 0 이하면(빈 응답이 0 으로 읽힌 것) 실시간 값이 없는
// 것으로 친다 — loadQuote 가 야후 값(20분지연)을 쓴다. 종목 어댑터(candidate)와 같은 검사다.
function indexLive(n) {
  if (!n || !Number.isFinite(n.change) || !(n.value > 0) || !(n.value - n.change > 0)) return undefined;
  const session = n.isOpen ? 'regular' : 'closed';
  return {
    price: n.value,
    prevClose: n.value - n.change,
    change: n.change,
    candle: n.open > 0 ? { open: n.open, high: n.high, low: n.low } : null,
    open: !!n.isOpen,
    session,
    priceSession: session,
    isTrading: !!n.isOpen,
    source: 'Naver',
    tradedAt: n.tradedAt || null,
  };
}

let state = { watchlist: [], selected: null, timeframe: '1D' };
const quotes = {}; // symbol -> { price, prevClose, rsi } | { error }
let dragFrom = null; // 순서 변경 드래그 중인 행 인덱스
let chart = null;
let busy = false;
let lastRefreshAt = 0; // 마지막 갱신이 끝난 시각 — ↻ 연타 제한에 쓴다
let chartSeq = 0; // 차트 요청 순번 — 응답이 역순으로 도착해도 마지막 것만 반영
let drawnKey = null; // 지금 그려진 차트의 '종목|기간'. 없으면 null
let isLive = false;      // 마지막 갱신이 실시간 시세였는지 (실패 시 Yahoo 20분 지연)
// 전체 관심종목의 거래 상태는 폴링/알림에 쓴다. 헤더는 선택 종목의 상태를 쓴다.
let marketOpen = true;
// 목표가 "통과" 판정의 기준 — 종목마다 직전에 알림 판정을 받은 가격(checkAlerts).
// 화면 가격(quotes)을 기준으로 쓰면 네이버가 한 번 실패한 사이 뜬 야후 지연가 — 국내 종목은
// 그 가격으로 판정하지 않는다 — 가 다음 갱신의 "직전 가격" 이 되어 같은 통과를 두 번
// 알리거나(100,500 → 지연 99,800 → 100,600) 놓친다(99,900 → 지연 100,200 → 100,300).
const alertBase = {};
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

// 해외 종목은 통화가 다르다. 원화는 정수, 그 외(USD 등)는 소수 2자리로 보여준다.
// 지수는 통화가 아니라 포인트다. money 는 원화가 아니면 소수 둘째 자리로 쓰므로 'pt' 를 주면
// 헤더 · 오늘 캔들 안내 · 52주 · 차트 축 · 툴팁이 상단 지수 줄처럼 7,003.74 로 나온다.
const curOf = (symbol) => (isIndex(symbol) ? 'pt' : (quotes[symbol] && quotes[symbol].currency) || 'KRW');
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
  // 1Y · 3Y 는 MM/DD로 쓰면 양 끝이 같은 날짜로 보여 1년 구간이 구분되지 않는다
  if (YEAR_TF.has(timeframe)) return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}`;
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
      <span class="nm"><span class="name">${esc(item.name)}</span>${holdSub(item.symbol)}</span>
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

// --- 지수 줄 ---------------------------------------------------------------------
// 개별 종목이 빠질 때 시장 전체 흐름인지 바로 알 수 있게 한 줄로 보여준다.
// 누르면 그 지수를 관심종목처럼 고른다(select) — 헤더 · 차트가 지수로 바뀐다.
// 다섯 개(코스피 · 코스닥 · 나스닥 · S&P 500 · 원/달러)는 한 줄에 들어가지 않아 장(INDICES 의 page)을
// 보유 합계 줄처럼 FOLIO_MS 마다 넘긴다. 마우스를 올리면 멈추고, 보고 있는 지수가 있으면 그 장에 머문다.
let indexItems = []; // 마지막으로 받은 지수 항목 — 선택만 바뀔 때 강조를 다시 그리는 데 쓴다
let indexPage = 0;   // 지금 보이는 장(indexPages 의 번호)
let indexHover = false;

async function loadIndices() {
  const r = await api.indices();
  indexItems = r.ok ? r.items : []; // 실패하면 조용히 숨긴다(핵심 기능이 아님)
  renderIndices();
  return indexItems;
}

// 받은 항목을 장으로 — INDICES 순서대로, 항목이 하나도 없는 장은 뺀다. 모르는 지수는 보이지 않는다.
function indexPages() {
  const pages = [];
  for (const ix of INDICES) {
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
  if (shown >= 0) indexPage = shown; // 보고 있는 지수의 장
  indexPage %= pages.length;
  box.innerHTML = `<div class="ixpage${animate ? ' in' : ''}">${pages[indexPage].items.map(({ ix, it }) => {
    const color = it.pct === 0 ? cssVar('--flat') : (it.pct > 0 ? UP : DOWN);
    const cls = ix.symbol === state.selected ? 'ix on' : 'ix';
    return `<span class="${cls}" data-symbol="${ix.symbol}" title="${ix.name} 차트 보기"><span class="ixn">${esc(ix.name)}</span>`
      + `<span class="ixv">${it.value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      + `<span class="ixp" style="color:${color}">${fmtPct(it.pct)}</span></span>`;
  }).join('')}</div>`;
}

// FOLIO_MS 마다 다음 장으로. 한 장뿐이거나, 마우스가 올라가 있거나, 보고 있는 지수가 이 줄에 있으면 그대로.
function tickIndices() {
  const pages = indexPages();
  if (indexHover || pages.length < 2) return;
  if (pages.some((p) => p.items.some(({ ix }) => ix.symbol === state.selected))) return;
  indexPage = (indexPage + 1) % pages.length;
  renderIndices(true);
}

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
function folioLines(held, rate) {
  // 툴팁(title)은 글자 그대로 나오므로 종목명은 HTML 쪽에서만 이스케이프한다
  const line = (name, value, pl, pct, cur) => ({
    html: `<span class="fn">${esc(name)}</span><span class="fv">평가 ${money(value, cur)}</span>`
      + `<span class="fp" style="color:${plColor(pl)}">손익 ${signedMoney(pl, cur)} (${fmtPct(pct)})</span>`,
    text: `${name} · 평가 ${money(value, cur)} · 손익 ${signedMoney(pl, cur)} (${fmtPct(pct)})`,
  });
  const stocks = held.map(({ i, h, q }) => {
    const r = holdingPl(h, q.price);
    return line(`${i.name} ${fmt(h.qty)}주`, r.value, r.pl, r.pct, curOf(i.symbol));
  });
  if (held.length === 1) return { lines: [stocks[0].html], tip: stocks[0].text };

  const total = `보유 ${held.length}종목`;
  const foreign = held.some((x) => curOf(x.i.symbol) !== 'KRW');
  if (foreign && !rate) {
    // 환율을 못 받으면 합계가 틀린 값이 되므로 숫자를 내놓지 않는다
    return { lines: [`<span class="fn">${total}</span><span class="fv">환율을 받지 못해 합계를 낼 수 없습니다</span>`,
      ...stocks.map((s) => s.html)], tip: stocks.map((s) => s.text).join('\n') };
  }
  let value = 0; let cost = 0;
  for (const { i, h, q } of held) {
    const k = curOf(i.symbol) === 'KRW' ? 1 : rate;
    value += q.price * h.qty * k;
    cost += h.avg * h.qty * k;
  }
  const gain = Math.round(value - cost);
  const sum = line(total, Math.round(value), gain, cost > 0 ? ((value - cost) / cost) * 100 : 0, 'KRW');
  return {
    lines: [sum.html, ...stocks.map((s) => s.html)],
    tip: [sum.text, ...stocks.map((s) => s.text),
      ...(foreign ? [`환율 ${fmt(rate)}원/$ (미국 주식은 이 값으로 합계에 넣음)`] : [])].join('\n'),
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
  el.innerHTML = `<span class="${q && q.live ? SESSION_CLASS[session] : 'delay'}">`
    + `${stale ? '갱신 실패' : delayed ? '20분지연' : SESSION_TEXT[session]}</span> ${time}`;
  const source = q && !q.error && q.price != null
    ? `${q.live ? '실시간' : stale ? '마지막으로 받은 값' : delayed ? '20분지연' : '정규장 가격'}`
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

  document.getElementById('infoToggle').hidden = !item; // 고른 것이 없으면 접을 것도 없다
  renderHolding(item && item.symbol, q && q.price);
  renderW52(q && q.week52Low, q && q.week52High, q && q.price, cur);
  renderTrendCheck(item);
  infoTip(); // 접혀 있으면 위 세 줄의 새 내용을 손잡이 툴팁에 옮긴다

  const lv = levelOf(q && q.rsi);
  badge.textContent = q && q.rsi != null ? `${lv.label} · RSI ${q.rsi.toFixed(0)}` : 'RSI —';
  badge.style.color = lv.color;
  badge.style.background = q && q.rsi != null ? hexA(lv.color, 0.16) : cssVar('--chip');
}

// 상세의 보유 자리. 보유 중이면 수량 · 평단 · 평가 · 손익과 고치기(✎), 아니면 "＋ 보유 입력".
// 입력 중이면 수량 · 평단가 칸을 그리고, 30초 갱신은 그 칸을 다시 그리지 않는다(치던 값이 날아간다).
// 버튼 · Enter · Esc 는 init 에서 #hold 에 한 번 단다.
function renderHolding(symbol, price) {
  const el = document.getElementById('hold');
  if (!symbol || isIndex(symbol)) { el.hidden = true; holdFormFor = null; return; } // 지수는 보유할 수 없다
  el.hidden = false;
  if (holdEdit && holdEdit.symbol !== symbol) holdEdit = null; // 다른 종목을 고르면 입력은 취소된다
  if (holdEdit) {
    if (holdFormFor !== symbol) { el.innerHTML = holdForm(); holdFormFor = symbol; }
    return;
  }
  holdFormFor = null;

  const h = state.holdings[symbol];
  if (!h) { el.innerHTML = '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>'; return; }
  const cur = curOf(symbol);
  const r = holdingPl(h, price);
  el.innerHTML = `<span class="hqty">${fmt(h.qty)}주</span><span>평단 ${money(h.avg, cur)}</span>`
    + (r ? `<span>평가 ${money(r.value, cur)}</span>`
      + `<span class="hpl" style="color:${plColor(r.pl)}">${signedMoney(r.pl, cur)} (${fmtPct(r.pct)})</span>` : '')
    + '<button type="button" class="hedit" data-act="edit" title="보유 고치기">✎</button>';
}

// 입력 칸. 값은 holdEdit 의 글자 그대로 — 저장에 실패해 다시 그려도 친 값이 남는다.
function holdForm() {
  const e = holdEdit;
  const input = (cls, ph, v) => `<input class="${cls}" type="text" inputmode="decimal" placeholder="${ph}" value="${esc(v)}" />`;
  return input('hq', '수량', e.qty) + input('ha', '평단가', e.avg)
    + '<button type="button" data-act="save">저장</button><button type="button" data-act="cancel">취소</button>'
    + (state.holdings[e.symbol] ? '<button type="button" data-act="del">삭제</button>' : '')
    + (e.msg ? `<span class="hmsg">${e.msg}</span>` : '');
}

function redrawHolding() {
  const q = quotes[state.selected];
  renderHolding(state.selected, q && q.price);
}

function startHoldEdit(symbol) {
  const h = state.holdings[symbol];
  holdEdit = { symbol, qty: h ? amountText(h.qty) : '', avg: h ? amountText(h.avg) : '', msg: '' };
  holdFormFor = null;
  redrawHolding();
}

// 둘 중 하나라도 비었거나 0 이하면 저장하지 않고 알린다 — 예전에는 말없이 보유가 지워졌다.
function saveHoldEdit(qtyText, avgText) {
  const h = holdingFrom(qtyText, avgText);
  if (!h) {
    holdEdit = { ...holdEdit, qty: qtyText, avg: avgText, msg: '수량과 평단가를 모두 0보다 큰 숫자로 넣어 주세요' };
    holdFormFor = null;
    redrawHolding();
    return;
  }
  const { symbol } = holdEdit;
  holdEdit = null;
  setHolding(symbol, h);
}

function cancelHoldEdit() {
  holdEdit = null;
  redrawHolding();
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

// 추세 점검 — 이평선 규칙을 지난 5년 일봉에 대 본 결과(backtest.js). 기간 탭과 상관없이
// 선택한 종목의 일봉 원본(dailyCache)으로 계산한다. quotes[].daily 는 마지막 봉을 현재가로
// 덮은 사본이라 쓰지 않는다. 계산에 쓰는 마지막 확정 봉(끝에서 두 번째)이 바뀔 때만 다시 계산한다.
function renderTrendCheck(item) {
  const el = document.getElementById('trendCheck');
  const d = item && dailyCache[item.symbol];
  if (!d || !d.closes) { el.hidden = true; return; }
  const n = d.closes.length;
  const key = `${n}:${d.times[n - 2]}`;
  let hit = trendCache[item.symbol];
  if (!hit || hit.key !== key) {
    // 계산이 예외를 내면 줄만 숨긴다 — 그대로 두면 renderDetail 이 여기서 끊겨 합계 줄 · 차트까지 그 갱신에서
    // 빠진다. 실패도 캐시해 같은 확정 봉으로 30초마다 다시 계산하지 않는다(다음 봉에서 다시 해 본다).
    let result = null;
    try {
      result = trendCheck(item.symbol, d.closes, d.times, { domestic: isDomestic(item.symbol), cost: costOf(item.symbol) });
    } catch (err) {
      console.error(err);
    }
    hit = { key, result };
    trendCache[item.symbol] = hit;
  }
  const r = hit.result;
  el.hidden = !r;
  if (!r) return;
  if (r.error) {
    el.textContent = '추세 점검: 데이터 확인 필요';
    el.title = '하루에 35% 넘게 움직인 봉이 있습니다. 국내 가격제한폭(±30%) 밖이라 액면분할 같은 데이터 이상으로 보고\n'
      + '그 뒤만 쓰려 했지만 2년(500봉)이 남지 않아 계산하지 않았습니다.';
    return;
  }
  el.innerHTML = trendCheckText(r);
  el.title = trendCheckTip(r, item.symbol);
}

// 추세 점검의 왕복 비용. 국내 종목은 매도세가 붙어 0.25%, 해외 종목과 지수(ETF 로 따라간다고 본다)는 0.10%.
function costOf(symbol) {
  return isDomestic(symbol) ? 0.0025 : 0.001;
}

function verdictText(v) {
  return { better: '나음', worse: '못함', same: '구분 안 됨', few: '표본 부족' }[v];
}

// 줄 한 줄. 판정 조각만 색을 입힌다 — 나음 빨강, 못함 파랑, 나머지는 줄 색(회색) 그대로.
// 글자는 전부 이 함수가 만든 고정 문구라 innerHTML 로 넣어도 된다.
function trendCheckText(r) {
  const g = r.regime;
  const v = r.rule.verdict;
  const color = v === 'better' ? UP : v === 'worse' ? DOWN : '';
  const regime = `${g.cls === 'up' ? '정배열' : g.cls === 'down' ? '역배열' : '혼조'}·20선${g.up ? '↑' : '↓'}`;
  // "20/60 보유" 는 사용자의 실제 보유(목록 · 상세)와 같은 말이라 선의 위치로 쓴다
  const state = `20선${r.rule.on ? '>' : '<'}60선 ${daysAgo(r.rule.since)}일째`;
  // 실제로 쓴 기간. 5년치를 받아도 60일선이 생기기까지를 빼면 약 4.7년이라 "5년" 이 되고,
  // 상장 2~5년 종목이나 이상 봉 뒤부터 쓴 종목은 그 길이대로 "2년" · "3년" 이 된다.
  const years = Math.round((r.rule.to - r.rule.from) / (365.25 * 86400000));
  return `${regime} · ${state} · ${years}년: <span${color ? ` style="color:${color}"` : ''}>${verdictText(v)}</span>`;
}

// 툴팁. 모든 숫자를 비교 대상(그냥 보유 · 평소)과 우연의 범위(가짜 타이밍 · 가짜 주가) 옆에 둔다.
function trendCheckTip(r, symbol) {
  const p = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  const pp = (x, digits = 1) => (x > 0 ? '+' : '') + (x * 100).toFixed(digits) + '%p';
  const ymd = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const { rule, fast, regime: g } = r;
  const cost = costOf(symbol);
  const lines = [
    '20/60 규칙 — 20일선이 60일선 위면 보유, 아래면 정리',
    `종가로 판단 → 다음 날 종가에 체결 · 왕복 비용 ${(cost * 100).toFixed(2)}%${isIndex(symbol) ? ' (지수는 ETF 로 따라간다고 봄)' : ''}`,
    `기간 ${ymd(rule.from)} ~ ${ymd(rule.to)}${r.cut ? ' (하루 35% 넘게 움직인 봉 뒤부터)' : ''}`,
    `규칙: 누적 ${p(rule.strat.total)} · 연 ${p(rule.strat.cagr)} · 최대 낙폭 ${p(-rule.strat.mdd)} · 보유 ${Math.round(rule.strat.inShare * 100)}%`,
    `그냥 보유: 누적 ${p(rule.hold.total)} · 연 ${p(rule.hold.cagr)} · 최대 낙폭 ${p(-rule.hold.mdd)}`,
  ];
  if (rule.verdict === 'few') {
    lines.push(`진입 ${rule.strat.entries}회 — 적어서 판정하지 않음`);
  } else {
    // 순위는 개수로 보인다 — 백분율("상위 99%")은 반올림 때문에 못함에도 구분 안 됨에도 같은 값이 나왔다
    const edge = Math.floor(rule.count * BT_ROT_EDGE);
    lines.push(
      `시점만 밀어 만든 가짜 타이밍 ${rule.count}개 중 규칙보다 누적이 낮은 것 ${rule.below}개 → ${verdictText(rule.verdict)}`
        + ` (${rule.count - edge}개 이상이면 나음 · ${edge}개 이하면 못함)`,
      `가짜 타이밍의 최대 낙폭 중앙값 ${p(-rule.nullMdd)} (낙폭이 작은 건 덜 들고 있어서일 수 있음)`,
      `진입 ${rule.strat.entries}회`,
    );
  }
  lines.push(`5/20 같은 규칙: 진입 ${fast.entries}회 · 비용 합계 약 ${(fast.trades * cost * 50).toFixed(0)}% · 누적 ${p(fast.total)}`, '');

  const cls = { up: '정배열(5>20>60>120)', down: '역배열(5<20<60<120)',
    mixUp: '혼조(20일선이 60일선 위)', mixDown: '혼조(20일선이 60일선 아래)' }[g.cls];
  lines.push(`지금: ${cls} · 20일선 ${g.up ? '상승' : '하락'} — ${ymd(g.at).slice(5).replace('-', '/')} 종가 기준`);
  if (g.fallback) lines.push('같은 배열·방향인 날이 적어 배열만으로 봄');
  // 표본이 얼마나 작았는지는 판정하지 않을 때도 보인다 — 빼는 것은 차이 · 범위 줄뿐이다.
  const sample = [`같은 상태였던 날 ${g.days}일 (${g.episodes}구간 · 겹치지 않는 20일 묶음 ${g.windows}개)`];
  if (g.days) sample.push(`20거래일 뒤 중앙값 ${p(g.med)} · 오른 비율 ${Math.round(g.rise * 100)}% (다음 날 종가 매수, 비용 차감)`);
  if (g.verdict === 'few') {
    lines.push('같은 상태였던 날이 적어 판정하지 않음', ...sample);
  } else {
    const out = g.lo != null && (g.diff < g.lo || g.diff > g.hi);
    // 차이와 범위 끝이 소수 한 자리로 같게 보이면(+3.18 · +3.21 → 둘 다 +3.2) 왜 안/밖인지 안 보인다 — 그때만 둘째 자리까지
    const d = g.lo != null && (pp(g.diff) === pp(g.lo) || pp(g.diff) === pp(g.hi)) ? 2 : 1;
    lines.push(
      ...sample,
      `평소: ${p(g.allMed)} · ${Math.round(g.allRise * 100)}% → 차이 ${pp(g.diff, d)}`,
      g.lo == null ? '가짜 주가가 모자라 판정하지 않음'
        : `가짜 주가 ${g.paths}개의 차이 범위 ${pp(g.lo, d)} ~ ${pp(g.hi, d)} ${out ? '밖' : '안'} → ${verdictText(g.verdict)}`
          + (out && g.verdict === 'same' ? ' (앞·뒤 절반의 방향이 달라)' : ''),
    );
  }
  // 2026-10-13 재검증: 효과 없는 규칙에서도 판정이 4~5% 나왔고, 10년치에서 앞 5년 순위로 뒤 5년 순위를 맞히지 못했다(상관 -0.02)
  lines.push('',
    '나음·못함은 규칙이 쓸모없어도 판정마다 20번에 1번꼴로 우연히 나옵니다',
    '지난 기간의 설명입니다 — 10년치로 해 보니 앞 5년 결과로 뒤 5년을 맞히지 못했습니다',
    '배당·세금·환전 제외 · 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽습니다 · 과거 통계이며 매매 권유가 아닙니다');
  return lines.join('\n');
}

// 선택 구간의 수익률 배지. 1D는 위의 일간 등락과 같은 값이라 표시하지 않는다.
// rel(지수 대비, 보조 지표)이 있으면 종목 수익률에서 같은 기간 지수 수익률을 뺀 초과 수익(%p)을 붙인다.
function renderPeriod(first, last, rel = null) {
  const el = document.getElementById('period');
  if (state.timeframe === '1D' || !first || last == null) { el.hidden = true; return; }

  const pct = ((last - first) / first) * 100;
  const tone = (v) => (v === 0 ? cssVar('--flat') : (v > 0 ? UP : DOWN));
  const color = tone(pct);
  el.hidden = false;
  // 글자는 숫자와 고정된 기간 이름뿐이라 innerHTML 로 써도 된다
  let html = `${state.timeframe} ${fmtPct(pct)}`;
  el.title = '';
  if (rel) {
    const ex = pct - rel.pct;
    html += `<span style="color:${tone(ex)}"> · 초과 ${ex > 0 ? '+' : ''}${ex.toFixed(2)}%p</span>`;
    el.title = `같은 기간 ${rel.name} ${fmtPct(rel.pct)} — 종목이 ${Math.abs(ex).toFixed(2)}%p ${ex >= 0 ? '앞섬' : '뒤처짐'}`;
  }
  el.innerHTML = html;
  el.style.color = color;
  el.style.background = hexA(color, 0.16);
}

// 지수 대비 수익률의 비교 지수. 코스피 상장(.KS)은 코스피, 코스닥 상장(.KQ)은 코스닥, 미국은 S&P 500.
// 지수 자체(^KS11)는 어디에도 걸리지 않아 null 이다.
function benchmarkOf(symbol) {
  if (/\.KQ$/i.test(symbol)) return { symbol: '^KQ11', name: '코스닥' };
  if (/\.KS$/i.test(symbol)) return { symbol: '^KS11', name: '코스피' };
  if (isUs(symbol)) return { symbol: '^GSPC', name: 'S&P 500' };
  return null;
}

// 같은 기간 지수 수익률. 국내 지수의 마지막 값은 실시간 지수(위 지수 줄과 같은 값)를 쓴다 — 종목도 현재가다.
function benchReturn(bench, got, from) {
  if (!bench || !got || !got.ok) return null;
  const live = quotes[bench.symbol] && quotes[bench.symbol].price;
  const pct = returnSince(got.times, got.closes, from, live > 0 ? live : got.closes[got.closes.length - 1]);
  return pct == null ? null : { name: bench.name, pct };
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// 이동평균선 범례. 실제로 그린 선만, 기간 숫자 뒤에 그 색을 붙여 보여준다.
// 차트에 마우스를 올리면 그 시점의 값까지 같이 보여준다(툴팁 대신 여기에 띄운다).
let hoverIdx = null;
let lastProfile = null; // 지금 차트의 매물대(drawChart 가 보이는 구간으로 계산) — 범례 · 그리기가 같이 쓴다
function renderMaLegend() {
  const box = document.getElementById('maLegend');
  const mas = (lastChart && lastChart.mas) || [];
  // 확대 중에는 추세선을 그리지 않으므로(drawChart) 범례에서도 뺀다. drawChart 가
  // zoom 을 먼저 정리한 뒤 이 함수를 부르므로 zoom 이 있으면 확대된 화면이다.
  const trends = (lastChart && !zoom && lastChart.trends) || [];
  const bands = (lastChart && lastChart.bands) || null;
  const vw = (lastChart && lastChart.vwapLine) || null;
  const vp = lastChart ? lastProfile : null;
  const sr = (lastChart && lastChart.sar) || null;
  box.hidden = mas.length === 0 && trends.length === 0 && !bands && !vw && !vp && !sr;
  box.innerHTML = '';

  // 값 칸은 비어 있어도 자리를 잡아둔다. 마우스가 올라올 때마다 폭이 변하면
  // 범례가 한 줄에서 두 줄로 접히면서 아래 차트가 들썩인다.
  const add = (label, value, color, title, dashed) => {
    const s = document.createElement('span');
    s.title = title;
    s.append(label);
    const val = document.createElement('b');
    val.textContent = value == null ? '' : typeof value === 'string' ? value : money(value, lastChart.cur);
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
  // 볼린저 밴드는 이동평균처럼 마우스를 올린 시점의 아래~위 값만
  if (bands) {
    const lo = hoverIdx == null ? null : bands.lower[hoverIdx];
    const hi = hoverIdx == null ? null : bands.upper[hoverIdx];
    add('BB', lo == null || hi == null ? null : `${money(lo, lastChart.cur)}~${money(hi, lastChart.cur)}`,
      cssVar('--bb-line'), `볼린저 밴드 (${BB_PERIOD}일 ± ${BB_K}표준편차)`, true);
  }
  // VWAP 는 추세선처럼 마우스를 안 올리면 마지막 값(지금 평균가)을 보여 준다
  if (vw) {
    let i = hoverIdx;
    if (i == null) for (i = vw.length - 1; i > 0 && vw[i] == null; i--);
    add('VWAP', vw[i], cssVar('--vwap-line'), '거래량 가중 평균가 — 그날 정규장 봉');
  }
  // SAR 은 마우스를 안 올리면 지금 방향과 그 방향이 이어진 기간 — 매수 · 매도 신호가 아니라 상태만 말한다.
  // 1D · 1W 는 전환 시각(축과 같은 형식), 일봉 기간은 전환 뒤 봉 수(거래일, 전환한 날 포함). 마우스를 올리면 그 봉의 SAR.
  if (sr) {
    const dir = sr.rising ? '상승' : '하락';
    const intraday = state.timeframe === '1D' || state.timeframe === '1W';
    const when = labelFor(sr.flipAt, intraday ? state.timeframe : '1M');
    add('SAR', hoverIdx != null ? sr.data[hoverIdx] : intraday ? `${dir} · ${when}부터` : `${dir} ${sr.since}일째`,
      cssVar(sr.rising ? '--sar-up' : '--sar-down'),
      `파라볼릭 SAR — ${when} ${dir} 전환 (가속 ${SAR_STEP} · 최대 ${SAR_MAX}). 상승 추세면 점이 봉 아래, 하락 추세면 봉 위`);
  }
  // 매물대는 가장 많이 거래된 가격대(진하게 칠한 칸)를 늘 보여 준다
  if (vp) {
    const from = vp.lo + vp.poc * vp.step;
    add('매물대', `${money(from, lastChart.cur)}~${money(from + vp.step, lastChart.cur)}`,
      cssVar('--vp-poc'), '보이는 구간에서 거래가 가장 많았던 가격대');
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

// 이름표끼리 이만큼(px) 가까우면 포개지므로 하나로 합친다
const HLINE_GAP = 10;

// 가로선 이름표 묶기. 이름표는 묶음의 맨 위 선 자리 · 색에 그리므로, 그 자리에서 HLINE_GAP 안으로
// 들어오는 것끼리 `전일·전고` 처럼 한 이름표가 된다. 예전에는 뒤의 것을 그냥 뺐다 — SOXL 10/14 의
// 전일 127.57 과 전고 127.92 처럼 겹치면 어느 선이 무엇인지 알 수 없었다.
// 값(val)이 있는 것은 묶음의 vals 에 같은 순서로 모은다(마우스를 올렸을 때 오른쪽 끝에 적는 값).
// 가장자리 표시(edge, `▲ 전일 232,000 …`)는 묶음의 뒤에 붙인다 — 앞에 두면 `▲ … ·전저` 처럼 범위 안의
// 선까지 범위 밖으로 읽힌다. 색도 범위 안의 선이 있으면 그 색이다.
function hLineGroups(items) {
  const groups = [];
  for (const it of [...items].sort((a, b) => a.y - b.y)) {
    let g = groups[groups.length - 1];
    if (!g || it.y - g.y >= HLINE_GAP) groups.push(g = { y: it.y, names: [], edges: [], vals: [] });
    (it.edge ? g.edges : g.names).push(it);
    if (it.val != null) g.vals.push(it.val);
  }
  return groups.map((g) => {
    const all = [...g.names, ...g.edges];
    return { y: g.y, text: all.map((it) => it.text).join('·'), color: all[0].color, vals: g.vals };
  });
}

// 가로 기준선(평단 · 전일 · 전고 · 전저 · 프리 · 애프터). 데이터셋으로 넣으면 값이 차트 범위 밖일 때
// y축이 통째로 늘어나므로, 축과 무관하게 캔버스에 직접 그린다. 범위 밖의 선은 선 대신 위 · 아래
// 가장자리에 `▲ 전고 230,500` 처럼 이름과 값을 적는다 — 갭이 큰 날 전고 · 전저가 말없이 사라졌다.
const hLinePlugin = {
  id: 'hLine',
  afterDatasetsDraw(c, _args, opts) {
    const lines = opts.lines || [];
    if (!lines.length) return;
    const area = c.chartArea;
    const ctx = c.ctx;
    const inside = [];
    const above = [];
    const below = [];
    for (const ln of lines) {
      const y = c.scales.y.getPixelForValue(ln.value);
      const it = { ...ln, y, color: cssVar(ln.varName) };
      if (y < area.top) above.push(it);
      else if (y > area.bottom) below.push(it);
      else inside.push(it);
    }

    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const ln of inside) {
      ctx.strokeStyle = ln.color;
      ctx.beginPath();
      ctx.moveTo(area.left, ln.y);
      ctx.lineTo(area.right, ln.y);
      ctx.stroke();
    }

    // 이름표 자리(y 는 글자 아래끝)를 먼저 정하고 묶는다. 이름표는 선 바로 위에 — 다만 맨 위 경계에 붙은
    // 선은 위로 그리면 글자가 차트 밖으로 나가 잘렸다(삼성전자 10/15 전저 230,000) — 그런 선은 선 아래에.
    // 가장자리 표시도 같은 묶음에 넣어 안쪽 선의 이름표와 포개지지 않게 한다(위는 첫 줄, 아래는 맨 아래 줄).
    // 가장자리는 가까운 선부터 적는다.
    // 차트에 마우스를 올린 동안(십자선이 뜨는 동안)은 값도 적는다 — 평소에는 이름만이라 빽빽하지 않고,
    // 이평선 범례처럼 보고 싶을 때만 숫자가 보인다. 값은 오른쪽 끝(y축 눈금 옆)에 따로 적는다: 왼쪽
    // 이름표에 붙이면 커서가 오른쪽 절반일 때 왼쪽에 뜨는 툴팁이 그 값을 가렸다.
    const TEXT_H = 9;
    const labelAt = (y) => (y - 1 - TEXT_H < area.top ? y + 1 + TEXT_H : y - 1);
    const hovering = !!(c.tooltip && c.tooltip.getActiveElements && c.tooltip.getActiveElements().length);
    const labels = inside.map((ln) => ({ y: labelAt(ln.y), color: ln.color, text: ln.label,
      val: hovering ? money(ln.value, opts.cur) : null }));
    const edge = (items, arrow) => `${arrow} ${items.map((ln) => `${ln.label} ${money(ln.value, opts.cur)}`).join(' · ')}`;
    above.sort((a, b) => b.y - a.y);
    below.sort((a, b) => a.y - b.y);
    if (above.length) labels.push({ y: area.top + TEXT_H, text: edge(above, '▲'), color: above[0].color, edge: true });
    if (below.length) labels.push({ y: area.bottom - 1, text: edge(below, '▼'), color: below[0].color, edge: true });
    ctx.setLineDash([]);
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const g of hLineGroups(labels)) {
      ctx.fillStyle = g.color;
      ctx.textAlign = 'left';
      ctx.fillText(g.text, area.left + 2, g.y);
      if (!g.vals.length) continue;
      ctx.textAlign = 'right';
      ctx.fillText(g.vals.join(' · '), area.right - 2, g.y);
    }
    ctx.restore();
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

// 1D 시간외(프리 · 애프터) 구간의 옅은 배경. 선과 캔들 뒤에 깔려야 해서 beforeDatasetsDraw 이고,
// 플러그인 목록에서 캔들보다 앞에 둔다. 칸 경계는 이웃한 두 봉의 가운데다.
const extBandPlugin = {
  id: 'extBand',
  beforeDatasetsDraw(c, _args, opts) {
    const ext = opts && opts.ext;
    if (!ext || !ext.some(Boolean)) return;
    const sx = c.scales.x;
    const area = c.chartArea;
    const ctx = c.ctx;
    const step = ext.length > 1 ? Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0)) : sx.width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip();
    ctx.fillStyle = cssVar('--ext-band');
    for (let i = 0; i < ext.length; i++) {
      if (!ext[i] || ext[i - 1]) continue; // 구간의 첫 봉에서만
      let j = i;
      while (j + 1 < ext.length && ext[j + 1]) j++;
      const x0 = sx.getPixelForValue(i) - step / 2;
      ctx.fillRect(x0, area.top, sx.getPixelForValue(j) + step / 2 - x0, area.height);
    }
    ctx.restore();
  },
};

// 매물대(보조 지표) — 가격대별 거래량을 차트 오른쪽 끝에서 왼쪽으로 옅은 가로 막대로. 가장 긴 막대가
// 차트 폭의 30% 이고, 가장 많이 거래된 칸은 진하게. 선 · 캔들 뒤에 깔려야 해서 beforeDatasetsDraw 다.
// 칸의 위아래는 y축이 그 가격을 두는 자리라 축 범위가 바뀌어도 맞는다.
const VP_MAX_WIDTH = 0.3;
const profilePlugin = {
  id: 'profile',
  beforeDatasetsDraw(c, _args, opts) {
    const p = opts && opts.profile;
    if (!p) return;
    const sy = c.scales.y;
    const area = c.chartArea;
    const ctx = c.ctx;
    const max = p.vols[p.poc];
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip();
    for (let b = 0; b < p.vols.length; b++) {
      if (!(p.vols[b] > 0)) continue;
      const top = sy.getPixelForValue(p.lo + (b + 1) * p.step);
      const bottom = sy.getPixelForValue(p.lo + b * p.step);
      const w = (p.vols[b] / max) * area.width * VP_MAX_WIDTH;
      ctx.fillStyle = cssVar(b === p.poc ? '--vp-poc' : '--vp-bar');
      // 칸 사이 1px 틈 — 붙으면 한 덩어리로 보인다
      ctx.fillRect(area.right - w, top + 0.5, w, Math.max(1, bottom - top - 1));
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

// 끄는 중인 확대 구간 { a, b, x, key } — 봉 번호(누른 곳, 지금 마우스), x 는 누른 곳의
// clientX, key 는 누른 시점의 "종목|기간"(dragKey()). 끌기 이벤트가 쓰고 아래
// zoomBoxPlugin 이 읽는다. 끄는 동안에는 chart.draw() 로 다시 그리기만 해서 가볍다.
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
  // 그 전에 시작한 차트 요청도 무효로 한다. 마지막 종목을 지울 때 그 종목의 요청이 진행 중이면
  // 늦게 온 응답이 지운 종목의 차트를 빈 헤더 아래 다시 그렸다.
  chartSeq++;
  if (chart) { chart.destroy(); chart = null; }
  lastChart = null;
  lastDrawSig = null;
  drawnKey = null;
  document.getElementById('chartBox').className = 'chartbox'; // 불러오던 요청도 위에서 무효가 됐다
  hoverIdx = null;
  renderMaLegend();
  renderCrossBadge([], []);
  renderTrendBadges([], 0);
  document.getElementById('chartMode').hidden = true; // 차트가 없으면 전환할 것도 없다
  document.getElementById('plainChart').hidden = true;
  document.getElementById('zoomReset').hidden = true; // 차트가 없으면 풀 확대도 없다
}

function drawChart(arg) {
  lastChart = arg;
  const {
    closes, times, up, mas = [], cur = 'KRW',
    volumes = [], opens = [], highs = [], lows = [], hLines = [], crosses = [], trends = [], ext = null,
    bands = null, vwapLine = null, volAvg = null, profile = false, sar = null,
  } = arg;
  const color = up ? UP : DOWN;
  // 빠진 시가는 main.js 와 pad 가 종가로 채운다(그 봉은 회색 십자). opens 를 아예 안
  // 넘기는 호출만 라인으로 그린다.
  const daily = TF[state.timeframe].interval === '1d';
  // 확대 구간(3M · 1Y · 3Y). 날짜로 기억해 둔 것을 지금 봉 번호로 바꾼다 — 구간이
  // 사라졌으면(5봉 미만) 전체 보기로 돌아간다.
  const zr = zoom && ZOOM_TF.has(state.timeframe) ? zoomRange(times, zoom.start, zoom.end) : null;
  if (!zr) zoom = null;
  const bars = zr ? zr.to - zr.from + 1 : closes.length; // 화면에 보이는 봉 수
  const candles = candleMode(bars, daily, state.chartMode) && opens.length > 0;
  renderChartMode(bars, daily); // 전환 아이콘도 같은 기준으로 보인다
  document.getElementById('zoomReset').hidden = !zr;
  // 매물대(보조 지표)는 보이는 구간으로 — 확대하면 그 구간의 매물대다. 범례도 이 값을 쓴다.
  lastProfile = profile ? volumeProfile(highs, lows, volumes, zr ? zr.from : 0, zr ? zr.to : closes.length - 1, VP_BINS) : null;
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
    plugins: [extBandPlugin, profilePlugin, candlePlugin, hLinePlugin, crossMarkPlugin, crosshairPlugin, zoomBoxPlugin],
    data: {
      // 1Y · 3Y 를 확대하면 몇 주 · 몇 달만 보이므로 연/월 라벨로는 눈금이 같은 값으로
      // 반복된다(26/03 · 26/03 · 26/04). 그때는 1M · 3M 과 같은 월/일로 쓴다.
      labels: times.map((t) => labelFor(t, zr && YEAR_TF.has(state.timeframe) ? '3M' : state.timeframe)),
      datasets: [{
        label: '',
        data: closes,
        yAxisID: 'y',
        // Chart.js 는 order 가 큰 것부터 그린다(4.5.1: 오름차순 정렬 후 뒤에서부터) — 아래부터
        // 이동평균(3) · 주가선(2) · 고저 밴드(1) · 거래량(0) · 추세선(-1). 밴드 · 막대는 옅어서
        // 주가선을 가리지 않는다.
        order: 2,
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
      // 볼린저 밴드(보조 지표). 위 · 아래 경계를 얇은 점선으로, 사이를 옅게 채운다 — 고저 밴드처럼
      // 위쪽이 fill:'+1' 로 바로 다음(아래쪽)까지 채우므로 배열에서 붙어 있어야 한다.
      // 정규 데이터셋이라 y축이 밴드까지 넓어진다(밴드 밖으로 나간 봉이 보여야 해서).
      ...(bands ? [{
        data: bands.upper,
        yAxisID: 'y',
        order: 3,
        borderColor: cssVar('--bb-line'),
        borderWidth: 1,
        borderDash: [3, 2],
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: '+1',
        backgroundColor: cssVar('--bb-fill'),
        spanGaps: false,
      }, {
        data: bands.lower,
        yAxisID: 'y',
        order: 3,
        borderColor: cssVar('--bb-line'),
        borderWidth: 1,
        borderDash: [3, 2],
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
      }] : []),
      // 파라볼릭 SAR(보조 지표) — 선 없이 봉마다 작은 점. 상승 추세(봉 아래)는 옅은 빨강, 하락(봉 위)은 옅은 파랑.
      // 툴팁 · 범례 값은 renderMaLegend 가 맡아 마우스 대상에서 뺀다.
      ...(sar ? [{
        data: sar.data,
        yAxisID: 'y',
        order: 3,
        showLine: false,
        pointRadius: 1.4,
        pointHoverRadius: 1.4,
        pointHitRadius: 0,
        pointBorderWidth: 0,
        pointBackgroundColor: sar.up.map((u) => cssVar(u ? '--sar-up' : '--sar-down')),
      }] : []),
      // VWAP(보조 지표, 1D 정규장 봉만). 시간외 칸은 null 이라 끊긴다.
      ...(vwapLine ? [{
        data: vwapLine,
        yAxisID: 'y',
        order: 3,
        borderColor: cssVar('--vwap-line'),
        borderWidth: 1.4,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0,
        fill: false,
        spanGaps: false,
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
      // 점선 1.6px — 이동평균과 헷갈리지 않게 하고, 선이 하나 더 늘어도 눌리지 않게 한다.
      // 맨 위에 그린다(order -1). 아래에 깔면 1Y 라인 모드의 주가 채움에 물들고, 같은 주황
      // 계열인 5일선이 저항선을 덮는다.
      // 정규 데이터셋이라 y축이 알아서 범위에 넣는다. 캔버스에 직접 그리면
      // 기울어진 선의 양 끝이 축 밖으로 나가 말없이 잘린다(시간외 선에서 겪음).
      // 확대 중에는 숨긴다. "지금"을 말하는 선(최근 5봉을 빼고 만들어 오늘 값 · 돌파를
      // 계산)이고, 과거 구간 가격에서 먼 선이 y축을 다시 벌려 확대 효과를 깎는다.
      ...(zr ? [] : trends).map((t) => ({
        data: t.data,
        yAxisID: 'y',
        order: -1,
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
        order: 0, // 추세선 바로 아래 — 옅어서(0.2) 주가선 · 이평선이 비쳐 보인다
        // 거래량 평균을 켜면 평균의 VOL_SURGE 배 넘는 막대만 진하게 — 거래가 터진 봉이 바로 보인다
        backgroundColor: volAvg
          ? volumes.map((v, i) => hexA(color, volAvg[i] > 0 && v >= VOL_SURGE * volAvg[i] ? 0.55 : 0.2))
          : hexA(color, 0.2),
        borderWidth: 0,
        barPercentage: 1,
        categoryPercentage: 1,
      }] : []),
      // 거래량 평균선(보조 지표). 거래량 축에 그린다.
      ...(maxVol > 0 && volAvg ? [{
        data: volAvg,
        yAxisID: 'yVol',
        order: 0,
        borderColor: cssVar('--vol-avg'),
        borderWidth: 1,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
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
        // 이동평균과 추세선은 차트 위 범례(renderMaLegend)가 색과 값으로 알려준다.
        legend: { display: false },
        hLine: { lines: hLines, cur },
        crossMark: { list: crosses },
        candle: candles ? { opens, highs, lows, closes } : {},
        extBand: { ext },
        profile: { profile: lastProfile },
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
            // 1Y · 3Y 는 축 라벨이 연/월(YY/MM)이라 제목에 일이 없으면 어느 날을 가리키는지
            // 모른다 — 끌어서 구간을 고를 때 특히. 1Y · 3Y 만 일까지 보인다.
            title: (items) => {
              const it = items[0];
              if (!it) return '';
              // 1D 시간외 봉은 어느 세션인지 붙인다(배경만으로는 무슨 구간인지 모른다)
              const session = ext && ext[it.dataIndex];
              if (session) return `${it.label} ${session === 'pre' ? '프리' : '애프터'}`;
              if (!YEAR_TF.has(state.timeframe)) return it.label;
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
              if (v && v.parsed.y) {
                const avg = volAvg && volAvg[v.dataIndex];
                lines.push(`거래량 ${fmtVol(v.parsed.y)}${avg > 0 ? ` · 평균의 ${(v.parsed.y / avg).toFixed(1)}배` : ''}`);
              }
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
// 일봉 시리즈를 캐시에서 꺼낸다. 만료됐으면 다시 받는다. 받지 못하면 있던 캐시를 쓰되
// 낡았다고 표시한다(stale) — 몇 시간 전 값일 수 있다. 그 종목은 DAILY_RETRY 동안 쉬고, 이번
// 차례에 다른 종목이 실패했어도 건너뛴다. 캐시가 없는 종목은 쉬지 않는다 — 그 줄은 오류라
// 다음 갱신에 바로 다시 해 봐야 한다.
async function dailyFor(symbol, ttl) {
  const cached = dailyCache[symbol];
  if (cached && Date.now() - cached.at < ttl) return cached;
  if (cached && (Date.now() < (cached.retryAt || 0) || dailyFailRound === dailyRound)) {
    return { ...cached, stale: true };
  }

  const r = await api.fetchChart({ symbol, ...DAILY });
  if (!r.ok) {
    dailyFailRound = dailyRound;
    if (!cached) return { error: r.error };
    cached.retryAt = Date.now() + DAILY_RETRY;
    return { ...cached, stale: true };
  }

  const last = r.closes.length - 1;
  dailyCache[symbol] = {
    at: Date.now(),
    price: r.price,
    closes: r.closes,
    times: r.times,
    // 목록의 오늘 캔들용 폴백(해외 종목·네이버 실패). 마지막 봉만 쓰므로 시가 배열은 들고 있지 않는다.
    candle: { open: r.opens?.[last], high: r.highs?.[last], low: r.lows?.[last] },
    // 파라볼릭 SAR(보조 지표)은 지난 흐름을 이어받아 5년치 고 · 저가 있어야 1M 첫 봉부터 값이 맞는다
    // (종목당 약 1,250봉 × 2 — 수십 KB).
    highs: r.highs || [],
    lows: r.lows || [],
    // 보조 지표용. 거래량 평균은 5년치가 있어야 1M 첫 봉부터 그려지고(이동평균과 같은 이유),
    // 전일 고가 · 저가는 마지막 며칠의 고 · 저만 있으면 된다.
    volumes: r.volumes || [],
    recent: { times: r.times.slice(-5), highs: (r.highs || []).slice(-5), lows: (r.lows || []).slice(-5) },
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
  };
  return dailyCache[symbol];
}

async function loadQuote(item, live) {
  // 실시간 가격이 따로 오면 일봉은 오래 캐시해도 된다.
  // 실시간이 없으면(폴백) 일봉의 가격을 그대로 쓰므로 짧게만 캐시한다.
  // 미국 종목은 실시간이 있어도 짧게 둔다 — 야후 미국 일봉은 늦지 않아 RSI 를 그대로 맞춰 주고,
  // 아래에서 일봉을 건드리지 않는다. 미국 지수 · 환율도 일봉을 건드리지 않지만 캐시는 길게 둔다 —
  // 세 개를 1분마다 5년치씩(약 80KB) 받기에는 지수 RSI 가 몇 분 늦는 것이 낫다.
  const overseas = isOverseas(item.symbol);
  const r = await dailyFor(item.symbol, live && !isUs(item.symbol) ? DAILY_TTL : 60000);
  if (!r || r.error) {
    quotes[item.symbol] = { error: r ? r.error : '조회 실패', fetchedAt: Date.now() };
    return;
  }

  const closes = r.closes.slice();
  let times = r.times;
  let price = r.price;
  let prevClose = closes.length >= 2 ? closes[closes.length - 2] : price;

  if (live) {
    // 현재가/전일종가는 실시간 값으로 교체한다
    price = live.price;
    prevClose = live.prevClose;
  }
  // 미국 종목 · 지수 · 환율은 일봉을 그대로 둔다. 프리 · 애프터 가격이 정규장 봉에 들어가고, 한국 날짜로
  // "오늘" 을 가르면 밤 22:30~05:00 의 정규장 하루가 둘로 쪼개진다.
  if (live && !overseas) {
    // 마지막 일봉 종가도 현재가로 맞춰 RSI가 20분 지난 값으로 계산되지 않게 한다.
    // 다만 마지막 봉이 아직 어제인데(장 전 프리마켓 · 개장 직후 — 야후 일봉은 20분 늦고 30분 캐시)
    // 실시간은 오늘 거래면, 어제 종가를 지우지 않고 오늘 봉을 덧붙인다. 덮으면 어제 봉의 이동평균
    // 끝점이 오늘 가격으로 틀어져 차트의 어제 캔들(실제 종가)과 어긋났다. 시각은 야후 일봉처럼 그날
    // 09:00 KST(00:00 UTC)다 — maFor 는 UTC 날짜로 짝짓는데 08:30 KST 는 UTC 로 아직 어제다.
    // 실시간 값이 오늘 것이 아니면(휴장일 · 장 전 08:00 이전) 지금처럼 마지막 봉을 맞춘다.
    const kstDay = (ms) => Math.floor((ms + 9 * 3600000) / 86400000);
    const today = kstDay(Date.now());
    if (closes.length && kstDay(times[times.length - 1]) < today
      && live.tradedAt && kstDay(Date.parse(live.tradedAt)) === today) {
      closes.push(price);
      times = [...times, today * 86400000];
    } else if (closes.length) {
      closes[closes.length - 1] = price;
    }
  }

  const change = price - prevClose;
  quotes[item.symbol] = {
    price,
    prevClose,
    change,
    pct: prevClose ? (change / prevClose) * 100 : 0,
    rsi: calcRSI(closes),
    live: !!live,
    // 실시간 없이 야후도 실패해 캐시로 만든 가격 — 받은 시각과 함께 "갱신 실패" 로 보인다(renderUpdated).
    // 실시간이 있으면 가격은 새것이다. 낡은 일봉은 RSI · 이동평균 · 52주에만 쓰인다.
    stale: !live && !!r.stale,
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
    openTime: live && live.openTime || null, // 정규장 시작 'HHMM' — 분봉이 언제 들어오는지 알릴 때 쓴다
    closeTime: live && live.closeTime || null, // 정규장 끝 'HHMM' — 1D 차트의 종가 점 이름표(intradayEnd)
    fetchedAt: !live && r.stale ? r.at : Date.now(),
    // 장후 가격의 검증된 당일 정규장 종가 대비 이동폭. 종료 후에도 유지한다.
    // 0 도 뜻이 있는 값이라(움직이지 않음) || 로 뭉개면 안 된다.
    fromClose: live && live.fromClose != null ? live.fromClose : null,
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
    // 이동평균 계산용. 1M 차트는 23봉뿐이라 자체 데이터로는 20일선이 끝부분만 그려진다.
    // 이미 받아둔 1년치를 그대로 재활용해 추가 요청 없이 앞구간까지 채운다.
    daily: { times, closes },
    // 거래량 평균 · 전일 고저(보조 지표). 거래량은 받은 일봉 그대로라 시각도 그 일봉의 것이다.
    dailyVolume: { times: r.times, volumes: r.volumes || [] },
    dailyHL: { times: r.times, highs: r.highs || [], lows: r.lows || [] },
    recentBars: r.recent || null,
  };
}

// 일봉 값(srcTimes 와 짝인 values)을 차트 시각에 날짜로 맞춘다 — maFor 와 같은 UTC 날짜 짝짓기.
function alignByDay(srcTimes, values, times) {
  const dayOf = (t) => Math.floor(t / 86400000);
  const byDay = new Map();
  for (let i = 0; i < srcTimes.length; i++) byDay.set(dayOf(srcTimes[i]), values[i]);
  const out = times.map((t) => (byDay.has(dayOf(t)) ? byDay.get(dayOf(t)) : null));
  return out.some((v) => v != null) ? out : null;
}

// 볼린저 밴드 — 이동평균처럼 5년치 일봉 종가(오늘 봉은 현재가)로 계산해 차트에 맞춘다.
function bandFor(symbol, times) {
  const d = quotes[symbol] && quotes[symbol].daily;
  if (!d || d.closes.length < BB_PERIOD) return null;
  const b = bollinger(d.closes, BB_PERIOD, BB_K);
  const upper = alignByDay(d.times, b.upper, times);
  const lower = alignByDay(d.times, b.lower, times);
  return upper && lower ? { upper, lower } : null;
}

// 파라볼릭 SAR(보조 지표). SAR 은 지난 흐름(극값 · 가속)을 이어받아서 차트 첫 봉에서 새로 시작하면 1M 은
// 대부분 다른 값이 된다 — 일봉 기간은 차트 첫날 앞의 5년치 일봉 고 · 저를 이어 붙여 계산한다. 차트 봉은 오늘
// 봉을 실시간 캔들로 맞춘 값이라 차트 쪽을 쓴다. 1D · 1W(ext 를 넘긴다, 없으면 null)는 받은 분봉만으로 첫 봉부터, 1D 는
// 정규장 봉만 — 시간외는 거래가 드물어 빈 칸을 채운 평평한 봉이 많아 엉뚱한 곳에서 뒤집힌다. 시간외 칸은 null.
// 돌려주는 값: { data, up(봉마다), rising(지금 상승인지), since(전환 봉부터 센 봉 수), flipAt(전환 봉 시각) } | null
function sarFor(symbol, times, highs, lows, ext) {
  const intraday = ext !== undefined;
  const hs = []; const ls = []; const ts = [];
  const d = !intraday && times.length && quotes[symbol] && quotes[symbol].dailyHL;
  if (d) {
    const first = Math.floor(times[0] / 86400000); // 이동평균과 같은 UTC 날짜 짝짓기
    for (let i = 0; i < d.times.length && Math.floor(d.times[i] / 86400000) < first; i++) {
      hs.push(d.highs[i]); ls.push(d.lows[i]); ts.push(d.times[i]);
    }
  }
  const pre = hs.length;
  const idx = times.map((_, i) => i).filter((i) => !(ext && ext[i]));
  for (const i of idx) { hs.push(highs[i]); ls.push(lows[i]); ts.push(times[i]); }
  const r = parabolicSar(hs, ls, SAR_STEP, SAR_MAX);
  const last = hs.length - 1;
  if (last < 1) return null;
  let k = last;
  while (k > 1 && r.up[k - 1] === r.up[last]) k--;
  const data = new Array(times.length).fill(null);
  const up = new Array(times.length).fill(null);
  idx.forEach((i, j) => { data[i] = r.sar[pre + j]; up[i] = r.up[pre + j]; });
  return { data, up, rising: r.up[last], since: last - k + 1, flipAt: ts[k] };
}

// 거래량 평균. 일봉 기간은 5년치 일봉 거래량으로(첫 봉부터 평균이 있다).
function dailyVolAvg(symbol, times) {
  const d = quotes[symbol] && quotes[symbol].dailyVolume;
  if (!d || d.volumes.length < VOL_AVG) return null;
  return alignByDay(d.times, sma(d.volumes, VOL_AVG), times);
}

// 분봉(1D · 1W) · 전체 탭은 받은 봉으로. 1D 시간외 봉과 거래량 0 인 봉(끼운 끝점 · 야후 종가 봉)은
// 평균에서 빼고 그 칸은 비운다 — 시간외 거래량은 기준이 다르다(미국 프리 0, 국내는 NXT).
function seriesVolAvg(volumes, ext) {
  const idx = volumes.map((_, i) => i).filter((i) => !(ext && ext[i]) && volumes[i] > 0);
  const avg = sma(idx.map((i) => volumes[i]), VOL_AVG);
  const out = new Array(volumes.length).fill(null);
  idx.forEach((i, k) => { out[i] = avg[k]; });
  return out;
}

// 1D 가 보여 주는 날의 바로 앞 거래일 고가 · 저가(전고 · 전저). 날짜는 그 시장의 날짜다 —
// 국내 일봉은 09:00 KST(00:00 UTC), 국내 1D 프리 봉(08:00 KST)은 UTC 로 전날이라 한국 날짜로 센다.
// 미국 일봉은 13:30 UTC 이고 미국 1D 봉(뉴욕 04:00~20:00)은 UTC 날짜가 뉴욕 날짜와 같다.
function prevDayRange(symbol, times) {
  const r = quotes[symbol] && quotes[symbol].recentBars;
  if (!r || !times.length) return null;
  const day = (ms) => Math.floor((ms + (isOverseas(symbol) ? 0 : 9 * 3600000)) / 86400000);
  const shown = day(times[times.length - 1]);
  for (let i = r.times.length - 1; i >= 0; i--) {
    if (day(r.times[i]) < shown && r.highs[i] > 0 && r.lows[i] > 0) return { high: r.highs[i], low: r.lows[i] };
  }
  return null;
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

// 1D 차트의 끝. 야후 5분봉은 20분 늦어 차트 끝이 위에 보이는 가격보다 뒤처진다.
//  - 장중(정규장 거래 중): 현재가를 지금 시각에 덧붙인다.
//  - 정규장이 끝나 확인된 종가가 있으면(지수는 마감 뒤 값이 곧 종가): 종가로 끝낸다. 15:30 뒤 가격은 NXT
//    애프터마켓에서 오고(세션 애프터마켓) 야후 종가 봉(거래량 0)은 15:50쯤 와서, 예전에는 그사이 차트가 20분 전
//    봉에서 멈췄다(2026-10-13). 야후 종가 봉이 이미 있으면 점을 더하지 않고 그 봉 값을 거래소 종가로 맞춘다 —
//    둘이 한 틱 다르면 끝이 두 개가 된다. 이름표는 거래소가 알려 준 종료 시각(closeTime)이다.
//  - 단일가 · 일시정지처럼 정규장 가격이 멈춰 있고 아직 종가가 없으면: 그 가격을 지금 시각에 덧붙인다.
//  - 애프터 · 프리 가격은 정규장 차트에 넣지 않는다(애프터 · 프리 점선이 따로 있다). 오늘 가격이 아니면(장 전 ·
//    휴일) 아무것도 하지 않는다.
// 돌려주는 값: null | { value, replace: true }(마지막 봉 값을 바꾼다) | { value, at }(at 시각에 덧붙인다)
function intradayEnd(q, lastVolume, nowMs) {
  if (!q || !q.live || q.price == null) return null;
  if (q.open && q.session === 'regular') return { value: q.price, at: nowMs };
  const kstDay = (ms) => Math.floor((ms + 9 * 3600000) / 86400000);
  if (!q.tradedAt || kstDay(Date.parse(q.tradedAt)) !== kstDay(nowMs)) return null;
  const close = q.regularClose != null ? q.regularClose : q.priceSession === 'closed' ? q.price : null;
  if (close != null) {
    return lastVolume === 0 ? { value: close, replace: true } : { value: close, at: kstClockMs(q.closeTime, nowMs) ?? nowMs };
  }
  return q.priceSession === 'regular' ? { value: q.price, at: nowMs } : null;
}

// 오늘(한국 시간) 'HHMM' 의 시각(ms). 형식이 아니면 null.
function kstClockMs(hhmm, nowMs) {
  if (!/^\d{4}$/.test(hhmm || '')) return null;
  const midnight = Math.floor((nowMs + 9 * 3600000) / 86400000) * 86400000 - 9 * 3600000;
  return midnight + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2))) * 60000;
}

// 분봉이 들어오기 시작하는 시각(한국 시간 'HH:MM')과 거기까지 남은 분(지났으면 0 이하).
// 야후 국내 시세는 늦게 오므로 개장 시각 + delayMin 이다. openTime 은 네이버가 주는
// 'HHMM' — 수능일처럼 늦게 여는 날은 1000 이 온다. 없으면 평소 개장(09:00)으로 본다.
function intradayEta(nowMs, openTime, delayMin) {
  const hhmm = /^\d{4}$/.test(openTime || '') ? openTime : '0900';
  const startMin = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2)) + delayMin;
  const kst = new Date(nowMs + 9 * 3600000); // 보는 사람의 시간대와 상관없이 한국 시간으로 센다
  const nowOfDay = ((kst.getUTCHours() * 60 + kst.getUTCMinutes()) * 60 + kst.getUTCSeconds()) * 1000
    + kst.getUTCMilliseconds();
  const p = (n) => String(n).padStart(2, '0');
  return {
    at: `${p(Math.floor(startMin / 60))}:${p(startMin % 60)}`,
    minutes: Math.ceil((startMin * 60000 - nowOfDay) / 60000),
  };
}

// 남은 분을 "약 7분 뒤" · "약 2시간 20분 뒤" 로
function leftText(minutes) {
  if (minutes < 60) return `약 ${minutes}분 뒤`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `약 ${h}시간 ${m}분 뒤` : `약 ${h}시간 뒤`;
}

// 분봉(1D · 1W)이 비어 있을 때의 안내. 고장이 아니라는 것과 언제 들어오는지를 말한다.
// 국내만 시각을 댄다 — 해외는 야후가 늦지 않아 이 이유로 비지 않는다.
function intradayWaitText(item, q) {
  const head = `${item.name} ${state.timeframe}`;
  // 지수도 야후 분봉이 국내 종목처럼 20분 늦다. isDomestic 은 그대로 둔다 — 폴링 · 알림이 쓴다.
  if (!isDomestic(item.symbol) && !isIndex(item.symbol)) return `${head}: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`;
  const eta = intradayEta(Date.now(), q && q.openTime, YAHOO_KR_DELAY_MIN);
  return eta.minutes > 0
    ? `${head}: 분봉은 ${eta.at}쯤부터 들어옵니다 (${leftText(eta.minutes)} · 1M 이상은 정상)`
    : `${head}: 분봉이 늦어지고 있습니다 (보통 ${eta.at}쯤 들어옵니다 · 1M 이상은 정상)`;
}

async function loadChart() {
  const item = selectedItem(); // 관심종목 또는 지수
  if (!item) { document.getElementById('period').hidden = true; return; }

  // 종목/타임프레임을 빠르게 바꾸면 요청이 겹친다. 응답이 뒤늦게 도착한
  // 이전 요청은 버려야 헤더와 차트가 서로 다른 종목을 가리키지 않는다.
  // 네트워크가 느리면 응답까지 몇 초가 걸린다. 그동안 다른 종목 · 기간의 차트를 그대로 두면 탭 · 헤더는 새것인데
  // 차트 · 기간 배지는 옛것이라 눌러도 데이터가 안 바뀐 것처럼 보였다(2026-10-15). 다른 화면으로 넘어가면 옛 차트를
  // 먼저 지우고 불러오는 중을 띄운다. 같은 화면의 30초 갱신은 차트를 그대로 둔다(깜빡이지 않게).
  const key = `${item.symbol}|${state.timeframe}`;
  if (key !== drawnKey) {
    if (drawnKey) clearChart();
    document.getElementById('period').hidden = true;
    document.getElementById('chartBox').className = 'chartbox loading';
  }
  const seq = ++chartSeq;
  const tf = TF[state.timeframe];
  // 차트만 보기(차트 위 버튼): 이동평균 · 보조 지표 · 추세선 · 교차 · 가로선 · 기간 배지를 그리지 않는다.
  // 칩 설정은 그대로 두고 그리기만 건너뛰어, 다시 누르면 원래대로 돌아온다. 가격과 거래량 막대는 남는다.
  const plain = state.plainChart === true;
  // 지수 대비 수익률(보조 지표)은 같은 기간의 지수 차트가 필요하다 — 종목 차트와 함께 받는다(같은 캐시).
  const bench = !plain && state.indicators && state.indicators.rel && state.timeframe !== '1D' ? benchmarkOf(item.symbol) : null;
  const [got, benchGot] = await Promise.all([fetchChartCached(item.symbol, tf),
    bench ? fetchChartCached(bench.symbol, tf).catch(() => null) : null]);
  if (seq !== chartSeq) return; // 더 새 요청이 있다 — 불러오는 중은 그 요청이 내린다
  document.getElementById('chartBox').className = 'chartbox';
  const r = got.ok && tf.years ? lastYears(got, tf.years) : got; // 3Y: 5년치에서 3년만

  if (!r.ok) {
    // 실패 시 이전 차트를 남겨두면 헤더와 다른 종목을 보여주게 되므로 지운다
    clearChart();
    document.getElementById('period').hidden = true;
    // 장 시작 직후엔 Yahoo가 한국 분봉을 아직 안 채워 빈 응답이 온다.
    // 일봉(1M 이상)은 정상이므로 고장이 아니라는 걸 알려주고, 언제 들어오는지 말한다.
    const intraday = tf.interval !== '1d';
    err(intraday && r.error === '빈 데이터'
      ? intradayWaitText(item, quotes[item.symbol])
      : `${item.name} 차트: ${r.error}`);
    return;
  }

  err(quoteErrText());
  const q = quotes[item.symbol];
  const closes = r.closes.slice();
  const times = r.times.slice();
  // 1D 시간외 봉(main.js): 봉마다 'pre' · 'after', 정규장은 null. 그 구간의 배경을 옅게 칠한다.
  const ext = r.ext ? r.ext.slice() : null;

  // Yahoo 1D 봉은 20분 전에서 끊긴다. 끝점을 이어붙이거나(장중 현재가 · 장 마감 뒤 종가)
  // 야후 종가 봉을 거래소 종가로 맞춰 차트 끝과 위에 표시된 가격이 어긋나 보이지 않게 한다.
  // 미국 종목은 야후 분봉이 늦지 않아 맞출 것이 없다(intradayEnd 의 날짜 · 시각도 한국 기준이다).
  // 기준은 정규장의 마지막 봉이다 — 뒤에 애프터 봉이 붙어 있어도. 끝점은 시각 순서대로 끼운다.
  const lastReg = ext ? ext.lastIndexOf(null) : closes.length - 1;
  const end = state.timeframe === '1D' && !isOverseas(item.symbol)
    ? intradayEnd(q, r.volumes && r.volumes[lastReg], Date.now()) : null;
  let endAt = -1; // 끼운 끝점의 자리 — 아래 봉 단위 배열들도 같은 자리를 채운다
  if (end && end.replace) {
    if (lastReg >= 0) closes[lastReg] = end.value;
  } else if (end) {
    const later = times.findIndex((t) => t > end.at);
    const i = later < 0 ? closes.length : later;
    // 애프터 봉보다 뒤("지금")로 가는 끝점은 붙이지 않는다 — 선이 애프터에서 정규장 값으로 되돌아간다.
    if (!(lastReg >= 0 && lastReg < closes.length - 1 && i > lastReg + 1)) {
      closes.splice(i, 0, end.value);
      times.splice(i, 0, end.at);
      if (ext) ext.splice(i, 0, null);
      endAt = i;
    }
  }

  // 1D 외에는 "일간 등락"만 보여주면 탭과 안 맞는다. 해당 구간 수익률도 같이 표시.
  if (plain) document.getElementById('period').hidden = true;
  else {
    renderPeriod(r.closes[0], q && q.price != null ? q.price : closes[closes.length - 1],
      benchReturn(bench, benchGot, r.times[0]));
  }

  // 이동평균선은 일봉 타임프레임(1M/3M/1Y/3Y)에서만 의미가 있다.
  // 1D(5분봉)/1W(30분봉)에 "5일선"을 그리면 이름과 실제가 안 맞는다.
  const daily = tf.interval === '1d';
  const bars = daily ? r.times.length : 0;
  if (bars !== chartBars) { chartBars = bars; renderMaChips(); } // 켤 수 있는 기간이 바뀐다

  const mas = [];
  for (const p of plain ? [] : state.maPeriods) {
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

  // 1D 는 끝점을 끼웠으므로 봉 단위 배열들보다 한 칸 길다 → 그 칸을 채운다
  const pad = (src, fill) => {
    const at = (i) => (typeof fill === 'function' ? fill(i) : fill);
    if (!src) return closes.map((_, i) => at(i));
    const a = src.slice(0, r.closes.length);
    if (endAt >= 0) a.splice(endAt, 0, at(endAt));
    while (a.length < closes.length) a.push(at(a.length));
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
  if (!plain && TREND_TF.has(state.timeframe)) {
    const len = closes.length;
    const sup = trendLine(lows, len, true);
    const res = trendLine(highs, len, false);
    // 선을 만들 때 빼둔 최근 봉이 그 선을 뚫었는지 같이 담는다.
    if (sup) trends.push({ ...sup, varName: '--sup-line', broke: breakoutOf(sup, lows, len, true) });
    if (res) trends.push({ ...res, varName: '--res-line', broke: breakoutOf(res, highs, len, false) });
  }
  renderTrendBadges(trends, closes.length, times);

  // 보조 지표(설정의 칩). 볼린저 밴드는 이동평균처럼 일봉 기간에만, VWAP 는 1D 정규장 봉만 —
  // 시간외 거래량은 기준이 달라(미국 프리 0, 국내는 NXT) 섞으면 평균가의 뜻이 흐려진다.
  const ind = plain ? {} : state.indicators || {};
  const bands = ind.bb && daily ? bandFor(item.symbol, times) : null;
  const vw = ind.vwap && state.timeframe === '1D'
    ? vwap(highs, lows, closes, volumes, (i) => !(ext && ext[i])) : null;
  const vwapLine = vw && vw.some((v) => v != null) ? vw : null;
  const volAvg = ind.volAvg ? (daily ? dailyVolAvg(item.symbol, times) : seriesVolAvg(volumes, ext)) : null;
  // SAR 은 1D · 1W 와 일봉 기간만 — 전체(월봉 · 분기봉)는 봉 크기가 들쭉날쭉하다. 1W(30분봉)는 1D 처럼 받은 봉만으로
  // 5일 전 첫 봉부터(더 긴 분봉 이력이 없다). 밤 사이 갭에서 뒤집히기도 하지만 드물었다(2026-10-15 실측).
  const sar = !ind.sar ? null
    : daily ? sarFor(item.symbol, times, highs, lows)
      : state.timeframe === '1D' || state.timeframe === '1W' ? sarFor(item.symbol, times, highs, lows, ext) : null;

  const held = state.holdings[item.symbol];
  const up = !q || q.change >= 0;

  // 가로 기준선. 전일 종가는 장중(1D)에만 의미가 있다 —
  // 일봉 차트에서는 마지막에서 두 번째 점일 뿐이라 기준선이 될 이유가 없다.
  const hLines = [];
  if (!plain && held && held.avg > 0) hLines.push({ value: held.avg, label: '평단', varName: '--avg-line' });
  if (!plain && state.timeframe === '1D' && q) {
    if (q.prevClose != null) {
      hLines.push({ value: q.prevClose, label: '전일', varName: '--prev-line' });
    }
    // 시간외 가격은 별도 기준선이다. 종료 후에도 마지막 가격의 출처를 유지한다.
    // 시간외 한 점을 정규장 5분봉에 붙이면 시간 간격이 왜곡된다.
    const origin = priceSessionOf(q);
    if ((origin === 'after' || origin === 'pre') && q.price != null) {
      hLines.push({ value: q.price, label: origin === 'after' ? '애프터' : '프리', varName: '--over-line' });
    }
    // 어제 고가 · 저가 — 이름표가 묶이거나 가장자리로 가도 어느 선인지 알게 옅은 빨강 · 파랑(높으면 빨강)
    const prev = ind.prevHL ? prevDayRange(item.symbol, times) : null;
    if (prev) {
      hLines.push({ value: prev.high, label: '전고', varName: '--prevhi-line' },
        { value: prev.low, label: '전저', varName: '--prevlo-line' });
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
    + `|${opens[opens.length - 1]}|${highs[highs.length - 1]}|${lows[lows.length - 1]}`
    // 애프터 봉이 뒤에 붙으면 정규장 끝점(종가)은 마지막 칸이 아니다 — 그 값과 시간외 봉 수도 본다.
    + `|${ext ? ext.filter(Boolean).length : ''}|${endAt >= 0 ? closes[endAt] : ''}|${lastReg >= 0 ? closes[lastReg] : ''}`
    // 보조 지표를 켜고 끄면 봉이 그대로여도 다시 그린다
    + `|${INDICATORS.map((i) => (ind[i.key] ? 1 : 0)).join('')}`
    // 차트만 보기 — 이동평균 · 가로선이 없던 화면이면 위 값이 같아도 추세선이 남는다
    + `|${plain}`;
  if (sig === lastDrawSig) return;
  lastDrawSig = sig;
  drawnKey = key;

  drawChart({
    closes, times, up, mas, cur: curOf(item.symbol),
    volumes, opens, highs, lows, crosses, hLines, trends, ext, bands, vwapLine, volAvg, sar,
    profile: !!ind.vp && daily, // 매물대 — 보이는 구간(확대 포함)으로 drawChart 가 계산한다
  });
}

async function refreshAll() {
  if (busy) return;
  busy = true;
  dailyRound++; // 일봉 실패를 차례 단위로 센다(dailyFor)
  try {
    const indexNow = await loadIndices();

    // 실시간 현재가는 한 번에 (요청 1건), 일봉은 rate limit 고려해 종목별 순차
    const liveMap = await fetchLive(state.watchlist.map((i) => i.symbol));
    for (const item of state.watchlist) {
      await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
      renderList();
    }
    // 지수도 종목과 같은 시세로 만든다 — 누르면 바로 뜨게 둘 다. 네이버 지수를 못 받았으면
    // 실시간 없이 들어가 야후 값(20분지연)이 된다(종목 폴백과 같다).
    for (const ix of INDICES) await loadQuote(ix, indexLive(indexNow.find((n) => n.code === ix.code)));
    checkAlerts();
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
  plainChart: state.plainChart,
  infoOpen: state.infoOpen,
  indicators: state.indicators,
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
    setTimeframe(key);
    save();
    renderTabs();
    loadChart();
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
  renderIndChips();
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

// 보조 지표 켜고 끄기. 켜진 칩은 이동평균 칩처럼 그 선의 색을 띤다.
function renderIndChips() {
  const box = document.getElementById('indChips');
  box.innerHTML = '';
  for (const ind of INDICATORS) {
    const on = state.indicators[ind.key];
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ind.label;
    b.title = ind.title;
    if (on) {
      const c = cssVar(ind.varName);
      b.className = 'on';
      b.style.color = c;
      b.style.borderColor = c;
    }
    b.onclick = () => {
      state.indicators = { ...state.indicators, [ind.key]: !on };
      save();
      renderIndChips();
      loadChart();
    };
    box.appendChild(b);
  }
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
  // 보유 칸은 쉼표를 보이려고 글자 칸(text)이다 — number 칸은 "206,000" 을 받지 않는다.
  const buildRow = (item, fields, onSave) => {
    const row = document.createElement('div');
    row.className = 'arow';
    row.innerHTML = `<span class="aname">${esc(item.name)}</span>`
      + fields.map((f) => `<input class="${f.cls}" type="${f.text ? 'text' : 'number'}"`
        + `${f.text ? ' inputmode="decimal"' : ''} placeholder="${f.ph}"`
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
  }

  // 보유는 들고 있는 종목만 고치고 지운다. 새로 넣는 것은 상세 화면의 "＋ 보유 입력" 이다 —
  // 관심종목 전부를 늘어놓으면 무엇을 들고 있는지 알 수 없었다.
  const held = state.watchlist.filter((i) => state.holdings[i.symbol]);
  if (!held.length) {
    holdBox.innerHTML = '<div class="empty">종목을 고른 뒤 상세 화면의 ＋ 보유 입력으로 넣으세요</div>';
    return;
  }
  const msg = document.createElement('div');
  msg.className = 'ohint';
  for (const item of held) {
    const h = state.holdings[item.symbol];
    const row = buildRow(item, [
      { cls: 'qty', ph: '수량', value: amountText(h.qty), text: true },
      { cls: 'avg', ph: '평단가', value: amountText(h.avg), text: true },
    ], (r) => () => {
      const qEl = r.querySelector('.qty');
      const aEl = r.querySelector('.avg');
      const next = holdingFrom(qEl.value, aEl.value);
      // 잘못 넣으면 지우지 않는다 — 예전에는 칸 하나를 비우면 말없이 보유가 지워졌다
      const keep = next || state.holdings[item.symbol];
      qEl.value = amountText(keep.qty);
      aEl.value = amountText(keep.avg);
      msg.textContent = next ? '' : '수량과 평단가를 모두 0보다 큰 숫자로 넣어 주세요';
      if (next) setHolding(item.symbol, next);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'hdel';
    del.title = '보유 지우기';
    del.textContent = '✕';
    del.onclick = () => { setHolding(item.symbol, null); renderAlerts(); };
    row.appendChild(del);
    holdBox.appendChild(row);
  }
  holdBox.appendChild(msg);
}

// 목표가 "통과" 시에만 알린다. 이전 가격이 없는 첫 갱신은 기준만 잡고 넘어가므로
// 앱을 켜자마자 이미 목표가를 넘긴 종목이 무더기로 울리지 않는다.
function checkAlerts() {
  for (const item of state.watchlist) {
    const t = state.alerts.targets[item.symbol];
    const q = quotes[item.symbol];
    if (!q || q.error) continue;
    // 국내 장이 모두 닫혔으면 국내 종목만 건너뛴다. 미국 정규장은 한국 시간 밤이라 국내 장과
    // 겹치지 않는다 — 알림 전체를 끄면 국내 종목이 하나라도 있을 때 해외 알림이 울릴 수 없다.
    if (isDomestic(item.symbol) && !marketOpen) continue;
    // 세션 정보가 전혀 없는 기존 가격 전용 테스트/호출은 그대로 지원한다.
    const hasSession = q.isTrading !== undefined || q.session !== undefined || q.open !== undefined;
    if (isDomestic(item.symbol) && hasSession && tradingState(q) !== true) continue;

    // 판정한 가격만 다음 기준이 된다. 알림이 꺼져 있거나 목표가가 없어도 기준은 따라가야
    // 켜거나 목표가를 넣은 직후에 지난 통과를 뒤늦게 알리지 않는다.
    const prev = alertBase[item.symbol];
    alertBase[item.symbol] = q.price;
    if (!state.alerts.enabled || !t || prev == null) continue;

    // 해외 종목은 원이 아니다 — $179.50 를 원화 포맷에 넣으면 "180원" 이 된다
    const cur = curOf(item.symbol);
    const unit = (v) => (cur === 'KRW' ? `${money(v, cur)}원` : `${money(v, cur)} ${cur}`);
    if (t.up != null && prev < t.up && q.price >= t.up) {
      api.notify({ title: `${item.name} 상한 도달`, body: `${unit(q.price)} (목표 ${unit(t.up)})` });
    }
    if (t.down != null && prev > t.down && q.price <= t.down) {
      api.notify({ title: `${item.name} 하한 도달`, body: `${unit(q.price)} (목표 ${unit(t.down)})` });
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

// 기간을 바꾼다. 떠나는 기간의 확대는 기억해 두고, 돌아오는 기간의 확대를 되살린다 —
// 1D 를 잠깐 보고 3M 으로 돌아올 때마다 다시 끌지 않게. 기간 버튼과 숫자 단축키가 같이 쓴다.
function setTimeframe(key) {
  zoomByTf[state.timeframe] = zoom;
  state.timeframe = key;
  zoom = zoomByTf[key] || null;
}

// 종목이 바뀌면 모든 기간의 확대를 버린다 — 다른 종목에 같은 날짜 구간은 뜻이 없다.
function clearZooms() {
  zoom = null;
  for (const k of Object.keys(zoomByTf)) delete zoomByTf[k];
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
    zoomDrag = { a: i, b: i, x: e.clientX, key: dragKey() };
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
  window.addEventListener('mouseup', (e) => {
    if (!zoomDrag) return;
    const r = zoomDrag.key === dragKey() ? dragToRange(zoomDrag.a, zoomDrag.b, e.clientX - zoomDrag.x) : null;
    zoomDrag = null;
    // 5봉 · 6px 미만(클릭 · 손떨림 · 도로 좁혀 취소)이거나, 끄는 도중 종목 · 기간이 바뀐 것
    if (!r || !lastChart) {
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
  // 옆의 차트만 보기 버튼 — 켜져 있으면 강조
  const p = document.getElementById('plainChart');
  p.hidden = false;
  p.className = state.plainChart ? 'on' : '';
  p.title = state.plainChart ? '덧그림 다시 보기' : '차트만 보기 — 이동평균 · 보조 지표 · 기준선 끄기';
}

function renderTabs() {
  const box = document.getElementById('tf');
  box.innerHTML = '';
  for (const key of Object.keys(TF)) {
    const b = document.createElement('button');
    b.textContent = key;
    b.className = key === state.timeframe ? 'on' : '';
    b.onclick = async () => {
      setTimeframe(key);
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
  // 지수 줄은 30초마다 다시 그려지므로 항목이 아니라 줄에 한 번만 붙인다
  document.getElementById('indices').onclick = (e) => {
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
  const opEl = document.getElementById('opacity');
  opEl.oninput = () => applyOpacity(opEl.value, true); // 끄는 동안 미리보기
  opEl.onchange = () => save();                       // 손을 뗄 때만 저장
  document.getElementById('alertOn').onchange = (e) => {
    state.alerts.enabled = e.target.checked;
    save();
    renderAlerts();
  };
  // 문서의 Esc(위젯 접기)로 번지지 않게 멈춘다 — 이 처리로 패널이 먼저 닫히므로 문서 쪽의
  // "패널이 열려 있으면 무시" 검사를 지나 버린다(다크 · 라이트 버튼에 포커스가 있을 때).
  alertsEl.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAlerts(); } };
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
  state.plainChart = state.plainChart === true;
  // 보유 · 52주 · 추세 점검은 접었다고 저장된 때만 접는다
  state.infoOpen = state.infoOpen !== false;
  applyInfoOpen();
  document.getElementById('infoToggle').onclick = toggleInfo;
  // 이동평균 색 · 굵기 — 잘못된 값은 버리고 기본으로 그린다(applyTheme 가 칩을 그리기 전에)
  state.maStyles = cleanMaStyles(state.maStyles);
  state.indicators = cleanIndicators(state.indicators);
  applyTheme(state.theme);
  applyOpacity(state.opacity);
  renderMaChips();
  renderIndChips();
  state.selected = validSelection(state.selected, state.watchlist); // 지수를 보던 중이면 그대로
  state.timeframe = validTimeframe(state.timeframe);

  document.getElementById('chartMode').onclick = async () => {
    state.chartMode = state.chartMode === 'candle' ? 'line' : 'candle';
    save();
    await loadChart(); // 서명에 chartMode 가 있어 다시 그려지고, drawChart 가 아이콘도 바꾼다
  };
  document.getElementById('plainChart').onclick = async () => {
    state.plainChart = !state.plainChart;
    save();
    await loadChart(); // 서명에 plainChart 가 있어 다시 그려지고, drawChart 가 버튼 강조도 바꾼다
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
