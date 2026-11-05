// renderer/data.js — 데이터 로딩 — 시세 · 일봉 · 보조 지표 계산 · 차트 요청(loadChart) · 30초 갱신(refreshAll).

// --- 데이터 로딩 ----------------------------------------------------------------
const err = (msg) => { document.getElementById('err').textContent = msg || ''; };

// 시세 조회에 실패한 종목이 있으면 그 메시지, 없으면 빈 문자열
function quoteErrText() {
  const failed = state.watchlist.filter((i) => quotes[i.symbol] && quotes[i.symbol].error);
  return failed.length ? `${failed.length}개 종목 조회 실패: ${quotes[failed[0].symbol].error}` : '';
}

// 일봉 1년치로 현재가/전일종가/RSI를 만든다.
// meta.chartPreviousClose는 "range 시작 직전" 종가라 일간 등락에 쓸 수 없다 → closes[len-2] 사용.
// 일봉 시리즈를 캐시에서 꺼낸다. 만료됐으면 다시 받는다. 받지 못하면 있던 캐시를 쓰되
// 낡았다고 표시한다(stale) — 몇 시간 전 값일 수 있다. 그 종목은 DAILY_RETRY 동안 쉬고, 이번
// 차례에 다른 종목이 실패했어도 건너뛴다. 캐시가 없는 종목은 쉬지 않는다 — 그 줄은 오류라
// 다음 갱신에 바로 다시 해 봐야 한다.
async function dailyFor(symbol, ttl) {
  const cached = dailyCache[symbol];
  if (cached && Date.now() - cached.at < ttl) return cached;
  if (cached && (Date.now() < (cached.retryAt || 0) || dailyFailRound === dailyRound)) {
    return { ...cached, stale: true };
  }

  const r = await api.fetchChart({ symbol, ...DAILY });
  if (!r.ok) {
    dailyFailRound = dailyRound;
    if (!cached) return { error: r.error };
    cached.retryAt = Date.now() + DAILY_RETRY;
    return { ...cached, stale: true };
  }

  const last = r.closes.length - 1;
  dailyCache[symbol] = {
    at: Date.now(),
    price: r.price,
    closes: r.closes,
    times: r.times,
    // 목록의 오늘 캔들용 폴백(해외 종목·네이버 실패). 마지막 봉만 쓰므로 시가 배열은 들고 있지 않는다.
    candle: { open: r.opens?.[last], high: r.highs?.[last], low: r.lows?.[last] },
    // 파라볼릭 SAR(보조 지표)은 지난 흐름을 이어받아 5년치 고 · 저가 있어야 1M 첫 봉부터 값이 맞는다
    // (종목당 약 1,250봉 × 2 — 수십 KB).
    highs: r.highs || [],
    lows: r.lows || [],
    // 보조 지표용. 거래량 평균은 5년치가 있어야 1M 첫 봉부터 그려지고(이동평균과 같은 이유),
    // 전일 고가 · 저가는 마지막 며칠의 고 · 저만 있으면 된다.
    volumes: r.volumes || [],
    recent: { times: r.times.slice(-5), highs: (r.highs || []).slice(-5), lows: (r.lows || []).slice(-5) },
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
  };
  return dailyCache[symbol];
}

