import { describe, expectTypeOf, it } from "vitest";
import type { GenerationProfileSelectionInput } from "./generation-profile-selection";

describe("generation profile selection input", () => {
  it("represents every supported catalog scope and excludes public video scopes", () => {
    expectTypeOf<{
      mode: "image";
      catalogScope: "executable";
    }>().toMatchTypeOf<GenerationProfileSelectionInput>();
    expectTypeOf<{
      mode: "image";
      catalogScope: "public_text_to_image";
    }>().toMatchTypeOf<GenerationProfileSelectionInput>();
    expectTypeOf<{
      mode: "image";
      catalogScope: "public_image_edit";
    }>().toMatchTypeOf<GenerationProfileSelectionInput>();
    expectTypeOf<{
      mode: "video";
      catalogScope: "executable";
    }>().toMatchTypeOf<GenerationProfileSelectionInput>();
    expectTypeOf<{
      mode: "video";
      catalogScope: "public_image_edit";
    }>().not.toMatchTypeOf<GenerationProfileSelectionInput>();
  });
});
