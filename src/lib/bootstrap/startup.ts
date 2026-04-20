import { getVaultService } from "@/lib/services/vault";

declare global {
  // eslint-disable-next-line no-var
  var __vaultBootstrapDone__: boolean | undefined;
}

/**
 * One-time startup bootstrap ("soft migration"):
 * create required vault folders/files if missing, never overwrite existing.
 */
export async function ensureStartupBootstrap(): Promise<void> {
  if (globalThis.__vaultBootstrapDone__) return;
  await getVaultService().ensureFolders();
  globalThis.__vaultBootstrapDone__ = true;
}
