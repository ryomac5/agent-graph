import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';

vi.mock('../pages/settings/SettingsPage.tsx', async () => { throw new Error('Chunk 404'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps navigation when SettingsLayout loads but the nested SettingsPage import rejects', async () => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<MemoryRouter initialEntries={['/settings']}><App/></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('A new version is available.');
  expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
});
