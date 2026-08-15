import { Router } from 'express';
import { resetDemo, listVerticals, demoStatus } from './demo.controller';

export const demoRouter = Router();
// No authenticate() middleware — secret-header-gated instead, see resetDemo().
demoRouter.post('/reset', resetDemo);
// Public — the /demo landing page needs this before anyone is logged in.
demoRouter.get('/verticals', listVerticals);
// Public diagnostics — tells you whether the demo is seeded and what to run if
// it isn't, without needing a login you may not be able to get.
demoRouter.get('/status', demoStatus);
