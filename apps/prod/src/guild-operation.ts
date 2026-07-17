export type ExecuteGuildOperation = <Value>(
  guildId: string,
  task: () => Promise<Value>,
) => Promise<Value>;

export const createGuildOperationExecutor = (): ExecuteGuildOperation => {
  const tails = new Map<string, Promise<void>>();
  return async <Value>(
    guildId: string,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = tails.get(guildId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    tails.set(guildId, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (tails.get(guildId) === tail) tails.delete(guildId);
    }
  };
};
