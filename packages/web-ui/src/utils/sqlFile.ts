import type {Tab} from '@/types/editor';
import {sanitizeFileNamePart} from './exportFileName';

export function getSqlFileName(filePath: string): string {
    return filePath.split(/[/\\]/).filter(Boolean).pop() ?? 'SQL File';
}

/**
 * Derives a safe, filesystem-friendly suggested filename for exporting a saved
 * query as a SQL file. Strips any existing .sql, .psql, or .pgsql extension,
 * sanitizes invalid and reserved characters across Windows, macOS, and Linux,
 * and preserves valid extensions (defaulting to .sql).
 */
const SQL_EXTENSIONS = new Set(['sql', 'psql', 'pgsql']);

const SOURCE_LANGUAGES: Record<string, string> = {
    bash: 'shell',
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    dockerfile: 'plaintext',
    env: 'plaintext',
    graphql: 'plaintext',
    go: 'go',
    h: 'c',
    hcl: 'plaintext',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsonc: 'json',
    jsx: 'javascript',
    kt: 'kotlin',
    lua: 'lua',
    md: 'markdown',
    markdown: 'markdown',
    mjs: 'javascript',
    mts: 'typescript',
    proto: 'plaintext',
    properties: 'plaintext',
    prisma: 'plaintext',
    gql: 'plaintext',
    csv: 'plaintext',
    log: 'plaintext',
    mdx: 'markdown',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'shell',
    sql: 'sql',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
};

export function isSqlSourceFile(filePath: string): boolean {
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    return SQL_EXTENSIONS.has(extension);
}

export function getSqlTvSession(filePath?: string): string | undefined {
    return filePath
        ?.replaceAll('\\', '/')
        .match(/(?:^|\/)\.duck\/tabularis\/((?:claude|codex)-[a-f0-9]{12})\.sql$/i)?.[1];
}

export function isSqlTvPath(filePath: string): boolean {
    return (
        Boolean(getSqlTvSession(filePath)) ||
        filePath.replaceAll('\\', '/').endsWith('/.duck/tabularis/Active agent sessions.md')
    );
}

function sqlTvEntryAtCursor(content: string, cursorLine: number): string[] {
    const lines = content.split('\n');
    const entries = lines.flatMap((line, index) =>
        line.startsWith('-- SQL TV call ') ? [index] : [],
    );
    const start = entries.filter((index) => index < cursorLine).at(-1) ?? entries[0];
    if (start === undefined) return [];
    const end = entries.find((index) => index > start);
    return lines.slice(start, end);
}

export function buildSqlTvFeedback(content: string, cursorLine: number): string {
    const header = content.split('\n', 2).join('\n');
    const entry = sqlTvEntryAtCursor(content, cursorLine).join('\n').trimEnd();
    return entry ? `${header}\n\n${entry}` : content;
}

export function buildSqlTvScratch(content: string, cursorLine: number, selection?: string): string {
    if (selection) return selection;
    const entry = sqlTvEntryAtCursor(content, cursorLine);
    const outcome = entry.findIndex(
        (line, index) => index > 1 && /^(-- Recorded |-- No result recorded)/.test(line),
    );
    return outcome === -1 ? '' : entry.slice(2, outcome).join('\n');
}

export function getSourceFileKind(filePath: string): 'sql' | 'markdown' | 'text' {
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (SQL_EXTENSIONS.has(extension)) return 'sql';
    if (extension === 'md' || extension === 'markdown') return 'markdown';
    return 'text';
}

export function getSourceFileLanguage(filePath: string): string {
    const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
    return SOURCE_LANGUAGES[extension] ?? 'plaintext';
}

export function getSavedQueryExportFileName(name?: string | null): string {
    if (!name) return 'query.sql';
    const trimmed = name.trim();
    const extMatch = trimmed.match(/\.(sql|psql|pgsql)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'sql';
    const baseName = extMatch ? trimmed.slice(0, extMatch.index) : trimmed;
    const safeBase = sanitizeFileNamePart(baseName);
    if (!safeBase) {
        return `query.${ext}`;
    }
    return `${safeBase}.${ext}`;
}

export function createSqlFileTab(filePath: string, query: string, schema?: string): Partial<Tab> {
    const sqlTvSession = getSqlTvSession(filePath);
    return {
        type: 'console',
        title: sqlTvSession ? `SQL TV · ${sqlTvSession}` : getSqlFileName(filePath),
        query,
        sourceFileKind: getSourceFileKind(filePath),
        ...(sqlTvSession || !isSqlSourceFile(filePath) ? {readOnly: true} : {}),
        sourceFilePath: filePath,
        sourceFileContent: query,
        sourceFileDirty: false,
        ...(schema ? {schema} : {}),
    };
}

/**
 * Tab fields after writing `savedContent` to `filePath`. The dirty flag is
 * recomputed against `currentQuery`, which may have moved on while the write
 * was in flight.
 */
export function savedSqlFileTab(
    filePath: string,
    savedContent: string,
    currentQuery: string = savedContent,
): Partial<Tab> {
    return {
        title: getSqlFileName(filePath),
        sourceFilePath: filePath,
        sourceFileContent: savedContent,
        sourceFileDirty: currentQuery !== savedContent,
    };
}

/**
 * Dirty means the editor text differs from what is on disk, so typing a
 * character and deleting it again leaves the file clean.
 */
export function isSqlFileDirty(
    tab: Pick<Tab, 'sourceFilePath' | 'sourceFileContent'>,
    query: string,
): boolean {
    if (!tab.sourceFilePath) return false;
    return query !== (tab.sourceFileContent ?? '');
}

export function hasUnsavedSqlFileTabs(
    tabs: ReadonlyArray<Pick<Tab, 'id' | 'sourceFilePath' | 'sourceFileDirty'>>,
    tabIds: string[],
): boolean {
    const closingIds = new Set(tabIds);
    return tabs.some(
        (tab) =>
            closingIds.has(tab.id) && Boolean(tab.sourceFilePath) && tab.sourceFileDirty === true,
    );
}
