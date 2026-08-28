import "dotenv/config";
import { CompanionEngine } from "./engine";
import { bindIgrepLlmEnvironment, loadSidecarConfig } from "./config";
import {
  IgrepMemoryProbe,
  IgrepMemoryRebuilder,
  loadIgrepPlugin,
} from "./igrep";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import { createReadinessProbe, probeWorkspaceRebuild } from "./readiness";
import { createCompanionServer } from "./server";
import { createSidecarInstanceIdentity } from "./sidecar-instance";
import { AttemptWorkspaceStore } from "./workspace";

const config = loadSidecarConfig();
bindIgrepLlmEnvironment(config.igrepLlm);
const instance = createSidecarInstanceIdentity();
const plugin = Promise.resolve().then(() => loadIgrepPlugin(config.igrepPluginUrl));
const workspaces = new AttemptWorkspaceStore({
  canonicalRoot: config.canonicalRoot,
  privateRoot: config.privateRoot,
  memoryProbe: new IgrepMemoryProbe(config.igrepCommand),
});
const engine = new CompanionEngine({
  instance,
  workspaces,
  plugin: async () => (await plugin).module,
  adapter: (profile) => new OpenAiCompatibleAdapter({
    profile,
    apiKey: config.providerApiKey,
    openRouterProviderOnly: config.openRouterProviderOnly,
  }),
  igrepCommand: config.igrepCommand,
  igrepLlm: config.igrepLlm,
  rebuilder: new IgrepMemoryRebuilder(config.igrepCommand),
  maxSteps: config.maxSteps,
  maxConcurrentAgents: config.maxConcurrentAgents,
});
const server = createCompanionServer({
  authToken: config.authToken,
  hostname: config.host,
  port: config.port,
  readiness: createReadinessProbe({
    config,
    instance,
    plugin: () => plugin,
    workspaceRebuildProbe: () => probeWorkspaceRebuild(engine),
  }),
  invocation: engine,
});

process.stdout.write(`dsh companion listening on ${server.http.url.origin}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
