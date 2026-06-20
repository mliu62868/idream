import pino from "pino";

export const logger = pino({
  name: "gen",
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
});
