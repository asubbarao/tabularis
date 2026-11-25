export function getCommittedVisibleResults<
    T extends {id: string; isLoading: boolean; result: unknown | null; error: string},
>(previous: ReadonlyMap<string, object>, current: readonly T[], expectedCount: number): T[] | null {
    const entries = current.filter((entry) => previous.get(entry.id) !== entry);
    if (
        entries.length !== expectedCount ||
        entries.some((entry) => entry.isLoading || (!entry.result && !entry.error))
    )
        return null;
    return entries;
}

export type VisibleResultPhase = 'starting' | 'running';

export function assertVisibleRequestCurrent(
    waiter: {phase: VisibleResultPhase; settled: boolean} | undefined,
    requestId: string,
    activeRunId: string | undefined,
    disposed = false,
): void {
    if (disposed) throw new Error('The MCP UI request listener was disposed before execution');
    if (waiter?.settled) throw new Error('The visible SQL request was canceled before execution');
    if (waiter?.phase === 'running' && activeRunId !== requestId)
        throw new Error('The visible SQL request was superseded before execution');
}

export function isSqlSourceTab(tab: object): boolean {
    if ('sourceFilePath' in tab && typeof tab.sourceFilePath === 'string') {
        if (getSqlTvSession(tab.sourceFilePath)) return false;
    }
    const kind =
        'sourceFileKind' in tab ? (tab as {sourceFileKind?: unknown}).sourceFileKind : undefined;
    return kind === undefined || kind === 'sql';
}

export function executeSqlSourceAction<T>(tab: object, execute: () => T): T | undefined {
    return isSqlSourceTab(tab) ? execute() : undefined;
}

export function finishVisibleRequest(waiter: {settled: boolean}, remove: () => void): boolean {
    if (waiter.settled) return false;
    waiter.settled = true;
    remove();
    return true;
}

export type VisibleResultCommit<T> =
    {status: 'waiting'} | {status: 'superseded'} | {status: 'committed'; entries: T[]};

export function assessVisibleResultCommit<
    T extends {id: string; isLoading: boolean; result: unknown | null; error: string},
>(
    phase: VisibleResultPhase,
    requestId: string,
    activeRunId: string | undefined,
    previous: ReadonlyMap<string, object>,
    current: readonly T[],
    expectedCount: number,
): VisibleResultCommit<T> {
    if (phase === 'starting') return {status: 'waiting'};
    if (activeRunId !== requestId) return {status: 'superseded'};
    const entries = getCommittedVisibleResults(previous, current, expectedCount);
    return entries ? {status: 'committed', entries} : {status: 'waiting'};
}

export function getVisibleResultsError(entries: readonly {error: string}[]): string | null {
    const statementError = entries.find((entry) => entry.error)?.error;
    return statementError ? `SQL statement failed: ${statementError}` : null;
}

export async function executeVisiblePreflight<T>(
    assertCurrent: () => void,
    preflight: readonly (() => Promise<unknown>)[],
    execute: () => Promise<T>,
): Promise<T> {
    assertCurrent();
    for (const step of preflight) {
        await step();
        assertCurrent();
    }
    assertCurrent();
    return execute();
}
import {getSqlTvSession} from './sqlFile';
