import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, mapPrismaError, sendError, zodFields } from '../src/lib/errors.js';

const { prismaMock, authUser } = vi.hoisted(() => {
  const authUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'reader@example.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  };
  const prismaMock: Record<string, any> = {
    $queryRaw: vi.fn(async () => []),
    book: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dogEar: { findMany: vi.fn(), updateMany: vi.fn() },
    annotation: { findMany: vi.fn(), updateMany: vi.fn() },
    rereadMark: { findMany: vi.fn(), updateMany: vi.fn() },
    completionReflection: { findMany: vi.fn(), updateMany: vi.fn() },
    activityEvent: { create: vi.fn(async () => ({})) }
  };
  prismaMock.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  return { prismaMock, authUser };
});

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/lib/auth.js', () => ({
  requireAuth: async (request: Record<string, unknown>) => {
    request.authUser = authUser;
  },
  currentUser: (request: Record<string, unknown>) => request.authUser
}));

import { bookRoutes } from '../src/modules/books/routes.js';

const BOOK_ID = '22222222-2222-4222-8222-222222222222';

function bookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    userId: authUser.id,
    title: '被删除的书',
    author: null,
    publisher: null,
    publicationYear: null,
    isbn: null,
    pageCount: 300,
    coverUrl: null,
    status: 'READING',
    version: 3,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    deletedAt: null,
    ...overrides
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.statusCode, error.code, error.message, error.fields, request.id);
    }
    if (error instanceof ZodError) {
      return sendError(reply, 422, 'VALIDATION_ERROR', '请求参数无效', zodFields(error), request.id);
    }
    if (mapPrismaError(error, reply)) return;
    request.log.error(error);
    return sendError(reply, 500, 'INTERNAL_ERROR', '服务器暂时无法处理请求', undefined, request.id);
  });
  await app.register(bookRoutes, { prefix: '/api/v1' });
  return app;
}

function mockCascadeChildren() {
  prismaMock.dogEar.findMany.mockResolvedValue([{ id: 'de-1' }, { id: 'de-2' }]);
  prismaMock.annotation.findMany.mockResolvedValue([{ id: 'an-1' }]);
  prismaMock.rereadMark.findMany.mockResolvedValue([{ id: 'rr-1' }]);
  prismaMock.completionReflection.findMany.mockResolvedValue([{ id: 'cr-1' }]);
  prismaMock.dogEar.updateMany.mockResolvedValue({ count: 2 });
  prismaMock.annotation.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.rereadMark.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.completionReflection.updateMany.mockResolvedValue({ count: 1 });
}

describe('DELETE /api/v1/books/:bookId', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it('旧页面不带版本号时拒绝删除（无请求体）', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/api/v1/books/${BOOK_ID}` });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('旧页面不带版本号时拒绝删除（请求体缺少 version）', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${BOOK_ID}`,
      payload: {}
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('版本号落后于当前书目时返回 409，不触碰任何痕迹', async () => {
    prismaMock.book.findFirst.mockResolvedValue(bookRow());
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${BOOK_ID}`,
      payload: { version: 1 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STALE_WRITE');
    expect(prismaMock.book.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.dogEar.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.activityEvent.create).not.toHaveBeenCalled();
  });

  it('书目不存在时返回 404', async () => {
    prismaMock.book.findFirst.mockResolvedValue(null);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${BOOK_ID}`,
      payload: { version: 3 }
    });
    expect(response.statusCode).toBe(404);
  });

  it('版本匹配时软删除整本书并记录完整影响链', async () => {
    prismaMock.book.findFirst.mockResolvedValue(bookRow());
    mockCascadeChildren();
    prismaMock.book.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${BOOK_ID}`,
      payload: { version: 3 }
    });
    expect(response.statusCode).toBe(204);

    const bookUpdate = prismaMock.book.updateMany.mock.calls[0][0];
    expect(bookUpdate.where).toMatchObject({ id: BOOK_ID, userId: authUser.id, deletedAt: null, version: 3 });
    expect(bookUpdate.data.deletedAt).toBeInstanceOf(Date);
    expect(bookUpdate.data.version).toEqual({ increment: 1 });

    // 级联子记录与书目共享同一 deletedAt，供恢复时识别完整影响链
    for (const child of ['dogEar', 'annotation', 'rereadMark', 'completionReflection']) {
      const childUpdate = prismaMock[child].updateMany.mock.calls[0][0];
      expect(childUpdate.where).toMatchObject({ bookId: BOOK_ID, deletedAt: null });
      expect(childUpdate.data.deletedAt).toBe(bookUpdate.data.deletedAt);
    }

    const events = prismaMock.activityEvent.create.mock.calls.map((call) => call[0].data);
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({
      entityType: 'BOOK',
      entityId: BOOK_ID,
      action: 'DELETED',
      payloadJson: {
        bookTitle: '被删除的书',
        affected: { dogEars: 2, annotations: 1, rereadMarks: 1, reflections: 1 }
      }
    });
    const cascadeEvents = events.slice(1);
    expect(cascadeEvents.map((event) => event.entityType)).toEqual([
      'DOG_EAR',
      'DOG_EAR',
      'ANNOTATION',
      'REREAD_MARK',
      'COMPLETION_REFLECTION'
    ]);
    for (const event of cascadeEvents) {
      expect(event.action).toBe('DELETED');
      expect(event.payloadJson).toEqual({ cascade: true });
    }
  });

  it('删除期间版本被并发修改时返回 409', async () => {
    prismaMock.book.findFirst.mockResolvedValue(bookRow());
    mockCascadeChildren();
    prismaMock.book.updateMany.mockResolvedValue({ count: 0 });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${BOOK_ID}`,
      payload: { version: 3 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STALE_WRITE');
  });
});

