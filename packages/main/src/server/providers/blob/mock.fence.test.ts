import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBlobStore } from "./mock";

let root: string;
let previousRoot: string | undefined;
beforeEach(async () => {
  previousRoot = process.env.BLOB_ROOT;
  root = await mkdtemp(path.join(tmpdir(), "idream-fenced-blob-test-"));
  process.env.BLOB_ROOT = root;
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.BLOB_ROOT;
  else process.env.BLOB_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
  await rm(`${root}-old`, { recursive: true, force: true });
});

describe("local import write fencing", () => {
  it("pins the storage directory identity and detects replacement at the same path", async () => {
    const store = new MockBlobStore();
    const original = store.getFencedStorageAuthority();
    expect(store.getFencedStorageAuthority()).toBe(original);
    await rename(root, `${root}-old`);
    await mkdir(root);
    expect(store.getFencedStorageAuthority()).not.toBe(original);
  });

  it("does not recreate the user's bytes when delete wins before a delayed conditional PUT", async () => {
    const store = new MockBlobStore();
    const marker = await store.prepareFencedPut({ key: "attempt/one" });
    if (!marker.ok) throw new Error("Could not prepare test marker");
    await expect(store.deleteFenced({ key: "attempt/one" })).resolves.toEqual({ ok: true, data: { deleted: true } });
    const late = await store.putPrivateFenced({ key: "attempt/one", body: new Uint8Array([1, 2, 3]), contentType: "image/png", markerEtag: marker.data.markerEtag });
    expect(late.ok).toBe(false);
    await expect(readFile(path.join(root, "attempt/one"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing key when reserving a fresh marker", async () => {
    const store = new MockBlobStore();
    await store.putPrivate({ key: "attempt/one", body: new Uint8Array([7]), contentType: "image/png" });
    expect((await store.prepareFencedPut({ key: "attempt/one" })).ok).toBe(false);
    expect(await readFile(path.join(root, "attempt/one"))).toEqual(Buffer.from([7]));
  });
});
