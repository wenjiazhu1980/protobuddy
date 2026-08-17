import { createApp } from './app.js';

const app = createApp();
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Prototype Review Platform Backend`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Storage driver: ${process.env.STORAGE_DRIVER === 'blob' ? 'Blob (Makers)' : 'local JSON files'}`);
  console.log(`========================================\n`);
});
