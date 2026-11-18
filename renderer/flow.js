let flowView = null;
let flowChart = null;
// 일별 수급(외국인 현물 · 선물)의 기간 — 창의 기간 버튼. 값은 개월 수: 10일(0)은 지표 화면이 받는 네이버 열흘치 그대로, 그 밖은
// 다음 금융의 긴 이력(market:flowHistory)에서 마지막 날부터 그만큼 앞까지 자른다(가격 차트의 1M · 3M · 1Y · 3Y 처럼).
const FLOW_RANGES = { '10d': 0, '1M': 1, '3M': 3, '1Y': 12, '3Y': 36 };
let flowRange = '10d'; // 마지막으로 고른 기간 — 다음에 열 때도 그 기간
// 종목 수급의 기간(2026-11-18 사용자 요청: 더 길게) — 20일(0)은 종목 지표가 받는 네이버 20거래일 그대로, 그 밖은 같은 네이버 매매동향을
// 그 기간만큼 거슬러 받은 것(stock:flowHistory — 60일씩 여러 번)을 자른다. 마지막으로 고른 기간은 시장 수급과 따로
const STOCK_FLOW_RANGES = { '20d': 0, '3M': 3, '1Y': 12, '3Y': 36 };
let stockFlowRange = '20d';
const flowRanges = (view) => (view.kind === 'stock' ? STOCK_FLOW_RANGES : FLOW_RANGES);
// 일별 수급의 주체(2026-11-18 사용자 요청: 개인 · 기관도) — 창의 고르기, 열 때마다 외국인(누른 줄이 외국인 줄이다)
const FLOW_WHO = { foreign: '외국인', personal: '개인', inst: '기관' };
// 긴 이력 — 시장('') · 종목(기호|기간)마다. 긴 기간을 고를 때만 받고 10분 기억한다. 받다 실패하면 있던 것을 두고 이유를 남긴다(loadInto).
// 종목은 고른 기간만큼만 거슬러 받아(3Y 는 요청이 열세 번 남짓) 기간마다 따로 둔다
const FLOW_HIST_TTL = 10 * 60000;
const flowHist = new Map(); // '' · '종목 기호|기간' → { at, d, error }
const flowHistLoading = new Set();
const flowLong = (view) => !!view && (view.kind === 'daily' || view.kind === 'stock') && !!flowRanges(view)[view.range];
const flowHistKey = (view) => (view.kind === 'stock' ? `${view.symbol}|${view.range}` : '');
// 앱이 모아 둔 지난 장중 수급 { days: { YYYYMMDD: { spot, fut } }, program: { YYYYMMDD: 억 원 } }(main 의 market:intradayPast)
// — 장중 수급 · 프로그램 창을 열 때마다 받는다
let intradayPast = null;

function loadFlowHistory(view = null) {
  const stock = !!view && view.kind === 'stock';
  return loadInto(flowHist, flowHistLoading, stock ? flowHistKey(view) : '',
    () => (stock ? api.stockFlowHistory(view.symbol, STOCK_FLOW_RANGES[view.range]) : api.flowHistory()), renderFlow);
}

