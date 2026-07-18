import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "./legacy-primitives";

export async function retiredCreativeWrite(
  request: Request,
  replacement: {
    readonly deepLink: string;
  },
): Promise<never> {
  await actorWithPermission(request, "creative.run.write");
  throw Errors.gone(
    "This legacy image-creation endpoint is retired. Use the Creative Run authority.",
    {
      replacementApi: "/api/v2/admin/creative/runs",
      deepLink: replacement.deepLink,
    },
  );
}