async function loadQuote(item, live) {
  // 실시간 가격이 따로 오면 일봉은 오래 캐시해도 된다.
  // 실시간이 없으면(폴백) 일봉의 가격을 그대로 쓰므로 짧게만 캐시한다.
  // 미국 종목은 실시간이 있어도 짧게 둔다 — 야후 미국 일봉은 늦지 않아 RSI 를 그대로 맞춰 주고,
  // 아래에서 일봉을 건드리지 않는다. 미국 지수 · 환율도 일봉을 건드리지 않지만 캐시는 길게 둔다 —
  // 세 개를 1분마다 5년치씩(약 80KB) 받기에는 지수 RSI 가 몇 분 늦는 것이 낫다.
  // 실시간이 없는 지수 항목(달러 인덱스 · 금 · 구리는 늘, 나머지는 네이버 실패 때)은 5분 — 1분이면 지표 화면을 열지 않아도
  // 셋이 1분마다 5년치를 받았고, 네이버가 막히면 지수 전부가 그랬다.
  const overseas = isOverseas(item.symbol);
  const r = await dailyFor(item.symbol, live && !isUs(item.symbol) ? DAILY_TTL : isIndex(item.symbol) ? 5 * 60000 : 60000);
  if (!r || r.error) {
    quotes[item.symbol] = { error: r ? r.error : '조회 실패', fetchedAt: Date.now() };
    return;
  }

  const closes = r.closes.slice();
  let times = r.times;
  let price = r.price;
  let prevClose = closes.length >= 2 ? closes[closes.length - 2] : price;

  if (live) {
    // 현재가/전일종가는 실시간 값으로 교체한다
    price = live.price;
    prevClose = live.prevClose;
  }
  // 미국 종목 · 지수 · 환율은 일봉을 그대로 둔다. 프리 · 애프터 가격이 정규장 봉에 들어가고, 한국 날짜로
  // "오늘" 을 가르면 밤 22:30~05:00 의 정규장 하루가 둘로 쪼개진다.
  if (live && !overseas) {
    // 마지막 일봉 종가도 현재가로 맞춰 RSI가 20분 지난 값으로 계산되지 않게 한다.
    // 다만 마지막 봉이 아직 어제인데(장 전 프리마켓 · 개장 직후 — 야후 일봉은 20분 늦고 30분 캐시)
    // 실시간은 오늘 거래면, 어제 종가를 지우지 않고 오늘 봉을 덧붙인다. 덮으면 어제 봉의 이동평균
    // 끝점이 오늘 가격으로 틀어져 차트의 어제 캔들(실제 종가)과 어긋났다. 시각은 야후 일봉처럼 그날
    // 09:00 KST(00:00 UTC)다 — maFor 는 UTC 날짜로 짝짓는데 08:30 KST 는 UTC 로 아직 어제다.
    // 실시간 값이 오늘 것이 아니면(휴장일 · 장 전 08:00 이전) 지금처럼 마지막 봉을 맞춘다.
    const kstDay = (ms) => Math.floor((ms + 9 * 3600000) / 86400000);
    const today = kstDay(Date.now());
    if (closes.length && kstDay(times[times.length - 1]) < today
      && live.tradedAt && kstDay(Date.parse(live.tradedAt)) === today) {
      closes.push(price);
      times = [...times, today * 86400000];
    } else if (closes.length) {
      closes[closes.length - 1] = price;
    }
  }

  const change = price - prevClose;
  quotes[item.symbol] = {
    price,
    prevClose,
    change,
    pct: prevClose ? (change / prevClose) * 100 : 0,
    rsi: calcRSI(closes),
    // 주봉 RSI — 같은 일봉(오늘은 지금 가격)을 주로 묶은 종가로. 이번 주는 진행 중인 값이다. 과열도는 일봉 RSI 다.
    rsiWeek: calcRSI(weekCloses(times, closes)),
    live: !!live,
    // 실시간 없이 야후도 실패해 캐시로 만든 가격 — 받은 시각과 함께 "갱신 실패" 로 보인다(renderUpdated).
    // 실시간이 있으면 가격은 새것이다. 낡은 일봉은 RSI · 이동평균 · 52주에만 쓰인다.
    stale: !live && !!r.stale,
    open: !!(live && live.open),
    session: live ? quoteSession(live) : 'unknown',
    priceSession: priceSessionOf(live),
    isTrading: tradingState(live),
    regularClose: live && live.regularClose != null ? live.regularClose : null,
    // 오늘 캔들. 실시간이 정규장 시·고·저를 함께 주면 그것을 쓰고(30초마다 최신),
    // 없으면 일봉 마지막 봉에서 가져온다 — 가격과 같은 폴백 순서다.
    candle: (live && live.candle) || r.candle || null,
    market: live && live.market || null,
    source: live && live.source || (live ? 'Naver' : 'Yahoo'),
    tradedAt: live && live.tradedAt || null,
    openTime: live && live.openTime || null, // 정규장 시작 'HHMM' — 분봉이 언제 들어오는지 알릴 때 쓴다
    closeTime: live && live.closeTime || null, // 정규장 끝 'HHMM' — 1D 차트의 종가 점 이름표(intradayEnd)
    fetchedAt: !live && r.stale ? r.at : Date.now(),
    // 장후 가격의 검증된 당일 정규장 종가 대비 이동폭. 종료 후에도 유지한다.
    // 0 도 뜻이 있는 값이라(움직이지 않음) || 로 뭉개면 안 된다.
    fromClose: live && live.fromClose != null ? live.fromClose : null,
    currency: r.currency,
    week52High: r.week52High,
    week52Low: r.week52Low,
    // 이동평균 계산용. 1M 차트는 23봉뿐이라 자체 데이터로는 20일선이 끝부분만 그려진다.
    // 이미 받아둔 1년치를 그대로 재활용해 추가 요청 없이 앞구간까지 채운다.
    daily: { times, closes },
    // 거래량 평균 · 전일 고저(보조 지표). 거래량은 받은 일봉 그대로라 시각도 그 일봉의 것이다.
    dailyVolume: { times: r.times, volumes: r.volumes || [] },
    dailyHL: { times: r.times, highs: r.highs || [], lows: r.lows || [] },
    recentBars: r.recent || null,
  };
}

// 일봉 값(srcTimes 와 짝인 values)을 차트 시각에 날짜로 맞춘다 — maFor 와 같은 UTC 날짜 짝짓기.
function alignByDay(srcTimes, values, times) {
  const dayOf = (t) => Math.floor(t / 86400000);
  const byDay = new Map();
  for (let i = 0; i < srcTimes.length; i++) byDay.set(dayOf(srcTimes[i]), values[i]);
  const out = times.map((t) => (byDay.has(dayOf(t)) ? byDay.get(dayOf(t)) : null));
  return out.some((v) => v != null) ? out : null;
}

// 볼린저 밴드 — 이동평균처럼 5년치 일봉 종가(오늘 봉은 현재가)로 계산해 차트에 맞춘다.
function bandFor(symbol, times) {
  const d = quotes[symbol] && quotes[symbol].daily;
  if (!d || d.closes.length < BB_PERIOD) return null;
  const b = bollinger(d.closes, BB_PERIOD, BB_K);
  const upper = alignByDay(d.times, b.upper, times);
  const lower = alignByDay(d.times, b.lower, times);
  return upper && lower ? { upper, lower } : null;
}

// 파라볼릭 SAR(보조 지표). SAR 은 지난 흐름(극값 · 가속)을 이어받아서 차트 첫 봉에서 새로 시작하면 1M 은
// 대부분 다른 값이 된다 — 일봉 기간은 차트 첫날 앞의 5년치 일봉 고 · 저를 이어 붙여 계산한다. 차트 봉은 오늘
// 봉을 실시간 캔들로 맞춘 값이라 차트 쪽을 쓴다. 1D · 1W(ext 를 넘긴다, 없으면 null)는 받은 분봉만으로 첫 봉부터,
// 정규장 봉만 — 시간외는 거래가 드물어 빈 칸을 채운 평평한 봉이 많아 엉뚱한 곳에서 뒤집힌다. 시간외 칸은 null.
// 돌려주는 값: { data, up(봉마다), rising(지금 상승인지), since(전환 봉부터 센 봉 수), flipAt(전환 봉 시각) } | null
function sarFor(symbol, times, highs, lows, ext) {
  const intraday = ext !== undefined;
  const hs = []; const ls = []; const ts = [];
  const d = !intraday && times.length && quotes[symbol] && quotes[symbol].dailyHL;
  if (d) {
    const first = Math.floor(times[0] / 86400000); // 이동평균과 같은 UTC 날짜 짝짓기
    for (let i = 0; i < d.times.length && Math.floor(d.times[i] / 86400000) < first; i++) {
      hs.push(d.highs[i]); ls.push(d.lows[i]); ts.push(d.times[i]);
    }
  }
  const pre = hs.length;
  const idx = times.map((_, i) => i).filter((i) => !(ext && ext[i]));
  for (const i of idx) { hs.push(highs[i]); ls.push(lows[i]); ts.push(times[i]); }
  const r = parabolicSar(hs, ls, SAR_STEP, SAR_MAX);
  const last = hs.length - 1;
  if (last < 1) return null;
  let k = last;
  while (k > 1 && r.up[k - 1] === r.up[last]) k--;
  const data = new Array(times.length).fill(null);
  const up = new Array(times.length).fill(null);
  idx.forEach((i, j) => { data[i] = r.sar[pre + j]; up[i] = r.up[pre + j]; });
  return { data, up, rising: r.up[last], since: last - k + 1, flipAt: ts[k] };
}

