import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { BOOK_STATUSES, MOOD_TAGS, type BookStatus, type MoodTag } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { isRestoreWindowOpen, normalizeMoodTags, normalizeText, validateStatusTransition } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';

const nullableText = (max: number) =>
  z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

function isValidIsbn(value: string): boolean {
  const isbn = value.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((acc, char, index) => acc + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce(
      (acc, char, index) => acc + Number(char) * (index % 2 === 0 ? 1 : 3),
      0
    );
    return sum % 10 === 0;
  }
  return false;
}

const isbnSchema = z.preprocess(
  (value) => (value === '' || value === null ? null : String(value).replace(/[-\s]/g, '').toUpperCase()),
  z
    .string()
    .max(20)
    .refine(isValidIsbn, '请输入有效的 ISBN-10 或 ISBN-13')
    .nullable()
    .optional()
);

const createBookSchema = z.object({
  title: z.string().trim().min(1, '请输入书名').max(300),
  author: nullableText(300),
  publisher: nullableText(300),
  publicationYear: z.number().int().min(1000).max(new Date().getFullYear()).nullable().optional(),
  isbn: isbnSchema,
  pageCount: z.number().int().min(1).max(100_000).nullable().optional(),
  coverUrl: z
    .preprocess(
      (value) => (value === '' ? null : value),
      z
        .string()
        .url('封面地址无效')
        .refine((value) => value.startsWith('http://') || value.startsWith('https://'), '仅支持 http/https 地址')
        .nullable()
        .optional()
    ),
  status: z.enum(['TO_READ', 'READING', 'PAUSED', 'ABANDONED']).default('TO_READ')
});

const updateBookSchema = createBookSchema.omit({ status: true }).partial().extend({
  version: z.number().int().positive().optional()
}).refine((value) => Object.keys(value).some((key) => key !== 'version'), {
  message: '至少提供一个要更新的字段'
});

const reflectionInputSchema = z.object({
  moodTags: z.array(z.enum(MOOD_TAGS as [MoodTag, ...MoodTag[]])).min(1).max(3),
  text: z.string().max(5000).optional().default(''),
  completedAt: z.string().datetime({ offset: true }).optional()
});

const statusSchema = z.object({
  status: z.enum(BOOK_STATUSES as [BookStatus, ...BookStatus[]]),
  version: z.number().int().positive().optional(),
  reflection: reflectionInputSchema.optional()
});

function serializeReflection(reflection: {
  id: string;
  bookId: string;
  completionRound: number;
  moodTags: MoodTag[];
  reflection: string | null;
  completedAt: Date;
  editableUntil: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: reflection.id,
    bookId: reflection.bookId,
    completionRound: reflection.completionRound,
    moodTags: reflection.moodTags,
    text: reflection.reflection ?? '',
    completedAt: reflection.completedAt,
    editableUntil: reflection.editableUntil,
    version: reflection.version,
    createdAt: reflection.createdAt,
    updatedAt: reflection.updatedAt
  };
}

function serializeBook(book: {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  publicationYear: number | null;
  isbn: string | null;
  pageCount: number | null;
  coverUrl: string | null;
  status: BookStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    publicationYear: book.publicationYear,
    isbn: book.isbn,
    pageCount: book.pageCount,
    coverUrl: book.coverUrl,
    status: book.status,
    version: book.version,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt
  };
}

async function maximumTracePage(userId: string, bookId: string): Promise<number> {
  const [dogEar, annotation, reread] = await Promise.all([
    prisma.dogEar.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { pageNumber: true } }),
    prisma.annotation.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { endPage: true } }),
    prisma.rereadMark.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { pageNumber: true } })
  ]);
  return Math.max(
    dogEar._max.pageNumber ?? 0,
    annotation._max.endPage ?? 0,
    reread._max.pageNumber ?? 0
  );
}

