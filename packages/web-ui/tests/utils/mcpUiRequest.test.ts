import {describe, expect, it, vi} from 'vitest';
import {executeClaimedUiRequest} from '@/utils/mcpUiRequest';

describe('executeClaimedUiRequest', () => {
    it('does not perform a UI or SQL action when another listener claimed the request', async () => {
        const execute = vi.fn(async () => 'executed');
        await expect(executeClaimedUiRequest(async () => false, execute)).resolves.toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
    });

    it('waits for ownership before performing exactly one action', async () => {
        let resolve!: (claimed: boolean) => void;
        const ownership = new Promise<boolean>((settle) => {
            resolve = settle;
        });
        const execute = vi.fn(async () => 'visible result');
        const operation = executeClaimedUiRequest(() => ownership, execute);
        expect(execute).not.toHaveBeenCalled();
        resolve(true);
        await expect(operation).resolves.toBe('visible result');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('does not perform the action when accepting ownership fails', async () => {
        const execute = vi.fn(async () => undefined);
        await expect(
            executeClaimedUiRequest(async () => {
                throw new Error('request disappeared');
            }, execute),
        ).rejects.toThrow('request disappeared');
        expect(execute).not.toHaveBeenCalled();
    });
});
