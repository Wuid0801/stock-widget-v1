// renderer/rank.js — 시장 순위 패널과 시장 지표 화면(데드캣 점검 · 코스톨라니 달걀).

// --- 시장 순위 -------------------------------------------------------------------
// 헤더의 순위 버튼이 여는 패널(검색 · 설정과 같은 덮개). 데이터는 main 의 naver:rank — 열려 있는 동안 지금 보는
// 탭만 받고 1분 쓴다(30초 갱신 때 1분이 지났으면 다시 받는다). 누르면 관심종목에 넣고 연다.

// 목록 HTML. 금액은 원(조 · 억) · 달러(T · B · M)로 줄인다. 시총 상위 탭은 시총, 나머지는 거래대금.
// 맨 위에 기준 시각과 거른 기준을 적는다 — 장이 닫혀 있으면 지난 장 순위라 열자마자 보여야 한다
// (처음에는 맨 아래에 두었는데 스크롤해야 보였다).
// 업종 · 테마 탭의 묶음 목록(d.groups)은 묶음 등락률과 오른 · 내린 종목 수다 — 등락률은 평균이라 큰 종목 한두 개에
// 끌려서 수를 같이 봐야 한다. 누르면 그 묶음 안의 종목(d.items, 급등처럼 거른 것)이다.
function rankPct(v) {
  const tone = v > 0 ? UP : v < 0 ? DOWN : null;
  return `<span class="rpct"${tone ? ` style="color:${tone}"` : ''}>${fmtPct(v)}</span>`;
}
function rankCount(g) {
  return `<span class="rcnt"><span style="color:${UP}">↑${g.up}</span> <span style="color:${DOWN}">↓${g.down}</span></span>`;
}
function rankHtml(d, market, kind) {
  if (!d) return '<div class="qhint">순위를 불러오는 중…</div>';
  if (!d.ok) return `<div class="qhint">순위를 불러오지 못했습니다 (${esc(d.error || '알 수 없는 오류')})</div>`;
  const label = { industry: '업종', theme: '테마' }[kind];
  if (d.groups) {
    if (!d.groups.length) return `<div class="qhint">조건에 맞는 ${kind === 'theme' ? '테마가' : '업종이'} 없습니다</div>`;
    const groups = d.groups.map((g, i) => `<div class="hit rrow" data-g="${i}" title="${g.count}종목 중 오른 ${g.up} · 내린 ${g.down} — 누르면 종목">`
      + `<span class="rk">${i + 1}</span><span class="hname">${esc(g.name)}</span>${rankPct(g.pct)}${rankCount(g)}</div>`).join('');
    return `<div class="qhint rnote">네이버 ${label} 등락률 순 · 5종목 이상 · ↑오른 ↓내린 종목 수</div>${groups}`;
  }
  if (!d.items.length) return '<div class="qhint">조건에 맞는 종목이 없습니다</div>';
  const amt = (v, cur) => {
    if (v == null) return '';
    if (cur === 'KRW') return v >= 1e12 ? `${(v / 1e12).toFixed(1)}조` : `${Math.round(v / 1e8).toLocaleString()}억`;
    if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
    return v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6).toLocaleString()}M`;
  };
  const rows = d.items.map((it, i) => {
    const mine = state.watchlist.some((w) => w.symbol === it.symbol);
    return `<div class="hit rrow" data-i="${i}"><span class="rk">${i + 1}</span>`
      + `<span class="hname">${mine ? '<span class="rin" title="관심종목에 있음">✓</span>' : ''}${esc(it.name)}</span>`
      + `<span class="rpx">${money(it.price, it.currency)}</span>`
      + rankPct(it.pct)
      + `<span class="rval">${amt(kind === 'cap' ? it.cap : it.value, it.currency)}</span></div>`;
  }).join('');
  const basis = kind === 'search' ? '네이버 인기 검색 순'
    : label ? '등락률 순 · 일반 주식만(ETF · ETN · 우선주 제외) · 거래대금 10억 원 이상'
    : market === 'kr' ? '일반 주식만(ETF · ETN · 우선주 제외) · 거래대금 10억 원 이상 · 코스피 + 코스닥'
      : kind === 'cap' ? '일반 주식만 · 나스닥 + 뉴욕' : '일반 주식만 · 시총 3억 달러 이상 · 나스닥 + 뉴욕';
  const p2 = (n) => String(n).padStart(2, '0');
  const t = new Date(d.at ? Date.parse(d.at) : NaN);
  const when = Number.isFinite(t.getTime())
    ? `${p2(t.getMonth() + 1)}/${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())} 기준 · ` : '';
  return `<div class="qhint rnote">${when}${basis}</div>${rows}`;
}

// 업종 · 테마 안에서 맨 위 줄 — 누르면 묶음 목록으로(rankClick)
function rankBackHtml(kind, g) {
  return `<div class="hit rback" data-back="1" title="${kind === 'theme' ? '테마' : '업종'} 목록으로">← <span class="hname">${esc(g.name)}</span>`
    + `${rankPct(g.pct)}${rankCount(g)}</div>`;
}

// 캐시 · 화면의 열쇠 — 업종 · 테마 안이면 묶음 번호까지('kr|industry|278')
function rankKey(v) {
  return `${v.market}|${v.kind}${v.group ? `|${v.group.no}` : ''}`;
}

// 지표 화면의 줄 하나. 고를 수 있는 시장 항목(INDICES)은 값이 지수 줄 값(없으면 받은 시세)이고, 5일 변화는 일봉의 5거래일 전
// 종가 대비다(일봉이 6개 미만이면 null). 금리는 오늘 등락 · 5일 변화를 bp 로 쓴다(d5 는 %p 차이). 데이터가 없으면 null —
// 그 줄을 그리지 않는다. 주가지수(EGG_INDEX)는 메모에 코스톨라니 달걀 국면을 달고 툴팁(noteTitle)에 근거를 적는다.
function marketRow(key) {
  const ix = INDICES.find((i) => i.code === key);
  if (!ix) return marketExtraRow(key);
  const it = indexItems.find((i) => i.code === key);
  const q = quotes[ix.symbol];
  const value = it ? it.value : q && q.price;
  if (!(value > 0)) return null;
  const cur = curOf(ix.symbol);
  const closes = q && q.daily && q.daily.closes;
  const base = closes && closes.length >= 6 ? closes[closes.length - 6] : null;
  const bp = cur === '%';
  const egg = EGG_INDEX.has(key) && closes ? eggPhase(closes, dailyVolumesOf(ix.symbol)) : null;
  return {
    key, name: ix.name, symbol: ix.symbol, value, cur,
    pct: it ? it.pct : q && q.pct != null ? q.pct : null,
    change: it ? it.change : q && q.change != null ? q.change : null,
    d5: base > 0 ? (bp ? value - base : (value / base - 1) * 100) : null,
    d5Unit: bp ? 'bp' : '%',
    note: ix.delayMin ? `${ix.delayMin}분 지연` : egg ? `달걀 ${eggDir(egg)}` : '',
    noteTitle: egg ? eggTip(egg) : '',
    spark: closes ? closes.slice(-20) : null,
  };
}

// 지표 화면에만 있는 줄 — 차트가 없어 누를 수 없다(symbol null). market:extras 를 아직 못 받았거나 그 부분이 실패했으면 null.
//  - FUT 코스피200 선물: 값 · 등락률은 지수 줄과 함께 받은 FUT(20분 늦다), 5일 변화는 선물 일봉의 6번째 앞 종가 대비.
//  - SPOT · FUTFLOW 외국인 현물 · 선물 수급: 마지막 확정일의 외국인 순매수(네이버 표기 그대로 — 네이버 화면도 단위를 적지 않는다),
//    5일 변화 자리에 확정일 끝에서 같은 부호가 이어진 날 수, 18:00 전 오늘 값은 잠정이라 메모에 따로.
//  - HYOAS 미국 HY OAS: 마지막 값(%), 오늘 등락은 앞 줄 · 5일 변화는 다섯 줄 앞 대비 bp, 메모에 그 값의 날짜(1~2영업일 늦다).
function marketExtraRow(key) {
  const x = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d : null;
  const signed = (v) => (v > 0 ? '+' : '') + v.toLocaleString('ko-KR');
  if (key === 'FUT') {
    const it = indexItems.find((i) => i.code === 'FUT');
    if (!it || !(it.value > 0)) return null;
    const days = x && x.futDays;
    const base = days && days.length >= 6 ? days[days.length - 6].close : null;
    return { key, name: MARKET_EXTRA_NAMES.FUT, symbol: null, value: it.value, cur: 'pt', pct: it.pct, change: it.change,
      d5: base > 0 ? (it.value / base - 1) * 100 : null, d5Unit: '%', note: '20분 지연',
      spark: days ? days.slice(-20).map((d) => d.close) : null };
  }
  if (key === 'SPOT' || key === 'FUTFLOW') {
    const flows = x && (key === 'SPOT' ? x.spotFlows : x.futFlows);
    const done = (flows || []).filter((f) => f.final);
    const last = done[done.length - 1];
    if (!last) return null;
    let n = 0;
    for (let i = done.length - 1; i >= 0 && Math.sign(done[i].foreign) === Math.sign(last.foreign) && done[i].foreign !== 0; i--) n++;
    const today = flows[flows.length - 1].final ? null : flows[flows.length - 1];
    return { key, name: MARKET_EXTRA_NAMES[key], symbol: null, value: last.foreign, pct: null, change: null,
      d5: null, d5Unit: '%', valueText: signed(last.foreign), dayText: '', dayTone: last.foreign,
      d5Text: n ? `${n}일 연속 순${last.foreign > 0 ? '매수' : '매도'}` : '—',
      note: today ? `오늘 잠정 ${signed(today.foreign)}` : '',
      title: `외국인 순매수 ${last.date.slice(4, 6)}/${last.date.slice(6)} 확정 — 네이버 표기 그대로(단위 없음), 18:00 전 오늘 값은 잠정`,
      spark: done.slice(-20).map((f) => f.foreign) };
  }
  if (key === 'HYOAS') {
    const rows = x && x.hyOas;
    if (!rows || !rows.length) return null;
    const last = rows[rows.length - 1];
    const prev = rows.length >= 2 ? rows[rows.length - 2].value : null;
    const base = rows.length >= 6 ? rows[rows.length - 6].value : null;
    return { key, name: MARKET_EXTRA_NAMES.HYOAS, symbol: null, value: last.value, pct: null, change: prev == null ? null : last.value - prev,
      d5: base == null ? null : last.value - base, d5Unit: 'bp', valueText: `${last.value.toFixed(2)}%`,
      note: `${last.date.slice(4, 6)}/${last.date.slice(6)} 기준`,
      title: '미국 하이일드 회사채 가산금리(ICE BofA US High Yield OAS, FRED) — 1~2영업일 늦다',
      spark: rows.slice(-20).map((r) => r.value) };
  }
  return null;
}

// 데드캣 점검의 입력 — market:extras 의 다섯 부분과, SOX · 원/달러 · VIX · 미국채의 { now(지수 줄 실시간, 없으면 받은 시세),
// closes(일봉 종가), dayPct(오늘 등락률) }. 없는 것은 null(그 판정은 판정 불가).
function marketCheckInput() {
  const x = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d : {};
  const series = (code) => {
    const ix = INDICES.find((i) => i.code === code);
    const it = indexItems.find((i) => i.code === code);
    const q = ix && quotes[ix.symbol];
    const now = it ? it.value : q && q.price;
    const closes = q && q.daily && q.daily.closes;
    return now > 0 && closes ? { now, closes, dayPct: it ? it.pct : q.pct != null ? q.pct : null } : null;
  };
  return {
    spotFlows: x.spotFlows || null, futFlows: x.futFlows || null, kospiDays: x.kospiDays || null, futDays: x.futDays || null,
    hyOas: x.hyOas || null, sox: series('SOX'), usdkrw: series('USDKRW'), vix: series('VIX'), us10y: series('US10Y'),
  };
}

// 미니 선 — 값들을 44×14 칸에 왼쪽(오래된 것)부터 오른쪽(최근)으로 잇는다. 값이 둘 미만이면 그리지 않고, 모두 같으면 가운데 평평하게.
function sparkSvg(values) {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (v.length < 2) return '';
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const r1 = (n) => Math.round(n * 10) / 10;
  const pts = v.map((x, i) => `${r1(1 + (i * 42) / (v.length - 1))},${r1(hi === lo ? 7 : 13 - ((x - lo) / (hi - lo)) * 12)}`).join(' ');
  return `<svg class="mspark" viewBox="0 0 44 14" width="44" height="14" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
}

