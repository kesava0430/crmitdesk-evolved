import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { AuthRequest } from '../../middleware/authenticate';
import { getVapidPublicKey, appPushConfigured } from '../../utils/webPush';

/** GET /push/vapid-public-key — the client needs this to call pushManager.subscribe(). 404s (not an empty 200) when unconfigured, so the client can distinguish "not set up yet" from "here's the key". */
export async function getVapidKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const key = getVapidPublicKey();
    if (!key) { res.status(404).json({ message: 'Push notifications are not configured on this server.' }); return; }
    res.json({ publicKey: key });
  } catch (err) { next(err); }
}

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/** POST /push/subscribe — upserted on endpoint (unique): a browser re-subscribing after a permission reset or reinstall always belongs to whoever is logged in now. */
export async function subscribe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { endpoint, keys } = SubscribeSchema.parse(req.body);
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.user!.id, orgId: req.user!.orgId, p256dh: keys.p256dh, auth: keys.auth },
      create: { endpoint, userId: req.user!.id, orgId: req.user!.orgId, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.status(201).json({ message: 'Subscribed' });
  } catch (err) { next(err); }
}

/** POST /push/unsubscribe — scoped to the caller's own subscription so one user can't unsubscribe another's device by guessing an endpoint. */
export async function unsubscribe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
    res.json({ message: 'Unsubscribed' });
  } catch (err) { next(err); }
}

// ─── Native app (FCM) device tokens ─────────────────────────────────────────

const DeviceSchema = z.object({
  // FCM registration tokens are ~150–200 chars; bound it generously.
  token: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios']).default('android'),
});

/** GET /push/app-config — whether this server can push to the Android app (FCM configured). */
export async function getAppPushConfig(_req: AuthRequest, res: Response) {
  res.json({ enabled: appPushConfigured() });
}

/** POST /push/device — the Android app registers its FCM token. Upserted on token: a device always belongs to whoever is signed in on it now. */
export async function registerDevice(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { token, platform } = DeviceSchema.parse(req.body);
    await prisma.deviceToken.upsert({
      where: { token },
      update: { userId: req.user!.id, orgId: req.user!.orgId, platform },
      create: { token, platform, userId: req.user!.id, orgId: req.user!.orgId },
    });
    res.status(201).json({ message: 'Device registered' });
  } catch (err) { next(err); }
}

/** POST /push/device/unregister — on sign-out. Scoped to the caller, same as unsubscribe above. */
export async function unregisterDevice(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
    await prisma.deviceToken.deleteMany({ where: { token, userId: req.user!.id } });
    res.json({ message: 'Device unregistered' });
  } catch (err) { next(err); }
}
