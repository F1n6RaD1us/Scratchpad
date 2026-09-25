// Pages Functions 共用的小工具。
// 放在 functions/ 目录外面：functions/ 里的每个文件都会被当成路由。

export const MAX_CONTENT_BYTES = 1024 * 1024; // 单篇文档上限 1MB
export const HISTORY_LIMIT = 50;              // 最多保留多少个历史版本
export const HISTORY_MERGE_MS = 2 * 60 * 1000; // 同一人连续编辑时，每 2 分钟最多留一个历史版本
// 前端每 15 秒心跳一次（editor.js 的 PRESENCE_INTERVAL_MS），下面两个值要和它配合着改
export const PRESENCE_WINDOW_MS = 60 * 1000;    // 最近 1 分钟有心跳算在线
export const PRESENCE_WRITE_MIN_MS = 25 * 1000; // 距上次记录不足 25 秒的心跳不写入（大约隔一次写一次），省写入额度

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 256 % 62 有偏差，但对随机 ID 无影响
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function error(message, status) {
  return json({ error: message }, status);
}

export const readJson = (request) => request.json().catch(() => null);

// 接口出错时返回 JSON，前端能显示原因，而不是 Cloudflare 的 HTML 错误页。
// 标了 expose 的错误（比如没绑数据库）原样告诉用户，其他的只报“服务器出错”，不泄露内部细节
export async function catchErrors({ next }) {
  try {
    return await next();
  } catch (err) {
    console.error(err);
    return error(err.expose ? err.message : '服务器出错，请稍后重试', 500);
  }
}

// 常量时间比较，避免通过响应时间逐字符猜 editKey
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}
