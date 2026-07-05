import { seedMcpServers } from '../../database/seed-mcp-servers';
import { prismaMock } from '../mocks/prisma';

describe('database/seed-mcp-servers.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should insert MCP server seed data with integrity', async () => {
    prismaMock.mcpServer.createMany.mockResolvedValue({ count: 2 });
    prismaMock.mcpServerCategory.createMany.mockResolvedValue({ count: 2 });

    await seedMcpServers();

    expect(prismaMock.mcpServer.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.mcpServerCategory.createMany).toHaveBeenCalledTimes(1);
  });

  it('should be idempotent on re-seeding', async () => {
    prismaMock.mcpServer.findMany.mockResolvedValue([{ id: 'existing' }]);
    prismaMock.mcpServerCategory.findMany.mockResolvedValue([{ id: 'existing-cat' }]);

    await seedMcpServers();
    await seedMcpServers();

    expect(prismaMock.mcpServer.createMany).not.toHaveBeenCalled();
    expect(prismaMock.mcpServerCategory.createMany).not.toHaveBeenCalled();
  });

  it('should ensure foreign key constraints between categories and servers', async () => {
    const order: string[] = [];
    prismaMock.mcpServerCategory.createMany.mockImplementation(() => {
      order.push('category');
      return { count: 1 };
    });
    prismaMock.mcpServer.createMany.mockImplementation(() => {
      order.push('server');
      return { count: 1 };
    });

    await seedMcpServers();

    expect(order).toEqual(['category', 'server']);
  });

  it('should not create servers without valid category reference', async () => {
    // If category insertion fails, servers should not be created
    prismaMock.mcpServerCategory.createMany.mockRejectedValue(new Error('FK constraint'));

    await expect(seedMcpServers()).rejects.toThrow('FK constraint');
    expect(prismaMock.mcpServer.createMany).not.toHaveBeenCalled();
  });
});
