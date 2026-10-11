import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { createInteractionFixture } from '../src/test/interaction-fixture.ts';
localStorage.clear();
history.replaceState(null, '', '/p/p');
const target = createInteractionFixture(14);
const client = { command: async () => ({ type: 'ack' as const, cmd_id: 'test', ok: true, result: [] }) };
createRoot(document.getElementById('root')!).render(<BrowserRouter><App target={target} client={client}/></BrowserRouter>);
