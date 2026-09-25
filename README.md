# shared-docs

多人共享的 Markdown 文档，部署在 Cloudflare Pages：**https://docs.suolk.cc.cd**

| 路径 | 内容 |
|---|---|
| `/` | 文档首页（新建文档、本设备创建过的文档） |
| `/doc/{id}` | 只读链接 |
| `/doc/{id}?key={editKey}` | 编辑链接 |

最早这个功能放在主页项目 [self-page](../self-page) 里（`suolk.cc.cd/doc/...`），后来拆成了独立项目。旧链接由主页那边负责跳转过来，见下文「和主页的关系」。

## 目录

| 路径 | 用途 |
|---|---|
| `public/` | 静态文件（文档首页、编辑页、样式、脚本） |
| `functions/` | 接口（Pages Functions），按文件路径自动成为路由 |
| `lib/store.js` | 所有数据库读写（D1 表结构、旧 KV 数据迁移）都在这里 |
| `lib/util.js` | 接口共用的工具。`lib/` 放在 `functions/` 外面，否则也会被当成路由 |
| `scripts/build.mjs` | 生成要发布的 `dist/`（`npm run build`，Cloudflare 构建时自动执行） |
| `scripts/vendor.mjs` | 把第三方依赖从 `node_modules` 复制到 `public/vendor/`（自托管，见下文） |
| `package.json` | 第三方依赖的版本（Vditor 编辑器、Lucide 图标），以及本地调试用的绑定参数 |

仓库里**故意没有 `wrangler.toml`**：有了它 Pages 会以它为准，数据库 ID 就得写进这个公开仓库。现在构建设置和绑定都在 Dashboard 里配（见下文），不要把它加回来。

## 部署