function flowData(view, data) {
  const stock = view.kind === 'stock';
  const intraday = view.kind === 'intraday';
  const program = view.kind === 'program';
  const future = intraday ? view.venue === 'fut' : view.key === 'FUTFLOW';
  const subject = MARKET_EXTRA_NAMES[view.key] || '외국인';
  const who = Object.hasOwn(FLOW_WHO, view.who || '') ? view.who : 'foreign';
  const months = flowLong(view) ? flowRanges(view)[view.range] : 0;
  const output = {
    title: program ? '프로그램 매매 일별 · 코스피' : stock ? `${view.name || '종목'} 투자자별 수급` : intraday
      ? `${subject} · ${future ? '코스피200 선물' : '코스피 현물'}` : `${FLOW_WHO[who]} ${future ? '선물' : '현물'} 일별 수급`,
    unit: stock ? '주' : '억 원', labels: [], dates: [], datasets: [], note: '', error: null,
  };
  if (!data) return output;
  if (!data.ok) { output.error = data.error || '조회 실패'; return output; }
  const keys = stock ? ['foreign', 'organ', 'individual'] : [program ? 'value' : intraday ? INTRADAY_FIELD[view.key] : who];
  if (keys.some((key) => !key)) return output;
  const part = stock ? 'trend' : program ? 'program' : intraday ? 'intraday' : future ? 'futFlows' : 'spotFlows';
  const source = intraday ? data.intraday && data.intraday[future ? 'fut' : 'spot'] : data[part];
  output.error = data.errors && data.errors[part] || null;
  const valid = (row) => row && (intraday ? Number.isFinite(row.t) : /^\d{8}$/.test(row.date))
    && keys.some((key) => Number.isFinite(row[key]));
  const rows = (Array.isArray(source) ? source : []).filter(valid)
    .sort((left, right) => intraday ? left.t - right.t : left.date.localeCompare(right.date));
  let shown = stock && !months ? rows.slice(-20) : rows;
  if (months && rows.length) {
    // 마지막 날에서 그 개월 수만큼 앞(달력)까지 — 그날은 넣지 않는다(1M 은 한 달치)
    const last = rows[rows.length - 1].date;
    const cut = new Date(Date.UTC(+last.slice(0, 4), last.slice(4, 6) - 1 - months, +last.slice(6))).toISOString().slice(0, 10).replace(/-/g, '');
    shown = rows.filter((row) => row.date > cut);
  }
  // 날짜 이름표 — 1Y · 3Y 는 가격 차트처럼 연/월(YY/MM), 그 밖은 월/일
  const day = (row) => (months >= 12 ? `${row.date.slice(2, 4)}/${row.date.slice(4, 6)}` : mmdd(row.date));
  output.labels = shown.map((row) => intraday ? new Date(row.t + 9 * 3600000).toISOString().slice(11, 16)
    : `${day(row)}${!stock && row.final === false ? ' 잠정' : ''}`);
  output.dates = shown.map((row) => intraday ? new Date(row.t + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
    : `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}${!stock && row.final === false ? ' 잠정' : ''}`);
  // 종목의 긴 기간(3M 이상)은 날마다 크게 튀는 선이라 읽기 어려워(2026-11-18 사용자) 그 기간 첫날부터 더해 간 누적 순매수 선으로
  const cumulative = stock && months > 0;
  output.datasets = keys.map((key, index) => {
    let sum = 0;
    return { label: stock ? `${['외국인', '기관', '개인'][index]}${cumulative ? ' 누적' : ''}` : intraday ? subject : program ? '프로그램' : FLOW_WHO[who],
      data: shown.map((row) => (Number.isFinite(row[key]) ? (cumulative ? (sum += row[key]) : row[key]) : null)) };
  });
  const last = output.dates[output.dates.length - 1];
  output.note = program ? '일별 순매수(차익 · 비차익 합) · 억 원 · 다음 금융 · 앱이 마감 뒤 모아 둔 날만 · 잠정은 오늘 장중 값'
    : stock ? (months ? '기간 첫날부터 더한 누적 순매수 · 주(KRX) · 네이버 · 장중 실시간 수급이 아닙니다'
      : '일별 순매수 · 주(KRX) · 최대 20거래일 · 네이버 · 장중 실시간 수급이 아닙니다')
    : intraday ? '장중 누적 순매수 · 억 원 · 다음 금융 · 장 마감 전 잠정치'
      : `일별 순매수 · 억 원 · ${months ? '다음 금융' : '네이버'} · 잠정 표시는 당일 미확정 값`;
  if (last) output.note += ` · ${last} 기준`;
  return output;
}

// 프로그램 일별 — 앱이 모아 둔 날(intradayPast.program)에, 아직 모으지 않은 날의 지금 값(지표 화면 · 잠정)을 붙인다
function programData(extras) {
  const kept = (intradayPast && intradayPast.program) || {};
  const rows = Object.keys(kept).map((date) => ({ date, value: kept[date] }));
  const live = extras && extras.ok && extras.intraday;
  if (live && Number.isFinite(live.program) && live.programDay && !(live.programDay in kept)) rows.push({ date: live.programDay, value: live.program, final: false });
  return { ok: true, program: rows, errors: extras && extras.errors && extras.errors.intraday ? { program: extras.errors.intraday } : {} };
}

function openFlow(view) {
  flowView = { ...view, venue: view.venue || 'spot', range: view.range || (view.kind === 'stock' ? stockFlowRange : flowRange), who: 'foreign', day: '' };
  const dialog = document.getElementById('flowDialog');
  if (!dialog.open) dialog.showModal();
  renderFlow();
  if (view.kind !== 'intraday' && view.kind !== 'program') return;
  api.intradayPast().then((d) => {
    intradayPast = d;
    const days = Object.keys((d && d.days) || {}).filter((k) => /^\d{8}$/.test(k)).sort().reverse();
    document.getElementById('flowDay').innerHTML = '<option value="">오늘</option>' + days.map((k) => `<option value="${k}">${mmdd(k)}</option>`).join('');
    renderFlow();
  }).catch(console.error);
}

function clearFlow() {
  flowView = null;
  if (flowChart) { flowChart.destroy(); flowChart = null; }
}

function closeFlow() {
  document.getElementById('flowDialog').close();
  clearFlow();
}

async function refreshFlow() {
  if (!flowView) return;
  const stock = flowView.kind === 'stock';
  const long = flowLong(flowView);
  const key = flowHistKey(flowView);
  if (long ? flowHistLoading.has(key) : stock ? metricsLoading.has(flowView.symbol) : marketLoading) return;
  document.getElementById('flowRetry').disabled = true;
  if (long) await loadFlowHistory(flowView);
  else if (stock) await loadMetrics(flowView.symbol);
  else await loadMarket();
}

function renderFlow() {
  if (!flowView || !document.getElementById('flowDialog').open) return;
  const stock = flowView.kind === 'stock';
  const long = flowLong(flowView); // 일별 수급의 1M 이상 · 종목 수급의 3M 이상 — 긴 이력(다음 금융)을 쓴다
  const histKey = flowHistKey(flowView);
  const cached = long ? flowHist.get(histKey) : stock ? metricsCache.get(flowView.symbol) : marketExtras;
  const ttl = long ? FLOW_HIST_TTL : stock ? METRICS_TTL : RANK_TTL;
  if (!cached || Date.now() - cached.at >= ttl) refreshFlow();
  // 지난 날을 골랐으면 모아 둔 그날 것을 그린다 — 받는 중 · 실패 표시는 오늘 것의 상태라 보이지 않는다
  const past = flowView.kind === 'intraday' && flowView.day && intradayPast && intradayPast.days ? intradayPast.days[flowView.day] : null;
  const loading = !past && (long ? flowHistLoading.has(histKey) : stock ? metricsLoading.has(flowView.symbol) : marketLoading);
  const model = flowData(flowView, past ? { ok: true, intraday: past } : flowView.kind === 'program' ? programData(cached && cached.d) : cached && cached.d);
  const failure = model.error || !past && cached && cached.error;
  const title = document.getElementById('flowTitle');
  title.textContent = model.title;
  document.getElementById('flowNote').textContent = model.note;
  const venue = document.getElementById('flowVenue');
  venue.hidden = flowView.kind !== 'intraday';
  venue.value = flowView.venue;
  const who = document.getElementById('flowWho'); // 일별 수급에만
  who.hidden = flowView.kind !== 'daily';
  who.value = flowView.who;
  const daySel = document.getElementById('flowDay'); // 모아 둔 날이 있을 때만
  daySel.hidden = flowView.kind !== 'intraday' || daySel.options.length < 2;
  daySel.value = flowView.day;
  // 기간 버튼 — 일별 수급(외국인 현물 · 선물) · 종목 수급에만. 지금 기간을 강조한다
  const range = document.getElementById('flowRange');
  range.hidden = flowView.kind !== 'daily' && flowView.kind !== 'stock';
  range.innerHTML = range.hidden ? '' : Object.keys(flowRanges(flowView)).map((key) =>
    `<button type="button" data-range="${key}"${key === flowView.range ? ' class="on"' : ''}>${key.endsWith('d') ? `${parseInt(key, 10)}일` : key}</button>`).join('');
  document.getElementById('flowRetry').disabled = loading;
  const status = document.getElementById('flowStatus');
  status.textContent = loading ? '수급을 불러오는 중…' : failure ? `조회 실패: ${failure}${model.labels.length ? ' · 이전 데이터를 표시합니다' : ''}`
    : model.labels.length ? '' : '표시할 수급 데이터가 없습니다';
  status.hidden = !status.textContent;
  const plot = document.getElementById('flowPlot');
  plot.hidden = !model.labels.length;
  if (flowChart) { flowChart.destroy(); flowChart = null; }
  if (!model.labels.length) return;
  const canvas = document.getElementById('flowCanvas');
  canvas.setAttribute('aria-label', `${model.title}, 단위 ${model.unit}, ${model.note}`);
  const bar = flowView.kind === 'daily' || flowView.kind === 'program';
  const colors = ['--accent', '--sup-line', '--res-line'].map(cssVar);
  flowChart = new Chart(canvas, {
    type: bar ? 'bar' : 'line',
    data: { labels: model.labels, datasets: model.datasets.map((series, index) => ({ ...series,
      borderColor: colors[index], backgroundColor: bar ? series.data.map((value) => value == null ? 'transparent' : value >= 0 ? UP : DOWN) : colors[index],
      // 막대가 많으면(1M 넘게) 틈 없이 붙인다 — 틈을 두면 1px 도 안 되는 막대가 흐려진다
      ...(bar && series.data.length > 30 ? { barPercentage: 1, categoryPercentage: 1 } : {}),
      borderWidth: bar ? 0 : 1.5, pointRadius: series.data.length === 1 ? 3 : 1,
      pointHoverRadius: 3, spanGaps: false,
    })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !bar, labels: { color: cssVar('--text'), boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: {
          title: (items) => items.length ? model.dates[items[0].dataIndex] : '',
          label: (item) => `${item.dataset.label}: ${item.parsed.y > 0 ? '+' : ''}${item.parsed.y.toLocaleString('ko-KR', { maximumFractionDigits: stock ? 0 : 1 })} ${model.unit}`,
        } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar('--mute'), maxTicksLimit: 6, maxRotation: 0, font: { size: 9 } } },
        y: { beginAtZero: true, title: { display: true, text: model.unit, color: cssVar('--mute'), font: { size: 10 } },
          grid: { color: (context) => cssVar(context.tick.value === 0 ? '--mute' : '--grid') },
          ticks: { color: cssVar('--mute'), font: { size: 9 },
            callback: (value) => value.toLocaleString('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }) },
        },
      },
    },
  });
}

function bindFlow() {
  const dialog = document.getElementById('flowDialog');
  document.getElementById('flowClose').onclick = closeFlow;
  document.getElementById('flowRetry').onclick = () => refreshFlow().catch(console.error);
  document.getElementById('flowVenue').onchange = (event) => {
    if (!flowView) return;
    flowView.venue = event.target.value === 'fut' ? 'fut' : 'spot';
    renderFlow();
  };
  document.getElementById('flowWho').onchange = (event) => {
    if (!flowView) return;
    flowView.who = Object.hasOwn(FLOW_WHO, event.target.value) ? event.target.value : 'foreign';
    renderFlow();
  };
  document.getElementById('flowDay').onchange = (event) => {
    if (!flowView) return;
    flowView.day = /^\d{8}$/.test(event.target.value) ? event.target.value : '';
    renderFlow();
  };
  document.getElementById('flowRange').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button || !flowView || !Object.hasOwn(flowRanges(flowView), button.dataset.range)) return;
    flowView.range = button.dataset.range;
    if (flowView.kind === 'stock') stockFlowRange = flowView.range;
    else flowRange = flowView.range;
    renderFlow();
  };
  dialog.oncancel = (event) => { event.preventDefault(); closeFlow(); };
  dialog.onclose = () => { if (!dialog.open) clearFlow(); };
}
