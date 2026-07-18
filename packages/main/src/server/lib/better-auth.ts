import { APIError, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import {
  isReservedInternalEmail,
  registeredUserDataClass,
} from "@/server/lib/user-data-provenance";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
    usePlural: true,
    transaction: true,
  }),
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        async before(user) {
          if (isReservedInternalEmail(user.email)) {
            throw APIError.from("BAD_REQUEST", {
              code: "RESERVED_EMAIL_DOMAIN",
              message: "Email domain is reserved",
            });
          }
          return {
            data: {
              ...user,
              dataClass: registeredUserDataClass(user.email),
            },
          };
        },
      },
    },
  },
  trustedOrigins: [
    env.BETTER_AUTH_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ],
  plugins: [nextCookies()],
});