Pages 项目连着 GitHub 仓库 [F1n6RaD1us/Scratchpad](https://github.com/F1n6RaD1us/Scratchpad)，**推送到 `main` 就会自动部署**，一两分钟后生效。部署进度和构建日志在 Pages 项目 →「部署」里看。

云端构建时 Cloudflare 会先自动 `npm ci` 装依赖，再执行 `npm run build`，然后发布 `dist/`：

- `public/` 里的所有文件都会发布，不需要维护清单
- 第三方文件（Vditor、图标）从 `node_modules` 复制进来，见下文「第三方依赖」
- 给 HTML 里引用的 `/assets/*` 加上内容哈希（`site.css?v=…`）：Cloudflare 默认让浏览器缓存 CSS/JS 4 小时，不加的话部署后访客可能拿到“新 HTML + 旧 CSS”
- `functions/` 由 Pages 自己编译，并自动生成 `_routes.json`，只让接口和文档页走 Worker，其余请求直接按静态文件返回

想在本地确认构建结果，可以自己运行 `npm run build` 看看 `dist/`（已被 git 忽略）。

### 第一次：建 Pages 项目、绑数据库和域名（只做一次）

1. dash.cloudflare.com → **Workers & Pages** → 创建 → **Pages** → **导入现有 Git 存储库**，选 `F1n6RaD1us/Scratchpad`
2. 项目名随意（比如 `suolk-docs`），它只决定 `xxx.pages.dev` 这个默认地址，建好后不能改
3. 构建设置：
   - 框架预设：**None**
   - 构建命令：**`npm run build`**
   - 构建输出目录：**`dist`**
   - 根目录、环境变量：留空
4. **保存并部署**。这次部署能成功，但打开文档会提示「没有绑定 D1 数据库」，因为还没绑，继续下一步
5. 进入项目 → **设置 → 绑定**，添加两个绑定（变量名必须一字不差）：
   - **D1 数据库**：变量名 **`DB`**，数据库选 **`self-page`**。不用建表，代码第一次访问时会自动建好
   - **KV 命名空间**：变量名 **`DOCS`**，选早期版本用的那个命名空间（用来把还没迁移的旧文档搬进 D1，见下文「数据存在哪里」）
6. 绑定只对**之后的**部署生效：项目 → **部署** → 最新那次部署右边的 **⋯** → **重试部署**
7. 项目 → **自定义域** → 添加 `docs.suolk.cc.cd`

绑定分「生产」和「预览」两套环境。只往 `main` 推送的话只用得到生产环境；如果以后推送别的分支，那些分支会部署到预览环境，要在预览环境里同样绑一次才能用（绑同一个数据库的话，预览环境写的就是线上数据）。

以后要换数据库或改构建设置，也是在 **设置** 里改，改完同样要重试一次部署才生效。

### 第三方依赖（自托管）

站点不从任何外部 CDN 加载东西，第三方文件都放在自己的 `/vendor/` 下：

| 依赖 | 用途 |
|---|---|
| [Vditor](https://github.com/Vanessa219/vditor) | 文档编辑器和只读页的渲染 |
| [Lucide](https://lucide.dev/) | 图标（只复制 `site.css` 里用到的） |

版本写在 `package.json`，`scripts/vendor.mjs` 负责把用得到的文件复制到 `public/vendor/`（不进 git，构建和本地调试时自动生成）。

Vditor 只带了常用部分（解析引擎、中文界面、代码高亮、KaTeX 数学公式），没带 mermaid 流程图、echarts 图表等十几 MB 的大件，文档里出现这类代码块时按普通代码显示。

**升级 Vditor**：改 `package.json` 里的版本号，`npm install`，再把 `public/editor.html` 里两处 `/vendor/vditor-x.y.z/` 改成新版本（改漏了构建会报错提醒）。

## 本地调试

第一次先装依赖：

```bash
npm install
```

之后每次：

```bash
npm run dev
```

打开 http://localhost:8788 。本地用的是模拟的 D1 和 KV（绑定写在 `package.json` 的 `dev` 命令参数里），数据存在 `.wrangler/state/`（已被 git 忽略），和线上互不相通，可以随便折腾。

查看本地数据库：因为没有 `wrangler.toml`，`wrangler d1 execute --local` 用不了。可以直接用 SQLite 工具（比如 [DB Browser for SQLite](https://sqlitebrowser.org/)）打开 `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` 下那个名字很长的 `.sqlite` 文件（不是 `metadata.sqlite`）。

## 功能

- 编辑器是 Vditor，默认「所见即所得」（像 Word，不会 Markdown 也能用），工具栏里可切换「即时渲染」「分屏预览」，选择会记住
- 停止输入 1.5 秒后自动保存（Ctrl+S 立即保存）；可以导入或拖入 `.md` 文件，从网页 / Word 粘贴会尽量保留格式
- 下载为 `.md`；需要 PDF 的话用浏览器打印（Ctrl+P → 另存为 PDF），打印时只输出文档正文
- 编辑模式下顶栏下方列出只读链接和编辑链接，可一键复制；收起后点顶栏的「链接」再展开
- 右上角显示在线人数（最近 15 秒内有心跳的访客，包括只读访客）
- 夜间模式：默认跟随系统，点顶栏的月亮 / 太阳按钮切换后会记住选择
- 「历史」保留最近 50 个版本：同一个人连续编辑时每 2 分钟最多留一个版本，换人保存一定会新开一个版本，所以保存冲突时被覆盖的内容总能找回
- 两个人同时改时，后保存的人会收到提示，选择覆盖或加载最新版本
- 没有登录系统：拿到编辑链接的人就能编辑；文档也没有删除功能

## 和主页的关系

两个项目完全独立，互不引用文件。主页只是在卡片上放了个链接，另外负责旧链接的跳转：

- 旧链接 `suolk.cc.cd/doc/...` 会先打开主页上的搬家页（`self-page/public/doc-moved.html`），再跳到本站同一篇文档
- 跳转时顺便把那台设备上「我创建的文档」列表（含编辑链接）放在网址 `#` 后面带过来：浏览器的本地存储按域名隔离，不这样的话换了域名列表就看不到了。`#` 后面的内容不会发给任何服务器
- 本站由 `public/assets/import-mine.js` 接收：**只接受从 suolk.cc.cd 跳转过来的**（检查来源页面），并逐条校验格式，别人构造的链接没法往你的列表里塞东西。读完立刻从地址栏清掉

两个站点的样式表各有一份，改配色的话记得两边一起改。

## 数据存在哪里

| 位置 | 内容 |
|---|---|
| **Cloudflare D1**（绑定名 `DB`） | 所有文档数据，表结构见 `lib/store.js`。在 Dashboard 的 D1 → 该数据库 → 控制台里可以直接写 SQL 查询 |
| 　`docs` 表 | 当前内容、编辑密钥、更新时间 |
| 　`history` 表 | 历史版本，每篇最多 50 条 |
| 　`presence` 表 | 在线心跳，离线超过 1 分钟的记录会被顺手清掉 |
| Cloudflare KV（绑定名 `DOCS`） | 早期版本的数据。D1 里找不到某篇文档时会来这里找，找到就连同历史版本自动搬进 D1。只读，原数据不会被删除或修改；确认旧文档都打开过一遍之后，才可以解除这个绑定 |
| **访客浏览器 localStorage** | 「我创建的文档」列表（含编辑密钥）、匿名 ID、明暗和编辑模式偏好。只在那台设备上，清浏览器数据就没了 |

编辑密钥只存在数据库和创建者的浏览器里，丢了就无法再编辑，可以在 D1 控制台里查回来：

```sql
SELECT edit_key FROM docs WHERE id = '文档ID';
```

D1 自带「时间旅行」：可以把整个数据库恢复到过去某个时间点（免费版 7 天内，付费版 30 天内），误操作了能救回来。恢复要用命令行（会覆盖当前数据，先看清楚再执行）：

```bash
npx wrangler d1 time-travel restore self-page --timestamp=2026-09-25T08:00:00+08:00
```

## 接口

| 接口 | 说明 |
|---|---|
| `POST /api/doc` | 新建文档，返回 `docId`、`editKey` |
| `GET /api/doc/:docId` | 读取内容（不返回 editKey） |
| `POST /api/doc/:docId` | 保存，body `{ editKey, content, baseUpdatedAt?, anonId? }`；别人先改过则返回 409 |
| `GET /api/doc/:docId/history` | 历史版本列表；`?at=<updatedAt>` 取某个版本全文 |
| `POST /api/presence/:docId` | 心跳，body `{ anonId }`，同时返回在线人数 |
| `GET /api/presence/:docId` | 只读取在线人数（前端没用到，心跳接口已经顺带返回） |

接口出错时统一返回 `{ error: "..." }`。

## 免费额度

免费版 D1 每天 **10 万行写入**、500 万行读取，每天 UTC 0 点（北京时间 8 点）重置。大致消耗：

- 每次保存：写 2～3 行（文档 + 历史版本，超过 50 个版本时再删掉最旧的）
- 在线人数：每个打开的标签页约 10 秒写 1 行（服务端节流，后台标签页不上报）

一个标签页开一小时大约 360 行，十几个人天天用也远远用不完。超额后保存和心跳会失败，查看文档不受影响。

另外任何人都能调用新建文档接口，如果被滥用，在 Cloudflare 里给 `POST /api/doc` 加一条限速规则。
