import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ APP_ENV: "production", BLOB_PROVIDER: "mock" }));
vi.mock("@/server/lib/env", () => ({ env: settings }));

import { createBlobStore } from "./factory";
import { MockBlobStore } from "./mock";

afterEach(() => { settings.APP_ENV = "production"; });

describe("standalone Blob construction", () => {
  it("refuses a production local store even without the full provider registry", () => {
    expect(() => createBlobStore()).toThrow("Production requires non-mock providers: BLOB_PROVIDER");
  });

  it.each(["development", "test"])("retains the local store in %s", appEnv => {
    settings.APP_ENV = appEnv;
    expect(createBlobStore()).toBeInstanceOf(MockBlobStore);
  });
});
