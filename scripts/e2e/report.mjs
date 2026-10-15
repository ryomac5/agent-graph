import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const JOURNEYS = [
  ['1-claude', 'Claude: 新規会話・送信・返事'],
  ['1-codex', 'Codex: 新規会話・送信・返事'],
  ['2', '作業中の追加送信・Queued・重複なし'],
  ['3', '最新履歴・再読み込み・タブの往復'],
  ['4', 'fork・同じ根・古いタブから継続'],
  ['5-ui', '行の名前変更・サイドバー・タブ'],
  ['5-terminal', '端末の /rename・サイドバー・タブ'],
  ['6', 'Apply・モデル確認・二度送りの拒否'],
  ['7', 'Working・Idle/Done・SessionEnd 後の継続'],
  ['8-date', '行の日付が最新のやり取りになる'],
  ['8-root', '同じ根が二行に分かれない'],
  ['9-delivered', '届いた通常送信に未着の誤通知がない'],
  ['9-missing', '届かなかった通常送信を通知する'],
  ['9-bang', '! の配達確認・未着通知'],
  ['10', 'pageerror・console error がない'],
];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export class Report {
  constructor(directory, metadata, log = console.log) { this.directory = directory; this.metadata = metadata; this.log = log; this.results = []; this.errors = []; }
  async initialize() { await mkdir(this.directory, { recursive: true }); await this.save(); }
  async step(id, page, run, evidence) {
    const name = JOURNEYS.find(row => row[0] === id)?.[1] ?? id;
    const started = Date.now();
    const result = { id, name, status: 'pass', started: new Date(started).toISOString(), artifacts: [] };
    try { result.detail = await run(); }
    catch (error) { result.status = 'fail'; result.error = error.stack ?? String(error); }
    if (page && !page.isClosed()) {
      try {
        const image = `${id}.png`; await page.screenshot({ path: join(this.directory, image), fullPage: true, timeout: 10_000 }); result.artifacts.push(image);
        const dom = `${id}.html`; await writeFile(join(this.directory, dom), await page.content()); result.artifacts.push(dom);
        if (evidence) {
          const file = `${id}.json`; await writeFile(join(this.directory, file), JSON.stringify(await evidence(), null, 2)); result.artifacts.push(file);
        }
      } catch (error) { result.status = 'fail'; result.error = `${result.error ?? ''}\n証拠の保存失敗: ${error.message}`; }
    }
    for (const name of await readdir(this.directory)) if (name.startsWith(id + '-') && name.endsWith('.png')) result.artifacts.push(name);
    result.elapsedMs = Date.now() - started; this.results.push(result);
    this.log(`${result.status.toUpperCase()} ${id} ${name}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
    await this.save(); return result;
  }
  async blockRemaining(reason) {
    for (const [id, name] of JOURNEYS) if (!this.results.some(result => result.id === id)) {
      this.results.push({ id, name, status: 'blocked', reason, artifacts: [], screenshot: 'ブラウザ未実行のため画像なし' });
    }
    await this.save();
  }
  passed() {
    return this.results.length === JOURNEYS.length
      && JOURNEYS.every(([id]) => this.results.filter(result => result.id === id).length === 1
        && this.results.some(result => result.id === id && result.status === 'pass' && result.artifacts.some(name => name.endsWith('.png'))))
      && !this.errors.length && this.metadata.cleanup?.ok === true && this.metadata.cleanup.runtimeRemoved === true;
  }
  async save() {
    const value = { ...this.metadata, gate: this.passed() ? 'pass' : 'fail', errors: this.errors, results: this.results };
    await writeFile(join(this.directory, 'report.json'), JSON.stringify(value, null, 2) + '\n');
    const rows = this.results.map(result => `<tr><td>${escape(result.id)}</td><td>${escape(result.name)}</td><td class="${result.status}">${escape(result.status)}</td><td><pre>${escape(result.error ?? result.reason ?? result.detail ?? '')}</pre>${result.artifacts.filter(name => name.endsWith('.png')).map(name => `<a href="${escape(name)}"><img src="${escape(name)}" alt="${escape(result.name)}"></a>`).join('')}${result.artifacts.map(name => `<a href="${escape(name)}">${escape(name)}</a> `).join('')}</td></tr>`).join('');
    await writeFile(join(this.directory, 'report.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><title>agent-graph E2E</title><style>body{font:15px system-ui;margin:24px;color:#222}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #ddd;text-align:left;vertical-align:top}pre{white-space:pre-wrap;max-width:70vw}.pass{color:#147438}.fail{color:#b11}.blocked{color:#866000}img{display:block;max-width:520px;margin:12px 0}a{margin-right:8px}</style><h1>agent-graph E2E: ${value.gate}</h1><p>HEAD: ${escape(value.head)} / main: ${escape(value.main)} / ${escape(value.started)}</p><p>${escape(this.errors.join('\n'))}</p><p>後片付け: ${escape(JSON.stringify(value.cleanup ?? '未完了'))}</p><table><thead><tr><th>項目</th><th>確認</th><th>結果</th><th>根拠と写し</th></tr></thead><tbody>${rows}</tbody></table></html>`);
  }
}
