let flowView = null;
let flowChart = null;

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
  const shown = stock ? rows.slice(-20) : rows;
  output.labels = shown.map((row) => intraday ? new Date(row.t + 9 * 3600000).toISOString().slice(11, 16)
    : `${mmdd(row.date)}${!stock && row.final === false ? ' 잠정' : ''}`);
  output.dates = shown.map((row) => intraday ? new Date(row.t + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
    : `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}${!stock && row.final === false ? ' 잠정' : ''}`);
  output.datasets = keys.map((key, index) => ({ label: stock ? ['외국인', '기관', '개인'][index] : intraday ? subject : '외국인',
    data: shown.map((row) => Number.isFinite(row[key]) ? row[key] : null) }));
  const last = output.dates[output.dates.length - 1];
  output.note = stock ? '일별 순매수 · 주(KRX) · 최대 20거래일 · 네이버 · 장중 실시간 수급이 아닙니다'
    : intraday ? '장중 누적 순매수 · 억 원 · 다음 금융 · 장 마감 전 잠정치'
      : '일별 순매수 · 억 원 · 네이버 · 잠정 표시는 당일 미확정 값';
  if (last) output.note += ` · ${last} 기준`;
  return output;
}

function openFlow(view) {
  flowView = { ...view, venue: view.venue || 'spot' };
  const dialog = document.getElementById('flowDialog');
  if (!dialog.open) dialog.showModal();
  renderFlow();
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
  if (stock ? metricsLoading.has(flowView.symbol) : marketLoading) return;
  document.getElementById('flowRetry').disabled = true;
  if (stock) await loadMetrics(flowView.symbol);
  else await loadMarket();
}

function renderFlow() {
  if (!flowView || !document.getElementById('flowDialog').open) return;
  const stock = flowView.kind === 'stock';
  const cached = stock ? metricsCache.get(flowView.symbol) : marketExtras;
  const ttl = stock ? METRICS_TTL : RANK_TTL;
  if (!cached || Date.now() - cached.at >= ttl) refreshFlow();
  const loading = stock ? metricsLoading.has(flowView.symbol) : marketLoading;
  const model = flowData(flowView, cached && cached.d);
  const failure = model.error || cached && cached.error;
  const title = document.getElementById('flowTitle');
  title.textContent = model.title;
  document.getElementById('flowNote').textContent = model.note;
  const venue = document.getElementById('flowVenue');
  venue.hidden = flowView.kind !== 'intraday';
  venue.value = flowView.venue;
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
  dialog.oncancel = (event) => { event.preventDefault(); closeFlow(); };
  dialog.onclose = () => { if (!dialog.open) clearFlow(); };
}
