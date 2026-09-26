import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const pgPort = 40000 + Math.floor(Math.random() * 5000);
const pg = new EmbeddedPostgres({
  databaseDir: join(tmpdir(), `pbt-it-${process.pid}`),
  user: 'app',
  password: 'app',
  port: pgPort,
  persistent: false
});
const dbUrl = `postgresql://app:app@localhost:${pgPort}/pbt_it?schema=public`;

let app: FastifyInstance;
let cookie = '';

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const res = await app.inject({ method: method as never, url: `/api/v1${url}`, payload: body as never, headers });
  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const entry = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = entry.split(';')[0];
  }
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

function migrateDeploy(extraArgs: string[] = []): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', ...extraArgs], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit'
  });
}

beforeAll(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pbt_it');
  process.env.DATABASE_URL = dbUrl;
  process.env.SESSION_SECRET = 'integration-test-secret-0123456789abcdef';
  process.env.NODE_ENV = 'test';

  // 先只应用 init 迁移，把数据库置于“修复前”的历史状态。
  const initOnly = join(tmpdir(), `pbt-init-only-${process.pid}`);
  rmSync(initOnly, { recursive: true, force: true });
  mkdirSync(join(initOnly, 'migrations'), { recursive: true });
  copyFileSync(join(apiRoot, 'prisma/schema.prisma'), join(initOnly, 'schema.prisma'));
  cpSync(join(apiRoot, 'prisma/migrations/202609240001_init'), join(initOnly, 'migrations/202609240001_init'), {
    recursive: true
  });
  copyFileSync(join(apiRoot, 'prisma/migrations/migration_lock.toml'), join(initOnly, 'migrations/migration_lock.toml'));
  migrateDeploy(['--schema', join(initOnly, 'schema.prisma')]);
}, 300_000);

afterAll(async () => {
  if (app) await app.close();
  await pg.stop();
});

