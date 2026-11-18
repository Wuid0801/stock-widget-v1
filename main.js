// main.js — Electron 메인 프로세스
// 역할: 프레임리스/반투명/항상위 위젯 창 생성, 창 상태 저장·복원,
//       Yahoo Finance chart API 프록시(렌더러는 CORS 때문에 직접 호출 불가).

const { app, BrowserWindow, ipcMain, screen, globalShortcut, Notification, Menu, dialog, session, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { normalizeQuote, normalizeWorldQuote, confirmedRegularClose, overFromClose,
  dailyRegularClose, koreaDate, numberOrNull } = require('./quote-session.cjs');

// Only confirmed same-day regular closes. An after-market startup has none of
// its own, so it asks the daily chart once; retries are spaced by CLOSE_RETRY
// because the close only lands there once the 20-minute delay has passed.
const regularCloseCache = new Map();
const regularCloseTried = new Map();
const CLOSE_RETRY = 300000;

// --- 테스트 훅 (환경변수가 없으면 전부 무동작) ---------------------------------
// 검증 스위트가 상류 실패와 장 상태를 만들어내야 하는데, 예전에는 그걸 하려고
// main.js 를 디스크에서 치환하고 finally 에서 되돌렸다. 프로세스가 중간에 죽으면
// 사용자의 main.js 가 패치된 채로 남는다. 그래서 환경변수로 바꿨다.
// tests/isolation.mjs 가 스위트들이 소스를 다시 건드리지 않는지 검사한다.

// 쉼표로 나열한 조각 중 하나라도 URL 에 들어 있으면 그 요청을 실패시킨다.
const FAIL_URLS = (process.env.KR_STOCK_WIDGET_FAIL_URLS || '').split(',').filter(Boolean);
const rawFetch = FAIL_URLS.length
  ? (url, opt) => (FAIL_URLS.some((s) => String(url).includes(s))
    ? Promise.reject(new Error('테스트에서 차단한 요청'))
    : fetch(url, opt))
  : fetch;

// 모든 요청은 8초 안에 답이 없으면 포기한다. 제한이 없으면 Node 기본값(최대 5분)만큼
// 기다리는데, 그동안 렌더러의 갱신이 끝나지 않아 자동 갱신과 ↻ 가 같이 멈춘다.
// tests/net-timeout.mjs 가 핸들러마다 확인한다.
const FETCH_TIMEOUT = 8000;
// 인터넷이 끊기거나 서버에 닿지 못하면 Node fetch 는 영어 'fetch failed'(TypeError)를 던진다 —
// 화면에 그대로 뜨면("삼성전자 차트: fetch failed") 원인을 알기 어렵다. 원인 코드(cause.code)는
// 상황마다 달라(DNS 실패 ENOTFOUND, 연결 거부는 없음) 한 문구로 묶는다.
// 시간 제한 신호는 본문을 읽는 동안에도 살아 있다 — 머리는 왔는데 본문이 늦으면 res.json() 이 영어 TimeoutError
// ("The operation was aborted due to timeout")로 끝나 화면에 그대로 떴다. 본문 읽기의 실패도 같은 문구로 바꾼다.
const netError = (e) => {
  if (e?.name === 'TimeoutError') return new Error('응답 시간 초과');
  if (e instanceof TypeError && e.message === 'fetch failed') return new Error('네트워크 연결 실패');
  // Electron net.fetch(FRED)는 Chromium 오류 코드('net::ERR_INTERNET_DISCONNECTED' 등)로 실패한다 — 원인이 갈리니 코드는 남긴다
  if (/^net::ERR_/.test(e?.message || '')) return new Error(`네트워크 오류 (${e.message.slice(5)})`);
  return e;
};
// via 는 보낼 fetch — 기본은 Node fetch, FRED 만 Electron net.fetch(fredHyOas).
const netFetch = (url, opt = {}, via = rawFetch) => via(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...opt })
  .then((res) => {
    for (const k of ['json', 'text']) {
      const read = res[k];
      if (typeof read === 'function') res[k] = () => read.call(res).catch((e) => { throw netError(e); });
    }
    return res;
  }, (e) => { throw netError(e); });

// 'regular' | 'pre' | 'after' | 'closed' 로 장 상태를 고정한다.
// 실제 장 시간에 기대면 밤·주말에는 폴링 간격 검증을 돌릴 수 없다.
const FORCE_SESSION = process.env.KR_STOCK_WIDGET_FORCE_SESSION || '';

// 초기 관심종목. 이후에는 store 값이 우선이므로 UI에서 추가/삭제만 붙이면 된다.
const DEFAULT_WATCHLIST = [
  { symbol: '005930.KS', name: '삼성전자' },
  { symbol: '069500.KS', name: 'KODEX 200' },
  { symbol: '122630.KS', name: 'KODEX 레버리지' },
  { symbol: '000660.KS', name: 'SK하이닉스' },
  { symbol: '035420.KS', name: 'NAVER' },
];

const storeOptions = {
  // electron-store 는 기본적으로 app.getName() 기준 폴더에 저장한다.
  // productName 을 붙이면 저장 위치가 바뀌어 기존 설정이 통째로 사라지므로 경로를 고정한다.
  //
  // 환경변수는 테스트만 쓴다. 검증 스위트는 매번 설정을 비우고 관심종목을 넣다
  // 지우는데, 그 대상이 이 경로라 npm test 한 번에 실제 설정이 날아갔다.
  // --user-data-dir 로는 못 막는다 — 그 스위치는 userData 만 바꾸고 여기 쓰는
  // appData 는 그대로다(tests/isolation.mjs 가 이 우회로를 검사한다).
  cwd: process.env.KR_STOCK_WIDGET_CONFIG_DIR
    || path.join(app.getPath('appData'), 'kr-stock-widget'),
  defaults: {
    bounds: { width: 340, height: 520 },
    watchlist: DEFAULT_WATCHLIST,
    selected: '005930.KS',
    timeframe: '1D',
    // 목표가 알림. 기본은 꺼짐 — 사용자가 켜야만 알린다.
    alerts: { enabled: false, targets: {} },
    // 보유 수량/평단가 (계좌 연동 없이 직접 입력)
    holdings: {},
    theme: 'dark', // 'dark' | 'light'
    opacity: 74,   // 평소(마우스가 벗어났을 때) 불투명도 %
    maPeriods: [5, 20, 60], // 표시할 이동평균 기간(일)
    maStyles: {}, // 이동평균선별로 바꾼 색 · 굵기 { [기간]: { color, width } } — 바꾼 것만
    chartMode: 'candle', // 'candle' | 'line'
    plainChart: false, // 차트만 보기(이동평균 · 보조 지표 · 기준선을 그리지 않는다)
    extHours: true, // 1D · 1W 를 장전 · 장후까지(전체) 볼지, 정규장만 볼지
    candleVenue: 'integrated', // 국내 일봉 캔들 기준 'integrated'(KRX + NXT, 증권사 앱의 통합) | 'krx'
    infoOpen: true, // 상세의 보유 · 52주 · 추세 점검 세 줄을 펴 둘지
    alwaysOnTop: true, // 항상 다른 창 위에 둘지(설정의 고정 / 안 고정)
    listGroup: 'none', // 관심종목 묶어 보기 'none' | 'kr'(국내 먼저) | 'us'(미국 먼저) | 'sector'(업종별)
    // 보조 지표(설정의 칩). 기본은 모두 꺼짐 — 이동평균 · 추세선과 겹치면 작은 차트가 빽빽해진다.
    indicators: { bb: false, vwap: false, volAvg: false, prevHL: false, vp: false, rel: false, sar: false },
  },
  // 메모장 · PowerShell 이 붙인 UTF-8 BOM 은 떼고 읽는다 — JSON.parse 는 BOM 에서 SyntaxError 를 낸다.
  deserialize: (text) => JSON.parse(text.replace(/^\uFEFF/, '')),
};

// 설정 파일이 깨졌으면(손으로 고치다 남긴 끝 쉼표, PowerShell 5.1 의 '{}' > 가 만든 UTF-16 등)
// Store 를 만드는 순간 SyntaxError 가 나서 창 코드가 하나도 돌지 않았다 — 위젯이 아예 뜨지 않는다.
// 지우지 않고 이름을 바꿔 두고(평단가는 이 파일에만 있다) 기본값으로 시작하고, 창이 뜬 뒤 알린다.
let brokenConfig = null; // 옮겨 둔 깨진 설정 파일 경로
function openStore() {
  try {
    return new Store(storeOptions);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    brokenConfig = path.join(storeOptions.cwd, `config.broken-${Date.now()}.json`);
    fs.renameSync(path.join(storeOptions.cwd, 'config.json'), brokenConfig);
    return new Store(storeOptions);
  }
}
const store = openStore();

let win = null;
let compact = false;      // 우하단 축소 모드 — 이때의 창 크기는 저장하지 않는다
let normalBounds = null;  // 접기 직전의 창 위치/크기 (펼 때 되돌릴 값)

// 펼친 상태의 최소 크기(차트가 보이려면 이 정도는 필요). 접을 때는 일시적으로 낮춘다.
const MIN_W = 280;
const MIN_H = 380;

// 창 위치를 지금 화면에서 잡을 수 있는가 — 위쪽 끌기 막대(높이 약 30px)가 어느 모니터의
// 작업 영역과 가로 40px · 세로 20px 이상 겹치면 된다. 외부 모니터에 둔 채 끄고 그 모니터
// 없이 켜면 저장된 위치는 화면 밖인데, Windows 는 지정한 좌표의 창을 화면 안으로 옮겨 주지
// 않아 되살릴 길이 마땅치 않다(작업표시줄 버튼을 눌러도 화면 밖에서 뜬다).
const BAR_H = 30;
function reachable(b, displays) {
  return displays.some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + BAR_H, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 40 && h >= 20;
  });
}

function createWindow() {
  // 손으로 고친 설정(bounds: null · 크기 없음)에도 뜬다 — 예외로 창 없이 프로세스만 남으면 단일 실행 잠금을 쥔 채라
  // 다시 실행해도 뜨지 않았다.
  const saved = store.get('bounds');
  const b = saved && typeof saved === 'object' ? saved : {};
  const width = b.width > 0 ? b.width : 340;
  const height = b.height > 0 ? b.height : 520;
  // 저장된 위치가 지금 어느 화면에서도 잡히지 않으면(외부 모니터를 뗀 채 실행) 위치는 버리고
  // 크기만 쓴다 — 첫 실행처럼 OS 가 가운데에 놓는다.
  const placed = Number.isInteger(b.x) && Number.isInteger(b.y)
    && reachable({ x: b.x, y: b.y, width, height }, screen.getAllDisplays());

  win = new BrowserWindow({
    x: placed ? b.x : undefined,
    y: placed ? b.y : undefined,
    width,
    height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: store.get('alwaysOnTop') !== false,
    // 작업표시줄에 버튼을 둔다(2026-11-17 사용자 요청) — 예전에는 숨기고(skipTaskbar) 최소화한 동안만 보였다. 다른 창에 가려지거나
    // 최소화했을 때 그 버튼으로 꺼낸다. 전역 단축키로 숨긴 동안은 Windows 가 버튼도 감춘다.
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    // build/ 는 electron-builder 가 기본으로 설치본에서 빼므로 package.json build.files 에 이 파일을 따로 넣는다(2026-11-06)
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Windows 고배율(예: 150%) 환경에서는 생성자의 x/y/height가 어긋나게 적용된다
  // (640,210 요청 → 54,352 배치). setBounds는 정확하므로 저장된 위치를 다시 잡아준다.
  // 최초 실행에는 저장된 좌표가 없으므로 OS가 알아서 중앙 배치한다.
  if (placed) {
    win.setBounds({ x: b.x, y: b.y, width, height });
  }

  applyOnTop();

  // 이 앱은 로컬 페이지 하나만 띄운다. 어떤 경로로든 외부 페이지로 이동하거나
  // 새 창이 열리는 일이 없도록 막는다.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // 화면(렌더러) 프로세스가 죽으면 창은 남는데 내용이 없고 ✕ 도 안 먹는다 — 테두리 없는 투명
  // 창이라 빠져나오기 어렵다. 다시 띄운다. 다시 뜬 화면은 펼친 상태로
  // 시작하므로 접혀 있었으면 창도 편다(그대로 두면 접힌 크기에 갇히고 위치도 저장되지 않는다).
  // 시작하자마자 또 죽으면 끝없이 다시 띄우게 되니 1분 안의 두 번째부터는 되풀이하지 않는다.
  let reloadedAt = -Infinity;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || Date.now() - reloadedAt < 60000) return;
    reloadedAt = Date.now();
    if (compact) unfold();
    win.webContents.reload();
  });

  win.loadFile('index.html');

  // 축소 모드의 임시 크기가 저장되면 재실행 시 접힌 채로 뜨므로, 평소 크기만 저장한다.
  //
  // 기준 크기(normalBounds)는 여기서만 갱신한다. 접을 때마다 getBounds() 로 다시 잡으면,
  // 고배율에서 setBounds → getBounds 왕복이 1px 어긋나는 값이 되먹임돼
  // 접기/펴기를 반복할수록 창이 계속 커진다(5회에 5px).
  const saveBounds = () => {
    if (!win || win.isDestroyed() || compact) return;
    normalBounds = win.getBounds();
    store.set('bounds', normalBounds);
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });
}

// 항상 위(설정의 고정 / 안 고정 — 저장 키 alwaysOnTop, 끄기로 저장된 때만 끈다). 고정이면 전체화면 앱 위에서도 유지되도록
// screen-saver 레벨. 안 고정이면 다른 창에 가려질 수 있다 — 가려지면 작업표시줄의 버튼을 눌러 앞으로 꺼낸다(2026-11-13 사용자 요청).
function applyOnTop() {
  if (win) win.setAlwaysOnTop(store.get('alwaysOnTop') !== false, 'screen-saver');
}

// ---- IPC: 창/상태 ----------------------------------------------------------

// 렌더러가 저장하는 설정(save() 가 보내는 키, 창 위치는 뺀다). 읽기(state:get) · 쓰기(state:set) · 백업이 모두 이 목록을
// 쓴다 — 셋이 따로 적혀 있을 때는 새 설정을 한 곳에 빠뜨리면 조용히 저장 · 복원되지 않았다. save() 와 같은지는
// tests/state-contract.mjs 가 본다.
const STATE_KEYS = ['watchlist', 'selected', 'timeframe', 'alerts', 'holdings', 'theme', 'opacity', 'maPeriods', 'maStyles',
  'chartMode', 'plainChart', 'infoOpen', 'indicators', 'extHours', 'candleVenue', 'alwaysOnTop', 'listGroup'];
const storedState = () => Object.fromEntries(STATE_KEYS.map((k) => [k, store.get(k)]));

ipcMain.handle('state:get', () => storedState());

// 받은 키를 모아 한 번에 쓴다 — conf 는 set 을 부를 때마다 파일 전체를 읽고 다시 써서(fsync 포함), 키마다 부르면
// save() 한 번(14키)에 47~71ms 메인이 멈췄다(↑↓ 를 누르고 있으면 초당 30번, 2026-10-21 측정). 한 번에 쓰면 4~5ms 이고
// 일부 키만 저장된 채 남지 않는다.
ipcMain.handle('state:set', (_e, patch) => {
  const next = {};
  for (const [k, v] of Object.entries(patch || {})) {
    // electron-store 는 undefined 를 거부하며 예외를 던진다. 저장할 값이 없으면 그냥 건너뛴다.
    if (v === undefined) continue;
    if (STATE_KEYS.includes(k)) next[k] = v;
  }
  if (Object.keys(next).length) store.set(next);
  if ('alwaysOnTop' in next) applyOnTop();
});

// ---- 설정 백업 · 복원 -----------------------------------------------------------
// 보유 수량 · 평단가 · 목표가는 이 PC 의 설정 파일에만 있다 — 파일로 내보내고 불러와 PC 를 옮기거나 설정 파일이
// 깨졌을 때 되살린다. 담는 것은 렌더러가 저장하는 설정 전부(STATE_KEYS)이고 창 위치는 뺀다. 불러올 파일은 믿지 않는다: 1MB 이하 JSON 이어야 하고, 아는 키만, 모양이 맞는 값만
// 쓴다(세세한 값은 렌더러가 시작할 때 다시 거른다). 확인 창에서 바꾸기를 눌러야만 바꾸고, 그 직전 설정은 고른
// 파일과 같은 폴더에 따로 저장해 잘못 불러와도 되돌릴 수 있게 한다. 파일에 없는 설정은 그대로 둔다.
const BACKUP_MAX_BYTES = 1024 * 1024;
const BACKUP_FILTERS = [{ name: '설정 백업(JSON)', extensions: ['json'] }];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const backupJson = () => JSON.stringify({ app: 'stock-widget', version: 1, savedAt: new Date().toISOString(), state: storedState() }, null, 2);
const backupCounts = (s) => ({ watchlist: (s.watchlist || []).length, holdings: Object.keys(s.holdings || {}).length,
  targets: Object.keys((s.alerts && s.alerts.targets) || {}).length });
// 창이 있으면 그 창에 붙여 띄운다(창 뒤로 숨지 않게)
const dialogArgs = (opts) => (win ? [win, opts] : [opts]);

