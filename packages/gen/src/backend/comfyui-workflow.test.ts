import { beforeEach, describe, expect, it, vi } from "vitest";
import { workflowDescriptorSchema } from "./workflow";
import { buildComfyUiWorkflow, syncComfyUiWorkflow } from "./comfyui-workflow";

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "test-t2i",
  modelId: "test-model",
  backendKind: "comfyui",
  comfyWorkflow: { id: "11111111-1111-4111-8111-111111111111", name: "iDream: Test/T2I" },
  version: 2,
  capabilities: ["textToImage"],
  apiPrompt: {
    "1": { class_type: "ModelLoader", inputs: { model_name: "model.safetensors" } },
    "2": { class_type: "Sampler", inputs: { model: ["1", 0], seed: 42, steps: 8 } },
  },
  inputs: [],
});
if (descriptor.backendKind !== "comfyui") throw new Error("expected ComfyUI descriptor");

const objectInfo = {
  ModelLoader: {
    input: { required: { model_name: [["model.safetensors"]] } },
    input_order: { required: ["model_name"] },
    output: ["MODEL"],
    output_name: ["MODEL"],
  },
  Sampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT", { default: 0, control_after_generate: true }],
        steps: ["INT", { default: 20 }],
      },
    },
    input_order: { required: ["model", "seed", "steps"] },
    output: ["LATENT"],
    output_name: ["LATENT"],
  },
};

describe("ComfyUI visible workflow sync", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("builds a loadable UI graph with stable identity, widgets, and links", () => {
    const workflow = buildComfyUiWorkflow(descriptor, objectInfo) as {
      id: string;
      revision: number;
      nodes: Array<{ id: number; inputs: Array<{ name: string; link: number | null }>; widgets_values: unknown[] }>;
      links: unknown[];
      extra: { idream: { name: string; workflowKey: string } };
    };
    expect(workflow.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(workflow.revision).toBe(1);
    expect(workflow.links).toHaveLength(1);
    expect(workflow.nodes[1].inputs.map((input) => input.name)).toEqual(["model", "seed", "steps"]);
    expect(workflow.nodes[1].inputs[0].link).toBe(1);
    expect(workflow.nodes[1].widgets_values).toEqual([42, "fixed", 8]);
    expect(workflow.extra.idream).toMatchObject({ name: "iDream: Test/T2I", workflowKey: "test-t2i" });
  });

  it("stores the graph in ComfyUI's workflows userdata directory", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(objectInfo), { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const workflow = await syncComfyUiWorkflow({
      apiUrl: "http://comfy/",
      descriptor,
      timeoutMs: 5_000,
    });

    expect(workflow.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://comfy/object_info");
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/userdata/workflows%2FiDream_%20Test_T2I.json?overwrite=true",
    );
    const saved = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(saved.nodes).toHaveLength(2);
    expect(saved.id).toBe(descriptor.comfyWorkflow.id);
  });
});
