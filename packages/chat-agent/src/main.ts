import "dotenv/config";
import { CompanionEngine } from "./engine";
import { loadSidecarConfig } from "./config";
import { IgrepMemoryProbe, IgrepMemoryRebuilder, loadIgrepPlugin } from "./igrep";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import { createReadinessProbe } from "./readiness";
import { createCompanionServer } from "./server";
import { AttemptWorkspaceStore } from "./workspace";

const config = loadSidecarConfig();
const plugin = Promise.resolve().then(() => loadIgrepPlugin(config.igrepPluginUrl));
const workspaces = new AttemptWorkspaceStore({
  canonicalRoot: config.canonicalRoot,
  privateRoot: config.privateRoot,
  memoryProbe: new IgrepMemoryProbe(config.igrepCommand),
});
const engine = new CompanionEngine({
  workspaces,
  plugin: async () => (await plugin).module,
  adapter: (profile) => new OpenAiCompatibleAdapter({
    profile,
    apiKey: config.providerApiKey,
    openRouterProviderOnly: config.openRouterProviderOnly,
  }),
  igrepCommand: config.igrepCommand,
  rebuilder: new IgrepMemoryRebuilder(config.igrepCommand),
  maxSteps: config.maxSteps,
});
const server = createCompanionServer({
  authToken: config.authToken,
  readiness: createReadinessProbe({ config, plugin: () => plugin }),
  invocation: engine,
});

server.http.listen(config.port, config.host, () => {
  process.stdout.write(`dsh companion listening on http://${config.host}:${config.port}\n`);
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