// 불러온 내용 → 쓸 설정. 내보낸 꼴({ state }) · 설정 파일(config.json) 꼴 둘 다 받는다. 아는 값이 하나도 없으면 null.
function cleanBackup(raw) {
  const s = isPlain(raw) && isPlain(raw.state) ? raw.state : raw;
  if (!isPlain(s)) return null;
  const out = {};
  if (Array.isArray(s.watchlist)) {
    const seen = new Set();
    out.watchlist = s.watchlist.filter((i) => isPlain(i) && SYMBOL_RE.test(String(i.symbol ?? '')) && typeof i.name === 'string'
      && !seen.has(i.symbol) && seen.add(i.symbol)).slice(0, 200).map((i) => ({ symbol: i.symbol, name: i.name.slice(0, 100),
        ...(Number.isFinite(i.addedAt) && i.addedAt > 0 ? { addedAt: i.addedAt } : {}) })); // addedAt — 넣은 때(정렬 '최근 추가순')
  }
  if (s.selected === null || (typeof s.selected === 'string' && SYMBOL_RE.test(s.selected))) out.selected = s.selected;
  if (typeof s.timeframe === 'string' && s.timeframe.length <= 10) out.timeframe = s.timeframe;
  if (isPlain(s.alerts)) {
    const targets = {};
    for (const [k, t] of Object.entries(isPlain(s.alerts.targets) ? s.alerts.targets : {})) {
      if (!SYMBOL_RE.test(k) || !isPlain(t)) continue;
      const v = {};
      if (positive(t.up)) v.up = t.up;
      if (positive(t.down)) v.down = t.down;
      if (Object.keys(v).length) targets[k] = v;
    }
    out.alerts = { enabled: s.alerts.enabled === true, targets };
  }
  if (isPlain(s.holdings)) {
    out.holdings = {};
    for (const [k, h] of Object.entries(s.holdings)) {
      if (SYMBOL_RE.test(k) && isPlain(h) && positive(h.qty) && positive(h.avg)) out.holdings[k] = { qty: h.qty, avg: h.avg };
    }
  }
  if (s.theme === 'dark' || s.theme === 'light') out.theme = s.theme;
  if (typeof s.opacity === 'number' && s.opacity >= 30 && s.opacity <= 100) out.opacity = s.opacity;
  if (Array.isArray(s.maPeriods)) out.maPeriods = s.maPeriods.filter((p) => Number.isInteger(p) && p > 0 && p <= 1000).slice(0, 20);
  if (isPlain(s.maStyles)) out.maStyles = JSON.parse(JSON.stringify(s.maStyles)); // 렌더러가 시작할 때 다시 거른다(cleanMaStyles)
  if (s.chartMode === 'candle' || s.chartMode === 'line') out.chartMode = s.chartMode;
  if (s.candleVenue === 'integrated' || s.candleVenue === 'krx') out.candleVenue = s.candleVenue;
  for (const k of ['plainChart', 'infoOpen', 'extHours', 'alwaysOnTop']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (['none', 'kr', 'us', 'sector'].includes(s.listGroup)) out.listGroup = s.listGroup;
  if (isPlain(s.indicators)) out.indicators = Object.fromEntries(Object.entries(s.indicators).filter(([, v]) => typeof v === 'boolean'));
  return Object.keys(out).length ? out : null;
}

ipcMain.handle('backup:export', async () => {
  try {
    const pick = await dialog.showSaveDialog(...dialogArgs({ title: '설정 내보내기', filters: BACKUP_FILTERS,
      defaultPath: path.join(app.getPath('documents'), `stock-widget-backup-${ymd(new Date())}.json`) }));
    if (pick.canceled || !pick.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(pick.filePath, backupJson());
    return { ok: true, path: pick.filePath, counts: backupCounts(storedState()) };
  } catch (err) {
    return { ok: false, error: err.message || '내보내기 실패' };
  }
});

ipcMain.handle('backup:import', async () => {
  try {
    const pick = await dialog.showOpenDialog(...dialogArgs({ title: '설정 불러오기', filters: BACKUP_FILTERS, properties: ['openFile'] }));
    const file = pick.canceled ? null : pick.filePaths && pick.filePaths[0];
    if (!file) return { ok: false, canceled: true };
    if (fs.statSync(file).size > BACKUP_MAX_BYTES) return { ok: false, error: '파일이 너무 큽니다(1MB 넘음)' };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      return { ok: false, error: '백업 파일을 읽을 수 없습니다(JSON 이 아님)' };
    }
    const next = cleanBackup(raw);
    if (!next) return { ok: false, error: '백업 파일이 아닙니다(아는 설정이 없음)' };
    const counts = backupCounts({ ...storedState(), ...next });
    const now = new Date();
    const before = path.join(path.dirname(file),
      `stock-widget-before-import-${ymd(now)}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}.json`);
    const ans = await dialog.showMessageBox(...dialogArgs({ type: 'question', buttons: ['바꾸기', '취소'], defaultId: 1, cancelId: 1,
      title: '설정 불러오기', message: '지금 설정을 이 파일로 바꿉니다',
      detail: `관심종목 ${counts.watchlist}개 · 보유 ${counts.holdings}개 · 목표가 ${counts.targets}개\n바꾸기 전 설정은 ${before} 에 저장해 둡니다.` }));
    if (ans.response !== 0) return { ok: false, canceled: true };
    fs.writeFileSync(before, backupJson());
    store.set(next); // 한 번에 쓴다(state:set 과 같은 이유)
    applyOnTop();
    return { ok: true, counts, before };
  } catch (err) {
    return { ok: false, error: err.message || '불러오기 실패' };
  }
});

// 목표가 도달 알림. 렌더러가 켜져 있을 때만 보낸다(켜고 끄는 판단은 렌더러 쪽).
// 렌더러가 보내는 값의 모양을 믿지 않는다 — ipcMain.on 안의 예외는 메인 프로세스의 잡히지 않은 예외가 된다.
ipcMain.on('notify', (_e, payload) => {
  const { title, body } = payload || {};
  if (!Notification.isSupported()) return;
  new Notification({ title: String(title || ''), body: String(body || '') }).show();
});

ipcMain.on('win:close', () => win && win.close());

// 우하단 접기/펴기. height는 렌더러가 실제 행 높이를 재서 넘겨준다(배율·폰트 영향 회피).
// 펼 때는 store에 남아있는 평소 크기로 되돌린다.
const DOCK_MARGIN = 12; // 화면 가장자리 여백 — 접을 자리와, 펼 자리를 고칠 때 같이 쓴다

// 접기 전 크기 · 자리로 편다. 접기를 푸는 IPC 와, 화면 프로세스가 죽어 다시 띄울 때 쓴다.
function unfold() {
  compact = false;
  win.setMinimumSize(MIN_W, MIN_H);
  if (!normalBounds) return;
  // 접은 채 외부 모니터를 떼면 펼 자리(normalBounds)가 없는 화면을 가리킨다. 접힌 창은
  // Windows 가 남은 화면으로 옮기지만 펼 자리는 그대로라, 크기만 살려 지금 화면의
  // 오른쪽 아래에 편다.
  if (!reachable(normalBounds, screen.getAllDisplays())) {
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    normalBounds = {
      ...normalBounds,
      x: area.x + area.width - normalBounds.width - DOCK_MARGIN,
      y: area.y + area.height - normalBounds.height - DOCK_MARGIN,
    };
  }
  win.setBounds(normalBounds);
}

ipcMain.on('win:dock', (_e, on, height) => {
  if (!win) return;
  if (!on) { unfold(); return; }
  if (!Number.isFinite(height) || height <= 0 || height > 4000) return; // 렌더러가 잰 줄 높이 합 — 이상하면 접지 않는다
  compact = true;
  // store의 bounds에는 창을 한 번도 옮기지 않았으면 x/y가 없다.
  // 그 값으로 되돌리면 크기만 바뀌고 우하단에 머무르므로 직접 기억해 둔다.
  // 이미 잡아둔 기준이 있으면 다시 읽지 않는다(위 saveBounds 주석 참고).
  const b = win.getBounds();
  if (!normalBounds) normalBounds = b;
  const area = screen.getDisplayMatching(b).workArea; // 작업표시줄을 피한 영역
  const width = normalBounds.width; // 펼친 폭과 어긋나지 않도록 기준값을 쓴다
  // 최소 높이(MIN_H)를 먼저 낮추지 않으면 접힌 높이가 그대로 클램프된다
  win.setMinimumSize(MIN_W, height);
  win.setBounds({
    width,
    height,
    x: area.x + area.width - width - DOCK_MARGIN,
    y: area.y + area.height - height - DOCK_MARGIN,
  });
});

// 최소화한 창은 작업표시줄의 버튼으로 되살린다(버튼은 늘 있다 — 예전에는 최소화한 동안만 보이게 했다).
ipcMain.on('win:minimize', () => {
  if (win) win.minimize();
});

// ---- IPC: Yahoo Finance ----------------------------------------------------

// 실시간 현재가. Yahoo 한국 시세는 20분 지연이므로 현재가/등락만 이쪽으로 덮어쓴다.
// 여러 종목을 한 번에 조회할 수 있어 요청 1건으로 끝난다.
// 실패하면 { ok:false } 를 주고, 렌더러는 Yahoo 값(지연)을 그대로 쓴다.
// 세션·가격 선택은 quote-session.cjs 에서 독립적으로 검증한다.
// 미국 종목은 네이버 해외 시세로 따로 받는다 — 야후는 정규장 가격만 줘서 프리 · 애프터마켓
// 움직임이 안 보였다. 한쪽이 실패해도 다른 쪽 시세는 쓴다(빠진 종목은 렌더러가 야후로 채운다).
ipcMain.handle('quote:realtime', async (_e, symbols) => {
  if (!Array.isArray(symbols)) return { ok: false, error: '잘못된 요청' };
  const usPending = usRealtime(symbols);
  const kr = await domesticRealtime(symbols);
  const us = await usPending;
  if (!Object.keys(us).length) return kr;
  return { ok: true, quotes: { ...(kr.ok ? kr.quotes : {}), ...us } };
});

// 미국 종목 = 접미사 없는 야후 티커(AAPL, BRK-B). 지수(^) · 환율(=) · 국내(.KS)는 걸린다.
const US_RE = /^[A-Z][A-Z0-9-]{0,9}$/;
// 국내 종목 = 야후 기호 '코드.KS'(코스피) · '코드.KQ'(코스닥). [1] 이 네이버 종목 코드다.
const KR_RE = /^([A-Za-z0-9]{1,10})\.(KS|KQ)$/;

// 네이버 코드(AAPL.O)를 못 찾은 종목(BRK-B 는 네이버에서 BRK.B)이나 요청 실패는 빠진다.
async function usRealtime(symbols) {
  const us = [...new Set((symbols || []).map(String).filter((s) => US_RE.test(s)))];
  if (!us.length) return {};
  try {
    const pairs = (await Promise.all(us.map(async (s) => [s, await naverUsCode(s).catch(() => null)])))
      .filter(([, code]) => code);
    if (!pairs.length) return {};
    const j = await naverJson('https://polling.finance.naver.com/api/realtime/worldstock/stock/'
      + pairs.map(([, code]) => encodeURIComponent(code)).join(','));
    const byCode = new Map((Array.isArray(j?.datas) ? j.datas : []).map((d) => [d.reutersCode, d]));
    const now = Date.now();
    const quotes = {};
    for (const [symbol, code] of pairs) {
      const q = normalizeWorldQuote(byCode.get(code), { now });
      if (q) quotes[symbol] = q;
    }
    return quotes;
  } catch {
    return {};
  }
}

async function domesticRealtime(symbols) {
  // 국내 종목만 받는다(미국은 usRealtime).
  // 종목코드 형태를 확인해 URL 경로에 이상한 값이 끼어들지 않게 한다.
  const valid = (symbols || [])
    .filter((s) => KR_RE.test(String(s)))
    .map(String);
  const codes = valid.map((s) => s.split('.')[0]);
  const symbolOf = new Map(valid.map((s) => [s.split('.')[0], s]));
  if (!codes.length) return { ok: true, quotes: {} };

  try {
    // Explicit venue endpoints; the KRX top-level quote now includes afterMarket.
    const results = await Promise.allSettled([
      naverJson(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`),
      naverJson(`https://polling.finance.naver.com/api/realtime/domestic/NXT/stock/${codes.join(',')}`),
    ]);
    const rows = results.map((r) => r.status === 'fulfilled' && Array.isArray(r.value?.datas)
      ? r.value.datas : []);
    const baseMap = new Map(rows[0].map((d) => [d.itemCode, d]));
    const nxtMap = new Map(rows[1].map((d) => [d.itemCode, d]));
    const partial = results.some((r) => r.status === 'rejected'
      || !Array.isArray(r.value?.datas));
    const quotes = {};
    const now = Date.now();
    for (const code of new Set(codes)) {
      const d = baseMap.get(code) || { itemCode: code };
      const captured = confirmedRegularClose(d);
      if (captured) regularCloseCache.set(code, captured);
      const quote = normalizeQuote(d, {
        now, nxt: nxtMap.get(code), regularClose: regularCloseCache.get(code),
      });
      if (!quote) continue;

      // No dedicated regular-close field is available after the KRX price starts
      // moving again. Hide fromClose on a cold startup instead of treating a
      // generic 15:30 chart candle as a verified close on special trading days.
      // If one venue failed, do not claim all trading is over based on the other.
      if (partial && quote.isTrading !== true) {
        quote.isTrading = null;
        quote.session = 'unknown';
      }
      // Test-only override. It never fabricates a regular close or price.
      if (['regular', 'pre', 'after', 'closed'].includes(FORCE_SESSION)) {
        quote.session = FORCE_SESSION;
        quote.priceSession = FORCE_SESSION === 'closed' ? quote.priceSession : FORCE_SESSION;
        quote.isTrading = FORCE_SESSION !== 'closed';
        quote.open = FORCE_SESSION === 'regular';
        quote.fromClose = overFromClose(quote.regularClose, quote.price, quote.priceSession);
      }
      quotes[code] = quote;
    }

    // After-market with no close of its own: read it back from the daily chart.
    // One request per symbol per day, not per poll - the value never changes
    // once the session is over, and a failure only hides the difference line.
    const missing = [...new Set(codes)].filter((code) => {
      const q = quotes[code];
      if (!q || q.priceSession !== 'after' || q.regularClose != null) return false;
      const last = regularCloseTried.get(code);
      return last == null || now - last >= CLOSE_RETRY;
    });
    await Promise.all(missing.map(async (code) => {
      regularCloseTried.set(code, now);
      try {
        const res = await netFetch('https://query1.finance.yahoo.com/v8/finance/chart/'
          + `${encodeURIComponent(symbolOf.get(code))}?range=5d&interval=1d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return;
        const meta = (await res.json())?.chart?.result?.[0]?.meta;
        const close = dailyRegularClose(
          { price: meta?.regularMarketPrice, timeMs: meta?.regularMarketTime * 1000 },
          baseMap.get(code)?.stockExchangeType?.endTime);
        const q = quotes[code];
        // normalizeQuote 처럼 시세와 같은 날의 종가만 — 야후가 하루 늦으면 어제 종가가 오늘 "종가 대비" 로 붙었다
        if (!close || !q.tradedAt || close.date !== koreaDate(Date.parse(q.tradedAt))) return;
        regularCloseCache.set(code, close);
        // Patch the two fields instead of rebuilding: the session decision and
        // any override above it stay exactly as they were.
        q.regularClose = close.price;
        q.fromClose = overFromClose(close.price, q.price, q.priceSession);
      } catch { /* 일봉을 못 받으면 종가 대비 줄만 빠진다 */ }
    }));
    if (!Object.keys(quotes).length) return { ok: false, error: '빈 응답 또는 시세 조회 실패' };
    return { ok: true, quotes };
  } catch (err) {
    return { ok: false, error: err.message || '실시간 조회 실패' };
  }
}

// 지수 줄 (실시간): 코스피 · 코스닥, 나스닥 · S&P 500(네이버 해외 지수), 나스닥 100 선물 · WTI(네이버 — 거래소가
// 10분 늦게 준다), 미국채 10년(네이버 — 실시간), 원/달러(야후 — 차트와 보유 합계의 원화 환산이 같은 값을 쓴다).
// 함께 받고, 하나가 실패해도 나머지는 보인다. 다종목 응답에는 *Raw 필드가 빠져 있어 문자열을 직접 파싱한다.
// VIX · SOX 는 지수 줄이 아니라 시장 지표 화면에 쓴다 — 같은 요청에 붙여 요청이 늘지 않는다(2026-10-27 실측)
const US_INDICES = { '.IXIC': { code: 'NASDAQ', name: '나스닥' }, '.INX': { code: 'SPX', name: 'S&P 500' },
  '.VIX': { code: 'VIX', name: 'VIX' }, '.SOX': { code: 'SOX', name: 'SOX' } };
ipcMain.handle('quote:indices', async () => {
  // 지수 헤더용 값. 빠진 값은 0 이 아니라 null(numberOrNull) — 0 이면 시가 0 캔들, 전일 대비 0 이 된다.
  const naver = async (url) => (await naverJson(url)).datas || [];
  // 선물 · 유가 · 미국채의 네이버 코드는 1D 차트와 같은 표(NAVER_DAY)에서 읽는다 — 두 곳에 따로 적으면 한쪽만 고쳐져
  // 지수 줄 값과 1D 차트가 다른 것을 볼 수 있었다(2026-11-06)
  const rc = (symbol) => NAVER_DAY[symbol].reutersCode;
  const item = (d, code, name) => ({
    code,
    name,
    value: numberOrNull(d.closePriceRaw ?? d.closePrice),
    // 지수도 종목처럼 내리면 음수다(2026-10-02 코스닥 -1.00 실측). 유가 · 국채(시장지표)는 이름이 fluctuations 다
    // (2026-10-23 금 -43.50 · 한국 국채 10년 -0.0600 — 내리면 음수인 것도 같다).
    change: numberOrNull(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice ?? d.fluctuations),
    pct: numberOrNull(d.fluctuationsRatioRaw ?? d.fluctuationsRatio),
    open: numberOrNull(d.openPriceRaw ?? d.openPrice),
    high: numberOrNull(d.highPriceRaw ?? d.highPrice),
    low: numberOrNull(d.lowPriceRaw ?? d.lowPrice),
    isOpen: d.marketStatus === 'OPEN',
    tradedAt: d.localTradedAt || null,
  });
  const parts = await Promise.allSettled([
    // KPI200(코스피200 현물) · FUT(코스피200 선물)는 시장 지표 화면에만 쓴다(코스피200 · 베이시스 = 선물 - 현물) — 같은 요청에
    // 붙여 요청이 늘지 않는다. 선물은 20분 늦다(2026-10-23 실측)
    naver('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ,KPI200,FUT')
      .then((ds) => { noteKrxEnd(ds); return ds.map((d) => item(d, d.itemCode, d.stockName)); }),
    naver('https://polling.finance.naver.com/api/realtime/worldstock/index/.IXIC,.INX,.VIX,.SOX')
      .then((ds) => ds.filter((d) => US_INDICES[d.reutersCode])
        .map((d) => item(d, US_INDICES[d.reutersCode].code, US_INDICES[d.reutersCode].name))),
    naver(`https://polling.finance.naver.com/api/realtime/worldstock/futures/${rc('NQ=F')}`)
      .then((ds) => ds.filter((d) => d.reutersCode === rc('NQ=F')).map((d) => item(d, 'NQ', '나스닥 선물'))),
    naver(`https://polling.finance.naver.com/api/realtime/marketindex/energy/${rc('CL=F')}`)
      .then((ds) => ds.filter((d) => d.reutersCode === rc('CL=F')).map((d) => item(d, 'WTI', 'WTI'))),
    // 브렌트유(시장 지표 화면, 2026-11-03 사용자 요청) — WTI 와 같은 네이버 에너지 주소. 코드(LCOcv1)는 네이버 모바일 원자재
    // 페이지의 것으로, 실제 응답은 앱 밖에서 확인하지 못했다(check:sources 가 본다)
    naver(`https://polling.finance.naver.com/api/realtime/marketindex/energy/${rc('BZ=F')}`)
      .then((ds) => ds.filter((d) => d.reutersCode === rc('BZ=F')).map((d) => item(d, 'BRENT', '브렌트유'))),
    // 국채는 폴링 주소가 없다(404) — 상세를 받는다
    naverJson(`https://api.stock.naver.com/marketindex/bond/${rc('^TNX')}`)
      .then((d) => (d && d.reutersCode === rc('^TNX') ? [item(d, 'US10Y', '미국채 10년')] : [])),
    usdKrwItem(),
  ]);
  // 종가 · 등락률이 비면 그 지수는 뺀다 — 0 으로 읽으면 지수 줄에 "코스피 0.00" 이 뜬다.
  const items = parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : []))
    .filter((i) => i.value > 0 && i.pct != null);
  if (items.length) return { ok: true, items };
  const failed = parts.find((p) => p.status === 'rejected');
  return { ok: false, error: failed ? failed.reason?.message || '지수 조회 실패' : '빈 응답' };
});

// 지수 줄의 원/달러. 야후 KRW=X 의 지금 값과 전일 종가. 30분 넘게 값이 그대로면 쉬는 중으로 본다(주말).
async function usdKrwItem() {
  const res = await netFetch('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=1d&interval=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = (await res.json())?.chart?.result?.[0]?.meta;
  const value = Number(m?.regularMarketPrice);
  const prev = Number(m?.chartPreviousClose);
  if (!(value > 0) || !(prev > 0)) return [];
  const at = Number(m.regularMarketTime) * 1000;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return [{
    code: 'USDKRW', name: '원/달러', value, change: value - prev, pct: ((value - prev) / prev) * 100,
    open: null, high: num(m.regularMarketDayHigh), low: num(m.regularMarketDayLow),
    isOpen: Number.isFinite(at) && Date.now() - at < 30 * 60000,
    tradedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
  }];
}

// --- 시장 지표 화면(market:extras) ---------------------------------------------------------
// 순위 패널의 '지표' 가 열려 있을 때 1분마다 묻는다. 여덟 부분은 따로 받아 하나가 실패해도 나머지는 온다(실패한 부분은 null,
// 이유는 errors[부분]).
// - 외국인 현물 · 선물 수급: 네이버 모바일 지수 수급(trend?bizdate=) — 날짜를 주면 그날 값이다. 휴장일 · 미래 날짜도 오류 없이
//   0 을 줘서(2026-10-27 실측 10/25 토 · 10/28) 코스피 일봉에 있는 날만 묻는다. 지난 날과 20:30 뒤의 오늘은 확정이라 기억한다.
// - 코스피 · 코스피200 선물 · 코스피200 현물 일별 종가: 네이버 지수 일봉(최근 30일) — 장중에는 오늘 행이 있다.
// - 코스피200 현물 오늘 1분 종가: 네이버 지수 분봉 — 20분 늦은 선물과 같은 시각의 현물로 베이시스를 낸다.
// - 미국 HY OAS(ICE BofA US High Yield OAS, %): FRED CSV(키 없음, 최근 3년, 1~2영업일 늦다, Electron net.fetch) — 6시간 기억한다.
// - 장중 수급: 다음 금융(daumIntraday, 아래).
// 이때부터 오늘 수급을 확정으로 본다(장중 값은 잠정치). 예전 18:00 — 2026-09-14 KRX 애프터마켓(16:00~20:00)이 생긴 뒤 그날
// 투자자별 값이 20:00 까지 바뀌는지 확인하지 못해, 어느 쪽이든 틀리지 않게 20:30 으로 늦췄다(2026-11-02 사용자 결정)
const FLOW_FINAL = '2030';
const FLOW_DAYS = 10;        // 수급을 묻는 거래일 수
const HYOAS_TTL = 6 * 3600000; // FRED 시리즈(HY OAS · 장단기 금리차)를 다시 묻지 않는 시간
const flowCache = new Map(); // '경로|YYYYMMDD' → 확정된 그날 수급
const fredCache = new Map(); // FRED 시리즈 id → { at, rows }

// 그날 외국인 · 기관 · 개인 순매수. path 는 'KOSPI'(현물) · 'FUT'(코스피200 선물). 모양이 다르거나 다른 날의 값이 오면 null.
// 값은 '+4,080' · '-9,811' · '' 모양의 글자다(numberOrNull: 4080 · -9811 · null).
async function naverFlow(path, date, now) {
  const key = `${path}|${date}`;
  if (flowCache.has(key)) return flowCache.get(key);
  const j = await naverJson(`https://m.stock.naver.com/api/index/${path}/trend?bizdate=${date}`);
  const foreign = j && j.bizdate === date ? numberOrNull(j.foreignValue) : null;
  if (foreign == null) return null;
  const inst = numberOrNull(j.institutionalValue);
  const personal = numberOrNull(j.personalValue);
  // 셋 다 0 이면 아직 없는 값이다 — 네이버는 값이 없을 때도 오류 대신 0 을 준다. 확정된 날에 한 번 온 0 을 기억하면 앱을 다시
  // 켤 때까지 연속 일수 · 판정이 틀렸다(리뷰 2026-10-27) — 빼고 기억하지 않아 다음에 다시 묻는다
  if (foreign === 0 && !inst && !personal) return null;
  const row = { date, foreign, inst, personal, final: date < kstDay(now) || kstClock(now) >= FLOW_FINAL };
  if (row.final) flowCache.set(key, row);
  return row;
}

// 지수 일별 종가(오름차순, 최근 30일) — path 'KOSPI' · 'FUT' · 'KPI200'.
async function naverIndexCloses(path, now) {
  const rows = await naverJson(`https://api.stock.naver.com/chart/domestic/index/${path}/day`
    + `?startDateTime=${kstDay(now - 30 * 86400000)}&endDateTime=${kstDay(now)}`);
  if (!Array.isArray(rows)) throw new Error('모양이 다른 응답');
  return rows.map((r) => ({ date: String(r?.localDate ?? ''), close: Number(r?.closePrice) }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

// 코스피200 현물의 오늘 1분 종가 [{ t(그 분의 시각 ms), close }] 오름차순 — 베이시스를 선물 시각에 맞출 때 쓴다. 선물(FUT)은
// 네이버가 20분 늦게 줘서 지금 현물과 빼면 그 20분 동안 움직인 만큼이 섞였다(오르는 장에서 콘탱고가 백워데이션으로 보였다).
// 장 전 · 휴장일이면 빈 배열.
async function naverMinuteCloses(path, now) {
  const day = kstDay(now);
  const rows = await naverJson(`https://api.stock.naver.com/chart/domestic/index/${path}/minute`
    + `?startDateTime=${day}0000&endDateTime=${day}2359`);
  if (!Array.isArray(rows)) throw new Error('모양이 다른 응답');
  return rows.map((r) => {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(r?.localDateTime ?? ''));
    return { t: m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`) : NaN, close: Number(r?.currentPrice) };
  }).filter((r) => Number.isFinite(r.t) && r.close > 0).sort((a, b) => a.t - b.t);
}

// FRED CSV 'observation_date,<id>' 아래 '날짜,값'. 휴일은 값이 비고(또는 '.') 건너뛴다. 최근 60개(all 이면 받은 전부 — 차트).
// 미국 HY OAS(BAMLH0A0HYM2, 약 3년치) · 장단기 금리차(T10Y2Y — 10년 − 2년, 2026-11-03 사용자 요청)를 같은 길로 받는다.
// Electron net.fetch(Chromium 네트워크)로 받고 User-Agent 는 그대로 둔다. Electron 44(10/29 올림) 안의 Node fetch 는 FRED(앞단
// Akamai)에서 답이 없어(20초 — PC 의 Node 22 는 0.2초, 헤더를 브라우저처럼 채워도 같다) 줄이 — 였고(10/27 Electron 43 에서는
// 보였다), net.fetch 에 'Mozilla/5.0' 을 달면 HTTP2 프로토콜 오류다(2026-11-02 실측).
async function fredSeries(id, now, all = false) {
  let hit = fredCache.get(id);
  if (!hit || now - hit.at >= HYOAS_TTL) {
    const res = await netFetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, {}, (u, o) => net.fetch(u, o));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.text()).split(/\r?\n/).map((line) => line.split(','))
      .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && /^-?\d+(\.\d+)?$/.test((v || '').trim()))
      .map(([d, v]) => ({ date: d.replace(/-/g, ''), value: Number(v) }));
    if (!rows.length) throw new Error('빈 응답');
    hit = { at: now, rows };
    fredCache.set(id, hit);
  }
  return all ? hit.rows : hit.rows.slice(-60);
}
const fredHyOas = (now, all) => fredSeries('BAMLH0A0HYM2', now, all);
const fredCurve = (now, all) => fredSeries('T10Y2Y', now, all);

// CNN 공포 · 탐욕 지수(지표 화면, 2026-11-03 사용자 요청) — CNN 웹페이지(edition.cnn.com/markets/fear-and-greed)가 쓰는 데이터라
// 공식 API 가 아니다(모양이 바뀌면 이 줄만 실패한다). 브라우저(Chromium)에서 열리는 것을 확인했고(2026-11-03), 같은 네트워크 스택인
// Electron net.fetch 로 받는다 — User-Agent 는 그대로(FRED 처럼, 위). fear_and_greed 의 지금 값 · 전일 종가 · 1주 · 1달 · 1년 전과,
// 1년치 기록(점마다 x ms · y — 끝은 1시간 간격)을 날마다 마지막 값으로 줄인 최근 30일. 미국 장중에 바뀌어 10분 동안 다시 묻지 않는다.
// 날마다의 기록 전부({ date, value }, 차트 ^FNG)는 fearGreedDays.
const FEARGREED_TTL = 10 * 60000;
let fearGreedCache = null;
async function loadFearGreed(now) {
  if (fearGreedCache && now - fearGreedCache.at < FEARGREED_TTL) return fearGreedCache;
  const res = await netFetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {}, (u, o) => net.fetch(u, o));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const fg = j?.fear_and_greed;
  if (!Number.isFinite(fg?.score)) throw new Error('모양이 다른 응답');
  const num = (v) => (Number.isFinite(v) ? v : null);
  const byDay = new Map();
  for (const p of j?.fear_and_greed_historical?.data || []) {
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) byDay.set(new Date(p.x).toISOString().slice(0, 10).replace(/-/g, ''), p.y);
  }
  const v = { score: fg.score, rating: String(fg.rating || ''), at: typeof fg.timestamp === 'string' ? fg.timestamp : null,
    prevClose: num(fg.previous_close), week: num(fg.previous_1_week), month: num(fg.previous_1_month), year: num(fg.previous_1_year),
    days: [...byDay.values()].slice(-30) };
  fearGreedCache = { at: now, v, rows: [...byDay].map(([date, value]) => ({ date, value })) };
  return fearGreedCache;
}
const cnnFearGreed = async (now) => (await loadFearGreed(now)).v;
const fearGreedDays = async (now) => (await loadFearGreed(now)).rows;

// 지표 화면의 줄 중 날마다 값 하나만 있는 것의 차트(앱이 붙인 기호, 2026-11-03 사용자 요청) — 기호 → 날마다의 { date, value }.
// 야후 · 네이버에는 없다. 일봉(1M · 3M · 1Y · 3Y)과 전체만 — 분봉이 없다(yf:chart).
const DAILY_ONLY = { '^FNG': fearGreedDays, '^HYOAS': (now) => fredHyOas(now, true), '^T10Y2Y': (now) => fredCurve(now, true) };

// 장중 수급(지표 화면의 '코스피 장중 수급' 묶음, 2026-10-30 사용자 요청) — 다음 금융. 네이버 수급(trend?bizdate=)은 날짜마다 값 하나라
// 장중 흐름이 없다. 2026-10-30 브라우저에서 확인한 주소 셋을 함께 받는다(하나가 실패하면 그것만 null, 셋 다면 실패):
//  - 코스피 현물 시간별(investor/KOSPI/times) — 그날 09:01 부터 1~2분 간격 누적 순매수(원, 최신이 앞), 세부(details)에 연기금 · 기타법인
//  - 코스피200 선물 시간별(investor/future/times&type=PRICE) — 08:45 부터 누적 순매수(원). 기본값은 계약수인데 1계약이 약 2.2억 원이라
//    현물(억 원)과 나란히 놓으면 작아 보여 견주기 어려웠다(사용자 요청으로 금액 — 15:12 외국인 705계약 = 1,590.7억)
//  - 프로그램(domestic/quotes?summary=true) — 코스피(KGG01P)의 지금 누적 순매수(원) 하나. 장중 흐름은 없다
// 모두 억 원으로 바꾸고 시각 오름차순. 순매수는 모두 더하면 0 이라(산 만큼 판다) 합이 총량의 5% 넘게 어긋난 줄은 뺀다 —
// 한 칸이 0 으로 빈 줄이 섞여 왔다(2026-10-30 14:01 개인 0, 외국인 -12,854억). Referer 가 없으면 막는 곳이라 브라우저처럼 붙인다.
const DAUM_API = 'https://finance.daum.net/api';
const daumJson = async (url) => {
  const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.daum.net/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const balanced = (v) => Math.abs(v.reduce((a, x) => a + x, 0)) <= 0.05 * v.reduce((a, x) => a + Math.abs(x), 0);

async function daumIntraday() {
  const list = (a) => { if (!Array.isArray(a)) throw new Error('모양이 다른 응답'); return a; };
  const parts = await Promise.allSettled([
    daumJson(`${DAUM_API}/investor/KOSPI/times?market=KOSPI&page=1&perPage=400&details=true&pagination=true`).then((j) => list(j?.data)),
    daumJson(`${DAUM_API}/investor/future/times?page=1&perPage=400&terms=times&pagination=true&type=PRICE`).then((j) => list(j?.data)),
    daumJson(`${DAUM_API}/domestic/quotes?summary=true&changeStatistics=true`).then(list),
  ]);
  if (parts.every((p) => p.status === 'rejected')) throw parts[0].reason;
  const [spotRows, futRows, quotes] = parts.map((p) => (p.status === 'fulfilled' ? p.value : null));
  const at = (r) => Date.parse(`${String(r?.date ?? '').replace(' ', 'T')}+09:00`);
  const fin = (v) => (Number.isFinite(v) ? v : null);
  // 줄 → { t, individual, foreign, institution, pension, corp }(억 원). v 는 개인 · 외국인 · 기관 · 기타법인(· 기타외국인) — 합이 0 이어야 한다
  const series = (rows, pick) => (rows ? rows.map((r) => {
    const t = at(r);
    const p = pick(r);
    return Number.isFinite(t) && p.v.every(Number.isFinite) && balanced(p.v)
      ? { t, individual: p.v[0] / 1e8, foreign: p.v[1] / 1e8, institution: p.v[2] / 1e8, pension: p.pension == null ? null : p.pension / 1e8,
        corp: p.v[3] / 1e8 } : null;
  }).filter(Boolean).sort((a, b) => a.t - b.t) : null);
  const spot = series(spotRows, (r) => {
    const d = r?.details || {};
    return { pension: fin(d.PENSION_FUND), v: [r?.individualStraightPurchasePrice, r?.foreignStraightPurchasePrice,
      r?.institutionStraightPurchasePrice, d.ETC_CORPORATION, d.ETC_FOREIGN ?? 0] };
  });
  const fut = series(futRows, (r) => ({ pension: fin(r?.pensionFundInvestment),
    v: [r?.privateSettlement, r?.foreignSettlement, r?.institutionalSettlement, r?.etcCorporationSettlement] }));
  const kospi = quotes ? quotes.find((q) => q?.symbolCode === 'KGG01P') : null;
  const program = fin(kospi?.investorSummary?.programStraightPurchasePrice);
  return { spot, fut, program: program == null ? null : program / 1e8 };
}

// 지난 장중 수급(2026-11-18 사용자 요청: 당일만이 아니라 이전도) — 다음 금융은 그날 것만 준다(날짜를 붙여도 오늘 것, 같은 날
// 브라우저 확인). 그래서 마감 뒤 받은 그날 것을 날마다 따로 파일(intraday.json, 설정 옆)에 모아 둔다. 현물(09:01~) · 선물(08:45~)은
// 새 날로 바뀌는 시각이 달라 줄마다 마지막 시각의 날에 둔다. 오늘 장중(16:00 전)의 것은 아직 다 차지 않아 두지 않는다. 최근 INTRADAY_KEEP 일.
// Store 는 처음 쓸 때 만든다 — 창을 띄우기 전 설정 파일 처리(openStore)와 섞이지 않게.
const INTRADAY_KEEP = 20;
const INTRADAY_DONE = '1600'; // 선물이 15:45 에 끝난다 — 이 뒤에 받은 그날 것은 다 찬 것
let intradayStore = null;
const intradayDays = () => (intradayStore ||= new Store({ cwd: storeOptions.cwd, name: 'intraday', clearInvalidConfig: true }));
const intradayKept = {}; // 'spot' | 'fut' → 마지막으로 둔 줄의 시각 — 같으면 파일을 다시 읽고 쓰지 않는다
function keepIntraday(it, now) {
  try {
    const fresh = ['spot', 'fut'].map((venue) => {
      const rows = it && it[venue];
      const last = rows && rows.length ? rows[rows.length - 1].t : null;
      const day = last == null ? null : kstDay(last);
      return last == null || intradayKept[venue] === last || (day === kstDay(now) && kstClock(now) < INTRADAY_DONE) ? null : { venue, rows, last, day };
    }).filter(Boolean);
    if (!fresh.length) return;
    const days = { ...(intradayDays().get('days') || {}) };
    for (const f of fresh) days[f.day] = { ...days[f.day], [f.venue]: f.rows };
    intradayDays().set('days', Object.fromEntries(Object.keys(days).sort().slice(-INTRADAY_KEEP).map((d) => [d, days[d]])));
    for (const f of fresh) intradayKept[f.venue] = f.last;
  } catch (e) {
    console.warn('지난 장중 수급 저장 실패', e.message);
  }
}
// 지표 화면을 열지 않은 날도 모이게 장이 끝난 뒤(16:00 ~ 다음 날 08:40) 한 번 받는다 — 10분마다 보고, 그 밤에 둘 다 받았으면 다시 묻지 않는다
let intradayNight = null;
async function captureIntraday() {
  const now = Date.now();
  const clock = kstClock(now);
  const night = clock >= INTRADAY_DONE ? kstDay(now) : clock < '0840' ? kstDay(now - 86400000) : null;
  if (!night || night === intradayNight) return;
  try {
    const it = await daumIntraday();
    keepIntraday(it, now);
    if (it.spot && it.spot.length && it.fut && it.fut.length) intradayNight = night;
  } catch (e) {
    console.warn('지난 장중 수급 받기 실패', e.message);
  }
}
ipcMain.handle('market:intradayPast', () => ({ days: intradayDays().get('days') || {} }));

// --- 외국인 현물 · 선물 수급의 긴 이력(market:flowHistory) ---------------------------------------
// 수급 확대 차트에서 1M 이상을 고를 때만 묻는다(2026-11-16 사용자 요청: 더 길게 보고 싶다). 다음 금융의 투자자별 일별 값 —
// 요청 한 번에 2016-05 부터 온다(같은 날 확인: 현물 2,579일 · 선물 2,578일, 오늘 행 포함). 네이버는 하루에 요청 하나라 열흘치만
// 받는다(FLOW_DAYS). 웹페이지가 쓰는 데이터라(공식 API 아님) 막히거나 모양이 바뀔 수 있다 — 두 부분을 따로 받고, 둘 다 받았을
// 때만 10분 기억한다. 값은 원 → 억 원, 날짜 오름차순, 모양은 market:extras 의 spotFlows · futFlows 와 같다({ date, foreign, final }).
// 지표 화면의 수급 줄 · 데드캣 점검은 그대로 네이버 열흘치를 쓴다(출처가 달라 값이 조금 다를 수 있다).
const FLOW_HISTORY_TTL = 10 * 60000;
let flowHistory = null; // { at, d }
ipcMain.handle('market:flowHistory', async () => {
  const now = Date.now();
  if (flowHistory && now - flowHistory.at < FLOW_HISTORY_TTL) return flowHistory.d;
  const today = kstDay(now);
  const rows = (url, field) => daumJson(url).then((j) => {
    if (!Array.isArray(j?.data)) throw new Error('모양이 다른 응답');
    return j.data.map((r) => {
      const date = String(r?.date ?? '').slice(0, 10).replace(/-/g, '');
      return /^\d{8}$/.test(date) && Number.isFinite(r[field])
        ? { date, foreign: r[field] / 1e8, final: date < today || kstClock(now) >= FLOW_FINAL } : null;
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  });
  const parts = await Promise.allSettled([
    rows(`${DAUM_API}/investor/KOSPI/days?market=KOSPI&page=1&perPage=3000&pagination=true`, 'foreignStraightPurchasePrice'),
    rows(`${DAUM_API}/investor/future/days?page=1&perPage=3000&terms=days&pagination=true&type=PRICE`, 'foreignSettlement')]);
  if (parts.every((p) => p.status === 'rejected')) return { ok: false, error: parts[0].reason?.message || '수급 이력 조회 실패' };
  const d = { ok: true, errors: {} };
  ['spotFlows', 'futFlows'].forEach((name, i) => {
    d[name] = parts[i].status === 'fulfilled' ? parts[i].value : null;
    if (parts[i].status === 'rejected') d.errors[name] = parts[i].reason?.message || '요청 실패';
  });
  if (!Object.keys(d.errors).length) flowHistory = { at: now, d };
  return d;
});

ipcMain.handle('market:extras', async () => {
  const now = Date.now();
  const kospi = naverIndexCloses('KOSPI', now);
  // 날마다 따로 — 하루가 실패하거나 모양이 다르면 그날만 빠지고, 모두 실패하면 그 부분이 실패다
  const flows = (path) => kospi.then(async (days) => {
    const got = await Promise.allSettled(days.slice(-FLOW_DAYS).map((d) => naverFlow(path, d.date, now)));
    if (got.length && got.every((g) => g.status === 'rejected')) throw got[0].reason;
    return got.map((g) => (g.status === 'fulfilled' ? g.value : null)).filter(Boolean);
  });
  const parts = await Promise.allSettled([flows('KOSPI'), flows('FUT'), kospi, naverIndexCloses('FUT', now), fredHyOas(now),
    naverIndexCloses('KPI200', now), // 코스피200 현물 일별 종가 — 5일 변화 · 날마다의 베이시스(선물 종가 - 현물 종가)
    naverMinuteCloses('KPI200', now), // 오늘 1분 종가 — 장중 베이시스를 20분 늦은 선물의 시각에 맞춘다
    daumIntraday().then((it) => { keepIntraday(it, now); return it; }), // 장중 수급(현물 · 선물 · 프로그램) — 마감 뒤 것은 모아 둔다
    cnnFearGreed(now),
    fredCurve(now)]); // 미국 장단기 금리차(10년 − 2년)
  if (parts.every((p) => p.status === 'rejected')) {
    return { ok: false, error: parts[0].reason?.message || '시장 지표 조회 실패' };
  }
  // 실패한 부분은 null, 그 이유는 errors[부분] — 지표 화면이 빈 줄의 메모에 적는다(2026-11-02)
  const names = ['spotFlows', 'futFlows', 'kospiDays', 'futDays', 'hyOas', 'k200Days', 'k200Min', 'intraday', 'fearGreed', 'curve'];
  const out = { ok: true, errors: {} };
  parts.forEach((p, i) => {
    out[names[i]] = p.status === 'fulfilled' ? p.value : null;
    if (p.status === 'rejected') out.errors[names[i]] = p.reason?.message || '알 수 없는 오류';
  });
  return { ...out, at: new Date(now).toISOString() };
});

// 업종. 네이버 한글 업종을 먼저 쓰고, 네이버에 없으면 야후 영어 업종을 쓴다.
// 야후 값은 영어이고 검증용 99종목 중 21종목이 비어 있었으며(SK하이닉스 · MSFT …), 국내 분류가
// 어색했다(삼성전자 Consumer Electronics) — 네이버는 국내 업종 79개(삼성전자 반도체와반도체장비),
// 미국은 네이버 해외 업종(애플 전화 및 소형 장치)을 준다(2026-10-14 실측).
// ETF 는 네이버가 "기타" 만 주므로 쓰지 않는다(야후도 값이 없어 지금처럼 비운다).
// 네이버 요청이 실패하면 실패로 끝낸다 — 야후 영어로 넘어가면 렌더러가 그 값을 세션 내내 캐시한다.
const naverJson = async (url) => {
  const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// 네이버 국내 업종 번호 → 이름(79개). 한 번 받으면 앱이 켜져 있는 동안 쓴다. 빈 목록은 기억하지 않는다 — 기억하면
// 네이버가 한 번 빈 채로 준 것으로 앱이 켜져 있는 동안 모든 국내 종목이 야후 영어 업종이 된다(실패로 끝내고 다시 묻는다).
let naverIndustryNames = null;
async function naverIndustryName(no) {
  if (!naverIndustryNames) {
    const j = await naverJson('https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100');
    const names = new Map((j.groups || []).map((g) => [Number(g.no), g.name]));
    if (!names.size) throw new Error('업종 목록 없음');
    naverIndustryNames = names;
  }
  return naverIndustryNames.get(Number(no)) || null;
}

// 네이버 한글 업종. 없으면 null(→ 야후).
async function naverIndustry(symbol) {
  const kr = KR_RE.exec(symbol);
  if (kr) {
    const d = await naverJson(`https://m.stock.naver.com/api/stock/${kr[1]}/integration`);
    return d.stockEndType === 'stock' && d.industryCode != null ? naverIndustryName(d.industryCode) : null;
  }
  const code = await naverUsCode(symbol);
  if (!code) return null;
  const b = await naverJson(`https://api.stock.naver.com/stock/${encodeURIComponent(code)}/basic`);
  return b.stockEndType === 'stock' ? b.industryCodeType?.industryGroupKor || null : null;
}

// 미국: 앱에는 야후 티커(AAPL)만 있다 — 네이버 검색으로 네이버 코드(AAPL.O)를 찾는다(업종 · 실시간 시세).
// 정확히 같은 티커만 쓴다. BRK-B(네이버 BRK.B)처럼 표기가 다르면 못 찾고 야후로 간다.
// 찾은 코드는 앱이 켜져 있는 동안, 못 찾음은 1시간만 기억한다 — 네이버가 잠깐 빈 결과를 줘도 재시작까지 그 종목의
// 시간외 시세 · 지표 · 일정 · 한글 업종을 잃지 않게. 요청이 실패하면 기억하지 않는다.
const NAVER_MISS_TTL = 3600000;
const naverUsCodes = new Map(); // symbol -> { code(없으면 null), at }
async function naverUsCode(symbol) {
  const known = naverUsCodes.get(symbol);
  if (known && (known.code || Date.now() - known.at < NAVER_MISS_TTL)) return known.code;
  const s = await naverJson('https://m.stock.naver.com/front-api/search/autoComplete'
    + `?query=${encodeURIComponent(symbol)}&target=stock`);
  const hit = (s.result?.items || []).find((i) => i.nationCode === 'USA' && i.code === symbol);
  const code = hit?.reutersCode || null;
  naverUsCodes.set(symbol, { code, at: Date.now() });
  return code;
}

// 야후 업종(영어). quoteSummary(assetProfile)는 크럼 토큰을 요구해 막히는데,
// 검색 엔드포인트는 심볼로 조회하면 인증 없이 sector/industry 를 같이 준다.
async function yahooIndustry(symbol) {
  const url = 'https://query1.finance.yahoo.com/v1/finance/search'
    + `?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=0`;
  const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hit = (await res.json())?.quotes?.[0];
  // 심볼이 정확히 맞을 때만 쓴다. 검색이라 엉뚱한 종목이 1등으로 올 수 있다.
  if (!hit || hit.symbol !== symbol) return { sector: null, industry: null };
  return { sector: hit.sectorDisp || null, industry: hit.industryDisp || null };
}

ipcMain.handle('yf:sector', async (_e, symbol) => {
  if (!SYMBOL_RE.test(String(symbol ?? ''))) return { ok: false, error: '잘못된 요청' };
  try {
    const kor = await naverIndustry(symbol);
    if (kor) return { ok: true, sector: null, industry: kor };
    return { ok: true, ...(await yahooIndustry(symbol)) };
  } catch (err) {
    return { ok: false, error: err.message || '업종 조회 실패' };
  }
});

// ---- 지표 보기(차트 대신 보는 화면) ------------------------------------------------
// 국내: 네이버 종목 상세(가치 지표 · 컨센서스 · 실적 일정 · 동종 업종 · ETF 지표) · 투자자별 매매동향(20일) ·
// 분기 실적 · KRX 실시간 거래량 · 주주 구성(기업정보). 미국: 네이버 해외 종목 정보 · 상세(컨센서스 · 동종 업종) · 분기 실적.
// 요청은 따로 받아 하나가 실패하면 그 칸만 비운다(전부 실패하면 ok:false). 응답 모양은 2026-10-16 실측
// (tests/fixtures/naver-detail-20261016.json). 렌더러가 지표 화면을 열었을 때만 부른다.
//
// 오늘 거래량은 KRX 실시간이다 — 종목 상세의 거래량은 NXT 를 더한 값이라(삼성전자 10/16 2,122만 = KRX 1,179만 +
// NXT 952만) 야후 일봉 · 매매동향의 날짜별 거래량(KRX, 둘이 같다)으로 낸 평균과 견주면 배수가 부푼다.
// NXT 포함 거래량은 totalVolume 으로 따로 둔다.
const DETAIL_VALUATION = [['per', 'PER'], ['cnsPer', '추정 PER'], ['pbr', 'PBR'], ['eps', 'EPS'], ['bps', 'BPS'],
  ['dividendYieldRatio', '배당수익률'], ['dividend', '주당배당금'], ['exDividendAt', '배당락일']];
// 네이버 숫자 글자 → 숫자. '%' 를 뗀 뒤로는 다른 곳과 같은 numberOrNull — 공백뿐인 값만 여기서 0 으로 읽던 것도 null 로 맞췄다.
const detailNum = (v) => numberOrNull(typeof v === 'string' ? v.replace(/%/g, '') : v);
// 네이버 표기('9.82배', '22,292원')는 그대로 쓴다. 값이 없다는 표기는 뺀다.
const detailInfos = (list) => {
  const map = new Map((Array.isArray(list) ? list : []).map((x) => [x.code, x.value]));
  const get = (code) => {
    const v = map.get(code);
    return v == null || ['', '-', 'N/A'].includes(String(v).trim()) ? null : String(v);
  };
  return { get, valuation: DETAIL_VALUATION.filter(([c]) => get(c)).map(([c, label]) => ({ label, value: get(c) })) };
};
// '2025.06.' · '2025.06.28' → '25.06'
const quarterTitle = (t) => String(t).replace(/^\d{2}(\d{2})\.(\d{2}).*$/, '$1.$2');
function detailQuarters(titles, rows, pickRows, unit) {
  if (!Array.isArray(titles) || !titles.length || !Array.isArray(rows)) return null;
  const out = pickRows.map(([title, label]) => {
    const r = rows.find((x) => x.title === title);
    return r && { title: label, values: titles.map((t) => detailNum(r.columns?.[t.key]?.value)) };
  }).filter(Boolean);
  if (!out.length) return null;
  return { unit, cols: titles.map((t) => ({ title: quarterTitle(t.title), estimate: t.isConsensus === 'Y' })), rows: out };
}
const detailConsensus = (c, currency) => (c && detailNum(c.priceTargetMean) != null ? {
  target: detailNum(c.priceTargetMean), high: detailNum(c.priceTargetHigh), low: detailNum(c.priceTargetLow),
  opinion: detailNum(c.recommMean), date: c.createDate || null, currency: c.currencyType?.code || currency,
} : null);
const detailPeers = (list) => (Array.isArray(list) ? list : []).slice(0, 6)
  .map((p) => ({ name: String(p.stockName ?? ''), pct: detailNum(p.fluctuationsRatio), code: String(p.itemCode ?? p.symbolCode ?? '') }))
  .filter((p) => p.name && p.pct != null);
// 요청들을 따로 받아 실패는 null 로. 전부 실패하면 첫 오류를 던진다.
async function settleAll(urls) {
  const got = await Promise.allSettled(urls.map((u) => naverJson(u)));
  if (got.every((g) => g.status === 'rejected')) throw got[0].reason;
  return got.map((g) => (g.status === 'fulfilled' ? g.value : null));
}

// 주주 구성(국내) — 네이버 금융 기업정보(WiseReport) 페이지의 주요주주 표 · 외국인지분율 · 유동비율. JSON 이 없어
// HTML 에서 뽑는다(2026-10-28 실측, tests/fixtures/wisereport-holders-20261028.json). 외국인은 이 페이지의 지분율이다 —
// 종목 상세의 외국인 값은 소진율이라 한도가 있는 종목에서 다르다(SK텔레콤 10/27 소진율 72.17% · 지분율 35.39%).
// 우선주를 물으면 회사(보통주) 페이지를 주므로 보통주 코드(common)를 같이 돌려준다. ETF 는 ETF 페이지로 넘어가 null.
// 주주 명부는 공시로만 바뀌어 종목마다 6시간 기억한다(지표 화면은 1분마다 다시 받는다). 받지 못하면 기억하지 않고
// 있던 것을 둔다 — 지난 값이 빈칸보다 낫다.
const HOLDERS_TTL = 6 * 3600000;
const holdersCache = new Map(); // 종목 코드 → { at, v }
const htmlText = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function parseHolders(html, code) {
  const at = html.indexOf('id="cTB13"');
  if (at < 0) return null;
  // 주요주주 줄: <td … title="이름"> · <td class="… num">주식수</td> · <td class="… num">지분율</td>
  const rows = [...html.slice(at, html.indexOf('</table>', at)).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, tr]) => {
    const name = /title="([^"]*)"/.exec(tr);
    const nums = [...tr.matchAll(/<td[^>]*\bnum\b[^>]*>([^<]*)<\/td>/g)].map((m) => detailNum(m[1].trim()));
    return name && nums.length >= 2 && nums[1] != null ? { name: htmlText(name[1]), pct: nums[1] } : null;
  }).filter(Boolean);
  if (!rows.length) return null;
  const date = [...html.slice(0, at).matchAll(/\[기준:\s*(\d{4})\.(\d{2})\.(\d{2})\]/g)].pop(); // 표 바로 위의 기준일
  const page = /<span class="name">[\s\S]{0,1500}?<b class="num">(\w+)<\/b>/.exec(html);
  const foreign = /외국인지분율<\/th>\s*<td[^>]*>\s*([\d.]+)%/.exec(html);
  const float = /유동비율<\/th>\s*<td[^>]*>[^<]*?\/\s*([\d.]+)%/.exec(html);
  return {
    date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
    common: page && page[1] !== code ? page[1] : null,
    foreign: foreign ? Number(foreign[1]) : null,
    float: float ? Number(float[1]) : null,
    rows: rows.slice(0, 8),
  };
}
async function krHolders(code) {
  const hit = holdersCache.get(code);
  if (hit && Date.now() - hit.at < HOLDERS_TTL) return hit.v;
  try {
    const res = await netFetch(`https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=${code}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = parseHolders(await res.text(), code);
    holdersCache.set(code, { at: Date.now(), v });
    return v;
  } catch {
    return hit ? hit.v : null;
  }
}

// 거래원(국내, 지표 보기 — 2026-10-30 사용자 요청) — 다음 금융 trader/ranks: 오늘 매수 · 매도 상위 10개 증권사(주)와 그 목록 안
// 외국계의 합. 종목의 장중 투자자별 수급은 무료 출처에 없어(네이버 · 다음 모두 날짜별) 외국계 창구로 외국인 매매를 어림한다.
// 줄마다 반대쪽 수량도 오지만 목록 밖이면 0 으로 와서(2026-10-30 실측 JP모간 매도 0) 그쪽 수량만 쓰고 0 은 뺀다. 실패하면 null.
async function krTraders(code) {
  try {
    const j = await daumJson(`${DAUM_API}/trader/ranks?symbolCode=A${code}&BidFieldName=bidAccTradeVolume&BidOrder=desc`
      + '&AskFieldName=askAccTradeVolume&AskOrder=desc&intervalType=TODAY&limit=10');
    const side = (s, k) => (Array.isArray(s?.data) ? s.data.map((r) => ({ name: String(r?.traderName ?? ''), volume: Number(r?.[k]),
      foreign: r?.isForeignInvestor === true })).filter((r) => r.name && r.volume > 0) : null);
    const buy = side(j?.BID, 'bidAccTradeVolume');
    const sell = side(j?.ASK, 'askAccTradeVolume');
    if (!buy || !sell) return null;
    const sum = (s) => (Number.isFinite(s?.foreignInvestorAskBidSum) ? s.foreignInvestorAskBidSum : null);
    return { date: String(j?.baseDate ?? '').slice(0, 10).replace(/-/g, ''), buy, sell, foreignBuy: sum(j.BID), foreignSell: sum(j.ASK) };
  } catch {
    return null;
  }
}

async function krDetail(code) {
  // 주주 구성 · 거래원은 따로 받는다 — 이것만으로는 지표 화면이 되지 않아 '전부 실패' 판정(settleAll)에 넣지 않는다
  const holders = krHolders(code);
  const traders = krTraders(code);
  const filings = daumFilings(code); // 최근 공시 — 실패하면 null(그 단락만 빠진다)
  const [I, trend, quarter, rt] = await settleAll([
    `https://m.stock.naver.com/api/stock/${code}/integration`,
    `https://m.stock.naver.com/api/stock/${code}/trend?pageSize=20`,
    `https://m.stock.naver.com/api/stock/${code}/finance/quarter`,
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
  ]);
  const info = detailInfos(I?.totalInfos);
  const etfKey = I?.etfKeyIndicator || null;
  const live = rt?.datas?.[0];
  const fin = quarter?.financeInfo;
  return {
    market: 'kr',
    kind: etfKey || I?.stockEndType === 'etf' ? 'etf' : 'stock',
    today: {
      volume: detailNum(live?.accumulatedTradingVolumeRaw ?? live?.accumulatedTradingVolume),
      at: live?.localTradedAt || null,
      totalVolume: detailNum(info.get('accumulatedTradingVolume')),
      value: info.get('accumulatedTradingValue'),
      marketValue: info.get('marketValue') || etfKey?.marketValue || null,
      foreignRate: info.get('foreignRate'),
    },
    valuation: info.valuation,
    consensus: detailConsensus(I?.consensusInfo, 'KRW'),
    trend: Array.isArray(trend) ? trend.map((r) => ({
      date: String(r.bizdate), foreign: detailNum(r.foreignerPureBuyQuant), organ: detailNum(r.organPureBuyQuant),
      individual: detailNum(r.individualPureBuyQuant), foreignRatio: detailNum(r.foreignerHoldRatio),
    })) : null,
    ir: I?.irScheduleInfo?.irScheduleDate ? { title: String(I.irScheduleInfo.title ?? ''),
      date: I.irScheduleInfo.irScheduleDate, dday: detailNum(I.irScheduleInfo.irScheduleDday) } : null,
    // 단위는 억원(삼성전자 2025.06 매출액 745,663 = 74.6조)
    quarters: detailQuarters(fin?.trTitleList, fin?.rowList, [['매출액', '매출액'], ['영업이익', '영업이익'], ['당기순이익', '당기순이익']], '억원'),
    // ETF 의 "동종 업종" 자리에는 인기 ETF(미국 S&P500 등)가 와서 업종 비교로 읽히면 틀린 정보다 — 비운다
    peers: etfKey ? [] : detailPeers(I?.industryCompareInfo),
    etf: etfKey ? {
      nav: detailNum(etfKey.nav),
      deviation: etfKey.deviationRate == null ? null : (etfKey.deviationSign === '-' ? -1 : 1) * Number(etfKey.deviationRate),
      issuer: etfKey.issuerName || info.get('issueName'),
      baseIndex: info.get('etfBaseIdx'),
      dividendYield: detailNum(etfKey.dividendYieldTtm),
    } : null,
    holders: await holders,
    traders: await traders,
    filings: recentFilings(await filings),
  };
}

async function usDetail(code) {
  const c = encodeURIComponent(code);
  const [B, I, Q] = await settleAll([
    `https://api.stock.naver.com/stock/${c}/basic`,
    `https://api.stock.naver.com/stock/${c}/integration`,
    `https://api.stock.naver.com/stock/${c}/finance/quarter`,
  ]);
  const info = detailInfos(B?.stockItemTotalInfos);
  return {
    market: 'us',
    kind: B?.stockEndType === 'etf' ? 'etf' : 'stock',
    today: {
      volume: detailNum(B?.accumulatedTradingVolumeRaw), at: B?.localTradedAt || null, totalVolume: null,
      value: info.get('accumulatedTradingValue'), marketValue: info.get('marketValue'), foreignRate: null,
    },
    valuation: info.valuation,
    consensus: detailConsensus(I?.consensusInfo, 'USD'),
    trend: null, // 투자자별 매매동향은 국내만
    ir: null,    // 네이버 해외 응답에는 실적 발표 일정이 없다
    // 단위는 USD 백만. 영업이익 대신 EBIT 를 준다.
    quarters: detailQuarters(Q?.trTitleList, Q?.rowList, [['매출액', '매출액'], ['EBIT', '영업이익(EBIT)'], ['당기순이익', '당기순이익']], 'USD 백만'),
    peers: detailPeers(I?.industryCompareInfo?.globalStocks),
    etf: null,
  };
}

// 공시 원문 — 기본 브라우저로 DART 를 연다. 접수번호만 받아 주소는 여기서 만든다(렌더러가 아무 주소나 열 수 없게).
ipcMain.handle('dart:open', (_e, no) => {
  const s = String(no ?? '');
  if (!/^\d{14}$/.test(s)) return false;
  return shell.openExternal(`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${s}`).then(() => true, () => false);
});

ipcMain.handle('naver:detail', async (_e, symbol) => {
  const s = String(symbol ?? '');
  if (!SYMBOL_RE.test(s)) return { ok: false, error: '잘못된 요청' };
  try {
    const kr = KR_RE.exec(s);
    if (kr) return { ok: true, ...(await krDetail(kr[1])) };
    if (!US_RE.test(s)) return { ok: false, error: '지표가 없는 종목' }; // 지수 · 환율
    const code = await naverUsCode(s);
    if (!code) return { ok: false, error: '네이버에 없는 종목' };
    return { ok: true, ...(await usDetail(code)) };
  } catch (err) {
    return { ok: false, error: err.message || '지표 조회 실패' };
  }
});

// ---- 관심종목 일정(목록의 실적 · 배당락 D-day) -----------------------------------------
// 렌더러가 종목마다 30분마다 부른다. 네이버 부분 — 국내는 종목 상세의 (미리 알린) 실적 발표 일정, 미국은 해외 종목 정보의
// 배당락일(네이버 해외 응답에는 실적 발표일이 없다) — 은 6시간 기억하고(예전 렌더러 주기), 국내는 다음 금융 공시 목록을 매번 본다
// (prelimEvents — 오늘 잠정실적을 30분 안에 보이려고). 일정이 없으면 빈 목록(실패가 아니다). 네이버가 실패하면 ok:false.
// 돌려주는 값: { ok, events: [{ kind: 'ir' | 'irEst' | 'irPast' | 'exdiv', title, date: 'YYYY-MM-DD' }] }
const EVENT_NAVER_TTL = 6 * 3600000;
const naverEventCache = new Map(); // 기호 → { at, events } — 실패는 기억하지 않는다

async function naverEventsOf(s, kr) {
  if (kr) {
    const ir = (await naverJson(`https://m.stock.naver.com/api/stock/${kr[1]}/integration`))?.irScheduleInfo;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ir?.irScheduleDate ?? '')) ? ir.irScheduleDate : null;
    return date ? [{ kind: 'ir', title: String(ir.title ?? '실적 발표'), date }] : [];
  }
  const code = await naverUsCode(s);
  if (!code) throw new Error('네이버에 없는 종목');
  const b = await naverJson(`https://api.stock.naver.com/stock/${encodeURIComponent(code)}/basic`);
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(detailInfos(b?.stockItemTotalInfos).get('exDividendAt') || ''); // '2026.08.10.'
  return m ? [{ kind: 'exdiv', title: '배당락일', date: `${m[1]}-${m[2]}-${m[3]}` }] : [];
}

// 다음 금융 공시 목록(최근 몇 년, { code, rows: [{ no, day, name }] }). 실패하면 null — 그 부분만 빠진다.
async function daumFilings(code) {
  try {
    const j = await daumJson(`${DAUM_API}/home/dart-filings?code=${code}`);
    return Array.isArray(j?.rows) ? j.rows : null;
  } catch {
    return null;
  }
}

// 지표 화면의 최근 공시. 응답은 최근 날부터 온다(2026-11-17 삼성전자 561건, 같은 날 안은 접수 순이 아님). 접수번호(14자리 —
// 거래소 공시 '…80…' 도 DART 에서 열린다)와 날짜가 맞는 것만 10건. 렌더러는 그 번호로 원문을 연다(dart:open).
function recentFilings(rows) {
  if (!rows) return null;
  return rows.filter((r) => /^\d{14}$/.test(String(r?.no ?? '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(r?.day ?? '')))
    .slice(0, 10).map((r) => ({ no: String(r.no), day: String(r.day), name: String(r.name ?? '') }));
}

// 잠정실적 공시로 본 일정(2026-10-30 사용자 제보 — 효성중공업은 실적 발표 일정을 미리 알리지 않고 잠정실적 · IR 안내를 같은 날
// 공시해(7/31 · 10/30) 네이버 일정이 없었고 D-day 가 뜨지 않았다). 공시 이름에 '영업(잠정)실적'이 든 것(prelimDays).
//  - 오늘 공시했으면 { kind: 'ir', title: '잠정실적 공시', date: 오늘 } — 칩은 '실적 D-day'
//  - 아니면 가장 최근에 지난 공시 { kind: 'irPast' } — 렌더러가 다음 날부터 일주일 동안 흐린 '실적 D+3' 으로 보인다
//    (EVENT_PAST_DAYS, 2026-11-02 사용자 요청 — 효성중공업이 10/30 잠정실적 뒤 11/2 에 +13% 였는데 실적 때문인지 목록에 안 보였다)
//  - 그리고 미리 알린 일정(announced)이 오늘 이후에 없을 때 작년 공시일 + 1년이 앞으로 30일 안이면 { kind: 'irEst' }(추정).
//    올해 그 분기를 이미 냈으면(그 날 45일 앞부터 오늘 사이에 공시가 있으면) 뺀다.
const PRELIM_RE = /영업\(잠정\)실적/;

// 잠정실적 공시일. 정정([기재정정] · [첨부정정])은 발표가 아니라 빼고, [첨부추가]는 원래 공시라 센다(LG에너지솔루션 7/7 은
// '[첨부추가]…' 로만 남아 있었다). 연결 공시를 내는 회사는 연결만 센다 — 현대차 · 기아 · HD현대중공업은 분기 실적(연결) 말고도
// 연결이 아닌 '영업(잠정)실적' 을 거의 매달 내(2026-11-02 점검) 그날마다 '실적 D-day' 가 떴다. 연결이 없는 회사(한화)는 별도가 분기 실적이다.
function prelimDays(rows) {
  const prelim = rows.map((r) => ({ day: String(r?.day ?? ''), name: String(r?.name ?? '') }))
    .filter((r) => PRELIM_RE.test(r.name) && !/^\[[^\]]*정정/.test(r.name) && /^\d{4}-\d{2}-\d{2}$/.test(r.day));
  const own = prelim.some((r) => r.name.includes('연결')) ? prelim.filter((r) => r.name.includes('연결')) : prelim;
  return [...new Set(own.map((r) => r.day))].sort();
}

// 네이버 IR 일정 중 실적인 것. 그 일정은 회사의 기업설명회(IR) 공시에서 온다(제목 = 개최목적, 날짜 = 일시 — 삼성전자 10/29
// '2026년 3분기 경영실적 발표' 가 그 공시와 같다). IR 공시 넷 중 셋은 증권사 컨퍼런스 · NDR 이라(대형주 14곳 2026-05~10 의 97건 중
// 74건, 2026-11-02 점검) 둘 다일 때만 실적으로 둔다(사용자 결정 — 컨퍼런스 · NDR 은 숨긴다):
//  - 제목에 '실적' 이 있다(컨퍼런스 · NDR · 간담회는 없다)
//  - 그 분기 잠정실적을 아직 내지 않았다 — 그 날 45일 앞부터 전날 사이에 잠정실적 공시가 없다. 효성중공업은 10/30 잠정실적 뒤
//    11/4~6 기관 대면 미팅을 '3분기 경영실적 발표 및 질의응답' 으로 공시해 '실적 D-2' 가 떴다(사용자 제보). 삼성전자처럼 월초
//    잠정실적 뒤의 월말 컨퍼런스콜도 빠진다 — 실적 숫자는 월초에 나왔다.
// 공시 목록을 받지 못하면(rows null) 제목만 본다.
function earningsIr(announced, rows) {
  const days = rows ? prelimDays(rows) : [];
  const at = (d) => Date.parse(`${d}T00:00:00Z`);
  return announced.filter((e) => e.kind !== 'ir' || (/실적/.test(e.title)
    && !days.some((x) => x < e.date && at(x) > at(e.date) - 45 * 86400000)));
}

function prelimEvents(rows, announced, now) {
  if (!rows) return [];
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const at = (d) => Date.parse(`${d}T00:00:00Z`);
  const today = iso(now + 9 * 3600000);
  const days = prelimDays(rows);
  if (days.includes(today)) return [{ kind: 'ir', title: '잠정실적 공시', date: today }];
  const last = days.filter((d) => d < today).pop();
  const out = last ? [{ kind: 'irPast', title: '잠정실적 공시', date: last }] : [];
  if (announced.some((e) => e.date >= today)) return out;
  const horizon = iso(at(today) + 30 * 86400000);
  for (const d of days) {
    const p = iso(Date.UTC(Number(d.slice(0, 4)) + 1, Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));
    if (p < today || p > horizon) continue;
    const from = iso(at(p) - 45 * 86400000);
    if (days.some((x) => x > from && x <= today)) continue;
    out.push({ kind: 'irEst', title: `작년 같은 분기 잠정실적 공시일(${d}) 기준 예상`, date: p });
  }
  return out;
}

ipcMain.handle('naver:events', async (_e, symbol) => {
  const s = String(symbol ?? '');
  if (!SYMBOL_RE.test(s)) return { ok: false, error: '잘못된 요청' };
  const kr = KR_RE.exec(s);
  if (!kr && !US_RE.test(s)) return { ok: false, error: '일정이 없는 종목' }; // 지수 · 환율
  try {
    const now = Date.now();
    const filings = kr ? daumFilings(kr[1]) : null; // 실패해도 던지지 않는다
    const hit = naverEventCache.get(s);
    let events = hit && now - hit.at < EVENT_NAVER_TTL ? hit.events : null;
    if (!events) {
      events = await naverEventsOf(s, kr);
      naverEventCache.set(s, { at: now, events });
    }
    const rows = await filings;
    const ir = earningsIr(events, rows); // 기억은 네이버 원본 — 공시 목록은 매번 새로 보므로 거르기는 돌려줄 때
    return { ok: true, events: [...ir, ...prelimEvents(rows, ir, now)] };
  } catch (err) {
    return { ok: false, error: err.message || '일정 조회 실패' };
  }
});

// ---- 시장 순위(헤더의 순위 버튼이 여는 패널) ------------------------------------------
// 국내: 인기 검색 · 급등 · 급락 · 거래대금(코스피 + 코스닥), 미국: 급등 · 급락 · 거래대금 · 시총 상위(나스닥 + 뉴욕).
// 네이버 순위는 거르는 매개변수가 없고, 그대로 쓰면 잡음이 위를 차지한다(2026-10-16 국내 급등 20위 중 일반 주식은
// 4개 — 나머지는 우선주 · 레버리지 ETN · ETF, 미국 급등 1위는 1달러 미만 종목, 국내 거래량 1위는 인버스 ETF). 그래서
// 급등 · 급락 · 거래대금은 시장마다 100개를 받아 거른 뒤 합쳐 정렬하고 20개만 준다:
//   국내 — 일반 주식만(stockEndType 'stock' 에 보통주 코드 끝 0: 우선주는 5 · 7 · K 로 끝난다) · 거래대금 10억 원 이상
//   미국 — 일반 주식만 · 시총 3억 달러 이상(시총 상위는 시총으로 거를 것이 없다) · 야후 기호 꼴(BRK.B 처럼 . 이 있으면 뺀다)
// 인기 검색은 사람들이 실제로 본 목록이라 거르지 않고 네이버 순서 그대로다. 미국 인기 검색은 네이버에 없다.
// 국내 업종 · 테마(industry · theme)는 번호(no)가 없으면 묶음 순위, 있으면 그 묶음 안의 종목이다. 묶음 순위는 네이버의
// 묶음 등락률 순이고 오른 · 내린 종목 수를 같이 준다 — 등락률은 평균이라 큰 종목 한두 개에 끌린다(2026-10-21
// 생명과학도구및서비스 +3.80% 인데 오른 16 · 내린 21). 그래서 5종목 미만 묶음은 뺀다(2~3종목 테마가 상위를 차지했다).
// 묶음 안의 종목은 급등처럼 거르고 등락률 순으로 줄 세운다 — 네이버는 테마 안을 등락률 순으로 주지 않는다.
const RANK_LIMIT = 20;
const RANK_GROUP_MIN = 5;        // 이보다 적은 종목의 업종 · 테마는 뺀다
const RANK_KR_MIN_VALUE = 1e9;   // 거래대금 10억 원
const RANK_US_MIN_CAP = 3e8;     // 시총 3억 달러
const RANK_KINDS = {
  kr: { search: null, up: 'up', down: 'down', value: 'priceTop', industry: 'industry', theme: 'theme' },
  us: { up: 'up', down: 'down', value: 'priceTop', cap: 'marketValue' },
};
const RANK_SORT = {
  up: (a, b) => b.pct - a.pct, down: (a, b) => a.pct - b.pct,
  value: (a, b) => b.value - a.value, cap: (a, b) => b.cap - a.cap,
};
// 네이버 순위 한 줄 → { symbol(야후 꼴), name, price, pct, value(거래대금), cap(시총), currency }. 금액은 원 · 달러.
function rankItemKr(s) {
  const market = { 0: 'KS', 1: 'KQ' }[s.sosok]; // 코스피 0 · 코스닥 1(그 밖은 받지 않는다)
  if (!market || !/^[0-9A-Z]{6}$/.test(String(s.itemCode))) return null;
  return { symbol: `${s.itemCode}.${market}`, name: String(s.stockName ?? ''), price: detailNum(s.closePriceRaw ?? s.closePrice),
    pct: detailNum(s.fluctuationsRatio), value: detailNum(s.accumulatedTradingValueRaw), cap: detailNum(s.marketValueRaw),
    currency: 'KRW', common: s.stockEndType === 'stock' && /0$/.test(s.itemCode), at: s.localTradedAt || null };
}
// 네이버 업종 · 테마 한 줄 → { no(묶음 번호), name, pct(묶음 등락률), count(종목 수), up · down(오른 · 내린 종목 수) }
function rankGroup(g) {
  const no = Number(g?.no);
  const pct = detailNum(g?.changeRate);
  if (!Number.isInteger(no) || no <= 0 || pct == null || !g.name) return null;
  return { no, name: String(g.name), pct, count: Number(g.totalCount) || 0, up: Number(g.riseCount) || 0, down: Number(g.fallCount) || 0 };
}
function rankItemUs(s) {
  const symbol = String(s.symbolCode ?? '');
  if (!US_RE.test(symbol)) return null;
  return { symbol, name: String(s.stockName ?? ''), price: detailNum(s.closePriceRaw ?? s.closePrice),
    pct: detailNum(s.fluctuationsRatioRaw ?? s.fluctuationsRatio), value: detailNum(s.accumulatedTradingValueRaw),
    cap: detailNum(s.marketValueRaw), currency: 'USD', common: s.stockEndType === 'stock', at: s.localTradedAt || null };
}

ipcMain.handle('naver:rank', async (_e, req) => {
  const { market, kind, no } = req || {};
  if (!Object.hasOwn(RANK_KINDS, market) || !Object.hasOwn(RANK_KINDS[market], kind)) return { ok: false, error: '잘못된 요청' };
  const group = kind === 'industry' || kind === 'theme';
  if (no !== undefined && !(group && Number.isInteger(no) && no > 0 && no < 1e6)) return { ok: false, error: '잘못된 요청' };
  try {
    if (group && no === undefined) {
      const d = await naverJson(`https://m.stock.naver.com/api/stocks/${kind}?page=1&pageSize=100`);
      const groups = (Array.isArray(d?.groups) ? d.groups : []).map(rankGroup)
        .filter((g) => g && g.count >= RANK_GROUP_MIN)
        .sort((a, b) => b.pct - a.pct);
      return { ok: true, market, kind, groups: groups.slice(0, RANK_LIMIT) };
    }
    let lists;
    if (kind === 'search') {
      lists = [await naverJson('https://m.stock.naver.com/api/stocks/searchTop?page=1&pageSize=20')];
    } else if (group) {
      lists = [await naverJson(`https://m.stock.naver.com/api/stocks/${kind}/${no}?page=1&pageSize=100`)];
    } else if (market === 'kr') {
      lists = await settleAll(['KOSPI', 'KOSDAQ'].map((m) => `https://m.stock.naver.com/api/stocks/${RANK_KINDS.kr[kind]}/${m}?page=1&pageSize=100`));
    } else {
      lists = await settleAll(['NASDAQ', 'NYSE'].map((ex) => `https://api.stock.naver.com/stock/exchange/${ex}/${RANK_KINDS.us[kind]}?page=1&pageSize=100`));
    }
    let items = lists.flatMap((l) => (Array.isArray(l?.stocks) ? l.stocks : []))
      .map(market === 'kr' ? rankItemKr : rankItemUs)
      .filter((i) => i && i.name && i.price != null && i.pct != null);
    const filtered = kind !== 'search';
    if (filtered) {
      items = items.filter((i) => i.common && (market === 'kr' ? i.value >= RANK_KR_MIN_VALUE : kind === 'cap' || i.cap >= RANK_US_MIN_CAP));
      items.sort(RANK_SORT[group ? 'up' : kind]); // 같은 값(상한가 30%)은 받은 순서(코스피 · 나스닥 먼저)
    }
    const at = items.map((i) => i.at).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    return { ok: true, market, kind, filtered, at,
      items: items.slice(0, RANK_LIMIT).map(({ common, at: _at, ...i }) => i) };
  } catch (err) {
    return { ok: false, error: err.message || '순위 조회 실패' };
  }
});

// 종목 검색. Yahoo 검색은 한글 쿼리에 400을 주므로 네이버를 쓴다.
// (주식·ETF 모두 한글명으로 잡히고 코스피/코스닥까지 알려준다)
// 자동완성(autoComplete)이 아니라 통합 검색이다 — 자동완성은 앞글자로만 찾아 `금융` 으로 KB금융, `바이오로직스` 로
// 삼성바이오로직스가 나오지 않았다(2026-10-20). 통합 검색은 이름 중간 글자로도 찾고, 앞글자가 맞는 · 많이 찾는
// 종목이 위다(`삼성` → 삼성전자). 다른 나라 종목이 섞여 오므로(`금융` 30개 중 국내 20) 넉넉히 받아 거른다.
ipcMain.handle('yf:search', async (_e, query) => {
  const q = String(query ?? '').slice(0, 50); // 길이 상한
  if (!q) return { ok: true, items: [] };
  const url = 'https://m.stock.naver.com/front-api/search'
    + `?q=${encodeURIComponent(q)}&target=stock&page=1&size=30`;
  try {
    const json = await naverJson(url); // 실패하면 아래 catch 가 'HTTP nnn' 을 돌려준다
    const items = (json.result?.items || [])
      .filter((i) => i.code && (i.nationCode === 'KOR' || i.nationCode === 'USA'))
      .map((i) => ({
        // 국내는 코스닥 .KQ / 코스피 .KS, 미국은 티커 그대로 (Yahoo 심볼 규칙)
        symbol: i.nationCode === 'KOR'
          ? i.code + (i.typeCode === 'KOSDAQ' ? '.KQ' : '.KS')
          : i.code,
        name: i.name,
        market: i.typeName || i.typeCode,
      }));
    return { ok: true, items: items.slice(0, 12) };
  } catch (err) {
    return { ok: false, error: err.message || '검색 실패' };
  }
});

// 성공: { ok:true, symbol, price, closes[], times[], volumes[], highs[], lows[] }
// 실패: { ok:false, error }  (렌더러에서 그대로 표시)
// 렌더러가 넘기는 값은 신뢰하지 않고 허용 목록으로 검사한다.
// (호스트는 고정이지만, 쿼리에 임의 문자열이 그대로 들어가지 않도록)
// max · 1mo 는 전체 탭이다. 야후는 max 면 묻는 봉 크기와 상관없이 기간에 따라 월봉 · 주봉 · 분기봉을
// 준다(2026-10-14 실측). 1d 로 묻지 않아야 아래 일봉용 빈 날 채우기(fillGaps)가 끼지 않는다.
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '1y', '5y', 'max']);
const INTERVALS = new Set(['5m', '30m', '1d', '1mo']);
// 지수는 야후 기호가 ^ 로 시작한다(^KS11 코스피 · ^KQ11 코스닥). 맨 앞 한 번만 받는다.
// 환율은 끝에 =X, 선물은 =F 가 붙는다(KRW=X 원/달러 · NQ=F 나스닥 100 선물 · CL=F WTI — 지수 줄에서 누르면 차트).
// = 는 그 자리 한 번만.
const SYMBOL_RE = /^\^?[A-Za-z0-9][A-Za-z0-9.\-]{0,19}(?:=[XF])?$/;
// 야후 값에 곱해 보이는 기호 — 원/엔은 한국 관례대로 100엔당 원(야후 JPYKRW=X 는 1엔당 8.298, 2026-11-12 확인)
const YF_SCALE = { 'JPYKRW=X': 100 };

// 야후는 국내 종목 일봉을 가끔 하루 통째로 비워 준다(종가 · 거래량 null). 2025-09-19 · 2026-10-12 는
// 모든 국내 종목이 비었고 1년이 지나도 채워지지 않았다(2026-10-13 확인). 비운 채 두면 차트에서 그날이
// 빠지고 이동평균 · RSI · 추세 점검이 그날 없이 계산된다 — 그날만 네이버 일봉으로 채운다.
// 네이버는 증자 · 분할 · 분배금을 지난 가격에 반영하고(수정주가) 야후 close 는 액면분할만 반영한다. 그런 종목은
// 두 값의 기준이 다르다(2026-10-13 실측: 삼성바이오로직스 2025-09-19 야후/네이버 1.053, KODEX 200 1.03~1.10).
// 그대로 넣으면 그날만 움푹 꺼지므로 빈 날 앞뒤로 가까운 날 5일씩의 야후/네이버 종가 비율 중앙값을 곱한다.
// 중앙값이라 빈 날 바로 앞날처럼 야후 값이 어긋난 하루에 끌리지 않는다. 1% 안쪽은 기준 차이가 아니라
// 날마다 한두 틱 다른 잡음이라(같은 날 국내 60종목 0.995~1.008) 거래소 종가인 네이버 값을 그대로 둔다.
// 지난 날은 바뀌지 않으므로 받은 봉(네이버에도 없던 빈 날은 null)을 '경로:YYYYMMDD' 로 기억해 다시 묻지 않는다.
// 오늘 칸은 채우지도 비율에 쓰지도 않는다 — 장중에 움직이고, renderer 가 실시간 값으로 맞춘다(loadQuote).
// 코스피 · 코스닥 지수도 같다 — 야후가 지수 일봉의 하루를 비웠다(2026-10-28 실측: ^KS11 · ^KQ11 의 10/27 null, 같은 날
// 삼성전자는 값이 있었다). 네이버 지수 일봉은 종가 · 거래량이 야후와 같아(10/19~10/26 거래량 비율 1.0) 그대로 채운다.
// 경로(item/코드 · index/KOSPI · index/KOSDAQ)는 krPath 가 정한다.
const naverDays = new Map();
const NAVER_NEAR = 5;            // 비율을 볼 빈 날 앞뒤 날 수
const NAVER_SCALE_MIN = 0.01;    // 이보다 작은 비율 차이는 잡음으로 본다
const kstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

async function fillGaps(symbol, stamps, q) {
  const code = krPath(symbol); // 'item/005930' · 'index/KOSPI'
  if (!code || !Array.isArray(q.close)) return;
  const today = kstDay(Date.now());
  const days = stamps.map((t) => kstDay(t * 1000));
  const gaps = [];
  days.forEach((d, i) => { if (q.close[i] == null && d < today) gaps.push(i); });
  const ask = gaps.filter((i) => !naverDays.has(`${code}:${days[i]}`));
  if (ask.length) {
    // 비율을 볼 앞뒤 날까지 한 번에 받는다
    const from = days[Math.max(0, ask[0] - 2 * NAVER_NEAR)];
    const to = days[Math.min(days.length - 1, ask[ask.length - 1] + 2 * NAVER_NEAR)];
    const url = `https://api.stock.naver.com/chart/domestic/${code}/day`
      + `?startDateTime=${from}0000&endDateTime=${to}2359`;
    try {
      const rows = await naverJson(url);
      for (const x of Array.isArray(rows) ? rows : []) {
        const d = String(x.localDate);
        if (d < today && Number(x.closePrice) > 0) naverDays.set(`${code}:${d}`, {
          close: Number(x.closePrice), open: Number(x.openPrice), high: Number(x.highPrice),
          low: Number(x.lowPrice), volume: Number(x.accumulatedTradingVolume) || 0,
        });
      }
      for (const i of ask) if (!naverDays.has(`${code}:${days[i]}`)) naverDays.set(`${code}:${days[i]}`, null);
    } catch { /* 지금처럼 그날을 뺀다. 기억하지 않으므로 다음 요청에서 다시 묻는다 */ }
  }
  // 비율은 채우기 전에 구한다 — 채운 날이 다른 빈 날의 비율에 섞이지 않게
  const ratio = (j) => {
    const bar = q.close[j] != null && naverDays.get(`${code}:${days[j]}`);
    return bar ? q.close[j] / bar.close : null;
  };
  const scales = gaps.map((i) => {
    const rs = [];
    for (const step of [-1, 1]) {
      for (let j = i + step, k = 0; k < NAVER_NEAR && Math.abs(j - i) <= 2 * NAVER_NEAR; j += step) {
        const r = ratio(j);
        if (r) { rs.push(r); k++; }
      }
    }
    if (!rs.length) return 1;
    rs.sort((a, b) => a - b);
    const h = rs.length >> 1;
    const mid = rs.length % 2 ? rs[h] : (rs[h - 1] + rs[h]) / 2;
    return Math.abs(mid - 1) < NAVER_SCALE_MIN ? 1 : mid;
  });
  gaps.forEach((i, g) => {
    const bar = naverDays.get(`${code}:${days[i]}`);
    if (!bar) return;
    const s = scales[g];
    for (const k of ['open', 'high', 'low', 'volume']) if (!Array.isArray(q[k])) q[k] = [];
    q.close[i] = bar.close * s; q.open[i] = bar.open * s; q.high[i] = bar.high * s; q.low[i] = bar.low * s; q.volume[i] = bar.volume;
  });
}

// --- 1D · 1W 시간외 봉 ------------------------------------------------------------
// 1D · 1W 는 정규장만 그렸다. 프리 · 애프터마켓 봉을 시각 순서대로 이어 붙이고 봉마다 세션을 단다
// (ext: 'pre' · 'after', 정규장은 null) — 렌더러가 그 구간의 배경을 옅게 칠한다. 렌더러의 정규장 / 전체
// 버튼이 정규장이면 extended 를 끄고 묻는다.
// 미국은 야후가 includePrePost 로 같이 주고, 어디까지가 정규장인지는 응답의 tradingPeriods 가 알려 준다.
// 국내는 야후가 15:30 까지만 줘서(includePrePost 도 같다) 네이버 NXT 분봉을 5분봉(1W 는 30분봉)으로 묶어 붙인다.
// NXT 는 프리(08:00~08:50) · 애프터(15:40~20:00)를 연속 매매로 연다. ETF 는 NXT 에 없어 빈 응답이다.
// NXT 에 없는 종목은 NXT 분봉이 비어 애프터가 없었다(2026-10-30 DSC인베스트먼트 241520 — 헤더는 종가대비 +290 인데 1D 전체가 15:30 에서
// 끝났다, 사용자 제보). 2026-09-14 부터 KRX 도 16:00~20:00 애프터마켓을 열어 KRX 분봉의 장 종료 칸 뒤에 그 봉이 있으므로, NXT 애프터가
// 비면 그것을 애프터로 쓴다(KRX 에 프리는 없다). NXT 에 있는 종목은 지금처럼 NXT 애프터다.
const STEP_5M = 300000;
const STEP_30M = 1800000;
const EXT_FILL_MAX = 12 * 3600000; // 이보다 긴 빈 칸은 하루를 넘는다 — 채우지 않는다(fillExtGaps)
const EXT_WINDOWS = [['pre', '0800', '0850'], ['after', '1530', '2000']];
const EXT_TTL = 30000;
const naverMinutes = new Map(); // '시장/코드|YYYYMMDD|창' → { at, bars, done }
const kstClock = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(11, 16).replace(':', '');

// 시각순으로 오는 봉 b 를 칸 목록 out 에 넣는다 — 앞 봉과 같은 칸(시각 · 시간외 여부)이면 종가 · 고 · 저 · 거래량을 이어
// 합치고, 아니면 새 칸이다. 분봉 · 일봉을 칸으로 묶는 곳이 모두 쓴다(네 곳에 같은 블록이 따로 있었다, 2026-11-05).
function pushBar(out, b) {
  const last = out[out.length - 1];
  if (last && last.time === b.time && last.ext === b.ext) {
    last.close = b.close;
    last.high = Math.max(last.high, b.high);
    last.low = Math.min(last.low, b.low);
    last.volume += b.volume;
  } else {
    out.push(b);
  }
}

// 네이버 분봉(1분) → 5분봉. 시각은 칸의 시작이다(야후 5분봉과 같다).
// 이름과 달리 accumulatedTradingVolume 은 그 1분의 거래량이다(2026-10-14 실측 — 하루 누적이 아니다).
function bucket5m(rows, session) {
  const out = [];
  const sorted = [...rows].sort((a, b) => String(a?.localDateTime).localeCompare(String(b?.localDateTime)));
  for (const r of sorted) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(r?.localDateTime ?? ''));
    const c = Number(r?.currentPrice);
    if (!m || !(c > 0)) continue;
    const at = Math.floor(Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`) / STEP_5M) * STEP_5M;
    const pick = (v) => (Number(v) > 0 ? Number(v) : c);
    pushBar(out, { time: at, open: pick(r.openPrice), high: pick(r.highPrice), low: pick(r.lowPrice), close: c,
      volume: Number(r.accumulatedTradingVolume) || 0, ext: session });
  }
  return out;
}

// 그날 한 창(프리 또는 애프터)의 5분봉. 다 지난 창(지난 날 · 끝난 시각)은 바뀌지 않으므로 계속 기억하고,
// 진행 중인 창은 30초만 쓴다(1D 차트 캐시와 같다). 실패는 기억하지 않는다. venue 는 'NXT/'(넥스트레이드) 또는 ''(KRX).
async function naverWindow(code, day, [name, from, to], now, venue = 'NXT/') {
  const key = `${venue}${code}|${day}|${name}`;
  const hit = naverMinutes.get(key);
  if (hit && (hit.done || now - hit.at < EXT_TTL)) return hit.bars;
  const rows = await naverJson(`https://api.stock.naver.com/chart/domestic/${venue}item/${code}/minute`
    + `?startDateTime=${day}${from}&endDateTime=${day}${to}`);
  const bars = bucket5m(Array.isArray(rows) ? rows : [], name);
  naverMinutes.set(key, { at: now, bars, done: day < kstDay(now) || kstClock(now) >= to });
  return bars;
}

// 5분봉을 step 칸으로 다시 묶는다(1W 30분봉). 30분 칸은 UTC 와 한국 시각에서 같은 곳에 떨어진다.
function rebucket(bars, step) {
  const out = [];
  for (const b of bars) pushBar(out, { ...b, time: Math.floor(b.time / step) * step });
  return out;
}

const toSeries = (bars) => ({
  closes: bars.map((b) => b.close), times: bars.map((b) => b.time), volumes: bars.map((b) => b.volume),
  opens: bars.map((b) => b.open), highs: bars.map((b) => b.high), lows: bars.map((b) => b.low),
  ext: bars.map((b) => b.ext || null),
});

// 국내 1D 에 그날 NXT 프리 · 애프터 봉을 붙인다. 그날 = 오늘이다 — 프리마켓이 열리면 새 하루라
// 08:00 부터는 어제 정규장이 빠진다. 오늘 시간외가 아직 없으면(08:00 전 · 휴장일) 야후 봉의 날을 쓴다.
// 1W(week)는 야후 봉의 날마다 붙이고 30분 칸으로 묶는다 — 프리마켓이 열렸는데 야후에 아직 오늘이 없으면
// 오늘 프리도 끝에 붙인다. 지난 날의 창은 끝났으니 한 번만 묻는다(naverWindow).
// 그 날들이 아닌 봉은 버린다. 네이버가 실패하면 던지고, 부르는 쪽이 정규장만 그린다.
async function withNaverExtended(code, series, now, week = false) {
  const today = kstDay(now);
  const clock = kstClock(now);
  // NXT 애프터가 비면(NXT 에 없는 종목) KRX 분봉의 장 종료 칸(naverRegular 의 끝) 뒤를 애프터로
  const window = async (day, w) => {
    const bars = await naverWindow(code, day, w, now);
    if (bars.length || w[0] !== 'after') return bars;
    return naverWindow(code, day, ['after', plusMin(krxEnd.day === day ? krxEnd.end : '1530', 5), w[2]], now, '');
  };
  const dayBars = async (day) => (await Promise.all(EXT_WINDOWS
    .filter(([, from]) => day < today || clock >= from)
    .map((w) => window(day, w)))).flat();
  let days;
  let ext;
  if (week) {
    days = [...new Set(series.times.map(kstDay))];
    if (!days.includes(today) && clock >= EXT_WINDOWS[0][1]) days.push(today);
    ext = rebucket((await Promise.all(days.map(dayBars))).flat(), STEP_30M);
  } else {
    let day = today;
    ext = await dayBars(today);
    const yahooDay = series.times.length ? kstDay(series.times[series.times.length - 1]) : null;
    if (!ext.length && yahooDay && yahooDay !== today) {
      day = yahooDay;
      ext = await dayBars(yahooDay);
    }
    days = [day];
  }
  if (!ext.length) return series;
  const bars = series.times.map((t, i) => ({ time: t, open: series.opens[i], high: series.highs[i],
    low: series.lows[i], close: series.closes[i], volume: series.volumes[i], ext: null }));
  const taken = new Set(bars.map((b) => b.time));
  return toSeries([...bars, ...ext.filter((b) => !taken.has(b.time))]
    .filter((b) => days.includes(kstDay(b.time)))
    .sort((a, b) => a.time - b.time));
}

// --- 국내 1D · 1W 정규장 봉(네이버) --------------------------------------------------
// 야후 국내 분봉은 20분 늦다 — 장 시작 뒤 20분은 1D 가 비고, 그 뒤로도 끝이 20분 전이라 현재가를 이어 붙였다.
// 네이버 KRX 1분봉은 실시간이고(2026-10-27 09:51 에 09:51 봉), 같은 5분 칸의 종가 · 고가 · 저가가 야후와 같다.
// 종목은 15:20~15:29(종가 동시호가)에 봉이 없고 15:30 봉이 공식 종가, 15:40 부터는 시간외 봉이다. 코스피 지수는
// 15:32 봉이 공식 종가다(2026-10-26 5469.47). 그래서 정규장은 장 종료 칸(종료 시각 + 5분 앞)까지다. 종료 시각은
// 그날 네이버가 알려 준 값이다(수능일은 늦다, noteKrxEnd). 시가 · 종가 동시호가 거래량은 09:00 · 15:30 봉에 담긴다
// (야후는 시가 동시호가를 뺐다). 날: 오늘 정규장 봉이 있으면 오늘, 없으면(장 전 · 휴장) 앞 거래일 — 1W 는 최근
// 다섯 거래일(네이버 일봉의 날짜). 지난 날은 바뀌지 않으므로 한 번만 묻는다. 실패하거나 비면 부르는 쪽이 야후로 그린다.
// 코스피200 현물 · 선물(시장 지표 화면의 줄, ^KS200 · ^KS200F — 선물은 앱이 붙인 기호)도 같은 분봉이다(NAVER_ONLY).
const KR_INDEX_PATH = { '^KS11': 'index/KOSPI', '^KQ11': 'index/KOSDAQ', '^KS200': 'index/KPI200', '^KS200F': 'index/FUT' };
// 코스피200 선물의 정규장은 08:45~15:45 — 15:35 에 자르면 마지막 10분이 빠진다. 시작 앞은 뺀다 — 야간 거래(18:00~다음 날
// 06:00) 봉이 그날 날짜로 섞여 와도(섞이는지는 확인하지 못했다) 정규장 앞에 붙지 않게.
const KR_HOURS = { 'index/FUT': ['0845', '1545'] };
const krPath = (symbol) => {
  const m = KR_RE.exec(symbol);
  return m ? `item/${m[1]}` : KR_INDEX_PATH[symbol] || null;
};
let krxEnd = { day: null, end: '1530' }; // 그날 정규장 종료 시각 'HHMM'. 모르는 날은 15:30
const naverRegularBars = new Map(); // '경로|YYYYMMDD' → { at, bars, done }
// 진행 중인 오늘 봉은 10초만 쓴다 — 렌더러 차트 캐시(1D 30초) 위에 30초를 더 겹치면 최대 1분 늦었다. 한 갱신에서
// 1D · 1W · 시간외가 같은 날을 겹쳐 묻는 것만 막는다.
const REGULAR_TTL = 10000;
const naverTradingDays = new Map(); // 경로 → { day(받은 날), days(그 앞 거래일들) }
const plusMin = (hhmm, m) => {
  const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2)) + m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}${String(t % 60).padStart(2, '0')}`;
};

// 오늘 정규장이 몇 시에 끝나는지 — 지수 응답의 거래소 정보(종목 응답의 stockExchangeType 과 같은 KS 거래소 값).
// 지수 줄이 갱신마다 먼저 받으므로 차트보다 앞선다.
function noteKrxEnd(ds) {
  const end = ds.map((d) => d?.stockExchangeType?.endTime).find((t) => /^\d{4}$/.test(t || ''));
  if (end) krxEnd = { day: kstDay(Date.now()), end };
}

// 그날 정규장 5분봉. 지난 날과 끝난 오늘(종료 칸 + 5분 뒤)은 기억하고, 진행 중이면 10초만 쓴다. 실패는 기억하지 않는다.
async function naverRegular(path, day, now) {
  const key = `${path}|${day}`;
  const hit = naverRegularBars.get(key);
  if (hit && (hit.done || now - hit.at < REGULAR_TTL)) return hit.bars;
  const hours = KR_HOURS[path];
  const cut = plusMin(hours ? hours[1] : krxEnd.day === day ? krxEnd.end : '1530', 5); // 이 시각 앞까지가 정규장
  const rows = await naverJson(`https://api.stock.naver.com/chart/domestic/${path}/minute`
    + `?startDateTime=${day}0000&endDateTime=${day}${cut}`);
  const bars = bucket5m((Array.isArray(rows) ? rows : []).filter((r) => {
    const hm = String(r?.localDateTime ?? '').slice(8, 12);
    return hm < cut && (!hours || hm >= hours[0]);
  }), null);
  naverRegularBars.set(key, { at: now, bars, done: day < kstDay(now) || kstClock(now) >= plusMin(cut, 5) });
  return bars;
}