describe('POST /api/v1/books/:bookId/restore', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it('书目未删除时返回 404', async () => {
    prismaMock.book.findFirst.mockResolvedValue(bookRow());
    const response = await app.inject({ method: 'POST', url: `/api/v1/books/${BOOK_ID}/restore` });
    expect(response.statusCode).toBe(404);
  });

  it('书目不存在时返回 404', async () => {
    prismaMock.book.findFirst.mockResolvedValue(null);
    const response = await app.inject({ method: 'POST', url: `/api/v1/books/${BOOK_ID}/restore` });
    expect(response.statusCode).toBe(404);
  });

  it('超过 24 小时恢复窗口时返回 409', async () => {
    const deletedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    prismaMock.book.findFirst.mockResolvedValue(bookRow({ deletedAt }));
    const response = await app.inject({ method: 'POST', url: `/api/v1/books/${BOOK_ID}/restore` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('RESTORE_WINDOW_EXPIRED');
    expect(prismaMock.book.update).not.toHaveBeenCalled();
  });

  it('恢复书目时连同级联删除的痕迹、感受与审计一起恢复', async () => {
    const deletedAt = new Date(Date.now() - 60 * 60 * 1000);
    prismaMock.book.findFirst.mockResolvedValue(bookRow({ deletedAt }));
    mockCascadeChildren();
    prismaMock.book.update.mockImplementation(async ({ data }: any) =>
      bookRow({ deletedAt: data.deletedAt, version: 4 })
    );

    const response = await app.inject({ method: 'POST', url: `/api/v1/books/${BOOK_ID}/restore` });
    expect(response.statusCode).toBe(200);
    expect(response.json().book).toMatchObject({ id: BOOK_ID, version: 4 });

    // 只恢复与书目同一 deletedAt 的级联记录，兼容历史删除；单独删除的记录不受影响
    for (const child of ['dogEar', 'annotation', 'rereadMark', 'completionReflection']) {
      const findFilter = prismaMock[child].findMany.mock.calls[0][0].where;
      expect(findFilter).toEqual({ bookId: BOOK_ID, deletedAt });
      const childUpdate = prismaMock[child].updateMany.mock.calls[0][0];
      expect(childUpdate.where).toEqual({ bookId: BOOK_ID, deletedAt });
      expect(childUpdate.data).toEqual({ deletedAt: null, version: { increment: 1 } });
    }

    const bookUpdate = prismaMock.book.update.mock.calls[0][0];
    expect(bookUpdate.where).toEqual({ id: BOOK_ID });
    expect(bookUpdate.data).toEqual({ deletedAt: null, version: { increment: 1 } });

    const events = prismaMock.activityEvent.create.mock.calls.map((call) => call[0].data);
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({
      entityType: 'BOOK',
      entityId: BOOK_ID,
      action: 'RESTORED',
      payloadJson: {
        bookTitle: '被删除的书',
        affected: { dogEars: 2, annotations: 1, rereadMarks: 1, reflections: 1 }
      }
    });
    const cascadeEvents = events.slice(1);
    expect(cascadeEvents.map((event) => event.entityType)).toEqual([
      'DOG_EAR',
      'DOG_EAR',
      'ANNOTATION',
      'REREAD_MARK',
      'COMPLETION_REFLECTION'
    ]);
    for (const event of cascadeEvents) {
      expect(event.action).toBe('RESTORED');
      expect(event.payloadJson).toEqual({ cascade: true });
    }
  });
});
