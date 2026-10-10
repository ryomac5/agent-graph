import { createRoot } from 'react-dom/client';
import { Dashboard } from './App.tsx';
import { createSearchClient } from './pages/search/model.ts';
import { createClient } from './lib/client.ts';
import { installStyleNonce } from './lib/style-nonce.ts';

installStyleNonce();

const injectedToken = document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content ?? '';
let token = injectedToken === '__AGENT_GRAPH_TOKEN__' ? new URLSearchParams(location.search).get('token') ?? '' : injectedToken;
const client = createClient({ url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  token,
  refreshToken: async () => {
    const response = await fetch('/', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Credentials: ${response.status}`);
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const next = document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content;
    if (!next || next === '__AGENT_GRAPH_TOKEN__') throw new Error('Credentials unavailable');
    token = next;
    const meta = window.document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]');
    if (meta) meta.content = next;
    return next;
  } });
client.start();
createRoot(document.getElementById('root')!).render(<Dashboard client={client} searchClient={{ search: (query, signal) => createSearchClient({ token }).search(query, signal) }}/>);
window.addEventListener('pagehide', () => client.stop());
