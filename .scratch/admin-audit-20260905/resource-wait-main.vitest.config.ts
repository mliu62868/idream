import original from "../../packages/main/vitest.config";
const staged = new URL("./resource-wait-staging/packages/", import.meta.url).pathname;
export default {
  ...original,
  root: new URL("../../packages/main", import.meta.url).pathname,
  test: { ...original.test, include: [staged + "main/src/server/ai/generation-transport-execution.integration.test.ts"] },
  resolve: { ...original.resolve, alias: { ...original.resolve?.alias, "@idream/shared/contracts": staged + "shared/src/contracts/index.ts" } },
};
