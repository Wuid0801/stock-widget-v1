let flowView = null;
let flowChart = null;
// 일별 수급(외국인 현물 · 선물)의 기간 — 창의 기간 버튼. 값은 개월 수: 10일(0)은 지표 화면이 받는 네이버 열흘치 그대로, 그 밖은
// 다음 금융의 긴 이력(market:flowHistory)에서 마지막 날부터 그만큼 앞까지 자른다(가격 차트의 1M · 3M · 1Y · 3Y 처럼).
const FLOW_RANGES = { '10d': 0, '1M': 1, '3M': 3, '1Y': 12, '3Y': 36 };
let flowRange = '10d'; // 마지막으로 고른 기간 — 다음에 열 때도 그 기간
// 긴 이력 — 1M 이상을 고를 때만 받고 10분 기억한다(main 도 10분). 받다 실패하면 있던 것을 두고 이유를 남긴다(loadInto 와 같은 꼴)
const FLOW_HIST_TTL = 10 * 60000;
let flowHist = null; // { at, d, error }
let flowHistLoading = false;
const flowLong = (view) => !!view && view.kind === 'daily' && view.range !== '10d';
// 앱이 모아 둔 지난 장중 수급 { days: { YYYYMMDD: { spot, fut } } }(main 의 market:intradayPast) — 장중 수급 창을 열 때마다 받는다
let intradayPast = null;

async function loadFlowHistory() {
  if (flowHistLoading) return;
  flowHistLoading = true;
  let d;
  try {
    d = await api.flowHistory();
  } catch (e) {
    d = { ok: false, error: e.message };
  } finally {
    flowHistLoading = false;
  }
  const keep = flowHist && flowHist.d && flowHist.d.ok && !(d && d.ok);
  flowHist = { at: Date.now(), d: keep ? flowHist.d : d || { ok: false, error: '응답 없음' }, error: keep ? d && d.error || '응답 없음' : null };
  renderFlow();
}

function flowData(view, data) {
  const stock = view.kind === 'stock';
  const intraday = view.kind === 'intraday';
  const future = intraday ? view.venue === 'fut' : view.key === 'FUTFLOW';
  const subject = MARKET_EXTRA_NAMES[view.key] || '외국인';
  const output = {
    title: stock ? `${view.name || '종목'} 투자자별 수급` : intraday
      ? `${subject} · ${future ? '코스피200 선물' : '코스피 현물'}` : `외국인 ${future ? '선물' : '현물'} 일별 수급`,
    unit: stock ? '주' : '억 원', labels: [], dates: [], datasets: [], note: '', error: null,
  };
  if (!data) return output;
  if (!data.ok) { output.error = data.error || '조회 실패'; return output; }
  const keys = stock ? ['foreign', 'organ', 'individual'] : [intraday ? INTRADAY_FIELD[view.key] : 'foreign'];
  if (keys.some((key) => !key)) return output;
  const part = stock ? 'trend' : intraday ? 'intraday' : future ? 'futFlows' : 'spotFlows';
  const source = intraday ? data.intraday && data.intraday[future ? 'fut' : 'spot'] : data[part];
  output.error = data.errors && data.errors[part] || null;
  const valid = (row) => row && (intraday ? Number.isFinite(row.t) : /^\d{8}$/.test(row.date))
    && keys.some((key) => Number.isFinite(row[key]));
  const rows = (Array.isArray(source) ? source : []).filter(valid)
    .sort((left, right) => intraday ? left.t - right.t : left.date.localeCompare(right.date));
  const months = !stock && !intraday ? FLOW_RANGES[view.range] || 0 : 0;
  let shown = stock ? rows.slice(-20) : rows;
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
  output.datasets = keys.map((key, index) => ({ label: stock ? ['외국인', '기관', '개인'][index] : intraday ? subject : '외국인',
    data: shown.map((row) => Number.isFinite(row[key]) ? row[key] : null) }));
  const last = output.dates[output.dates.length - 1];
  output.note = stock ? '일별 순매수 · 주(KRX) · 최대 20거래일 · 네이버 · 장중 실시간 수급이 아닙니다'
    : intraday ? '장중 누적 순매수 · 억 원 · 다음 금융 · 장 마감 전 잠정치'
      : `일별 순매수 · 억 원 · ${months ? '다음 금융' : '네이버'} · 잠정 표시는 당일 미확정 값`;
  if (last) output.note += ` · ${last} 기준`;
  return output;
}