// 오늘 앞의 거래일들 — 네이버 일봉의 날짜. 하루에 한 번 묻는다. 3주를 보면 긴 연휴(추석)에도 다섯 날이 넘는다.
async function naverDaysBefore(path, now) {
  const today = kstDay(now);
  const hit = naverTradingDays.get(path);
  if (hit && hit.day === today) return hit.days;
  const rows = await naverJson(`https://api.stock.naver.com/chart/domestic/${path}/day`
    + `?startDateTime=${kstDay(now - 21 * 86400000)}&endDateTime=${today}`);
  const days = [...new Set((Array.isArray(rows) ? rows : []).map((r) => String(r?.localDate ?? ''))
    .filter((d) => /^\d{8}$/.test(d) && d < today))].sort();
  if (days.length) naverTradingDays.set(path, { day: today, days }); // 빈 응답은 기억하지 않는다
  return days;
}

// 국내 1D(5분봉) · 1W(30분봉)의 정규장 봉. 보일 날이 없으면 빈 배열. want 는 거래일 수 — RSI 의 앞 거래일 봉은 1D 5일치 5분봉 · 1W 10일치 30분봉.
async function naverIntraday(path, now, week, want = week ? 5 : 1) {
  const today = kstDay(now);
  const todayBars = await naverRegular(path, today, now);
  let days = todayBars.length ? [today] : [];
  if (days.length < want) days = [...(await naverDaysBefore(path, now)).slice(-(want - days.length)), ...days];
  const bars = (await Promise.all(days.map((d) => (d === today ? todayBars : naverRegular(path, d, now))))).flat();
  return week ? rebucket(bars, STEP_30M) : bars;
}