// 지표 화면 HTML — 맨 위 데드캣 점검 요약(개수만 — 결론을 내리지 않는다), 묶음 제목 줄과 줄들(판정 점 · 이름(메모) · 값 · 오늘 등락 ·
// 5일 변화 · 20일 미니 선). 누를 수 있는 줄(고를 수 있는 항목)만 data-sym. 점검 대상이 아닌 줄은 점 자리만 비운다.
function marketHtml() {
  const tone = (v) => (v > 0 ? UP : v < 0 ? DOWN : cssVar('--flat'));
  const checks = marketChecks(marketCheckInput());
  const checkOf = new Map(checks.map((c) => [MARKET_CHECK_ROW[c.key], c]));
  const out = [];
  for (const [title, keys] of MARKET_GROUPS) {
    // 데이터가 없으면(출처 실패 · 아직 못 받음) 줄을 빼지 않고 — 로 둔다(설계 ④) — 점검 대상이면 점은 테두리만(판정 불가)
    const rows = keys.map((key) => marketRow(key) || { key, symbol: null, valueText: '—', dayText: '—', d5Text: '—', note: '',
      name: (INDICES.find((i) => i.code === key) || {}).name || MARKET_EXTRA_NAMES[key] });
    out.push(`<div class="qhint rnote mgroup">${title}</div>`);
    for (const r of rows) {
      const bp = r.d5Unit === 'bp';
      const day = r.dayText != null ? r.dayText : bp ? (r.change != null ? fmtBp(r.change) : '—') : (r.pct != null ? fmtPct(r.pct) : '—');
      const d5 = r.d5Text != null ? r.d5Text : r.d5 == null ? '—' : bp ? fmtBp(r.d5) : fmtPct(r.d5);
      const open = r.symbol ? `<div class="hit rrow mrow" data-sym="${r.symbol}" data-key="${r.key}" title="${esc(r.name)} 차트 보기">`
        : `<div class="rrow mrow mfix" data-key="${r.key}"${r.title ? ` title="${esc(r.title)}"` : ''}>`;
      const chk = checkOf.get(r.key);
      const dot = chk ? `<span class="mdot ${chk.verdict || 'none'}" title="${esc(chk.detail)}"></span>` : '<span class="mdsp"></span>';
      out.push(`${open}${dot}<span class="hname"><span class="mname">${esc(r.name)}</span>${r.note ? `<span class="mnote"${r.noteTitle ? ` title="${esc(r.noteTitle)}"` : ''}>${esc(r.note)}</span>` : ''}</span>`
        + `<span class="mval">${r.valueText != null ? esc(r.valueText) : money(r.value, r.cur)}</span>`
        + `<span class="rpct" style="color:${tone(r.dayTone != null ? r.dayTone : bp ? r.change : r.pct)}">${day}</span>`
        + `<span class="md5" title="5거래일 전 종가 대비">${d5}</span>${sparkSvg(r.spark)}</div>`);
    }
  }
  const count = (v) => checks.filter((c) => c.verdict === v).length;
  const judged = checks.filter((c) => c.verdict).length;
  return `<div class="qhint msum" title="경험칙을 숫자로 옮긴 참고용입니다 — 매매 판단을 대신하지 않습니다">데드캣 점검 · 긍정 ${count('good')}`
    + ` · 중립 ${count('neutral')} · 위험 ${count('risk')} (참고용)${judged < checks.length ? ` · 판정 ${judged}/${checks.length}` : ''}</div>`
    + out.join('');
}

