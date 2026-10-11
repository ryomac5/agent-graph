import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { createInteractionFixture } from '../src/test/interaction-fixture.ts';
localStorage.clear();
const target = createInteractionFixture(14);
const client = { command: async () => ({ type: 'ack' as const, cmd_id: 'test', ok: true, result: [] }) };
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/p/p']}><App target={target} client={client}/></MemoryRouter>);
