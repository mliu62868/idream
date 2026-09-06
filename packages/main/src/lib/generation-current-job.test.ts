import { describe, expect, it } from "vitest";
import { readCurrentGenerationJob, saveCurrentGenerationJob } from "./generation-current-job";

function tabStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); } };
}

describe("the current generation request", () => {
  it("restores a tab's own job after reload without selecting another tab's latest job", () => {
    const videoTab = tabStorage();
    const imageTab = tabStorage();
    saveCurrentGenerationJob(videoTab, "owner-a", "video-job");
    saveCurrentGenerationJob(imageTab, "owner-a", "image-job");
    expect(readCurrentGenerationJob(videoTab, "owner-a")).toBe("video-job");
    expect(readCurrentGenerationJob(imageTab, "owner-a")).toBe("image-job");
  });

  it("does not restore private work for a different viewer or turn history into the current request", () => {
    const storage = tabStorage();
    expect(readCurrentGenerationJob(storage, "owner-a")).toBeNull();
    saveCurrentGenerationJob(storage, "owner-a", "private-job");
    expect(readCurrentGenerationJob(storage, "owner-b")).toBeNull();
  });

  it("keeps generation usable when storage fails", () => {
    const storage = { getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("quota exceeded"); } };
    expect(readCurrentGenerationJob(storage, "owner-a")).toBeNull();
    expect(() => saveCurrentGenerationJob(storage, "owner-a", "job")).not.toThrow();
  });
});
