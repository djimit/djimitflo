import { seed } from '../../database/seed';
import { prismaMock } from '../mocks/prisma';

describe('database/seed.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should insert seed data with integrity', async () => {
    // Mock the database calls within seed
    // Assume seed uses prisma.user.createMany, etc.
    prismaMock.user.createMany.mockResolvedValue({ count: 1 });
    prismaMock.policy.createMany.mockResolvedValue({ count: 1 });
    prismaMock.mcpServer.createMany.mockResolvedValue({ count: 1 });

    await seed();

    expect(prismaMock.user.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.policy.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.mcpServer.createMany).toHaveBeenCalledTimes(1);
  });

  it('should be idempotent on re-seeding', async () => {
    // Simulate re-seed: seed function should check existence or use upsert
    prismaMock.user.findMany.mockResolvedValue([{ id: 'existing' }]);
    prismaMock.policy.findMany.mockResolvedValue([{ id: 'existing' }]);

    await seed();
    await seed();

    // Should not create duplicates; assume it uses upsert or skip
    expect(prismaMock.user.createMany).not.toHaveBeenCalled();
    expect(prismaMock.policy.createMany).not.toHaveBeenCalled();
  });

  it('should respect foreign key constraints by inserting in correct order', async () => {
    // Ensure parent records (e.g., users) are inserted before dependent records (policies)
    const order: string[] = [];
    prismaMock.user.createMany.mockImplementation(() => {
      order.push('user');
      return { count: 1 };
    });
    prismaMock.policy.createMany.mockImplementation(() => {
      order.push('policy');
      return { count: 1 };
    });

    await seed();

    expect(order).toEqual(['user', 'policy']);
  });

  it('should create default policies if none exist', async () => {
    prismaMock.policy.findMany.mockResolvedValue([]);
    prismaMock.policy.createMany.mockResolvedValue({ count: 1 });

    await seed();

    expect(prismaMock.policy.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ name: 'default' })
        ])
      })
    );
  });
});
