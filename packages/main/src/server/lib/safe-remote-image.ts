import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import sharp from "sharp";
import { AppError, Errors } from "@/server/lib/errors";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_PENDING_DNS = 32;
const MAX_PENDING_DOH = 16;
const MAX_DOH_BYTES = 64 * 1024;
let pendingDns = 0;
let pendingDoh = 0;
let activeRemoteValidations = 0;

/** Bound remote download and full image decode together; never queue unbounded work. */
export async function withRemoteImageValidationLimit<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRemoteValidations >= 2) throw Errors.unavailable("Source image retrieval is busy. Please try again.");
  activeRemoteValidations += 1;
  try { return await operation(); }
  finally { activeRemoteValidations -= 1; }
}

/** Decode untrusted image bytes fully before using or serving them. */
export async function verifySourceImageBytes(bytes: Uint8Array, sourceImageAssetId?: string) {
  const startedAt = performance.now();
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000, animated: true }).timeout({ seconds: 10 });
    const metadata = await image.metadata();
    if (performance.now() - startedAt >= 10_000) throw Errors.unavailable("Reference image verification timed out. Please try again.");
    const supported = ["png", "jpeg", "webp", "gif", "tiff"].includes(metadata.format ?? "") ||
      (metadata.format === "heif" && metadata.compression === "av1");
    if (!metadata.width || !metadata.height || !supported) throw new Error("Unsupported source format");
    // Wait for the native callback before releasing the verification slot.
    await image.raw().toBuffer();
    if (performance.now() - startedAt >= 10_000) throw Errors.unavailable("Reference image verification timed out. Please try again.");
    return { bytes, contentType: metadata.format === "heif" ? "image/avif" : `image/${metadata.format}` };
  } catch (error) {
    if (error instanceof Error && /tim(?:eout|ed out)/i.test(error.message)) throw Errors.unavailable("Reference image verification timed out. Please try again.");
    throw Errors.conflict("This reference image cannot be used for generation. Choose another readable image.", sourceImageAssetId ? { sourceImageAssetId } : undefined);
  }
}

const ipv4Blocked = new BlockList();
const fakeIpv4 = new BlockList();
fakeIpv4.addSubnet("198.18.0.0", 15, "ipv4");
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) ipv4Blocked.addSubnet(address, prefix, "ipv4");
const ipv6Global = new BlockList();
ipv6Global.addSubnet("2000::", 3, "ipv6");
const ipv6Blocked = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20],
] as const) ipv6Blocked.addSubnet(address, prefix, "ipv6");

/** Only routable public unicast addresses may be used for external media. */
export function isPublicRemoteImageAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !ipv4Blocked.check(address, "ipv4");
  if (version === 6) return ipv6Global.check(address, "ipv6") && !ipv6Blocked.check(address, "ipv6");
  return false;
}

function checkedUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw Errors.conflict("This source image URL is invalid. Choose another image."); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) {
    throw Errors.conflict("This source image URL is not supported. Choose another image.");
  }
  return url;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function publicAddresses(url: URL, signal: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  let records: Array<{ address: string; family: number }>;
  if (literal) {
    records = [{ address: host, family: literal }];
  } else {
    // OS DNS cannot be cancelled. Keep timed-out lookups counted until they
    // actually finish, so repeated stalls cannot grow the resolver queue forever.
    if (pendingDns >= MAX_PENDING_DNS) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
    pendingDns += 1;
    let promise: Promise<Array<{ address: string; family: number }>>;
    try { promise = lookup(host, { all: true, verbatim: true }); }
    catch (error) { pendingDns -= 1; throw error; }
    records = await withAbort(promise.finally(() => { pendingDns -= 1; }), signal);
    // Some local resolvers return synthetic benchmark-range addresses for
    // every public name. Never connect to those addresses: resolve eligible
    // names through a fixed, authenticated public resolver instead. Do not
    // bypass a mixed or private DNS response, which must remain fail-closed.
    if (records.length && records.every(record => record.family === 4 && isIP(record.address) === 4 && fakeIpv4.check(record.address, "ipv4"))) {
      records = await resolveFakeIpName(host, signal);
    }
  }
  if (!records.length || records.some(record => isIP(record.address) !== record.family || !isPublicRemoteImageAddress(record.address))) {
    throw Errors.conflict("This source image URL does not point to a public address. Choose another image.");
  }
  return records.map(record => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
}

// Pin the validated DNS result into the socket lookup. Host and TLS servername
// remain the original hostname, so a later DNS change cannot redirect the request.
function getPinned(url: URL, target: { address: string; family: 4 | 6 }, signal: AbortSignal, accept = "image/*"): Promise<IncomingMessage> {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", lookup: pinnedLookup, signal, agent: false,
      headers: { accept, "accept-encoding": "identity" },
    }, resolve);
    req.once("error", reject);
    req.end();
  });
}

function mayUsePublicDns(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  const labels = name.split(".");
  const privateSuffixes = ["localhost", "local", "localdomain", "lan", "home", "internal", "intranet", "corp", "private", "arpa", "onion", "test", "invalid", "example"];
  return labels.length >= 2 && name.length <= 253 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !privateSuffixes.includes(labels[labels.length - 1]!);
}