// 시장 · 탭 버튼과 목록을 지금 보는 것으로 그린다. 같은 목록이면 다시 쓰지 않는다(30초마다 다시 쓰면
// 내려 둔 스크롤이 맨 위로 튄다). 탭이 바뀌면 맨 위부터. 지표 화면(mk)은 탭 줄이 없다.
function renderRank() {
  if (document.getElementById('rank').hidden) return;
  const { market, kind, group } = rankView;
  const mk = market === 'mk';
  document.getElementById('rankMarket').innerHTML = [['kr', '국내'], ['us', '미국'], ['mk', '지표']]
    .map(([m, label]) => `<button data-market="${m}"${m === market ? ' class="on"' : ''}>${label}</button>`).join('');
  const tabs = document.getElementById('rankTabs');
  tabs.hidden = mk;
  if (!mk) {
    tabs.innerHTML = RANK_TABS[market]
      .map(([k, label]) => `<button data-kind="${k}"${k === kind ? ' class="on"' : ''}>${label}</button>`).join('');
  }
  const key = mk ? 'mk' : rankKey(rankView);
  const hit = mk ? null : rankCache.get(key);
  const html = mk ? marketHtml() : (group ? rankBackHtml(kind, group) : '') + rankHtml(hit && hit.d, market, kind);
  const list = document.getElementById('rankList');
  if (html !== rankShown.html || key !== rankShown.key) {
    const keep = key === rankShown.key ? list.scrollTop : 0;
    list.innerHTML = html;
    list.scrollTop = keep;
    rankShown = { key, html };
  }
  if (!mk && (!hit || Date.now() - hit.at >= RANK_TTL)) loadRank(market, kind, group ? group.no : undefined);
  if (mk && (!marketExtras || Date.now() - marketExtras.at >= RANK_TTL)) loadMarket();
}

