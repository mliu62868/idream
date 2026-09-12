import { z } from "zod";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";

export type AccountEmailPurpose = "verify_email" | "reset_password";

export function accountMailAvailable() {
  return env.ACCOUNT_MAIL_PROVIDER === "resend" && Boolean(env.RESEND_API_KEY && env.ACCOUNT_MAIL_FROM);
}

export function requireAccountMail() {
  if (!accountMailAvailable()) {
    throw Errors.unavailable("Email verification and password reset are temporarily unavailable. Use a saved recovery code or try again later.");
  }
}

// Resend's acceptance receipt is not a delivery receipt. Never log the message,
// recipient, code, or provider response; those can contain account credentials.
// Contract: https://resend.com/docs/api-reference/emails/send-email
export async function sendAccountEmail(input: {
  email: string;
  code: string;
  challengeId: string;
  purpose: AccountEmailPurpose;
}) {
  requireAccountMail();
  const purpose = input.purpose === "verify_email" ? "verify your email" : "reset your password";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "Idempotency-Key": `account-email/${input.challengeId}`,
      },
      body: JSON.stringify({
        from: env.ACCOUNT_MAIL_FROM,
        to: [input.email],
        subject: "Your iDream verification code",
        text: `Your iDream code to ${purpose} is ${input.code}.\n\nIt expires in 10 minutes. Enter it only in the browser where you requested it. A newer code replaces this one.\n\nThis email does not confirm that an account exists. If you did not request this code, ignore this email. Never share this code with anyone.`,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Email provider rejected the request");
    const receipt = z.object({ id: z.string().uuid() }).parse(await response.json());
    return { provider: "resend" as const, requestId: receipt.id };
  } catch {
    throw Errors.unavailable("The email request could not be confirmed. Wait a minute and request a new code. Any code from this attempt cannot be used.");
  }
}