// RSI · 시그널(보조 지표). 일봉 기간은 이동평균처럼 5년치 일봉 종가(오늘 봉은 현재가)로 계산해 날짜로 맞춘다 — 첫 봉부터 값이
// 있다. 1D · 1W 는 앞 거래일 봉(warm — 차트 첫 봉 앞의 종가들, rsiWarmFor)을 앞에 이어 첫 봉부터 값이 있고 증권사 앱처럼 날을
// 넘어 이어진다. warm 을 못 받으면 받은 봉만으로(앞 14봉이 빈다). 시간외 봉도 그대로 잇는다 — 빈 칸을 채운 평평한 봉은
// RSI 를 움직이지 않는다. 교차는 확정된 것만(마지막 봉은 진행 중) — 골든 · 데드와 같은 규칙(confirmedCrosses).
// 돌려주는 값: { data, signal, crosses, rising(마지막 확정 교차가 위로인지, 없으면 null), since(그 봉부터 센 봉 수), flipAt } | null
function rsiFor(symbol, times, closes, warm) {
  let data; let signal; let found;
  if (TF[state.timeframe].interval === '1d') {
    const d = quotes[symbol] && quotes[symbol].daily;
    if (!d) return null;
    const r = rsiSeries(d.closes, RSI_PERIOD);
    data = alignByDay(d.times, r, times);
    if (!data) return null;
    signal = alignByDay(d.times, rsiSignal(r, RSI_SIGNAL), times) || times.map(() => null);
    found = crossings(data, signal);
  } else {
    const pre = warm || [];
    const r = rsiSeries([...pre, ...closes], RSI_PERIOD);
    const g = rsiSignal(r, RSI_SIGNAL);
    data = r.slice(pre.length);
    signal = g.slice(pre.length);
    // 첫 봉의 교차는 앞 거래일 마지막 봉과 견준다
    found = crossings(r, g).filter((c) => c.i >= pre.length).map((c) => ({ ...c, i: c.i - pre.length }));
  }
  if (!data.some((v) => v != null)) return null;
  const crosses = confirmedCrosses(found, times.length);
  const last = crosses[crosses.length - 1];
  // 1D 는 진행 중인 마지막 봉의 교차도 따로 준다 — drawChart 가 테두리 점으로 그리고, 봉이 끝나면 crosses 로 옮겨 속이 찬다.
  // 일봉 기간은 오늘 봉이 하루 내내 진행 중이라 종일 생겼다 사라지기를 되풀이해 뺀다. 1W 도 1D 만 해 달라고 했다(2026-10-29).
  const pending = state.timeframe === '1D' ? found.find((c) => c.i === times.length - 1) || null : null;
  return { data, signal, crosses, pending, rising: last ? last.golden : null, since: last ? times.length - last.i : null,
    flipAt: last ? times[last.i] : null };
}

// 1D · 1W RSI 의 앞 거래일 봉 — 차트 첫 봉(first) 앞의 종가들. 지금 기간의 RSI_WARM(정규장)을 받는다 — 국내는 main 이 네이버
// KRX 분봉으로 준다(야후 국내 5분봉은 15:00 뒤 봉이 없다). 지난 날 봉은 바뀌지 않아 차트 첫 봉 뒤에 받은 것이면 다시 받지 않는다
// (날이 바뀔 때 한 번 꼴). 실패하면
// null(받은 봉만으로 계산한다 — 앞쪽이 빈다)이고 RSI_WARM_RETRY 동안 다시 묻지 않는다.
async function rsiWarmFor(symbol, first) {
  const req = RSI_WARM[state.timeframe];
  const key = `${symbol} ${req.interval}`;
  let hit = rsiWarmCache.get(key);
  const fresh = hit && (hit.closes ? hit.at >= first : Date.now() - hit.at < RSI_WARM_RETRY);
  if (!fresh) {
    const r = await api.fetchChart({ symbol, ...req }).catch(() => null);
    hit = { at: Date.now(), times: r && r.ok ? r.times : null, closes: r && r.ok ? r.closes : null };
    rsiWarmCache.set(key, hit);
  }
  return hit.closes ? hit.closes.filter((_, i) => hit.times[i] < first) : null;
}

// 거래량 평균. 일봉 기간은 5년치 일봉 거래량으로(첫 봉부터 평균이 있다).
function dailyVolAvg(symbol, times) {
  const d = quotes[symbol] && quotes[symbol].dailyVolume;
  if (!d || d.volumes.length < VOL_AVG) return null;
  return alignByDay(d.times, sma(d.volumes, VOL_AVG), times);
}

// 분봉(1D · 1W) · 전체 탭은 받은 봉으로. 1D 시간외 봉과 거래량 0 인 봉(끼운 끝점 · 야후 종가 봉)은
// 평균에서 빼고 그 칸은 비운다 — 시간외 거래량은 기준이 다르다(미국 프리 0, 국내는 NXT).
function seriesVolAvg(volumes, ext) {
  const idx = volumes.map((_, i) => i).filter((i) => !(ext && ext[i]) && volumes[i] > 0);
  const avg = sma(idx.map((i) => volumes[i]), VOL_AVG);
  const out = new Array(volumes.length).fill(null);
  idx.forEach((i, k) => { out[i] = avg[k]; });
  return out;
}

// 시장 날짜(일 번호) — 시간외 봉과 일봉을 같은 날로 짝지을 때. 국내는 한국 날짜다 — NXT 프리(08:00 KST)는 UTC 로
// 전날이다. 미국 종목 · 지수는 뉴욕 시각을 -5시간 고정으로 센다 — 04:00~20:00 ET 가 서머타임이든 아니든 같은 날로
// 떨어진다(UTC 로 세면 겨울에 19~20시 ET 가 다음 날이 된다). 일봉(국내 00:00 UTC · 미국 13:30/14:30 UTC)은 어느 쪽으로
// 세도 그날이다. 환율은 하루 내내 돌아 예전처럼 UTC 날짜. 선물(=F)은 야후 일봉 하나가 CME 하루(18:00 ET ~ 다음 날
// 17:00 ET)이고 시각은 끝 날의 00:00 ET 다(2026-10-23 실측 NQ · CL — 일봉 시가가 전날 18:00 봉의 시가). +2시간이면
// 서머타임이든 아니든 그 하루가 끝 날의 날짜로 떨어진다(쉬는 17~18시 ET 가 자정에 걸린다).
function marketDay(ms, symbol) {
  const usMarket = isUs(symbol) || (symbol.startsWith('^') && isOverseas(symbol));
  const offset = symbol.endsWith('=F') ? 2 : usMarket ? -5 : isOverseas(symbol) ? 0 : 9;
  return Math.floor((ms + offset * 3600000) / 86400000);
}

