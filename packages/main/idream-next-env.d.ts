/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Next rewrites next-env.d.ts for every build. Route types are included by the
// active tsconfig so concurrent builds do not import another run's output.
