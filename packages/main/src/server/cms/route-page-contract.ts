import { createHash } from "node:crypto";
import { z } from "zod";

export const CMS_CONTENT_SCHEMA_VERSION = 1;
export const cmsContentStatusSchema = z.enum(["template", "draft", "published"]);
export const cmsIndexingStatusSchema = z.enum(["noindex", "index"]);
export const cmsTemplateSchema = z.literal("article");

const reservedCmsPrefixes = [
  "/admin",
  "/api",
  "/characters",
  "/chat",
  "/community",
  "/create",
  "/creators",
  "/custom",
  "/explore",
  "/feed",
  "/generate",
  "/generator",
  "/helpdesk",
  "/internal-preview",
  "/login",
  "/profile",
  "/safety",
  "/signup",
  "/terms",
  "/upgrade",
  "/user-content",
] as const;

const normalizedPathPattern =
  /^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const normalizedInternalPathPattern =
  /^(?:\/|\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)$/;

export const cmsPathSchema = z
  .string()
  .trim()
  .min(2)
  .max(512)
  .refine((value) => normalizedPathPattern.test(value), {
    message:
      "path must be a normalized lowercase pathname without a query, fragment, or trailing slash",
  })
  .refine(
    (value) =>
      !reservedCmsPrefixes.some(
        (prefix) => value === prefix || value.startsWith(`${prefix}/`),
      ),
    { message: "path is owned by an application route and cannot be replaced by CMS" },
  );

export const cmsCanonicalSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => normalizedInternalPathPattern.test(value), {
    message: "canonical must be a normalized internal pathname",
  })
  .nullable();

const nonBlank = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const ctaHrefSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (normalizedInternalPathPattern.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }, "CTA href must be a normalized internal path or an HTTPS URL");

export const cmsArticleBodySchema = z
  .object({
    heading: nonBlank(160),
    intro: nonBlank(2_000).min(60),
    sections: z
      .array(
        z
          .object({
            heading: nonBlank(160),
            paragraphs: z.array(nonBlank(4_000).min(40)).min(1).max(20),
          })
          .strict(),
      )
      .min(2)
      .max(30),
    cta: z
      .object({
        label: nonBlank(80),
        href: ctaHrefSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const serializedLength = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (serializedLength > 128 * 1_024) {
      ctx.addIssue({
        code: "custom",
        message: "CMS body must not exceed 128 KiB",
      });
    }

    const headings = body.sections.map((section) =>
      section.heading.toLocaleLowerCase(),
    );
    if (new Set(headings).size !== headings.length) {
      ctx.addIssue({
        code: "custom",
        path: ["sections"],
        message: "section headings must be unique",
      });
    }
  });

export type CmsArticleBody = z.infer<typeof cmsArticleBodySchema>;
export type CmsIndexingStatus = z.infer<typeof cmsIndexingStatusSchema>;

export type CmsPublicationCandidate = {
  body: unknown;
  canonical: string | null;
  description: string;
  indexingStatus: string;
  path: string;
  template: string;
  title: string;
};

const publicationSchema = z
  .object({
    path: cmsPathSchema,
    template: cmsTemplateSchema,
    title: nonBlank(200).min(10),
    description: nonBlank(320).min(50),
    canonical: cmsCanonicalSchema,
    indexingStatus: cmsIndexingStatusSchema,
    body: cmsArticleBodySchema,
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (
      candidate.indexingStatus === "index" &&
      candidate.canonical !== null &&
      candidate.canonical !== candidate.path
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["canonical"],
        message: "an indexable page must be self-canonical",
      });
    }
  });

export type ValidatedCmsPublication = z.infer<typeof publicationSchema>;

export function validateCmsPublication(
  candidate: CmsPublicationCandidate,
): ValidatedCmsPublication {
  return publicationSchema.parse(candidate);
}

export function inspectCmsPublication(candidate: CmsPublicationCandidate) {
  const result = publicationSchema.safeParse(candidate);
  if (result.success) {
    return {
      publishability: "ready" as const,
      issues: [] as CmsContractIssue[],
    };
  }
  return {
    publishability: "blocked" as const,
    issues: cmsContractIssues(result.error),
  };
}

export type CmsContractIssue = {
  code: string;
  message: string;
  path: string;
};

export function cmsContractIssues(error: z.ZodError): CmsContractIssue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.join("."),
  }));
}

export function cmsCacheTag(path: string) {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return `cms-page:${digest}`;
}
