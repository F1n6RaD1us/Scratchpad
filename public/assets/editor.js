(() => {
  'use strict';

  const AUTOSAVE_DELAY_MS = 1500;  // 停止输入多久后自动保存
  // 心跳间隔。一次心跳同时上报在线、拿到在线人数、得知别人有没有保存新内容，
  // 每次都算一次 Workers 请求，别调太密（服务器端的配套设置见 lib/util.js 的 PRESENCE_*）
  const PRESENCE_INTERVAL_MS = 15000;
  const MY_DOCS_KEY = 'shareddoc:mine';
  const LINK_BAR_HIDDEN_KEY = 'shareddoc:linkBarHidden';
  const EDIT_MODE_KEY = 'shareddoc:editMode';

  // 新文档的初始内容。原样不动就不会保存，服务器上也就不会建这篇文档
  const WELCOME = `# 新文档

像写 Word 一样直接编辑，上方工具栏可以设置标题、**加粗**、列表、表格等。

- 停止输入 1.5 秒后自动保存，也可以按 Ctrl+S
- 可以从网页或 Word 里复制内容粘贴进来，格式会尽量保留
- 会写 Markdown 的话，可以在工具栏里切换到「分屏预览」模式
`;

  // Vditor 运行时按需加载的文件（解析引擎、语言包、主题等）和主文件在同一个自托管目录下
  const VDITOR_CDN = document.querySelector('script[src*="/vendor/vditor-"]').src.replace(/\/dist\/.*$/, '');
  const CONTENT_THEME_PATH = `${VDITOR_CDN}/dist/css/content-theme`;

  // 工具栏：常用格式 + 模式切换；上传、导出、emoji 等用不上的没放。手机屏幕窄，只留最常用的。
  // 提示气泡默认往上弹，会被编辑区卡片的上沿裁掉，所以改成往下（tipPosition: 's'）
  const TOOLBAR = (matchMedia('(max-width: 720px)').matches
    ? ['headings', 'bold', 'italic', 'list', 'ordered-list', 'check', 'link', 'table', 'undo', 'redo', 'edit-mode']
    : [
      'headings', 'bold', 'italic', 'strike', '|',
      'list', 'ordered-list', 'check', 'quote', 'line', '|',
      'link', 'table', 'code', 'inline-code', '|',
      'undo', 'redo', '|',
      'edit-mode', 'outline', 'fullscreen',
    ]).map((name) => (name === '|' ? name : { name, tipPosition: 's' }));

  // 页面上所有带 id 的元素，按 id 取用
  const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));

  const params = new URLSearchParams(location.search);
  // /doc/new 是还没保存过的新文档（docId 为 null）：第一次保存时才在服务器上创建，
  // 拿到 docId 后地址栏换成正式的编辑链接（见 onCreated）
  let docId = location.pathname === '/doc/new' ? null : location.pathname.split('/')[2] || '';

  // 匿名身份：用于在线人数统计，以及让服务器把同一个人的连续保存合并成一个历史版本
  let anonId = localStorage.getItem('shareddoc:anonId');
  if (!anonId) {
    anonId = crypto.randomUUID();
    localStorage.setItem('shareddoc:anonId', anonId);
  }

  const state = {
    editKey: params.get('key'),
    canEdit: false,
    updatedAt: null,  // 服务器上当前版本的时间戳，保存时用作乐观锁
    savedContent: '', // 最后一次和服务器一致的内容
    saving: false,
    autosaveTimer: null,
  };

  let vditor = null; // 只在编辑模式下创建

  // ---------- 工具 ----------

  // 站点的浅色 / 深色 → Vditor 的界面、正文、代码高亮主题
  const themes = () => (document.documentElement.dataset.theme === 'dark'
    ? { ui: 'dark', content: 'dark', code: 'github-dark' }
    : { ui: 'classic', content: 'light', code: 'github' });

  function previewOptions() {
    const t = themes();
    return {
      cdn: VDITOR_CDN,
      lang: 'zh_CN',
      mode: t.content,
      theme: { current: t.content, path: CONTENT_THEME_PATH },
      hljs: { style: t.code },
      markdown: { sanitize: true }, // 过滤 <script>、onerror 之类，防止文档里夹带恶意代码
      math: { engine: 'KaTeX' },
      anchor: 0,
    };
  }

  const renderInto = (el, md) => Vditor.preview(el, md, previewOptions());
  const currentContent = () => (state.canEdit ? vditor.getValue() : state.savedContent);
  // 新文档被清空了不算改动：空白内容不值得建一篇文档
  function isDirty() {
    if (!state.canEdit) return false;
    const content = vditor.getValue();
    return content !== state.savedContent && (docId !== null || content.trim() !== '');
  }

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  function showError(message) {
    els.errorNotice.textContent = message;
    els.errorNotice.hidden = false;
  }

  // 在列表 / 预览区里放一行灰色提示文字
  function note(el, text) {
    const item = document.createElement(el.tagName === 'UL' ? 'li' : 'p');
    item.className = 'empty';
    item.textContent = text;
    el.replaceChildren(item);
  }

  function docTitle(md) {
    const m = md.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m);
    return m ? m[1].slice(0, 80) : '';
  }

  function updateTitle(md) {
    const title = docTitle(md);
    document.title = title ? `${title} · 共享文档` : '共享文档';
  }

  // 请求最多等 20 秒：服务器卡住时给出提示，而不是页面一直停在“加载中”
  async function api(path, body) {
    const res = await fetch(path, {
      signal: AbortSignal.timeout(20000),
      ...(body && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function copyText(text, btn) {
    await navigator.clipboard.writeText(text);
    const label = btn.querySelector('span');
    const original = label.textContent;
    label.textContent = '已复制';
    setTimeout(() => (label.textContent = original), 1500);
  }

  // 顶栏和提示条高度会变，编辑区高度要跟着变
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--chrome-height', `${els.chrome.offsetHeight}px`);
  }).observe(els.chrome);

  // ---------- 显示内容 ----------

  function setUpdatedAt(ts) {
    state.updatedAt = ts;
    els.updatedLabel.textContent = `更新于 ${new Date(ts).toLocaleString()}`;
  }

  // 用服务器内容替换本地（首次加载、别人改了、冲突时选择放弃本地）
  function applyRemote(content, updatedAt) {
    setUpdatedAt(updatedAt);
    if (state.canEdit) {
      vditor.setValue(content, true);
      state.savedContent = vditor.getValue(); // Vditor 会规范化格式，以它的结果为基准判断有没有改动
    } else {
      state.savedContent = content;
      renderInto(els.preview, content);
    }
    updateTitle(content);
  }

  // 创建编辑器；Vditor 要先加载解析引擎，加载完才算进入编辑模式
  function enterEditMode(content) {
    els.workspace.classList.remove('reading');
    els.readerPane.hidden = true;
    els.editorPane.hidden = false;
    els.editTools.hidden = els.saveBtn.hidden = false;
    els.modeBadge.classList.add('editing');
    els.modeIcon.className = 'icon i-pencil';
    els.modeLabel.textContent = '可编辑';
    setStatus('加载编辑器…');

    const t = themes();
    return new Promise((resolve) => {
      vditor = new Vditor('vditor', {
        cdn: VDITOR_CDN,
        lang: 'zh_CN',
        mode: localStorage.getItem(EDIT_MODE_KEY) || 'wysiwyg',
        value: content,
        height: '100%',
        theme: t.ui,
        toolbar: TOOLBAR,
        counter: { enable: true, type: 'text' }, // 统计正文字数，不算 **、# 这些 Markdown 符号
        cache: { enable: false }, // 内容以服务器为准，不用 Vditor 自带的本地缓存
        placeholder: '开始写点什么吧…',
        preview: {
          theme: { current: t.content, path: CONTENT_THEME_PATH },
          hljs: { style: t.code },
          markdown: { sanitize: true },
          math: { engine: 'KaTeX' },
          actions: [], // 分屏预览上方的“桌面 / 平板 / 手机 / 复制到公众号”那排按钮用不上
        },
        input: (md) => {
          updateTitle(md);
          scheduleAutosave();
        },
        after: () => {
          // 字数的提示气泡同样改成往下弹（提示文字见 site.css）
          els.editorPane.querySelector('.vditor-counter').classList.replace('vditor-tooltipped__nw', 'vditor-tooltipped__sw');

          state.canEdit = true;
          state.savedContent = vditor.getValue();
          setStatus('已保存');
          resolve();
        },
      });
    });
  }

  // 记住用户选的编辑模式（所见即所得 / 即时渲染 / 分屏），下次打开沿用
  addEventListener('pagehide', () => vditor && localStorage.setItem(EDIT_MODE_KEY, vditor.getCurrentMode()));

  addEventListener('themechange', () => {
    const t = themes();
    if (vditor) vditor.setTheme(t.ui, t.content, t.code);
    else {
      Vditor.setContentTheme(t.content, CONTENT_THEME_PATH);
      Vditor.setCodeTheme(t.code, VDITOR_CDN);
    }
  });

  // 更新“我创建的文档”列表里的标题，方便在文档首页辨认
  function rememberTitle(content) {
    const docs = JSON.parse(localStorage.getItem(MY_DOCS_KEY) || '[]');
    const mine = docs.find((d) => d.docId === docId);
    if (!mine) return;
    mine.title = docTitle(content);
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify(docs));
  }

  // 新文档第一次保存成功：换成正式的编辑链接，记进“我创建的文档”，展开链接栏，开始同步
  function onCreated(data) {
    docId = data.docId;
    state.editKey = data.editKey;
    history.replaceState(null, '', `/doc/${docId}?key=${encodeURIComponent(state.editKey)}`);

    const docs = JSON.parse(localStorage.getItem(MY_DOCS_KEY) || '[]');
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify([{ docId, editKey: state.editKey, createdAt: Date.now() }, ...docs]));

    els.historyBtn.hidden = els.linksBtn.hidden = false;
    setupLinkBar(true);
    startSync();
  }

  // ---------- 保存 ----------

  async function save() {
    clearTimeout(state.autosaveTimer);
    if (!state.canEdit || state.saving) return; // 保存中又有输入的话，保存完会再排一次自动保存

    const content = vditor.getValue();
    if (!isDirty()) return setStatus(docId === null ? '尚未保存' : '已保存');

    state.saving = true;
    setStatus('保存中…');
    const res = await (docId === null
      ? api('/api/doc', { content, anonId })
      : api(`/api/doc/${docId}`, {
        editKey: state.editKey,
        content,
        baseUpdatedAt: state.updatedAt,
        anonId,
      })
    ).catch(() => null);
    state.saving = false;

    if (!res) return setStatus('保存失败：网络错误', true);
    if (res.status === 409) return resolveConflict(res.data);
    if (res.status === 403) {
      setStatus('无权编辑', true);
      return showError('编辑密钥无效，无法保存。请确认你打开的是完整的编辑链接。');
    }
    if (!res.ok) return setStatus(`保存失败：${res.data.error || res.status}`, true);

    if (docId === null) onCreated(res.data);
    state.savedContent = content;
    setUpdatedAt(res.data.updatedAt);
    rememberTitle(content);
    if (isDirty()) scheduleAutosave();
    else setStatus('已保存');
  }

  async function resolveConflict(remote) {
    const overwrite = confirm(
      '在你编辑期间，别人保存了新版本。\n\n' +
      '「确定」：用你的内容覆盖（对方的修改仍可在“历史”里找回）\n' +
      '「取消」：放弃你的修改，加载最新版本'
    );
    if (overwrite) {
      state.updatedAt = remote.updatedAt; // 基于最新版本再存一次
      return save();
    }
    applyRemote(remote.content, remote.updatedAt);
    setStatus('已加载最新版本');
  }

  function scheduleAutosave() {
    clearTimeout(state.autosaveTimer);
    setStatus('未保存');
    state.autosaveTimer = setTimeout(save, AUTOSAVE_DELAY_MS);
  }

  // 用新内容替换全文并立即保存（导入文件、恢复历史版本）；Ctrl+Z 可以撤销
  function replaceContent(text) {
    vditor.setValue(text);
    updateTitle(text);
    save();
  }

  // 捕获阶段监听，免得被编辑器自己的快捷键处理吞掉
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  }, true);

  addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  els.saveBtn.onclick = save;

  // ---------- 导入 / 导出 / 打印 ----------

  function importText(text) {
    if (vditor.getValue().trim() && !confirm('用导入的内容替换当前全部内容？（旧内容可在“历史”里找回）')) return;
    replaceContent(text);
  }

  els.importBtn.onclick = () => els.fileInput.click();
  els.fileInput.onchange = async () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = '';
    if (file) importText(await file.text());
  };

  // 把 .md 文件拖进编辑区当作导入；其他文件（比如图片）交给 Vditor 自己处理
  els.editorPane.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) els.editorPane.classList.add('dragover');
  }, true);
  els.editorPane.addEventListener('dragleave', () => els.editorPane.classList.remove('dragover'), true);
  els.editorPane.addEventListener('drop', async (e) => {
    els.editorPane.classList.remove('dragover');
    const file = [...e.dataTransfer.files].find((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    importText(await file.text());
  }, true);

  els.downloadBtn.onclick = () => {
    const content = currentContent();
    const name = (docTitle(content) || docId || '新文档').replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Ctrl+P / 另存为 PDF 时只打印文档正文（打印样式见 site.css 的 @media print）
  addEventListener('beforeprint', () => {
    els.printArea.innerHTML = state.canEdit ? vditor.getHTML() : els.preview.innerHTML;
  });

  // ---------- 链接栏：编辑模式下列出只读链接和编辑链接，收起状态会记住 ----------

  function showLinkBar(visible) {
    els.linkBar.hidden = !visible;
    els.linksBtn.classList.toggle('active', visible);
    localStorage.setItem(LINK_BAR_HIDDEN_KEY, String(!visible));
  }

  els.linksBtn.onclick = () => showLinkBar(els.linkBar.hidden);
  els.linkBarClose.onclick = () => {
    showLinkBar(false);
    els.linkHint.hidden = true;
    els.linkBar.classList.remove('new');
  };
  els.copyViewLink.onclick = () => copyText(els.viewLinkInput.value, els.copyViewLink);
  els.copyEditLink.onclick = () => copyText(els.editLinkInput.value, els.copyEditLink);
  for (const input of [els.viewLinkInput, els.editLinkInput]) input.onfocus = () => input.select();

  // isNew：刚创建的文档，强制展开链接栏并提示保存编辑链接
  function setupLinkBar(isNew = false) {
    const viewUrl = `${location.origin}/doc/${docId}`;
    els.viewLinkInput.value = viewUrl;
    els.editLinkInput.value = `${viewUrl}?key=${encodeURIComponent(state.editKey)}`;
    els.linkHint.hidden = !isNew;
    els.linkBar.classList.toggle('new', isNew);
    showLinkBar(isNew || localStorage.getItem(LINK_BAR_HIDDEN_KEY) !== 'true');
  }

  // ---------- 历史版本 ----------

  let selectedVersion = null;

  async function openHistory() {
    selectedVersion = null;
    els.restoreBtn.hidden = !state.canEdit;
    els.restoreBtn.disabled = true;
    note(els.versionPreview, '点左侧的版本查看内容');
    note(els.versionList, '加载中…');
    els.historyDialog.showModal();

    const { ok, data } = await api(`/api/doc/${docId}/history`);
    if (!ok) return note(els.versionList, `加载失败：${data.error || ''}`);
    if (!data.versions.length) return note(els.versionList, '还没有历史版本，保存一次后就会出现');

    els.versionList.replaceChildren(...data.versions.map((v, i) => {
      const li = document.createElement('li');
      li.textContent = new Date(v.updatedAt).toLocaleString();
      const meta = document.createElement('small');
      meta.textContent = `${v.length} 字${i === 0 ? ' · 当前版本' : ''}`;
      li.append(meta);
      li.onclick = () => showVersion(v.updatedAt, li);
      return li;
    }));
  }

  async function showVersion(updatedAt, li) {
    for (const item of els.versionList.children) item.classList.toggle('active', item === li);
    els.restoreBtn.disabled = true;
    note(els.versionPreview, '加载中…');

    const { ok, data } = await api(`/api/doc/${docId}/history?at=${updatedAt}`);
    if (!ok) return note(els.versionPreview, `加载失败：${data.error || ''}`);
    selectedVersion = data;
    await renderInto(els.versionPreview, data.content);
    els.restoreBtn.disabled = false;
  }

  els.historyBtn.onclick = openHistory;
  els.historyClose.onclick = () => els.historyDialog.close();
  // 点遮罩关闭（内容铺满了 dialog，点到 dialog 本身只可能是点在遮罩上）
  els.historyDialog.onclick = (e) => e.target === els.historyDialog && els.historyDialog.close();
  els.restoreBtn.onclick = () => {
    if (!confirm(`把文档恢复到 ${new Date(selectedVersion.updatedAt).toLocaleString()} 的版本？`)) return;
    els.historyDialog.close();
    replaceContent(selectedVersion.content);
  };

  // ---------- 在线人数 ----------

  // 心跳接口同时返回在线人数和文档当前版本，版本变了才去拉全文
  async function heartbeat({ force = false } = {}) {
    if (document.hidden && !force) return; // 后台标签页不上报，省请求次数和写入额度
    const res = await api(`/api/presence/${docId}`, { anonId }).catch(() => null);
    if (!res?.ok) return;
    els.onlineCount.textContent = res.data.online;
    if (res.data.updatedAt !== state.updatedAt) refresh();
  }

  // ---------- 拉取别人保存的新内容 ----------

  async function refresh() {
    if (document.hidden || state.saving || isDirty()) return; // 有未保存的修改时交给保存时的冲突处理
    const { ok, data } = await api(`/api/doc/${docId}`);
    if (!ok || data.updatedAt === state.updatedAt || isDirty()) return;
    applyRemote(data.content, data.updatedAt);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !docId) return;
    heartbeat(); // 切回来立刻报一次，顺便检查离开期间有没有人保存
  });

  function startSync() {
    heartbeat({ force: true });
    setInterval(heartbeat, PRESENCE_INTERVAL_MS);
  }

  // ---------- 启动 ----------

  async function init() {
    if (docId === null) {
      // 新文档：还没有链接和历史，这两个按钮等第一次保存后再出现
      els.historyBtn.hidden = els.linksBtn.hidden = true;
      updateTitle(WELCOME);
      await enterEditMode(WELCOME);
      setStatus('尚未保存');
      return;
    }
    if (!docId) {
      els.preview.innerHTML = '<p>链接不完整。请从 <a href="/">文档首页</a> 新建或打开文档。</p>';
      return;
    }

    const { ok, status, data } = await api(`/api/doc/${docId}`);
    if (!ok) {
      if (status === 404) els.preview.innerHTML = '<p>文档不存在。<a href="/">新建一个？</a></p>';
      else note(els.preview, `加载失败：${data.error || status}`);
      return;
    }
    let { content, updatedAt } = data;

    let editable = false;
    if (state.editKey) {
      // 用“保存相同内容”校验密钥：内容没变时服务器只比对密钥、不写入
      const check = await api(`/api/doc/${docId}`, { editKey: state.editKey, content, baseUpdatedAt: updatedAt });
      editable = check.ok || check.status === 409;
      if (check.status === 409) ({ content, updatedAt } = check.data); // 刚好有人保存了，用最新的
      if (!editable) showError('编辑密钥无效，已切换为只读模式。');
    }

    if (editable) {
      setUpdatedAt(updatedAt);
      updateTitle(content);
      setupLinkBar();
      await enterEditMode(content);
    } else {
      applyRemote(content, updatedAt);
    }

    startSync();
  }

  init().catch(() => {
    els.readerPane.hidden = false;
    note(els.preview, '加载失败：网络超时或服务器没有响应，请刷新重试');
  });
})();