// 코스피200 현물 · 선물은 야후에 쓸 일봉이 없다 — ^KS200 은 5y · 1mo · max 모두 오늘 봉 하나뿐이고, 선물은 기호가 없다
// (2026-10-30 실측 KS200=F 404). 1D · 1W 는 위 분봉, 일봉은 네이버 지수 일봉(naverDaily)으로 그리고 실패해도 야후는 묻지 않는다.
const NAVER_ONLY = new Set(['^KS200', '^KS200F']);
const NAVER_DAILY_DAYS = { '1mo': 31, '3mo': 92, '1y': 366, '5y': 1827 }; // 기간 → 며칠 앞부터

// 네이버 지수 일봉 → 봉. 기간의 첫날부터 오늘까지(장중이면 오늘 봉이 있다), 시각은 야후 국내 일봉처럼 그날 09:00 KST(00:00 UTC).
// 전체(max)는 1990년(코스피200 기준 해)부터의 일봉을 달마다 묶는다 — 시각은 그달 1일(야후 월봉처럼).
async function naverDaily(path, range, now) {
  const from = range === 'max' ? '19900101' : kstDay(now - NAVER_DAILY_DAYS[range] * 86400000);
  const rows = await naverJson(`https://api.stock.naver.com/chart/domestic/${path}/day?startDateTime=${from}&endDateTime=${kstDay(now)}`);
  const bars = [];
  for (const r of (Array.isArray(rows) ? rows : []).slice().sort((a, b) => String(a?.localDate).localeCompare(String(b?.localDate)))) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(r?.localDate ?? ''));
    const c = Number(r?.closePrice);
    if (!m || !(c > 0)) continue;
    const pick = (v) => (Number(v) > 0 ? Number(v) : c);
    const time = Date.UTC(+m[1], m[2] - 1, range === 'max' ? 1 : +m[3]);
    pushBar(bars, { time, open: pick(r.openPrice), high: pick(r.highPrice), low: pick(r.lowPrice), close: c,
      volume: Number(r.accumulatedTradingVolume) || 0 });
  }
  return bars;
}

