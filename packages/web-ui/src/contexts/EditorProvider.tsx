import {useState, useEffect, useMemo, useCallback, useRef} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import type {ReactNode} from 'react';
import type {Tab, SchemaCache, TableSchema, QueryResultEntry} from '@/types/editor';
import {EditorContext, type AddTabOptions} from './EditorContext';
import {useDatabase} from '@/hooks/useDatabase';
import {useConnectionLayoutContext} from '@/hooks/useConnectionLayoutContext';
import {useTabularisClient} from '@/hooks/useTabularisClient';
import {forgetResultChartStates} from '@/hooks/useResultChartState';
import {forgetHiddenColumns} from '@/hooks/useHiddenColumns';
import {
    generateTabId,
    loadEditorPreferences,
    saveTabsToStorage,
    createInitialTabState,
    generateTabTitle,
    findExistingTableTab,
    insertTabAfter,
    getConnectionTabs,
    getActiveTab,
    closeTabWithState,
    closeAllTabsForConnection,
    closeOtherTabsForConnection,
    closeTabsToLeft,
    closeTabsToRight,
    updateTabInList,
    shouldUseCachedSchema,
    createSchemaCacheEntry,
} from '@/utils/editor';
import {moveTab} from '@/utils/tabDnd';
import {getBulkClosedTabIds, keepPinnedTabsFirst, setTabPinned} from '@/utils/tabPins';
import {getRecentTabIds as orderRecentTabs} from '@/utils/tabScroll';
import {createAutoRefreshSchedule, type AutoRefreshSchedule} from '@/utils/autoRefresh';
import {
    pushClosedTabs,
    popClosedTab,
    insertReopenedTab,
    type ClosedTabsByConnection,
} from '@/utils/closedTabs';
import {createNotebookFromState, evictFromCache, flushAllPendingSaves} from '@/utils/notebookStore';
import {
    createSqlFileTab,
    getSourceFileKind,
    getSqlFileName,
    getSqlTvSession,
    isSqlTvPath,
} from '@/utils/sqlFile';
import {UI_STATE_KEYS} from '@/utils/uiStateStore';
import {useUiState} from '@/hooks/useUiState';
import {
    getActiveCommandScopeId,
    isActiveCommandScope,
    ROOT_COMMAND_SCOPE_ID,
} from '@/utils/commandScopeStore';
import {resolveRenderedSplitLayout} from '@/utils/connectionLayout';
import {BROWSER_ROUTES, buildEditorRoute} from '@/routing';
import {
    registerWorkingFileOpenHandler,
    waitForWorkingFileOpenHandler,
} from '@/utils/workingFileOpenRouter';
import {
    enqueueWorkingFileOpen,
    isWorkingFileRequestOwner,
    isWorkingFileOpenCurrent,
    isWorkingFileBufferReady,
    reloadCleanWorkingFileBuffer,
    updateRecentWorkingFiles,
    getRoutedWorkingFileOpenHandler,
    type RoutedWorkingFileOpenHandler,
} from '@/utils/workingFiles';
import {executeClaimedUiRequest} from '@/utils/mcpUiRequest';

interface McpUiRequest {
    id: string;
    kind: 'open_files' | 'list_visible_tabs' | 'run_visible_tab';
    paths: string[];
    path?: string;
    expectedSha256?: string;
    connectionId?: string;
    responsePath: string;
}

const sha256 = async (content: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
    );
};

