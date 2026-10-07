export const USER_AGENT = "NYCFieldFinder/0.1 (https://github.com/jacobwolf-1/NYC-Field-Finder)";

// Serialize availability cache misses across searches and expanded rows.
let pending: Promise<unknown> = Promise.resolve();
export function politeRequest<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, 200)));
  return result;
}
