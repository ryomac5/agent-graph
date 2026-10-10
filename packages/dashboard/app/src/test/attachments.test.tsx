import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { createStore } from '../lib/store.ts';
import type { Ack } from '../lib/client.ts';
const id = JSON.stringify(['claude', '12345678-1234-1234-1234-123456789abc']);
const ack = (result: unknown = {}): Ack => ({ type: 'ack', cmd_id: 'cmd', ok: true, result });
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: {}, next: null }) })));
  URL.createObjectURL = vi.fn(() => 'blob:preview'); URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function renderConversation(origin = 'observed', language: 'en' | 'ja' = 'en') {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', root_path: '/repo', state: 'registered' }],
    conversations: [{ id, provider: 'claude', origin, project: 'p', history_format: 'jsonl' }],
    runs: [{ id: 'r', conversation_id: id, state: 'idle', generation: 1, launch: { cwd: '/repo', model: { model: 'opus' } } }],
  } }); target.setConnection('connected');
  const command = vi.fn(async (name: string, _payload?: unknown) => {
    if (name === 'list_models') return ack([{ model: 'opus', displayName: 'Opus' }]);
    if (name === 'session.hosts') return ack({ hosts: [{ conversationId: id, terminalId: 't' }] });
    if (name === 'attachment.put') return ack({ attachmentId: 'image-id', path: '/cache/image.png' });
    return ack();
  });
  const view = render(<MemoryRouter><ConversationPage target={target} client={{ command }} conversationId={id} language={language}/></MemoryRouter>);
  return { command, view, box: document.querySelector('.composer-box')!, input: screen.getByRole('textbox', { name: language === 'ja' ? '入力' : 'Message' }) };
}
function image(name = 'image.png', type = 'image/png') { return new File([new Uint8Array([137,80,78,71,13,10,26,10])], name, { type }); }
function drop(box: Element, files: File[]) { fireEvent.drop(box, { dataTransfer: { files, types: ['Files'] } }); }
function paste(input: Element, files: File[]) { fireEvent.paste(input, { clipboardData: { items: files.map(file => ({ kind: 'file', getAsFile: () => file })) } }); }

it('highlights a drop, previews dropped and pasted images, removes them and revokes previews', async () => {
  const f = renderConversation();
  fireEvent.dragEnter(f.box, { dataTransfer: { types: ['Files'] } });
  expect(f.box.classList.contains('composer-drop-active')).toBe(true);
  drop(f.box, [image()]);
  expect(f.box.classList.contains('composer-drop-active')).toBe(false);
  expect(screen.getByRole('img', { name: 'image.png' })).toBeTruthy();
  paste(f.input, [image('clipboard.webp', 'image/webp')]);
  expect(screen.getAllByRole('img')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Remove image: image.png' }));
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  f.view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it('uploads image bytes then sends IDs and text, and clears attachments on success', async () => {
  const f = renderConversation(); drop(f.box, [image()]);
  fireEvent.change(f.input, { target: { value: 'Look here' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId: id, text: 'Look here', attachments: ['image-id'] }));
  expect(f.command).toHaveBeenCalledWith('attachment.put', { name: 'image.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' });
  await waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0));
  expect(f.input).toHaveProperty('value', '');
});

it('sends an image without text and retains it after a failed send for retry', async () => {
  const f = renderConversation();
  f.command.mockImplementation(async (name: string) => name === 'session.hosts' ? ack({ hosts: [{ conversationId: id, terminalId: 't' }] }) : name === 'attachment.put' ? ack({ attachmentId: 'image-id' }) : name === 'session.send' ? { type: 'ack', cmd_id: 'cmd', ok: false, error: 'no_host' } : ack());
  drop(f.box, [image()]); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('img')).toBeTruthy();
  expect(f.command).toHaveBeenCalledWith('session.send', { conversationId: id, text: '', attachments: ['image-id'] });
  f.command.mockImplementation(async (name: string) => name === 'session.hosts' ? ack({ hosts: [{ conversationId: id, terminalId: 't' }] }) : ack());
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0));
  expect(f.command.mock.calls.filter(([name]) => name === 'attachment.put')).toHaveLength(1);
});

it('rejects unsupported types, files over 10MB, and a ninth image from either input', async () => {
  const f = renderConversation();
  drop(f.box, [image('bad.svg', 'image/svg+xml')]); expect(screen.getByRole('alert').textContent).toContain('PNG');
  const large = image(); Object.defineProperty(large, 'size', { value: 10 * 1024 * 1024 + 1 });
  paste(f.input, [large]); expect(screen.getByRole('alert').textContent).toContain('10 MB');
  drop(f.box, Array.from({ length: 9 }, (_, index) => image(`${index}.png`))); expect(screen.getByRole('alert').textContent).toContain('8');
  expect(screen.queryAllByRole('img')).toHaveLength(0);
  const max = image(); Object.defineProperty(max, 'size', { value: 10 * 1024 * 1024 });
  drop(f.box, [max, ...Array.from({ length: 7 }, (_, index) => image(`${index}.png`))]);
  expect(screen.getAllByRole('img')).toHaveLength(8);
  paste(f.input, [image('extra.png')]); expect(screen.getByRole('alert').textContent).toContain('8');
  expect(screen.getAllByRole('img')).toHaveLength(8);
});

it.each(['en', 'ja'] as const)('disables managed attachments with a reason in %s', async language => {
  const f = renderConversation('managed', language);
  await act(async () => { drop(f.box, [image()]); });
  expect(screen.queryAllByRole('img')).toHaveLength(0);
  expect(screen.getByRole('alert').textContent).toBe(language === 'ja' ? '管理された会話では、まだ画像を添付できません。' : 'Managed conversations do not support image attachments yet.');
  expect(f.command.mock.calls.some(([name]) => name === 'attachment.put')).toBe(false);
});

it('画像のパスの付いた記録の発言を、送った本文と同じ発言として扱う', async () => {
  const { sameSent } = await import('../pages/conversation/ConversationPage.tsx');
  expect(sameSent('/Users/r/.cache/agent-graph/attachments/2026-10-10/a.png この画像の色は', 'この画像の色は')).toBe(true);
  expect(sameSent('/tmp/a.png /tmp/b.jpeg 2 枚を比べて', '2 枚を比べて')).toBe(true);
  expect(sameSent('別の発言 この画像の色は', 'この画像の色は')).toBe(false);
  expect(sameSent('この画像の色は', 'この画像の色は')).toBe(true);
});