export const bookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books', async (request) => {
    const { page, pageSize, skip } = paginationFromQuery(request);
    const query = request.query as Record<string, unknown>;
    const status = typeof query.status === 'string' && query.status !== 'ALL' ? query.status : undefined;
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const userId = currentUser(request).id;

    if (status && !BOOK_STATUSES.includes(status as BookStatus)) {
      throw new AppError(422, 'VALIDATION_ERROR', '书目状态无效');
    }

    const where: Prisma.BookWhereInput = {
      userId,
      deletedAt: null,
      ...(status ? { status: status as BookStatus } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { author: { contains: search, mode: 'insensitive' } }
            ]
          }
        : {})
    };

    const [total, books] = await Promise.all([
      prisma.book.count({ where }),
      prisma.book.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          _count: {
            select: {
              dogEars: { where: { deletedAt: null } },
              annotations: { where: { deletedAt: null } },
              rereadMarks: { where: { deletedAt: null } },
              reflections: { where: { deletedAt: null } }
            }
          }
        }
      })
    ]);

    const ids = books.map((book) => book.id);
    const latestEvents = ids.length
      ? await prisma.activityEvent.groupBy({
          by: ['bookId'],
          where: {
            userId,
            bookId: { in: ids },
            entityType: { in: ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'] },
            action: { in: ['CREATED', 'UPDATED', 'RESTORED'] }
          },
          _max: { occurredAt: true }
        })
      : [];
    const latestMap = new Map(latestEvents.map((event) => [event.bookId, event._max.occurredAt]));

    return {
      items: books.map((book) => ({
        ...serializeBook(book),
        traceSummary: {
          dogEars: book._count.dogEars,
          annotations: book._count.annotations,
          rereadMarks: book._count.rereadMarks
        },
        hasCompletionReflection: book._count.reflections > 0,
        lastTraceAt: latestMap.get(book.id) ?? null
      })),
      pagination: { page, pageSize, total }
    };
  });

  app.post('/books', async (request, reply) => {
    const parsed = createBookSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '书目信息无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const data = parsed.data;
    const book = await prisma.$transaction(async (tx) => {
      const created = await tx.book.create({
        data: {
          userId,
          title: normalizeText(data.title),
          author: data.author ? normalizeText(data.author) : null,
          publisher: data.publisher ? normalizeText(data.publisher) : null,
          publicationYear: data.publicationYear ?? null,
          isbn: data.isbn ?? null,
          pageCount: data.pageCount ?? null,
          coverUrl: data.coverUrl ?? null,
          status: data.status
        }
      });
      await writeEvent(tx, {
        userId,
        bookId: created.id,
        entityType: 'BOOK',
        entityId: created.id,
        action: 'CREATED',
        payload: { bookTitle: created.title, status: created.status }
      });
      return created;
    });
    return reply.status(201).send({ book: serializeBook(book) });
  });

  app.get('/books/:bookId', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({
      where: { id: bookId, userId, deletedAt: null },
      include: {
        _count: {
          select: {
            dogEars: { where: { deletedAt: null } },
            annotations: { where: { deletedAt: null } },
            rereadMarks: { where: { deletedAt: null } },
            reflections: { where: { deletedAt: null } }
          }
        },
        reflections: {
          where: { deletedAt: null },
          orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }]
        }
      }
    });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');

    return {
      book: {
        ...serializeBook(book),
        traceSummary: {
          dogEars: book._count.dogEars,
          annotations: book._count.annotations,
          rereadMarks: book._count.rereadMarks
        },
        reflections: book.reflections.map(serializeReflection)
      }
    };
  });

  app.patch('/books/:bookId', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = updateBookSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '书目信息无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    if (parsed.data.version && parsed.data.version !== existing.version) {
      throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
    }
    if (parsed.data.pageCount !== undefined && parsed.data.pageCount !== null) {
      const maxPage = await maximumTracePage(userId, bookId);
      if (parsed.data.pageCount < maxPage) {
        throw new AppError(409, 'PAGE_COUNT_TOO_SMALL', `总页数不能小于已有痕迹的最大页码 ${maxPage}`);
      }
    }

    const data: Prisma.BookUpdateManyMutationInput = {};
    if (parsed.data.title !== undefined) data.title = normalizeText(parsed.data.title);
    if (parsed.data.author !== undefined) data.author = parsed.data.author ? normalizeText(parsed.data.author) : null;
    if (parsed.data.publisher !== undefined) data.publisher = parsed.data.publisher ? normalizeText(parsed.data.publisher) : null;
    if (parsed.data.publicationYear !== undefined) data.publicationYear = parsed.data.publicationYear;
    if (parsed.data.isbn !== undefined) data.isbn = parsed.data.isbn;
    if (parsed.data.pageCount !== undefined) data.pageCount = parsed.data.pageCount;
    if (parsed.data.coverUrl !== undefined) data.coverUrl = parsed.data.coverUrl;

    if (Object.keys(data).length === 0) return { book: serializeBook(existing) };

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.book.updateMany({
        where: { id: bookId, userId, deletedAt: null, version: existing.version },
        data: { ...data, version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'UPDATED',
        payload: {
          bookTitle: normalizeText(parsed.data.title ?? existing.title),
          previousStatus: existing.status,
        }
      });
      return tx.book.findUniqueOrThrow({ where: { id: bookId } });
    });
    return { book: serializeBook(result) };
  });

  app.patch('/books/:bookId/status', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '状态信息无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
      const book = await tx.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
      if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
      if (parsed.data.version && parsed.data.version !== book.version) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      validateStatusTransition(book.status, parsed.data.status);
      if (book.status === parsed.data.status) {
        return { book, reflection: null };
      }

      if (parsed.data.status === 'READ') {
        if (!parsed.data.reflection) {
          throw new AppError(422, 'COMPLETION_REQUIRED', '标记读完时必须记录完成感受', {
            reflection: '请选择情绪标签'
          });
        }
        const moodTags = normalizeMoodTags(parsed.data.reflection.moodTags);
        const completedAt = parsed.data.reflection.completedAt
          ? new Date(parsed.data.reflection.completedAt)
          : new Date();
        if (
          completedAt.getTime() < book.createdAt.getTime() ||
          completedAt.getTime() > Date.now() + 5 * 60 * 1000
        ) {
          throw new AppError(422, 'VALIDATION_ERROR', '完成时间无效', {
            completedAt: '完成时间不能早于建书时间或晚于当前时间'
          });
        }
        const latest = await tx.completionReflection.aggregate({
          where: { bookId },
          _max: { completionRound: true }
        });
        const completionRound = (latest._max.completionRound ?? 0) + 1;
        const now = new Date();
        const reflection = await tx.completionReflection.create({
          data: {
            userId,
            bookId,
            completionRound,
            moodTags,
            reflection: parsed.data.reflection.text ? normalizeText(parsed.data.reflection.text) : null,
            completedAt,
            editableUntil: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            createdAt: now
          }
        });
        const updated = await tx.book.update({
          where: { id: bookId },
          data: { status: 'READ', version: { increment: 1 } }
        });
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: 'BOOK',
          entityId: bookId,
          action: 'STATUS_CHANGED',
          payload: { previousStatus: book.status, nextStatus: 'READ', completionRound }
        });
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: 'COMPLETION_REFLECTION',
          entityId: reflection.id,
          action: 'COMPLETED',
          payload: { moodTags, completionRound }
        });
        return { book: updated, reflection: serializeReflection(reflection) };
      }

      const updated = await tx.book.update({
        where: { id: bookId },
        data: { status: parsed.data.status, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'STATUS_CHANGED',
        payload: { previousStatus: book.status, nextStatus: parsed.data.status }
      });
      return { book: updated, reflection: null };
    });
    return {
      book: serializeBook(result.book),
      ...(result.reflection ? { reflection: result.reflection } : {})
    };
  });

  app.delete('/books/:bookId', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    // version 为可选项：旧页面删除时不带版本，也必须放行，不能让整本书脱离可控软删。
    const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();
    const parsed = deleteSchema.safeParse(request.body ?? undefined);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    }
    const requestedVersion = parsed.data?.version;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
      const book = await tx.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
      if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
      // version 为可选项：旧页面删除时不带版本，也必须放行，不能让整本书脱离可控软删。
      if (requestedVersion && requestedVersion !== book.version) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      const now = new Date();
      // 只级联当前仍有效的子记录；此前已单独删除的记录保持其自身删除时间，不被算作随书删除。
      const [dogEars, annotations, rereadMarks, reflections] = await Promise.all([
        tx.dogEar.findMany({ where: { bookId, deletedAt: null, cascadeDeletedAt: null }, select: { id: true, pageNumber: true } }),
        tx.annotation.findMany({ where: { bookId, deletedAt: null, cascadeDeletedAt: null }, select: { id: true, startPage: true, endPage: true } }),
        tx.rereadMark.findMany({ where: { bookId, deletedAt: null, cascadeDeletedAt: null }, select: { id: true, pageNumber: true } }),
        tx.completionReflection.findMany({ where: { bookId, deletedAt: null, cascadeDeletedAt: null }, select: { id: true, completionRound: true } })
      ]);
      await Promise.all([
        tx.dogEar.updateMany({
          where: { bookId, deletedAt: null, cascadeDeletedAt: null },
          data: { deletedAt: now, cascadeDeletedAt: now, version: { increment: 1 } }
        }),
        tx.annotation.updateMany({
          where: { bookId, deletedAt: null, cascadeDeletedAt: null },
          data: { deletedAt: now, cascadeDeletedAt: now, version: { increment: 1 } }
        }),
        tx.rereadMark.updateMany({
          where: { bookId, deletedAt: null, cascadeDeletedAt: null },
          data: { deletedAt: now, cascadeDeletedAt: now, version: { increment: 1 } }
        }),
        tx.completionReflection.updateMany({
          where: { bookId, deletedAt: null, cascadeDeletedAt: null },
          data: { deletedAt: now, cascadeDeletedAt: now, version: { increment: 1 } }
        })
      ]);
      const updated = await tx.book.updateMany({
        where: { id: bookId, userId, deletedAt: null, ...(requestedVersion ? { version: book.version } : {}) },
        data: { deletedAt: now, version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      // 审计不回抹：书与每条子记录的级联删除都进入时间线，恢复时再写恢复事件。
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'DELETED',
        payload: {
          bookTitle: book.title,
          cascade: {
            dogEars: dogEars.length,
            annotations: annotations.length,
            rereadMarks: rereadMarks.length,
            reflections: reflections.length
          }
        }
      });
      const childEvents = [
        ...dogEars.map((item) => ({ entityType: 'DOG_EAR' as const, id: item.id, payload: { pageNumber: item.pageNumber, cascade: true } })),
        ...annotations.map((item) => ({ entityType: 'ANNOTATION' as const, id: item.id, payload: { startPage: item.startPage, endPage: item.endPage, cascade: true } })),
        ...rereadMarks.map((item) => ({ entityType: 'REREAD_MARK' as const, id: item.id, payload: { pageNumber: item.pageNumber, cascade: true } })),
        ...reflections.map((item) => ({ entityType: 'COMPLETION_REFLECTION' as const, id: item.id, payload: { completionRound: item.completionRound, cascade: true } }))
      ];
      for (const child of childEvents) {
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: child.entityType,
          entityId: child.id,
          action: 'DELETED',
          payload: child.payload
        });
      }
    });
    return reply.status(204).send();
  });

  // 回收站：列出当前用户在 24 小时恢复窗口内软删的书目。
  app.get('/books/deleted', async (request) => {
    const userId = currentUser(request).id;
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const books = await prisma.book.findMany({
      where: { userId, deletedAt: { not: null, gte: windowStart } },
      orderBy: { deletedAt: 'desc' }
    });
    return {
      items: books.map((book) => ({
        ...serializeBook(book),
        deletedAt: book.deletedAt,
        restorableUntil: new Date(book.deletedAt!.getTime() + 24 * 60 * 60 * 1000)
      }))
    };
  });

  // 恢复整本书：把随书级联删除的痕迹与感受一并恢复，恢复完整影响链。
  app.post('/books/:bookId/restore', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
      const book = await tx.book.findFirst({ where: { id: bookId, userId } });
      if (!book || !book.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除书目不存在');
      if (!isRestoreWindowOpen(book.deletedAt)) {
        throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
      }

      const [dogEars, annotations, rereadMarks, reflections] = await Promise.all([
        tx.dogEar.findMany({ where: { bookId, cascadeDeletedAt: { not: null } }, select: { id: true, pageNumber: true } }),
        tx.annotation.findMany({ where: { bookId, cascadeDeletedAt: { not: null } }, select: { id: true } }),
        tx.rereadMark.findMany({ where: { bookId, cascadeDeletedAt: { not: null } }, select: { id: true } }),
        tx.completionReflection.findMany({ where: { bookId, cascadeDeletedAt: { not: null } }, select: { id: true, completionRound: true } })
      ]);

      // 折角：同页若已存在有效折角（书被删期间新建），则该条不恢复，避免唯一约束冲突。
      const restoredDogEarIds: string[] = [];
      for (const dogEar of dogEars) {
        const blocked = await tx.dogEar.findFirst({
          where: { bookId, pageNumber: dogEar.pageNumber, deletedAt: null, id: { not: dogEar.id } }
        });
        if (blocked) continue;
        await tx.dogEar.update({
          where: { id: dogEar.id },
          data: { deletedAt: null, cascadeDeletedAt: null, version: { increment: 1 } }
        });
        restoredDogEarIds.push(dogEar.id);
      }

      // 批注与重读页不存在同页唯一约束，直接恢复。
      const restoredAnnotationIds = annotations.map((item) => item.id);
      const restoredRereadIds = rereadMarks.map((item) => item.id);
      const [restoredAnnotations, restoredRereads] = await Promise.all([
        tx.annotation.updateMany({
          where: { id: { in: restoredAnnotationIds } },
          data: { deletedAt: null, cascadeDeletedAt: null, version: { increment: 1 } }
        }),
        tx.rereadMark.updateMany({
          where: { id: { in: restoredRereadIds } },
          data: { deletedAt: null, cascadeDeletedAt: null, version: { increment: 1 } }
        })
      ]);

      // 感受：同一完成轮次若已有有效感受（部分唯一索引），跳过该条；
      // 书被删期间产生了更新轮次时，旧轮次同样跳过恢复。
      const restoredReflectionIds: string[] = [];
      for (const reflection of reflections.sort((a, b) => a.completionRound - b.completionRound)) {
        const blockedByRound = await tx.completionReflection.findFirst({
          where: { bookId, deletedAt: null, completionRound: { gte: reflection.completionRound }, id: { not: reflection.id } }
        });
        if (blockedByRound) continue;
        await tx.completionReflection.update({
          where: { id: reflection.id },
          data: { deletedAt: null, cascadeDeletedAt: null, version: { increment: 1 } }
        });
        restoredReflectionIds.push(reflection.id);
      }

      const restored = await tx.book.update({
        where: { id: bookId },
        data: { deletedAt: null, version: { increment: 1 } }
      });

      // 若书被删前处于已读完，却没有任何有效感受可以随书回来，则回到阅读中，
      // 与“删除最新感受会回到阅读中”的既有规则保持一致。
      if (book.status === 'READ') {
        const activeReflectionCount = await tx.completionReflection.count({ where: { bookId, deletedAt: null } });
        if (activeReflectionCount === 0) {
          await tx.book.update({
            where: { id: bookId },
            data: { status: 'READING', version: { increment: 1 } }
          });
          await writeEvent(tx, {
            userId,
            bookId,
            entityType: 'BOOK',
            entityId: bookId,
            action: 'STATUS_CHANGED',
            payload: { previousStatus: 'READ', nextStatus: 'READING', reason: 'book_restored_without_reflection' }
          });
        }
      }

      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'RESTORED',
        payload: {
          bookTitle: restored.title,
          restored: {
            dogEars: restoredDogEarIds.length,
            annotations: restoredAnnotations.count,
            rereadMarks: restoredRereads.count,
            reflections: restoredReflectionIds.length
          },
          skipped: {
            dogEars: dogEars.length - restoredDogEarIds.length,
            annotations: annotations.length - restoredAnnotations.count,
            rereadMarks: rereadMarks.length - restoredRereads.count,
            reflections: reflections.length - restoredReflectionIds.length
          }
        }
      });
      const restoredEvents: Array<{ entityType: 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK' | 'COMPLETION_REFLECTION'; id: string }> = [
        ...restoredDogEarIds.map((id) => ({ entityType: 'DOG_EAR' as const, id })),
        ...(restoredAnnotations.count ? restoredAnnotationIds.map((id) => ({ entityType: 'ANNOTATION' as const, id })) : []),
        ...(restoredRereads.count ? restoredRereadIds.map((id) => ({ entityType: 'REREAD_MARK' as const, id })) : []),
        ...restoredReflectionIds.map((id) => ({ entityType: 'COMPLETION_REFLECTION' as const, id }))
      ];
      for (const child of restoredEvents) {
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: child.entityType,
          entityId: child.id,
          action: 'RESTORED',
          payload: { cascade: true }
        });
      }
      return tx.book.findUniqueOrThrow({ where: { id: bookId } });
    });
    return { book: serializeBook(result) };
  });
};
