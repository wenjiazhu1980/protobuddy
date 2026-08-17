/**
 * ProtoBuddy API — EdgeOne Makers Cloud Function (framework mode).
 *
 * EdgeOne classifies ANY function whose bundle imports express as an Express
 * FRAMEWORK function. Framework dispatch requires the module's DEFAULT export
 * to be the Express app — a bare `export default createApp()` is even skipped
 * by the function scanner, and a module that only exports `onRequest` is
 * wrapped but the dispatch falls through (app == undefined) and requests hang.
 *
 * So the contract here is: default export = Express app, mounted at /api.
 * The platform computes the sub-path itself by stripping the route's static
 * prefix (/api/:default* -> /api/health arrives at the app as /health), so
 * createApp() is told makersPrefix:'/api' to re-attach it before routing.
 *
 * STORAGE_DRIVER=blob switches db + file storage onto @edgeone/pages-blob.
 * An externally-set STORAGE_DRIVER (e.g. STORAGE_DRIVER=local in the dev
 * runner) is respected so the full API can be exercised locally; the deployed
 * function defaults to blob.
 */
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'blob';

import { createApp } from '../../backend/src/app.js';

const app = createApp({ makersPrefix: '/api' });

export default app;
