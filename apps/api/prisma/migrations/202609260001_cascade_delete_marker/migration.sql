-- 旧版删除整本书时，会把书下仍有效的折角/批注/重读/感受一并软删，
-- 数据并未物理消失，但界面无法区分“单条删除”与“随书删除”，也无法随书恢复。
-- 新增 cascade_deleted_at 标记随书级联删除的时刻，并从审计事件回填历史数据。

-- AlterTable
ALTER TABLE "dog_ears" ADD COLUMN "cascade_deleted_at" TIMESTAMPTZ(3);
ALTER TABLE "annotations" ADD COLUMN "cascade_deleted_at" TIMESTAMPTZ(3);
ALTER TABLE "reread_marks" ADD COLUMN "cascade_deleted_at" TIMESTAMPTZ(3);
ALTER TABLE "completion_reflections" ADD COLUMN "cascade_deleted_at" TIMESTAMPTZ(3);

-- Backfill：旧逻辑在级联软删每条子记录时，都写了一条
-- action=DELETED 且 payload.cascade=true 的审计事件，entity_id 即子记录主键。
-- 以该事件为准回填级联删除标记，时间戳取子记录自身的 deleted_at。
UPDATE "dog_ears" d
SET "cascade_deleted_at" = d."deleted_at"
FROM "activity_events" e
WHERE e."entity_type" = 'DOG_EAR'
  AND e."action" = 'DELETED'
  AND e."payload_json"->>'cascade' = 'true'
  AND e."entity_id" = d."id"
  AND d."deleted_at" IS NOT NULL
  AND d."cascade_deleted_at" IS NULL;

UPDATE "annotations" a
SET "cascade_deleted_at" = a."deleted_at"
FROM "activity_events" e
WHERE e."entity_type" = 'ANNOTATION'
  AND e."action" = 'DELETED'
  AND e."payload_json"->>'cascade' = 'true'
  AND e."entity_id" = a."id"
  AND a."deleted_at" IS NOT NULL
  AND a."cascade_deleted_at" IS NULL;

UPDATE "reread_marks" r
SET "cascade_deleted_at" = r."deleted_at"
FROM "activity_events" e
WHERE e."entity_type" = 'REREAD_MARK'
  AND e."action" = 'DELETED'
  AND e."payload_json"->>'cascade' = 'true'
  AND e."entity_id" = r."id"
  AND r."deleted_at" IS NOT NULL
  AND r."cascade_deleted_at" IS NULL;

UPDATE "completion_reflections" c
SET "cascade_deleted_at" = c."deleted_at"
FROM "activity_events" e
WHERE e."entity_type" = 'COMPLETION_REFLECTION'
  AND e."action" = 'DELETED'
  AND e."payload_json"->>'cascade' = 'true'
  AND e."entity_id" = c."id"
  AND c."deleted_at" IS NOT NULL
  AND c."cascade_deleted_at" IS NULL;
