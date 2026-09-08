// 테스트가 의존하는 DOM 계약 가드 — 앱을 띄우지 않고 index.html 만 본다.
//
// #dname 의 textContent 는 "종목명"이어야 한다. 8개 스위트(watchlist · reorder ·
// restore · realtime · holdings · foreign · week52 · chart-integrity)가 이 값을
// 종목명과 직접 비교한다.
//
// 한 번 깨진 적이 있다. 업종을 붙이면서 #dname 을 래퍼로 만들고 이름을
// #dnameText 로 옮겼는데, 그러자 textContent 가 "삼성전자Consumer Electronics"
// 가 됐다(가운뎃점은 CSS ::before 라 textContent 에 없다). 업종은 네트워크를
// 타므로 도착 시점에 따라 값이 달라져 그 8개가 flaky 하게 깨진다.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './_paths.mjs';

const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');

let fails = 0;
const check = (t, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${t}${x ? '  ' + x : ''}`); };

const nameTag = /<(\w+)[^>]*\bid="dname"/.exec(html);
const sectorTag = /<(\w+)[^>]*\bid="dsector"/.exec(html);

check('#dname 이 있다', !!nameTag);
check('#dsector 가 있다', !!sectorTag);

if (nameTag && sectorTag) {
  // 래퍼가 아니라 이름만 담는 잎 노드여야 한다
  check('#dname 은 span 이다 (래퍼 div 가 아니다)', nameTag[1] === 'span', `<${nameTag[1]}>`);

  // #dsector 가 #dname 안에 들어가 있으면 textContent 에 업종이 섞인다
  const between = html.slice(nameTag.index, sectorTag.index);
  check('#dname 이 #dsector 보다 먼저 나온다', sectorTag.index > nameTag.index);
  check('#dname 이 #dsector 를 감싸지 않는다 (사이에 닫는 태그가 있다)',
    between.includes('</span>'), between.replace(/\s+/g, ' ').slice(0, 80));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: 실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
