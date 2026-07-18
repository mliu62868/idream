import { env } from "./env";
import { syncComfyUiWorkflow } from "./backend/comfyui-workflow";
import { loadWorkflowDescriptors } from "./backend/workflow";

const descriptors = await loadWorkflowDescriptors(env.GEN_WORKFLOW_DIR, {
  onSkip: (file, error) => console.warn(`Skipping ${file}: ${error}`),
});
const comfyDescriptors = descriptors.filter((descriptor) => descriptor.backendKind === "comfyui");

for (const descriptor of comfyDescriptors) {
  await syncComfyUiWorkflow({
    apiUrl: env.COMFYUI_API_URL,
    descriptor,
    timeoutMs: 30_000,
  });
  console.log(`Synced ${descriptor.comfyWorkflow.name} (${descriptor.comfyWorkflow.id})`);
}

console.log(`Synced ${comfyDescriptors.length} ComfyUI workflows.`);
