// 데이터 출처 점검을 Electron 안에서 — `npm run check:sources:electron`. 항목은 tests/sources-live.mjs 와 같고(앱 main.js 처리기
// 그대로), 네트워크만 앱과 같다: Node fetch 는 Electron 안의 것, net.fetch 자리(FRED)는 진짜 Electron net.fetch(Chromium).
// 주간 점검(sources-live)은 일반 Node 로 돌아 Electron 에서만 막히는 것을 못 잡는다 — Electron 44 로 올린 뒤 FRED 가 앱 안의
// Node fetch 에만 답하지 않았다(2026-11-02, 일반 Node 22 는 0.2초). Electron 을 올릴 때 돌린다. 앱 창은 뜨지 않는다.
// 항목 결과 뒤에 출처마다 요청 수 · 실패 · 가장 느린 것(앱 제한 8초) · 앞단(봇 차단을 하는 Akamai · Cloudflare 등의 흔적)을 적는다.
// 하나라도 FAIL 이면 종료 코드 1. 장 밖에서는 분봉 · 실시간 항목이 모양 때문에 FAIL 일 수 있다 — 요청 실패인지를 본다.
import { app, net } from 'electron';
import { runChecks } from './sources-live.mjs';

const log = []; // { host, via, ms, status | error, edge }
// 앞단 흔적 — server 머리와, 봇 차단 쿠키 · 머리(Akamai _abck · bm_sz 등, Cloudflare __cf_bm · cf-ray)
const edgeOf = (res) => {
  const h = res.headers;
  const cookies = typeof h.getSetCookie === 'function' ? h.getSetCookie().map((c) => c.split('=')[0]) : [];
  const marks = [];
  if (cookies.some((c) => ['_abck', 'bm_sz', 'bm_sv', 'ak_bmsc', 'bm_mi'].includes(c))
    || [...h.keys()].some((k) => k.startsWith('akamai') || k.startsWith('x-akamai'))) marks.push('akamai');
  if (h.get('cf-ray') || cookies.includes('__cf_bm')) marks.push('cloudflare');
  if (h.get('x-amz-cf-id')) marks.push('cloudfront');
  return `${h.get('server') || '-'}${marks.length ? ` [${marks.join(',')}]` : ''}`;
};
const timed = (via, impl) => async (url, opt) => {
  const host = new URL(String(url)).host;
  const t = Date.now();
  try {
    const res = await impl(url, opt);
    log.push({ host, via, ms: Date.now() - t, status: res.status, edge: edgeOf(res) });
    return res;
  } catch (e) {
    log.push({ host, via, ms: Date.now() - t, error: `${e.name}: ${e.message}` });
    throw e;
  }
};

app.whenReady().then(async () => {
  const kst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Electron 안 데이터 출처 점검 — electron ${process.versions.electron} (node ${process.versions.node}) · KST ${kst}\n`);
  const results = await runChecks(timed('node', fetch), undefined, timed('net.fetch', (u, o) => net.fetch(u, o)));
  console.log('[항목]');
  for (const r of results) {
    console.log(`${r.problems.length ? 'FAIL' : 'OK  '} ${r.name}`);
    for (const p of r.problems) console.log(`       - ${p}`);
  }
  console.log('\n[출처별 요청] 개수 · 실패 · 가장 느린 것(앱 제한 8000ms) · 앞단');
  for (const host of new Set(log.map((x) => x.host))) {
    const xs = log.filter((x) => x.host === host);
    const bad = xs.filter((x) => x.error || x.status >= 400);
    const edges = [...new Set(xs.filter((x) => x.edge).map((x) => x.edge))].join(' | ');
    const vias = [...new Set(xs.map((x) => x.via))].join(' · ');
    console.log(`${bad.length ? 'FAIL' : 'OK  '} ${host} (${vias}) ${xs.length}개 · 실패 ${bad.length} · 최대 ${Math.max(...xs.map((x) => x.ms))}ms · ${edges || '-'}`);
    for (const b of bad.slice(0, 3)) console.log(`       - ${b.error || `HTTP ${b.status}`} ${b.ms}ms`);
  }
  const bad = results.filter((r) => r.problems.length).length;
  console.log(`\n${bad ? 'FAIL' : 'PASS'}: ${results.length}개 중 ${bad}개 실패`);
  process.exit(bad ? 1 : 0);
});