// 지표 화면의 market:extras — 받는 중이면 또 묻지 않고, 다시 받다 실패하면 있던 것을 둔다(loadRank 와 같다). 받으면 다시 그린다.
// 실패는 부분마다다 — 응답이 ok 라도 한 부분만 실패(null)했으면 그 부분은 있던 값을 둔다(FRED 기억이 끝난 직후 500 이면
// HY OAS 줄 · 판정이 1분 넘게 사라졌다, 리뷰 2026-10-27).
async function loadMarket() {
  if (marketLoading) return;
  marketLoading = true;
  let d;
  try {
    d = await api.marketExtras();
  } catch (e) {
    d = { ok: false, error: e.message };
  } finally {
    marketLoading = false;
  }
  const prev = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d : null;
  let next = d && d.ok ? { ...d } : prev || d || { ok: false, error: '응답 없음' };
  if (d && d.ok && prev) {
    for (const k of ['spotFlows', 'futFlows', 'kospiDays', 'futDays', 'hyOas']) if (next[k] == null && prev[k] != null) next[k] = prev[k];
  }
  marketExtras = { at: Date.now(), d: next };
  renderRank();
}

// 받는 중이면 또 묻지 않는다. 다시 받다 실패하면 있던 것을 둔다. 받으면 지금 보는 것을 다시 그린다 —
// 그사이 다른 탭으로 옮겼으면 늦게 온 응답은 캐시에만 남는다. no 는 업종 · 테마 안의 묶음 번호.
async function loadRank(market, kind, no) {
  const key = rankKey({ market, kind, group: no === undefined ? null : { no } });
  if (rankLoading.has(key)) return;
  rankLoading.add(key);
  let d;
  try {
    d = await api.rank(no === undefined ? { market, kind } : { market, kind, no });
  } catch (e) {
    d = { ok: false, error: e.message };
  } finally {
    rankLoading.delete(key);
  }
  const prev = rankCache.get(key);
  const keep = prev && prev.d && prev.d.ok && !(d && d.ok);
  rankCache.set(key, { at: Date.now(), d: keep ? prev.d : d || { ok: false, error: '응답 없음' } });
  renderRank();
}

