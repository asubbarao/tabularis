export const MAX_RECENT_WORKING_FILES = 20;

export function updateRecentWorkingFiles(paths: string[], filePath: string): string[] {
    return [filePath, ...paths.filter((path) => path !== filePath)].slice(
        0,
        MAX_RECENT_WORKING_FILES,
    );
}

export function isWorkingFileRequestOwner({
    commandScopeId,
    activeCommandScopeId,
    connectionId,
    splitConnectionIds,
    isSplitRendered,
}: {
    commandScopeId?: string;
    activeCommandScopeId: string;
    connectionId?: string;
    splitConnectionIds?: string[];
    isSplitRendered: boolean;
}): boolean {
    if (connectionId && isSplitRendered && splitConnectionIds) {
        if (splitConnectionIds.includes(connectionId)) return commandScopeId === connectionId;
        return commandScopeId === undefined;
    }
    return (commandScopeId ?? 'root') === activeCommandScopeId;
}

export function isWorkingFileOpenCurrent(
    isMounted: boolean,
    expectedScopeId: string,
    activeScopeId: string,
): boolean {
    return isMounted && expectedScopeId === activeScopeId;
}

export interface RoutedWorkingFileOpenHandler<T> {
    connectionId: string;
    open: (path: string, background?: boolean) => Promise<T>;
}

export function getRoutedWorkingFileOpenHandler<T>(
    handler: RoutedWorkingFileOpenHandler<T> | null,
    requestConnectionId?: string,
): RoutedWorkingFileOpenHandler<T> | null {
    return handler?.connectionId === requestConnectionId ? handler : null;
}

export function reloadCleanWorkingFileBuffer<
    T extends {query?: string; sourceFileContent?: string; sourceFileDirty?: boolean},
>(tab: T, savedContent: string): T {
    if (tab.sourceFileDirty) return tab;
    if (tab.query === savedContent && tab.sourceFileContent === savedContent) return tab;
    return {...tab, query: savedContent, sourceFileContent: savedContent, sourceFileDirty: false};
}

interface WorkingFileTabSnapshot {
    sourceFilePath?: string;
    sourceFileKind?: string;
    sourceFileDirty?: boolean;
    query?: string;
}

export function isWorkingFileBufferReady(
    tab: WorkingFileTabSnapshot | undefined,
    filePath: string,
    sourceFileKind: string,
    savedContent: string,
): boolean {
    if (!tab || tab.sourceFilePath !== filePath || tab.sourceFileKind !== sourceFileKind)
        return false;
    return tab.sourceFileDirty === true || tab.query === savedContent;
}

export function enqueueWorkingFileOpen<T>(
    queue: {current: Promise<void>},
    operation: () => Promise<T>,
): Promise<T> {
    const result = queue.current.then(operation);
    queue.current = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}
