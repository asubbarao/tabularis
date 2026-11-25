import {describe, expect, it, vi} from 'vitest';
import {fireEvent, render, screen} from '@testing-library/react';
import {RecentWorkingFiles} from '@/components/editor/RecentWorkingFiles';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, values?: Record<string, string>) => {
            const strings: Record<string, string> = {
                'editor.recentWorkingFiles.title': 'Recent files',
                'editor.recentWorkingFiles.clear': 'Clear history',
                'editor.recentWorkingFiles.empty': 'No recent files.',
                'editor.recentWorkingFiles.openFailed': 'Could not reopen file: {{error}}',
                'editor.recentWorkingFiles.reopen': 'Reopen {{path}}',
            };
            return (strings[key] ?? key)
                .replace('{{path}}', values?.path ?? '')
                .replace('{{error}}', values?.error ?? '');
        },
    }),
}));

vi.mock('lucide-react', () => ({Clock3: () => null}));

describe('RecentWorkingFiles', () => {
    it('closes on Escape and returns keyboard focus to its trigger', () => {
        render(
            <RecentWorkingFiles paths={['/repo/config.tf']} onOpen={vi.fn()} onClear={vi.fn()} />,
        );

        const trigger = screen.getByRole('button', {name: 'Recent files'});
        fireEvent.click(trigger);
        expect(screen.getByRole('region', {name: 'Recent files'})).toBeTruthy();

        fireEvent.keyDown(document, {key: 'Escape'});

        expect(screen.queryByRole('region', {name: 'Recent files'})).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('closes when the pointer moves outside and exposes a full-path reopen action', () => {
        render(
            <div>
                <button type="button" data-testid="outside">
                    Outside
                </button>
                <RecentWorkingFiles
                    paths={['/Users/example/project/config.tf']}
                    onOpen={vi.fn()}
                    onClear={vi.fn()}
                />
            </div>,
        );

        fireEvent.click(screen.getByRole('button', {name: 'Recent files'}));
        expect(
            screen.getByRole('button', {name: 'Reopen /Users/example/project/config.tf'}),
        ).toBeTruthy();

        fireEvent.pointerDown(screen.getByTestId('outside'));

        expect(screen.queryByRole('region', {name: 'Recent files'})).toBeNull();
    });
});
