// Naver quote adapter. Pure functions: no clock, network or Electron globals.
// OPEN means the market is available, not necessarily the regular session.
// The top-level price also moves in KRX afterMarket (observed 2026-09-15).

function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function koreaDate(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sessionOf(value) {
  return ({ regularMarket: 'regular', beforeMarket: 'pre', preMarket: 'pre',
    afterMarket: 'after', BEFORE_MARKET: 'pre', AFTER_MARKET: 'after' })[value] || 'unknown';
}

function activity(status, detail, stop, phase, ms, now) {
  // Old Friday prices are still useful on weekends, but are not live sessions.
  if (ms != null && koreaDate(ms) !== koreaDate(now)) return false;
  if (status === 'CLOSE' || status === 'CLOSED' || detail === 'break' || detail === 'close') return false;
  if (stop && stop !== 'TRADING') return false;
  if (status === 'OPEN' && phase !== 'unknown' && ms != null) return true;
  return null; // Missing/new enum values must not silently become regular trading.
}

function candidate(data, kind, now) {
  const base = kind === 'base';
  if (!data) return null;
  const price = numberOrNull(base ? (data.closePriceRaw ?? data.closePrice) : data.overPrice);
  const change = numberOrNull(base
    ? (data.compareToPreviousClosePriceRaw ?? data.compareToPreviousClosePrice)
    : data.compareToPreviousClosePrice);
  if (price == null || price <= 0 || change == null || price - change <= 0) return null;
  const ms = timestamp(data.localTradedAt);
  // Reject future-dated feed records, allowing a small transport/clock skew.
  if (ms != null && ms > now + 60000) return null;
  const priceSession = sessionOf(base ? data.marketSessionType : data.tradingSessionType);
  return {
    price, change, prevClose: price - change, priceSession,
    source: base ? 'naver-base' : 'naver-over',
    // Venue names are supplied only when independently verified by the caller.
    market: null,
    tradedAt: ms == null ? null : data.localTradedAt, ms,
    active: activity(base ? data.marketStatus : data.overMarketStatus,
      base ? data.marketStatusDetailType : null, data.tradeStopType?.name, priceSession, ms, now),
  };
}

// Today's open/high/low for the price candle, from the INTEGRATED session.
// The top-level fields cover KRX alone, but NXT opens an hour earlier, so on a
// day when it trades first the two disagree - Samsung on 2026-09-22 opened at
// 283,000 on KRX and 279,000 integrated, which is the difference between a
// large body with no upper shadow and a small one with a long shadow. Brokers
// chart the integrated session, so integratedPriceInfo wins where it exists;
// it carries no ...Raw variants, and numberOrNull strips the thousands commas.
// The over-market object is never a source here: it has a price, not a range.
function dayCandle(data) {
  const p = data?.integratedPriceInfo || data;
  const open = numberOrNull(p?.openPriceRaw ?? p?.openPrice);
  if (open == null || open <= 0) return null;
  return {
    open,
    high: numberOrNull(p?.highPriceRaw ?? p?.highPrice),
    low: numberOrNull(p?.lowPriceRaw ?? p?.lowPrice),
  };
}

function overFromClose(regularClose, price, priceSession) {
  if (priceSession !== 'after') return null;
  if (!Number.isFinite(regularClose) || regularClose <= 0 || !Number.isFinite(price)) return null;
  return price - regularClose;
}

// Only capture a finalized regular quote at the exchange's declared closing time.
// Never save the last price seen during an active regular session as its close.
function confirmedRegularClose(data) {
  if (sessionOf(data?.marketSessionType) !== 'regular') return null;
  if (!(data.marketStatus === 'CLOSE' || ['break', 'close'].includes(data.marketStatusDetailType))) return null;
  const ms = timestamp(data.localTradedAt);
  const end = data.stockExchangeType?.endTime;
  const price = numberOrNull(data.closePriceRaw ?? data.closePrice);
  if (ms == null || !/^\d{4}$/.test(end || '') || price == null || price <= 0) return null;
  const clock = new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(11, 19).replace(/:/g, '');
  if (clock !== `${end}00`) return null;
  return { date: koreaDate(ms), price };
}

// The same-day regular close, read back from daily chart metadata. Needed on a
// cold start after 16:00, when the realtime close field already carries the
// after price and no finalized regular record is left to capture.
//
// endTime is the exchange close the feed itself reports, not a hardcoded hour.
// Anything stamped before it is still an intraday price (Korean quotes are
// delayed 20 minutes), so it is rejected rather than shown as a close.
function dailyRegularClose(meta, endTime) {
  const price = numberOrNull(meta?.price);
  const ms = Number.isFinite(meta?.timeMs) ? meta.timeMs : null;
  if (price == null || price <= 0 || ms == null) return null;
  if (!/^\d{4}$/.test(endTime || '')) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  if (Number(kst.slice(11, 16).replace(':', '')) < Number(endTime)) return null;
  // The date travels with the price: a stale close can never match another day.
  return { date: kst.slice(0, 10), price };
}

function normalizeQuote(data, { now = Date.now(), regularClose = null, nxt = null } = {}) {
  const base = candidate(data, 'base', now);
  if (base) base.market = 'KRX'; // Verified Naver domestic-stock-krx endpoint.
  const directNxt = candidate(nxt, 'base', now);
  if (directNxt) {
    directNxt.market = 'NXT';
    directNxt.source = 'naver-nxt';
  }
  // Legacy nested field is only a fallback. Do not guess its venue.
  const over = directNxt || candidate(data?.overMarketPriceInfo, 'over', now);
  let candidates = [base, over].filter(Boolean);
  if (!candidates.length) return null;

  const dated = candidates.filter((q) => q.ms != null);
  if (dated.length) {
    const latestDate = koreaDate(Math.max(...dated.map((q) => q.ms)));
    // An old AFTER_MARKET object must not override today's regular/pre price.
    candidates = dated.filter((q) => koreaDate(q.ms) === latestDate);
  }
  const active = candidates.filter((q) => q.active === true);
  // A live record's localTradedAt is the response serialization time, not a trade
  // time: two venues polled together are microseconds apart and the order flips
  // every poll (measured 2026-09-15 - a 52us gap decided a 1,000 KRW difference).
  // So while something is trading, pick by venue: candidates are ordered KRX first.
  // A finished record's timestamp is a real close time, so latest still wins there.
  const selected = active.length
    ? active[0]
    : candidates.reduce((a, b) => ((b.ms ?? -Infinity) > (a.ms ?? -Infinity) ? b : a));
  const isTrading = active.length ? true : candidates.some((q) => q.active == null) ? null : false;
  const session = isTrading === true ? selected.priceSession : isTrading === false ? 'closed' : 'unknown';
  const captured = confirmedRegularClose(data);
  const date = selected.ms == null ? null : koreaDate(selected.ms);
  const close = [captured, regularClose].find((c) => c && c.date === date && Number.isFinite(c.price) && c.price > 0);
  return {
    price: selected.price, change: selected.change, prevClose: selected.prevClose,
    open: isTrading === true && session === 'regular',
    session, priceSession: selected.priceSession, isTrading,
    regularClose: close?.price ?? null,
    candle: dayCandle(data),
    fromClose: overFromClose(close?.price, selected.price, selected.priceSession),
    market: selected.market,
    source: selected.source, tradedAt: selected.tradedAt,
    // Regular open as the exchange reports it (HHMM). Late-open days (e.g. the college
    // entrance exam) say 1000; the empty-intraday hint uses it to tell when bars arrive.
    openTime: /^\d{4}$/.test(data?.stockExchangeType?.startTime || '') ? data.stockExchangeType.startTime : null,
    // Regular close (HHMM). The 1D chart labels its close point with it while Yahoo's close bar is still late.
    closeTime: /^\d{4}$/.test(data?.stockExchangeType?.endTime || '') ? data.stockExchangeType.endTime : null,
  };
}

module.exports = { normalizeQuote, confirmedRegularClose, overFromClose, dailyRegularClose };
