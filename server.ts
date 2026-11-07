// Loaded before every other module, since several read their settings from .env as they load
import 'dotenv/config';
import { createApp } from './server/app.js';
import { config } from './server/config.js';
import { getConnection } from './server/google.js';
import { syncVault } from './server/pipeline.js';
import { configProblems } from './server/roles.js';

// Settings that would open a door, or send traffic to the wrong place, stop the server before it serves anything
const problems = configProblems();
if (problems.length) {
  for (const problem of problems) console.error(`Paperwork can't start: ${problem}`);
  process.exit(1);
}

// Locally a timer stands in for Cloud Scheduler (Cloud Run sets K_SERVICE; its instances sleep between requests).
// The public edge never files.
if (!process.env.K_SERVICE && process.env.NODE_ENV !== 'test' && config.role !== 'edge') {
  setInterval(async () => {
    const connection = await getConnection().catch(() => null);
    if (connection && !connection.broken) syncVault('schedule').catch(err => console.error('Scheduled filing failed:', err));
  }, 5 * 60 * 1000);
}

async function startServer() {
  const app = await createApp(config.role, { client: config.isProduction ? 'dist' : 'vite' });
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Paperwork running on http://0.0.0.0:${config.port}${config.role === 'all' ? '' : ` as the ${config.role}`}`);
  });
}

startServer();
