import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/error-handler';

const app = express();
app.get('/error', (req, res) => {
  throw new Error('Test error');
});
app.use(errorHandler);

describe('Error Handler Middleware', () => {
  it('should return 500 for unhandled errors', async () => {
    const res = await request(app).get('/error');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
  });

  it('should map known error types to correct status codes', async () => {
    const appCustom = express();
    appCustom.get('/unauthorized', (req, res) => {
      const err: any = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    });
    appCustom.use(errorHandler);
    const res = await request(appCustom).get('/unauthorized');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should include stack trace in development mode', async () => {
    process.env.NODE_ENV = 'development';
    const res = await request(app).get('/error');
    expect(res.body.stack).toBeDefined();
    process.env.NODE_ENV = 'test';
  });

  it('should not include stack trace in production mode', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app).get('/error');
    expect(res.body.stack).toBeUndefined();
    process.env.NODE_ENV = 'test';
  });

  it('should handle validation errors (422)', async () => {
    const appValidation = express();
    appValidation.get('/validation', (req, res) => {
      const err: any = new Error('Validation failed');
      err.statusCode = 422;
      err.details = [{ field: 'email', message: 'Invalid email' }];
      throw err;
    });
    appValidation.use(errorHandler);
    const res = await request(appValidation).get('/validation');
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([{ field: 'email', message: 'Invalid email' }]);
  });
});
