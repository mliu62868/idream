import { describe, expect, it, vi } from "vitest";
import {
  AdminV2RequestError,
  apiDelete,
  apiWrite,
  formatApiError,
} from "./api";

describe("admin API error formatting", () => {
  it("shows CMS publication issue paths instead of a generic conflict", () => {
    expect(
      formatApiError(
        {
          message: "CMS page is not ready to publish",
          details: {
            issues: [
              {
                code: "too_small",
                path: "body.intro",
                message: "Too small: expected string to have >=60 characters",
              },
              {
                code: "too_small",
                path: "body.sections",
                message: "Too small: expected array to have >=2 items",
              },
            ],
          },
        },
        "Request failed",
      ),
    ).toContain(
      "body.intro: Too small: expected string to have >=60 characters",
    );
  });

  it("preserves response status and structured conflict details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: {
        code: "conflict",
        message: "Featured configuration changed",
        details: {
          reason: "featured_setting_version_conflict",
          settingVersion: 8,
          configuredCharacterIds: ["character-current"],
        },
      },
    }, { status: 409 })));
    try {
      const error = await apiWrite(
        "/api/v2/admin/content/featured",
        "PUT",
        {},
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AdminV2RequestError);
      expect(error).toMatchObject({
        status: 409,
        code: "conflict",
        details: {
          reason: "featured_setting_version_conflict",
          settingVersion: 8,
          configuredCharacterIds: ["character-current"],
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * SPEC: v1 后台 surface 的每一次写都带幂等键，而调用方一个字都不写。
 * INTENT: 这 30 多个 surface 以前把键当第四个参数自己塞进 headers，其中 17 处是
 *         `crypto.randomUUID()` —— 每点一次一把新键，丢响应后重试就是第二次真实写入。
 *         签名/回收的状态机在 idempotency-key-lifecycle.test.ts 里测；这里只钉住
 *         「这一层确实把键发出去了，而且调用方没有参与」。
 */
describe("legacy admin write transport", () => {
  function stubbedFetch(
    respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ) {
    const fetchMock = vi.fn(respond);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function captureFetch() {
    return stubbedFetch(async () => Response.json({ ok: true, data: {} }));
  }

  it("sends an idempotency key on a write the caller never named one for", async () => {
    const fetchMock = captureFetch();
    try {
      await apiWrite("/api/v2/admin/content/tags/tag-1", "PATCH", { label: "New" });
      const [, init] = fetchMock.mock.calls[0] ?? [];
      expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/.{8,}/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses the key while the body is unchanged and mints a new one once it changes", async () => {
    const fetchMock = captureFetch();
    try {
      const path = "/api/v2/admin/content/tags/tag-reuse";
      await apiWrite(path, "PATCH", { label: "Draft" }).catch(() => undefined);
      await apiWrite(path, "PATCH", { label: "Draft" }).catch(() => undefined);
      await apiWrite(path, "PATCH", { label: "Renamed" }).catch(() => undefined);
      const keys = fetchMock.mock.calls.map(
        ([, init]) => new Headers(init?.headers).get("idempotency-key"),
      );
      // 每一次都收到了服务端的答复，所以键都回收了：三次点击是三次意图。
      expect(new Set(keys).size).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replays the same key after a lost response", async () => {
    const fetchMock = stubbedFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    try {
      const path = "/api/v2/admin/content/tags/tag-lost";
      await apiDelete(path).catch(() => undefined);
      await apiDelete(path).catch(() => undefined);
      const keys = fetchMock.mock.calls.map(
        ([, init]) => new Headers(init?.headers).get("idempotency-key"),
      );
      expect(keys[1]).toBe(keys[0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
