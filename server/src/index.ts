import http from "node:http";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { getAiSettings, keyConfigured } from "./services/settings.js";

const app = createApp();
const server = http.createServer(app);
initSocket(server);

server.listen(env.port, async () => {
  const ai = await getAiSettings().catch(() => null);
  const demo = !ai || ai.forceDemo || !keyConfigured(ai.provider);
  console.log(`RoboLearn API listening on http://localhost:${env.port}`);
  console.log(`AI: ${demo ? "DEMO MODE (no API key configured - results are simulated)" : `${ai!.provider} enabled`}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
