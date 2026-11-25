import {useEffect, useId, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Clock3} from 'lucide-react';

interface RecentWorkingFilesProps {
    paths: string[];
    onOpen: (path: string) => Promise<unknown>;
    onClear: () => void;
}

export function RecentWorkingFiles({paths, onOpen, onClear}: RecentWorkingFilesProps) {
    const {t} = useTranslation();
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
                setOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
            }
        };

        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    const reopen = async (path: string) => {
        setError(null);
        try {
            await onOpen(path);
            setOpen(false);
            triggerRef.current?.focus();
        } catch (reason) {
            setError(t('editor.recentWorkingFiles.openFailed', {error: String(reason)}));
        }
    };

    return (
        <div ref={rootRef} className="relative flex h-full shrink-0">
            <button
                ref={triggerRef}
                type="button"
                aria-label={t('editor.recentWorkingFiles.title')}
                aria-expanded={open}
                aria-controls={panelId}
                title={t('editor.recentWorkingFiles.title')}
                onClick={() => setOpen((value) => !value)}
                className="flex h-full w-9 items-center justify-center border-l border-default text-muted transition-colors hover:bg-surface-secondary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
                <Clock3 size={15} aria-hidden="true" />
            </button>
            {open && (
                <section
                    id={panelId}
                    aria-label={t('editor.recentWorkingFiles.title')}
                    className="absolute left-0 top-full z-[80] mt-1 w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-default bg-surface-primary p-2 shadow-xl"
                >
                    <div className="flex items-center justify-between gap-2 border-b border-default px-2 pb-2">
                        <span className="text-xs font-semibold text-primary">
                            {t('editor.recentWorkingFiles.title')}
                        </span>
                        <button
                            type="button"
                            onClick={() => {
                                onClear();
                                setError(null);
                            }}
                            disabled={paths.length === 0}
                            className="rounded px-2 py-1 text-xs text-muted hover:bg-surface-secondary hover:text-primary disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                            {t('editor.recentWorkingFiles.clear')}
                        </button>
                    </div>
                    {error && (
                        <div
                            role="alert"
                            className="mx-2 mt-2 rounded border border-accent-error/30 bg-accent-error/10 p-2 text-xs text-accent-error"
                        >
                            {error}
                        </div>
                    )}
                    {paths.length === 0 ? (
                        <p className="px-2 py-4 text-xs text-muted">
                            {t('editor.recentWorkingFiles.empty')}
                        </p>
                    ) : (
                        <ul className="max-h-72 overflow-y-auto py-1">
                            {paths.map((path) => (
                                <li key={path}>
                                    <button
                                        type="button"
                                        title={path}
                                        aria-label={t('editor.recentWorkingFiles.reopen', {path})}
                                        onClick={() => void reopen(path)}
                                        className="group flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                    >
                                        <span className="min-w-0 flex-1 break-all text-xs text-primary">
                                            {path}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}
        </div>
    );
}
