import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    registerWorkingFileOpenHandler,
    waitForWorkingFileOpenHandler,
} from '@/utils/workingFileOpenRouter';

afterEach(() => vi.useRealTimers());

describe('working file open routing', () => {
    it('waits for a newly rendered split pane handler and removes it on cleanup', async () => {
        vi.useFakeTimers();
        const pending = waitForWorkingFileOpenHandler('connection-b');
        const handler = vi.fn(async (path: string) => ({
            tabId: path,
            content: 'buffer',
            connectionId: 'connection-b',
            dirty: false,
        }));
        const unregister = registerWorkingFileOpenHandler('connection-b', handler);

        await expect(pending).resolves.toBe(handler);
        await expect(handler('/work/file.sql')).resolves.toEqual({
            tabId: '/work/file.sql',
            content: 'buffer',
            connectionId: 'connection-b',
            dirty: false,
        });
        unregister();
        const missing = waitForWorkingFileOpenHandler('connection-b', 10);
        const rejection = expect(missing).rejects.toThrow(/Timed out/);
        await vi.advanceTimersByTimeAsync(10);
        await rejection;
    });
});
