export interface OpenedWorkingFile {
    tabId: string;
    content: string;
    connectionId: string;
    dirty: boolean;
    sha256?: string;
}

export type WorkingFileOpenHandler = (path: string) => Promise<OpenedWorkingFile>;

const handlers = new Map<string, WorkingFileOpenHandler>();
const handlerWaiters = new Map<string, Set<() => void>>();

export function registerWorkingFileOpenHandler(scopeId: string, handler: WorkingFileOpenHandler): () => void {
    handlers.set(scopeId, handler);
    handlerWaiters.get(scopeId)?.forEach((resolve) => resolve());
    handlerWaiters.delete(scopeId);

    return () => {
        if (handlers.get(scopeId) === handler) handlers.delete(scopeId);
    };
}

export async function waitForWorkingFileOpenHandler(
    scopeId: string,
    timeoutMs = 20_000,
): Promise<WorkingFileOpenHandler> {
    const existing = handlers.get(scopeId);
    if (existing) return existing;

    await new Promise<void>((resolve, reject) => {
        const waiters = handlerWaiters.get(scopeId) ?? new Set<() => void>();
        handlerWaiters.set(scopeId, waiters);
        let timeout: number;
        const ready = () => {
            window.clearTimeout(timeout);
            waiters.delete(ready);
            resolve();
        };
        timeout = window.setTimeout(() => {
            waiters.delete(ready);
            if (waiters.size === 0) handlerWaiters.delete(scopeId);
            reject(new Error(`Timed out waiting for connection ${scopeId} to open the file`));
        }, timeoutMs);
        waiters.add(ready);
    });

    const handler = handlers.get(scopeId);
    if (!handler) throw new Error(`Connection ${scopeId} is no longer available to open the file`);
    return handler;
}
