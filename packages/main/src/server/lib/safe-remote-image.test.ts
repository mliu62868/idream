import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { isPublicRemoteImageAddress, readRemoteImage, withRemoteImageValidationLimit } from "./safe-remote-image";

type Spec = { status?: number; headers?: Record<string, string>; chunks?: Buffer[] };
function dns(name: string, type: 1 | 28, answer: Array<{ name: string; type: number; data: string }> = [], extra: Record<string, unknown> = {}): Spec {
  return { chunks: [Buffer.from(JSON.stringify({ Status: 0, TC: false, Question: [{ name: `${name}.`, type }], Answer: answer, ...(answer.length ? {} : { Authority: [{ name: `${name}.`, type: 6 }] }), ...extra }))] };
}
function respond(...specs: Spec[]) {
  const remaining = [...specs];
  mocks.request.mockImplementation((_url, _options, callback) => {
    const spec = remaining.shift();
    if (!spec) throw new Error("Unexpected request");
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => callback(Object.assign(Readable.from(spec.chunks ?? [Buffer.from("image")]), {
      statusCode: spec.status ?? 200, headers: spec.headers ?? {},
    })));
    return req;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

describe("safe remote image fetching", () => {
  it("bounds fetch and decode work and releases slots after success or failure", async () => {
    const release: Array<() => void> = [];
    const held = Array.from({ length: 2 }, () => withRemoteImageValidationLimit(() => new Promise<void>(resolve => { release.push(resolve); })));
    await expect(withRemoteImageValidationLimit(async () => undefined)).rejects.toMatchObject({ code: "unavailable" });
    release[0]!();
    await held[0];
    await expect(withRemoteImageValidationLimit(async () => { throw new Error("bad pixels"); })).rejects.toThrow("bad pixels");
    await expect(withRemoteImageValidationLimit(async () => "ready")).resolves.toBe("ready");
    release[1]!();
    await held[1];
  });
  it.each([
    "127.0.0.1", "0.0.0.1", "10.1.2.3", "169.254.169.254", "172.31.0.1",
    "192.168.1.5", "100.64.0.2", "198.18.1.1", "224.0.0.1", "255.255.255.255",
    "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1", "2002:0808:0808::1", "3ffe::1",
  ])("rejects non-public address %s", address => expect(isPublicRemoteImageAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", address => expect(isPublicRemoteImageAddress(address)).toBe(true));
  it("rejects private literals, URL credentials and mixed DNS before connecting", async () => {
    await expect(readRemoteImage("http://127.0.0.1/image")).rejects.toMatchObject({ code: "conflict" });
    await expect(readRemoteImage("https://user:pass@example.org/image")).rejects.toMatchObject({ code: "conflict" });
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("pins the verified DNS address while retaining hostname and reads bytes", async () => {
    respond({ headers: { "content-type": "image/png" }, chunks: [Buffer.from("abc"), Buffer.from("def")] });
    const result = await readRemoteImage("https://example.org/image");
    expect(Buffer.from(result.bytes).toString()).toBe("abcdef");
    expect(result.contentType).toBe("image/png");
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.hostname).toBe("example.org");
    let pinned: unknown;
    options.lookup("example.org", {}, (_error: unknown, address: string, family: number) => { pinned = { address, family }; });
    expect(pinned).toEqual({ address: "8.8.8.8", family: 4 });
    options.lookup("example.org", { all: true }, (_error: unknown, addresses: unknown) => { pinned = addresses; });
    expect(pinned).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
  it("uses authenticated pinned public DNS only for an all-fake-IP result", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.12", family: 4 }]);
    respond(dns("example.org", 1, [{ name: "example.org.", type: 1, data: "8.8.4.4" }]), dns("example.org", 28), { chunks: [Buffer.from("public image")] });
    expect(Buffer.from((await readRemoteImage("https://example.org/image")).bytes).toString()).toBe("public image");
    expect(mocks.request).toHaveBeenCalledTimes(3);
    for (const [url, options] of mocks.request.mock.calls.slice(0, 2)) {
      expect(url.hostname).toBe("dns.google");
      expect(options.headers.accept).toBe("application/dns-json");
      let address: unknown;
      options.lookup("dns.google", {}, (_error: unknown, ip: string) => { address = ip; });
      expect(address).toBe("8.8.8.8");
    }
    const [url, options] = mocks.request.mock.calls[2]!;
    let address: unknown;
    options.lookup("example.org", {}, (_error: unknown, ip: string) => { address = ip; });
    expect(url.hostname).toBe("example.org");
    expect(address).toBe("8.8.4.4");
  });
  it("does not use public DNS for fake-IP literals, mixed or internal names", async () => {
    await expect(readRemoteImage("http://198.18.1.2/image")).rejects.toMatchObject({ code: "conflict" });
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.12", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.12", family: 4 }]);
    for (const host of ["localhost", "printer", "printer.lan", "server.home.arpa", "service.local"]) {
      await expect(readRemoteImage(`https://${host}/image`)).rejects.toMatchObject({ code: "conflict" });
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects private DNS-over-HTTPS answers and malformed or truncated replies", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.12", family: 4 }]);
    respond(dns("example.org", 1, [{ name: "example.org.", type: 1, data: "8.8.4.4" }]), dns("example.org", 28, [{ name: "example.org.", type: 28, data: "fc00::1" }]));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
    respond(dns("example.org", 1, [], { TC: true }), dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    respond(dns("example.org", 1, [], { Question: [{ name: "elsewhere.org.", type: 1 }] }), dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    respond({ headers: { "content-length": "65537" } }, dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.request).toHaveBeenCalledTimes(8);
  });
  it("accepts only a complete CNAME chain and rejects unrelated or looping answers", async () => {
    mocks.lookup.mockResolvedValue([{ address: "198.18.0.12", family: 4 }]);
    const cname = { name: "example.org.", type: 5, data: "cdn.example.org." };
    const terminal = { name: "cdn.example.org.", type: 1, data: "8.8.4.4" };
    respond(dns("example.org", 1, [cname, terminal]), dns("example.org", 28), { chunks: [Buffer.from("ok")] });
    expect(Buffer.from((await readRemoteImage("https://example.org/image")).bytes).toString()).toBe("ok");
    respond(dns("example.org", 1, [cname, terminal]), dns("example.org", 28, [cname], { Authority: [{ name: "example.org.", type: 6 }] }), { chunks: [Buffer.from("nodata")] });
    expect(Buffer.from((await readRemoteImage("https://example.org/image")).bytes).toString()).toBe("nodata");
    respond(dns("example.org", 1, [cname]), dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    respond(dns("example.org", 1, [cname], { Authority: [{ name: "unrelated.org.", type: 6 }] }), dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    respond(dns("example.org", 1, [cname, terminal, { name: "other.org.", type: 1, data: "1.1.1.1" }]), dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    respond(dns("example.org", 1, [cname, { name: "cdn.example.org.", type: 5, data: "example.org." }]), dns("example.org", 28));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
  });
  it("checks every redirect before making the next request", async () => {
    respond({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("resolves and pins a public redirect to its own checked address", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }]);
    respond({ status: 302, headers: { location: "https://cdn.example.org/image" } }, { chunks: [Buffer.from("ok")] });
    expect(Buffer.from((await readRemoteImage("https://example.org/image")).bytes).toString()).toBe("ok");
    const [url, options] = mocks.request.mock.calls[1]!;
    let pinned: unknown;
    options.lookup("cdn.example.org", {}, (_error: unknown, address: string, family: number) => { pinned = { address, family }; });
    expect(url.hostname).toBe("cdn.example.org");
    expect(pinned).toEqual({ address: "1.1.1.1", family: 4 });
  });
  it("rejects excessive redirects and oversized declared or streamed bodies", async () => {
    respond(...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/next" } })));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
    respond({ headers: { "content-length": String(64 * 1024 * 1024 + 1) } });
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
    respond({ chunks: Array.from({ length: 65 }, () => Buffer.alloc(1024 * 1024)) });
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "conflict" });
  });
  it("reports temporary DNS and remote failures as unavailable", async () => {
    mocks.lookup.mockRejectedValueOnce(new Error("DNS unavailable"));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    respond({ status: 503 });
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
  });
  it("tries a second checked address when the first connection fails", async () => {
    mocks.lookup.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }, { address: "1.1.1.1", family: 4 }]);
    respond({ chunks: [Buffer.from("ok")] });
    const goodRequest = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce(() => {
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () => queueMicrotask(() => req.emit("error", new Error("network unreachable")));
      return req;
    }).mockImplementation(goodRequest);
    expect(Buffer.from((await readRemoteImage("https://example.org/image")).bytes).toString()).toBe("ok");
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it("bounds a stalled DNS lookup by the total timeout", async () => {
    let finish!: (value: Array<{ address: string; family: number }>) => void;
    mocks.lookup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await expect(readRemoteImage("https://example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.request).not.toHaveBeenCalled();
    finish([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
  }, 12_000);
  it("bounds unresolved OS DNS work instead of queuing unbounded lookups", async () => {
    const finish: Array<(reason: Error) => void> = [];
    mocks.lookup.mockImplementation(() => new Promise((_resolve, reject) => { finish.push(reject); }));
    const pending = Array.from({ length: 32 }, (_, index) => readRemoteImage(`https://host${index}.example.org/image`).catch(error => error));
    await expect(readRemoteImage("https://overflow.example.org/image")).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.lookup).toHaveBeenCalledTimes(32);
    finish.forEach(reject => reject(new Error("DNS unavailable")));
    await Promise.all(pending);
  });
});
