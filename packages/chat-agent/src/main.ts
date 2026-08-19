import "dotenv/config";
import { COMPANION_IGREP_VERSION } from "@idream/shared/chat/companion-runtime";
import { CompanionEngine } from "./engine";
import { loadSidecarConfig } from "./config";
import {
  IgrepLegacyMemoryImporter,
  IgrepMemoryProbe,
  IgrepMemoryRebuilder,
  loadIgrepPlugin,
} from "./igrep";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import { createReadinessProbe, probeWorkspaceRebuild } from "./readiness";
import { createCompanionServer } from "./server";
import { AttemptWorkspaceStore } from "./workspace";

const config = loadSidecarConfig();
const plugin = Promise.resolve().then(() => loadIgrepPlugin(config.igrepPluginUrl));
const workspaces = new AttemptWorkspaceStore({
  canonicalRoot: config.canonicalRoot,
  shadowRoot: config.shadowRoot,
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
  legacyImporter: new IgrepLegacyMemoryImporter(
    config.igrepCommand,
    COMPANION_IGREP_VERSION,
  ),
  maxSteps: config.maxSteps,
});
const server = createCompanionServer({
  authToken: config.authToken,
  readiness: createReadinessProbe({
    config,
    plugin: () => plugin,
    workspaceRebuildProbe: () => probeWorkspaceRebuild(engine),
  }),
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
