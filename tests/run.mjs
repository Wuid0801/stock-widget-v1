// 검증 스위트 러너.
//
//   npm test              전체 실행
//   npm test -- rsi dock  이름에 rsi / dock 이 들어간 스위트만 실행
//
// 각 스위트는 실제 앱을 Electron 으로 띄우고 실제 API를 호출한다.
// 설정 파일과 창을 공유하므로 반드시 순차 실행한다.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfig, CFG_PATH, USER_DATA_DIR } from './_paths.mjs';
import { RENDERER_FILES } from './_renderer.mjs';

// 안전장치. 아래에서 매 스위트 전에 설정을 '{}' 로 밀기 때문에, 그 대상이 실제
// 사용자 프로필이면 npm test 한 번에 관심종목·보유·알림이 날아간다. 실제로 그런
// 적이 있다. isolation.mjs 도 같은 것을 보지만 이 러너는 실패해도 계속 진행하므로
// 검사만으로는 데이터를 지키지 못한다 — 여기서 아예 멈춘다.
if (!path.resolve(CFG_PATH).startsWith(path.resolve(USER_DATA_DIR) + path.sep)) {
  console.error('중단: 테스트 설정 경로가 임시 프로필 밖을 가리킵니다.');
  console.error(`  CFG_PATH      ${CFG_PATH}`);
  console.error(`  USER_DATA_DIR ${USER_DATA_DIR}`);
  console.error('tests/_paths.mjs 를 확인하세요. 실제 앱 설정을 지울 수 있습니다.');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 빠른 것부터. 앱을 띄우지 않는 rsi · trend · dom-contract 가 먼저 돌아
// 계산 회귀와 DOM 계약 위반을 즉시 잡는다.
const ORDER = [
  'isolation.mjs',
  'quote-session.mjs',
  'session-ui.mjs',
  'rsi.mjs',
  'techniques.mjs',
  'sources.mjs',
  'renderer-load.mjs',
  'trend.mjs',
  'backtest.mjs',
  'cross.mjs',
  'candle.mjs',
  'overlay.mjs',
  'zoom.mjs',
  'dom-contract.mjs',
  'state-contract.mjs',
  'net-timeout.mjs',
  'single-instance.mjs',
  'index-main.mjs',
  'chart-fill.mjs',
  'extended-chart.mjs',
  'sector.mjs',
  'detail.mjs',
  'rank.mjs',
  'backup.mjs',
  'search.mjs',
  'market.mjs',
  'chart-integrity.mjs',
  'watchlist.mjs',
  'reorder.mjs',
  'period.mjs',
  'moving-average.mjs',
  'week52.mjs',
  'indices.mjs',
  'realtime.mjs',
  'after-hours.mjs',
  'alerts.mjs',
  'dock.mjs',
  'compact-search.mjs',
  'minimize.mjs',
  'shortcut.mjs',
  'restore.mjs',
  'polling.mjs', // 간격 측정 때문에 가장 오래 걸린다
];

const filters = process.argv.slice(2);
// sources-live 는 앱 테스트가 아니라 바깥 출처 점검이다 — `npm run check:sources` 와 매주 도는 sources.yml 이 돌린다.
// sources-electron 은 같은 점검을 Electron 안에서(`npm run check:sources:electron`, Electron 을 올릴 때 손으로)
const all = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run.mjs' && f !== 'sources-live.mjs'
  && f !== 'sources-electron.mjs');
const ordered = [...ORDER.filter((f) => all.includes(f)), ...all.filter((f) => !ORDER.includes(f))];
const suites = filters.length
  ? ordered.filter((f) => filters.some((q) => f.includes(q)))
  : ordered;

if (!suites.length) {
  console.error(`일치하는 스위트 없음: ${filters.join(', ')}`);
  console.error(`사용 가능: ${ordered.join(', ')}`);
  process.exit(1);
}

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    const last = out.trimEnd().split('\n').pop() || '';
    // 스위트는 마지막 줄에 "PASS/FAIL: 실패 N건" 을 찍는다
    const passed = code === 0 && /(^|\s)PASS\b/.test(last);
    resolve({ file, passed, last: last.trim(), out, secs: ((Date.now() - started) / 1000).toFixed(0) });
  });
});

// 스위트가 앱 소스를 바꾸면 실패로 친다. 중간에 죽으면 바뀐 채로 남고, 도는 동안 편집한 내용을 옛 내용으로 덮을 수 있다
// (alerts.mjs 가 renderer.js 에 훅을 붙였다 되돌렸다 — isolation.mjs 의 정규식 검사는 변수 이름에 빠져나갔다).
const APP_SOURCES = ['main.js', 'preload.js', ...RENDERER_FILES, 'index.html', 'indicators.js', 'backtest.js', 'market-check.js', 'quote-session.cjs'];
const digest = () => APP_SOURCES.map((f) => crypto.createHash('sha1')
  .update(fs.readFileSync(path.join(HERE, '..', f))).digest('hex')).join();

console.log(`${suites.length}개 스위트 실행\n`);
const results = [];
for (const file of suites) {
  try { resetConfig(); } catch { /* 설정 파일이 아직 없으면 무시 */ }
  process.stdout.write(`${file.padEnd(22)} ... `);
  const before = digest();
  const r = await run(file);
  if (digest() !== before) {
    r.passed = false;
    r.last = `앱 소스가 바뀌었다(스위트가 고쳐 썼거나 실행 중에 편집됨) — ${r.last}`;
  }
  results.push(r);
  console.log(`${r.passed ? 'PASS' : 'FAIL'}  (${r.secs}s)  ${r.last}`);
  if (!r.passed) console.log(r.out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => `      ${l}`).join('\n'));
}
try { resetConfig(); } catch { /* noop */ }

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (failed.length) {
  console.log(`실패: ${failed.map((r) => r.file).join(', ')}`);
  process.exit(1);
}
