import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import projectsRouter from './routes/projects.js';
import filesRouter from './routes/files.js';
import deployRouter from './routes/deploy.js';
import annotationsRouter from './routes/annotations.js';
import plansRouter from './routes/plans.js';
import { isBlobMode } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Express 4 does not forward rejections from async route handlers to the error
 * middleware — an unhandled rejection leaves the response hanging (HTTP 000).
 * Wrap every route handler so rejections go to next(err) -> the 500 handler.
 */
function wrapAsyncHandlers(router) {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const h of layer.route.stack || []) {
      const fn = h.handle;
      // Skip error handlers (4-arg signature).
      if (typeof fn !== 'function' || fn.length >= 4) continue;
      h.handle = (req, res, next) => {
        try {
          return Promise.resolve(fn(req, res, next)).catch(next);
        } catch (e) {
          next(e);
        }
      };
    }
  }
  return router;
}

function resolveFrontendBuild() {
  // Root build output (frontend/vite.config.js -> ../dist)
  const rootDist = path.join(__dirname, '..', '..', 'dist');
  if (fs.existsSync(rootDist)) return rootDist;
  // Legacy location
  const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) return frontendDist;
  return null;
}

/**
 * Create the Express application (shared by the local server and the
 * EdgeOne Makers Cloud Functions framework entry).
 *
 * @param {{makersPrefix?: string}} [opts] makersPrefix re-attaches a route
 *   prefix that the EdgeOne framework dispatch stripped. EdgeOne's framework
 *   mode computes the sub-path by consuming the static segments of the route
 *   pattern: a request to /api/health routed via /api/:default* arrives at
 *   the app as /health. Since this app mounts its API under /api/*, the entry
 *   passes makersPrefix:'/api' so the prefix is restored before route matching.
 */
export function createApp({ makersPrefix } = {}) {
  // Indirection below keeps EdgeOne's framework detector from classifying
  // this file as an Express framework function: it matches `const X = express()`
  // (callee named "express"), which would route us into the broken framework
  // pipeline. `const factory = express; const app = factory()` is not matched.
  const expressFactory = express;
  const app = expressFactory();
  // In EdgeOne Makers Cloud Functions mode static assets are served by the
  // platform itself; the function only handles API + preview routes.
  const blobMode = isBlobMode();

  // Trust the platform's forwarding headers so req.protocol/host reflect the
  // public URL (the in-process onRequest adapter forwards Host + X-Forwarded-Proto).
  app.set('trust proxy', true);

  // MUST be registered before any route: restore the prefix stripped by the
  // framework dispatch (see comment on createApp options).
  if (makersPrefix) {
    app.use((req, res, next) => {
      const p = req.url;
      if (p !== '/' && !p.startsWith(makersPrefix + '/')) {
        req.url = makersPrefix + p;
      }
      next();
    });
  }

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes (wrapped so async rejections become 500s instead of hanging)
  app.use('/api/projects', wrapAsyncHandlers(projectsRouter));
  app.use('/api/projects', wrapAsyncHandlers(filesRouter));      // /api/projects/:id/preview/* etc.
  app.use('/api/projects', wrapAsyncHandlers(deployRouter));      // /api/projects/:id/deploy
  app.use('/api/projects', wrapAsyncHandlers(annotationsRouter)); // /api/projects/:id/annotations
  app.use('/api/projects', wrapAsyncHandlers(plansRouter));       // /api/projects/:id/plan + /api/plans/:planId

  // Serve frontend build (local server only; Makers serves static itself)
  if (!blobMode) {
    const frontendBuild = resolveFrontendBuild();
    if (frontendBuild) {
      app.use(express.static(frontendBuild));
      // SPA fallback
      app.get('*', (req, res) => {
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'API endpoint not found' });
        }
        res.sendFile(path.join(frontendBuild, 'index.html'));
      });
    } else {
      // Dev mode - frontend runs on separate port
      app.get('/', (req, res) => {
        res.json({
          name: 'Prototype Review Platform API',
          status: 'running',
          mode: 'development',
          frontend: 'Run frontend dev server (cd frontend && npm run dev)',
          docs: '/api/health'
        });
      });
    }
  } else {
    // Makers mode: the function is mounted at /express (static assets at root
    // are served by the platform, which takes priority over function routes).
    app.get('/', (req, res) => {
      res.json({
        name: 'ProtoBuddy API',
        status: 'running',
        mode: 'edgeone-makers',
        health: '/express/api/health'
      });
    });
    // Unknown non-static paths are 404 (HashRouter avoids deep links)
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}