// --- 통합(KRX + NXT) 일봉 — 일봉 차트의 캔들 기준 '통합'(증권사 앱의 통합 캔들) -------------------------------------
// 시가는 NXT 시가(08:00 프리마켓 첫 체결), 고가 · 저가는 두 시장 하루 전체의 가장 높은 · 낮은 값, 종가는 하루 마지막 체결이다.
// 네이버 KRX 일봉의 종가가 그 값이다 — KRX 분봉 주소도 15:40~19:59 봉을 주는데 KRX 시간외는 18:00 에 끝나니, 장 마감 뒤는
// 통합 시세다(2026-11-09 실측). 2026-11-06 SK하이닉스: KRX 1,089,000 · 1,217,000 · 1,089,000 / NXT 1,172,000 · 1,216,000 ·
// 1,070,000 · 1,176,000 → 통합 1,172,000 · 1,217,000 · 1,070,000 · 1,176,000 — 증권사 앱과 같았다. 정규장 종가(1,132,000)가
// 아니므로 선 · 지표는 이것을 쓰지 않는다(캔들 모양만, 사용자 결정). NXT 거래가 없는 날(2025-03-04 전 · NXT 밖 종목)은 담지 않는다 —
// 렌더러가 그날은 KRX 캔들 그대로 둔다. 한계: NXT 프리마켓 거래가 없는 날은 NXT 시가가 09:00 뒤 첫 체결이라 증권사 앱 시가와
// 조금 다를 수 있다(일봉에는 체결 시각이 없다).
const NXT_START = '20250304';
function venueDays(krxRows, nxtRows) {
  const ohlc = (r) => {
    const v = [r?.openPrice, r?.highPrice, r?.lowPrice, r?.closePrice].map(numberOrNull);
    return v.every((x) => x > 0) ? { open: v[0], high: v[1], low: v[2], close: v[3] } : null;
  };
  const krx = new Map((Array.isArray(krxRows) ? krxRows : []).map((r) => [String(r?.localDate ?? ''), ohlc(r)]));
  const days = {};
  for (const r of Array.isArray(nxtRows) ? nxtRows : []) {
    const day = String(r?.localDate ?? '');
    const n = ohlc(r);
    if (!/^\d{8}$/.test(day) || !n || !(numberOrNull(r.accumulatedTradingVolume) > 0)) continue;
    const k = krx.get(day);
    days[day] = { open: n.open, high: Math.max(n.high, k ? k.high : n.high), low: Math.min(n.low, k ? k.low : n.low),
      close: k ? k.close : n.close };
  }
  return days;
}
ipcMain.handle('naver:venueDays', async (_e, symbol, from) => {
  const m = KR_RE.exec(String(symbol ?? ''));
  if (!m || !/^\d{8}$/.test(String(from ?? ''))) return { ok: false, error: '잘못된 요청' };
  const start = from > NXT_START ? from : NXT_START;
  const end = kstDay(Date.now());
  if (start > end) return { ok: true, days: {} };
  const q = `?startDateTime=${start}&endDateTime=${end}`;
  try {
    const [krx, nxt] = await Promise.all([naverJson(`https://api.stock.naver.com/chart/domestic/item/${m[1]}/day${q}`),
      naverJson(`https://api.stock.naver.com/chart/domestic/NXT/item/${m[1]}/day${q}`)]);
    return { ok: true, days: venueDays(krx, nxt) };
  } catch (err) {
    return { ok: false, error: err.message || '요청 실패' };
  }
});

