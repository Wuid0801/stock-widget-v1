// renderer/state.js — 렌더러의 상수 · 상태(state · quotes · 캐시) · 설정 표 · 과열도 단계.
// 렌더러는 index.html 이 renderer/ 의 파일을 차례로 싣는 클래식 스크립트들이다 — 최상위 선언이 전역이라 서로 이름으로 부르고
// (모듈이 아니다), 맨 위에서 바로 도는 코드는 앞 파일의 것만 부를 수 있다(tests/renderer-load.mjs 가 순서대로 실어 본다).
// UI 렌더링 · Chart.js 그리기 · 30초 폴링. 네트워크는 전부 window.api(preload → 메인 프로세스)로만 나간다.


const UP = '#e24b4a';   // 상승 = 빨강 (한국 관례)
const DOWN = '#185fa5'; // 하락 = 파랑

const TF = {
  // 1D · 1W 는 시간외(프리 · 애프터) 봉까지 받는다 — 미국은 야후, 국내는 네이버 NXT 분봉(main.js).
  // 차트 위 정규장 / 전체 버튼으로 끌 수 있다(chartTf).
  '1D': { range: '1d', interval: '5m', extended: true },
  '1W': { range: '5d', interval: '30m', extended: true },
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
  { key: 'rel', label: '지수 대비', varName: '--accent', title: '기간 수익률에서 같은 기간 지수 수익률을 뺀 초과 수익(%p)과, 첫 봉을 종목 가격에 맞춘 지수 점선 — 코스피 · 코스닥 · S&P 500 (1M 이상)' },
  { key: 'sar', label: 'SAR', varName: '--sar-up', title: '파라볼릭 SAR — 상승 추세면 봉 아래, 하락 추세면 봉 위에 점. 범례에 지금 방향과 전환 뒤 기간 (1D · 1W · 1M · 3M · 1Y · 3Y)' },
  { key: 'rsi', label: 'RSI', varName: '--rsi-line', title: 'RSI(14)와 시그널(RSI 9봉 평균) — 차트 아래 따로 둔 칸에 선, 시그널을 위로 뚫은 봉은 빨강 · 아래로 뚫은 봉은 파랑 점. 범례에 지금 방향과 교차 뒤 기간 (1D · 1W · 1M · 3M · 1Y · 3Y)' },
];
const VP_BINS = 20;   // 매물대 가격 칸 수 — 150px 차트에서 한 칸 약 7px
const BB_PERIOD = 20;
const BB_K = 2;
const VOL_AVG = 20;   // 거래량 평균 봉 수
const VOL_SURGE = 2;  // 평균의 몇 배부터 막대를 진하게 칠하나
const SAR_STEP = 0.02; // 파라볼릭 SAR 가속 — 흔한 기본값(와일더)
const SAR_MAX = 0.2;
const RSI_PERIOD = 14; // RSI(보조 지표) — 과열도 배지와 같은 RSI(14)
const RSI_SIGNAL = 9;  // 시그널 = RSI 의 이 봉 수 평균(증권사에 따라 6 을 쓰기도 한다)
const RSI_PANE = 45;   // RSI 칸 높이(px) — 가격 칸 아래 따로 둔다. 켜 두면 차트 상자도 이만큼 커진다(index.html .chartbox.sub)
const RSI_TF = new Set(['1D', '1W', '1M', '3M', '1Y', '3Y']); // 전체(월봉 · 분기봉)는 SAR 처럼 뺀다
const RSI_WARM_RETRY = 5 * 60000; // 1D 의 앞 거래일 봉을 못 받으면 이만큼 뒤에 다시 묻는다
const rsiWarmCache = new Map(); // 종목 → { at, times, closes } — 1D RSI 의 앞 거래일 5분봉(closes null = 실패)
// 차트 상자의 class. RSI 를 켜 두면 그 칸만큼 키운다(sub) — 기간 · 차트만 보기와 상관없이 켜 둔 동안은 같은 높이라 기간을
// 바꿀 때마다 아래 관심종목 목록이 들썩이지 않는다. RSI 를 그리지 않는 화면(전체 · 차트만 보기)은 가격이 그 칸까지 쓴다.
const chartBoxClass = (loading) => `chartbox${state.indicators && state.indicators.rsi ? ' sub' : ''}${loading ? ' loading' : ''}`;
const FOLLOW_MA = 200;    // 기법 점검(지표 화면) — 추세 추종의 장기 이동평균
const DCA_MONTHS = 12;    //   적립식 기간(달, 이번 달 포함)
const REBOUND_DAYS = 60;  //   반등 점검 — 이 거래일 안의 최고 종가에서
const REBOUND_DROP = 15;  //   이만큼(%) 넘게 빠진 뒤 반등 중일 때만
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

