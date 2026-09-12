import { checkModelAccess } from "./higgsfield";

const CACHE_MS = 10 * 60_000;
const RETRY_MS = 30_000;
let cached: { at: number; ttl: number; value: Record<string, boolean> } | null = null;
let inFlight: Promise<Record<string, boolean>> | null = null;

/** Share the existing non-rendering access probes between quotes and submits. */
export async function getVideoModelAccess(): Promise<Record<string, boolean>> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
  inFlight ??= checkModelAccess()
    .then((value) => {
      // Failed/unknown access checks should recover promptly on a retry.
      // The probe reports them as false, so any negative sweep gets a short
      // cache; a fully confirmed catalog keeps the normal ten-minute TTL.
      const ttl = Object.keys(value).length > 0 && Object.values(value).every(Boolean) ? CACHE_MS : RETRY_MS;
      cached = { at: Date.now(), ttl, value };
      return value;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}
