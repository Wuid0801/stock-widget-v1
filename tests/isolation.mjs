// 테스트가 실제 앱 설정을 건드리지 않는지 확인한다. 앱을 띄우지 않는다.
//
// run.mjs 는 매 스위트 전에 resetConfig() 로 설정을 '{}' 로 밀고, 스위트들은
// 앱을 띄워 관심종목을 넣고 지운다. 그 대상이 실제 사용자 설정이면 npm test
// 한 번에 관심종목·보유·알림이 날아간다. 실제로 그렇게 비어 있었다.
//
// 건드릴 수 있는 프로필이 둘이다:
//   %APPDATA%/kr-stock-widget   개발 실행 (package.json 의 name)
//   %APPDATA%/관심종목 위젯      설치본 (productName) — packaged.mjs 가 띄운다
// 둘 다 --user-data-dir 로 임시 경로를 물려 격리해야 한다.
import fs from 'node:fs';
import path from 'node:path';
// 네임스페이스로 받는다. 이름 하나가 없으면 ESM 이 SyntaxError 로 죽어버려
// 어느 검사가 깨졌는지 보이지 않는다.
import * as P from './_paths.mjs';

const { APP_DIR, CFG_PATH, USER_DATA_DIR, LAUNCH_ARGS } = P;

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
const REAL = ['kr-stock-widget', '관심종목 위젯'].map((n) => path.join(APPDATA, n));

check('USER_DATA_DIR 가 정의돼 있다', typeof USER_DATA_DIR === 'string' && USER_DATA_DIR.length > 0,
  String(USER_DATA_DIR));

if (typeof USER_DATA_DIR === 'string') {
  for (const real of REAL) {
    check(`임시 프로필이 실제 프로필과 다르다 (${path.basename(real)})`,
      path.resolve(USER_DATA_DIR) !== path.resolve(real)
      && !path.resolve(USER_DATA_DIR).startsWith(path.resolve(real) + path.sep),
      USER_DATA_DIR);
  }
  check('설정 파일이 임시 프로필 안에 있다',
    path.resolve(CFG_PATH).startsWith(path.resolve(USER_DATA_DIR) + path.sep), CFG_PATH);
  check('임시 프로필 디렉터리가 만들어져 있다', fs.existsSync(USER_DATA_DIR));
}

for (const real of REAL) {
  check(`설정 파일이 실제 프로필을 가리키지 않는다 (${path.basename(real)})`,
    !path.resolve(CFG_PATH).startsWith(path.resolve(real) + path.sep), CFG_PATH);
}

check('launchApp 이 --user-data-dir 를 넘긴다',
  Array.isArray(LAUNCH_ARGS) && LAUNCH_ARGS.some((a) => a === `--user-data-dir=${USER_DATA_DIR}`),
  JSON.stringify(LAUNCH_ARGS));

// packaged.mjs 는 설치본을 자기 손으로 띄우므로 _paths 의 launchApp 을 타지 않는다.
const pkg = fs.readFileSync(path.join(APP_DIR, 'tests', 'packaged.mjs'), 'utf8');
check('packaged.mjs 도 --user-data-dir 를 넘긴다', pkg.includes('--user-data-dir'),
  /args:\s*\[[^\]]*\]/.exec(pkg)?.[0] || '(args 를 찾지 못함)');

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
