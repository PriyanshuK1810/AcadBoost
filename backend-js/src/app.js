import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { AppError, errorHandler, notFound, notReady } from './core/errors.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerRecoveryRoutes } from './modules/auth/recovery.js';
import { registerReviewRoutes } from './modules/review/routes.js';
import { registerLearningRoutes } from './modules/learning/routes.js';
import { registerGoogleRoutes } from './modules/auth/google.js';
import { registerPhoneRoutes } from './modules/auth/phone.js';
import { registerActivityPlanRoutes } from './modules/activity-plans/routes.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createApp({ prisma, settings = {}, emailProvider, redisClient, smsProvider, objectStorage } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.prisma = prisma;
  app.locals.settings = settings;
  app.use((request, response, next) => {
    const candidate = request.get('X-Request-ID');
    request.requestId = candidate && uuidPattern.test(candidate) ? candidate.toLowerCase() : randomUUID();
    response.set('X-Request-ID', request.requestId);
    const started = performance.now();
    response.once('finish', () => {
      if (settings.env === 'test' || process.env.NODE_ENV === 'test') return;
      console.info(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        logger: 'outpost.request',
        message: 'request.completed',
        method: request.method,
        path: request.route?.path,
        request_id: request.requestId,
        status_code: response.statusCode,
        duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
      }));
    });
    next();
  });
  const normalJson = express.json({ limit: '1mb' });
  const reviewJson = express.json({ limit: '4mb' });
  app.use((request, response, next) => {
    // A reviewed proposal repeats selectable source text alongside corrections.
    // Allow its bounded UTF-8 representation without enlarging auth requests.
    const review = request.method === 'PATCH' &&
      /^\/api\/v1\/organizations\/[0-9a-f-]+\/activity-plans\/[0-9a-f-]+\/?$/i.test(request.path);
    (review ? reviewJson : normalJson)(request, response, (error) => {
      if (error?.type === 'entity.too.large') {
        return next(new AppError(413, 'request_too_large', 'The request exceeds the allowed size.'));
      }
      if (error?.type === 'entity.parse.failed' && error.status === 400) {
        return next(new AppError(400, 'invalid_json', 'Malformed JSON request body.'));
      }
      next(error);
    });
  });
  app.use(cookieParser());

  app.get('/health', (_request, response) => response.json({ status: 'healthy' }));
  app.get('/ready', async (_request, response, next) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      response.json({ status: 'ready' });
    } catch {
      next(notReady('Database is unavailable'));
    }
  });
  app.get('/api/v1', (_request, response) => response.json({ name: 'Outpost API', version: 'v1' }));
  const requireUser = registerAuthRoutes(app, { prisma, settings });
  registerRecoveryRoutes(app, { prisma, settings, emailProvider });
  registerGoogleRoutes(app, { prisma, settings, redisClient });
  registerPhoneRoutes(app, { prisma, settings, redisClient, smsProvider });
  registerReviewRoutes(app, { prisma, settings, requireUser });
  registerLearningRoutes(app, { prisma, settings, requireUser, redisClient });
  registerActivityPlanRoutes(app, { prisma, requireUser, storage: objectStorage });

  app.use((_request, _response, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