describe('历史级联删除的兼容与恢复', () => {
  it('迁移回填级联标记，历史误删的书可整书恢复完整影响链', async () => {
    const client = pg.getPgClient('pbt_it');
    await client.connect();

    // 旧版删除现场：书与全部子记录被软删，审计里只有 cascade 删除事件。
    const userId = randomUUID();
    const bookId = randomUUID();
    const dogEarId = randomUUID();
    const annotationId = randomUUID();
    const rereadId = randomUUID();
    const reflectionId = randomUUID();
    const soloDogEarId = randomUUID();
    const passwordHash = await hash('password123', { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });

    await client.query(
      `INSERT INTO users (id, email, password_hash, status, created_at, updated_at) VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
      [userId, 'legacy@example.com', passwordHash]
    );
    await client.query(
      `INSERT INTO books (id, user_id, version, title, page_count, status, created_at, updated_at, deleted_at)
       VALUES ($1, $2, 4, '历史误删的书', 320, 'READ', NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')`,
      [bookId, userId]
    );
    const childRows: Array<[string, string, string, string]> = [
      ['dog_ears', dogEarId, 'page_number, reason', `10, '历史折角'`],
      ['annotations', annotationId, 'start_page, end_page, content', `20, 25, '历史批注'`],
      ['reread_marks', rereadId, 'page_number, reason', `30, '历史重读'`]
    ];
    for (const [table, id, cols, vals] of childRows) {
      await client.query(
        `INSERT INTO ${table} (id, user_id, book_id, version, ${cols}, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, 2, ${vals}, NOW() - INTERVAL '20 days', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')`,
        [id, userId, bookId]
      );
    }
    await client.query(
      `INSERT INTO completion_reflections (id, user_id, book_id, version, completion_round, mood_tags, reflection, completed_at, editable_until, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, 2, 1, '{MOVED}', '历史感受', NOW() - INTERVAL '15 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '15 days', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')`,
      [reflectionId, userId, bookId]
    );
    // 单独删除的折角（先于整书删除，与级联无关）
    await client.query(
      `INSERT INTO dog_ears (id, user_id, book_id, version, page_number, reason, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, 3, 99, '单独删除的折角', NOW() - INTERVAL '20 days', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')`,
      [soloDogEarId, userId, bookId]
    );
    const events: Array<[string, string, string, Record<string, unknown>]> = [
      ['BOOK', bookId, 'DELETED', { bookTitle: '历史误删的书' }],
      ['DOG_EAR', dogEarId, 'DELETED', { cascade: true }],
      ['ANNOTATION', annotationId, 'DELETED', { cascade: true }],
      ['REREAD_MARK', rereadId, 'DELETED', { cascade: true }],
      ['COMPLETION_REFLECTION', reflectionId, 'DELETED', { cascade: true }],
      ['DOG_EAR', soloDogEarId, 'DELETED', { pageNumber: 99 }]
    ];
    for (const [entityType, entityId, action, payload] of events) {
      await client.query(
        `INSERT INTO activity_events (id, user_id, book_id, entity_type, entity_id, action, payload_json, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - INTERVAL '2 hours')`,
        [randomUUID(), userId, bookId, entityType, entityId, action, JSON.stringify(payload)]
      );
    }

    // 应用新迁移：新增 cascade_deleted_at 并从审计事件回填历史数据。
    migrateDeploy();

    const backfill = await client.query(
      `SELECT
         (SELECT cascade_deleted_at FROM dog_ears WHERE id = $1) AS dog_ear,
         (SELECT cascade_deleted_at FROM annotations WHERE id = $2) AS annotation,
         (SELECT cascade_deleted_at FROM reread_marks WHERE id = $3) AS reread,
         (SELECT cascade_deleted_at FROM completion_reflections WHERE id = $4) AS reflection,
         (SELECT cascade_deleted_at FROM dog_ears WHERE id = $5) AS solo`,
      [dogEarId, annotationId, rereadId, reflectionId, soloDogEarId]
    );
    expect(backfill.rows[0].dog_ear).not.toBeNull();
    expect(backfill.rows[0].annotation).not.toBeNull();
    expect(backfill.rows[0].reread).not.toBeNull();
    expect(backfill.rows[0].reflection).not.toBeNull();
    expect(backfill.rows[0].solo).toBeNull();

    const mod = await import('../src/app.js');
    app = await mod.buildApp();

    let r = await call('POST', '/auth/login', { email: 'legacy@example.com', password: 'password123' });
    expect(r.status).toBe(200);

    r = await call('GET', '/books/deleted');
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].id).toBe(bookId);
    expect(r.json.items[0].restorableUntil).toBeTruthy();

    r = await call('POST', `/books/${bookId}/restore`);
    expect(r.status).toBe(200);
    expect(r.json.book.status).toBe('READ');

    r = await call('GET', `/books/${bookId}`);
    expect(r.json.book.traceSummary).toEqual({ dogEars: 1, annotations: 1, rereadMarks: 1 });
    expect(r.json.book.reflections).toHaveLength(1);
    expect(r.json.book.reflections[0].text).toBe('历史感受');

    r = await call('GET', `/books/${bookId}/traces`);
    expect(r.json.items).toHaveLength(3);
    expect(r.json.items.every((t: any) => t.pageNumber !== 99)).toBe(true);

    r = await call('GET', `/timeline?bookId=${bookId}&pageSize=100`);
    const cascadeDeletes = r.json.items.filter((e: any) => e.action === 'DELETED' && e.payload?.cascade === true);
    expect(cascadeDeletes).toHaveLength(4);
    expect(r.json.items.filter((e: any) => e.action === 'RESTORED')).toHaveLength(5);

    r = await call('GET', '/books/deleted');
    expect(r.json.items).toHaveLength(0);

    await client.end();
  }, 120_000);
});

