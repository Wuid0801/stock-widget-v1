// 렌더러 소스 — index.html 이 싣는 renderer/*.js 를 그 태그 순서대로 이은 글자. 렌더러는 한 덩어리(예전 renderer.js)를 단락별로
// 나눈 클래식 스크립트들이라, 함수를 이름으로 꺼내거나 표식 사이를 잘라 보는 테스트(session-ui · state-contract · dom-contract)는
// 이어 붙인 글자를 예전 한 파일처럼 본다. 순서의 출처는 index.html 하나다 — 파일을 더하거나 옮기면 태그만 고친다.
import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', ROOT), 'utf8');

// 'renderer/state.js' … (index.html 의 태그 순서)
export const RENDERER_FILES = [...html.matchAll(/<script src="\.\/(renderer\/[\w-]+\.js)"><\/script>/g)].map((m) => m[1]);

export const rendererFile = (f) => fs.readFileSync(new URL(f, ROOT), 'utf8');
export const rendererSource = () => RENDERER_FILES.map(rendererFile).join('');
