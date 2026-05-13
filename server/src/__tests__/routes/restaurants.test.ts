import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import restaurantsRouter from '../../routes/restaurants';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/restaurants', restaurantsRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

const fakeRestaurant = {
  id: 1,
  name: 'Burger Joint',
  googlePlaceId: null,
  cuisineType: 'American',
  priceLevel: 2,
  hours: '11am–10pm',
  phone: null,
  website: null,
  yelpUrl: null,
  takeout: true,
  delivery: false,
  googleRating: null,
  createdBy: 1,
  createdAt: new Date(),
};

describe('GET /api/restaurants', () => {
  it('returns a paginated list of restaurants', async () => {
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([fakeRestaurant]);
    (mockPrisma.restaurant.count as jest.Mock).mockResolvedValue(1);

    const res = await request(buildApp()).get('/api/restaurants');

    expect(res.status).toBe(200);
    expect(res.body.restaurants).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/restaurants/:id', () => {
  it('returns 200 with the restaurant when found', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(fakeRestaurant);

    const res = await request(buildApp()).get('/api/restaurants/1');

    expect(res.status).toBe(200);
    expect(res.body.restaurant.name).toBe('Burger Joint');
  });

  it('returns 404 when restaurant does not exist', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/restaurants/999');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/restaurants', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await request(buildApp())
      .post('/api/restaurants')
      .send({ name: 'New Place' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(400);
  });

  it('creates a restaurant and returns 201', async () => {
    (mockPrisma.restaurant.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.restaurant.create as jest.Mock).mockResolvedValue(fakeRestaurant);

    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({ name: 'Burger Joint' });

    expect(res.status).toBe(201);
    expect(res.body.restaurant.name).toBe('Burger Joint');
  });

  it('returns the existing restaurant when name already exists (case-insensitive)', async () => {
    (mockPrisma.restaurant.findFirst as jest.Mock).mockResolvedValue(fakeRestaurant);

    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({ name: 'burger joint' });

    expect(res.status).toBe(201);
    expect(mockPrisma.restaurant.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/restaurants/:id/reviews', () => {
  it('returns reviews and community rating', async () => {
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.review.aggregate as jest.Mock).mockResolvedValue({ _avg: { rating: null }, _count: 0 });
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/restaurants/1/reviews');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reviews');
    expect(res.body).toHaveProperty('communityRating');
    expect(res.body.averageRating).toBeNull();
    expect(res.body.total).toBe(0);
  });
});
