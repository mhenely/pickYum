import rateLimit from 'express-rate-limit';

// Skip rate limiting under test so supertest spam doesn't trip the limiter
// across the suite. Real traffic still limits normally.
const skipInTest = () => process.env.NODE_ENV === 'test';

// General write limiter for mutating endpoints. Liberal enough for normal use,
// tight enough to slow abuse. Applied as middleware that only counts non-GET.
export const writeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => skipInTest() || req.method === 'GET',
  message: { error: 'Too many write requests, please slow down' },
});

// Stricter limiter for endpoints that hit external paid APIs (Google Places).
export const externalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'External API budget reached, please try again later' },
});
