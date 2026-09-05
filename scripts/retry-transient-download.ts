export class RetryableDownloadError extends Error {}

export async function retryTransientDownload<T>(
  operation: () => Promise<T>,
  options: {
    maximumAttempts: number;
    wait?: (milliseconds: number) => Promise<void>;
  },
): Promise<T> {
  if (!Number.isSafeInteger(options.maximumAttempts) || options.maximumAttempts < 1) {
    throw new Error("Download retry count must be a positive integer");
  }
  const wait = options.wait ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RetryableDownloadError) ||
        attempt === options.maximumAttempts) {
        throw error;
      }
      await wait(attempt * 500);
    }
  }
  throw new Error("Download retry loop ended unexpectedly");
}
