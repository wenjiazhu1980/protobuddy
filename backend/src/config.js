/**
 * Shared runtime configuration.
 *
 * The storage driver is read LAZILY (at call time) instead of at module load,
 * so the EdgeOne Makers Cloud Functions entry can set STORAGE_DRIVER=blob in
 * its module body before creating the Express app, without relying on ESM
 * import evaluation order.
 */
export function isBlobMode() {
  return process.env.STORAGE_DRIVER === 'blob';
}

export function storageDriver() {
  return process.env.STORAGE_DRIVER || 'local';
}
