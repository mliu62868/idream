import { safeInternalAuthRedirect } from "@/components/ourdream/authRedirect";

export const AGE_VERIFICATION_RETURN_PATH = "/age-verification/return";

export function safeAgeVerificationReturnTarget(next: string | null) {
  const target = safeInternalAuthRedirect(
    next,
    "https://ourdream.invalid",
  );
  return target === AGE_VERIFICATION_RETURN_PATH ||
      target.startsWith(`${AGE_VERIFICATION_RETURN_PATH}?`) ||
      target.startsWith(`${AGE_VERIFICATION_RETURN_PATH}#`) ||
      target.startsWith(`${AGE_VERIFICATION_RETURN_PATH}/`)
    ? "/"
    : target;
}