// 1D 가 보여 주는 날의 바로 앞 거래일 고가 · 저가(전고 · 전저). 날짜는 그 시장의 날짜다(marketDay).
function prevDayRange(symbol, times) {
  const r = quotes[symbol] && quotes[symbol].recentBars;
  if (!r || !times.length) return null;
  const day = (ms) => marketDay(ms, symbol);
  const shown = day(times[times.length - 1]);
  for (let i = r.times.length - 1; i >= 0; i--) {
    if (day(r.times[i]) < shown && r.highs[i] > 0 && r.lows[i] > 0) return { high: r.highs[i], low: r.lows[i] };
  }
  return null;
}

// 툴팁 가격 옆 등락률의 기준(봉마다). 1D 는 전일 종가 — 차트의 '전일' 선 · 위 등락률과 같은 값. 1W(30분봉)는 그 봉
// 날짜(시장 날짜 — 국내 프리 · 미국 겨울 애프터 봉이 UTC 로 하루 밀린다)의 앞 거래일 종가(일봉) — 바로 앞 30분봉과
// 견주면 0.1% 남짓의 잡음이다. 일봉 ·
// 월봉은 앞 봉 종가(그날 · 그달 등락률)이고, 일봉의 첫 봉은 일봉에서 그 앞 거래일 종가. 빈 종가는 건너뛰고, 없으면 null.
function tipBases(symbol, times, closes) {
  const q = quotes[symbol];
  if (state.timeframe === '1D') return times.map(() => (q && q.prevClose > 0 ? q.prevClose : null));
  const d = q && q.daily;
  const dayOf = (t) => marketDay(t, symbol);
  let j = 0; let last = null;
  const before = (t) => { // t 의 날짜 앞의 마지막 일봉 종가 — times 는 오름차순이라 앞으로만 간다
    while (d && j < d.times.length && dayOf(d.times[j]) < dayOf(t)) { if (d.closes[j] > 0) last = d.closes[j]; j++; }
    return last;
  };
  if (state.timeframe === '1W') return times.map(before);
  let prev = times.length && state.timeframe !== '전체' ? before(times[0]) : null;
  return closes.map((c) => { const b = prev; if (c > 0) prev = c; return b; });
}

// 차트 시각(times)에 맞춰 일봉 이동평균을 끌어온다. 일봉이 아닌 타임프레임은 대상 아님.
function maFor(symbol, times, period) {
  const d = quotes[symbol] && quotes[symbol].daily;
  if (!d || d.closes.length < period) return null;

  // 시각이 아니라 날짜로 짝짓는다(alignByDay). 장중 오늘 봉의 시각은 마지막 체결 시각이라
  // 일봉과 차트를 받은 순간마다 달라서(실측 1초 차), 정확히 맞추면 오늘 값이 빠진다.
  // UTC 날짜를 쓰는 건 한국(00:00~06:30 UTC)·미국(13:30~21:00 UTC) 장이 모두 하루 안에
  // 들어가서다 — 한국 날짜로 자르면 미국 장이 자정을 넘겨 오늘 봉이 이틀로 갈린다.
  return alignByDay(d.times, sma(d.closes, period), times);
}

// 실시간 시세 조회 (실패해도 조용히 빈 값 → Yahoo 지연 시세로 동작)
async function fetchLive(symbols) {
  // 실패/빈 응답이 직전의 장마감 상태를 남겨 폴링을 늦추지 않게 한다.
  isLive = false;
  marketOpen = true;
  try {
    const r = await api.realtimeQuotes(symbols);
    if (!r || !r.ok || !r.quotes) return {};
    isLive = true;
    const requested = new Set(symbols);
    const all = [...new Set([...state.watchlist.map((i) => i.symbol), ...symbols])];
    const combined = {};
    for (const symbol of all) {
      combined[symbol] = requested.has(symbol)
        ? r.quotes[symbol] || r.quotes[symbol.split('.')[0]] : quotes[symbol];
    }
    marketOpen = pollingIsOpen(all, combined);
    return r.quotes;
  } catch (e) {
    console.error('실시간 시세 조회 실패', e);
    return {};
  }
}

// 차트 응답 캐시. 종목·타임프레임을 오갈 때마다 같은 걸 다시 받으면
// 매번 네트워크 왕복을 기다리게 된다. 1D(5분봉)만 폴링 주기와 같은 30초로 두고
// 나머지는 5분 — 일봉이 30초마다 바뀔 일은 없다.
const chartCache = new Map(); // `symbol|range|interval|ext` -> { at, ttl, r }
const chartTtl = (interval) => (interval === '5m' ? 30000 : 5 * 60 * 1000);

// 차트 요청. 시간외를 받을 수 있는 기간(1D · 1W)이라도 정규장만 보기(state.extHours === false)면 묻지 않는다.
function chartTf(key) {
  return TF[key].extended && state.extHours === false ? { ...TF[key], extended: false } : TF[key];
}

async function fetchChartCached(symbol, tf) {
  const key = `${symbol}|${tf.range}|${tf.interval}|${tf.extended ? 'ext' : ''}`; // 정규장 · 전체는 다른 응답이다
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.r;

  const r = await api.fetchChart({ symbol, ...tf });
  if (!r.ok) return r; // 실패는 캐시하지 않는다 (다음 시도에서 바로 다시 받게)

  // 만료된 항목을 치워 캐시가 무한정 늘지 않게 한다
  const now = Date.now();
  for (const [k, v] of chartCache) if (now - v.at >= v.ttl) chartCache.delete(k);

  chartCache.set(key, { at: now, ttl: chartTtl(tf.interval), r });
  return r;
}