async function resolveFakeIpName(host: string, signal: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (!mayUsePublicDns(host)) throw Errors.conflict("This source image URL does not point to a public address. Choose another image.");
  if (pendingDoh >= MAX_PENDING_DOH) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
  pendingDoh += 1;
  try {
    // DNS over HTTPS uses a fixed Google Public DNS bootstrap address. The
    // URL hostname remains dns.google, so the normal TLS hostname check still
    // applies and the OS fake-IP resolver is not used for the bootstrap.
    const resolve = async (type: 1 | 28): Promise<Array<{ address: string; family: 4 | 6 }>> => {
      const url = new URL("https://dns.google/resolve");
      url.searchParams.set("name", host);
      url.searchParams.set("type", String(type));
      const response = await getPinned(url, { address: "8.8.8.8", family: 4 }, signal, "application/dns-json");
      if (response.statusCode !== 200) { response.destroy(); throw Errors.unavailable("Source image retrieval is temporarily unavailable."); }
      const length = response.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_DOH_BYTES)) { response.destroy(); throw Errors.unavailable("Source image retrieval is temporarily unavailable."); }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_DOH_BYTES) { response.destroy(); throw Errors.unavailable("Source image retrieval is temporarily unavailable."); }
        chunks.push(bytes);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
      const normalized = (name: string) => name.toLowerCase().replace(/\.$/, "");
      if (!data || typeof data !== "object" || !("Status" in data) || data.Status !== 0 || !("TC" in data) || data.TC !== false
        || !("Question" in data) || !Array.isArray(data.Question) || data.Question.length !== 1
        || !data.Question[0] || typeof data.Question[0].name !== "string" || normalized(data.Question[0].name) !== normalized(host)
        || data.Question[0].type !== type || ("Answer" in data && !Array.isArray(data.Answer))) {
        throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
      }
      const answers: unknown[] = "Answer" in data ? data.Answer as unknown[] : [];
      const cnames = new Map<string, string>();
      const addresses = new Map<string, Array<{ address: string; family: 4 | 6 }>>();
      for (const answer of answers) {
        if (!answer || typeof answer !== "object" || !("type" in answer) || !("data" in answer) || typeof answer.data !== "string"
          || !("name" in answer) || typeof answer.name !== "string" || !mayUsePublicDns(answer.name)) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
        const owner = normalized(answer.name);
        if (answer.type === 5) {
          if (!mayUsePublicDns(answer.data) || cnames.has(owner)) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
          cnames.set(owner, normalized(answer.data));
          continue;
        }
        const family = type === 1 ? 4 : 6;
        if (answer.type !== type || isIP(answer.data) !== family) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
        if (!isPublicRemoteImageAddress(answer.data)) throw Errors.conflict("This source image URL does not point to a public address. Choose another image.");
        const entries = addresses.get(owner) ?? [];
        entries.push({ address: answer.data, family });
        addresses.set(owner, entries);
      }
      let owner = normalized(host);
      const visited = new Set<string>();
      while (cnames.has(owner)) {
        if (visited.has(owner) || addresses.has(owner)) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
        visited.add(owner);
        owner = cnames.get(owner)!;
      }
      const result = addresses.get(owner) ?? [];
      // A CNAME may legitimately terminate in NODATA for one address family.
      // Require a matching ancestor SOA, so an incomplete answer alone does
      // not masquerade as authoritative absence of that family's addresses.
      const authority = "Authority" in data && Array.isArray(data.Authority) ? data.Authority : [];
      const hasNegativeAuthority = authority.some((record: unknown) => {
        if (!record || typeof record !== "object" || !("type" in record) || record.type !== 6 || !("name" in record) || typeof record.name !== "string") return false;
        const zone = normalized(record.name);
        return zone.length > 0 && (owner === zone || owner.endsWith(`.${zone}`));
      });
      // Do not accept unrelated records, loops or an incomplete CNAME chain.
      if (visited.has(owner) || visited.size !== cnames.size || addresses.size > (result.length ? 1 : 0) || (!result.length && !hasNegativeAuthority)) {
        throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
      }
      return result;
    };
    // Keep the concurrency slot until both HTTP requests settle, even when
    // one fails early. Otherwise a stalled sibling can accumulate unboundedly.
    const results = await Promise.allSettled([resolve(1), resolve(28)]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  } finally { pendingDoh -= 1; }
}

/** Fetch untrusted media without allowing private-network access or DNS rebinding. */
export async function readRemoteImage(value: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const signal = AbortSignal.timeout(10_000);
  let url = checkedUrl(value);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const targets = await publicAddresses(url, signal);
      let response: IncomingMessage | undefined;
      for (const target of targets) {
        try { response = await getPinned(url, target, signal); break; }
        catch (error) { if (signal.aborted) throw error; }
      }
      if (!response) throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || hop === MAX_REDIRECTS) throw Errors.conflict("This source image URL redirects too many times or is invalid.");
        try { url = checkedUrl(new URL(location, url)); }
        catch (error) {
          if (error instanceof AppError) throw error;
          throw Errors.conflict("This source image URL has an invalid redirect.");
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw Errors.conflict("This source image is unavailable. Choose another image.");
        throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
      }
      const length = response.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
        response.destroy();
        throw Errors.conflict("This source image is too large to verify. Choose another image.");
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_BYTES) {
          response.destroy();
          throw Errors.conflict("This source image is too large to verify. Choose another image.");
        }
        chunks.push(bytes);
      }
      return { bytes: Buffer.concat(chunks, total), contentType: response.headers["content-type"] ?? null };
    }
    throw Errors.conflict("This source image URL redirects too many times.");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw Errors.unavailable("Source image retrieval is temporarily unavailable.");
  }
}
