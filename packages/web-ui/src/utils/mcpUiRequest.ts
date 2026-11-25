export async function executeClaimedUiRequest<T>(
    claim: () => Promise<boolean>,
    execute: () => Promise<T>,
): Promise<T | undefined> {
    if (!(await claim())) return undefined;
    return execute();
}
