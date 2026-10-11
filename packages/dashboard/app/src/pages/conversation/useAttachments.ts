import { useEffect, useRef, useState } from 'react';
import type { Language } from '../../lib/i18n.ts';
import type { ConversationClient } from './ConversationPage.tsx';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const attachmentText = {
  en: { unsupported: 'Managed conversations do not support image attachments yet.', type: 'Use PNG, JPEG, GIF or WebP images.', size: 'Each image must be 10 MB or smaller.', count: 'Attach up to 8 images.', remove: 'Remove image', failed: 'Unable to upload the image.' },
  ja: { unsupported: '管理された会話では、まだ画像を添付できません。', type: 'PNG、JPEG、GIF、WebP の画像を使ってください。', size: '画像は1枚10MBまでです。', count: '画像は8枚まで添付できます。', remove: '画像を外す', failed: '画像を送れませんでした。' },
};
interface Attachment { key: string; file: File; url: string; attachmentId?: string }
// 縮小は data: の URL で描く。blob: の URL は画面の CSP の img-src が許しておらず、描かれないからである。
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function readBase64(file: File): Promise<string> { return (await readDataUrl(file)).split(',')[1]; }
export function useAttachments(conversationId: string, language: Language, client: ConversationClient) {
  const [items, setItems] = useState<Attachment[]>([]);
  const current = useRef<Attachment[]>([]);
  const [error, setError] = useState('');
  const text = attachmentText[language];
  function clear() {
    current.current = []; setItems([]); setError('');
  }
  useEffect(() => { clear(); return () => { current.current = []; }; }, [conversationId]);
  function accept(files: File[], enabled: boolean) {
    if (!enabled) { setError(text.unsupported); return; }
    if (files.some(file => !IMAGE_TYPES.includes(file.type))) { setError(text.type); return; }
    if (files.some(file => file.size > MAX_IMAGE_BYTES)) { setError(text.size); return; }
    if (current.current.length + files.length > MAX_ATTACHMENTS) { setError(text.count); return; }
    // 枠は先に取り、縮小の中身は読み終わってから埋める。先に取らないと、読み込み中に上限を超えて受け付けてしまう。
    const added = files.map(file => ({ key: crypto.randomUUID(), file, url: '' }));
    current.current = [...current.current, ...added]; setItems(current.current); setError('');
    for (const item of added) void readDataUrl(item.file).then(url => {
      current.current = current.current.map(entry => entry.key === item.key ? { ...entry, url } : entry); setItems(current.current);
    }, () => setError(text.failed));
  }
  function remove(key: string) {
    current.current = current.current.filter(item => item.key !== key); setItems(current.current); setError('');
  }
  async function upload(): Promise<string[]> {
    const ids: string[] = [];
    for (const item of current.current) {
      if (!item.attachmentId) {
        const ack = await client.command('attachment.put', { name: item.file.name, mime: item.file.type, dataBase64: await readBase64(item.file) });
        const result = ack.result as { attachmentId?: string } | undefined;
        if (!ack.ok || typeof result?.attachmentId !== 'string') throw new Error(text.failed);
        item.attachmentId = result.attachmentId;
      }
      ids.push(item.attachmentId);
    }
    return ids;
  }
  return { items, error, accept, remove, clear, upload, text };
}
