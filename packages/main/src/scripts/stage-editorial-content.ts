import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { editorialContent } from "../server/cms/editorial-content";
import { validateCmsPublication } from "../server/cms/route-page-contract";
import { DEV_ADMIN_ACCOUNTS } from "../server/admin/dev-login-accounts";
import { canonicalJsonHash } from "../server/modules/admin-v2/shared/idempotency";

// Explicit local staging command. Ordinary db:seed never replaces reviewed CMS
// content; this command creates missing drafts and refuses conflicting drafts.
const mainRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(mainRoot, "../..");
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--origin")) throw Error("Usage: bun src/scripts/stage-editorial-content.ts [--origin http://localhost:3001]");
const origin = new URL(args[1] ?? "http://localhost:3001");
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname) || origin.port !== "3001" || origin.pathname !== "/") throw Error("Staging requires the local Admin origin on port 3001");
const mainEnv = parse(readFileSync(resolve(mainRoot, ".env")));
const database = new URL(mainEnv.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.port !== "5433" || database.pathname !== "/idream_runtime_20260812" || (mainEnv.APP_ENV && mainEnv.APP_ENV !== "development")) throw Error("Wrong development database or environment");
for (const page of editorialContent) validateCmsPublication({ ...page, template: "article", canonical: page.path, indexingStatus: "index" });

const preview = editorialContent.map(page => `## ${page.path}\n\n${page.title}\n\n${page.description}\n\n${page.body.intro}\n\n${page.body.sections.map(section => `### ${section.heading}\n\n${section.paragraphs.join("\n\n")}`).join("\n\n")}\n\nCTA: ${page.body.cta?.label} → ${page.body.cta?.href}\n`).join("\n");
writeFileSync(resolve(repoRoot, ".scratch/full-product-audit-2026-10-01/cms-editorial-preview.md"), `# Original CMS draft preview\n\nAll pages remain drafts until a canonical CMS publish action. Existing published pages are not overwritten. No private media or invented personal author is used.\n\n${preview}`);

let cookie = "";
const evidence: { path: string; action: "created" | "existing_draft" | "existing_published"; contentStatus: string; updatedAt: string; publishability: string; cacheRevalidated?: boolean }[] = [];
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); if (cookie) headers.set("cookie", cookie);
  const response = await fetch(new URL(path, origin), { ...init, headers, signal: AbortSignal.timeout(20_000) });
  return { response, payload: await response.json() };
}
const admin = DEV_ADMIN_ACCOUNTS.find(account => account.role === "admin");
if (!admin) throw Error("Development Admin account is missing");
try {
  const login = await request("/api/admin-auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: admin.username, password: admin.password }) });
  if (!login.response.ok || login.payload.ok !== true || login.payload.data?.user?.id !== admin.userId) throw Error(`Development Admin sign-in failed (${login.response.status})`);
  cookie = login.response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  if (!cookie.includes("idream_admin_session=")) throw Error("Admin session cookie is missing");
  for (const page of editorialContent) {
    const existing = await request(`/api/v2/admin/cms/page?${new URLSearchParams({ path: page.path })}`);
    if (existing.response.ok && existing.payload.ok === true) {
      const row = existing.payload.data.page;
      if (row.contentStatus !== "published" && (row.contentStatus !== "draft" || canonicalJsonHash(row.body) !== canonicalJsonHash(page.body) || row.title !== page.title || row.description !== page.description || row.canonical !== page.path || row.indexingStatus !== "index")) throw Error(`Existing draft needs review before replacement: ${page.path}`);
      evidence.push({ path: page.path, action: row.contentStatus === "published" ? "existing_published" : "existing_draft", contentStatus: row.contentStatus, updatedAt: row.updatedAt, publishability: row.publishability });
      continue;
    }
    if (existing.response.status !== 404) throw Error(`CMS read failed for ${page.path} (${existing.response.status})`);
    const created = await request("/api/v2/admin/cms/pages", { method: "POST", headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() }, body: JSON.stringify({ ...page, template: "article", canonical: page.path, indexingStatus: "index", reason: "Stage original iDream product guides for local publication review", confirmation: page.path }) });
    if (!created.response.ok || created.payload.ok !== true) throw Error(`CMS draft create failed for ${page.path} (${created.response.status}: ${created.payload.error?.message ?? "unknown"})`);
    const row = created.payload.data.page;
    if (row.contentStatus !== "draft" || row.publishability !== "ready" || row.publishedAt !== null) throw Error(`Created CMS page is not a ready unpublished draft: ${page.path}`);
    evidence.push({ path: page.path, action: "created", contentStatus: row.contentStatus, updatedAt: row.updatedAt, publishability: row.publishability, cacheRevalidated: created.payload.data.cacheRevalidated });
  }
  const report = { checkedAt: new Date().toISOString(), origin: origin.origin, database: { host: database.hostname, port: database.port, database: database.pathname.slice(1) }, actorId: admin.userId, pages: evidence, publishedByCommand: 0 };
  writeFileSync(resolve(repoRoot, ".scratch/full-product-audit-2026-10-01/cms-editorial-drafts.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (cookie) await fetch(new URL("/api/admin-auth/logout", origin), { method: "POST", headers: { cookie }, signal: AbortSignal.timeout(10_000) });
}
