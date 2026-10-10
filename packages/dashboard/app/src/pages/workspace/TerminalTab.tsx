import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import type { Language } from '../../lib/i18n.ts';
import type { TerminalNotice } from '../../lib/client.ts';
import '@xterm/xterm/css/xterm.css';
export function createTerminalSession(client: ConversationClient, projectId: string, worktree?: string, attachedId?: string) {
  let terminal: Terminal | undefined, fit: FitAddon | undefined, element: HTMLDivElement | undefined;
  let terminalId: string | undefined, disposed = false, ended = false;
  let error = '';
  let unsubscribe: (() => void) | undefined;
  let disconnectConnected: (() => void) | undefined;
  let early: TerminalNotice[] = [];
  const listeners = new Set<() => void>();
  function notify() { for (const listener of listeners) listener(); }
  function receive(message: TerminalNotice) {
    if (!terminalId) { early.push(message); return; }
    if (message.terminalId !== terminalId) return;
    if (message.event === 'output') terminal?.write(message.data);
    else { ended = true; notify(); }
  }
  async function command(name: string, payload: unknown) {
    try { const ack = await client.command(name, payload); if (!ack.ok) throw new Error(ack.error ?? 'Terminal command failed'); return ack; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); notify(); return undefined; }
  }
  function theme() {
    if (!terminal || !element) return;
    const style = getComputedStyle(element);
    const color = (name: string) => style.getPropertyValue(name).trim();
    terminal.options.theme = { background: color('--bg-0'), foreground: color('--fg-1'), cursor: color('--fg-1'), selectionBackground: color('--bg-3'), black: color('--fg-1'), white: color('--fg-2'), red: color('--state-failed'), green: color('--state-running'), yellow: color('--state-approval'), blue: color('--state-reply'), magenta: color('--accent'), cyan: color('--state-done'), brightBlack: color('--fg-3'), brightWhite: color('--fg-1'), brightRed: color('--state-failed'), brightGreen: color('--state-running'), brightYellow: color('--state-approval'), brightBlue: color('--state-reply'), brightMagenta: color('--accent'), brightCyan: color('--state-done') };
  }
  function resize() {
    if (!element?.isConnected || !element.clientWidth || !element.clientHeight) return;
    fit?.fit();
    if (terminalId && terminal && !ended) void command('terminal.resize', { terminalId, cols: terminal.cols, rows: terminal.rows });
  }
  return {
    async mount(host: HTMLDivElement) {
      if (disposed) return;
      if (element) { host.append(element); resize(); return; }
      element = document.createElement('div'); element.className = 'terminal-surface'; host.append(element);
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed) return;
      terminal = new Terminal({ fontSize: 12, fontFamily: getComputedStyle(host).getPropertyValue('--mono'), allowProposedApi: false });
      fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element); theme(); resize();
      terminal.onData(data => { if (terminalId && !ended) void command('terminal.input', { terminalId, data }); });
      if (!client.subscribeTerminal) { error = 'Terminal service unavailable'; ended = true; notify(); return; }
      unsubscribe = client.subscribeTerminal(receive);
      if (attachedId) disconnectConnected = client.subscribeConnected?.(() => {
        if (disposed || !terminalId || ended) return;
        terminalId = undefined; early = [];
        void command('terminal.attach', { terminalId: attachedId }).then(ack => {
          if (disposed) return;
          if (!ack) { ended = true; notify(); return; }
          terminalId = attachedId;
          error = ''; terminal?.reset();
          terminal?.write((ack.result as { scrollback: string }).scrollback);
          for (const notice of early) receive(notice); early = []; resize(); notify();
        });
      });
      void command(attachedId ? 'terminal.attach' : 'terminal.open', attachedId ? { terminalId: attachedId } : { projectId, ...(worktree ? { worktree } : {}), cols: terminal.cols, rows: terminal.rows }).then(ack => {
        if (!ack) { ended = true; notify(); return; }
        terminalId = (ack.result as { terminalId: string }).terminalId;
        if (disposed) { if (!attachedId) void command('terminal.close', { terminalId }); return; }
        if (attachedId) terminal?.write((ack.result as { scrollback: string }).scrollback);
        for (const notice of early) receive(notice); early = []; resize();
      });
    }, resize, theme,
    getState: () => ({ ended, error }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; unsubscribe?.(); disconnectConnected?.(); terminal?.dispose(); element?.remove(); if (terminalId && !ended && !attachedId) void command('terminal.close', { terminalId }); },
  };
}
export type TerminalSession = ReturnType<typeof createTerminalSession>;
export function TerminalTab({ session, language, reopen }: { session: TerminalSession; language: Language; reopen: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(session.getState);
  useEffect(() => {
    const unsubscribe = session.subscribe(() => setState(session.getState()));
    session.mount(host.current!); setState(session.getState());
    const observer = new ResizeObserver(() => session.resize()); observer.observe(host.current!);
    const theme = new MutationObserver(() => session.theme()); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => { unsubscribe(); observer.disconnect(); theme.disconnect(); };
  }, [session]);
  return <div className="terminal-tab">{state.error && <p role="alert">{language === 'ja' ? '端末を使えません。' : 'Terminal unavailable.'} {state.error}</p>}{state.ended && <p className="editor-notice">{language === 'ja' ? '終了しました。' : 'Exited.'} <button className="btn btn-ghost" onClick={reopen}>{language === 'ja' ? 'もう一度開く' : 'Open again'}</button></p>}<div className="terminal-host" ref={host}/></div>;
}
