// renderer/metrics.js — 지표 보기(차트 자리) — 오늘 · 기간 수익률 · 기법 점검 · 매매동향 · 주주 · 실적 · 가치 지표.

// --- 지표 보기(차트 대신) ---------------------------------------------------------
// 차트 왼쪽 위 버튼으로 차트 자리를 지표 화면으로 바꾼다. 데이터는 main 의 naver:detail — 열었을 때만 받고,
// 열려 있는 동안은 상세를 다시 그릴 때(30초 갱신 · 종목 바꾸기) 1분이 지났으면 다시 받는다.
// 오늘 거래량 배수와 기간 수익률은 이미 받은 일봉으로 센다(요청 없음).

// 오늘 거래량이 그날 앞 20거래일 평균의 몇 배인지. 거래량은 KRX(국내) · 통합(미국)이고, 평균은 같은 기준인
// 야후 일봉 거래량이다(2026-10-16 삼성전자 매매동향 · 야후 일봉 날짜별 거래량이 같았다). 날짜는 그 거래량의
// 날 — 미국 장 전에는 어제(뉴욕) 거래량이 오므로 오늘이 아니다. 거래량 0 인 날(휴장 · 빈 봉)은 뺀다.
function metricsVolume(symbol, today) {
  const d = quotes[symbol] && quotes[symbol].dailyVolume;
  const at = today && today.at ? Date.parse(today.at) : NaN;
  if (!d || today.volume == null || !Number.isFinite(at)) return null;
  // 그 시장의 날짜(marketDay) — 미국 애프터(겨울 19~20시 ET)의 거래량이 오늘을 평균에 넣지 않게
  const day = (ms) => marketDay(ms, symbol);
  const before = [];
  for (let i = 0; i < d.times.length; i++) {
    if (day(d.times[i]) < day(at) && d.volumes[i] > 0) before.push(d.volumes[i]);
  }
  const last = before.slice(-VOL_AVG);
  if (!last.length) return null;
  const avg = last.reduce((a, b) => a + b, 0) / last.length;
  return { volume: today.volume, avg, ratio: today.volume / avg };
}

// 기간 수익률 — 1주 · 1개월 · 3개월 · 올해 · 1년. 그날(없으면 그 앞의 마지막) 일봉 종가부터 현재가까지.
// 일봉이 그 기간만큼 없으면(최근 상장) null — 첫 봉부터 센 값이 그 기간 수익률로 읽히면 안 된다.
function periodReturns(symbol) {
  const q = quotes[symbol];
  const d = q && q.daily;
  if (!d || !d.times.length) return [];
  const lastT = d.times[d.times.length - 1];
  const last = q.price != null ? q.price : d.closes[d.closes.length - 1];
  // n 달 전 같은 날. 그달에 그날이 없으면(3/31 의 한 달 전) 그달 마지막 날
  const monthsBack = (n) => {
    const t = new Date(lastT);
    const want = t.getUTCDate();
    t.setUTCDate(1);
    t.setUTCMonth(t.getUTCMonth() - n);
    t.setUTCDate(Math.min(want, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()));
    return t.getTime();
  };
  const from = [['1주', lastT - 7 * 86400000], ['1개월', monthsBack(1)], ['3개월', monthsBack(3)],
    ['올해', Date.UTC(new Date(lastT).getUTCFullYear() - 1, 11, 31)], ['1년', monthsBack(12)]];
  const dayOf = (t) => Math.floor(t / 86400000);
  return from.map(([label, t]) => ({
    label, pct: dayOf(t) < dayOf(d.times[0]) ? null : returnSince(d.times, d.closes, t, last),
  }));
}

// 일봉 종가(quotes.daily)와 봉끼리 짝지은 거래량. 오늘 봉을 덧붙였으면(loadQuote — 일봉이 아직 어제까지일 때) 그 봉은 null.
function dailyVolumesOf(symbol) {
  const q = quotes[symbol];
  const v = q && q.dailyVolume;
  return v && q.daily && q.daily.times ? alignByDay(v.times, v.volumes, q.daily.times) : null;
}