describe('删除与整书恢复流程', () => {
  let bookId = '';

  it('注册并准备一本带痕迹且已读完的书', async () => {
    let r = await call('POST', '/auth/register', { email: `fresh-${Date.now()}@example.com`, password: 'password123' });
    expect(r.status).toBe(201);

    r = await call('POST', '/books', { title: '修复验证书', pageCount: 300 });
    expect(r.status).toBe(201);
    bookId = r.json.book.id;

    r = await call('PATCH', `/books/${bookId}/status`, { status: 'READING', version: r.json.book.version });
    expect(r.status).toBe(200);
    await call('POST', `/books/${bookId}/dog-ears`, { pageNumber: 10, reason: '折角' });
    await call('POST', `/books/${bookId}/annotations`, { startPage: 20, endPage: 25, content: '批注内容' });
    await call('POST', `/books/${bookId}/reread-marks`, { pageNumber: 30, reason: '重读' });

    r = await call('GET', `/books/${bookId}`);
    r = await call('PATCH', `/books/${bookId}/status`, {
      status: 'READ',
      version: r.json.book.version,
      reflection: { moodTags: ['MOVED'], text: '读完感受' }
    });
    expect(r.status).toBe(200);
    expect(r.json.reflection?.id).toBeTruthy();
  });

  it('旧页面不带版本的删除仍然放行（兼容历史客户端）', async () => {
    const r = await call('DELETE', `/books/${bookId}`);
    expect(r.status).toBe(204);

    expect((await call('GET', `/books/${bookId}`)).status).toBe(404);
    expect((await call('GET', `/books/${bookId}/traces`)).status).toBe(404);
    const list = await call('GET', '/books');
    expect(list.json.items).toHaveLength(0);

    const trash = await call('GET', '/books/deleted');
    expect(trash.json.items).toHaveLength(1);
    expect(trash.json.items[0].status).toBe('READ');
    expect(trash.json.items[0].restorableUntil).toBeTruthy();

    const timeline = await call('GET', '/timeline?pageSize=100');
    const bookDeleted = timeline.json.items.find((e: any) => e.action === 'DELETED' && e.entityType === 'BOOK');
    expect(bookDeleted.payload.cascade).toEqual({ dogEars: 1, annotations: 1, rereadMarks: 1, reflections: 1 });
    expect(timeline.json.items.filter((e: any) => e.action === 'DELETED' && e.payload?.cascade === true)).toHaveLength(4);
  });

  it('整书恢复：痕迹、感受、状态与审计全部回来', async () => {
    const r = await call('POST', `/books/${bookId}/restore`);
    expect(r.status).toBe(200);
    expect(r.json.book.status).toBe('READ');

    const detail = await call('GET', `/books/${bookId}`);
    expect(detail.json.book.traceSummary).toEqual({ dogEars: 1, annotations: 1, rereadMarks: 1 });
    expect(detail.json.book.reflections).toHaveLength(1);
    expect(detail.json.book.reflections[0].text).toBe('读完感受');

    const traces = await call('GET', `/books/${bookId}/traces`);
    expect(traces.json.items).toHaveLength(3);

    const timeline = await call('GET', `/timeline?bookId=${bookId}&pageSize=100`);
    expect(timeline.json.items.some((e: any) => e.action === 'RESTORED' && e.entityType === 'BOOK')).toBe(true);
    expect(timeline.json.items.filter((e: any) => e.action === 'RESTORED' && e.payload?.cascade === true)).toHaveLength(4);
    expect(timeline.json.items.some((e: any) => e.action === 'DELETED' && e.entityType === 'BOOK')).toBe(true);
  });

  it('携带过期版本的删除返回 409', async () => {
    const r = await call('DELETE', `/books/${bookId}`, { version: 99999 });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE_WRITE');

    const detail = await call('GET', `/books/${bookId}`);
    const again = await call('DELETE', `/books/${bookId}`, { version: detail.json.book.version });
    expect(again.status).toBe(204);
    const restored = await call('POST', `/books/${bookId}/restore`);
    expect(restored.status).toBe(200);
  });

  it('超过 24 小时恢复窗口返回 409，数据仍保留在导出中', async () => {
    expect((await call('DELETE', `/books/${bookId}`)).status).toBe(204);
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.book.update({ where: { id: bookId }, data: { deletedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });

    const r = await call('POST', `/books/${bookId}/restore`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('RESTORE_WINDOW_EXPIRED');

    const trash = await call('GET', '/books/deleted');
    expect(trash.json.items).toHaveLength(0);

    const exported = await call('GET', '/exports/me?includeDeleted=true');
    expect(exported.status).toBe(200);
    expect(exported.json.books).toHaveLength(1);
    expect(exported.json.books[0].deletedAt).toBeTruthy();
    expect(exported.json.dogEars.some((d: any) => d.deletedAt && d.cascadeDeletedAt)).toBe(true);
    expect(exported.json.activityEvents.length).toBeGreaterThan(5);
  });
});
