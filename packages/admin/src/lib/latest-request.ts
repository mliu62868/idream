export type LatestRequestToken = {
  isCurrent(): boolean;
};

export type LatestRequestGate = {
  begin(): LatestRequestToken;
  invalidate(): void;
};

export function createLatestRequestGate(): LatestRequestGate {
  let generation = 0;
  return {
    begin() {
      const activeGeneration = ++generation;
      return {
        isCurrent: () => activeGeneration === generation,
      };
    },
    invalidate() {
      generation += 1;
    },
  };
}
