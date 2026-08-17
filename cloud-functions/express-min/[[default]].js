/**
 * Minimal Express framework function — diagnostic only.
 *
 * If /express-min/api/health responds, framework mode works and the earlier
 * hang was caused by the full 7.6MB backend bundle (boot/init issue).
 * If it also hangs, the framework-mode pipeline itself is broken on this
 * platform/project, and we must avoid bundling express at all.
 */
import express from 'express';

const app = express();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', minimal: true, time: new Date().toISOString() });
});

export default app;
