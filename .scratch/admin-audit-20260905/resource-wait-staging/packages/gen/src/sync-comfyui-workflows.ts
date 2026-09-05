import { env } from "./env";
import { syncComfyUiWorkflow } from "./backend/comfyui-workflow";
import { loadWorkflowDescriptors } from "./backend/workflow";
import { comfyUiRunnerForDescriptor } from "./backend/registry";

const descriptors = await loadWorkflowDescriptors(env.GEN_WORKFLOW_DIR, {
  onSkip: (file, error) => console.warn(`Skipping ${file}: ${error}`),
});
const comfyDescriptors = descriptors.filter((descriptor) => descriptor.backendKind === "comfyui");

for (const descriptor of comfyDescriptors) {
  const runner = comfyUiRunnerForDescriptor(descriptor);
  await syncComfyUiWorkflow({
    apiUrl: runner === "image"
      ? env.COMFYUI_IMAGE_API_URL
      : runner === "video-h3"
        ? env.COMFYUI_H3_API_URL
        : env.COMFYUI_VIDEO_API_URL,
    descriptor,
    timeoutMs: 30_000,
  });
  console.log(
    `Synced ${descriptor.comfyWorkflow.name} (${descriptor.comfyWorkflow.id}) to ${runner} runner`,
  );
}

console.log(`Synced ${comfyDescriptors.length} ComfyUI workflows.`);
