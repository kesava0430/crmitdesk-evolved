/**
 * Persistent AI answer cache (ai_response_cache).
 *
 * utils/ai.ts keeps a small in-process cache, but it is emptied by every
 * restart and every deploy — and deploys happen several times a day — so a
 * lead scored this morning was re-scored (and re-billed) after lunch even
 * though nothing about it had changed. This table holds answers for the
 * repeatable features (scores, labels, search interpretations) for days.
 *
 * Freshness comes from the key, not the TTL: the key is a hash of the full
 * prompt, which already contains the record's data, so editing the record
 * changes the key and the next call asks the model again.
 *
 * Every function here swallows errors. The cache is an optimisation; a
 * database hiccup must degrade to "call the model", never break the feature.
 */
import { prisma } from './prisma';

/** Days a cached answer stays valid. Content changes invalidate sooner. */
const PERSISTENT_TTL_MS = Number(process.env.AI_CACHE_TTL_HOURS ?? 24 * 7) * 3_600_000;

export async function readPersistentCache(orgId: string, cacheKey: string): Promise<string | null> {
  try {
    const row = await prisma.aiResponseCache.findUnique({
      where: { orgId_cacheKey: { orgId, cacheKey } },
      select: { id: true, response: true, expiresAt: true },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    // Hit counter is informational; don't make the caller wait for it.
    prisma.aiResponseCache.update({ where: { id: row.id }, data: { hits: { increment: 1 } } }).catch(() => {});
    return row.response;
  } catch {
    return null;
  }
}

let writesSincePrune = 0;

export async function writePersistentCache(
  orgId: string,
  cacheKey: string,
  feature: string,
  response: string,
  ttlMs = PERSISTENT_TTL_MS,
): Promise<void> {
  // An empty answer is a failed call in disguise — caching it would pin the
  // failure for a week.
  if (!response.trim()) return;
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    await prisma.aiResponseCache.upsert({
      where: { orgId_cacheKey: { orgId, cacheKey } },
      create: { orgId, cacheKey, feature, response, expiresAt },
      update: { response, expiresAt },
    });
    // Expired rows are never read, but they take space; sweep them now and
    // then rather than needing a separate cron job.
    if (++writesSincePrune >= 200) {
      writesSincePrune = 0;
      await prisma.aiResponseCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    }
  } catch {
    /* non-fatal */
  }
}
