import { Router } from 'express';
import { authenticate, requireRole, IT_MANAGERS, ALL_USERS } from '../../middleware/authenticate';
import * as c from './assistantChannels.controller';

export const assistantChannelsRouter = Router();

// Slack calls these — public, verified with the org's signing secret (raw body, see index.ts).
assistantChannelsRouter.post('/slack/:key/events', c.slackEvents);
assistantChannelsRouter.post('/slack/:key/commands', c.slackCommand);

assistantChannelsRouter.use(authenticate);

// Same owners as the Slack and Inbox WhatsApp settings.
assistantChannelsRouter.get('/settings', requireRole(...IT_MANAGERS), c.getSettings);
assistantChannelsRouter.put('/settings', requireRole(...IT_MANAGERS), c.saveSettings);

// Everyone links their own accounts (employees can file leave etc. by message).
assistantChannelsRouter.get('/me', requireRole(...ALL_USERS), c.getMine);
assistantChannelsRouter.post('/me/whatsapp/code', requireRole(...ALL_USERS), c.createWhatsAppCode);
assistantChannelsRouter.delete('/me/whatsapp', requireRole(...ALL_USERS), c.unlinkWhatsApp);
assistantChannelsRouter.post('/me/slack/confirm', requireRole(...ALL_USERS), c.confirmSlack);
assistantChannelsRouter.delete('/me/slack', requireRole(...ALL_USERS), c.unlinkSlack);
