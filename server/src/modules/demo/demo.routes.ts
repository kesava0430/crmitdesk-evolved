import { Router } from 'express';
import { resetDemo, listVerticals } from './demo.controller';

export const demoRouter = Router();
// No authenticate() middleware — secret-header-gated instead, see resetDemo().
demoRouter.post('/reset', resetDemo);
// Public — the /demo landing page needs this before anyone is logged in.
demoRouter.get('/verticals', listVerticals);
