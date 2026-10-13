import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { ConversationClient } from './ConversationPage.tsx';

interface Command { name: string; description: string; argumentHint?: string }
export function useSlashCommands({ client, conversationId, projectId, provider, enabled, input, onChange }: {
  client: ConversationClient; conversationId: string; projectId: string; provider: string; enabled: boolean;
  input: string; onChange: (value: string) => void;
}) {
  const id = useId();
  const [commands, setCommands] = useState<Command[]>([]);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const active = enabled && /^\/[^\s]*$/u.test(input);
  useEffect(() => { setIndex(0); setDismissed(false); }, [input, conversationId]);
  useEffect(() => {
    let disposed = false;
    setCommands([]);
    if (!active) return;
    void client.command('session.commands', { conversationId, projectId, provider }).then(ack => {
      const rows = (ack.result as { commands?: unknown[] } | undefined)?.commands;
      if (!disposed && ack.ok && Array.isArray(rows)) setCommands(rows.filter((row): row is Command =>
        Boolean(row && typeof row === 'object' && 'name' in row && typeof row.name === 'string'
          && 'description' in row && typeof row.description === 'string')));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [client, conversationId, projectId, provider, active]);
  const query = input.slice(1).toLowerCase();
  const choices = active && !dismissed ? commands.filter(command => command.name.toLowerCase().startsWith(query)) : [];
  const selected = Math.min(index, Math.max(0, choices.length - 1));
  function choose(command: Command) { onChange(`/${command.name} `); setDismissed(true); }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!choices.length || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey && event.key === 'Tab') return false;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') setDismissed(true);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setIndex((selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
    else choose(choices[selected]);
    return true;
  }
  useEffect(() => { document.getElementById(`${id}-${selected}`)?.scrollIntoView?.({ block: 'nearest' }); }, [id, selected, choices.length]);
  return {
    onKeyDown,
    inputProps: { 'aria-autocomplete': 'list' as const, 'aria-controls': choices.length ? id : undefined,
      'aria-expanded': choices.length > 0, 'aria-activedescendant': choices.length ? `${id}-${selected}` : undefined },
    menu: choices.length > 0 && <div id={id} role="listbox" aria-label="Slash commands" className="choice-menu slash-commands">
      <div className="choice-options">{choices.map((command, row) => <button type="button" tabIndex={-1} role="option" id={`${id}-${row}`} key={command.name}
        aria-selected={row === selected} className="choice-option" onMouseDown={event => event.preventDefault()} onClick={() => choose(command)}>
        <span className="mono">/{command.name}{command.argumentHint && <span className="muted-text"> {command.argumentHint}</span>}</span>
        <span className="choice-detail">{command.description}</span>
      </button>)}</div>
    </div>,
  };
}