// 국내는 NXT 시간외 봉을 붙이고, 시간외가 있으면 빈 칸을 채운다. 없으면 응답 모양은 예전 그대로(ext 없음).
async function withExt(series, krExt, now, week) {
  if (krExt) {
    try { series = await withNaverExtended(krExt[1], series, now, week); } catch { /* 정규장만 그린다 */ }
  }
  if (series.ext && series.ext.some(Boolean)) return fillExtGaps(series, week ? STEP_30M : STEP_5M);
  delete series.ext;
  return series;
}

// --- 지수 줄의 선물 · 미국채 1D(네이버) --------------------------------------------------
// 야후는 선물(NQ=F · CL=F)의 하루를 미국 동부 자정(한국 13:00, 겨울 14:00)에 새로 시작하고 10분 늦어, 그 뒤 10분쯤은
// 1D 가 비었다(2026-10-27 13:06 둘 다 0봉). 미국채(^TNX)는 미국 정규장(한국 21:20~04:00)에만 움직여 한국 낮에는 지난밤
// 차트였다. 네이버 모바일 차트(front-api/chart/pricesByPeriod, scriptChartType=day)는 선물의 하루를 거래소 하루
// (17:00 CT ~ 다음 날 16:00 CT — 1분 간격 · 누적 거래량)로, 미국채는 뉴욕 날짜 하루(약 10분 간격, 거래량 없음 — 자정이
// 지나도 새 값이 오기 전까지는 전날 하루)로 준다. 공식 API 가 아니라 네이버 모바일 페이지가 쓰는 주소라 실패하거나 비면
// 야후로 그린다. 1W · 일봉은 야후 그대로다(네이버 일별은 종가뿐이다).
const NAVER_DAY = {
  'NQ=F': { reutersCode: 'NQcv1', category: 'major', chartInfoType: 'futures' },
  'CL=F': { reutersCode: 'CLcv1', category: 'energy', chartInfoType: 'futures' },
  'BZ=F': { reutersCode: 'LCOcv1', category: 'energy', chartInfoType: 'futures' }, // 브렌트유 — 확인 전이라 비거나 실패하면 야후
  // 미국채의 뉴욕 자정은 거래와 상관없는 경계다 — 그 뒤 몇 시간은 점이 몇 개뿐이라 전날의 같은 시각 뒤(lastPriceInfos)를
  // 앞에 이어 최근 24시간을 그린다(2026-10-27 13:18 오늘 1개 · 전날 128개).
  '^TNX': { reutersCode: 'US10YT=RR', category: 'bond', chartInfoType: 'governmentBond', last24h: true },
};
const zoneFormats = new Map();

