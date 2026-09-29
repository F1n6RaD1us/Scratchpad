// 管理接口：出错时统一返回 JSON，并且每个请求都要带管理密码。
// 密码是 Pages 项目里设置的环境变量 ADMIN_PASSWORD；没设置时管理功能整个关闭。
// 前端把密码 encodeURIComponent 后放在 Authorization: Bearer ... 里（请求头只能是 ASCII，密码可能有中文）
import { catchErrors, error, safeEqual } from '../../../lib/util.js';

function requireAdmin({ env, request, next }) {
  if (!env.ADMIN_PASSWORD) {
    return error('没有设置管理密码（Pages 项目 → 设置 → 变量和机密，变量名 ADMIN_PASSWORD）', 503);
  }
  const expected = `Bearer ${encodeURIComponent(env.ADMIN_PASSWORD)}`;
  if (!safeEqual(request.headers.get('authorization'), expected)) return error('管理密码错误', 401);
  return next();
}

export const onRequest = [catchErrors, requireAdmin];