let lastDrawSig = null; // 내용이 그대로면 다시 그리지 않는다

// 1D 차트의 끝. 야후 5분봉은 20분 늦어 차트 끝이 위에 보이는 가격보다 뒤처진다.
//  - 장중(정규장 거래 중): 현재가를 지금 시각에 덧붙인다.
//  - 정규장이 끝나 확인된 종가가 있으면(지수는 마감 뒤 값이 곧 종가): 종가로 끝낸다. 15:30 뒤 가격은 NXT
//    애프터마켓에서 오고(세션 애프터마켓) 야후 종가 봉(거래량 0)은 15:50쯤 와서, 예전에는 그사이 차트가 20분 전
//    봉에서 멈췄다(2026-10-13). 야후 종가 봉이 이미 있으면 점을 더하지 않고 그 봉 값을 거래소 종가로 맞춘다 —
//    둘이 한 틱 다르면 끝이 두 개가 된다. 이름표는 거래소가 알려 준 종료 시각(closeTime)이다.
//  - 단일가 · 일시정지처럼 정규장 가격이 멈춰 있고 아직 종가가 없으면: 그 가격을 지금 시각에 덧붙인다.
//  - 애프터 · 프리 가격은 정규장 차트에 넣지 않는다(애프터 · 프리 점선이 따로 있다). 오늘 가격이 아니면(장 전 ·
//    휴일) 아무것도 하지 않는다.
// 돌려주는 값: null | { value, replace: true }(마지막 봉 값을 바꾼다) | { value, at }(at 시각에 덧붙인다)
function intradayEnd(q, lastVolume, nowMs) {
  if (!q || !q.live || q.price == null) return null;
  if (q.open && q.session === 'regular') return { value: q.price, at: nowMs };
  const kstDay = (ms) => Math.floor((ms + 9 * 3600000) / 86400000);
  if (!q.tradedAt || kstDay(Date.parse(q.tradedAt)) !== kstDay(nowMs)) return null;
  const close = q.regularClose != null ? q.regularClose : q.priceSession === 'closed' ? q.price : null;
  if (close != null) {
    return lastVolume === 0 ? { value: close, replace: true } : { value: close, at: kstClockMs(q.closeTime, nowMs) ?? nowMs };
  }
  return q.priceSession === 'regular' ? { value: q.price, at: nowMs } : null;
}

// 오늘(한국 시간) 'HHMM' 의 시각(ms). 형식이 아니면 null.
function kstClockMs(hhmm, nowMs) {
  if (!/^\d{4}$/.test(hhmm || '')) return null;
  const midnight = Math.floor((nowMs + 9 * 3600000) / 86400000) * 86400000 - 9 * 3600000;
  return midnight + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2))) * 60000;
}

// 분봉이 들어오기 시작하는 시각(한국 시간 'HH:MM')과 거기까지 남은 분(지났으면 0 이하).
// 야후 국내 시세는 늦게 오므로 개장 시각 + delayMin 이다. openTime 은 네이버가 주는
// 'HHMM' — 수능일처럼 늦게 여는 날은 1000 이 온다. 없으면 평소 개장(09:00)으로 본다.
function intradayEta(nowMs, openTime, delayMin) {
  const hhmm = /^\d{4}$/.test(openTime || '') ? openTime : '0900';
  const startMin = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2)) + delayMin;
  const kst = new Date(nowMs + 9 * 3600000); // 보는 사람의 시간대와 상관없이 한국 시간으로 센다
  const nowOfDay = ((kst.getUTCHours() * 60 + kst.getUTCMinutes()) * 60 + kst.getUTCSeconds()) * 1000
    + kst.getUTCMilliseconds();
  const p = (n) => String(n).padStart(2, '0');
  return {
    at: `${p(Math.floor(startMin / 60))}:${p(startMin % 60)}`,
    minutes: Math.ceil((startMin * 60000 - nowOfDay) / 60000),
  };
}

// 남은 분을 "약 7분 뒤" · "약 2시간 20분 뒤" 로
function leftText(minutes) {
  if (minutes < 60) return `약 ${minutes}분 뒤`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `약 ${h}시간 ${m}분 뒤` : `약 ${h}시간 뒤`;
}

// 분봉(1D · 1W)이 비어 있을 때의 안내. 고장이 아니라는 것과 언제 들어오는지를 말한다.
// 국내만 시각을 댄다 — 해외는 야후가 늦지 않아 이 이유로 비지 않는다.
function intradayWaitText(item, q) {
  const head = `${item.name} ${state.timeframe}`;
  // 국내 지수도 야후 분봉이 국내 종목처럼 20분 늦다. isDomestic 은 그대로 둔다 — 폴링 · 알림이 쓴다. 해외 지수 · 선물 ·
  // 금리 · 환율(지수 줄)은 한국 개장과 상관없다 — 예전에는 WTI 1D 가 비면 "보통 09:20쯤" 이라고 했다(2026-10-27).
  if (isOverseas(item.symbol)) return `${head}: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`;
  const eta = intradayEta(Date.now(), q && q.openTime, YAHOO_KR_DELAY_MIN);
  return eta.minutes > 0
    ? `${head}: 분봉은 ${eta.at}쯤부터 들어옵니다 (${leftText(eta.minutes)} · 1M 이상은 정상)`
    : `${head}: 분봉이 늦어지고 있습니다 (보통 ${eta.at}쯤 들어옵니다 · 1M 이상은 정상)`;
}

