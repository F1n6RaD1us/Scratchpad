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
  // 文档集：只有名称，没有正文，用来把几篇文档归在一起、互相切换。
  // 集里的文档和文档集共用同一个编辑密钥，所以文档集的编辑链接能改里面每一篇
  `CREATE TABLE IF NOT EXISTS sets (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    edit_key   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

// docs 表后来加的列。已经部署过的数据库里，表是加列之前建的，CREATE TABLE IF NOT EXISTS 不会改它，
// 所以新加的列一律写在这里，缺哪列补哪列（新数据库也是先建出上面的表，再在这里补齐）。
// created_at：创建时间，文档集里的文档按它排序（旧文档是 NULL）；set_id：所在的文档集，不在集里是 NULL
const DOC_COLUMNS = [
  ['created_at', 'INTEGER'],
  ['set_id', 'TEXT'],
];
// 用到新加的列的索引，要等列补齐之后才能建。
// 中间有一版是「文档下面建子文档」，留下了 parent_id 列和它的索引；改成文档集后不再用，
// 那些子文档就成了普通的独立文档。列留着不碍事（SQLite 删列麻烦），索引删掉，省得每次新建文档还要维护它
const DOC_INDEXES = [
  'CREATE INDEX IF NOT EXISTS docs_set ON docs (set_id)',
  'DROP INDEX IF EXISTS docs_parent',
];

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
      // 能报这个错说明先到的那个已经把列和索引都弄好了，忽略即可
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

// 只校验编辑密钥、上传图片时用，不用把全文读出来
export async function getEditKey(env, docId) {
  const db = await database(env);
  const row = await db.prepare('SELECT edit_key AS editKey FROM docs WHERE id = ?').bind(docId).first();
  return row?.editKey ?? null;
}

// 新文档在第一次保存时才创建，这次保存同时记为第一个历史版本。
// setId：建在哪个文档集里（调用方已校验过文档集的编辑密钥，editKey 也沿用文档集的），顺带更新文档集的更新时间。
// 返回 updatedAt；返回 null 表示 ID 已被占用
export async function createDoc(env, id, content, editKey, author, setId = null) {
  const db = await database(env);
  const now = Date.now();
  const { meta } = await db
    .prepare('INSERT OR IGNORE INTO docs (id, content, edit_key, updated_at, created_at, set_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, content, editKey, now, now, setId)
    .run();
  if (meta.changes !== 1) return null;

  await db.batch([
    db.prepare('INSERT INTO history (doc_id, updated_at, started_at, author, content) VALUES (?, ?, ?, ?, ?)')
      .bind(id, now, now, author, content),
    ...(setId ? [db.prepare('UPDATE sets SET updated_at = ? WHERE id = ?').bind(now, setId)] : []),
  ]);
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

// ---------- 文档集 ----------

// 返回 updatedAt；返回 null 表示 ID 已被占用
export async function createSet(env, id, title, editKey) {
  const db = await database(env);
  const now = Date.now();
  const { meta } = await db
    .prepare('INSERT OR IGNORE INTO sets (id, title, edit_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, title, editKey, now, now)
    .run();
  return meta.changes === 1 ? now : null;
}

export async function getSetKey(env, id) {
  const db = await database(env);
  const row = await db.prepare('SELECT edit_key AS editKey FROM sets WHERE id = ?').bind(id).first();
  return row?.editKey ?? null;
}

// 返回新的 updatedAt；文档集不存在时返回 null
export async function renameSet(env, id, title) {
  const db = await database(env);
  const now = Date.now();
  const { meta } = await db.prepare('UPDATE sets SET title = ?, updated_at = ? WHERE id = ?').bind(title, now, id).run();
  return meta.changes === 1 ? now : null;
}

// 文档集和里面的文档 { id, title, updatedAt, docs: [{ id, updatedAt, head }] }，文档按创建时间排；
// 不读全文，标题从开头一段里找。idExpr 是算出文档集 ID 的 SQL（见下面两个函数），一次 batch 读完
async function readSet(env, idExpr, value) {
  const db = await database(env);
  const [set, docs] = await db.batch([
    db.prepare(`SELECT id, title, updated_at AS updatedAt FROM sets WHERE id = ${idExpr}`).bind(value),
    db.prepare(`SELECT id, updated_at AS updatedAt, substr(content, 1, 1000) AS head FROM docs
      WHERE set_id = ${idExpr} ORDER BY created_at`).bind(value),
  ]);
  const row = set.results[0];
  return row ? { ...row, docs: docs.results } : null;
}

export const getSet = (env, id) => readSet(env, '?', id);
// 文档所在的文档集，不在集里返回 null
export const getSetOfDoc = (env, docId) => readSet(env, '(SELECT set_id FROM docs WHERE id = ?)', docId);

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
    .prepare(`SELECT id, set_id AS setId, edit_key AS editKey, updated_at AS updatedAt, length(content) AS length,
      substr(content, 1, 1000) AS head,
      (SELECT COUNT(*) FROM history WHERE doc_id = docs.id) AS versions,
      (SELECT COUNT(*) FROM images WHERE doc_id = docs.id) AS images
      FROM docs ORDER BY updated_at DESC`)
    .all();
  return results;
}

// 所有文档集，最近更新的在前（新建文档集、改名、往里加文档都算更新）
export async function listSets(env) {
  const db = await database(env);
  const { results } = await db
    .prepare(`SELECT id, title, edit_key AS editKey, updated_at AS updatedAt,
      (SELECT COUNT(*) FROM docs WHERE set_id = sets.id) AS docs
      FROM sets ORDER BY updated_at DESC`)
    .all();
  return results;
}

// 删除文档及其全部历史版本、在线记录、上传的图片（batch 是一个事务，要么全删要么都不删）。
// 返回 false 表示文档本来就不存在
export async function deleteDoc(env, id) {
  const db = await database(env);
  const [doc] = await db.batch([
    db.prepare('DELETE FROM docs WHERE id = ?').bind(id),
    db.prepare('DELETE FROM history WHERE doc_id = ?').bind(id),
    db.prepare('DELETE FROM presence WHERE doc_id = ?').bind(id),
    db.prepare('DELETE FROM images WHERE doc_id = ?').bind(id),
  ]);
  return doc.meta.changes === 1;
}

// 删除文档集和里面的全部文档，连同这些文档的历史版本、在线记录、上传的图片（同样是一个事务）。
// docs 表放在后面删：前面几条要靠它找出集里有哪些文档。返回删掉了几篇文档，文档集本来就不存在时返回 null
export async function deleteSet(env, id) {
  const db = await database(env);
  const inSet = (table) => db.prepare(`DELETE FROM ${table} WHERE doc_id IN (SELECT id FROM docs WHERE set_id = ?)`).bind(id);
  const results = await db.batch([
    inSet('history'),
    inSet('presence'),
    inSet('images'),
    db.prepare('DELETE FROM docs WHERE set_id = ?').bind(id),
    db.prepare('DELETE FROM sets WHERE id = ?').bind(id),
  ]);
  return results[4].meta.changes === 1 ? results[3].meta.changes : null;
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
