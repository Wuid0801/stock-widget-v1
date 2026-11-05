// renderer/chart.js — 차트 — 기간 배지 · 범례 · Chart.js 플러그인 · 차트 그리기(drawChart).

// 선택 구간의 수익률 배지. 1D는 위의 일간 등락과 같은 값이라 표시하지 않는다.
// rel(지수 대비, 보조 지표)이 있으면 종목 수익률에서 같은 기간 지수 수익률을 뺀 초과 수익(%p)을 붙인다.
function renderPeriod(first, last, rel = null) {
  const el = document.getElementById('period');
  if (state.timeframe === '1D' || !first || last == null) { el.hidden = true; return; }

  const pct = ((last - first) / first) * 100;
  const color = plColor(pct);
  el.hidden = false;
  // 글자는 숫자와 고정된 기간 이름뿐이라 innerHTML 로 써도 된다
  let html = `${state.timeframe} ${fmtPct(pct)}`;
  el.title = '';
  if (rel) {
    const ex = pct - rel.pct;
    html += `<span style="color:${plColor(ex)}"> · 초과 ${ex > 0 ? '+' : ''}${ex.toFixed(2)}%p</span>`;
    el.title = `같은 기간 ${rel.name} ${fmtPct(rel.pct)} — 종목이 ${Math.abs(ex).toFixed(2)}%포인트 ${ex >= 0 ? '앞섬' : '뒤처짐'}`;
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

// 지수 비교선(보조 지표 '지수 대비'). 같은 기간 지수를 차트 첫 봉의 종목 가격에서 시작하게 맞춘 선 — 두 선이 벌어진
// 만큼이 초과 수익이다(배지의 숫자로는 언제 벌어졌는지 보이지 않았다). 날짜로 짝짓고 지수에 없는 날(휴장 차이)은
// 비운다. 기준은 둘 다 있는 첫 날, 마지막 봉은 배지(benchReturn)처럼 실시간 지수 값이다.
function benchLine(bench, got, times, closes) {
  if (!bench || !got || !got.ok || !times.length) return null;
  const idx = alignByDay(got.times, got.closes, times);
  if (!idx) return null;
  const live = quotes[bench.symbol] && quotes[bench.symbol].price;
  if (live > 0 && idx[idx.length - 1] != null) idx[idx.length - 1] = live;
  const i0 = idx.findIndex((v, i) => v != null && closes[i] != null);
  if (i0 < 0) return null;
  return { name: bench.name, data: idx.map((v) => (v == null ? null : (closes[i0] * v) / idx[i0])) };
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
  const bl = (lastChart && lastChart.benchLine) || null;
  const rs = (lastChart && lastChart.rsi) || null;
  box.hidden = mas.length === 0 && trends.length === 0 && !bands && !vw && !vp && !sr && !bl && !rs;
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
  // 지수 비교선은 VWAP 처럼 마우스를 안 올리면 마지막 값
  if (bl) {
    let i = hoverIdx;
    if (i == null) for (i = bl.data.length - 1; i > 0 && bl.data[i] == null; i--);
    add(bl.name, bl.data[i], cssVar('--bench-line'),
      `${bl.name} — 차트 첫 봉의 종목 가격에서 시작하게 맞춘 지수. 두 선이 벌어진 만큼이 초과 수익`, true);
  }
  // SAR 은 마우스를 안 올리면 지금 방향과 그 방향이 이어진 기간 — 매수 · 매도 신호가 아니라 상태만 말한다.
  // 1D · 1W 는 전환 시각(축과 같은 형식), 일봉 기간은 전환 뒤 봉 수(거래일, 전환한 날 포함). 마우스를 올리면 그 봉의 SAR.
  if (sr) {
    const dir = sr.rising ? '상승' : '하락';
    const intraday = state.timeframe === '1D' || state.timeframe === '1W';
    const when = labelFor(sr.flipAt, intraday ? state.timeframe : '1M');
    add('SAR', hoverIdx != null ? sr.data[hoverIdx] : intraday ? `${dir} · ${when}부터` : `${dir} ${sr.since}일째`,
      cssVar(sr.rising ? '--sar-up' : '--sar-down'),
      `파라볼릭 SAR — ${when} ${dir} 전환 (가속 ${SAR_STEP} · 최대 ${SAR_MAX}). 상승 추세면 점이 봉 아래, 하락 추세면 봉 위\n\n${SAR_EVIDENCE}`);
  }
  // RSI 는 SAR 처럼 지금 상태 — 마지막 확정 교차 뒤 RSI 가 시그널 위(상향)인지 아래(하향)인지와 그 기간. 확정된 교차가
  // 없으면 마지막 값. 마우스를 올려도 그대로다 — 그 봉의 값은 툴팁에 있다.
  if (rs) {
    const head = `RSI(${RSI_PERIOD}) · 시그널(RSI ${RSI_SIGNAL}봉 평균)`;
    const dots = '차트 아래 칸에 선, 시그널을 위로 뚫은 봉은 빨강 · 아래로 뚫은 봉은 파랑 점';
    if (rs.rising == null) {
      const lastOf = (a) => a.filter((v) => v != null).pop();
      const r = lastOf(rs.data); const g = lastOf(rs.signal);
      add('RSI', `${r.toFixed(0)}${g != null ? ` · 시그널 ${g.toFixed(0)}` : ''}`, cssVar('--rsi-line'),
        `${head} — 보이는 구간에 확정된 교차가 없습니다. ${dots}\n\n${RSI_CROSS_EVIDENCE}`);
    } else {
      const dir = rs.rising ? '상향' : '하향';
      const intraday = state.timeframe === '1D' || state.timeframe === '1W';
      const when = labelFor(rs.flipAt, intraday ? state.timeframe : '1M');
      add('RSI', intraday ? `${dir} · ${when}부터` : `${dir} ${rs.since}일째`, cssVar('--rsi-line'),
        `${head} — ${when} ${dir} 교차. ${dots}\n\n${RSI_CROSS_EVIDENCE}`);
    }
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
    // 위아래 경계는 가격 칸 — RSI 칸을 켜면 그림 아래쪽이 RSI 칸이라, 가격 밖의 선이 그 칸에 그어지지 않게 한다
    const area = { ...c.chartArea, top: c.scales.y.top, bottom: c.scales.y.bottom };
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
  // 툴팁에 뜻과 과거 검증(MA_CROSS_EVIDENCE, 2026-11-03) — 색은 방향일 뿐 매매 신호가 아니었다
  el.title = `${last.pair} 이동평균 ${last.golden ? '골든' : '데드'} 크로스 — 짧은 선이 긴 선을 ${last.golden ? '위로' : '아래로'} 뚫었다`
    + `${MA_CROSS_EVIDENCE[last.pair] ? `\n\n${MA_CROSS_EVIDENCE[last.pair]}` : ''}`;
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
    // 툴팁에 뜻과 그 기간(3M · 1Y) 추세선의 과거 검증(TREND_EVIDENCE, 2026-11-03) — 색은 방향일 뿐 매매 신호가 아니었다
    const ev = TREND_EVIDENCE[state.timeframe];
    brk.title = `${isSup ? '지지선 아래로 뚫었다' : '저항선 위로 뚫었다'} — 지금 그 선에서 ${fmtPct(hit.broke.pct * 100)}${ev ? `\n\n${ev}` : ''}`;
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
    ctx.rect(area.left, c.scales.y.top, area.width, c.scales.y.bottom - c.scales.y.top);
    ctx.clip(); // 축 눈금 위로 · RSI 칸으로 삐져나가지 않게

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
  document.getElementById('chartBox').className = chartBoxClass(); // 불러오던 요청도 위에서 무효가 됐다
  hoverIdx = null;
  renderMaLegend();
  renderCrossBadge([], []);
  renderTrendBadges([], 0);
  document.getElementById('chartMode').hidden = true; // 차트가 없으면 전환할 것도 없다
  document.getElementById('plainChart').hidden = true;
  document.getElementById('extHours').hidden = true;
  document.getElementById('rsiPane').hidden = true;
  document.getElementById('rsiTall').hidden = true;
  document.getElementById('zoomReset').hidden = true; // 차트가 없으면 풀 확대도 없다
}

function drawChart(arg) {
  lastChart = arg;
  const {
    closes, times, up, mas = [], cur = 'KRW',
    volumes = [], opens = [], highs = [], lows = [], hLines = [], crosses = [], trends = [], ext = null,
    bands = null, vwapLine = null, volAvg = null, profile = false, sar = null, rsi = null, benchLine = null, tipBases = null,
  } = arg;
  const color = up ? UP : DOWN;
  // 툴팁 가격 옆 등락률(%). 기준(tipBases, loadChart 가 만든다)이 없으면 null
  const tipPct = (i, y) => { const b = tipBases && tipBases[i]; return b > 0 && y != null ? ((y - b) / b) * 100 : null; };
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
  // RSI 교차 봉 → { golden(위로 뚫었는지), open(1D 진행 중인 마지막 봉 — 테두리 점) }
  const rsiDot = new Map(rsi ? [...rsi.crosses.map((x) => [x.i, { golden: x.golden, open: false }]),
    ...(rsi.pending ? [[rsi.pending.i, { golden: rsi.pending.golden, open: true }]] : [])] : []);
  const rsiDotColor = (i) => (rsiDot.has(i) && rsiDot.get(i).golden ? UP : DOWN);
  // RSI 칸 눈금 — 보이는 봉의 RSI · 시그널 최저~최고에 맞춘다(rsiScale). 거래량처럼 확대 중에는 그 구간으로.
  const rsiFit = rsi ? rsiScale(zr ? [...rsi.data.slice(zr.from, zr.to + 1), ...rsi.signal.slice(zr.from, zr.to + 1)]
    : [...rsi.data, ...rsi.signal]) : null;
  // RSI 칸을 둘 때 가격 칸의 stack 비중(RSI 칸은 RSI_PANE, 크게 보기면 RSI_TALL). 그림 높이는 캔버스에서 아래 날짜 줄 · 위
  // 여백(약 22px)을 뺀 만큼이라 RSI 칸이 약 그 px 가 된다. 축 옵션은 다시 배치할 때마다 새로 읽혀 창 높이를 바꿔도 칸 높이가 그대로다.
  const rsiPx = rsiTall ? RSI_TALL : RSI_PANE;
  // 가격 축 범위 — 보이는 봉(확대 구간)의 고 · 저 · 종가와 추세선만으로 정한다(y 의 afterDataLimits). 볼린저 · 지수 비교선 · SAR ·
  // 이동평균 · VWAP 까지 넣으면 범위가 넓어지고, Chart.js 가 눈금(최대 4개)을 1 · 2 · 5 단위로 맞추며 축 끝을 또 넓혀(5만 간격 →
  // 100,000~200,000) 같은 차트가 덧그림을 켜면 3배 넘게 납작했다(2026-11-04 KB금융 1M, 사용자 결정). 범위 밖 덧그림은 축 칸에서
  // 잘리고 값은 범례에 있다. 추세선은 끝이 말없이 잘리지 않게 넣는다(아래 데이터셋 주석).
  let yLo = Infinity;
  let yHi = -Infinity;
  for (let i = zr ? zr.from : 0; i <= (zr ? zr.to : closes.length - 1); i++) {
    for (const v of [lows[i], highs[i], closes[i], ...(zr ? [] : trends).map((t) => t.data[i])]) {
      if (v != null && Number.isFinite(v)) { yLo = Math.min(yLo, v); yHi = Math.max(yHi, v); }
    }
  }
  const priceWeight = ({ chart: c }) => Math.max(c.height - 22 - rsiPx, RSI_PANE);

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
        // 이동평균(3) · 주가선(2) · 고저 밴드(1) · 거래량(0) · RSI(-0.5) · 추세선(-1). 밴드 · 막대는 옅어서
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
          // 위쪽만 옅게 남기고 아래 절반은 빠르게 비워 이평선이 지나갈 자리를 만든다. 가격 칸(y) 바닥에서 다 비운다 — RSI 칸 위
          const sy = ctx.chart.scales.y;
          const g = ctx.chart.ctx.createLinearGradient(0, sy.top, 0, sy.bottom);
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
      // 가격 축은 주가에만 맞춰 밴드가 축을 넓히지 않고, 범위 밖 부분은 가격 칸에서 잘린다.
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
      // 지수 비교선(보조 지표 '지수 대비') — 옅은 점선. 볼린저(청회색 점선) · 지지선(초록)과 헷갈리지 않는 회색.
      // 지수에 없는 날(휴장 차이)은 건너 잇는다.
      ...(benchLine ? [{
        data: benchLine.data,
        yAxisID: 'y',
        order: 3,
        borderColor: cssVar('--bench-line'),
        borderWidth: 1.2,
        borderDash: [5, 3],
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.15,
        fill: false,
        spanGaps: true,
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
      // 가격 축 범위(yLo ~ yHi)에 넣는다 — 덧그림 중 추세선만. 캔버스에 직접 그리면
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
      // RSI · 시그널(보조 지표) — 가격 칸 아래 따로 둔 칸(축 yRsi, RSI_PANE)에 그린다. RSI 는 옅은 실선, 시그널은 점선,
      // 30 · 70 은 아주 옅은 점선 — 눈금(rsiFit) 안일 때만. 밖이면 RSI 칸을 벗어나 가격 칸에 그어진다. 시그널을 뚫은
      // 봉(확정된 교차)에 작은 점 — 위로 빨강 · 아래로 파랑. 거래량 막대(0) 위 · 추세선(-1) 아래에 그린다. 그 봉의 값은
      // 툴팁 footer, 지금 상태는 renderMaLegend 가 맡아 마우스 대상에서 뺀다.
      ...(rsi ? [...[30, 70].filter((v) => v > rsiFit.min && v < rsiFit.max).map((v) => ({
        data: closes.map(() => v),
        yAxisID: 'yRsi',
        order: -0.5,
        borderColor: cssVar('--grid'),
        borderWidth: 1,
        borderDash: [2, 3],
        pointRadius: 0,
        pointHitRadius: 0,
        fill: false,
      })), {
        data: rsi.signal,
        yAxisID: 'yRsi',
        order: -0.5,
        borderColor: cssVar('--mute'),
        borderWidth: 1,
        borderDash: [3, 2],
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
      }, {
        data: rsi.data,
        yAxisID: 'yRsi',
        order: -0.5,
        borderColor: hexA(cssVar('--rsi-line'), 0.7),
        borderWidth: 1.2,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.2,
        fill: false,
        spanGaps: false,
      }, {
        data: closes.map((_, i) => (rsiDot.has(i) ? rsi.data[i] : null)),
        yAxisID: 'yRsi',
        order: -0.5,
        showLine: false,
        pointRadius: 2.2,
        pointHoverRadius: 2.2,
        pointHitRadius: 0,
        pointBorderWidth: closes.map((_, i) => (rsiDot.has(i) && rsiDot.get(i).open ? 1.2 : 0)),
        pointBorderColor: closes.map((_, i) => rsiDotColor(i)),
        pointBackgroundColor: closes.map((_, i) => (rsiDot.has(i) && rsiDot.get(i).open ? 'transparent' : rsiDotColor(i))),
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
          // footer(시가 · 고저 · 거래량)는 본문과 같은 글꼴 · 색 · 줄 간격으로 — 기본은 굵게, 위로 6px 띄운다
          footerColor: cssVar('--text'),
          footerFont: { size: 11, weight: 'normal' },
          footerMarginTop: 2,
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
            // 본문은 가격 줄 하나다 — 그 봉의 가격과 기준(tipBases) 대비 등락률을 목록의 가격처럼 등락 색으로.
            // Chart.js 툴팁은 한 줄 안에서 색을 나누지 못해 줄 전체를 칠한다. 나머지는 그 아래 footer 다 —
            // afterBody 는 마지막 본문 항목의 글자색을 물려받아, 가격(order 2)이 마지막 항목이면(이동평균이 없을 때)
            // 시가 · 고저 · 거래량까지 빨강 · 파랑이 된다(Chart.js 4.5.1 drawBody). footer 는 제 색을 쓴다.
            // 빈 배열을 주면 Chart.js 가 그 줄을 통째로 건너뛴다 → 다른 데이터셋은 줄을 만들지 않는다.
            label: (it) => {
              if (it.datasetIndex !== 0) return [];
              const pct = tipPct(it.dataIndex, it.parsed.y);
              return `${money(it.parsed.y, cur)}${pct == null ? '' : ` ${fmtPct(pct)}`}`;
            },
            labelTextColor: (it) => {
              const pct = it.datasetIndex === 0 ? tipPct(it.dataIndex, it.parsed.y) : null;
              return pct == null ? cssVar('--text') : plColor(pct);
            },
            footer: (items) => {
              const lines = [];
              const p = items.find((i) => i.datasetIndex === 0);
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
              // RSI(보조 지표) — 그 봉의 RSI · 시그널. 범례는 지금 상태만 말한다.
              if (rsi && rsi.data[i] != null) {
                lines.push(`RSI ${rsi.data[i].toFixed(1)}${rsi.signal[i] != null ? ` · 시그널 ${rsi.signal[i].toFixed(1)}` : ''}`);
              }
              return lines;
            },
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
          // RSI 를 그리면 yRsi 와 위아래로 쌓는다(Chart.js stack) — 위가 가격 칸, 아래 rsiPx 만큼이 RSI 칸
          ...(rsi ? { stack: 'pane', stackWeight: priceWeight } : {}),
          // 범위는 주가에만(yLo ~ yHi). Chart.js 가 데이터로 끝을 정한 직후 바꿔 두면 그 범위를 1 · 2 · 5 단위로 넓히며 눈금을 단다
          // ("차트만 보기"와 같은 축). min · max 로 못 박으면 그 안의 눈금만 남아 셋 중 하나꼴로 숫자가 하나뿐이었다.
          afterDataLimits: (s) => { if (yHi > yLo) { s.min = yLo; s.max = yHi; } },
          grid: { color: cssVar('--grid') },
          ticks: { color: cssVar('--mute'), font: { size: 9 }, maxTicksLimit: 4, callback: (v) => money(v, cur) },
        },
        // 거래량 전용 축. 최댓값의 4배를 천장으로 잡아 막대가 아래 1/4 만 차지한다. 쌓지 않아 그림 전체 높이라,
        // RSI 칸이 있으면 바닥을 그 칸만큼 음수로 내려 0 이 가격 칸 바닥에 오게 한다(막대는 가격 칸 아래 1/4).
        yVol: {
          display: false,
          beginAtZero: true,
          ...(rsi ? { min: (ctx) => (-maxVol * 4 * rsiPx) / priceWeight(ctx) } : {}),
          max: maxVol * 4,
          grid: { display: false },
        },
        // RSI 전용 축(보조 지표). y 와 같은 오른쪽 stack 의 아래 칸. 눈금은 보이는 RSI 범위(rsiFit), 숫자는 rsiFit 이 고른
        // 자리에만 — 쌓인 축은 폭을 같이 써 가격 눈금과 같은 줄에 선다. 기준선은 데이터셋이라 격자 · 축 선은 끈다.
        ...(rsi ? { yRsi: {
          position: 'right',
          stack: 'pane',
          stackWeight: rsiPx,
          min: rsiFit.min,
          max: rsiFit.max,
          afterBuildTicks: (axis) => { axis.ticks = rsiFit.ticks.map((value) => ({ value })); },
          grid: { display: false },
          border: { display: false },
          ticks: { color: cssVar('--mute'), font: { size: 9 }, autoSkip: false },
        } } : {}),
      },
    },
  });
}

