import {describe, expect, it} from 'vitest';
import {
    buildSqlTvFeedback,
    buildSqlTvScratch,
    createSqlFileTab,
    getSourceFileKind,
    getSourceFileLanguage,
    getSavedQueryExportFileName,
    getSqlFileName,
    hasUnsavedSqlFileTabs,
    isSqlFileDirty,
    savedSqlFileTab,
} from '@/utils/sqlFile';

describe('sqlFile', () => {
    it('opens only the current statement in scratch when there is no selection', () => {
        expect(
            buildSqlTvScratch(
                '-- claude session 123\n-- branch main | cwd /work\n' +
                    '-- SQL TV call one\n-- cwd /work | transcript 1 → 2\n' +
                    'SELECT 2;\n-- Recorded tool result: [2]\n' +
                    '-- SQL TV call two\n-- cwd /work | transcript 3 → 4\n' +
                    'SELECT 1;\n-- Recorded tool result: [1]\n',
                9,
            ),
        ).toBe('SELECT 1;');
    });
    it('copies the statement and observed result at the cursor with the source session', () => {
        expect(
            buildSqlTvFeedback(
                '-- claude session 123\n-- branch main | cwd /work\n' +
                    '-- SQL TV call one\nSELECT 2;\n-- observed rows: [2]\n' +
                    '-- SQL TV call two\nSELECT 1;\n-- observed rows: [1]\n',
                8,
            ),
        ).toBe(
            '-- claude session 123\n-- branch main | cwd /work\n\n' +
                '-- SQL TV call two\nSELECT 1;\n-- observed rows: [1]',
        );
    });

    describe('getSqlFileName', () => {
        it('returns the last segment of Unix and Windows paths', () => {
            expect(getSqlFileName('/home/user/queries/report.sql')).toBe('report.sql');
            expect(getSqlFileName('C:\\queries\\schema.psql')).toBe('schema.psql');
        });

        it('falls back to a generic name for empty paths', () => {
            expect(getSqlFileName('')).toBe('SQL File');
        });
    });

    describe('createSqlFileTab', () => {
        it('creates passive SQL TV tabs without changing regular SQL files', () => {
            const path = '/home/user/.duck/tabularis/claude-6b62258612e1.sql';
            expect(createSqlFileTab(path, 'SELECT 1;')).toMatchObject({
                title: 'SQL TV · claude-6b62258612e1',
                query: 'SELECT 1;',
                readOnly: true,
                sourceFilePath: path,
                sourceFileDirty: false,
            });
            expect(
                createSqlFileTab('/work/claude-6b62258612e1.sql', 'SELECT 1;').readOnly,
            ).toBeUndefined();
            expect(
                createSqlFileTab('/home/user/.duck/tabularis/claude-issue-seed01.sql', 'SELECT 1;')
                    .readOnly,
            ).toBeUndefined();
        });

        it('creates a console tab named after a Unix file path', () => {
            expect(createSqlFileTab('/tmp/report.sql', 'SELECT 1;')).toEqual({
                type: 'console',
                title: 'report.sql',
                query: 'SELECT 1;',
                sourceFileKind: 'sql',
                sourceFilePath: '/tmp/report.sql',
                sourceFileContent: 'SELECT 1;',
                sourceFileDirty: false,
            });
        });

        it('supports Windows paths and preserves the selected schema', () => {
            expect(
                createSqlFileTab('C:\\queries\\schema.psql', 'CREATE TABLE users ();', 'analytics'),
            ).toEqual({
                type: 'console',
                title: 'schema.psql',
                query: 'CREATE TABLE users ();',
                sourceFileKind: 'sql',
                sourceFilePath: 'C:\\queries\\schema.psql',
                sourceFileContent: 'CREATE TABLE users ();',
                sourceFileDirty: false,
                schema: 'analytics',
            });
        });

        it('keeps non-SQL files out of the run path and selects a text language', () => {
            expect(createSqlFileTab('/work/main.tf', 'resource "x" "y" {}').readOnly).toBe(true);
            expect(createSqlFileTab('/work/settings.json', '{}').readOnly).toBe(true);
            expect(createSqlFileTab('/work/query.sql', 'SELECT 1').readOnly).toBeUndefined();
            expect(getSourceFileLanguage('/work/main.tf')).toBe('plaintext');
            expect(getSourceFileLanguage('/work/config.yaml')).toBe('yaml');
            expect(getSourceFileLanguage('/work/README.md')).toBe('markdown');
            expect(getSourceFileLanguage('/work/unknown.custom')).toBe('plaintext');
            expect(getSourceFileKind('/work/main.tf')).toBe('text');
            expect(getSourceFileKind('/work/README.md')).toBe('markdown');
            expect(getSourceFileKind('/work/page.pdf')).toBe('text');
            expect(getSourceFileKind('/work/chart.svg')).toBe('text');
            expect(getSourceFileKind('/work/custom.filetype')).toBe('text');
            expect(getSourceFileKind('/work/.gitignore')).toBe('text');
        });
    });

    describe('savedSqlFileTab', () => {
        it('updates the path and clears the dirty state after Save As', () => {
            expect(savedSqlFileTab('/tmp/renamed.pgsql', 'SELECT 2;')).toEqual({
                title: 'renamed.pgsql',
                sourceFilePath: '/tmp/renamed.pgsql',
                sourceFileContent: 'SELECT 2;',
                sourceFileDirty: false,
            });
        });

        it('stays dirty when the editor changed while the write was in flight', () => {
            expect(savedSqlFileTab('/tmp/q.sql', 'SELECT 2;', 'SELECT 22;').sourceFileDirty).toBe(
                true,
            );
        });
    });

    describe('isSqlFileDirty', () => {
        const tab = {sourceFilePath: '/tmp/q.sql', sourceFileContent: 'SELECT 1;'};

        it('is dirty only while the editor text differs from the file', () => {
            expect(isSqlFileDirty(tab, 'SELECT 1;x')).toBe(true);
            expect(isSqlFileDirty(tab, 'SELECT 1;')).toBe(false);
        });

        it('never marks a console without a backing file', () => {
            expect(isSqlFileDirty({sourceFilePath: undefined}, 'SELECT 1;')).toBe(false);
        });
    });

    describe('hasUnsavedSqlFileTabs', () => {
        const tabs = [
            {id: 'clean', sourceFilePath: '/tmp/clean.sql', sourceFileDirty: false},
            {id: 'dirty', sourceFilePath: '/tmp/dirty.sql', sourceFileDirty: true},
            {id: 'console', sourceFileDirty: true},
        ];

        it('detects a dirty SQL file among the tabs being closed', () => {
            expect(hasUnsavedSqlFileTabs(tabs, ['clean', 'dirty'])).toBe(true);
        });

        it('ignores clean tabs and consoles not backed by a file', () => {
            expect(hasUnsavedSqlFileTabs(tabs, ['clean', 'console'])).toBe(false);
        });
    });

    describe('getSavedQueryExportFileName', () => {
        it('appends .sql to standard query names', () => {
            expect(getSavedQueryExportFileName('Active Users')).toBe('Active Users.sql');
            expect(getSavedQueryExportFileName('monthly_revenue')).toBe('monthly_revenue.sql');
        });

        it('preserves existing .sql, .psql and .pgsql extensions without duplicating them', () => {
            expect(getSavedQueryExportFileName('report.sql')).toBe('report.sql');
            expect(getSavedQueryExportFileName('REPORT.SQL')).toBe('REPORT.sql');
            expect(getSavedQueryExportFileName('schema.pgsql')).toBe('schema.pgsql');
            expect(getSavedQueryExportFileName('trigger.psql')).toBe('trigger.psql');
        });

        it('sanitizes invalid and reserved characters across platforms', () => {
            expect(getSavedQueryExportFileName('sales/2026:report*')).toBe(
                'sales_2026_report_.sql',
            );
            expect(getSavedQueryExportFileName('CON')).toBe('CON_.sql');
            expect(getSavedQueryExportFileName('nul.sql')).toBe('nul_.sql');
            expect(getSavedQueryExportFileName('query\nwith\ttab')).toBe('query_with_tab.sql');
        });

        it('supports Unicode characters in query names', () => {
            expect(getSavedQueryExportFileName('用户查询')).toBe('用户查询.sql');
            expect(getSavedQueryExportFileName('クエリ')).toBe('クエリ.sql');
        });

        it('falls back to a default name for empty, blank, or invalid names', () => {
            expect(getSavedQueryExportFileName('')).toBe('query.sql');
            expect(getSavedQueryExportFileName('   ')).toBe('query.sql');
            expect(getSavedQueryExportFileName(null)).toBe('query.sql');
            expect(getSavedQueryExportFileName(undefined)).toBe('query.sql');
            expect(getSavedQueryExportFileName('.sql')).toBe('query.sql');
            expect(getSavedQueryExportFileName('///:::***')).toBe('query.sql');
        });
    });
});
