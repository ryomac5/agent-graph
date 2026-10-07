import { createRoot } from 'react-dom/client';
import { Dashboard } from './App.tsx';
import { createClient } from './lib/client.ts';

const token = document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content ?? '';
const client = createClient({ url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  token: token === '__AGENT_GRAPH_TOKEN__' ? new URLSearchParams(location.search).get('token') ?? '' : token });
client.start();
createRoot(document.getElementById('root')!).render(<Dashboard/>);
window.addEventListener('pagehide', () => client.stop());
