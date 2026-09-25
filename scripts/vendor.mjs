// 自托管第三方依赖：把 node_modules 里用得到的文件复制到 public/vendor/（已 gitignore）。
// build.mjs 构建前会自动运行；本地调试用 npm run dev，也会先跑这一步。
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'public/vendor';
const version = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;

rmSync(OUT, { recursive: true, force: true, maxRetries: 5 }); // 开着 npm run dev 时文件可能被占用，重试几次

// ---------- Vditor ----------
// 目录带版本号：升级后路径随之变化，不会被浏览器缓存的旧文件卡住。
// 主文件由 editor.html 引用；其余文件由 Vditor 运行时按 `${cdn}/dist/...` 自己加载。
const vditor = `vditor-${version('vditor')}`;
const VDITOR_FILES = [
  'index.min.js',
  'index.css',
  'js/lute',                     // Markdown 解析引擎，编辑和只读渲染都要用
  'js/i18n/zh_CN.js',
  'js/icons/ant.js',
  'css/content-theme/light.css',
  'css/content-theme/dark.css',
  'js/highlight.js/highlight.min.js',
  'js/highlight.js/third-languages.js',
  'js/highlight.js/styles/github.min.css',
  'js/highlight.js/styles/github-dark.min.css',
  'js/katex',                    // 数学公式
  'js/mermaid',                  // 流程图等（3.5 MB），文档里有 mermaid 代码块时才下载
  // 没带 echarts / graphviz / mathjax 等大件，文档里出现这些代码块时按普通代码显示
];
for (const file of VDITOR_FILES) {
  cpSync(`node_modules/vditor/dist/${file}`, `${OUT}/${vditor}/dist/${file}`, { recursive: true });
}

// 修改 Vditor 里几处写死的代码（README「构建时对 Vditor 的修改」有说明）。
// 找不到要替换的字符串就报错（升级 Vditor 后写法变了），免得补丁悄悄失效。
const mainJs = `${OUT}/${vditor}/dist/index.min.js`;
let js = readFileSync(mainJs, 'utf8');
for (const [from, to] of [
  // 前两处是安全问题：只读链接会分享给别人，而读者的浏览器里存着他们自己文档的编辑密钥，图里的内容不能当作 HTML 执行。
  // Vditor 给 Mermaid 写死了宽松的 loose，允许图里嵌 HTML 和点击事件，改成最严格的 strict
  ['securityLevel:"loose"', 'securityLevel:"strict"'],
  // 图有语法错误时，Vditor 把报错信息当 HTML 插进页面，而报错信息会引用图的源码，要先转义
  ['i.message.replace(/\\n/,"<br>")', 'i.message.replace(/[&<>"\']/g,function(c){return"&#"+c.charCodeAt(0)+";"}).replace(/\\n/,"<br>")'],
  // Mermaid 不跟着切深色主题，始终按浅色渲染：已经画好的图切换明暗时不会重画，
  // 深色模式下改由 site.css 用滤镜反色显示，打印时也就总是浅色
  ['"dark"===n&&(e.theme="dark"),', ''],
  // 统计字数时只去掉了「所见即所得」模式里渲染好的图和公式，「即时渲染」模式下会把 SVG 里的样式代码也算进去
  ['querySelectorAll(".vditor-wysiwyg__preview").forEach((function(e){e.remove()}))',
    'querySelectorAll(".vditor-wysiwyg__preview,.vditor-ir__preview").forEach((function(e){e.remove()}))'],
]) {
  const count = js.split(from).length - 1;
  if (count !== 1) throw new Error(`${mainJs} 里应当恰好有 1 处 ${from}，实际 ${count} 处，请检查 Vditor 的写法是否变了`);
  js = js.replace(from, to);
}
writeFileSync(mainJs, js);

// editor.html 里每一处 Vditor 路径都要是已安装的版本，改漏一处也报错
const html = readFileSync('public/editor.html', 'utf8');
const refs = [...html.matchAll(/\/vendor\/(vditor-[^/]+)\//g)].map((m) => m[1]);
if (!refs.length || refs.some((ref) => ref !== vditor)) {
  throw new Error(`public/editor.html 里引用的 Vditor 路径和已安装的版本（${vditor}）不一致，请同步修改`);
}

// ---------- Lucide 图标：只复制 site.css 里用到的 ----------
const css = readFileSync('public/assets/site.css', 'utf8');
const icons = new Set([...css.matchAll(/\/vendor\/lucide\/([\w-]+)\.svg/g)].map((m) => m[1]));
for (const name of icons) {
  cpSync(`node_modules/lucide-static/icons/${name}.svg`, `${OUT}/lucide/${name}.svg`);
}

console.log(`已复制 ${vditor} 和 ${icons.size} 个图标到 ${OUT}/`);
