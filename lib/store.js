// 数据存储：Cloudflare D1（SQLite），binding 名为 DB。
import { HISTORY_LIMIT, HISTORY_MERGE_MS, IMAGE_KEEP_MS, PRESENCE_WINDOW_MS, PRESENCE_WRITE_MIN_MS } from './util.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
    id         TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    edit_key   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // 一行一个历史版本；started_at 是这个版本第一次保存的时间，用来判断要不要合并
  `CREATE TABLE IF NOT EXISTS history (
    doc_id     TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    author     TEXT,
    content    TEXT NOT NULL,
    PRIMARY KEY (doc_id, updated_at)
  )`,
  `CREATE TABLE IF NOT EXISTS presence (
    doc_id    TEXT NOT NULL,
    anon_id   TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (doc_id, anon_id)
  )`,
  // 上传到本站的图片。data 放最后一列：统计大小时只读 size，SQLite 不用把图片内容也读出来
  `CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    data       BLOB NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS images_doc ON images (doc_id)',
];

// docs 表后来加的列。已经部署过的数据库里，表是加列之前建的，CREATE TABLE IF NOT EXISTS 不会改它，
// 所以新加的列一律写在这里，缺哪列补哪列（新数据库也是先建出上面的表，再在这里补齐）。
// parent_id：父文档，NULL 是一棵树的根；created_at：创建时间，目录里同一层的文档按它排序（旧文档是 NULL）
const DOC_COLUMNS = [
  ['parent_id', 'TEXT'],
  ['created_at', 'INTEGER'],
];
// 用到新加的列的索引，要等列补齐之后才能建
const DOC_INDEXES = ['CREATE INDEX IF NOT EXISTS docs_parent ON docs (parent_id)'];

// 每个 Worker 实例第一次访问时建表（已存在则跳过），不用手动去控制台执行 SQL。
// 注意全局只能存“建好了”这个结果，不能存建表的 Promise 让别的请求去等：
// Workers 里一个请求发起的 I/O 不能被其他请求等待，发起它的请求一旦被取消（比如用户刷新），
// 这个 Promise 就永远不会完成，之后落到这个实例上的请求全都卡死（表现为 524 超时）。
// 表还没建好时，并发的几个请求各自执行一遍 CREATE TABLE IF NOT EXISTS，重复执行没有副作用。
let schemaReady = false;
async function database(env) {
  if (!env.DB) {
    const err = new Error('没有绑定 D1 数据库（Pages 项目 → 设置 → 绑定，变量名 DB）');
    err.expose = true; // 这条可以直接显示给用户，见 util.js 的 catchErrors
    throw err;
  }
  if (!schemaReady) {
    const db = env.DB;
    const results = await db.batch([...SCHEMA, 'PRAGMA table_info(docs)'].map((sql) => db.prepare(sql)));
    const have = new Set(results.at(-1).results.map((col) => col.name));
    try {
      await db.batch([
        ...DOC_COLUMNS.filter(([name]) => !have.has(name)).map(([name, type]) => db.prepare(`ALTER TABLE docs ADD COLUMN ${name} ${type}`)),
        ...DOC_INDEXES.map((sql) => db.prepare(sql)),
      ]);
    } catch (err) {
      // 刚部署完时几个实例同时补列，晚到的会因为列已经有了而失败。batch 是一个事务，
      // 能报这个错说明先到的那个已经把列和索引都建好了，忽略即可
      if (!/duplicate column/i.test(err.message)) throw err;
    }
    schemaReady = true;
  }
  return env.DB;
}

// ---------- 文档 ----------

export async function getDoc(env, id) {
  const db = await database(env);
  return db
    .prepare('SELECT content, edit_key AS editKey, updated_at AS updatedAt FROM docs WHERE id = ?')
    .bind(id)
    .first();
}

// 新文档在第一次保存时才创建，这次保存同时记为第一个历史版本。
// parentId：建成谁的子文档（调用方已校验过父文档的编辑密钥，editKey 也沿用父文档的）。
// 返回 updatedAt；返回 null 表示 ID 已被占用
export async function createDoc(env, id, content, editKey, author, parentId = null) {
  const db = await database(env);
  const now = Date.now();
  const { meta } = await db
    .prepare('INSERT OR IGNORE INTO docs (id, content, edit_key, updated_at, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, content, editKey, now, parentId, now)
    .run();
  if (meta.changes !== 1) return null;

  await db
    .prepare('INSERT INTO history (doc_id, updated_at, started_at, author, content) VALUES (?, ?, ?, ?, ?)')
    .bind(id, now, now, author, content)
    .run();
  return now;
}

// 保存并记历史。只有文档还停留在 expectedUpdatedAt 这个版本时才写入，
// 否则说明读取之后有人抢先保存了，返回 null 让调用方报冲突，不会悄悄覆盖别人的修改。
// 历史版本：同一个人连续保存时，HISTORY_MERGE_MS 内的合并成一条；换人保存一定新开一条
export async function saveDoc(env, id, content, author, expectedUpdatedAt) {
  const db = await database(env);
  const updatedAt = Date.now();

  const { meta } = await db
    .prepare('UPDATE docs SET content = ?, updated_at = ? WHERE id = ? AND updated_at = ?')
    .bind(content, updatedAt, id, expectedUpdatedAt)
    .run();
  if (meta.changes === 0) return null;

  const last = await db
    .prepare('SELECT updated_at AS updatedAt, started_at AS startedAt, author FROM history WHERE doc_id = ? ORDER BY updated_at DESC LIMIT 1')
    .bind(id)
    .first();
  const merge = last && author && last.author === author && updatedAt - last.startedAt < HISTORY_MERGE_MS;

  await db.batch([
    merge
      ? db.prepare('UPDATE history SET content = ?, updated_at = ? WHERE doc_id = ? AND updated_at = ?')
        .bind(content, updatedAt, id, last.updatedAt)
      : db.prepare('INSERT INTO history (doc_id, updated_at, started_at, author, content) VALUES (?, ?, ?, ?, ?)')
        .bind(id, updatedAt, updatedAt, author, content),
    // 只保留最近 HISTORY_LIMIT 个版本
    db.prepare(`DELETE FROM history WHERE doc_id = ? AND updated_at NOT IN (
      SELECT updated_at FROM history WHERE doc_id = ? ORDER BY updated_at DESC LIMIT ?)`)
      .bind(id, id, HISTORY_LIMIT),
  ]);
  return updatedAt;
}

// ---------- 目录树 ----------

// 一棵树里的全部文档：up 从这篇往上找到根，sub 再从根往下找出所有子孙。
// 根取 up 里最上面的一篇，而不是 parent_id 为 NULL 的：万一父文档没了（建子文档时父文档恰好被删），
// 这篇自己当根，不至于整棵树都找不到
const TREE = `WITH RECURSIVE
  up(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM docs WHERE id = ?
    UNION ALL
    SELECT docs.id, docs.parent_id, up.depth + 1 FROM docs JOIN up ON docs.id = up.parent_id
  ),
  sub(id) AS (
    SELECT id FROM (SELECT id FROM up ORDER BY depth DESC LIMIT 1)
    UNION ALL
    SELECT docs.id FROM docs JOIN sub ON docs.parent_id = sub.id
  )`;

// 返回 [{ id, parentId, head }]，同一层按创建时间排；文档不存在时返回空数组。不读全文，标题从开头一段里找
export async function getTree(env, id) {
  const db = await database(env);
  const { results } = await db
    .prepare(`${TREE} SELECT docs.id, docs.parent_id AS parentId, substr(docs.content, 1, 1000) AS head
      FROM sub JOIN docs ON docs.id = sub.id ORDER BY docs.created_at`)
    .bind(id)
    .all();
  return results;
}

// ---------- 历史版本 ----------

export async function listHistory(env, id) {
  const db = await database(env);
  const { results } = await db
    .prepare('SELECT updated_at AS updatedAt, length(content) AS length FROM history WHERE doc_id = ? ORDER BY updated_at DESC')
    .bind(id)
    .all();
  return results;
}

export async function getVersion(env, id, updatedAt) {
  const db = await database(env);
  return db
    .prepare('SELECT content, updated_at AS updatedAt FROM history WHERE doc_id = ? AND updated_at = ?')
    .bind(id, updatedAt)
    .first();
}

// ---------- 图片 ----------

// 上传图片时只需要校验编辑密钥，不用把全文读出来
export async function getEditKey(env, docId) {
  const db = await database(env);
  const row = await db.prepare('SELECT edit_key AS editKey FROM docs WHERE id = ?').bind(docId).first();
  return row?.editKey ?? null;
}

// 全站和这篇文档已经存了多少字节的图片
export async function imageUsage(env, docId) {
  const db = await database(env);
  return db
    .prepare('SELECT COALESCE(SUM(size), 0) AS total, COALESCE(SUM(CASE WHEN doc_id = ? THEN size END), 0) AS doc FROM images')
    .bind(docId)
    .first();
}

export async function addImage(env, id, docId, type, data) {
  const db = await database(env);
  await db
    .prepare('INSERT INTO images (id, doc_id, type, size, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, docId, type, data.byteLength, Date.now(), data)
    .run();
}

export async function getImage(env, id) {
  const db = await database(env);
  return db.prepare('SELECT type, data FROM images WHERE id = ?').bind(id).first();
}

// ---------- 在线人数 ----------

const countOnline = (db, docId, now) => db
  .prepare('SELECT COUNT(*) AS online FROM presence WHERE doc_id = ? AND last_seen > ?')
  .bind(docId, now - PRESENCE_WINDOW_MS);

// 记一次心跳，返回在线人数和文档当前版本的时间戳（前端据此判断要不要拉取别人保存的新内容）。
// 距上次记录不足 PRESENCE_WRITE_MIN_MS 的心跳不写入，省写入额度。
// 文档不存在时返回 null，也不写入：免得有人编造文档 ID 往 presence 表里刷数据
export async function heartbeat(env, docId, anonId) {
  const db = await database(env);
  const now = Date.now();
  const [doc, , , count] = await db.batch([
    db.prepare('SELECT updated_at AS updatedAt FROM docs WHERE id = ?').bind(docId),
    // SELECT 后面必须带 WHERE，否则 SQLite 会把 ON CONFLICT 误当成 JOIN 的 ON
    db.prepare(`INSERT INTO presence (doc_id, anon_id, last_seen)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM docs WHERE id = ?)
      ON CONFLICT (doc_id, anon_id) DO UPDATE SET last_seen = excluded.last_seen
      WHERE excluded.last_seen - presence.last_seen >= ?`)
      .bind(docId, anonId, now, docId, PRESENCE_WRITE_MIN_MS),
    // 顺手清掉所有文档里早已离线的记录，表不会越积越多
    db.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 2 * PRESENCE_WINDOW_MS),
    countOnline(db, docId, now),
  ]);
  const updatedAt = doc.results[0]?.updatedAt;
  if (updatedAt === undefined) return null;
  return { online: count.results[0].online, updatedAt };
}

export async function getOnline(env, docId) {
  const db = await database(env);
  return (await countOnline(db, docId, Date.now()).first()).online;
}

// ---------- 管理后台 ----------

// 所有文档的概要，最近更新的在前。不读全文：标题从开头一段里找就够了
export async function listDocs(env) {
  const db = await database(env);
  const { results } = await db
    .prepare(`SELECT id, parent_id AS parentId, edit_key AS editKey, updated_at AS updatedAt, length(content) AS length,
      substr(content, 1, 1000) AS head,
      (SELECT COUNT(*) FROM history WHERE doc_id = docs.id) AS versions,
      (SELECT COUNT(*) FROM images WHERE doc_id = docs.id) AS images
      FROM docs ORDER BY updated_at DESC`)
    .all();
  return results;
}

// 这篇文档和它下面的各级子文档
const SUBTREE = `WITH RECURSIVE sub(id) AS (
  SELECT id FROM docs WHERE id = ?
  UNION ALL
  SELECT docs.id FROM docs JOIN sub ON docs.parent_id = sub.id
)`;

// 删除文档和它下面的全部子文档，连同它们的历史版本、在线记录、上传的图片（batch 是一个事务，要么全删要么都不删）。
// docs 表放在最后删：前面几条要靠它找出有哪些子文档。返回删掉了几篇，0 表示文档本来就不存在
export async function deleteDoc(env, id) {
  const db = await database(env);
  const inSubtree = (table, column) => db.prepare(`${SUBTREE} DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM sub)`).bind(id);
  const results = await db.batch([
    inSubtree('history', 'doc_id'),
    inSubtree('presence', 'doc_id'),
    inSubtree('images', 'doc_id'),
    inSubtree('docs', 'id'),
  ]);
  return results.at(-1).meta.changes;
}

// 全站图片的数量、大小，以及其中上传超过 IMAGE_KEEP_MS 的（过期的）
export async function imageStats(env) {
  const db = await database(env);
  return db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes,
      COUNT(CASE WHEN created_at < ?1 THEN 1 END) AS expiredCount,
      COALESCE(SUM(CASE WHEN created_at < ?1 THEN size END), 0) AS expiredBytes
      FROM images`)
    .bind(Date.now() - IMAGE_KEEP_MS)
    .first();
}

// 只在管理员点了按钮时才调用，图片不会自动删除。返回删掉的张数
export async function deleteExpiredImages(env) {
  const db = await database(env);
  const { meta } = await db
    .prepare('DELETE FROM images WHERE created_at < ?')
    .bind(Date.now() - IMAGE_KEEP_MS)
    .run();
  return meta.changes;
}
