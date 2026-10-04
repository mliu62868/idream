import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(), auth: vi.fn(), entitlements: vi.fn(), publication: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  permanentRedirect: vi.fn(),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children) }));
vi.mock("@/server/lib/auth", () => ({ getAuthCtx: mocks.auth }));
vi.mock("@/server/modules/ourdream/subscription-lifecycle", () => ({ entitlementMap: mocks.entitlements }));
vi.mock("./published-route", () => ({ loadPublishedRoutePage: mocks.publication }));
vi.mock("@/components/ourdream/OurdreamRoutePage", () => ({ RouteShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/ourdream/CmsRenderer", () => ({ CmsRenderer: ({ page }: { page: { body: { intro: string } } }) => createElement("article", null, page.body.intro) }));
import ChangelogPage from "@/app/changelog/page";
import PublicCmsPage, { generateMetadata } from "@/app/[...slug]/page";

describe("Changelog per-request publication gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ cookie: "idream_session=current-customer" }));
    mocks.auth.mockResolvedValue({ userId: "customer" });
    mocks.entitlements.mockResolvedValue({ premium_controls: true });
    mocks.publication.mockResolvedValue({ state: "published", page: { body: { intro: "Private published release body" } } });
  });
  async function html() { return renderToStaticMarkup(await ChangelogPage()); }

  it("keeps anonymous HTML and RSC free of CMS content and preserves the login return", async () => {
    mocks.auth.mockResolvedValue({});
    expect(await html()).toContain('/login?next=%2Fchangelog');
    expect(mocks.entitlements).not.toHaveBeenCalled();
    expect(mocks.publication).not.toHaveBeenCalled();
  });
  it.each([{}, { premium_controls: false }, { premium_controls: "true" }])("requires the current authoritative entitlement: %j", async (entitlement) => {
    mocks.entitlements.mockResolvedValue(entitlement);
    const body = await html();
    expect(body).toContain("View plans");
    expect(body).not.toContain("Private published release body");
    expect(mocks.publication).not.toHaveBeenCalled();
  });
  it("reads published content only after resolving the current customer's access", async () => {
    expect(await html()).toContain("Private published release body");
    expect(mocks.entitlements).toHaveBeenCalledWith("customer");
    expect(mocks.publication).toHaveBeenCalledWith("/changelog");
    const request = mocks.auth.mock.calls[0]![0] as Request;
    expect(request.headers.get("cookie")).toBe("idream_session=current-customer");
    expect(new URL(request.url).pathname).toBe("/changelog");
  });
  it.each(["missing", "not_published"])("shows an honest empty state for %s", async (reason) => {
    mocks.publication.mockResolvedValue({ state: "absent", reason });
    expect(await html()).toContain("No product updates have been published yet.");
  });
  it.each(["invalid", "unavailable"])("does not turn %s into empty content", async (state) => {
    mocks.publication.mockResolvedValue({ state });
    await expect(ChangelogPage()).rejects.toThrow("temporarily unavailable");
  });
  it.each(["page", "metadata"])("refuses Changelog in the public catch-all %s before reading CMS", async (surface) => {
    mocks.publication.mockResolvedValue({ state: "absent", reason: "missing" });
    const props = { params: Promise.resolve({ slug: ["changelog"] }), searchParams: Promise.resolve({}) };
    await expect(surface === "page" ? PublicCmsPage(props) : generateMetadata(props)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(mocks.publication).not.toHaveBeenCalled();
  });
});
