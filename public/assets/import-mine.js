// 从旧地址 suolk.cc.cd/doc/... 跳过来时，# 后面带着那边这台设备上的「我创建的文档」列表（见 home/public/doc-moved.html），
// 合并进本站的列表。浏览器的本地存储按域名隔离，不这样搬的话换到新域名后列表（和里面的编辑链接）就看不到了。
// 只接受从旧站点跳转过来的（看来源页面），防止别人用构造好的链接往你的列表里塞东西。
(() => {
  const m = location.hash.match(/^#import=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search); // 先把列表从地址栏里清掉

  const from = document.referrer && new URL(document.referrer).hostname;
  if (!['suolk.cc.cd', 'www.suolk.cc.cd', 'localhost'].includes(from)) return;

  const KEY = 'shareddoc:mine';
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  try {
    const incoming = JSON.parse(decodeURIComponent(m[1]));
    const mine = JSON.parse(localStorage.getItem(KEY) || '[]');
    const known = new Set(mine.map((d) => d.docId));
    const added = incoming.filter((d) => d && ID.test(d.docId) && ID.test(d.editKey) && !known.has(d.docId));
    if (added.length) localStorage.setItem(KEY, JSON.stringify([...mine, ...added]));
  } catch {
    // 数据格式不对就忽略
  }
})();
