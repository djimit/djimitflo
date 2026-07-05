import request from 'supertest';
import express from 'express';
import { requestLogger } from '../middleware/request-logger';
import logger from '../utils/logger';

jest.mock('../utils/logger');

const app = express();
app.use(requestLogger);
app.get('/test', (req, res) => res.json({ ok: true }));

describe('Request Logger Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should log incoming requests', async () => {
    await request(app).get('/test');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/GET \/test/),
      expect.objectContaining({ method: 'GET', url: '/test' })
    );
  });

  it('should log response with status code', async () => {
    await request(app).get('/test');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/200/),
      expect.objectContaining({ statusCode: 200 })
    );
  });

  it('should include request duration', async () => {
    await request(app).get('/test');
    const calls = (logger.info as jest.Mock).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toHaveProperty('duration');
    expect(typeof lastCall[1].duration).toBe('number');
  });

  it('should log errors for failed requests', async () => {
    const errorApp = express();
    errorApp.use(requestLogger);
    errorApp.get('/error', (req, res) => {
      res.status(500).send('Error');
    });
    await request(errorApp).get('/error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/500/),
      expect.objectContaining({ statusCode: 500 })
    );
  });
});
