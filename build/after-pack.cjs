// 패키징 직후 실행 훅 — exe 아이콘과 버전 정보를 직접 넣는다.
//
// 왜 필요한가:
// electron-builder 의 기본 아이콘 삽입은 winCodeSign 을 내려받아 푸는데,
// 그 아카이브에 macOS 용 심볼릭 링크가 들어 있어 Windows 에서 개발자 모드나
// 관리자 권한 없이는 압축 해제가 실패한다. 그래서 win.signAndEditExecutable 을
// 끄고(=winCodeSign 자체를 건너뛰고), 아이콘만 rcedit 으로 따로 넣는다.
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  // make-icon.cjs 가 icon.svg 로 만든 멀티사이즈 ico(npm run dist 가 먼저 돌린다).
  // 예전에는 electron-builder 가 icon.png 로 만들던 dist/.icon-ico 를 봤는데, 55d2b4a 에서
  // make-icon 으로 바꾼 뒤로 그 파일이 생기지 않아 이 단계가 경고 한 줄만 남기고 건너뛰어졌다 —
  // 설치본이 "Electron" 이름 · 아이콘(작업 관리자, 바로가기)으로 나갔다.
  const ico = path.join(__dirname, 'icon.ico');

  // 건너뛰지 않고 빌드를 멈춘다. 경고는 빌드 로그에 묻혀 아무도 못 봤다.
  if (!fs.existsSync(exe)) throw new Error(`afterPack: exe 없음 — ${exe}`);
  if (!fs.existsSync(ico)) throw new Error(`afterPack: ico 없음 — ${ico} (npm run dist 로 빌드하면 make-icon 이 만든다)`);

  const rcedit = require('rcedit');
  await rcedit(exe, {
    icon: ico,
    'version-string': {
      ProductName: context.packager.appInfo.productName,
      FileDescription: context.packager.appInfo.description,
      CompanyName: 'Wuid0801',
      LegalCopyright: '',
    },
    'file-version': context.packager.appInfo.version,
    'product-version': context.packager.appInfo.version,
  });
  console.log(`  afterPack: 아이콘·버전 정보 삽입 완료 (${path.basename(exe)})`);
};
