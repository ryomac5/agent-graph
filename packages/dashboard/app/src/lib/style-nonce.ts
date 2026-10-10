export function readStyleNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="agent-graph-style-nonce"]')?.content ?? '';
}

export function installStyleNonce(): void {
  const nonce = readStyleNonce();
  if (!nonce) return;
  const createElement = document.createElement;
  // xterm など nonce の設定口を持たない部品の style 要素も CSP で許可するため、生成時に付ける。
  document.createElement = function (tagName: string, options?: ElementCreationOptions) {
    const element = createElement.call(document, tagName, options);
    if (element.localName === 'style') element.setAttribute('nonce', nonce);
    return element;
  } as typeof document.createElement;
}
