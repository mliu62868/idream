import { describe, expect, it, vi } from "vitest";
import {
  extractLinkedNextAssetUrls,
  isAdminAccessDeniedHtml,
  isAdminDevLoginWallHtml,
  probeLinkedNextAssets,
  runProbe,
} from "./probe-web-surface";

describe("web-surface linked Next asset closure", () => {
  it("recognizes the protected Admin login wall in both supported locales", () => {
    expect(
      isAdminDevLoginWallHtml(
        '<main><p>DEV ONLY</p><h1>Admin login</h1><input type="password"></main>',
      ),
    ).toBe(true);
    expect(
      isAdminDevLoginWallHtml(
        "<main><p>仅限开发环境</p><h1>后台登录</h1><input type='password'></main>",
      ),
    ).toBe(true);
    expect(
      isAdminDevLoginWallHtml(
        '<main data-admin-auth-wall="dev-login-v1"></main>',
      ),
    ).toBe(true);
  });

  it("does not treat login-themed copy without a password control as protection", () => {
    expect(
      isAdminDevLoginWallHtml(
        "<main><p>仅限开发环境</p><h1>后台登录</h1></main>",
      ),
    ).toBe(false);
    expect(
      isAdminDevLoginWallHtml(
        '<main><p>仅限开发环境</p><h1>后台登录</h1><div type="password"></div></main>',
      ),
    ).toBe(false);
  });

  it("recognizes versioned and localized Admin access-denied walls", () => {
    expect(
      isAdminAccessDeniedHtml(
        '<main data-admin-auth-wall="access-denied-v1"></main>',
      ),
    ).toBe(true);
    expect(isAdminAccessDeniedHtml("<h1>Admin access denied</h1>")).toBe(true);
    expect(isAdminAccessDeniedHtml("<h1>无后台访问权限</h1>")).toBe(true);
  });

  it("checks each distinct linked JavaScript and stylesheet with query identity intact", async () => {
    const html = `
      <link rel="stylesheet" href="/_next/static/css/app.css?dpl=release-a">
      <script src="/_next/static/chunks/app.js?dpl=release-a"></script>
      <script src="/_next/static/chunks/app.js?dpl=release-a"></script>
      <script src="/_next/static/chunks/app.js?dpl=release-b"></script>
      <img src="/_next/static/media/portrait.webp">
    `;
    expect(extractLinkedNextAssetUrls(
      html,
      "http://127.0.0.1:3000/generate",
    )).toEqual([
      "http://127.0.0.1:3000/_next/static/css/app.css?dpl=release-a",
      "http://127.0.0.1:3000/_next/static/chunks/app.js?dpl=release-a",
      "http://127.0.0.1:3000/_next/static/chunks/app.js?dpl=release-b",
    ]);
    const fetchAsset = vi.fn(async (input: string | URL | Request) =>
      new Response("asset", {
        status: 200,
        headers: {
          "content-type": String(input).includes(".css")
            ? "text/css; charset=utf-8"
            : "application/javascript; charset=utf-8",
        },
      })
    );

    const evidence = await probeLinkedNextAssets(
      html,
      "http://127.0.0.1:3000/generate",
      fetchAsset,
    );

    expect(evidence).toEqual({ ok: true, checked: 3, failures: [] });
    expect(fetchAsset).toHaveBeenCalledTimes(3);
  });

  it("fails on missing, empty, or incorrectly typed linked chunks", async () => {
    const html = `
      <script src="/_next/static/chunks/missing.js"></script>
      <link href="/_next/static/css/empty.css" rel="stylesheet">
      <script src="/_next/static/chunks/html.js"></script>
    `;
    const fetchAsset = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("missing")) {
        return new Response("error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.includes("empty")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }
      return new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    const evidence = await probeLinkedNextAssets(
      html,
      "http://127.0.0.1:3000/",
      fetchAsset,
    );

    expect(evidence.ok).toBe(false);
    expect(evidence.checked).toBe(3);
    expect(evidence.failures.map((failure) => failure.error)).toEqual([
      "Linked Next asset returned HTTP 500",
      "Linked Next asset was empty",
      "Linked Next asset returned an unexpected content type",
    ]);
  });

  it("fails when healthy-looking HTML links no executable Next assets", async () => {
    const evidence = await probeLinkedNextAssets(
      "<html><body>ourdream generator</body></html>",
      "http://127.0.0.1:3000/",
    );

    expect(evidence.ok).toBe(false);
    expect(evidence.checked).toBe(0);
    expect(evidence.failures[0]?.error).toContain("linked no Next");
  });

  it("aborts a linked asset that never produces a response", async () => {
    const fetchAsset = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const evidence = await probeLinkedNextAssets(
      '<script src="/_next/static/chunks/stuck.js"></script>',
      "http://127.0.0.1:3000/",
      fetchAsset,
      { requestTimeoutMs: 5 },
    );
    expect(evidence.ok).toBe(false);
    expect(evidence.failures[0]).toMatchObject({
      url: "http://127.0.0.1:3000/_next/static/chunks/stuck.js",
    });
    expect(evidence.failures[0]?.error).toContain("within 5ms");
  });

  it("returns total-deadline evidence even when a fetch ignores abort", async () => {
    const startedAt = Date.now();
    const report = await runProbe(
      {
        report: null,
        mainUrl: "http://127.0.0.1:3000",
        adminUrl: "http://127.0.0.1:3001",
      },
      {
        fetch: () => new Promise<Response>(() => undefined),
        requestTimeoutMs: 5,
        totalTimeoutMs: 15,
      },
    );
    expect(report).toMatchObject({
      ok: false,
      error: {
        code: "web_surface_probe_timeout",
        retryable: true,
      },
    });
    expect(report.error?.message).toContain("15ms");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
