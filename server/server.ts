// server/server.ts — Lakebase only. Every read and write goes to Lakebase; the e-mail drafts call a
// Claude model through the Unity AI Gateway model service bound as MODEL_SERVICE (server/lib/llm.ts).
import { createApp, genie, lakebase, server } from '@databricks/appkit';
import { bootstrap } from './lib/bootstrap';
import { setDb } from './lib/db';
import { registerRoutes } from './routes/api';

// Genie is optional: local dev and deploys without a space still boot, and the UI says it is not configured.
const genieSpaceId = process.env.DATABRICKS_GENIE_SPACE_ID;

createApp({
  plugins: [server(), lakebase(), ...(genieSpaceId ? [genie({ spaces: { default: genieSpaceId } })] : [])],
  async onPluginsReady(appkit) {
    setDb(appkit.lakebase);
    await bootstrap();
    appkit.server.extend((app) => registerRoutes(app));
  },
}).catch(console.error);
