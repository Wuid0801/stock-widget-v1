# Naver session regression snapshots

Public market responses captured on 2026-09-15, Asia/Seoul. No account data.

- `naver-break-20260915.json`: 15:56, KRX `OPEN + break + regularMarket`, nested after price active.
- `naver-after-20260915.json`: 16:05, KRX `OPEN + open + afterMarket`, base price moves.
- `naver-nxt-20260915.json`: 16:08, direct NXT `afterMarket`, ETF 069500 omitted.

Sources: `https://polling.finance.naver.com/api/realtime/domestic/stock/{codes}`
and `https://polling.finance.naver.com/api/realtime/domestic/NXT/stock/{codes}`.
These captures are not simultaneous; tests set the clock explicitly.

Venue mapping was verified against Naver's deployed web client route configuration
(`domestic-stock-krx` / `domestic-stock-nxt`) and the explicit `krx` / `nxt`
records at `https://m.stock.naver.com/front-api/domestic/stock/detail?itemCode=005930`.
The polling `stockExchangeType` object is KOSPI/KS even on the NXT endpoint.
Legacy `overMarketPriceInfo` is a fallback with an unknown venue, not an assumed KRX close.

No dedicated same-day regular-close field was found in the realtime response, so a
cold start after 16:00 reads the close back from daily chart metadata instead:
Yahoo's regularMarketPrice paired with regularMarketTime, accepted only when that
time is at or after the endTime the exchange itself reported. Measured 2026-09-15:
regularMarketTime 15:30:22 KST with endTime 1530, and the daily close matched the
captured regular close exactly for both 005930 (248,500) and 000660 (1,690,000).

The time check is what makes it safe. Korean Yahoo quotes are 20 minutes delayed, so
between 15:30 and 15:50 the same fields still hold an intraday price. The adapter
still refuses to infer a close from an arbitrary 15:30 candle, lastClosePrice
(previous day), or a moving after price, and it never hardcodes a closing hour.
