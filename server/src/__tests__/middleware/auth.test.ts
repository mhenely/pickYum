import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../middleware/auth';

const SECRET = process.env.JWT_SECRET!;

const makeReq = (token?: string) =>
  ({ cookies: token ? { token } : {} }) as unknown as Request;

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
};

describe('requireAuth middleware', () => {
  it('calls next() and sets req.userId when token is valid', () => {
    const token = jwt.sign({ userId: 42 }, SECRET);
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe(42);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when no cookie is present', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token string is invalid', () => {
    const req = makeReq('not-a-real-jwt');
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with the wrong secret', () => {
    const token = jwt.sign({ userId: 1 }, 'wrong-secret');
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is expired', () => {
    const token = jwt.sign({ userId: 1 }, SECRET, { expiresIn: -1 });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
