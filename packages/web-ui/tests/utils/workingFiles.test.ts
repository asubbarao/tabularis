import {describe, expect, it, vi} from 'vitest';
import {
    MAX_RECENT_WORKING_FILES,
    enqueueWorkingFileOpen,
    getRoutedWorkingFileOpenHandler,
    isWorkingFileBufferReady,
    isWorkingFileOpenCurrent,
    isWorkingFileRequestOwner,
    reloadCleanWorkingFileBuffer,
    updateRecentWorkingFiles,
} from '@/utils/workingFiles';

describe('updateRecentWorkingFiles', () => {
    it('moves an existing full path to the front and removes duplicates', () => {
        expect(updateRecentWorkingFiles(['/repo/a.tf', '/repo/b.sql'], '/repo/b.sql')).toEqual([
            '/repo/b.sql',
            '/repo/a.tf',
        ]);
    });

    it('keeps the most recent bounded set of paths', () => {
        const paths = Array.from(
            {length: MAX_RECENT_WORKING_FILES},
            (_, index) => `/repo/${index}.sql`,
        );
        const next = updateRecentWorkingFiles(paths, '/repo/new.sql');
        expect(next).toHaveLength(MAX_RECENT_WORKING_FILES);
        expect(next[0]).toBe('/repo/new.sql');
        expect(next).not.toContain(paths.at(-1));
    });
});

describe('reloadCleanWorkingFileBuffer', () => {
    it('keeps edits made while the disk read was pending', async () => {
        let resolveDiskRead: (value: string) => void = () => undefined;
        const diskRead = new Promise<string>((resolve) => {
            resolveDiskRead = resolve;
        });
        let current = {
            query: 'saved before read',
            sourceFileContent: 'saved before read',
            sourceFileDirty: false,
        };
        const reload = diskRead.then((content) => {
            current = reloadCleanWorkingFileBuffer(current, content);
        });

        current = {...current, query: 'typed during read', sourceFileDirty: true};
        resolveDiskRead('new disk bytes');
        await reload;

        expect(current.query).toBe('typed during read');
        expect(current.sourceFileContent).toBe('saved before read');
        expect(current.sourceFileDirty).toBe(true);
    });

    it('reloads a clean buffer from the bytes read from disk', () => {
        expect(
            reloadCleanWorkingFileBuffer(
                {query: 'stale', sourceFileContent: 'stale', sourceFileDirty: false},
                'saved bytes',
            ),
        ).toEqual({query: 'saved bytes', sourceFileContent: 'saved bytes', sourceFileDirty: false});
    });
});

describe('isWorkingFileRequestOwner', () => {
    const request = {
        activeCommandScopeId: 'connection-a',
        connectionId: 'connection-b',
        splitConnectionIds: ['connection-a', 'connection-b'],
        isSplitRendered: true,
    };

    it('assigns an explicit request for a rendered pane to exactly that pane', () => {
        expect(isWorkingFileRequestOwner({...request, commandScopeId: 'connection-a'})).toBe(false);
        expect(isWorkingFileRequestOwner({...request, commandScopeId: 'connection-b'})).toBe(true);
        expect(isWorkingFileRequestOwner({...request, commandScopeId: undefined})).toBe(false);
    });

    it('lets the root provider route a connection that is not yet rendered', () => {
        expect(
            isWorkingFileRequestOwner({
                ...request,
                connectionId: 'connection-c',
                commandScopeId: undefined,
            }),
        ).toBe(true);
        expect(
            isWorkingFileRequestOwner({
                ...request,
                connectionId: 'connection-c',
                commandScopeId: 'connection-a',
            }),
        ).toBe(false);
    });
});

describe('isWorkingFileOpenCurrent', () => {
    it.each([
        {isMounted: false, activeScopeId: 'pane-b', expected: false},
        {isMounted: true, activeScopeId: 'pane-a', expected: false},
        {isMounted: true, activeScopeId: 'pane-b', expected: true},
    ])('rejects stale or unmounted file reads', async ({isMounted, activeScopeId, expected}) => {
        let resolveRead: () => void = () => undefined;
        const read = new Promise<void>((resolve) => {
            resolveRead = resolve;
        });
        const pendingAck = read.then(() =>
            isWorkingFileOpenCurrent(isMounted, 'pane-b', activeScopeId),
        );
        resolveRead();
        await expect(pendingAck).resolves.toBe(expected);
    });
});

describe('isWorkingFileBufferReady', () => {
    it('does not acknowledge an already-active clean tab until changed disk bytes commit', () => {
        const staleTab = {
            sourceFilePath: '/repo/query.sql',
            sourceFileKind: 'sql',
            query: 'old bytes',
            sourceFileDirty: false,
        };

        expect(isWorkingFileBufferReady(staleTab, '/repo/query.sql', 'sql', 'new disk bytes')).toBe(
            false,
        );

        const committedTab = reloadCleanWorkingFileBuffer(staleTab, 'new disk bytes');
        expect(
            isWorkingFileBufferReady(
                {...committedTab, sourceFilePath: '/repo/query.sql', sourceFileKind: 'sql'},
                '/repo/query.sql',
                'sql',
                'new disk bytes',
            ),
        ).toBe(true);
    });

    it('accepts edits made while the read was pending without overwriting them', () => {
        expect(
            isWorkingFileBufferReady(
                {
                    sourceFilePath: '/repo/query.sql',
                    sourceFileKind: 'sql',
                    query: 'user edit',
                    sourceFileDirty: true,
                },
                '/repo/query.sql',
                'sql',
                'new disk bytes',
            ),
        ).toBe(true);
    });
});

describe('enqueueWorkingFileOpen', () => {
    it('serializes deferred opens and continues after a failed request', async () => {
        const queue = {current: Promise.resolve()};
        const order: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const first = enqueueWorkingFileOpen(queue, async () => {
            order.push('first-start');
            await firstGate;
            order.push('first-ack');
        });
        const failed = enqueueWorkingFileOpen(queue, async () => {
            order.push('failed-start');
            throw new Error('gone file');
        });
        const second = enqueueWorkingFileOpen(queue, async () => {
            order.push('second-start');
            order.push('second-ack');
        });

        await Promise.resolve();
        expect(order).toEqual(['first-start']);
        releaseFirst();
        await first;
        await expect(failed).rejects.toThrow('gone file');
        await second;
        expect(order).toEqual([
            'first-start',
            'first-ack',
            'failed-start',
            'second-start',
            'second-ack',
        ]);
    });
});

describe('getRoutedWorkingFileOpenHandler', () => {
    it('reuses the newly rendered target pane for every file in an open batch', async () => {
        const open = vi.fn(async (path: string) => ({path, connectionId: 'connection-b'}));
        let routed: {connectionId: string; open: typeof open} | null = null;
        const opened: string[] = [];

        for (const path of ['/repo/a.tf', '/repo/b.sql']) {
            const existing = getRoutedWorkingFileOpenHandler(routed, 'connection-b');
            if (existing) {
                opened.push((await existing.open(path)).path);
            } else {
                routed = {connectionId: 'connection-b', open};
                opened.push((await routed.open(path)).path);
            }
        }

        expect(opened).toEqual(['/repo/a.tf', '/repo/b.sql']);
        expect(open.mock.calls).toEqual([['/repo/a.tf'], ['/repo/b.sql']]);
        expect(getRoutedWorkingFileOpenHandler(routed, 'connection-a')).toBeNull();
    });
});
