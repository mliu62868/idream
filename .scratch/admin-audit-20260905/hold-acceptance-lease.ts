import { withGenerationAcceleratorLease } from '../../packages/gen/src/backend/generation-accelerator-lease';

// Controlled contention only: use the production lease protocol, never steal
// another process's device ownership. This makes the real Chrome request wait
// briefly before its actual model invocation; it does not mock the provider.
await withGenerationAcceleratorLease('video', async () => {
  console.log(JSON.stringify({ event: 'acceptance_resource_lease_acquired', pid: process.pid, at: new Date().toISOString(), durationMs: 90_000 }));
  await new Promise((resolve) => setTimeout(resolve, 90_000));
}, { lockPath: '/tmp/idream-generation-accelerator.lock', waitTimeoutMs: 10_000 });
console.log(JSON.stringify({ event: 'acceptance_resource_lease_released', at: new Date().toISOString() }));
