import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MOOD_TAGS, type MoodTag } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { isStrictlyEditable, normalizeMoodTags, normalizeText } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';

const updateSchema = z
  .object({
    moodTags: z.array(z.enum(MOOD_TAGS as [MoodTag, ...MoodTag[]])).min(1).max(3).optional(),
    text: z.string().max(5000).optional(),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.moodTags !== undefined || value.text !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();

function serialize(item: {
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
    id: item.id,
    bookId: item.bookId,
    completionRound: item.completionRound,
    moodTags: item.moodTags,
    text: item.reflection ?? '',
    completedAt: item.completedAt,
    editableUntil: item.editableUntil,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function assertVersion(current: number, requested?: number): void {
  if (requested && requested !== current) {
    throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改，请刷新后重试');
  }
}

export const reflectionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/reflections', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    const reflections = await prisma.completionReflection.findMany({
      where: { bookId, userId, deletedAt: null },
      orderBy: [{ completionRound: 'desc' }]
    });
    return { items: reflections.map(serialize) };
  });

  app.patch('/reflections/:reflectionId', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '完成感受信息无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期');
    }
    assertVersion(existing.version, parsed.data.version);
    const moodTags = parsed.data.moodTags ? normalizeMoodTags(parsed.data.moodTags) : existing.moodTags;
    const reflection =
      parsed.data.text === undefined
        ? existing.reflection
        : parsed.data.text
          ? normalizeText(parsed.data.text)
          : null;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { moodTags, reflection, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'UPDATED',
        payload: {
          completionRound: existing.completionRound,
          moodTags,
          summary: reflection ? reflection.slice(0, 120) : ''
        }
      });
      return tx.completionReflection.findUniqueOrThrow({ where: { id } });
    });
    return { reflection: serialize(updated) };
  });

  app.delete('/reflections/:reflectionId', async (request, reply) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期');
    }
    assertVersion(existing.version, parsed.data?.version);

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${existing.bookId}::uuid FOR UPDATE`;
      const currentBook = await tx.book.findFirstOrThrow({ where: { id: existing.bookId } });
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'DELETED',
        payload: { completionRound: existing.completionRound }
      });
      const latestActive = await tx.completionReflection.aggregate({
        where: { bookId: existing.bookId, deletedAt: null },
        _max: { completionRound: true }
      });
      if (currentBook.status === 'READ' && (latestActive._max.completionRound ?? 0) < existing.completionRound) {
        await tx.book.update({
          where: { id: existing.bookId },
          data: { status: 'READING', version: { increment: 1 } }
        });
        await writeEvent(tx, {
          userId,
          bookId: existing.bookId,
          entityType: 'BOOK',
          entityId: existing.bookId,
          action: 'STATUS_CHANGED',
          payload: { previousStatus: 'READ', nextStatus: 'READING', reason: 'reflection_deleted' }
        });
      }
    });
    return reply.status(204).send();
  });

  app.post('/reflections/:reflectionId/restore', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除完成感受不存在');
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');

    const restored = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${existing.bookId}::uuid FOR UPDATE`;
      const book = await tx.book.findFirstOrThrow({ where: { id: existing.bookId } });
      if (book.status !== 'READING') {
        throw new AppError(409, 'RESTORE_CONFLICT', '书目状态已变化，无法恢复该完成感受');
      }
      const latestActive = await tx.completionReflection.aggregate({
        where: { bookId: existing.bookId, deletedAt: null },
        _max: { completionRound: true }
      });
      if ((latestActive._max.completionRound ?? 0) > existing.completionRound) {
        throw new AppError(409, 'RESTORE_CONFLICT', '已有更新的完成轮次，无法恢复');
      }
      const value = await tx.completionReflection.update({
        where: { id },
        data: { deletedAt: null, cascadeDeletedAt: null, version: { increment: 1 } }
      });
      await tx.book.update({
        where: { id: existing.bookId },
        data: { status: 'READ', version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'RESTORED',
        payload: { completionRound: value.completionRound }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'BOOK',
        entityId: existing.bookId,
        action: 'STATUS_CHANGED',
        payload: { previousStatus: 'READING', nextStatus: 'READ', reason: 'reflection_restored' }
      });
      return value;
    });
    return { reflection: serialize(restored) };
  });
};
