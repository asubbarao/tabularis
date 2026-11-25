import {act, render, screen, waitFor} from '@testing-library/react';
import {MemoryRouter, useLocation} from 'react-router-dom';
import {expect, it, vi} from 'vitest';
import {EditorProvider} from '@/contexts/EditorProvider';
import {BROWSER_ROUTES, buildEditorRoute} from '@/routing';

const client = vi.hoisted(() => ({
    subscribe: vi.fn().mockResolvedValue(() => {}),
    call: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/hooks/useTabularisClient', () => ({useTabularisClient: () => client}));
vi.mock('@/hooks/useDatabase', () => ({useDatabase: () => ({activeConnectionId: null})}));
vi.mock('@/hooks/useConnectionLayoutContext', () => ({useConnectionLayoutContext: () => ({})}));
vi.mock('@/hooks/useUiState', () => ({useUiState: () => [[], vi.fn()]}));

function CurrentPath() {
    return <output>{useLocation().pathname}</output>;
}

it('opens the requested editor from the connection list and leaves the run for it to claim', async () => {
    render(
        <MemoryRouter initialEntries={[BROWSER_ROUTES.connections]}>
            <EditorProvider><CurrentPath /></EditorProvider>
        </MemoryRouter>,
    );
    await waitFor(() => expect(client.call).toHaveBeenCalledWith('mcp_ui_ready', {
        kind: 'run_visible_tab', ready: true,
    }));
    const [, receive] = client.subscribe.mock.calls.at(-1)!;
    act(() => receive({kind: 'run_visible_tab', id: 'request', connectionId: 'saved'}));
    expect(screen.getByRole('status')).toHaveTextContent(buildEditorRoute('saved'));
    expect(client.call).not.toHaveBeenCalledWith('claim_mcp_ui_request', expect.anything());
});