// 그 지역의 벽시계 'YYYYMMDDHHMM…' → UTC ms. 서머타임은 Intl 이 안다(Electron · Node 는 ICU 를 다 싣는다).
function zonedMs(local, zone) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(local ?? ''));
  if (!m) return NaN;
  if (!zoneFormats.has(zone)) {
    zoneFormats.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }));
  }
  const fmt = zoneFormats.get(zone);
  const offset = (t) => {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  const wall = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  return wall - offset(wall - offset(wall));
}

// 네이버 하루 차트 → 5분봉. 값(currentPrice)만 있어 시 · 고 · 저 · 종은 칸 안의 값들이다. 거래량은 하루 누적이라 앞 값과의
// 차이다(2026-10-27 WTI 348개 모두 늘기만 했다). 거래량이 없으면(미국채) 0.
function naverDayBars(list, zone) {
  const rows = list.slice().sort((a, b) => String(a?.localDateTime).localeCompare(String(b?.localDateTime)));
  const out = [];
  let cum = null;
  for (const p of rows) {
    const c = Number(p?.currentPrice);
    const t = zonedMs(p?.localDateTime, zone);
    if (!(c > 0) || !Number.isFinite(t)) continue;
    const acc = Number(p.accumulatedTradingVolume);
    const v = Number.isFinite(acc) ? (cum != null && acc >= cum ? acc - cum : acc) : 0;
    if (Number.isFinite(acc)) cum = acc;
    pushBar(out, { time: Math.floor(t / STEP_5M) * STEP_5M, open: c, high: c, low: c, close: c, volume: v, ext: null });
  }
  return out;
}