// 보유 종목 평가금액 합계에서 이 종목의 몫(%) — 합계 줄(renderFolio)처럼 수량 · 평단 · 현재가가 있는 종목만 세고, 달러는 받아 둔
// 환율(fxRate — 달러가 섞여 있으면 합계 줄이 받는다)로. 보유가 아니거나 보유가 하나뿐이면(늘 100%), 환율이 아직 없으면 null.
function holdWeight(symbol) {
  const held = state.watchlist.map((i) => ({ i, h: state.holdings[i.symbol], q: quotes[i.symbol] }))
    .filter((x) => x.h && x.h.qty > 0 && x.h.avg > 0 && x.q && x.q.price != null);
  const me = held.find((x) => x.i.symbol === symbol);
  if (!me || held.length < 2) return null;
  if (held.some((x) => curOf(x.i.symbol) !== 'KRW') && !fxRate) return null;
  const value = (x) => x.q.price * x.h.qty * (curOf(x.i.symbol) === 'KRW' ? 1 : fxRate);
  return { pct: (value(me) / held.reduce((s, x) => s + value(x), 0)) * 100, count: held.length };
}

// 기법 점검(지표 화면) — 추세 추종 · 모멘텀 · 적립식 · 보유 비중 · 반등 점검 · 코스톨라니 달걀. 받아 둔 5년치 일봉(오늘 봉은
// 현재가) · 거래량으로 센다(요청 없음, 계산은 indicators.js). 셀 수 없는 줄은 빼고, 하나도 없으면 빈 문자열.
// 줄마다 툴팁에 규칙을 적는다. 매매 판단이 아니라 참고용이다.
function techHtml(item) {
  const q = quotes[item.symbol];
  const d = q && q.daily;
  if (!d || !d.closes.length) return '';
  const cur = curOf(item.symbol);
  const pct = (v) => (v ? `<b style="color:${v > 0 ? UP : DOWN}">${fmtPct(v)}</b>` : `<b>${fmtPct(v)}</b>`);
  const line = (label, body, tip) => `<p title="${esc(tip)}"><span class="mxmute">${label}</span> ${body}</p>`;
  const out = [];
  const tf = trendFollow(d.closes, FOLLOW_MA);
  if (tf) {
    out.push(line('추세 추종', `${FOLLOW_MA}일선 ${money(tf.ma, cur)} ${tf.above ? '위' : '아래'} · <b>${tf.above ? '보유' : '현금'} 구간 ${tf.days}일째</b>`,
      `종가가 ${FOLLOW_MA}일선 위면 보유, 아래면 현금으로 보는 규칙 — 큰 하락을 피하는 데 강점이 있고 횡보장에서는 자주 바뀝니다. `
      + '일수는 그 상태가 이어진 거래일(오늘 포함)'));
  }
  const mom = momentum(d.times, d.closes);
  if (mom != null) {
    const all = state.watchlist.map((w) => { const x = quotes[w.symbol]; return x && x.daily ? momentum(x.daily.times, x.daily.closes) : null; })
      .filter((m) => m != null);
    out.push(line('모멘텀', `12-1개월 ${pct(mom)}${all.length > 1 ? ` · 관심종목 <b>${all.filter((m) => m > mom).length + 1}/${all.length}위</b>` : ''}`,
      '최근 1개월을 뺀 12개월 수익률(1개월 전 종가 / 12개월 전 종가) — 많이 오른 종목이 한동안 더 오르는 경향을 봅니다. 급반전할 때 크게 잃습니다. '
      + '순위는 관심종목 중 이 값이 있는 종목끼리'));
  }
  const dca = dcaCost(d.times, d.closes, DCA_MONTHS);
  if (dca) {
    out.push(line('적립식', `${DCA_MONTHS}개월 매달 같은 금액(${dca.buys}회) · 평단 ${money(dca.avg, cur)} · 지금 ${pct(dca.pct)}`,
      `최근 ${DCA_MONTHS}달(이번 달 포함) 매달 첫 거래일 종가에 같은 금액을 샀다면의 평균 단가와 지금 가격 대비 — 시점을 맞히지 않는 방식`));
  }
  const w = holdWeight(item.symbol);
  if (w) {
    out.push(line('비중', `보유 ${w.count}종목 중 <b>${w.pct.toFixed(1)}%</b> · 균등이면 ${(100 / w.count).toFixed(1)}%`,
      '보유 종목 평가금액 합계에서 이 종목의 몫 — 목표 비중 대신 균등 비중과 견줍니다(리밸런싱 참고). 미국 주식은 합계 줄과 같은 환율로 원화 환산'));
  }
  const vols = dailyVolumesOf(item.symbol);
  const rb = reboundCheck(d.closes, vols, REBOUND_DAYS, REBOUND_DROP);
  if (rb) {
    const more = [rb.aboveMa20 == null ? null : `20일선 ${rb.aboveMa20 ? '위' : '아래'}`, rb.rsi == null ? null : `RSI ${rb.rsi.toFixed(0)}`,
      rb.volRatio == null ? null : `반등 거래량 하락 때의 ${rb.volRatio.toFixed(1)}배`].filter(Boolean);
    out.push(line('반등 점검', `고점 ${money(rb.high, cur)} → 저점 ${money(rb.low, cur)} (${pct(rb.dropPct)}) · <b>${rb.retrace.toFixed(0)}%</b> 되돌림`
      + (more.length ? `<br><span class="mxmute">${more.join(' · ')}</span>` : ''),
      `최근 ${REBOUND_DAYS}거래일 고점에서 ${REBOUND_DROP}% 넘게 빠진 뒤 반등 중일 때만 — 진짜 반등인지(데드캣) 볼 때 흔히 보는 조건입니다. `
      + '20일선 위 · RSI 50 위 · 하락 때만큼 거래량이 실린 반등일수록 힘이 있다고 봅니다. 결론은 내리지 않습니다'));
  }
  const egg = eggPhase(d.closes, vols);
  if (egg) {
    out.push(line('코스톨라니', `<b>${egg.prev ? `${egg.prev} → ` : ''}${egg.phase}</b> · ${egg.days}일째 · ${EGG_NOTE[egg.phase]}`
      + ` · 다음 ${egg.next} (해석)`, eggTip(egg)));
  }
  return out.join('');
}