function openFlow(view) {
  flowView = { ...view, venue: view.venue || 'spot', range: view.range || flowRange, day: '' };
  const dialog = document.getElementById('flowDialog');
  if (!dialog.open) dialog.showModal();
  renderFlow();
  if (view.kind !== 'intraday') return;
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
  if (stock ? metricsLoading.has(flowView.symbol) : long ? flowHistLoading : marketLoading) return;
  document.getElementById('flowRetry').disabled = true;
  if (stock) await loadMetrics(flowView.symbol);
  else if (long) await loadFlowHistory();
  else await loadMarket();
}

function renderFlow() {
  if (!flowView || !document.getElementById('flowDialog').open) return;
  const stock = flowView.kind === 'stock';
  const long = flowLong(flowView); // 일별 수급의 1M 이상 — 긴 이력(다음 금융)을 쓴다
  const cached = stock ? metricsCache.get(flowView.symbol) : long ? flowHist : marketExtras;
  const ttl = stock ? METRICS_TTL : long ? FLOW_HIST_TTL : RANK_TTL;
  if (!cached || Date.now() - cached.at >= ttl) refreshFlow();
  // 지난 날을 골랐으면 모아 둔 그날 것을 그린다 — 받는 중 · 실패 표시는 오늘 것의 상태라 보이지 않는다
  const past = flowView.kind === 'intraday' && flowView.day && intradayPast && intradayPast.days ? intradayPast.days[flowView.day] : null;
  const loading = !past && (stock ? metricsLoading.has(flowView.symbol) : long ? flowHistLoading : marketLoading);
  const model = flowData(flowView, past ? { ok: true, intraday: past } : cached && cached.d);
  const failure = model.error || !past && cached && cached.error;
  const title = document.getElementById('flowTitle');
  title.textContent = model.title;
  document.getElementById('flowNote').textContent = model.note;
  const venue = document.getElementById('flowVenue');
  venue.hidden = flowView.kind !== 'intraday';
  venue.value = flowView.venue;
  const daySel = document.getElementById('flowDay'); // 모아 둔 날이 있을 때만
  daySel.hidden = flowView.kind !== 'intraday' || daySel.options.length < 2;
  daySel.value = flowView.day;
  // 기간 버튼 — 일별 수급(외국인 현물 · 선물)에만. 지금 기간을 강조한다
  const range = document.getElementById('flowRange');
  range.hidden = flowView.kind !== 'daily';
  range.innerHTML = range.hidden ? '' : Object.keys(FLOW_RANGES).map((key) =>
    `<button type="button" data-range="${key}"${key === flowView.range ? ' class="on"' : ''}>${key === '10d' ? '10일' : key}</button>`).join('');
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
  const bar = flowView.kind === 'daily';
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
  document.getElementById('flowDay').onchange = (event) => {
    if (!flowView) return;
    flowView.day = /^\d{8}$/.test(event.target.value) ? event.target.value : '';
    renderFlow();
  };
  document.getElementById('flowRange').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button || !flowView || !Object.hasOwn(FLOW_RANGES, button.dataset.range)) return;
    flowRange = flowView.range = button.dataset.range;
    renderFlow();
  };
  dialog.oncancel = (event) => { event.preventDefault(); closeFlow(); };
  dialog.onclose = () => { if (!dialog.open) clearFlow(); };
}
