import request from 'supertest';
import express from 'express';
import { authMiddleware } from '../middleware/auth';
import { createToken, verifyToken } from '../utils/jwt';

jest.mock('../utils/jwt');

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.get('/test', (req, res) => res.json({ user: req.user }));

describe('Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 if no token provided', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  it('should return 401 if token is invalid', async () => {
    (verifyToken as jest.Mock).mockImplementation(() => { throw new Error('Invalid token'); });
    const res = await request(app).get('/test').set('Authorization', 'Bearer invalid');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  it('should return 403 if user is disabled', async () => {
    (verifyToken as jest.Mock).mockResolvedValue({ id: 1, disabled: true });
    const res = await request(app).get('/test').set('Authorization', 'Bearer valid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('User disabled');
  });

  it('should return 403 if user lacks permission', async () => {
    (verifyToken as jest.Mock).mockResolvedValue({ id: 1, disabled: false, permissions: ['read'] });
    // Assume route requires 'write' permission
    const appWithPerm = express();
    appWithPerm.use((req, res, next) => {
      req.requiredPermissions = ['write'];
      next();
    });
    appWithPerm.use(authMiddleware);
    appWithPerm.get('/test', (req, res) => res.json({ user: req.user }));
    const res = await request(appWithPerm).get('/test').set('Authorization', 'Bearer valid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('should pass through if valid token and user has required permission', async () => {
    (verifyToken as jest.Mock).mockResolvedValue({ id: 1, disabled: false, permissions: ['read'] });
    const appPerm = express();
    appPerm.use((req, res, next) => {
      req.requiredPermissions = ['read'];
      next();
    });
    appPerm.use(authMiddleware);
    appPerm.get('/test', (req, res) => res.json({ user: req.user }));
    const res = await request(appPerm).get('/test').set('Authorization', 'Bearer valid');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 1, disabled: false, permissions: ['read'] });
  });
});
