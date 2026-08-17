/**
 * Minimal diagnostic Cloud Function (plain onRequest mode).
 *
 * Purpose: isolate whether the EdgeOne Makers function RUNTIME works for
 * this project at all. If /ping returns JSON while /express/* hangs, the
 * problem is the framework-mode pipeline, not the runtime. If /ping ALSO
 * hangs, the runtime/deployment itself is broken.
 *
 * Plain-function contract (verified from the CLI bundle):
 *   export async function onRequest(context) -> Response
 *   context.request is a web Request; return a web Response.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  return new Response(
    JSON.stringify({
      status: 'ok',
      ping: true,
      path: url.pathname,
      time: new Date().toISOString(),
      env: {
        node: process.version,
        storage: process.env.STORAGE_DRIVER || '(unset)'
      }
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
}
