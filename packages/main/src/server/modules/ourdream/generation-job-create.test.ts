import { describe, expect, it } from "vitest";
import { generationJobSchema } from "./generation-request-schema";
import { fitChatImageRequestToRoute } from "./generation-job-create";

const chatRoute = { maxCount: 1, allowedOrientations: ["4:5", "16:9"] };

describe("fitChatImageRequestToRoute", () => {
  it("turns a companion's 'a few square pics' into what the chat route delivers", () => {
    const body = generationJobSchema.parse({ characterId: "c1", prompt: "Selfie", orientation: "1:1", outputCount: 3, controls: { orientation: "1:1" } });
    const fitted = fitChatImageRequestToRoute(body, chatRoute);
    expect(fitted).toMatchObject({ outputCount: 1, orientation: "4:5", controls: { orientation: "4:5" } });
  });

  it("keeps a supported request unchanged", () => {
    const body = generationJobSchema.parse({ characterId: "c1", prompt: "Beach", orientation: "16:9", outputCount: 1, controls: { orientation: "16:9" } });
    expect(fitChatImageRequestToRoute(body, chatRoute)).toEqual(body);
  });
});
