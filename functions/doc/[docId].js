// /doc/:docId — 把所有文档页都交给同一个静态页面，页面自己从 URL 里取 docId
export async function onRequestGet({ request, env }) {
  return env.ASSETS.fetch(new URL('/editor', request.url));
}
