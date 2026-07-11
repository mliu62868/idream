import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { fallbackCreativeDirections, generateProductionDirections } from "./production-directions";

const P = "zt-production-directions-";

type CallResult = {
  status: number;
  ok: boolean;
  data: { directions?: Array<Record<string, unknown>>; source?: string } | undefined;
};

function request(role: string, userId: string, body: unknown) {
  return new Request("http://localhost/api/v1/admin/content/production/directions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idream-user-id": userId,
      "x-idream-role": role,
    },
    body: JSON.stringify(body),
  });
}

async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const response = await handler;
    const json = (await response.json()) as { ok?: boolean; data?: CallResult["data"] };
    return { status: response.status, ok: Boolean(json.ok), data: json.data };
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, ok: false, data: undefined };
    if (error instanceof ZodError) return { status: 400, ok: false, data: undefined };
    throw error;
  }
}

const validBody = {
  characterId: `${P}character`,
  purpose: "character_chat",
  creativeBrief: "Rainy night after work",
  scenePrompt: "A quiet walk through wet city streets after a long shift",
  mood: "melancholic",
  setting: "urban night",
  outfit: "trench coat",
  camera: "50mm portrait",
  lighting: "neon and streetlight",
  consistencyMode: "balanced",
} as const;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: `${P}admin`, role: "admin" });
  await createUser({ id: `${P}support`, role: "support" });
  await createCharacter({ id: validBody.characterId, name: "Direction Muse" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("production creative directions", () => {
  it("returns four editable directions even when the configured model response needs fallback", async () => {
    const result = await call(
      generateProductionDirections(request("admin", `${P}admin`, validBody)),
    );
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data?.directions).toHaveLength(4);
    expect(result.data?.directions?.every((direction) => typeof direction.scenePrompt === "string")).toBe(true);
    expect(["model", "fallback"]).toContain(result.data?.source);
  });

  it("creates starter directions from the character when the operator leaves both prompt fields blank", async () => {
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, {
          ...validBody,
          creativeBrief: "",
          scenePrompt: "",
        }),
      ),
    );

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data?.directions).toHaveLength(4);
    expect(
      result.data?.directions?.every(
        (direction) =>
          typeof direction.scenePrompt === "string" && direction.scenePrompt.length > 12,
      ),
    ).toBe(true);
  });

  it("requires content.production.write", async () => {
    const result = await call(
      generateProductionDirections(request("support", `${P}support`, validBody)),
    );
    expect(result.status).toBe(403);
  });

  it("validates the operator brief length before calling the model", async () => {
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, { ...validBody, creativeBrief: "x".repeat(241) }),
      ),
    );
    expect(result.status).toBe(400);
  });

  it("keeps the operator scene in all deterministic fallback lenses", () => {
    const directions = fallbackCreativeDirections(validBody);
    expect(directions).toHaveLength(4);
    expect(directions.every((direction) => direction.scenePrompt.includes(validBody.scenePrompt))).toBe(true);
    expect(new Set(directions.map((direction) => direction.camera)).size).toBeGreaterThan(2);
  });
});
