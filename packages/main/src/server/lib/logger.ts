import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "idream",
    env: env.APP_ENV,
  },
  redact: {
    paths: [
      "password",
      "token",
      "authorization",
      "headers.authorization",
      "cookie",
      "headers.cookie",
    ],
    remove: true,
  },
});