// 지표 화면의 HTML. d 는 naver:detail 응답(없으면 불러오는 중). 네트워크에서 온 글자는 모두 esc 한다.
function metricsHtml(item, d, q) {
  if (!d) return '<p class="mxnote">지표를 불러오는 중…</p>';
  if (!d.ok) return `<p class="mxnote">지표를 불러오지 못했습니다 (${esc(d.error || '알 수 없는 오류')})</p>`;
  const kr = d.market === 'kr';
  const tone = (v) => (v > 0 ? UP : v < 0 ? DOWN : null);
  const colored = (text, v) => (tone(v) ? `<b style="color:${tone(v)}">${text}</b>` : `<b>${text}</b>`);
  const signedVol = (v) => (v > 0 ? '+' : v < 0 ? '-' : '') + fmtVol(Math.abs(v));
  const cell = (v) => (v == null ? '<td>—</td>' : tone(v) ? `<td style="color:${tone(v)}">${signedVol(v)}</td>` : `<td>${signedVol(v)}</td>`);
  const mmdd = (s) => { const n = String(s).replace(/\D/g, ''); return `${n.slice(4, 6)}/${n.slice(6, 8)}`; };
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (ms) => { const t = new Date(ms); return `${p2(t.getMonth() + 1)}/${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`; };
  const sec = (title, body) => `<section><h5>${title}</h5>${body}</section>`;
  // 항목 하나(1년 +117.89% · 외국인 소진율 45.98%)는 줄바꿈하지 않는다 — 폭 340px 에서 '1 / 년' 으로 쪼개졌다
  const list = (items) => items.map((x) => `<span class="mxi">${x}</span>`).join(' · ');
  const parts = [];

  // 오늘 — 거래량은 KRX(국내) · 통합(미국). 국내 주식은 NXT 를 더한 거래량을 따로 적는다(ETF 는 NXT 에 없다).
  const t = d.today || {};
  const today = [];
  if (t.volume != null) {
    const v = metricsVolume(item.symbol, t);
    today.push(`<p>거래량 <b>${fmtVol(t.volume)} 주</b>${v ? ` · 20일 평균의 <b>${v.ratio.toFixed(2)}배</b>` : ''}`
      + `${t.at && Number.isFinite(Date.parse(t.at)) ? ` <span class="mxmute">${stamp(Date.parse(t.at))}</span>` : ''}</p>`);
  }
  const extra = [kr && d.kind !== 'etf' && t.totalVolume != null ? `NXT 포함 ${fmtVol(t.totalVolume)}` : null,
    t.value ? `대금 ${esc(t.value)}` : null, t.marketValue ? `시총 ${esc(t.marketValue)}` : null,
    t.foreignRate ? `외국인 소진율 ${esc(t.foreignRate)}` : null].filter(Boolean);
  if (extra.length) today.push(`<p class="mxmute">${list(extra)}</p>`);
  if (today.length) parts.push(sec('오늘', today.join('')));

  const rets = periodReturns(item.symbol).filter((r) => r.pct != null);
  if (rets.length) parts.push(sec('기간 수익률', `<p>${list(rets.map((r) => `${r.label} ${colored(fmtPct(r.pct), r.pct)}`))}</p>`));
  const tech = techHtml(item);
  if (tech) parts.push(sec('기법 점검 <span>(참고용)</span>', tech));

  // 투자자별 순매수 — 5일 · 20일 합과 최근 10일(최근이 위)
  if (d.trend && d.trend.length) {
    const keys = ['foreign', 'organ', 'individual'];
    const sum = (n, k) => d.trend.slice(0, n).reduce((a, r) => a + (r[k] || 0), 0);
    const sums = [5, 20].filter((n) => d.trend.length >= n)
      .map((n) => `<tr class="sum"><td>${n}일</td>${keys.map((k) => cell(sum(n, k))).join('')}</tr>`).join('');
    const rows = d.trend.slice(0, 10).map((r) => `<tr class="day"><td>${mmdd(r.date)}</td>${keys.map((k) => cell(r[k])).join('')}</tr>`).join('');
    parts.push(sec('투자자별 순매수 <span>(주, KRX)</span>',
      `<table class="mxt"><tr><th></th><th>외국인</th><th>기관</th><th>개인</th></tr>${sums}${rows}</table>`));
  } else if (!kr) {
    parts.push(sec('투자자별 순매수', '<p class="mxmute">투자자별 매매동향은 국내 종목만 있습니다</p>'));
  }

  // 주주 구성(국내 주식) — 공시된 주요주주와 외국인 지분율 · 유동비율. 우선주는 회사(보통주) 값이다.
  const h = d.holders;
  if (h && h.rows && h.rows.length) {
    const basis = [h.common ? '보통주 기준' : null, h.date ? (h.common ? mmdd(h.date) : `${mmdd(h.date)} 기준`) : null].filter(Boolean).join(', ');
    const rows = h.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.pct.toFixed(2)}%</td></tr>`).join('');
    const more = [h.foreign != null ? `외국인 ${h.foreign.toFixed(2)}%` : null, h.float != null ? `유동주식 ${h.float.toFixed(2)}%` : null].filter(Boolean);
    parts.push(sec(`주주 구성${basis ? ` <span>(${basis})</span>` : ''}`, `<table class="mxt">${rows}</table>`
      + (more.length ? `<p class="mxmute">${list(more)}</p>` : '')
      + '<p class="mxmute">최대주주 · 5% 이상 주주 · 자사주만 공시됩니다 (기관 · 개인 지분율은 없음)</p>'));
  }

  // 실적 — 발표 일정(국내)과 최근 4분기. 억원은 조 · 억으로, USD 백만은 B · M 으로 줄인다.
  const earn = [];
  if (d.ir && d.ir.date) {
    const dd = d.ir.dday == null || d.ir.dday < 0 ? '' : d.ir.dday === 0 ? ' · D-day' : ` · D-${d.ir.dday}`;
    earn.push(`<p>${esc(d.ir.title)} <b>${mmdd(d.ir.date)}</b>${dd}</p>`);
  }
  if (d.quarters && d.quarters.cols.length) {
    const usd = d.quarters.unit !== '억원';
    const fin = (v) => {
      if (v == null) return '—';
      if (usd) return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}B` : `${Math.round(v).toLocaleString()}M`;
      return Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}조` : `${Math.round(v).toLocaleString()}억`;
    };
    const from = Math.max(0, d.quarters.cols.length - 4);
    const cols = d.quarters.cols.slice(from);
    const head = `<tr><th></th>${cols.map((c) => `<th>${esc(c.title)}${c.estimate ? 'E' : ''}</th>`).join('')}</tr>`;
    const body = d.quarters.rows.map((r) => `<tr><td>${esc(r.title)}</td>${r.values.slice(from).map((v) => `<td>${fin(v)}</td>`).join('')}</tr>`).join('');
    earn.push(`<table class="mxt">${head}${body}</table>`);
    const notes = [usd ? 'USD' : null, cols.some((c) => c.estimate) ? 'E 는 증권사 추정치' : null].filter(Boolean);
    if (notes.length) earn.push(`<p class="mxmute">${notes.join(' · ')}</p>`);
  }
  if (earn.length) parts.push(sec('실적', earn.join('')));

  // 가치 지표 · 컨센서스 — 컨센서스는 증권사 추정치라 기준일과 함께 참고용으로 적는다
  const val = [];
  if (d.valuation && d.valuation.length) val.push(`<p>${list(d.valuation.map((v) => `${esc(v.label)} ${esc(v.value)}`))}</p>`);
  if (d.consensus) {
    const c = d.consensus;
    const amt = (v) => (v == null ? '—' : c.currency === 'KRW' ? `${money(v, 'KRW')}원` : `$${money(v, 'USD')}`);
    const vs = q && q.price > 0 && c.target != null ? ` (현재가 대비 ${fmtPct((c.target / q.price - 1) * 100)})` : '';
    const range = c.low != null && c.high != null ? ` · 최저 ${amt(c.low)} ~ 최고 ${amt(c.high)}` : '';
    val.push(`<p>목표가 평균 <b>${amt(c.target)}</b>${vs}${c.opinion != null ? ` · 의견 ${c.opinion.toFixed(2)} / 5` : ''}${range}</p>`);
    val.push(`<p class="mxmute">${c.date ? `${mmdd(c.date)} 기준 · ` : ''}증권사 추정치, 참고용</p>`);
  }
  if (val.length) parts.push(sec('가치 지표', val.join('')));

  if (d.etf) {
    const e = d.etf;
    const bits = [e.nav != null ? `NAV ${e.nav.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}` : null,
      e.deviation != null ? `괴리율 ${fmtPct(e.deviation)}` : null,
      e.dividendYield != null ? `분배율 ${e.dividendYield.toFixed(2)}%` : null,
      e.baseIndex ? esc(e.baseIndex) : null, e.issuer ? esc(e.issuer) : null].filter(Boolean);
    if (bits.length) parts.push(sec('ETF', `<p>${list(bits)}</p>`));
  }

  if (d.peers && d.peers.length) {
    parts.push(sec('동종 업종', `<p>${list(d.peers.map((p) => `${esc(p.name)} ${colored(fmtPct(p.pct), p.pct)}`))}</p>`));
  }
  parts.push('<p class="mxmute mxsrc">자료: 네이버 증권 · 거래량 배수와 기간 수익률은 일봉으로 계산</p>');
  return parts.join('');
}

// 버튼 · 지표 화면을 고른 종목에 맞춘다. 지수 · 환율은 지표가 없어 버튼을 숨기고 차트로 돌아간다.
// 같은 내용이면 다시 쓰지 않는다 — 30초마다 다시 쓰면 내려 둔 스크롤이 맨 위로 튄다. 종목이 바뀌면 맨 위부터.
function renderMetrics() {
  const item = selectedItem();
  const btn = document.getElementById('metricsBtn');
  const panel = document.getElementById('metricsView');
  const can = !!item && !isIndex(item.symbol);
  const on = can && metricsOn;
  btn.hidden = !can;
  btn.className = on ? 'mxbtn on' : 'mxbtn';
  btn.textContent = on ? '차트' : '지표'; // 열려 있으면 차트로 돌아가는 버튼
  btn.title = on ? '차트로 돌아가기' : '지표 보기 — 거래량 · 매매동향 · 실적 · 가치 지표';
  panel.hidden = !on;
  if (!on) return;
  const hit = metricsCache.get(item.symbol);
  const html = metricsHtml(item, hit && hit.d, quotes[item.symbol]);
  if (html !== metricsShown.html || item.symbol !== metricsShown.symbol) {
    const keep = item.symbol === metricsShown.symbol ? panel.scrollTop : 0;
    panel.innerHTML = html;
    panel.scrollTop = keep;
    metricsShown = { symbol: item.symbol, html };
  }
  if (!hit || Date.now() - hit.at >= METRICS_TTL) loadMetrics(item.symbol);
}

// 받는 중이면 또 묻지 않는다. 다시 받다 실패하면 있던 것을 둔다. 받으면 다시 그린다 — renderMetrics 는
// 늘 고른 종목을 그리므로 그사이 다른 종목으로 넘어갔으면 늦게 온 응답은 캐시에만 남는다.
async function loadMetrics(symbol) {
  if (metricsLoading.has(symbol)) return;
  metricsLoading.add(symbol);
  let d;
  try {
    d = await api.detail(symbol);
  } catch (e) {
    d = { ok: false, error: e.message };
  } finally {
    metricsLoading.delete(symbol);
  }
  const prev = metricsCache.get(symbol);
  const keep = prev && prev.d && prev.d.ok && !(d && d.ok);
  metricsCache.set(symbol, { at: Date.now(), d: keep ? prev.d : d || { ok: false, error: '응답 없음' } });
  renderMetrics();
}