// 고를 수 있는 시장 항목(상단 지수 줄 · 시장 지표 화면). 누르면 관심종목처럼 "선택"되어 헤더 · 차트가 그 항목으로 바뀐다.
// 기호는 야후 것이다(차트 · 일봉을 야후에서 받는다). code 는 main.js quote:indices 의 code.
// page 가 있는 것만 지수 줄에 오른다 — 같은 page 끼리 한 장, 340px 한 줄에 둘씩(국내 → 미국 → 나스닥 선물 · 원/달러,
// 2026-10-27 대표 여섯으로 줄였다). page 가 없는 WTI · 미국채 10년 · VIX · SOX 는 시장 지표 화면에서 고른다.
// overseas 는 야후 시세가 국내처럼 20분 늦지 않고 하루가 한국 날짜와 다른 것(미국 지수 · 선물 · 유가 · 금리 · 환율)
// — 미국 종목처럼 다룬다. delayMin 은 거래소가 늦게 주는 분이다 — 나스닥 100 선물(CME) · WTI(NYMEX)는 네이버 · 야후
// 모두 10분 늦다(2026-10-23 실측). cur 는 값의 단위(없으면 포인트 'pt') — 미국채 10년은 금리 '%' 다.
// 코스피200 현물 · 선물(시장 지표 화면에서 고른다, 2026-10-30 사용자 요청)은 야후에 쓸 것이 없어 main.js 가 차트 · 일봉을 네이버로만
// 그린다(NAVER_ONLY) — 선물 기호 ^KS200F 는 앱이 붙인 것이고, =F 로 끝나지 않게 했다(marketDay 가 CME 선물로 날짜를 센다).
// 선물은 네이버가 20분 늦게 준다.
// loadChart 가 selectedItem 을 부르므로 tests/session-ui.mjs 의 prelude(아래 '과열도 5단계'
// 마커 앞)에 있어야 한다.
const INDICES = [
  { symbol: '^KS11', code: 'KOSPI', name: '코스피', page: 0 },
  { symbol: '^KQ11', code: 'KOSDAQ', name: '코스닥', page: 0 },
  { symbol: '^IXIC', code: 'NASDAQ', name: '나스닥', page: 1, overseas: true },
  { symbol: '^GSPC', code: 'SPX', name: 'S&P 500', page: 1, overseas: true },
  { symbol: 'NQ=F', code: 'NQ', name: '나스닥 선물', page: 2, overseas: true, delayMin: 10 },
  { symbol: 'KRW=X', code: 'USDKRW', name: '원/달러', page: 2, overseas: true },
  { symbol: 'CL=F', code: 'WTI', name: 'WTI', overseas: true, delayMin: 10 },
  { symbol: '^TNX', code: 'US10Y', name: '미국채 10년', overseas: true, cur: '%' },
  { symbol: '^VIX', code: 'VIX', name: 'VIX', overseas: true },
  { symbol: '^SOX', code: 'SOX', name: 'SOX', overseas: true },
  { symbol: '^KS200', code: 'KPI200', name: '코스피200' },
  { symbol: '^KS200F', code: 'FUT', name: '코스피200 선물', delayMin: 20 },
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
// 지표 보기(차트 대신 보는 화면). 저장하지 않는다 — 다시 켜면 차트부터.
let metricsOn = false;
const metricsCache = new Map(); // symbol -> { at, d(naver:detail 응답) }
const metricsLoading = new Set();
let metricsShown = { symbol: null, html: null }; // 지금 화면에 쓴 것
const METRICS_TTL = 60000;
// 시장 순위 패널. 지금 보는 시장 · 탭은 저장하지 않는다(다시 켜면 국내 인기 검색).
const RANK_TABS = {
  kr: [['search', '인기 검색'], ['up', '급등'], ['down', '급락'], ['value', '거래대금'], ['industry', '업종'], ['theme', '테마']],
  us: [['up', '급등'], ['down', '급락'], ['value', '거래대금'], ['cap', '시총 상위']], // 미국 인기 검색은 네이버에 없다
};
// 패널의 지표 화면(시장 버튼 '지표', market 'mk') — 묶음과 줄 순서. 키는 INDICES 의 code 이고, 그 밖은 지표 화면만의 줄이다
// (SPOT 외국인 현물 수급 · FUTFLOW 외국인 선물 수급 · HYOAS 미국 하이일드 스프레드 — 2단계, BASIS 베이시스(선물 - 현물) — 2026-10-29).
// FUT 코스피200 선물 · KPI200 코스피200 현물도 처음에는 이쪽(차트 없는 줄)이었다 — 2026-10-30 부터 INDICES.
// 장중 수급(INTRA_*, 다음 금융 — 2026-10-30)은 주체별 한 줄이다(사용자가 고름).
const INTRADAY_GROUP = '코스피 장중 수급'; // 현물 · 프로그램이 코스피 기준이라(코스닥 없음) 이름에 — 사용자 요청
const MARKET_GROUPS = [
  ['국내', ['KOSPI', 'KOSDAQ', 'KPI200', 'FUT', 'BASIS', 'SPOT', 'FUTFLOW']],
  [INTRADAY_GROUP, ['INTRA_FOREIGN', 'INTRA_INDIV', 'INTRA_INST', 'INTRA_PENSION', 'INTRA_CORP', 'INTRA_PROGRAM']],
  ['미국', ['NASDAQ', 'SPX', 'NQ', 'SOX']],
  ['위험 · 자금', ['VIX', 'US10Y', 'HYOAS', 'USDKRW', 'WTI']],
];
// 지표 화면에만 있는 줄의 이름(INDICES 밖의 키)
const MARKET_EXTRA_NAMES = { BASIS: '베이시스', SPOT: '외국인 현물', FUTFLOW: '외국인 선물', HYOAS: '미국 HY OAS',
  INTRA_FOREIGN: '외국인', INTRA_INDIV: '개인', INTRA_INST: '기관', INTRA_PENSION: '연기금', INTRA_CORP: '기타법인', INTRA_PROGRAM: '프로그램' };
// 장중 수급 줄 → market:extras intraday 의 주체 필드. 프로그램은 필드가 아니라 현물 값 하나(intraday.program)다.
const INTRADAY_FIELD = { INTRA_FOREIGN: 'foreign', INTRA_INDIV: 'individual', INTRA_INST: 'institution', INTRA_PENSION: 'pension',
  INTRA_CORP: 'corp', INTRA_PROGRAM: null };
// 위험 · 자금 묶음 줄의 툴팁 — 그 지표의 뜻과 흔히 읽는 법(2026-11-02 사용자 요청). 기준 숫자는 흔히 쓰는 경험칙이다.
const MARKET_DESC = {
  VIX: 'VIX(변동성 지수) — S&P 500 옵션 값으로 낸 앞으로 30일의 예상 변동성(연 %)으로, 흔히 공포지수라고 부른다. '
    + '대략 20 아래면 차분, 20~30 불안, 30 넘으면 공포로 본다. 주가가 급락할 때 치솟고, 내려오면 불안이 가라앉는 것으로 읽는다',
  US10Y: '미국채 10년 금리(%) — 세계 자금의 기준 금리. 오르면 주식(특히 성장주) 값에 부담이고 달러가 강해지기 쉽다. '
    + '물가 · 경기 기대 · 연준 정책에 따라 움직인다. 오늘 등락 · 5일 변화는 bp(0.01%p)',
  HYOAS: '미국 HY OAS — 투기등급(하이일드) 회사채가 국채보다 더 얹어 주는 금리(%p, ICE BofA US High Yield OAS). '
    + '넓어지면(오르면) 부도 걱정에 돈이 위험자산에서 빠진다는 뜻이고, 좁아지면 위험을 감수하는 분위기다. '
    + '대략 3~4% 는 낙관, 5% 넘으면 경계, 2008 · 2020 위기 때는 10% 를 넘었다. FRED, 1~2영업일 늦다',
  USDKRW: '원/달러 — 1달러에 원화 몇 원. 오르면 원화 약세 — 외국인에게는 환차손 걱정이라 국내 주식을 팔기 쉽고, '
    + '수출 기업 실적에는 유리하다. 내리면 반대다',
  WTI: 'WTI — 서부 텍사스산 원유 선물(배럴당 달러, 근월물, 10분 지연). 오르면 물가 · 금리 부담이 커지고 정유 · 에너지주에 유리하다. '
    + '크게 내리면 경기 둔화 걱정으로 읽기도 한다',
};
// 데드캣 점검(market-check.js marketChecks)의 판정 key → 그 판정 점을 다는 지표 화면 줄
const MARKET_CHECK_ROW = { spot: 'SPOT', futures: 'FUTFLOW', sox: 'SOX', usdkrw: 'USDKRW', vix: 'VIX', hyoas: 'HYOAS', us10y: 'US10Y' };
// 코스톨라니 달걀(해석, indicators.js eggPhase)을 메모에 다는 지표 화면 줄 — 거래량이 있는 주가지수만. SOX · 환율 · VIX · 금리는
// 거래량이 없고(야후 0), 나스닥 선물 · WTI 는 만기 때 거래량이 튀고 주식시장 이론이 맞지 않아 뺀다.
const EGG_INDEX = new Set(['KOSPI', 'KOSDAQ', 'NASDAQ', 'SPX']);
// 국면 이름(달걀은 순서를 기억해 나아간다 — 국면은 그날의 거래량 상태가 아니라 달걀의 자리다)과 다음 칸으로 가는 조건
const EGG_NOTE = { A1: '바닥 뒤 상승 초기', A2: '상승 · 거래량 증가', A3: '과열',
  B1: '꼭대기 뒤 하락 초기', B2: '하락 · 거래량 증가', B3: '투매' };
const EGG_WHEN = {
  A1: '상승 중 거래량이 늘면(20일/60일 1배 이상)', A2: `과열되면(RSI ${EGG_HOT} 이상 또는 거래량 ${EGG_SURGE}배 이상)`,
  A3: '20일선이 60일선 아래로 내려가면', B1: '하락 중 거래량이 늘면(20일/60일 1배 이상)',
  B2: `투매가 나오면(RSI ${EGG_PANIC} 이하 또는 거래량 ${EGG_SURGE}배 이상)`, B3: '20일선이 다시 60일선 위로 올라서면',
};
// 시장 지표 줄 메모의 달걀 국면과 방향 — 직전 국면→지금 국면 · 달걀 순서의 다음 국면(eggPhase). 이름 칸이 기본 폭(340px)에서
// 95px 남짓이라(2026-10-29 측정 — '달걀 A2→B1 · 6일째 · 다음 B2' 는 122px 로 잘렸다) 이어진 일수는 툴팁에만 둔다.
const eggDir = (e) => `${e.prev ? `${e.prev}→` : ''}${e.phase} · 다음 ${e.next}`;
// 달걀 국면의 근거 · 방향과 규칙 — 지표 화면 툴팁(종목 기법 점검 · 시장 지표 줄)
const eggTip = (e) => `코스톨라니 달걀(해석) ${e.phase}(${EGG_NOTE[e.phase]})\n`
  + `지금 20일선이 60일선 ${e.up ? '위(상승)' : '아래(하락)'} · 거래량 20일 평균이 60일 평균의 ${e.ratio.toFixed(2)}배 · RSI ${e.rsi.toFixed(0)}\n`
  + (e.prev ? `${e.prev}(${EGG_NOTE[e.prev]})에서 ${e.phase}로 바뀐 지 ${e.days}거래일째(오늘 포함)\n` : '')
  + `다음은 ${e.next}(${EGG_NOTE[e.next]}) — ${EGG_WHEN[e.phase]}\n`
  + `순서 ${EGG_ORDER.join(' → ')} → 다시 ${EGG_ORDER[0]}. 한 칸씩 나아가고 되돌아가지 않습니다. `
  + `과열 · 투매는 바로 건너뛰고(A1 → A3, B1 → B3), 과열 없이 ${EGG_CONFIRM}거래일 넘게 내리면 B1, 투매 없이 그만큼 오르면 A1\n`
  + EGG_EVIDENCE + '\n'
  + '원래 이론에는 숫자 기준이 없어 이 기준은 해석입니다 — 참고용';
// 과거 검증(docs/DEVELOPMENT.md "코스톨라니 과거 검증") — 이론을 그대로 믿지 않게 툴팁에 함께 적는다. 종목마다의 통계는 대부분
// 우연과 구분되지 않아 넣지 않았다(2026-10-29 사용자와 정함).
const EGG_EVIDENCE = '과거 검증(국내 · 미국 대형주 25개 · 지수 4개, 10년): 그 국면 날 뒤 20거래일이 평소보다 — '
  + 'B3 +1.4%p(29곳 중 22곳 나음) · B2 −1.0%p(5곳만 나음) · A3 +0.4%p(팔 신호가 아니었다) · A1 −0.7%p(살 신호도 아니었다). '
  + '흔들림(20일 ±8~10%)에 비해 작고 종목 하나로는 우연과 구분되지 않는다';
// 과열도(RSI) · 추세 추종(200일선)의 과거 검증 — 코스톨라니와 같은 29곳 10년(docs/DEVELOPMENT.md "다른 기법 과거 검증").
// 과열도 배지 · 기법 점검의 추세 추종 줄 툴팁에 한 줄씩(2026-10-30 사용자와 정함).
const RSI_EVIDENCE = '과거 검증(국내 · 미국 대형주 25개 · 지수 4개, 10년): RSI 30 이하(과매도) 뒤 20거래일은 평소보다 +1.9%p'
  + '(29곳 중 22곳 나음, 2020년 폭락을 빼도 +2.2%p) — 대부분 하락 추세(200일선 아래) 속에서였다. '
  + 'RSI 70 이상(과열)은 팔 신호가 아니었다(0.0%p). 흔들림(20일 ±8~10%)에 비해 작고 종목 하나로는 우연과 구분되지 않는다';
const FOLLOW_EVIDENCE = '과거 검증(국내 · 미국 대형주 25개 · 지수 4개, 10년): 200일선 위에서만 보유하면 최대 낙폭이 평균 −55.9% → −43.3%'
  + '(29곳 중 27곳 덜 빠짐), 연수익률은 14.4% → 10.5%(오르는 장이 길어 29곳 중 21곳이 덜 벌었다). '
  + '20거래일 앞을 맞히는 힘은 거의 없었다(위 +0.2%p · 아래 −0.2%p)';
// group: 업종 · 테마 안으로 들어가 있으면 그 묶음({ no, name, pct, count, up, down }), 아니면 null
let rankView = { market: 'kr', kind: 'search', group: null };
const rankCache = new Map(); // 'kr|up' · 'kr|industry|278' -> { at, d(naver:rank 응답) }
const rankLoading = new Set();
let rankShown = { key: null, html: null }; // 지금 목록에 쓴 것
const RANK_TTL = 60000;
// 지표 화면의 수급 · 일별 종가 · HY OAS(main 의 market:extras). 지표 화면이 열려 있을 때만 받고 1분 쓴다(RANK_TTL).
let marketExtras = null; // { at, d(market:extras 응답) }
let marketLoading = false;
// 관심종목 일정(실적 발표 · 잠정실적 공시 · 배당락). 종목마다 30분 쓴다 — 오늘 낸 잠정실적 공시(다음 금융)를 늦지 않게 보이려고
// (예전 6시간, 2026-10-30). 네이버 일정은 main 이 6시간 기억해 네이버 요청은 예전과 같다. 종목 수만큼 요청이 나간다.
const eventCache = new Map(); // symbol -> { at, events: [{ kind: 'ir' | 'irEst' | 'exdiv', title, date: 'YYYY-MM-DD' }] }
let eventsBusy = false;
const EVENT_TTL = 30 * 60000;
const EVENT_LABEL = { ir: '실적', irEst: '실적 예상', exdiv: '배당락' }; // 목록 칩의 이름(eventBadge)
const EVENT_DAYS = 14; // 이만큼 남았을 때부터 목록에 보인다
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

