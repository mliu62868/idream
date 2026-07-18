import setupTestDatabase from "../server/test/global-setup";
import { assertPlaywrightDatabaseUrl } from "../../playwright-environment";

export default async function setupManagedPlaywrightEnvironment() {
  assertPlaywrightDatabaseUrl(
    process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "",
  );
  return setupTestDatabase();
}
