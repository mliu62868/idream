export type PublicOptimisticMutation = "follow" | "gallery_like";

export function publicOptimisticMutationFailure(kind: PublicOptimisticMutation) {
  if (kind === "gallery_like") {
    return {
      reloadAuthority: true,
      status: "Could not update like. Restoring the current gallery.",
    } as const;
  }
  return {
    reloadAuthority: false,
    status: "Could not update follow. Please try again.",
  } as const;
}