async function loadChart() {
  const item = selectedItem(); // 관심종목 또는 지수
  if (!item) { document.getElementById('period').hidden = true; return; }

  // 종목/타임프레임을 빠르게 바꾸면 요청이 겹친다. 응답이 뒤늦게 도착한
  // 이전 요청은 버려야 헤더와 차트가 서로 다른 종목을 가리키지 않는다.
  // 네트워크가 느리면 응답까지 몇 초가 걸린다. 그동안 다른 종목 · 기간의 차트를 그대로 두면 탭 · 헤더는 새것인데
  // 차트 · 기간 배지는 옛것이라 눌러도 데이터가 안 바뀐 것처럼 보였다(2026-10-15). 다른 화면으로 넘어가면 옛 차트를
  // 먼저 지우고 불러오는 중을 띄운다. 같은 화면의 30초 갱신은 차트를 그대로 둔다(깜빡이지 않게).
  const key = `${item.symbol}|${state.timeframe}`;
  if (key !== drawnKey) {
    if (drawnKey) clearChart();
    document.getElementById('period').hidden = true;
    document.getElementById('chartBox').className = chartBoxClass(true);
  }
  const seq = ++chartSeq;
  const tf = chartTf(state.timeframe);
  // 차트만 보기(차트 위 버튼): 이동평균 · 보조 지표 · 추세선 · 교차 · 가로선 · 기간 배지를 그리지 않는다.
  // 칩 설정은 그대로 두고 그리기만 건너뛰어, 다시 누르면 원래대로 돌아온다. 가격과 거래량 막대는 남는다.
  const plain = state.plainChart === true;
  // 지수 대비 수익률(보조 지표)은 같은 기간의 지수 차트가 필요하다 — 종목 차트와 함께 받는다(같은 캐시).
  // 일봉(1M 이상)만이다 — 지수와 날짜로 짝짓는데, 1W(30분봉)는 지수 기준이 첫날 마지막 봉 · 종목 기준이 첫 봉이 되고
  // 비교선이 계단이 됐다(종목 · 지수 모두 +10% 인데 초과 +5.24%p).
  const bench = !plain && state.indicators && state.indicators.rel && !['1D', '1W'].includes(state.timeframe)
    ? benchmarkOf(item.symbol) : null;
  const [got, benchGot] = await Promise.all([fetchChartCached(item.symbol, tf),
    bench ? fetchChartCached(bench.symbol, tf).catch(() => null) : null]);
  if (seq !== chartSeq) return; // 더 새 요청이 있다 — 불러오는 중은 그 요청이 내린다
  document.getElementById('chartBox').className = chartBoxClass(); // RSI 를 켜고 끈 것도 여기서 높이에 든다
  const r = got.ok && tf.years ? lastYears(got, tf.years) : got; // 3Y: 5년치에서 3년만

  if (!r.ok) {
    // 다른 종목 · 기간의 차트는 남겨 두면 헤더와 다른 것을 보이므로 지운다(위에서 이미 지웠다 — drawnKey 가 다르다).
    // 같은 화면의 갱신이 한 번 실패(야후 429 · 시간 초과)한 것은 그리던 차트를 두고 오류만 적는다 — 지우면 다음 갱신
    // (장 마감 뒤 5분)까지 빈칸이었다. 장 시작 직후의 빈 응답은 그날 차트가 아직 없다는 뜻이라 지운다.
    if (key !== drawnKey || r.error === '빈 데이터') {
      clearChart();
      document.getElementById('period').hidden = true;
    }
    // 장 시작 직후엔 Yahoo가 한국 분봉을 아직 안 채워 빈 응답이 온다.
    // 일봉(1M 이상)은 정상이므로 고장이 아니라는 걸 알려주고, 언제 들어오는지 말한다.
    const intraday = tf.interval !== '1d';
    err(intraday && r.error === '빈 데이터'
      ? intradayWaitText(item, quotes[item.symbol])
      : `${item.name} 차트: ${r.error}`);
    return;
  }
  // RSI(보조 지표)의 1D · 1W 는 앞 거래일 봉을 앞에 잇는다 — 차트 첫 봉 앞의 종가들(하루 한 번 받는다, rsiWarmFor)
  const rsiWarm = !plain && state.indicators && state.indicators.rsi && RSI_WARM[state.timeframe] && r.times.length
    ? await rsiWarmFor(item.symbol, r.times[0]) : null;
  if (seq !== chartSeq) return;

  err(quoteErrText());
  const q = quotes[item.symbol];
  const closes = r.closes.slice();
  const times = r.times.slice();
  // 1D · 1W 시간외 봉(main.js): 봉마다 'pre' · 'after', 정규장은 null. 그 구간의 배경을 옅게 칠한다.
  const ext = r.ext ? r.ext.slice() : null;

  // Yahoo 1D 봉은 20분 전에서 끊긴다. 끝점을 이어붙이거나(장중 현재가 · 장 마감 뒤 종가)
  // 야후 종가 봉을 거래소 종가로 맞춰 차트 끝과 위에 표시된 가격이 어긋나 보이지 않게 한다.
  // 미국 종목은 야후 분봉이 늦지 않아 맞출 것이 없다(intradayEnd 의 날짜 · 시각도 한국 기준이다). 국내도 네이버 실시간
  // 분봉으로 받았으면(main.js 가 realtime 을 단다 — 야후로 그렸을 때만 없다) 봉이 이미 지금까지 있어 맞출 것이 없다.
  // 기준은 정규장의 마지막 봉이다 — 뒤에 애프터 봉이 붙어 있어도. 끝점은 시각 순서대로 끼운다.
  const lastReg = ext ? ext.lastIndexOf(null) : closes.length - 1;
  const end = state.timeframe === '1D' && !isOverseas(item.symbol) && !r.realtime
    ? intradayEnd(q, r.volumes && r.volumes[lastReg], Date.now()) : null;
  let endAt = -1; // 끼운 끝점의 자리 — 아래 봉 단위 배열들도 같은 자리를 채운다
  if (end && end.replace) {
    if (lastReg >= 0) closes[lastReg] = end.value;
  } else if (end) {
    const later = times.findIndex((t) => t > end.at);
    const i = later < 0 ? closes.length : later;
    // 애프터 봉보다 뒤("지금")로 가는 끝점은 붙이지 않는다 — 선이 애프터에서 정규장 값으로 되돌아간다.
    if (!(lastReg >= 0 && lastReg < closes.length - 1 && i > lastReg + 1)) {
      closes.splice(i, 0, end.value);
      times.splice(i, 0, end.at);
      if (ext) ext.splice(i, 0, null);
      endAt = i;
    }
  }

  // 1D 외에는 "일간 등락"만 보여주면 탭과 안 맞는다. 해당 구간 수익률도 같이 표시.
  // 시작은 첫 정규장 봉이다 — 1W 전체의 첫 봉은 그날 프리라 그대로 쓰면 정규장 / 전체에 따라 값이 달라진다.
  if (plain) document.getElementById('period').hidden = true;
  else {
    const first = r.ext ? r.ext.indexOf(null) : 0;
    renderPeriod(r.closes[first], q && q.price != null ? q.price : closes[closes.length - 1],
      benchReturn(bench, benchGot, r.times[first]));
  }

  // 이동평균선은 일봉 타임프레임(1M/3M/1Y/3Y)에서만 의미가 있다.
  // 1D(5분봉)/1W(30분봉)에 "5일선"을 그리면 이름과 실제가 안 맞는다.
  const daily = tf.interval === '1d';
  const bars = daily ? r.times.length : 0;
  if (bars !== chartBars) { chartBars = bars; renderMaChips(); } // 켤 수 있는 기간이 바뀐다

  const mas = [];
  for (const p of plain ? [] : state.maPeriods) {
    if (!maFits(p)) continue; // 구간에 비해 너무 긴 선은 y축만 벌리므로 건너뛴다
    const data = maFor(item.symbol, times, p);
    if (data) mas.push({ p, data }); // 색 · 굵기는 그릴 때 maColor · maWidth 로 읽는다(설정에서 바뀐다)
  }

  // 골든/데드크로스. 양쪽 이평선이 실제로 그려지는 조합만 본다
  // (설정 칩에서 5·20·60 을 다 켜둬야 두 쌍 모두 나온다).
  const byPeriod = new Map(mas.map((m) => [m.p, m.data]));
  const found = [];
  for (const [s, l] of CROSS_PAIRS) {
    const a = byPeriod.get(s); const b = byPeriod.get(l);
    if (!a || !b) continue;
    for (const c of crossings(a, b)) found.push({ ...c, pair: `${s}/${l}` });
  }
  found.sort((x, y) => x.i - y.i);
  // 배지와 차트 표식(▲▼)이 같은 목록을 쓴다 — 확정 전 교차를 한쪽만 숨기면
  // 배지는 옛 교차를 말하는데 차트에는 오늘 표식이 찍혀 서로 어긋난다.
  const crosses = confirmedCrosses(found, times.length);
  renderCrossBadge(crosses, times);

  // 1D 는 끝점을 끼웠으므로 봉 단위 배열들보다 한 칸 길다 → 그 칸을 채운다
  const pad = (src, fill) => {
    const at = (i) => (typeof fill === 'function' ? fill(i) : fill);
    if (!src) return closes.map((_, i) => at(i));
    const a = src.slice(0, r.closes.length);
    if (endAt >= 0) a.splice(endAt, 0, at(endAt));
    while (a.length < closes.length) a.push(at(a.length));
    return a;
  };
  const volumes = pad(r.volumes, 0);
  const opens = pad(r.opens, (i) => closes[i]);
  const highs = pad(r.highs, (i) => closes[i]);
  const lows = pad(r.lows, (i) => closes[i]);

  // 야후 국내 시세는 20분 지연이라 오늘 봉이 화면의 다른 값들보다 뒤처진다 —
  // 상세 캔들(네이버 실시간)과 같은 값으로 마지막 봉을 맞춘다. 맞추지 않으면
  // 한 화면이 서로 다른 순간을 가리킨다(2026-09-22 삼성전자 저가 274,500 vs
  // 274,000). 덕분에 일봉 차트 끝점도 헤더 현재가와 어긋나지 않는다.
  // 마지막 봉이 오늘이 아니면(장 전 · 휴장) 건드리지 않는다 — 지나간 봉에
  // 오늘 값을 쓰면 없던 고가·저가가 생긴다.
  const todayBar = daily ? candleOf(q) : null;
  if (todayBar && daysAgo(times[times.length - 1]) === 0) {
    const i = closes.length - 1;
    closes[i] = todayBar.close;
    opens[i] = todayBar.open;
    highs[i] = todayBar.high;
    lows[i] = todayBar.low;
  }
  // 네이버 실시간 봉(국내 1D · 1W)도 받은 지 차트 캐시(1D 30초 · 1W 5분)만큼 지나 끝이 헤더 현재가와 달랐다(2026-10-27
  // SK하이닉스 헤더 1,368,000 · 차트 끝 1,365,000). 장중이면 오늘 마지막 정규장 봉의 종가를 현재가로 맞추고 고가 · 저가를
  // 넓힌다 — 점을 더하지 않아 봉 수는 그대로다. 장 전 · 휴장(마지막 정규장 봉이 지난 날)과 장 마감 뒤는 건드리지 않는다.
  if (r.realtime && q && q.live && q.open && q.session === 'regular' && q.price != null && lastReg >= 0
    && daysAgo(times[lastReg]) === 0) {
    closes[lastReg] = q.price;
    highs[lastReg] = Math.max(highs[lastReg], q.price);
    lows[lastReg] = Math.min(lows[lastReg], q.price);
  }

  // 추세선은 3M · 1Y 에서만. 검사를 통과 못 한 쪽은 빠지므로
  // 지지선만, 저항선만, 또는 둘 다 없는 상태가 정상이다.
  const trends = [];
  if (!plain && TREND_TF.has(state.timeframe)) {
    const len = closes.length;
    const sup = trendLine(lows, len, true);
    const res = trendLine(highs, len, false);
    // 선을 만들 때 빼둔 최근 봉이 그 선을 뚫었는지 같이 담는다.
    if (sup) trends.push({ ...sup, varName: '--sup-line', broke: breakoutOf(sup, lows, len, true) });
    if (res) trends.push({ ...res, varName: '--res-line', broke: breakoutOf(res, highs, len, false) });
  }
  renderTrendBadges(trends, closes.length, times);

  // 보조 지표(설정의 칩). 볼린저 밴드는 이동평균처럼 일봉 기간에만, VWAP 는 1D 정규장 봉만 —
  // 시간외 거래량은 기준이 달라(미국 프리 0, 국내는 NXT) 섞으면 평균가의 뜻이 흐려진다.
  const ind = plain ? {} : state.indicators || {};
  const bands = ind.bb && daily ? bandFor(item.symbol, times) : null;
  const vw = ind.vwap && state.timeframe === '1D'
    ? vwap(highs, lows, closes, volumes, (i) => !(ext && ext[i])) : null;
  const vwapLine = vw && vw.some((v) => v != null) ? vw : null;
  const volAvg = ind.volAvg ? (daily ? dailyVolAvg(item.symbol, times) : seriesVolAvg(volumes, ext)) : null;
  // SAR 은 1D · 1W 와 일봉 기간만 — 전체(월봉 · 분기봉)는 봉 크기가 들쭉날쭉하다. 1W(30분봉)는 1D 처럼 받은 봉만으로
  // 5일 전 첫 봉부터(더 긴 분봉 이력이 없다). 밤 사이 갭에서 뒤집히기도 하지만 드물었다(2026-10-15 실측).
  const sar = !ind.sar ? null
    : daily ? sarFor(item.symbol, times, highs, lows)
      : state.timeframe === '1D' || state.timeframe === '1W' ? sarFor(item.symbol, times, highs, lows, ext) : null;
  const rsi = ind.rsi && RSI_TF.has(state.timeframe) ? rsiFor(item.symbol, times, closes, rsiWarm) : null;
  // 지수 비교선 — 배지 때문에 이미 받은 지수 차트로(새 요청 없음)
  const bline = benchLine(bench, benchGot, times, closes);
  const tips = tipBases(item.symbol, times, closes); // 툴팁 가격 옆 등락률의 기준

  const held = state.holdings[item.symbol];
  const up = !q || q.change >= 0;

  // 가로 기준선. 전일 종가는 장중(1D)에만 의미가 있다 —
  // 일봉 차트에서는 마지막에서 두 번째 점일 뿐이라 기준선이 될 이유가 없다.
  const hLines = [];
  if (!plain && held && held.avg > 0) hLines.push({ value: held.avg, label: '평단', varName: '--avg-line' });
  if (!plain && state.timeframe === '1D' && q) {
    if (q.prevClose != null) {
      hLines.push({ value: q.prevClose, label: '전일', varName: '--prev-line' });
    }
    // 시간외 가격은 별도 기준선이다. 종료 후에도 마지막 가격의 출처를 유지한다.
    // 시간외 한 점을 정규장 5분봉에 붙이면 시간 간격이 왜곡된다.
    const origin = priceSessionOf(q);
    if ((origin === 'after' || origin === 'pre') && q.price != null) {
      hLines.push({ value: q.price, label: origin === 'after' ? '애프터' : '프리', varName: '--over-line' });
    }
    // 어제 고가 · 저가 — 이름표가 묶이거나 가장자리로 가도 어느 선인지 알게 옅은 빨강 · 파랑(높으면 빨강)
    const prev = ind.prevHL ? prevDayRange(item.symbol, times) : null;
    if (prev) {
      hLines.push({ value: prev.high, label: '전고', varName: '--prevhi-line' },
        { value: prev.low, label: '전저', varName: '--prevlo-line' });
    }
  }

  const chart = {
    closes, times, up, mas, cur: curOf(item.symbol),
    volumes, opens, highs, lows, crosses, hLines, trends, ext, bands, vwapLine, volAvg, sar, rsi, benchLine: bline, tipBases: tips,
    profile: !!ind.vp && daily, // 매물대 — 보이는 구간(확대 포함)으로 drawChart 가 계산한다
  };

  // 30초마다 캐시에서 같은 데이터가 나오면 다시 그릴 이유가 없다 — 다시 그리면 차트가 통째로 재생성돼 마우스를
  // 올려둔 범례 값도 같이 지워진다. 그릴 값 전체와, drawChart 가 그 밖에서 읽는 화면 상태(캔들 · 확대 · 칩 · 차트만
  // 보기 · 정규장/전체)를 견준다. 값을 손으로 골라 이어 붙이던 때는 빠진 값이 바뀌어도 다시 그리지 않았다 — 켠
  // 직후 시세 없이 그린 첫 차트에 일봉이 와도 볼린저 · SAR · 툴팁 등락률이 빠진 채 남았다(2026-11-05).
  const sig = JSON.stringify([key, chart, state.chartMode, zoom && [zoom.start, zoom.end],
    INDICATORS.map((i) => (ind[i.key] ? 1 : 0)).join(''), plain, state.extHours !== false]);
  if (sig === lastDrawSig) return;
  lastDrawSig = sig;
  drawnKey = key;

  drawChart(chart);
}

