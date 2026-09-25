// 数据存储：Cloudflare D1（SQLite），binding 名为 DB。
import { HISTORY_LIMIT, HISTORY_MERGE_MS, PRESENCE_WINDOW_MS, PRESENCE_WRITE_MIN_MS } from './util.js';

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
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
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
// 返回 updatedAt；返回 null 表示 ID 已被占用
export async function createDoc(env, id, content, editKey, author) {
  const db = await database(env);
  const now = Date.now();
  const { meta } = await db
    .prepare('INSERT OR IGNORE INTO docs (id, content, edit_key, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, content, editKey, now)
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

// ---------- 在线人数 ----------

const countOnline = (db, docId, now) => db
  .prepare('SELECT COUNT(*) AS online FROM presence WHERE doc_id = ? AND last_seen > ?')
  .bind(docId, now - PRESENCE_WINDOW_MS);

// 记一次心跳并返回在线人数。距上次记录不足 PRESENCE_WRITE_MIN_MS 的心跳不写入，省写入额度
export async function heartbeat(env, docId, anonId) {
  const db = await database(env);
  const now = Date.now();
  const [, , count] = await db.batch([
    db.prepare(`INSERT INTO presence (doc_id, anon_id, last_seen) VALUES (?, ?, ?)
      ON CONFLICT (doc_id, anon_id) DO UPDATE SET last_seen = excluded.last_seen
      WHERE excluded.last_seen - presence.last_seen >= ?`)
      .bind(docId, anonId, now, PRESENCE_WRITE_MIN_MS),
    // 顺手清掉所有文档里早已离线的记录，表不会越积越多
    db.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 60 * 1000),
    countOnline(db, docId, now),
  ]);
  return count.results[0].online;
}

export async function getOnline(env, docId) {
  const db = await database(env);
  return (await countOnline(db, docId, Date.now()).first()).online;
}