export const EditorProvider = ({
    children,
    commandScopeId,
}: {
    children: ReactNode;
    commandScopeId?: string;
}) => {
    const {
        explorerConnectionId,
        isSplitVisible,
        splitView,
        setExplorerConnectionId,
        addConnectionToSplit,
        hideSplitView,
    } = useConnectionLayoutContext();
    const navigate = useNavigate();
    const location = useLocation();
    const renderedSplitLayout = resolveRenderedSplitLayout({
        splitView,
        isSplitVisible,
        pathname: location.pathname,
    });
    const layoutRef = useRef({
        splitView,
        isSplitVisible,
        explorerConnectionId,
        pathname: location.pathname,
    });
    layoutRef.current = {
        splitView,
        isSplitVisible,
        explorerConnectionId,
        pathname: location.pathname,
    };
    const activeCommandScopeIdRef = useRef(ROOT_COMMAND_SCOPE_ID);
    activeCommandScopeIdRef.current = getActiveCommandScopeId({
        explorerConnectionId,
        isSplitRendered: !!renderedSplitLayout,
    });
    const client = useTabularisClient();
    const mountedRef = useRef(true);
    const runRequestListenerReady = useRef(false);
    const runRequestListenerWaiters = useRef(new Set<() => void>());
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            runRequestListenerReady.current = false;
        };
    }, []);
    const {activeConnectionId, connect, switchConnection, isConnectionOpen} = useDatabase();
    const [recentWorkingFiles, setRecentWorkingFiles] = useUiState<string[]>(
        UI_STATE_KEYS.recentWorkingFiles,
        [],
    );
    const recentWorkingFilesRef = useRef(recentWorkingFiles);
    recentWorkingFilesRef.current = recentWorkingFiles;
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabIds, setActiveTabIds] = useState<Record<string, string>>({});
    const activeTabIdsRef = useRef(activeTabIds);
    activeTabIdsRef.current = activeTabIds;
    const [isLoading, setIsLoading] = useState(true);
    const activeConnectionIdRef = useRef(activeConnectionId);
    const isLoadingRef = useRef(isLoading);
    activeConnectionIdRef.current = activeConnectionId;
    isLoadingRef.current = isLoading;
    const recentTabs = useRef<Record<string, string[]>>({});
    const previewTabs = useRef<Record<string, string | null>>({});
    const historySnapshot = useRef<{
        tabKey: string;
        activeIds: Record<string, string>;
        connectionId: string | null;
    } | null>(null);

    // History is runtime-only and belongs to the connection, not an editor pane.
    useEffect(() => {
        const tabKey = JSON.stringify(tabs.map((tab) => [tab.connectionId, tab.id]));
        const previous = historySnapshot.current;
        const tabsChanged = previous?.tabKey !== tabKey;
        if (
            !tabsChanged &&
            previous?.activeIds === activeTabIds &&
            previous.connectionId === activeConnectionId
        )
            return;
        historySnapshot.current = {
            tabKey,
            activeIds: activeTabIds,
            connectionId: activeConnectionId,
        };
        // Result updates do not affect history. Prune all connections only when
        // the open tabs change, including tabs removed from an inactive connection.
        if (tabsChanged) {
            for (const connectionId of Object.keys(recentTabs.current)) {
                if (connectionId === activeConnectionId) continue;
                const open = tabs.filter((tab) => tab.connectionId === connectionId);
                recentTabs.current[connectionId] = orderRecentTabs(
                    open,
                    recentTabs.current[connectionId],
                );
            }
        }
        if (!activeConnectionId) return;
        const open = tabs.filter((tab) => tab.connectionId === activeConnectionId);
        const activeId = activeTabIds[activeConnectionId];
        const history = recentTabs.current[activeConnectionId] ?? [];
        const committed =
            activeId && previewTabs.current[activeConnectionId] !== activeId
                ? [activeId, ...history]
                : history;
        recentTabs.current[activeConnectionId] = orderRecentTabs(open, committed);
    }, [tabs, activeTabIds, activeConnectionId]);

    // Closed tabs per connection, for "reopen closed tab". The state mirrors
    // closedTabsRef (kept in sync immediately) so consumers re-render on
    // canReopenClosedTab while reads stay synchronous across quick presses.
    const [closedTabs, setClosedTabs] = useState<ClosedTabsByConnection>({});
    const closedTabsRef = useRef<ClosedTabsByConnection>({});
    const handledMcpRequestIds = useRef(new Set<string>());
    const openRequestListenerReady = useRef<Promise<void> | null>(null);
    const markOpenRequestListenerReady = useRef<() => void>(() => {});
    if (!openRequestListenerReady.current) {
        openRequestListenerReady.current = new Promise<void>((resolve) => {
            markOpenRequestListenerReady.current = resolve;
        });
    }
    const waitForMcpOpenRequestListener = useCallback(() => openRequestListenerReady.current!, []);
    const waitForMcpRunRequestListener = useCallback(() => {
        if (runRequestListenerReady.current) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const ready = () => {
                window.clearTimeout(timeout);
                runRequestListenerWaiters.current.delete(ready);
                resolve();
            };
            const timeout = window.setTimeout(() => {
                runRequestListenerWaiters.current.delete(ready);
                reject(new Error('The editor did not become ready to display the file'));
            }, 20_000);
            runRequestListenerWaiters.current.add(ready);
        });
    }, []);
    const markMcpRunRequestListenerReady = useCallback((ready: boolean) => {
        runRequestListenerReady.current = ready;
        if (!ready) return;
        runRequestListenerWaiters.current.forEach((resolve) => resolve());
        runRequestListenerWaiters.current.clear();
    }, []);
    const openFilesQueueRef = useRef<Promise<void>>(Promise.resolve());

    const schemaCacheRef = useRef<Record<string, SchemaCache>>({});
    const tabsRef = useRef<Tab[]>([]);
    const refreshSchedules = useRef(new Map<string, AutoRefreshSchedule>());
    const getAutoRefreshSchedule = useCallback((tabId: string) => {
        let schedule = refreshSchedules.current.get(tabId);
        if (!schedule) {
            schedule = createAutoRefreshSchedule();
            refreshSchedules.current.set(tabId, schedule);
        }
        return schedule;
    }, []);

    useEffect(() => {
        const open = new Set(tabs.map((tab) => tab.id));
        for (const [id, schedule] of refreshSchedules.current) {
            if (!open.has(id)) {
                schedule.invalidate();
                refreshSchedules.current.delete(id);
            }
        }
    }, [tabs]);
    // A notebook the user asked to open from a different connection. Resolved
    // once that connection's tabs have finished loading (see effect below), so
    // the freshly-added tab isn't wiped by the in-flight preference load.
    const pendingNotebookRef = useRef<{
        connectionId: string;
        notebookId: string;
        title: string;
    } | null>(null);

    useEffect(() => {
        tabsRef.current = tabs;
    }, [tabs]);

    // Every tab close ends here, so a tab leaving the list releases its pinned
    // connection, rolling back any transaction it left open, and drops its result
    // chart views and hidden columns. The list cleared with no active connection
    // is skipped: disconnect and a failed health check release in the backend,
    // and a detached window reopens the same tabs and continues them.
    const releasedFromTabsRef = useRef<Tab[]>([]);
    useEffect(() => {
        const previous = releasedFromTabsRef.current;
        releasedFromTabsRef.current = tabs;
        if (!activeConnectionId) return;
        const open = new Set(tabs.map((t) => t.id));
        const closed = previous.filter((tab) => !open.has(tab.id));
        forgetResultChartStates(closed.map((tab) => tab.id));
        forgetHiddenColumns(closed.map((tab) => tab.id));
        for (const tab of closed) {
            void client
                .call('release_query_session', {
                    connectionId: tab.connectionId,
                    sessionId: tab.id,
                })
                .catch(() => {
                    // The tab is already gone; nothing useful to surface.
                });
        }
    }, [tabs, activeConnectionId, client]);

    // Load tabs from file storage when connection changes
    useEffect(() => {
        if (!activeConnectionId) {
            setTabs([]);
            setIsLoading(false);
            return;
        }

        // This connection's tabs are already live in memory. Storage copies are
        // saved result-stripped, so reloading them here would wipe the query
        // results of every tab whenever the user switches connections (#292).
        if (tabsRef.current.some((t) => t.connectionId === activeConnectionId)) {
            setIsLoading(false);
            return;
        }

        const loadPreferences = async () => {
            setIsLoading(true);
            try {
                const {tabs: loadedTabs, activeTabId: loadedActiveTabId} =
                    await loadEditorPreferences(client, activeConnectionId);

                for (const tab of loadedTabs) {
                    if (tab.sourceFilePath && !tab.sourceFileKind) {
                        tab.sourceFileKind = getSourceFileKind(tab.sourceFilePath);
                        if (tab.sourceFileKind !== 'sql') tab.readOnly = true;
                    }
                    const sqlTvSession = getSqlTvSession(tab.sourceFilePath);
                    if (sqlTvSession) {
                        tab.readOnly = true;
                        tab.title = `SQL TV · ${sqlTvSession}`;
                    }
                }

                // Migrate old notebook tabs: notebookState → notebookId
                for (const tab of loadedTabs) {
                    if (tab.type === 'notebook' && tab.notebookState && !tab.notebookId) {
                        try {
                            const {notebookId} = await createNotebookFromState(
                                tab.title,
                                tab.notebookState,
                                activeConnectionId,
                                client,
                            );
                            tab.notebookId = notebookId;
                            tab.notebookState = undefined;
                        } catch (e) {
                            console.error('Failed to migrate notebook tab:', e);
                        }
                    }
                }

                if (loadedTabs.length > 0) {
                    // Merge loaded tabs with tabs from other connections
                    setTabs((prev) => {
                        const tabsFromOtherConnections = prev.filter(
                            (t) => t.connectionId !== activeConnectionId,
                        );
                        return keepPinnedTabsFirst(
                            [...tabsFromOtherConnections, ...loadedTabs],
                            activeConnectionId,
                        );
                    });
                    setActiveTabIds((prev) => ({
                        ...prev,
                        [activeConnectionId]: loadedActiveTabId || loadedTabs[0].id,
                    }));
                } else {
                    // Create initial tab if no tabs exist, preserving other connections' tabs
                    const initialTab = createInitialTabState(activeConnectionId);
                    setTabs((prev) => {
                        const tabsFromOtherConnections = prev.filter(
                            (t) => t.connectionId !== activeConnectionId,
                        );
                        return [...tabsFromOtherConnections, initialTab];
                    });
                    setActiveTabIds((prev) => ({
                        ...prev,
                        [activeConnectionId]: initialTab.id,
                    }));
                }
            } catch (e) {
                console.error('Failed to load preferences:', e);
                // Fallback: create initial tab, preserving other connections' tabs
                const initialTab = createInitialTabState(activeConnectionId);
                setTabs((prev) => {
                    const tabsFromOtherConnections = prev.filter(
                        (t) => t.connectionId !== activeConnectionId,
                    );
                    return [...tabsFromOtherConnections, initialTab];
                });
                setActiveTabIds((prev) => ({
                    ...prev,
                    [activeConnectionId]: initialTab.id,
                }));
            } finally {
                setIsLoading(false);
            }
        };

        loadPreferences();
    }, [activeConnectionId, client]);

    const createInitialTab = useCallback(
        (partial?: Partial<Tab>): Tab => {
            return createInitialTabState(activeConnectionId, partial);
        },
        [activeConnectionId],
    );

    // Flush all pending notebook saves on app close
    useEffect(() => {
        const handleBeforeUnload = () => {
            flushAllPendingSaves();
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, []);

    // Save tabs to file storage when they change
    useEffect(() => {
        if (!activeConnectionId || isLoading) return;

        const connectionTabs = tabs.filter((t) => t.connectionId === activeConnectionId);
        const activeTabId = activeTabIds[activeConnectionId] || null;

        saveTabsToStorage(client, activeConnectionId, connectionTabs, activeTabId);
    }, [client, tabs, activeTabIds, activeConnectionId, isLoading]);

    const activeTabId = activeConnectionId ? activeTabIds[activeConnectionId] || null : null;

    useEffect(() => {
        const sourcePath = tabsRef.current.find((tab) => tab.id === activeTabId)?.sourceFilePath;
        if (!sourcePath || !isSqlTvPath(sourcePath)) return;

        let stopped = false;
        let timer: number | undefined;
        const refresh = async () => {
            try {
                const content = await client.call('read_sql_file', {path: sourcePath});
                if (stopped) return;
                setTabs((previous) => {
                    const current = previous.find((tab) => tab.id === activeTabId);
                    if (current?.sourceFilePath !== sourcePath) return previous;
                    const updated = reloadCleanWorkingFileBuffer(current, content);
                    return updated === current
                        ? previous
                        : previous.map((tab) => (tab.id === activeTabId ? updated : tab));
                });
            } catch {
                // The producer may be unavailable. Keep the last visible snapshot.
            } finally {
                if (!stopped) timer = window.setTimeout(refresh, 5_000);
            }
        };
        void refresh();
        return () => {
            stopped = true;
            window.clearTimeout(timer);
        };
    }, [activeTabId, client]);

    const setActiveTabId = useCallback(
        (id: string, options?: {preview?: boolean}) => {
            if (activeConnectionId && id) {
                previewTabs.current[activeConnectionId] = options?.preview ? id : null;
                if (!options?.preview) {
                    const history = recentTabs.current[activeConnectionId] ?? [];
                    recentTabs.current[activeConnectionId] = [
                        id,
                        ...history.filter((entry) => entry !== id),
                    ];
                }
                setActiveTabIds((prev) => ({...prev, [activeConnectionId]: id}));
            }
        },
        [activeConnectionId],
    );

    const getRecentTabIds = useCallback(() => {
        if (!activeConnectionId) return [];
        return orderRecentTabs(
            tabsRef.current.filter((tab) => tab.connectionId === activeConnectionId),
            recentTabs.current[activeConnectionId] ?? [],
        );
    }, [activeConnectionId]);

    const addTab = useCallback(
        (partial?: Partial<Tab>, options?: AddTabOptions) => {
            if (!activeConnectionId) return '';

            if (!options?.forceNew) {
                const existing = findExistingTableTab(
                    tabsRef.current,
                    activeConnectionId,
                    partial?.activeTable || undefined,
                    partial?.schema,
                    partial?.database,
                );
                if (existing) {
                    if (options?.activate !== false) setActiveTabId(existing.id);
                    return existing.id;
                }
            }

            const id = generateTabId();
            setTabs((prev) => {
                const title = generateTabTitle(prev, activeConnectionId, partial);
                const newTab = createInitialTab({
                    id,
                    title,
                    connectionId: activeConnectionId,
                    ...partial,
                });
                // A tab inserted after a pinned tab still lands after every pinned tab.
                return keepPinnedTabsFirst(
                    options?.insertAfterId
                        ? insertTabAfter(prev, options.insertAfterId, newTab)
                        : [...prev, newTab],
                    activeConnectionId,
                );
            });
            if (options?.activate !== false) setActiveTabId(id);
            return id;
        },
        [createInitialTab, activeConnectionId, setActiveTabId],
    );
    const addTabRef = useRef(addTab);
    const setActiveTabIdRef = useRef(setActiveTabId);
    addTabRef.current = addTab;
    setActiveTabIdRef.current = setActiveTabId;

    const clearRecentWorkingFiles = useCallback(
        () => setRecentWorkingFiles([]),
        [setRecentWorkingFiles],
    );

    const openWorkingFile = useCallback(
        async (
            filePath: string,
            targetConnectionId?: string,
            background = false,
        ): Promise<{
            tabId: string;
            content: string;
            connectionId: string;
            dirty: boolean;
            sha256?: string;
        }> => {
            const expectedScopeId = commandScopeId ?? ROOT_COMMAND_SCOPE_ID;
            const assertOpenCurrent = () => {
                if (
                    !isWorkingFileOpenCurrent(
                        mountedRef.current,
                        expectedScopeId,
                        activeCommandScopeIdRef.current,
                    )
                ) {
                    if (!mountedRef.current)
                        throw new Error('The editor closed while the file was loading');
                    throw new Error('The selected editor pane changed while the file was loading');
                }
            };
            const scopeDeadline = Date.now() + 20_000;
            while (activeCommandScopeIdRef.current !== expectedScopeId) {
                if (!mountedRef.current)
                    throw new Error('The editor closed while the file was loading');
                if (Date.now() >= scopeDeadline)
                    throw new Error('The selected editor pane did not become active');
                await new Promise((resolve) => window.setTimeout(resolve, 25));
            }
            assertOpenCurrent();
            if (targetConnectionId && targetConnectionId !== activeConnectionIdRef.current) {
                if (isConnectionOpen(targetConnectionId)) switchConnection(targetConnectionId);
                else await connect(targetConnectionId);
                assertOpenCurrent();
                const deadline = Date.now() + 20_000;
                while (
                    activeConnectionIdRef.current !== targetConnectionId ||
                    isLoadingRef.current
                ) {
                    assertOpenCurrent();
                    if (Date.now() >= deadline)
                        throw new Error('Timed out switching database connections');
                    await new Promise((resolve) => window.setTimeout(resolve, 50));
                }
                assertOpenCurrent();
            }

            const loadDeadline = Date.now() + 20_000;
            while (activeConnectionIdRef.current && isLoadingRef.current) {
                assertOpenCurrent();
                if (Date.now() >= loadDeadline)
                    throw new Error('Timed out loading the connection editor');
                await new Promise((resolve) => window.setTimeout(resolve, 25));
            }
            assertOpenCurrent();

            const connectionId = targetConnectionId ?? activeConnectionIdRef.current;
            if (!connectionId) throw new Error('Open a database connection in Tabularis first');
            if (renderedSplitLayout?.connectionIds.includes(connectionId)) {
                setExplorerConnectionId(connectionId);
                navigate(BROWSER_ROUTES.editor);
            } else {
                navigate(buildEditorRoute(connectionId));
            }
            await waitForMcpRunRequestListener();
            assertOpenCurrent();
            const startingActiveTabId = activeTabIdsRef.current[connectionId] ?? null;
            const activate = !background || !startingActiveTabId;
            const activeTabChanged = () =>
                activate && activeTabIdsRef.current[connectionId] !== startingActiveTabId;

            const sourceFileKind = getSourceFileKind(filePath);
            const content = await client.call('read_sql_file', {path: filePath});
            assertOpenCurrent();
            if (activeConnectionIdRef.current !== connectionId || activeTabChanged()) {
                throw new Error(
                    'The active connection or editor tab changed while the file was loading',
                );
            }
            const existing = tabsRef.current.find(
                (tab) => tab.connectionId === connectionId && tab.sourceFilePath === filePath,
            );
            let tabId: string;
            if (existing) {
                tabId = existing.id;
                if (!existing.sourceFileDirty) {
                    setTabs((previous) =>
                        previous.map((tab) =>
                            tab.id === existing.id
                                ? reloadCleanWorkingFileBuffer(tab, content)
                                : tab,
                        ),
                    );
                }
                if (activeConnectionIdRef.current !== connectionId || activeTabChanged()) {
                    throw new Error(
                        'The active connection or editor tab changed while the file was loading',
                    );
                }
                if (activate) setActiveTabIdRef.current(existing.id);
            } else {
                if (activeConnectionIdRef.current !== connectionId || activeTabChanged()) {
                    throw new Error(
                        'The active connection or editor tab changed while the file was loading',
                    );
                }
                tabId = addTabRef.current(
                    {...createSqlFileTab(filePath, content), connectionId, sourceFileKind},
                    {activate},
                );
            }

            const deadline = Date.now() + 10_000;
            while (true) {
                assertOpenCurrent();
                const committedTab = tabsRef.current.find((tab) => tab.id === tabId);
                const isActive = activeTabIdsRef.current[connectionId] === tabId;
                const currentActiveTabId = activeTabIdsRef.current[connectionId] ?? null;
                if (
                    activeConnectionIdRef.current !== connectionId ||
                    (activate &&
                        currentActiveTabId !== startingActiveTabId &&
                        currentActiveTabId !== tabId)
                ) {
                    throw new Error(
                        'The active connection or editor tab changed while the file was opening',
                    );
                }
                if (
                    committedTab &&
                    (!activate || isActive) &&
                    isWorkingFileBufferReady(committedTab, filePath, sourceFileKind, content)
                ) {
                    const currentContent = committedTab.query;
                    const nextRecentFiles = updateRecentWorkingFiles(
                        recentWorkingFilesRef.current,
                        filePath,
                    );
                    recentWorkingFilesRef.current = nextRecentFiles;
                    setRecentWorkingFiles(nextRecentFiles);
                    return {
                        tabId,
                        content: currentContent,
                        connectionId,
                        dirty: committedTab.sourceFileDirty === true,
                        sha256: await sha256(content),
                    };
                }
                if (Date.now() >= deadline)
                    throw new Error(`Timed out waiting for ${getSqlFileName(filePath)} to open`);
                await new Promise((resolve) => window.setTimeout(resolve, 25));
            }
        },
        [
            client,
            commandScopeId,
            connect,
            isConnectionOpen,
            navigate,
            renderedSplitLayout,
            setExplorerConnectionId,
            setRecentWorkingFiles,
            switchConnection,
            waitForMcpRunRequestListener,
        ],
    );

    useEffect(() => {
        if (!commandScopeId) return;
        return registerWorkingFileOpenHandler(commandScopeId, (path, background) =>
            openWorkingFile(path, commandScopeId, background),
        );
    }, [commandScopeId, openWorkingFile]);

    useEffect(() => {
        let disposed = false;
        let openReadyAdvertised = false;
        const onConnectionsPage =
            !commandScopeId && location.pathname === BROWSER_ROUTES.connections;
        let unlisten: (() => void) | undefined;
        const isCurrentCommandOwner = (request: McpUiRequest) => {
            const currentSplit = resolveRenderedSplitLayout({
                splitView: layoutRef.current.splitView,
                isSplitVisible: layoutRef.current.isSplitVisible,
                pathname: layoutRef.current.pathname,
            });
            return isWorkingFileRequestOwner({
                commandScopeId,
                activeCommandScopeId: activeCommandScopeIdRef.current,
                connectionId: request.kind === 'open_files' ? request.connectionId : undefined,
                splitConnectionIds: currentSplit?.connectionIds,
                isSplitRendered: !!currentSplit,
            });
        };
        const isActiveCommandOwner = () =>
            isActiveCommandScope(commandScopeId, activeCommandScopeIdRef.current);
        void client
            .subscribe('mcp://ui_request', (request: McpUiRequest) => {
                if (
                    disposed ||
                    !isCurrentCommandOwner(request) ||
                    !request?.id ||
                    handledMcpRequestIds.current.has(request.id)
                )
                    return;
                if (request.kind === 'run_visible_tab') {
                    if (onConnectionsPage && request.connectionId) {
                        // Editor readiness replays the unclaimed request after navigation.
                        navigate(buildEditorRoute(request.connectionId));
                    }
                    return;
                }
                handledMcpRequestIds.current.add(request.id);

                const respond = async (result: Record<string, unknown>) => {
                    await client.call('write_mcp_ui_response', {
                        path: request.responsePath,
                        content: JSON.stringify(result),
                    });
                };

                const processRequest = async () => {
                    try {
                        await executeClaimedUiRequest(
                            () => client.call('claim_mcp_ui_request', {id: request.id}),
                            async () => {
                                if (!mountedRef.current)
                                    throw new Error(
                                        'The editor closed before accepting the file request',
                                    );
                                if (
                                    request.kind === 'open_files' &&
                                    request.connectionId &&
                                    commandScopeId === request.connectionId
                                ) {
                                    setExplorerConnectionId(request.connectionId);
                                }
                                if (request.kind === 'list_visible_tabs') {
                                    const connectionId = activeConnectionIdRef.current;
                                    const visibleTabs = connectionId
                                        ? tabsRef.current.filter(
                                              (tab) => tab.connectionId === connectionId,
                                          )
                                        : [];
                                    await respond({
                                        ok: true,
                                        activeConnectionId: connectionId,
                                        activeTabId: connectionId
                                            ? (activeTabIdsRef.current[connectionId] ?? null)
                                            : null,
                                        tabs: visibleTabs.map((tab) => ({
                                            id: tab.id,
                                            title: tab.title,
                                            type: tab.type,
                                            connectionId: tab.connectionId,
                                            sourceFilePath: tab.sourceFilePath ?? null,
                                            dirty: tab.sourceFileDirty === true,
                                            active:
                                                tab.id ===
                                                activeTabIdsRef.current[tab.connectionId],
                                            error: tab.error ?? null,
                                            result: tab.result
                                                ? {
                                                      columns: tab.result.columns,
                                                      totalRows:
                                                          tab.result.pagination?.total_rows ?? null,
                                                      rows: tab.result.rows.slice(0, 20),
                                                  }
                                                : null,
                                            results: (tab.results ?? []).map((entry) => ({
                                                query: entry.query,
                                                error: entry.error || null,
                                                result: entry.result
                                                    ? {
                                                          columns: entry.result.columns,
                                                          totalRows:
                                                              entry.result.pagination?.total_rows ??
                                                              null,
                                                          rows: entry.result.rows.slice(0, 20),
                                                      }
                                                    : null,
                                            })),
                                        })),
                                    });
                                    return;
                                }

                                if (request.kind !== 'open_files')
                                    throw new Error('Unknown MCP UI request');
                                const opened: {
                                    path: string;
                                    sha256: string;
                                    dirty: boolean;
                                    connectionId: string;
                                }[] = [];
                                const seenPaths = new Set<string>();
                                let lastOpenedTabId: string | null = null;
                                let lastOpenedConnectionId: string | null = null;
                                let routedToSplitPane = false;
                                let routedOpenHandler: RoutedWorkingFileOpenHandler<
                                    Awaited<ReturnType<typeof openWorkingFile>>
                                > | null = null;
                                for (const path of request.paths) {
                                    if (seenPaths.has(path)) continue;
                                    seenPaths.add(path);
                                    const connectionId = request.connectionId;
                                    const background = isSqlTvPath(path);
                                    let openResult: Awaited<ReturnType<typeof openWorkingFile>>;
                                    const currentSplit = resolveRenderedSplitLayout({
                                        splitView: layoutRef.current.splitView,
                                        isSplitVisible: layoutRef.current.isSplitVisible,
                                        pathname: layoutRef.current.pathname,
                                    });
                                    const existingRoutedOpenHandler =
                                        getRoutedWorkingFileOpenHandler(
                                            routedOpenHandler,
                                            connectionId,
                                        );
                                    if (existingRoutedOpenHandler) {
                                        openResult = await existingRoutedOpenHandler.open(
                                            path,
                                            background,
                                        );
                                        routedToSplitPane = true;
                                    } else if (
                                        connectionId &&
                                        !commandScopeId &&
                                        currentSplit &&
                                        !currentSplit.connectionIds.includes(connectionId)
                                    ) {
                                        const initialExplorerConnectionId =
                                            layoutRef.current.explorerConnectionId;
                                        if (isConnectionOpen(connectionId))
                                            switchConnection(connectionId);
                                        else await connect(connectionId);
                                        if (
                                            layoutRef.current.explorerConnectionId !==
                                            initialExplorerConnectionId
                                        ) {
                                            throw new Error(
                                                'The selected connection changed while the file was loading',
                                            );
                                        }
                                        if (currentSplit.connectionIds.length >= 4) {
                                            hideSplitView();
                                            setExplorerConnectionId(connectionId);
                                            navigate(buildEditorRoute(connectionId));
                                            openResult = await openWorkingFile(
                                                path,
                                                connectionId,
                                                background,
                                            );
                                        } else {
                                            addConnectionToSplit(connectionId);
                                            setExplorerConnectionId(connectionId);
                                            navigate(BROWSER_ROUTES.editor);
                                            const targetOpenHandler =
                                                await waitForWorkingFileOpenHandler(connectionId);
                                            if (
                                                layoutRef.current.explorerConnectionId !==
                                                connectionId
                                            ) {
                                                throw new Error(
                                                    'The selected connection changed before the file opened',
                                                );
                                            }
                                            routedOpenHandler = {
                                                connectionId,
                                                open: targetOpenHandler,
                                            };
                                            openResult = await routedOpenHandler.open(
                                                path,
                                                background,
                                            );
                                            routedToSplitPane = true;
                                        }
                                    } else {
                                        openResult = await openWorkingFile(
                                            path,
                                            connectionId,
                                            background,
                                        );
                                    }
                                    const tab = routedToSplitPane
                                        ? undefined
                                        : tabsRef.current.find(
                                              (entry) => entry.id === openResult.tabId,
                                          );
                                    if (
                                        !routedToSplitPane &&
                                        (!tab ||
                                            tab.connectionId !==
                                                (connectionId ?? activeConnectionIdRef.current))
                                    ) {
                                        throw new Error(
                                            `Could not confirm ${getSqlFileName(path)} in the editor`,
                                        );
                                    }
                                    if (!background) {
                                        lastOpenedTabId = openResult.tabId;
                                        lastOpenedConnectionId = openResult.connectionId;
                                    }
                                    opened.push({
                                        path,
                                        sha256:
                                            openResult.sha256 ?? (await sha256(openResult.content)),
                                        dirty: openResult.dirty,
                                        connectionId: openResult.connectionId,
                                    });
                                }
                                if (
                                    !routedToSplitPane &&
                                    lastOpenedConnectionId &&
                                    (activeConnectionIdRef.current !== lastOpenedConnectionId ||
                                        activeTabIdsRef.current[lastOpenedConnectionId] !==
                                            lastOpenedTabId)
                                ) {
                                    throw new Error(
                                        'The active connection or editor tab changed before the file request completed',
                                    );
                                }
                                await respond({
                                    ok: true,
                                    activeConnectionId:
                                        lastOpenedConnectionId ?? activeConnectionIdRef.current,
                                    activeTabId:
                                        lastOpenedTabId ??
                                        activeTabIdsRef.current[
                                            activeConnectionIdRef.current ?? ''
                                        ] ??
                                        null,
                                    files: opened,
                                });
                            },
                        );
                    } catch (error) {
                        try {
                            await respond({ok: false, error: String(error)});
                        } catch {
                            // The MCP caller will time out if the acknowledgement cannot be written.
                        }
                    } finally {
                        handledMcpRequestIds.current.delete(request.id);
                    }
                };
                if (request.kind === 'open_files') {
                    void enqueueWorkingFileOpen(openFilesQueueRef, processRequest);
                } else {
                    void processRequest();
                }
            })
            .then(async (stop) => {
                if (disposed) {
                    stop();
                    return;
                }
                unlisten = stop;
                if (isActiveCommandOwner()) {
                    markOpenRequestListenerReady.current();
                    try {
                        await client.call('mcp_ui_ready', {kind: 'open_files', ready: true});
                        openReadyAdvertised = true;
                        if (!disposed && onConnectionsPage) {
                            await client.call('mcp_ui_ready', {
                                kind: 'run_visible_tab',
                                ready: true,
                            });
                        }
                    } catch {
                        // Browser transports do not expose the desktop request watcher.
                    }
                }
            });
        return () => {
            disposed = true;
            unlisten?.();
            if (onConnectionsPage) {
                void client
                    .call('mcp_ui_ready', {kind: 'run_visible_tab', ready: false})
                    .catch(() => {});
            }
            if (openReadyAdvertised) {
                void client
                    .call('mcp_ui_ready', {kind: 'open_files', ready: false})
                    .catch(() => {});
            }
        };
    }, [
        activeConnectionId,
        addConnectionToSplit,
        client,
        openWorkingFile,
        commandScopeId,
        explorerConnectionId,
        hideSplitView,
        isSplitVisible,
        navigate,
        setExplorerConnectionId,
        splitView,
        location.pathname,
    ]);

    // Open (or focus) a notebook tab, possibly belonging to another connection.
    // For the active connection it resolves immediately; otherwise it records the
    // intent and lets the effect below complete it after the target connection's
    // tabs have loaded (the caller is expected to call switchConnection too).
    const resolvePendingNotebook = useCallback(() => {
        const pending = pendingNotebookRef.current;
        if (!pending) return;
        if (isLoading || pending.connectionId !== activeConnectionId) return;
        pendingNotebookRef.current = null;
        const existing = tabsRef.current.find((t) => t.notebookId === pending.notebookId);
        if (existing) {
            setActiveTabId(existing.id);
        } else {
            addTab({type: 'notebook', notebookId: pending.notebookId, title: pending.title});
        }
    }, [isLoading, activeConnectionId, addTab, setActiveTabId]);

    const openNotebook = useCallback(
        (connectionId: string, notebookId: string, title: string) => {
            pendingNotebookRef.current = {connectionId, notebookId, title};
            resolvePendingNotebook();
        },
        [resolvePendingNotebook],
    );

    // Complete a deferred cross-connection notebook open once the connection's
    // tabs have settled (isLoading false + activeConnectionId matches).
    useEffect(() => {
        resolvePendingNotebook();
    }, [resolvePendingNotebook]);

    // Record tabs closed by the close actions below on their connection's
    // reopen stack. Runs outside the setTabs updater so React strict mode's
    // double invocation cannot push an entry twice.
    const rememberClosedTabs = useCallback((closedIds: string[]) => {
        const next = pushClosedTabs(closedTabsRef.current, tabsRef.current, closedIds);
        closedTabsRef.current = next;
        setClosedTabs(next);
    }, []);

    const closeTab = useCallback(
        (id: string) => {
            // Flush and evict notebook cache for the closed tab
            const closedTab = tabsRef.current.find((t) => t.id === id);
            if (closedTab?.notebookId) {
                evictFromCache(closedTab.notebookId);
            }

            rememberClosedTabs([id]);

            setTabs((prev) => {
                const {newTabs, newActiveTabId: nextActiveId} = closeTabWithState(
                    prev,
                    activeConnectionId || '',
                    activeTabId,
                    id,
                );

                if (nextActiveId !== activeTabId) {
                    setActiveTabIds((prevIds) => ({
                        ...prevIds,
                        [activeConnectionId || '']: nextActiveId || '',
                    }));
                }

                return newTabs;
            });
        },
        [activeConnectionId, activeTabId, rememberClosedTabs],
    );

    const closeAllTabs = useCallback(() => {
        if (!activeConnectionId) return;
        rememberClosedTabs(
            getBulkClosedTabIds(
                tabsRef.current.filter((t) => t.connectionId === activeConnectionId),
                'all',
            ),
        );
        setTabs((prev) => {
            const {newTabs, newActiveTabId} = closeAllTabsForConnection(
                prev,
                activeConnectionId,
                activeTabId,
            );
            setActiveTabIds((prevIds) => ({
                ...prevIds,
                [activeConnectionId]: newActiveTabId || '',
            }));
            return newTabs;
        });
    }, [activeConnectionId, activeTabId, rememberClosedTabs]);

    const closeOtherTabs = useCallback(
        (id: string) => {
            if (!activeConnectionId) return;
            rememberClosedTabs(
                getBulkClosedTabIds(
                    tabsRef.current.filter((t) => t.connectionId === activeConnectionId),
                    'others',
                    id,
                ),
            );
            setTabs((prev) => {
                const newTabs = closeOtherTabsForConnection(prev, activeConnectionId, id);
                setActiveTabIds((prevIds) => ({
                    ...prevIds,
                    [activeConnectionId]: id,
                }));
                return newTabs;
            });
        },
        [activeConnectionId, rememberClosedTabs],
    );

    const closeTabsToLeftInternal = useCallback(
        (id: string) => {
            if (!activeConnectionId) return;
            const connTabs = tabsRef.current.filter((t) => t.connectionId === activeConnectionId);
            rememberClosedTabs(getBulkClosedTabIds(connTabs, 'left', id));
            setTabs((prev) => {
                const {newTabs, newActiveTabId} = closeTabsToLeft(
                    prev,
                    activeConnectionId,
                    id,
                    activeTabId,
                );
                if (newActiveTabId && newActiveTabId !== activeTabId) {
                    setActiveTabIds((prevIds) => ({
                        ...prevIds,
                        [activeConnectionId]: newActiveTabId,
                    }));
                }
                return newTabs;
            });
        },
        [activeConnectionId, activeTabId, rememberClosedTabs],
    );

    const closeTabsToRightInternal = useCallback(
        (id: string) => {
            if (!activeConnectionId) return;
            const connTabs = tabsRef.current.filter((t) => t.connectionId === activeConnectionId);
            rememberClosedTabs(getBulkClosedTabIds(connTabs, 'right', id));
            setTabs((prev) => {
                const {newTabs, newActiveTabId} = closeTabsToRight(
                    prev,
                    activeConnectionId,
                    id,
                    activeTabId,
                );
                if (newActiveTabId && newActiveTabId !== activeTabId) {
                    setActiveTabIds((prevIds) => ({
                        ...prevIds,
                        [activeConnectionId]: newActiveTabId,
                    }));
                }
                return newTabs;
            });
        },
        [activeConnectionId, activeTabId, rememberClosedTabs],
    );

    // Reopen the most recently closed tab of the active connection at its
    // previous position and activate it. Reads both mirrors through refs so
    // two quick presses restore two different tabs (LIFO).
    const reopenClosedTab = useCallback((): string | null => {
        if (!activeConnectionId) return null;
        const {entry, stacks} = popClosedTab(closedTabsRef.current, activeConnectionId);
        if (!entry) return null;
        closedTabsRef.current = stacks;
        setClosedTabs(stacks);

        const {newTabs, tab} = insertReopenedTab(tabsRef.current, activeConnectionId, entry);
        setTabs(keepPinnedTabsFirst(newTabs, activeConnectionId));
        setActiveTabId(tab.id);
        return tab.id;
    }, [activeConnectionId, setActiveTabId]);

    const updateTab = useCallback(
        (id: string, partial: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => {
            setTabs((prev) => updateTabInList(prev, id, partial));
        },
        [],
    );

    const reorderTab = useCallback(
        (fromTabId: string, insertAt: number) => {
            if (!activeConnectionId) return;
            setTabs((prev) => moveTab(prev, activeConnectionId, fromTabId, insertAt));
        },
        [activeConnectionId],
    );

    const pinTab = useCallback((id: string, pinned: boolean) => {
        setTabs((prev) => setTabPinned(prev, id, pinned));
    }, []);

    const updateResultEntry = useCallback(
        (tabId: string, entryId: string, partial: Partial<QueryResultEntry>) => {
            setTabs((prev) =>
                prev.map((t) =>
                    t.id === tabId && t.results
                        ? {
                              ...t,
                              results: t.results.map((r) =>
                                  r.id === entryId ? {...r, ...partial} : r,
                              ),
                          }
                        : t,
                ),
            );
        },
        [],
    );

    const getSchema = useCallback(
        async (
            connectionId: string,
            schemaVersion?: number,
            schema?: string,
            database?: string,
        ): Promise<TableSchema[]> => {
            const cacheKey = [connectionId, database, schema].filter(Boolean).join(':');
            const cached = schemaCacheRef.current[cacheKey];

            if (shouldUseCachedSchema(cached, schemaVersion)) {
                return cached!.data;
            }

            const data = await client.call('get_schema_snapshot', {
                connectionId,
                ...(schema ? {schema} : {}),
                ...(database ? {database} : {}),
            });

            // Update cache in ref (no state update = no re-render)
            schemaCacheRef.current = {
                ...schemaCacheRef.current,
                [cacheKey]: createSchemaCacheEntry(data, schemaVersion || 0),
            };

            return data;
        },
        [client],
    );

    const activeTab = useMemo(() => {
        return getActiveTab(tabs, activeConnectionId, activeTabId);
    }, [tabs, activeTabId, activeConnectionId]);

    const connectionTabs = useMemo(() => {
        return getConnectionTabs(tabs, activeConnectionId);
    }, [tabs, activeConnectionId]);

    const canReopenClosedTab =
        !!activeConnectionId && (closedTabs[activeConnectionId]?.length ?? 0) > 0;

    const contextValue = useMemo(
        () => ({
            tabs: connectionTabs,
            recentWorkingFiles,
            openWorkingFile,
            clearRecentWorkingFiles,
            waitForMcpOpenRequestListener,
            waitForMcpRunRequestListener,
            markMcpRunRequestListenerReady,
            activeTabId,
            activeTab,
            addTab,
            openNotebook,
            closeTab,
            updateTab,
            reorderTab,
            setTabPinned: pinTab,
            updateResultEntry,
            setActiveTabId,
            getRecentTabIds,
            closeAllTabs,
            closeOtherTabs,
            closeTabsToLeft: closeTabsToLeftInternal,
            closeTabsToRight: closeTabsToRightInternal,
            reopenClosedTab,
            canReopenClosedTab,
            getSchema,
            getAutoRefreshSchedule,
        }),
        [
            connectionTabs,
            recentWorkingFiles,
            openWorkingFile,
            clearRecentWorkingFiles,
            waitForMcpOpenRequestListener,
            waitForMcpRunRequestListener,
            markMcpRunRequestListenerReady,
            activeTabId,
            activeTab,
            addTab,
            openNotebook,
            closeTab,
            updateTab,
            reorderTab,
            pinTab,
            updateResultEntry,
            setActiveTabId,
            getRecentTabIds,
            closeAllTabs,
            closeOtherTabs,
            closeTabsToLeftInternal,
            closeTabsToRightInternal,
            reopenClosedTab,
            canReopenClosedTab,
            getSchema,
            getAutoRefreshSchedule,
        ],
    );

    return <EditorContext.Provider value={contextValue}>{children}</EditorContext.Provider>;
};
