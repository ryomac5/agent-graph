import type { ComponentProps } from 'react';
import { useNow } from '../RelativeTime.tsx';
import { StateBadge } from '../StateBadge.tsx';
import { workingElapsed, type WorkingTurn } from '../../lib/turns.ts';
import { translate } from './text.ts';
import type { ConversationTabMetadata } from '../../lib/workspace-context.ts';
import { formatSeconds } from '../../lib/format.ts';

export function WorkingTimer({ turn }: { turn?: WorkingTurn }) {
  const elapsed = workingElapsed(turn, useNow());
  return elapsed ? <span role="timer" aria-live="off"> · {elapsed}</span> : null;
}

export function WorkingStateBadge({ turn, ...props }: ComponentProps<typeof StateBadge> & { turn?: WorkingTurn }) {
  const elapsed = workingElapsed(turn, useNow(Boolean(turn)));
  return <StateBadge {...props} elapsed={elapsed ? `${translate(props.language ?? 'en', props.state.startsWith('waiting') ? 'waiting' : 'elapsed')} ${elapsed}` : undefined}/>;
}

export function WorkspaceTabButton({ metadata, title, ...props }: ComponentProps<'button'> & { metadata?: ConversationTabMetadata }) {
  const now = useNow(metadata?.elapsedStarted !== undefined);
  const elapsed = metadata?.elapsedStarted === undefined ? ''
    : `${metadata.elapsedLabel} ${formatSeconds(Math.max(0, Math.floor((now - metadata.elapsedStarted) / 1000)))}`;
  return <button {...props} title={[title, elapsed, metadata?.model].filter(Boolean).join(' · ') || undefined}/>;
}
