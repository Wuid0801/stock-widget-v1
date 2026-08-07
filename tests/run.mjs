// 검증 스위트 러너.
//
//   npm test              전체 실행
//   npm test -- rsi dock  이름에 rsi / dock 이 들어간 스위트만 실행
//
// 각 스위트는 실제 앱을 Electron 으로 띄우고 실제 API를 호출한다.
// 설정 파일과 창을 공유하므로 반드시 순차 실행한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfig } from './_paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 빠른 것부터. 앱을 띄우지 않는 rsi 가 먼저 돌아 계산 회귀를 즉시 잡는다.
const ORDER = [
  'rsi.mjs',
  'chart-integrity.mjs',
  'watchlist.mjs',
  'reorder.mjs',
  'period.mjs',
  'moving-average.mjs',
  'week52.mjs',
  'indices.mjs',
  'realtime.mjs',
  'alerts.mjs',
  'dock.mjs',
  'compact-search.mjs',
  'minimize.mjs',
  'shortcut.mjs',
  'restore.mjs',
  'polling.mjs', // 간격 측정 때문에 가장 오래 걸린다
];

const filters = process.argv.slice(2);
const all = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run.mjs');
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

console.log(`${suites.length}개 스위트 실행\n`);
const results = [];
for (const file of suites) {
  try { resetConfig(); } catch { /* 설정 파일이 아직 없으면 무시 */ }
  process.stdout.write(`${file.padEnd(22)} ... `);
  const r = await run(file);
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