// 시간외는 거래가 드물어 칸(1D 5분 · 1W 30분)이 군데군데 빈다(SOXL 애프터 48칸 중 18칸, 2026-10-14). x축이 봉
// 순서라 그대로 두면 네 시간이 한 시간 반처럼 눌린다 — 같은 세션 안의 빈 칸을 직전 종가로 채운다(거래량 0).
// 세션이 바뀌는 곳(프리 → 정규장 → 애프터)과 하루를 넘는 빈 칸은 채우지 않는다 — 1W 에서 야후가 하루를
// 통째로 비우고 그날 프리도 없으면 애프터끼리 맞닿는다.
function fillExtGaps(s, step) {
  const bars = [];
  for (let i = 0; i < s.times.length; i++) {
    if (i > 0 && s.ext[i] && s.ext[i] === s.ext[i - 1] && s.times[i] - s.times[i - 1] < EXT_FILL_MAX) {
      const c = s.closes[i - 1];
      for (let t = s.times[i - 1] + step; t < s.times[i]; t += step) {
        bars.push({ time: t, open: c, high: c, low: c, close: c, volume: 0, ext: s.ext[i] });
      }
    }
    bars.push({ time: s.times[i], open: s.opens[i], high: s.highs[i], low: s.lows[i],
      close: s.closes[i], volume: s.volumes[i], ext: s.ext[i] });
  }
  return toSeries(bars);
}

ipcMain.handle('yf:chart', async (_e, req) => {
  const { symbol, range, interval, extended } = req || {};
  if (!SYMBOL_RE.test(String(symbol ?? '')) || !RANGES.has(range) || !INTERVALS.has(interval)) {
    return { ok: false, error: '잘못된 요청' };
  }
  // CNN 공포 · 탐욕 · 미국 HY OAS(DAILY_ONLY) — 날마다 값 하나를 시 · 고 · 저 · 종가 같은 봉으로(거래량 0). 시각은 그날
  // 00:00 UTC(네이버 일봉처럼), 전체(max)는 받은 전부를 일봉 그대로. 분봉 기간은 그릴 것이 없다.
  if (DAILY_ONLY[symbol]) {
    if (!(range === 'max' || (interval === '1d' && range in NAVER_DAILY_DAYS))) return { ok: false, error: '일별 값만 있습니다(1M 이상)' };
    try {
      const now = Date.now();
      const from = range === 'max' ? '' : kstDay(now - NAVER_DAILY_DAYS[range] * 86400000);
      const bars = (await DAILY_ONLY[symbol](now)).filter((r) => r.date >= from).map((r) => ({
        time: Date.UTC(+r.date.slice(0, 4), r.date.slice(4, 6) - 1, +r.date.slice(6)),
        open: r.value, high: r.value, low: r.value, close: r.value, volume: 0 }));
      if (!bars.length) return { ok: false, error: '데이터 없음' };
      const series = toSeries(bars);
      delete series.ext;
      return { ok: true, symbol, price: bars.at(-1).close, currency: null, week52High: null, week52Low: null, ...series };
    } catch (err) {
      return { ok: false, error: err.message || '요청 실패' };
    }
  }
  // 시간외는 1D(5분봉) · 1W(30분봉)에만 붙인다. 지수는 시간외가 없다.
  const week = range === '5d' && interval === '30m';
  const ext = extended === true && ((range === '1d' && interval === '5m') || week);
  const usExt = ext && US_RE.test(symbol);
  const krExt = ext ? KR_RE.exec(symbol) : null;
  // 지수 줄의 선물 · 미국채 1D 는 네이버 하루 차트(NAVER_DAY). 실패하거나 비면 아래 야후로 그린다.
  const nd = range === '1d' && interval === '5m' ? NAVER_DAY[symbol] : null;
  if (nd) {
    try {
      const j = await naverJson('https://m.stock.naver.com/front-api/chart/pricesByPeriod'
        + `?reutersCode=${encodeURIComponent(nd.reutersCode)}&category=${nd.category}&chartInfoType=${nd.chartInfoType}&scriptChartType=day`);
      const res = j?.result || {};
      const list = (a) => (Array.isArray(a) ? a : []);
      const bars = naverDayBars([...(nd.last24h ? list(res.lastPriceInfos) : []), ...list(res.priceInfos)], res.zoneId);
      if (bars.length) {
        // realtime: 봉이 지금까지 있다(선물은 거래소가 10분 늦게 준다) — 렌더러가 장중 마지막 봉을 지수 줄 값으로 맞춘다
        return { ok: true, symbol, price: bars.at(-1).close, currency: null, week52High: null, week52Low: null,
          realtime: true, ...(await withExt(toSeries(bars), null, Date.now(), false)) };
      }
    } catch { /* 야후로 */ }
  }
  // 국내 1D · 1W 정규장은 네이버 실시간 분봉(naverIntraday). 실패하거나 비면 아래 야후(20분 지연)로 그린다.
  // 5d · 5m 은 1D RSI 의 앞 거래일 봉(렌더러 rsiWarmFor)이다 — 야후 국내 5분봉은 15:00 뒤 봉이 없다(2026-10-29 실측 삼성전자
  // 날마다 09:00~14:55). 1W 처럼 다섯 거래일이되 30분으로 묶지 않는다. 1mo · 30m 은 1W RSI 의 앞 거래일 봉 — 열 거래일 30분봉.
  const warm = range === '5d' && interval === '5m';
  const warmWeek = range === '1mo' && interval === '30m';
  const kr = (range === '1d' && interval === '5m') || week || warm || warmWeek ? krPath(symbol) : null;
  if (kr) {
    try {
      const now = Date.now();
      const bars = await naverIntraday(kr, now, week || warmWeek, warm ? 5 : warmWeek ? 10 : undefined);
      if (bars.length) {
        const series = await withExt(toSeries(bars), krExt, now, week);
        // realtime: 봉이 지금까지 있다 — 렌더러가 1D 끝에 현재가를 덧붙이지 않는다(intradayEnd)
        return { ok: true, symbol, price: bars.at(-1).close, currency: 'KRW', week52High: null, week52Low: null,
          realtime: true, ...series };
      }
    } catch { /* 야후로 */ }
  }
  // 코스피200 현물 · 선물: 분봉이 실패했거나 일봉이면 여기서 끝난다(NAVER_ONLY)
  if (NAVER_ONLY.has(symbol)) {
    if (kr || !((interval === '1d' && range in NAVER_DAILY_DAYS) || (interval === '1mo' && range === 'max'))) {
      return { ok: false, error: '데이터 없음' };
    }
    try {
      const bars = await naverDaily(krPath(symbol), range, Date.now());
      // '빈 데이터' 는 렌더러가 "분봉이 아직 안 들어왔다" 로 읽는다(전체의 1mo 도 분봉으로 친다) — 일봉이 비는 것은 그 뜻이 아니다
      if (!bars.length) return { ok: false, error: '데이터 없음' };
      const series = toSeries(bars);
      delete series.ext;
      return { ok: true, symbol, price: bars.at(-1).close, currency: 'KRW', week52High: null, week52Low: null, ...series };
    } catch (err) {
      return { ok: false, error: err.message || '요청 실패' };
    }
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range}&interval=${interval}${usExt ? '&includePrePost=true' : ''}`;
  try {
    const res = await netFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return { ok: false, error: json?.chart?.error?.description || '데이터 없음' };
    if (interval === '1d') await fillGaps(symbol, result.timestamp || [], result.indicators?.quote?.[0] || {});

    // 거래량 · 시가 · 고가 · 저가는 close 와 같은 객체에 이미 들어있다(추가 요청 없음). close 에는 실제로 null 이 섞여
    // 나온다 → 그 봉은 뺀다. 시가 · 고가 · 저가가 비면 종가로(밴드 폭 0), 거래량이 비면 0. 열은 다른 경로처럼 toSeries 로.
    const q0 = result.indicators?.quote?.[0] || {};
    const stamps = result.timestamp || [];
    const k = YF_SCALE[symbol] || 1;
    const mul = (v) => (v == null ? null : v * k);
    const bars = [];
    (q0.close || []).forEach((c, i) => {
      if (c != null) bars.push({ time: stamps[i] * 1000, open: mul(q0.open?.[i] ?? c), high: mul(q0.high?.[i] ?? c), low: mul(q0.low?.[i] ?? c),
        close: mul(c), volume: q0.volume?.[i] ?? 0 });
    });

    let series = toSeries(bars);
    if (usExt) {
      // 정규장 구간은 날마다 하나다(1D 는 하루, 1W 는 닷새 — 2026-10-21 실측). 봉은 그날 구간의 앞이면 pre,
      // 끝부터 after. 그날 = 정규장 시작 6시간 전(프리 04:00 은 5시간 반 전)부터 끝난 뒤 5시간(애프터 20:00 은
      // 4시간 뒤)까지 — 첫날 구간 하나로 가르면 둘째 날 프리가 첫날 애프터가 된다.
      const regs = (result.meta?.tradingPeriods?.regular || []).flat()
        .filter((p) => Number.isFinite(p?.start) && Number.isFinite(p?.end));
      if (regs.length) {
        series.ext = series.times.map((t) => {
          const p = regs.find((x) => t >= x.start * 1000 - 6 * 3600000 && t < x.end * 1000 + 5 * 3600000);
          return !p ? null : t < p.start * 1000 ? 'pre' : t >= p.end * 1000 ? 'after' : null;
        });
      }
    }
    // 장 시작 직후 야후가 빈 응답이어도(20분 지연) 프리 봉은 그린다
    series = await withExt(series, krExt, Date.now(), week);
    if (!series.closes.length) return { ok: false, error: '빈 데이터' };

    return {
      ok: true,
      symbol,
      price: mul(result.meta?.regularMarketPrice) ?? bars.at(-1)?.close,
      // 52주 고저는 meta에 이미 들어있어 추가 요청이 필요 없다
      currency: result.meta?.currency ?? 'KRW',
      week52High: mul(result.meta?.fiftyTwoWeekHigh),
      week52Low: mul(result.meta?.fiftyTwoWeekLow),
      ...series,
    };
  } catch (err) {
    return { ok: false, error: err.message || '요청 실패' };
  }
});

// 전역 단축키로 표시/숨김을 토글한다. 숨긴 동안은 작업표시줄 버튼도 없어(Windows 가 감춘다) 이 단축키로 다시 띄운다.
const TOGGLE_KEY = 'CommandOrControl+Alt+S';

function registerToggle() {
  const ok = globalShortcut.register(TOGGLE_KEY, () => {
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      win.show();
      applyOnTop(); // 숨겼다 켜면 최상단 레벨이 풀리는 경우가 있다
    }
  });
  // 다른 프로그램이 이미 쓰는 조합이면 등록에 실패한다. 그때는 위젯이 숨겨질 일도 없으니 그대로 둔다.
  if (!ok) console.warn(`전역 단축키 ${TOGGLE_KEY} 등록 실패 (다른 프로그램이 사용 중일 수 있음)`);
}

// 한 번만 실행한다. 위젯이 둘 뜨면 각자 관심종목 전체를 저장해 서로 덮어쓰고(한쪽에서
// 추가한 종목이 다른 쪽 저장에 사라진다), 네이버 요청도 두 배가 된다. 두 번째 실행은 창을
// 만들지 않고 끝내고, 이미 떠 있는 창을 앞으로 가져온다 — 숨겼거나 최소화해 뒀어도.
// 잠금은 userData 경로마다 걸린다. 테스트는 --user-data-dir 로 따로 잡혀 켜 둔 위젯과 겹치지 않는다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    applyOnTop(); // 숨겼다 켜면 최상단 레벨이 풀리는 경우가 있다
  });

  app.whenReady().then(() => {
    // Windows에서 알림이 뜨려면 AppUserModelID가 필요하다
    if (process.platform === 'win32') app.setAppUserModelId('com.wuid0801.kr-stock-widget');
    // 설치본에서는 Electron 기본 메뉴를 없앤다. 테두리 없는 창이라 메뉴줄은 안 보여도 단축키는
    // 살아 있어서 Ctrl+W 는 앱을 끄고(알림도 끊긴다) Ctrl+M 은 창을 최소화하고
    // Ctrl+R 은 접힌 상태를 어긋나게 한다. 개발 실행은 새로고침 · 개발자 도구를 쓰도록 둔다.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    // 이 앱은 권한(카메라 · 마이크 · 위치 · 알림 등)이 필요한 웹 기능을 하나도 쓰지 않는다 — 요청은 모두 거절한다
    // (알림은 메인 프로세스의 Notification 이라 상관없다). Electron 은 따로 정하지 않으면 허락한다.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    createWindow();
    registerToggle();
    captureIntraday();
    setInterval(captureIntraday, 10 * 60000);
    // 깨진 설정을 옮겨 두고 처음 상태로 떴다 — 목록이 비어 보이는 까닭과 원래 파일 자리를 알린다
    if (brokenConfig && Notification.isSupported()) {
      new Notification({
        title: '설정 파일을 읽지 못했습니다',
        body: `처음 상태로 시작했습니다. 원래 파일은 ${path.basename(brokenConfig)} 로 옮겨 두었습니다.`,
      }).show();
    }
  }).catch((e) => {
    // 시작하다 실패하면 창 없이 프로세스만 남아 단일 실행 잠금을 쥔다(다시 실행해도 안 뜬다) — 알리고 끝낸다
    dialog.showErrorBox('위젯을 시작하지 못했습니다', String((e && e.stack) || e));
    app.quit();
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
