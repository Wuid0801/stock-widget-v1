// renderer/info.js — 상세의 보유 입력 · 52주 · 추세 점검 줄.

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
    el.title = '하루에 35% 넘게 움직인 봉이 있다\n'
      + '국내 가격제한폭(±30%) 밖이라 액면분할 같은 데이터 이상으로 보고 그 뒤만 쓰려 했지만\n'
      + '2년(500봉)이 남지 않아 계산하지 않았다';
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
  const num = (x, digits = 1) => (x > 0 ? '+' : '') + (x * 100).toFixed(digits); // %포인트의 숫자만
  const pp = (x, digits = 1) => `${num(x, digits)}%포인트`;
  const ymd = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const { rule, fast, regime: g } = r;
  const cost = costOf(symbol);
  // 툴팁 문체(2026-11-02): 규칙 / 지난 기간 결과 / 지금 / 한계 묶음, 목록은 '· '. Windows Chromium 은 1024자에서 자른다(테스트가 본다).
  const lines = [
    '20/60 규칙: 20일선이 60일선 위면 보유, 아래면 정리',
    `종가로 판단해 다음 날 종가에 사고판다 · 왕복 비용 ${(cost * 100).toFixed(2)}%${isIndex(symbol) ? ' (지수는 ETF 로 따라간다고 봄)' : ''}`,
    `기간 ${ymd(rule.from)} ~ ${ymd(rule.to)}${r.cut ? ' (하루 35% 넘게 움직인 봉 뒤부터)' : ''}`,
    '',
    '지난 기간 결과 (최대 낙폭 = 가장 크게 빠진 폭)',
    `· 규칙대로: 누적 ${p(rule.strat.total)} · 해마다 ${p(rule.strat.cagr)} · 최대 낙폭 ${p(-rule.strat.mdd)} · 보유한 날 ${Math.round(rule.strat.inShare * 100)}%`,
    `· 그냥 보유: 누적 ${p(rule.hold.total)} · 해마다 ${p(rule.hold.cagr)} · 최대 낙폭 ${p(-rule.hold.mdd)}`,
  ];
  if (rule.verdict === 'few') {
    lines.push(`· 진입 ${rule.strat.entries}회 — 적어서 판정하지 않음`);
  } else {
    // 순위는 개수로 보인다 — 백분율("상위 99%")은 반올림 때문에 못함에도 구분 안 됨에도 같은 값이 나왔다
    const edge = Math.floor(rule.count * BT_ROT_EDGE);
    lines.push(
      `· 날짜만 민 가짜 매매 ${rule.count}개 중 규칙보다 누적이 낮은 것 ${rule.below}개 → ${verdictText(rule.verdict)}`
        + ` (${rule.count - edge}개 이상이면 나음 · ${edge}개 이하면 못함)`,
      `· 가짜 매매의 최대 낙폭 중앙값 ${p(-rule.nullMdd)} (덜 빠진 건 덜 들고 있어서일 수 있다)`,
      `· 진입 ${rule.strat.entries}회`,
    );
  }
  lines.push(`· 5/20 같은 규칙: 진입 ${fast.entries}회 · 비용 합계 약 ${(fast.trades * cost * 50).toFixed(0)}% · 누적 ${p(fast.total)}`, '');

  const cls = { up: '정배열(짧은 선이 위: 5>20>60>120일선)', down: '역배열(짧은 선이 아래: 5<20<60<120일선)',
    mixUp: '혼조(20일선이 60일선 위)', mixDown: '혼조(20일선이 60일선 아래)' }[g.cls];
  lines.push(`지금: ${cls} · 20일선 ${g.up ? '상승' : '하락'} — ${ymd(g.at).slice(5).replace('-', '/')} 종가 기준`);
  if (g.fallback) lines.push('· 같은 배열 · 방향인 날이 적어 배열만으로 봄');
  // 표본이 얼마나 작았는지는 판정하지 않을 때도 보인다 — 빼는 것은 차이 · 범위 줄뿐이다.
  const sample = [`· 같은 상태였던 날 ${g.days}일 (${g.episodes}구간 · 겹치지 않는 20일 묶음 ${g.windows}개)`];
  if (g.days) sample.push(`· 그 뒤 20거래일: 중앙값 ${p(g.med)} · 오른 비율 ${Math.round(g.rise * 100)}% (다음 날 종가 매수, 비용 차감)`);
  if (g.verdict === 'few') {
    lines.push('· 같은 상태였던 날이 적어 판정하지 않음', ...sample);
  } else {
    const out = g.lo != null && (g.diff < g.lo || g.diff > g.hi);
    // 차이와 범위 끝이 소수 한 자리로 같게 보이면(+3.18 · +3.21 → 둘 다 +3.2) 왜 안/밖인지 안 보인다 — 그때만 둘째 자리까지
    const d = g.lo != null && (num(g.diff) === num(g.lo) || num(g.diff) === num(g.hi)) ? 2 : 1;
    lines.push(
      ...sample,
      `· 평소: ${p(g.allMed)} · ${Math.round(g.allRise * 100)}% → 차이 ${pp(g.diff, d)}`,
      g.lo == null ? '· 가짜 주가가 모자라 판정하지 않음'
        : `· 가짜 주가 ${g.paths}개의 차이 범위 ${num(g.lo, d)} ~ ${pp(g.hi, d)} ${out ? '밖' : '안'} → ${verdictText(g.verdict)}`
          + (out && g.verdict === 'same' ? ' (앞 · 뒤 절반의 방향이 달라)' : ''),
    );
  }
  // 2026-10-13 재검증: 효과 없는 규칙에서도 판정이 4~5% 나왔고, 10년치에서 앞 5년 순위로 뒤 5년 순위를 맞히지 못했다(상관 -0.02)
  lines.push('', '한계',
    '· 나음 · 못함은 규칙이 쓸모없어도 판정마다 20번에 1번꼴로 우연히 나온다',
    '· 지난 기간의 설명이다 — 10년치로 해 보니 앞 5년 결과로 뒤 5년을 맞히지 못했다',
    '· 배당 · 세금 · 환전 제외, 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽다',
    '· 과거 통계이며 매매 권유가 아니다');
  return lines.join('\n');
}

