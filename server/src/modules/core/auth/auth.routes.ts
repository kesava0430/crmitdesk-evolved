import { Router } from 'express';
import { register, login, refreshToken, logout, me, updateMe, changePassword, acceptInvite, inviteInfo, orgSignupInfo, approveOrgSignup } from './auth.controller';
import { authenticate } from '../../../middleware/authenticate';

export const authRouter = Router();
authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/refresh', refreshToken);
authRouter.post('/logout', logout);
authRouter.get('/invite-info', inviteInfo);
authRouter.post('/accept-invite', acceptInvite);
// Public + token-secured, same pattern as invite-info/accept-invite above —
// the reviewer is clicking a link from an email, not logged into the app.
authRouter.get('/org-signup-info', orgSignupInfo);
authRouter.post('/approve-org-signup', approveOrgSignup);
authRouter.get('/me', authenticate, me);
authRouter.put('/me', authenticate, updateMe);
authRouter.put('/me/password', authenticate, changePassword);
