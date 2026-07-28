import { Router } from 'express';
import { authenticate, requireRole, ADMIN, MANAGERS } from '../../middleware/authenticate';
import * as c from './storage.controller';

export const storageRouter = Router();

// Callback is hit directly by Google's redirect — no Authorization header
// exists at that point, so it must stay outside the authenticate() gate.
// It's protected instead by the signed, short-lived `state` param minted in
// connectGoogleDrive below.
storageRouter.get('/google/callback', c.googleCallback);

storageRouter.use(authenticate);
// Any manager can see whether storage is connected; only the org owner can
// change it — connecting an OAuth integration is a significant trust
// decision, same level as billing.
storageRouter.get('/status',           requireRole(...MANAGERS), c.getStatus);
storageRouter.get('/google/connect',   requireRole(...ADMIN),    c.connectGoogleDrive);
storageRouter.delete('/',              requireRole(...ADMIN),    c.disconnect);
