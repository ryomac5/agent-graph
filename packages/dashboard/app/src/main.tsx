import { createRoot } from 'react-dom/client';
import { Dashboard } from './App.tsx';
import { createClient } from './lib/client.ts';

const token = document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content ?? '';
const client = createClient({ url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  token: token === '__AGENT_GRAPH_TOKEN__' ? new URLSearchParams(location.search).get('token') ?? '' : token,
  refreshToken: async () => {
    const response = await fetch('/', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Credentials: ${response.status}`);
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const next = document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content;
    if (!next || next === '__AGENT_GRAPH_TOKEN__') throw new Error('Credentials unavailable');
    return next;
  } });
client.start();
createRoot(document.getElementById('root')!).render(<Dashboard client={client}/>);
window.addEventListener('pagehide', () => client.stop());
