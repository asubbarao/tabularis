import {describe, expect, it} from 'vitest';
import {
    assertVisibleRequestCurrent,
    assessVisibleResultCommit,
    executeVisiblePreflight,
    executeSqlSourceAction,
    finishVisibleRequest,
    getCommittedVisibleResults,
    getVisibleResultsError,
    isSqlSourceTab,
} from '@/utils/visibleResultCommit';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return {promise, resolve};
}

describe('getCommittedVisibleResults', () => {
    it('allows SQL and legacy tabs while rejecting non-SQL source files', () => {
        expect(isSqlSourceTab({sourceFileKind: 'sql'})).toBe(true);
        expect(isSqlSourceTab({})).toBe(true);
        expect(isSqlSourceTab({sourceFileKind: 'markdown'})).toBe(false);
        expect(isSqlSourceTab({sourceFileKind: 'text'})).toBe(false);
        expect(isSqlSourceTab({sourceFileKind: 'pdf'})).toBe(false);
    });

    it('does not dispatch a database call for non-SQL source tabs', () => {
        let dispatched = false;

        expect(
            executeSqlSourceAction({sourceFileKind: 'markdown'}, () => {
                dispatched = true;
                return 'called';
            }),
        ).toBeUndefined();
        expect(dispatched).toBe(false);
    });

    it('does not accept the previous result objects', () => {
        const oldEntry = {id: 'r0', isLoading: false, result: {rows: [[1]]}, error: ''};

        expect(
            getCommittedVisibleResults(new Map([[oldEntry.id, oldEntry]]), [oldEntry], 1),
        ).toBeNull();
    });

    it('waits for every new result entry to finish rendering', () => {
        const previous = new Map([['r0', {id: 'r0'}]]);
        const entries = [
            {id: 'r0', isLoading: false, result: {rows: [[1]]}, error: ''},
            {id: 'r1', isLoading: true, result: null, error: ''},
        ];

        expect(getCommittedVisibleResults(previous, entries, 2)).toBeNull();
        expect(
            getCommittedVisibleResults(
                previous,
                entries.map((entry) => ({...entry, isLoading: false, result: {rows: [[2]]}})),
                2,
            ),
        ).toHaveLength(2);
    });

    it('returns completed SQL error entries for the MCP acknowledgement', () => {
        const previous = new Map([['r0', {id: 'r0'}]]);
        const failed = {id: 'r0', isLoading: false, result: null, error: 'Binder failure'};

        const completed = getCommittedVisibleResults(previous, [failed], 1);
        expect(completed).toEqual([failed]);
        expect(getVisibleResultsError(completed ?? [])).toBe(
            'SQL statement failed: Binder failure',
        );
    });

    it('waits until a visible execution actually starts', () => {
        const oldEntry = {id: 'r0', isLoading: false, result: {rows: [[1]]}, error: ''};
        const unrelatedCommit = {id: 'r0', isLoading: false, result: {rows: [[2]]}, error: ''};

        expect(
            assessVisibleResultCommit(
                'starting',
                'mcp-1',
                undefined,
                new Map([[oldEntry.id, oldEntry]]),
                [unrelatedCommit],
                1,
            ),
        ).toEqual({status: 'waiting'});
    });

    it('does not accept a finished entry without a result or SQL error', () => {
        const previous = new Map([['r0', {id: 'r0'}]]);
        const empty = {id: 'r0', isLoading: false, result: null, error: ''};

        expect(
            assessVisibleResultCommit('running', 'mcp-1', 'mcp-1', previous, [empty], 1),
        ).toEqual({status: 'waiting'});
    });

    it('rejects a result produced by a later run', () => {
        const entry = {id: 'r0', isLoading: false, result: {rows: [[2]]}, error: ''};

        expect(
            assessVisibleResultCommit('running', 'mcp-1', 'user-run-2', new Map(), [entry], 1),
        ).toEqual({status: 'superseded'});
    });

    it('does not execute when the editor context changes during a file read', async () => {
        const read = deferred<void>();
        const readStarted = deferred<void>();
        let current = true;
        let executed = false;
        const operation = executeVisiblePreflight(
            () => {
                if (!current) throw new Error('active tab changed');
            },
            [
                async () => {
                    readStarted.resolve();
                    await read.promise;
                },
            ],
            async () => {
                executed = true;
            },
        );

        await readStarted.promise;
        current = false;
        read.resolve();
        await expect(operation).rejects.toThrow('active tab changed');
        expect(executed).toBe(false);
    });

    it('does not execute after the settled waiter has been removed from its map', async () => {
        const read = deferred<void>();
        const readStarted = deferred<void>();
        const waiter = {phase: 'running' as const, settled: false};
        const waiters = new Map([['mcp-1', waiter]]);
        let executed = false;
        const operation = executeVisiblePreflight(
            () => {
                assertVisibleRequestCurrent(waiter, 'mcp-1', 'mcp-1');
            },
            [
                async () => {
                    readStarted.resolve();
                    await read.promise;
                },
            ],
            async () => {
                executed = true;
            },
        );

        await readStarted.promise;
        expect(finishVisibleRequest(waiter, () => waiters.delete('mcp-1'))).toBe(true);
        expect(waiters.has('mcp-1')).toBe(false);
        read.resolve();

        await expect(operation).rejects.toThrow(
            'The visible SQL request was canceled before execution',
        );
        expect(executed).toBe(false);
    });

    it('does not execute after a user run supersedes a running MCP request', async () => {
        const read = deferred<void>();
        const readStarted = deferred<void>();
        const waiter = {phase: 'running' as const, settled: false};
        let activeRunId = 'mcp-1';
        let executed = false;
        const operation = executeVisiblePreflight(
            () => assertVisibleRequestCurrent(waiter, 'mcp-1', activeRunId),
            [
                async () => {
                    readStarted.resolve();
                    await read.promise;
                },
            ],
            async () => {
                executed = true;
            },
        );

        await readStarted.promise;
        activeRunId = 'user-run-2';
        read.resolve();

        await expect(operation).rejects.toThrow('visible SQL request was superseded');
        expect(executed).toBe(false);
    });

    it('does not execute after the editor listener unmounts during the initial file read', async () => {
        const read = deferred<void>();
        const readStarted = deferred<void>();
        let disposed = false;
        let executed = false;
        const operation = executeVisiblePreflight(
            () => assertVisibleRequestCurrent(undefined, 'mcp-1', undefined, disposed),
            [
                async () => {
                    readStarted.resolve();
                    await read.promise;
                },
            ],
            async () => {
                executed = true;
            },
        );

        await readStarted.promise;
        disposed = true;
        read.resolve();

        await expect(operation).rejects.toThrow('listener was disposed');
        expect(executed).toBe(false);
    });

    it('does not execute when the saved editor is edited during hashing', async () => {
        const hash = deferred<void>();
        const hashStarted = deferred<void>();
        let current = true;
        let guardStarted = false;
        let executed = false;
        const operation = executeVisiblePreflight(
            () => {
                if (!current) throw new Error('saved tab changed');
            },
            [
                async () => undefined,
                async () => {
                    hashStarted.resolve();
                    await hash.promise;
                },
                async () => {
                    guardStarted = true;
                },
            ],
            async () => {
                executed = true;
            },
        );

        await hashStarted.promise;
        current = false;
        hash.resolve();
        await expect(operation).rejects.toThrow('saved tab changed');
        expect(guardStarted).toBe(false);
        expect(executed).toBe(false);
    });

    it('does not execute when the guard resolves after the connection switches', async () => {
        const guard = deferred<void>();
        const guardStarted = deferred<void>();
        let current = true;
        let executed = false;
        const operation = executeVisiblePreflight(
            () => {
                if (!current) throw new Error('connection changed');
            },
            [
                async () => {
                    guardStarted.resolve();
                    await guard.promise;
                },
            ],
            async () => {
                executed = true;
            },
        );

        await guardStarted.promise;
        current = false;
        guard.resolve();
        await expect(operation).rejects.toThrow('connection changed');
        expect(executed).toBe(false);
    });
});
