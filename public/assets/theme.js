// 夜间模式。在 <head> 里同步加载，页面画出来之前就定好配色，避免先闪一下白屏。
// 没手动切换过就跟随系统；点过切换按钮后记住选择。
// 切换时派发 themechange 事件，页面里的组件（如文档页的 Vditor）自己跟着换配色。
(() => {
  const KEY = 'site:theme';
  const system = matchMedia('(prefers-color-scheme: dark)');

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  const preferred = () => localStorage.getItem(KEY) || (system.matches ? 'dark' : 'light');

  apply(preferred());
  system.addEventListener('change', () => localStorage.getItem(KEY) || apply(preferred()));

  window.toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };
})();
