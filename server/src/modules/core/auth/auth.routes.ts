import { Router } from 'express';
import { register, login, refreshToken, logout, me, updateMe, changePassword, acceptInvite, inviteInfo } from './auth.controller';
import { authenticate } from '../../../middleware/authenticate';

export const authRouter = Router();
authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/refresh', refreshToken);
authRouter.post('/logout', logout);
authRouter.get('/invite-info', inviteInfo);
authRouter.post('/accept-invite', acceptInvite);
authRouter.get('/me', authenticate, me);
authRouter.put('/me', authenticate, updateMe);
authRouter.put('/me/password', authenticate, changePassword);
