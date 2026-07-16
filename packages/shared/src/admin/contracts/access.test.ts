import { describe, expect, it } from "vitest";
import {
  ADMIN_DATA_CLASSES,
  accessUserListQuerySchema,
  accessUserListResponseSchema,
} from "./index";

describe("Access Users contracts", () => {
  it("shares the complete user data class vocabulary across query and response", () => {
    expect(ADMIN_DATA_CLASSES).toEqual([
      "customer",
      "internal",
      "fixture",
      "audit",
    ]);
    for (const dataClass of ADMIN_DATA_CLASSES) {
      expect(accessUserListQuerySchema.parse({ dataClass }).dataClass).toBe(
        dataClass,
      );
    }
    expect(
      accessUserListQuerySchema.safeParse({ dataClass: "unknown" }).success,
    ).toBe(false);
  });

  it("requires dataClass in every Access Users list item", () => {
    const response = {
      items: [
        {
          id: "user-1",
          email: "user-1@idream.test",
          displayName: "User One",
          role: "user",
          status: "active",
          dataClass: "fixture",
          createdAt: "2026-07-16T12:00:00.000Z",
          plan: null,
          dreamcoins: 0,
        },
      ],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    expect(accessUserListResponseSchema.parse(response)).toEqual(response);
    expect(
      accessUserListResponseSchema.safeParse({
        ...response,
        items: [{ ...response.items[0], dataClass: undefined }],
      }).success,
    ).toBe(false);
  });
});
