import { Router } from 'express';
import { resetDemo } from './demo.controller';

export const demoRouter = Router();
// No authenticate() middleware — secret-header-gated instead, see resetDemo().
demoRouter.post('/reset', resetDemo);
