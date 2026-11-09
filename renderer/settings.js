// renderer/settings.js — 설정 — 테마 · 투명도 · 이동평균 · 보조 지표 칩 · 목표가 알림 · 설정 백업.

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
      : `${p}일 이동평균 — ${state.timeframe} 구간에는 너무 길어 지금은 그리지 않는다`;
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
      state.indicators = withIndicator(ind.key, !on); // RSI · 스토캐스틱은 하나만
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

// --- 설정 백업 ---------------------------------------------------------------------
// 설정 패널 맨 아래의 내보내기 · 불러오기. 파일 창 · 확인 창 · 파일 검증은 main 이 맡는다(backup:export · backup:import).
// 불러오면 처음부터 다시 그린다 — 시작할 때 설정을 거르는 규칙(cleanIndicators · cleanMaStyles · validTimeframe …)을
// 그대로 타게. 바꾸기 직전 설정은 main 이 고른 파일과 같은 폴더에 따로 저장해 둔다.
async function exportBackup() {
  await save(); // 마지막 변경까지 저장소에 넣고 내보낸다
  const r = await api.backupExport();
  const c = r.counts;
  document.getElementById('backupMsg').textContent = r.ok
    ? `저장했습니다 — ${String(r.path).split(/[\\/]/).pop()} (관심종목 ${c.watchlist}개 · 보유 ${c.holdings}개 · 목표가 ${c.targets}개)`
    : r.canceled ? '' : `저장하지 못했습니다 (${r.error})`;
}

async function importBackup() {
  const r = await api.backupImport();
  if (r.ok) { location.reload(); return; }
  document.getElementById('backupMsg').textContent = r.canceled ? '' : `불러오지 못했습니다 (${r.error})`;
}

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

