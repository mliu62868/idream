import { afterEach, describe, expect, it, vi } from "vitest";
import { accountMailAvailable, sendAccountEmail } from "./account-mail";

const config = vi.hoisted(() => ({ ACCOUNT_MAIL_PROVIDER: "resend", RESEND_API_KEY: "server-only-test-key", ACCOUNT_MAIL_FROM: "accounts@sender.invalid" }));
vi.mock("@/server/lib/env", () => ({ env: config }));

afterEach(() => {
  config.ACCOUNT_MAIL_PROVIDER = "resend";
  config.RESEND_API_KEY = "server-only-test-key";
  config.ACCOUNT_MAIL_FROM = "accounts@sender.invalid";
  vi.unstubAllGlobals();
});

const input = { email: "controlled-recipient@customer.invalid", code: "02468135", challengeId: "test-challenge", purpose: "reset_password" as const };

describe("account email provider", () => {
  it("submits the documented Resend request with an idempotency key and requires a real provider receipt", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(sendAccountEmail(input)).resolves.toEqual({ provider: "resend", requestId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer server-only-test-key", "Idempotency-Key": "account-email/test-challenge" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: config.ACCOUNT_MAIL_FROM, to: [input.email], subject: "Your iDream verification code" });
    expect(body.text).toContain("reset your password is 02468135");
    expect(body.text).toContain("does not confirm that an account exists");
    expect(body.text).not.toContain(config.RESEND_API_KEY);
    expect(body).not.toHaveProperty("html");
  });

  it.each(["disabled", "missing-key", "missing-from"])("fails closed before networking when %s", async (setting) => {
    if (setting === "disabled") config.ACCOUNT_MAIL_PROVIDER = "disabled";
    if (setting === "missing-key") config.RESEND_API_KEY = "";
    if (setting === "missing-from") config.ACCOUNT_MAIL_FROM = "";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(accountMailAvailable()).toBe(false);
    await expect(sendAccountEmail(input)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 401, 429, 500])("does not expose provider response or credentials on HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: `${input.email} ${input.code} ${config.RESEND_API_KEY}` }, { status })));
    await expect(sendAccountEmail(input)).rejects.toMatchObject({ status: 503, message: "The email request could not be confirmed. Wait a minute and request a new code. Any code from this attempt cannot be used." });
  });

  it.each([{ id: "" }, { id: "not-a-receipt" }, { accepted: true }])("rejects a malformed success receipt %j", async (receipt) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(receipt)));
    await expect(sendAccountEmail(input)).rejects.toMatchObject({ status: 503 });
  });

  it("treats a timeout as uncertain, without claiming delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    await expect(sendAccountEmail(input)).rejects.toMatchObject({ status: 503 });
  });
});
