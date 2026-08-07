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
  // electron-builder 가 icon.png 로부터 만들어 둔 ico
  const ico = path.join(context.outDir, '.icon-ico', 'icon.ico');

  if (!fs.existsSync(exe)) { console.warn(`  afterPack: exe 없음 — ${exe}`); return; }
  if (!fs.existsSync(ico)) { console.warn(`  afterPack: ico 없음 — 아이콘 삽입 건너뜀`); return; }

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