// 시장을 바꿔도 지금 탭이 그 시장에도 있으면 그대로(급등 → 급등), 없으면(국내 인기 검색 · 미국 시총 상위) 첫 탭.
function setRankView(market, kind) {
  if (market === 'mk') { // 지표 화면 — 탭이 없다
    rankView = { market, kind: null, group: null };
    document.getElementById('rankMsg').hidden = true;
    renderRank();
    return;
  }
  const tabs = RANK_TABS[market];
  if (!tabs) return;
  const want = kind || rankView.kind;
  rankView = { market, kind: tabs.some(([k]) => k === want) ? want : tabs[0][0], group: null };
  document.getElementById('rankMsg').hidden = true;
  renderRank();
}

function openRank() {
  openPanel(rankEl);
  document.getElementById('rankMsg').hidden = true;
  renderRank();
}

const closeRank = () => closePanel(rankEl);

// 순위 목록을 누름(목록은 다시 그려지므로 상자에 한 번 붙인다) — ← 는 묶음 목록으로, 업종 · 테마 줄은 그 안으로,
// 종목 줄은 관심종목에 넣거나 그 종목으로(pickRank).
function rankClick(target) {
  const pick = target.closest('[data-sym]'); // 지표 화면의 시장 항목 — 지수 줄을 누를 때처럼 고른다
  if (pick) {
    closeRank();
    select(pick.dataset.sym).catch(console.error);
    return;
  }
  if (target.closest('[data-back]')) {
    rankView = { ...rankView, group: null };
    renderRank();
    return;
  }
  const hit = rankCache.get(rankKey(rankView));
  const d = hit && hit.d && hit.d.ok ? hit.d : null;
  const g = target.closest('[data-g]');
  const group = g && d && d.groups && d.groups[Number(g.dataset.g)];
  if (group) {
    rankView = { ...rankView, group };
    renderRank();
    return;
  }
  const row = target.closest('[data-i]');
  const it = row && d && d.items && d.items[Number(row.dataset.i)];
  if (it) pickRank(it).catch(console.error);
}

// 누르면: 관심종목에 있으면 그 종목으로 가고, 없으면 넣고 연다(검색에서 고를 때와 같다 — addSymbol 이 넣으면서
// 연다). 야후 시세에 없어 못 넣으면 패널을 두고 그렇다고 적는다.
async function pickRank(it) {
  const msg = document.getElementById('rankMsg');
  if (state.watchlist.some((w) => w.symbol === it.symbol)) {
    closeRank();
    await select(it.symbol);
    return;
  }
  // 같은 줄을 또 눌렀다 — 먼저 누른 것이 넣는 중이다. addSymbol 이 바로 돌아와 아래에서 "추가하지 못했습니다"로 적었다.
  if (adding.has(it.symbol)) return;
  msg.textContent = `${it.name} 추가하는 중…`;
  msg.hidden = false;
  await addSymbol({ symbol: it.symbol, name: it.name });
  if (state.watchlist.some((w) => w.symbol === it.symbol)) {
    msg.hidden = true;
    closeRank();
  } else {
    msg.textContent = `${it.name}: 추가하지 못했습니다 (야후 시세에 없는 종목)`;
    msg.hidden = false;
  }
}