async function refreshAll() {
  if (busy) return;
  busy = true;
  dailyRound++; // 일봉 실패를 차례 단위로 센다(dailyFor)
  try {
    const indexNow = await loadIndices();

    // 실시간 현재가는 한 번에 (요청 1건), 일봉은 rate limit 고려해 종목별 순차
    const liveMap = await fetchLive(state.watchlist.map((i) => i.symbol));
    // 목록은 처음 받는 종목만 그때그때(첫 화면이 빨리 차게), 나머지는 끝에 한 번 다시 그린다 — 종목마다 그리면 갱신
    // 한 번에 목록을 종목 수만큼 새로 만들고, 받는 사이 줄 요소가 바뀌어 누름 · 끌기가 끊길 수 있었다.
    // 순서 바꾸기 · 지우기가 목록을 바꿔도 흔들리지 않게 사본을 돌고, 그사이 지운 종목은 묻지 않는다. 받는 사이 지운
    // 종목의 시세는 남기지 않는다 — 지울 때 지운 시세가 늦게 온 응답으로 되살아나 영영 남았다.
    for (const item of [...state.watchlist]) {
      if (!state.watchlist.includes(item)) continue;
      const first = !quotes[item.symbol];
      await loadQuote(item, liveMap[item.symbol.split('.')[0]]);
      if (!state.watchlist.includes(item)) { delete quotes[item.symbol]; continue; }
      if (first) renderList();
    }
    renderList();
    // 지수도 종목과 같은 시세로 만든다 — 누르면 바로 뜨게 둘 다. 네이버 지수를 못 받았으면
    // 실시간 없이 들어가 야후 값(20분지연)이 된다(종목 폴백과 같다).
    for (const ix of INDICES) await loadQuote(ix, indexLive(indexNow.find((n) => n.code === ix.code)));
    checkAlerts();
    err(quoteErrText());
    renderDetail();
    renderRank(); // 순위 패널이 열려 있으면 1분이 지난 탭을 다시 받는다
    loadEvents().catch(console.error); // 관심종목 일정 — 6시간 지난 종목만, 기다리지 않는다
    await renderFolio();
    await loadChart();

    renderUpdated();
  } finally {
    busy = false;
    lastRefreshAt = Date.now(); // 실패로 끝나도 센다 — 실패할 때 더 두드리지 않게
  }
}

