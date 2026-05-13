import { PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';

const prismaMock = mockDeep<PrismaClient>();
export default prismaMock;
export type { DeepMockProxy };
