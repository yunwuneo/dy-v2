const $ = (selector) => document.querySelector(selector);
const state = { videos: [], lookupId: null, config: null, libraryItems: [], libraryTotal: 0, libraryHasMore: false, libraryRequest: 0, selectedItem: null, view: 'console', taskLimit: 30, watchers: [], editingWatcher: -1, poller: null };

function compactNumber(value) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function setBusy(form, busy, label) {
  const button = form.querySelector('button[type="submit"]');
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.label;
}

function notice(message, error = false) {
  const el = $('#notice');
  el.hidden = !message;
  el.textContent = message || '';
  el.classList.toggle('error', error);
}

function libraryNotice(message, error = false) {
  const el = $('#library-notice');
  el.hidden = !message;
  el.textContent = message || '';
  el.classList.toggle('error', error);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 1; size >= 1024 && i < units.length; i++) {
    size /= 1024;
    unit = units[i];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function formatDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function usd(value) { return `$${Number(value || 0).toFixed(4)}`; }

async function loadBilling() {
  const button = $('#billing-refresh');
  button.disabled = true;
  $('#billing-notice').hidden = true;
  try {
    const balance = await request('/api/billing/balance');
    $('#billing-balance').textContent = balance.balance === null ? '—' : usd(balance.balance);
    $('#billing-free-credit').textContent = balance.freeCredit === null ? '免费额度不可用' : `免费额度 ${usd(balance.freeCredit)} · 更新于 ${formatDate(balance.checkedAt)}`;
  } catch (error) {
    $('#billing-balance').textContent = '不可用';
    $('#billing-free-credit').textContent = error.message;
  }
  try {
    const bill = await request('/api/billing');
    $('#billing-requests').textContent = bill.totals.requests;
    $('#billing-results').textContent = `${bill.totals.succeeded} / ${bill.totals.failed}`;
    $('#billing-cost').textContent = usd(bill.totals.estimatedCostUsd);
    $('#billing-note').textContent = `从启用此功能后开始统计。${bill.totals.pending ? `有 ${bill.totals.pending} 次请求仍在进行或上次运行时未完成。` : ''}${bill.totals.unpriced ? `有 ${bill.totals.unpriced} 次成功请求缺少参考单价。` : ''}估算未计入阶梯折扣、免费额度和价格变化；实际扣费请以 TikHub 账单为准。`;
    const rows = $('#billing-rows');
    rows.replaceChildren();
    if (!bill.endpoints.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 6; td.textContent = '暂无请求记录'; tr.append(td); rows.append(tr);
    }
    for (const row of bill.endpoints) {
      const tr = document.createElement('tr');
      for (const value of [row.endpoint, row.requests, row.succeeded, row.failed, row.referencePriceUsd === null ? '—' : usd(row.referencePriceUsd), row.unpriced ? `${usd(row.estimatedCostUsd)} + 未计价` : usd(row.estimatedCostUsd)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      rows.append(tr);
    }
  } catch (error) {
    $('#billing-notice').textContent = `账单读取失败：${error.message}`;
    $('#billing-notice').hidden = false;
  }
  button.disabled = false;
}

function useImageFallback(image, fallback, onFailure = () => image.remove()) {
  image.addEventListener('error', () => {
    const fallbackUrl = typeof fallback === 'function' ? fallback() : fallback;
    if (fallbackUrl && image.dataset.fallback !== 'used') {
      image.dataset.fallback = 'used';
      image.src = fallbackUrl;
    } else {
      onFailure();
    }
  });
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload.data ?? payload;
}

function currentInput() {
  return {
    identifier: $('#identifier').value.trim(),
    type: $('#type').value,
    limit: Number($('#limit').value),
    cookie: $('#cookie').value.trim(),
  };
}

function renderUser(user) {
  $('#user-panel').hidden = false;
  $('#user-name').textContent = user.nickname || '未知用户';
  $('#user-initial').textContent = (user.nickname || '抖').slice(0, 1);
  $('#user-meta').textContent = [user.unique_id && `抖音号 ${user.unique_id}`, user.uid && `UID ${user.uid}`].filter(Boolean).join(' · ');
  $('#user-signature').textContent = user.signature || '';
  $('#followers').textContent = compactNumber(user.follower_count);
  $('#aweme-count').textContent = compactNumber(user.aweme_count);
  $('#favorited').textContent = compactNumber(user.total_favorited);
}

function renderVideos(videos) {
  const grid = $('#video-grid');
  grid.replaceChildren();
  $('#empty-state').hidden = videos.length > 0;
  $('#results-title').textContent = videos.length ? `${videos.length} 条结果` : '没有找到内容';
  $('#download-all').disabled = videos.length === 0;
  for (const video of videos) {
    const node = $('#video-template').content.cloneNode(true);
    const image = node.querySelector('.cover');
    image.src = video.cover || '';
    image.alt = video.desc ? `${video.desc}的封面` : '作品封面';
    image.addEventListener('error', () => image.remove());
    node.querySelector('.kind').textContent = video.is_image_post ? `图集 · ${video.image_count} 张` : '视频';
    node.querySelector('h3').textContent = video.desc || '无标题作品';
    node.querySelector('time').textContent = video.create_time ? new Date(video.create_time * 1000).toLocaleDateString('zh-CN') : '时间未知';
    node.querySelector('code').textContent = video.aweme_id || '';
    grid.append(node);
  }
}

async function loadStatus() {
  try {
    const cfg = await request('/api/config');
    state.config = cfg;
    $('#runtime-output').textContent = cfg.outputDir;
    $('#status-dot').className = 'online';
    $('#status-text').textContent = cfg.configured ? '服务可用' : '等待配置 API Key';
    $('#output-dir').textContent = `保存至 ${cfg.outputDir}`;
    $('#cookie-hint').textContent = cfg.cookieConfigured ? '已配置全局 Cookie，可留空' : 'Cookie 仅随本次请求使用';
  } catch (error) {
    $('#status-dot').className = 'error';
    $('#status-text').textContent = '服务异常';
    notice(error.message, true);
  }
}

$('#type').addEventListener('change', (event) => {
  const isCollection = event.target.value === 'collect';
  const identifier = $('#identifier');
  $('#cookie-row').hidden = !isCollection;
  identifier.required = !isCollection;
  identifier.placeholder = isCollection ? '收藏列表不需要用户标识' : '抖音号、用户主页链接、UID 或 sec_user_id';
});

$('#lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = currentInput();
  state.lookupId = null;
  $('#download-all').disabled = true;
  setBusy(form, true, '查询中...');
  notice('');
  try {
    const result = await request('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    state.videos = result.videos;
    state.lookupId = result.lookupId;
    if (result.user) renderUser(result.user); else $('#user-panel').hidden = true;
    renderVideos(result.videos);
  } catch (error) {
    notice(error.message, true);
  } finally {
    setBusy(form, false);
  }
});

$('#lookup-form').addEventListener('input', () => {
  state.lookupId = null;
  $('#download-all').disabled = true;
});

$('#download-all').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const values = currentInput();
  if (!state.lookupId) {
    notice('查询条件已变化，请重新查询后再下载。', true);
    return;
  }
  button.disabled = true;
  button.textContent = '提交中...';
  notice('正在加入下载队列…');
  try {
    const data = await request('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, lookupId: state.lookupId }),
    });
    notice('任务已加入队列，可在控制台查看进度。');
    switchView('console');
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = state.videos.length === 0;
    button.textContent = '下载当前列表';
  }
});

$('#single-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setBusy(form, true, '下载中...');
  notice('正在加入下载队列…');
  try {
    const data = await request('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'single', url: $('#single-url').value.trim() }),
    });
    switchView('console');
    notice('任务已加入队列。');
    form.reset();
  } catch (error) {
    notice(error.message, true);
  } finally {
    setBusy(form, false);
  }
});

loadStatus();

function populateFilter(select, values, defaultLabel, labels = {}) {
  const previous = select.value;
  select.replaceChildren(new Option(defaultLabel, ''));
  for (const value of values) select.add(new Option(labels[value] || value, value));
  if (values.includes(previous)) select.value = previous;
}

function renderLibrary() {
  const filtered = state.libraryItems;
  const visible = filtered;
  const list = $('#library-list');
  list.replaceChildren();
  $('#library-results-title').textContent = `${state.libraryTotal} 条内容`;
  $('#library-empty').hidden = filtered.length > 0;
  $('#library-more').hidden = !state.libraryHasMore;

  for (const item of visible) {
    const node = $('#library-row-template').content.cloneNode(true);
    const row = node.querySelector('.library-row');
    const preview = node.querySelector('.library-preview');
    const image = node.querySelector('.media-thumb img');
    const badge = node.querySelector('.media-thumb b');
    if (item.thumbnailUrl && item.mediaSupported?.[0] !== false) {
      image.src = item.thumbnailUrl;
      image.alt = `${item.title}缩略图`;
      useImageFallback(image, item.thumbnailFallbackUrl);
    } else {
      image.removeAttribute('src');
    }
    badge.textContent = item.kind === 'video' ? '视频' : `${item.fileCount} 张`;
    node.querySelector('.library-title-cell strong').textContent = item.title;
    node.querySelector('.library-title-cell small').textContent = item.awemeId || (item.kind === 'video' ? '视频' : `${item.fileCount} 张图片`);
    node.querySelector('.library-owner strong').textContent = item.displayUser || item.user;
    node.querySelector('.library-owner small').textContent = item.type;
    node.querySelector('time').textContent = formatDate(item.downloadedAt);
    node.querySelector('.library-size').textContent = formatBytes(item.size);
    const open = () => openLibraryItem(item.id);
    preview.addEventListener('click', open);
    node.querySelector('.row-action').addEventListener('click', open);
    row.dataset.id = item.id;
    list.append(node);
  }
}

async function loadLibrary({ append = false, refresh = false } = {}) {
  const sequence = ++state.libraryRequest;
  const button = $('#refresh-library');
  const more = $('#library-more');
  button.disabled = true;
  more.disabled = true;
  button.textContent = '读取中...';
  libraryNotice('');
  try {
    const params = new URLSearchParams({ offset: append ? state.libraryItems.length : 0, limit: 24, search: $('#library-search').value.trim(), kind: $('#library-kind').value, user: $('#library-user').value, type: $('#library-type').value, ...(refresh ? { refresh: '1' } : {}) });
    const data = await request(`/api/library?${params}`);
    if (sequence !== state.libraryRequest) return;
    state.libraryItems = append ? [...state.libraryItems, ...data.items] : data.items;
    state.libraryTotal = data.total;
    state.libraryHasMore = data.hasMore;
    $('#stat-total').textContent = data.summary.total;
    $('#stat-videos').textContent = data.summary.videos;
    $('#stat-albums').textContent = data.summary.albums;
    $('#stat-size').textContent = formatBytes(data.summary.bytes);
    $('#library-path').textContent = state.config?.outputDir || '';
    $('#orphan-hint').textContent = data.summary.orphanMetadata ? `${data.summary.orphanMetadata} 条孤立元数据未计入` : '';
    populateFilter($('#library-user'), data.summary.users, '全部用户', data.summary.userNames);
    populateFilter($('#library-type'), data.summary.types, '全部分类');
    renderLibrary();
  } catch (error) {
    if (sequence === state.libraryRequest) libraryNotice(error.message, true);
  } finally {
    if (sequence === state.libraryRequest) {
      button.disabled = false;
      more.disabled = false;
      button.textContent = '刷新';
    }
  }
}

function addDetailMeta(label, value) {
  if (value === null || value === undefined || value === '') return;
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  wrapper.append(dt, dd);
  $('#detail-meta').append(wrapper);
}

function showAlbumImage(item, index) {
  const image = $('#detail-media').querySelector('img');
  image.hidden = false;
  $('#detail-media').querySelector('.unsupported-media')?.remove();
  if (item.mediaSupported?.[index] === false) {
    image.hidden = true;
    const unsupported = document.createElement('span');
    unsupported.className = 'unsupported-media';
    unsupported.textContent = '当前浏览器不支持此图片编码';
    $('#detail-media').append(unsupported);
    for (const [buttonIndex, button] of [...$('#album-strip').children].entries()) {
      button.classList.toggle('active', buttonIndex === index);
    }
    return;
  }
  image.dataset.fallback = '';
  image.src = item.media[index];
  image.alt = `${item.title} 第 ${index + 1} 张`;
  for (const [buttonIndex, button] of [...$('#album-strip').children].entries()) {
    button.classList.toggle('active', buttonIndex === index);
  }
}

async function openLibraryItem(id) {
  try {
    const item = await request(`/api/library/item?id=${encodeURIComponent(id)}`);
    state.selectedItem = item;
    $('#detail-kind').textContent = item.kind === 'video' ? '本地视频' : `本地图集 · ${item.fileCount} 张`;
    $('#detail-title').textContent = item.title;
    $('#detail-media').replaceChildren();
    $('#album-strip').replaceChildren();
    $('#detail-meta').replaceChildren();

    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = item.mediaUrl;
      $('#detail-media').append(video);
    } else {
      const image = document.createElement('img');
      useImageFallback(image, () => image.dataset.fallbackUrl, () => {
        image.hidden = true;
        const unsupported = document.createElement('span');
        unsupported.className = 'unsupported-media';
        unsupported.textContent = '当前浏览器不支持此图片编码';
        $('#detail-media').append(unsupported);
      });
      $('#detail-media').append(image);
      item.media.forEach((url, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        if (item.mediaSupported?.[index] === false) {
          button.textContent = String(index + 1);
          button.title = '该图片编码无法在浏览器中预览';
        } else {
          const thumb = document.createElement('img');
          thumb.src = url;
          thumb.alt = `第 ${index + 1} 张`;
          useImageFallback(thumb, item.fallbackMedia?.[index], () => thumb.remove());
          button.append(thumb);
        }
        button.addEventListener('click', () => {
          image.dataset.fallbackUrl = item.fallbackMedia?.[index] || '';
          showAlbumImage(item, index);
        });
        $('#album-strip').append(button);
      });
      image.dataset.fallbackUrl = item.fallbackMedia?.[0] || '';
      showAlbumImage(item, 0);
    }

    addDetailMeta('用户', item.displayUser || item.user);
    addDetailMeta('分类', item.type);
    addDetailMeta('作品 ID', item.awemeId);
    addDetailMeta('作者', item.author);
    addDetailMeta('发布时间', formatDate(item.createdAt));
    addDetailMeta('下载时间', formatDate(item.downloadedAt));
    addDetailMeta('本地大小', formatBytes(item.size));
    addDetailMeta('媒体文件', item.kind === 'video' ? '1 个视频' : `${item.fileCount} 张图片`);
    addDetailMeta('点赞 / 评论', `${compactNumber(item.statistics?.digg_count)} / ${compactNumber(item.statistics?.comment_count)}`);
    addDetailMeta('音乐', item.music ? `${item.music.title}${item.music.author ? ` · ${item.music.author}` : ''}` : '');
    const share = $('#detail-share');
    share.hidden = !item.shareUrl;
    share.href = item.shareUrl || '#';
    $('#detail-dialog').showModal();
  } catch (error) {
    libraryNotice(error.message, true);
  }
}

function switchView(view) {
  if (!['console', 'download', 'library', 'watchers', 'billing', 'settings'].includes(view)) view = 'console';
  state.view = view;
  clearTimeout(watcherTimer);
  for (const name of ['console', 'download', 'library', 'watchers', 'billing', 'settings']) $(`#${name}-view`).hidden = name !== view;
  for (const tab of document.querySelectorAll('.nav-tab')) { tab.classList.toggle('active', tab.dataset.view === view); tab.setAttribute('aria-current', tab.dataset.view === view ? 'page' : 'false'); }
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'library') loadLibrary();
  if (view === 'console') loadConsole();
  if (view === 'watchers') loadWatchers();
  if (view === 'billing') loadBilling();
  if (view === 'settings') loadSettings();
}
for (const tab of document.querySelectorAll('.nav-tab')) tab.addEventListener('click', () => switchView(tab.dataset.view));
$('#billing-refresh').addEventListener('click', loadBilling);
window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
$('#new-download').addEventListener('click', () => { switchView('download'); $('#identifier').focus(); });
$('#refresh-library').addEventListener('click', () => loadLibrary({ refresh: true }));
let searchTimer;
for (const selector of ['#library-search', '#library-kind', '#library-user', '#library-type']) {
  $(selector).addEventListener(selector === '#library-search' ? 'input' : 'change', () => {
    clearTimeout(searchTimer);
    state.libraryRequest++;
    searchTimer = setTimeout(() => loadLibrary(), selector === '#library-search' ? 250 : 0);
  });
}
$('#library-more').addEventListener('click', () => loadLibrary({ append: true }));
$('#detail-dialog').addEventListener('close', () => {
  const video = $('#detail-media').querySelector('video');
  if (video) video.pause();
});
$('[data-close-detail]').addEventListener('click', () => $('#detail-dialog').close());
$('#request-delete').addEventListener('click', () => {
  if (!state.selectedItem) return;
  $('#delete-message').textContent = `“${state.selectedItem.title}”及其本地媒体和元数据将被永久删除。删除后可以重新下载。`;
  $('#delete-dialog').showModal();
});
$('[data-cancel-delete]').addEventListener('click', () => $('#delete-dialog').close());
$('#confirm-delete').addEventListener('click', async () => {
  if (!state.selectedItem) return;
  const button = $('#confirm-delete');
  button.disabled = true;
  button.textContent = '删除中...';
  try {
    await request(`/api/library/item?id=${encodeURIComponent(state.selectedItem.id)}`, { method: 'DELETE' });
    $('#delete-dialog').close();
    $('#detail-dialog').close();
    state.selectedItem = null;
    await loadLibrary();
    libraryNotice('本地内容已删除。');
  } catch (error) {
    $('#delete-dialog').close();
    libraryNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '确认删除';
  }
});

const taskLabels = { queued: '排队中', running: '下载中', cancelling: '取消中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const typeLabels = { post: '作品', like: '点赞', collect: '收藏' };
let consoleBusy = false;
let consoleTimer;
let lastTaskRender = '';
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function consoleNotice(message, error = false) {
  const node = $('#console-notice');
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('error', error);
}
function renderTasks(data) {
  const signature = JSON.stringify(data);
  if (signature === lastTaskRender) return;
  lastTaskRender = signature;
  const list = $('#task-list');
  list.replaceChildren();
  $('#task-empty').hidden = data.items.length > 0;
  $('#tasks-more').hidden = data.items.length >= data.total;
  for (const job of data.items) {
    const card = element('article', 'task-card');
    card.dataset.id = job.id;
    const head = element('div', 'task-head');
    head.append(element('h3', '', job.label), element('span', `task-status ${job.status}`, taskLabels[job.status] || job.status));
    const progress = element('progress');
    progress.setAttribute('aria-label', `${job.label} 下载进度`);
    const p = job.progress;
    if (p.total !== null) { progress.max = Math.max(1, p.total); progress.value = p.total === 0 && job.status === 'completed' ? 1 : p.completed; }
    else if (!['running', 'cancelling'].includes(job.status)) { progress.max = 1; progress.value = 0; }
    const detail = p.total === null ? '等待获取作品列表' : `已处理 ${p.completed} / ${p.total} · 下载 ${p.downloaded} · 跳过 ${p.skipped} · 失败 ${p.failed}${p.active ? ` · 正在下载 ${p.active}` : ''}`;
    card.append(head, progress, element('p', 'task-detail', detail));
    if (job.error) card.append(element('p', 'task-error', job.error));
    if (job.errors?.length) {
      const errors = element('details', 'task-error');
      errors.append(element('summary', '', '查看失败详情'));
      for (const error of job.errors) errors.append(element('p', '', `${error.awemeId}：${error.message}`));
      card.append(errors);
    }
    const footer = element('div', 'task-footer');
    footer.append(element('span', 'task-time', formatDate(job.createdAt)));
    const action = ['queued', 'running'].includes(job.status) ? 'cancel' : job.canRetry ? 'retry' : null;
    if (action) {
      const button = element('button', 'task-action', action === 'cancel' ? '取消任务' : '重试任务');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await request(`/api/jobs/${job.id}/${action}`, { method: 'POST' }); consoleNotice(action === 'cancel' ? '取消请求已提交。' : '重试任务已加入队列。'); await loadConsole(); }
        catch (error) { consoleNotice(error.message, true); }
        finally { button.disabled = false; }
      });
      footer.append(button);
    }
    card.append(footer);
    list.append(card);
  }
}
function settingsNotice(message, error = false, target = '#settings-notice') {
  const node = $(target);
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('error', error);
}
function renderWatcherCards() {
  const list = $('#watcher-list');
  list.replaceChildren();
  $('#watcher-count').textContent = String(state.watchers.length).padStart(2, '0');
  $('#watcher-empty').hidden = state.watchers.length > 0;
  state.watchers.forEach((watcher, index) => {
    const card = element('article', 'watcher-tile');
    card.dataset.watcherId = watcher.id;
    const top = element('div', 'watcher-tile-top');
    top.append(element('span', 'watcher-number', String(index + 1).padStart(2, '0')), element('span', 'watcher-indicator', watcher.enabled === false ? '● 已暂停' : '● 等待检查'));
    const title = element('h2', '', watcher.name || watcher.cachedName || watcher.identifier);
    const identifier = element('p', 'watcher-id', watcher.identifier);
    identifier.title = watcher.identifier;
    const tags = element('div', 'watcher-tags');
    for (const type of watcher.types || ['post']) tags.append(element('span', '', typeLabels[type] || type));
    const meta = element('p', 'watcher-meta', `每次最多 ${watcher.limit || 20} 条${watcher.cookieConfigured ? ' · 已设置专用 Cookie' : ''}`);
    const actions = element('div', 'watcher-actions');
    const run = element('button', 'primary', '检查新增'); run.type = 'button';
    run.addEventListener('click', async () => {
      run.disabled = true; run.textContent = '加入队列…';
      try { state.poller = await request(`/api/watchers/${index}/run`, { method: 'POST' }); renderPoller(); settingsNotice('目标检查已开始，进度可在此页及任务历史中查看。', false, '#watchers-notice'); }
      catch (error) { settingsNotice(error.message, true, '#watchers-notice'); }
      finally { run.textContent = '检查新增'; renderPoller(); }
    });
    const edit = element('button', 'quiet-button', '编辑'); edit.type = 'button'; edit.addEventListener('click', () => openWatcher(index));
    const refresh = element('button', 'quiet-button', '更新昵称'); refresh.type = 'button';
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { await request(`/api/user?identifier=${encodeURIComponent(watcher.identifier)}`); await loadWatchers(); settingsNotice('昵称已更新并缓存到本地。', false, '#watchers-notice'); }
      catch (error) { settingsNotice(error.message, true, '#watchers-notice'); }
      finally { refresh.disabled = false; }
    });
    const remove = element('button', 'quiet-button danger-text', '移除'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(`移除监控目标“${title.textContent}”？`)) return;
      try { await saveWatcherList(state.watchers.filter((_, i) => i !== index)); settingsNotice('目标已移除，后续轮询已更新。', false, '#watchers-notice'); }
      catch (error) { settingsNotice(error.message, true, '#watchers-notice'); }
    });
    const toggle = element('button', 'quiet-button', watcher.enabled === false ? '启用目标' : '暂停目标'); toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try { await saveWatcherList(state.watchers.map((w, i) => i === index ? { ...w, enabled: w.enabled === false } : w)); settingsNotice('目标启用状态已生效。', false, '#watchers-notice'); }
      catch (error) { settingsNotice(error.message, true, '#watchers-notice'); toggle.disabled = false; }
    });
    run.dataset.watcherRun = '';
    const runtime = element('div', 'watcher-runtime');
    runtime.append(element('p', 'watcher-last-time'), element('p', 'watcher-next-time'), element('p', 'watcher-progress'), element('p', 'watcher-error'));
    actions.append(run, toggle, edit, refresh, remove); card.append(top, title, identifier, tags, meta, runtime, actions); list.append(card);
  });
  if (state.watchers.length && state.watchers.length < 3) {
    const guide = element('aside', `watcher-guide ${state.watchers.length === 1 ? 'wide' : ''}`);
    guide.append(element('span', 'eyebrow', 'MONITORING, SIMPLIFIED'), element('h2', '', '从发现到归档，自动完成。'));
    const steps = element('div', 'watcher-guide-steps');
    for (const [number, title, detail] of [['01', '设置目标', '选择用户与内容类型'], ['02', '启动监听', '自动检查并查看实时进度'], ['03', '查看结果', '新内容进入本地媒体库']]) {
      const step = element('div');
      step.append(element('span', '', number), element('strong', '', title), element('small', '', detail));
      steps.append(step);
    }
    guide.append(steps); list.append(guide);
  }
}
let watcherTimer = null;
let watcherBusy = false;
let pollerBusy = false;
const pollerLabels = { stopped: '监听已停止', waiting: '监听中 · 等待下次检查', running: '正在检查', stopping: '正在停止', error: '监听启动失败' };
const watcherLabels = { idle: '等待检查', paused: '已暂停', queued: '排队中', running: '检查中', cancelling: '正在取消', completed: '已完成', partial: '部分失败', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const pollerTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未运行';
function renderPoller() {
  const data = state.poller;
  if (!data) return;
  $('#poller-status').textContent = pollerLabels[data.status] || data.status;
  $('#poller-status').dataset.status = data.status;
  $('#poller-detail').textContent = data.current ? `本轮已检查 ${data.current.completedTargets} / ${data.current.totalTargets} 个目标` : `${state.watchers.filter(w => w.enabled !== false).length} 个启用目标 · 自动下载未下载作品`;
  $('#poller-last-start').textContent = pollerTime(data.lastStartedAt);
  $('#poller-last-finish').textContent = pollerTime(data.lastFinishedAt);
  let next = '监听已停止';
  if (data.nextRunAt) next = `${pollerTime(data.nextRunAt)}（约 ${Math.max(0, Math.ceil((Date.parse(data.nextRunAt) - Date.now()) / 1000))} 秒后）`;
  else if (data.enabled) next = data.current ? `本轮结束后 ${data.intervalSeconds} 秒` : '等待启用目标';
  $('#poller-next').textContent = next;
  $('#poller-interval').textContent = `${data.intervalSeconds} 秒`;
  const cycle = data.current || data.lastRun;
  $('#poller-progress').max = cycle?.totalTargets || 1;
  $('#poller-progress').value = cycle?.completedTargets || 0;
  const p = data.progress;
  $('#poller-result').textContent = cycle ? `${data.current ? '本轮' : '最近一轮'}：处理 ${p.completed} / ${p.total} 个作品 · 新下载 ${p.downloaded} · 跳过 ${p.skipped} · 失败 ${p.failed}${!data.current ? ` · ${watcherLabels[cycle.status] || cycle.status}` : ''}` : '尚未运行';
  $('#poller-error').hidden = !data.error; $('#poller-error').textContent = data.error || '';
  $('#poller-start').disabled = pollerBusy || data.enabled || data.status === 'stopping' || !state.watchers.some(w => w.enabled !== false);
  $('#poller-stop').disabled = pollerBusy || data.status === 'stopping' || (!data.enabled && !data.current && !data.desiredEnabled);
  $('#poller-run').disabled = pollerBusy || Boolean(data.current) || !state.watchers.some(w => w.enabled !== false);
  for (const target of data.watchers) {
    const card = document.querySelector(`[data-watcher-id="${target.id}"]`);
    if (!card) continue;
    card.querySelector('.watcher-indicator').textContent = `● ${watcherLabels[target.status] || target.status}`;
    card.querySelector('.watcher-last-time').textContent = `最近开始：${pollerTime(target.lastStartedAt)} · 结束：${pollerTime(target.lastFinishedAt)}`;
    card.querySelector('.watcher-next-time').textContent = `下次：${target.nextRunAt ? pollerTime(target.nextRunAt) : state.watchers.find(w => w.id === target.id)?.enabled === false ? '目标已暂停' : data.enabled && data.current ? '本轮结束后安排' : '未安排'}`;
    const stats = target.progress;
    card.querySelector('.watcher-progress').textContent = target.lastStartedAt ? `作品 ${stats.completed}/${stats.total} · 下载 ${stats.downloaded} · 跳过 ${stats.skipped} · 失败 ${stats.failed}` : '等待首次检查';
    card.querySelector('.watcher-error').textContent = target.error || '';
    card.querySelector('[data-watcher-run]').disabled = Boolean(data.current) || pollerBusy;
  }
}
async function pollerAction(action) {
  pollerBusy = true; renderPoller();
  try {
    state.poller = await request(`/api/poller/${action}`, { method: 'POST' });
    settingsNotice(action === 'start' ? '监听已启动，启停状态已保存。' : action === 'stop' ? '监听已停止，正在取消本轮未完成任务。' : '已开始检查全部启用目标。', false, '#watchers-notice');
  } catch (error) { settingsNotice(error.message, true, '#watchers-notice'); }
  finally { pollerBusy = false; renderPoller(); loadWatchers(); }
}
for (const action of ['start', 'stop', 'run']) $(`#poller-${action}`).addEventListener('click', () => pollerAction(action));
async function loadWatchers() {
  if (watcherBusy) return;
  watcherBusy = true; clearTimeout(watcherTimer);
  try {
    const [data, poller] = await Promise.all([request('/api/settings'), request('/api/poller')]);
    const changed = JSON.stringify(state.watchers) !== JSON.stringify(data.watchers);
    state.watchers = data.watchers; state.poller = poller;
    if (changed || !$('#watcher-list').children.length) renderWatcherCards();
    renderPoller();
    if (data.reloadError) settingsNotice(`配置重载失败，继续使用原设置：${data.reloadError}`, true, '#watchers-notice');
  } catch (error) { settingsNotice(error.message, true, '#watchers-notice'); }
  finally { watcherBusy = false; watcherTimer = setTimeout(() => { if (state.view === 'watchers' && !document.hidden) loadWatchers(); }, 2000); }
}
async function saveWatcherList(watchers) {
  const data = await request('/api/watchers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watchers }) });
  state.watchers = data.watchers;
  renderWatcherCards();
  state.poller = await request('/api/poller'); renderPoller();
}
function openWatcher(index = -1) {
  state.editingWatcher = index;
  const form = $('#watcher-form');
  form.reset();
  $('#watcher-dialog-title').textContent = index < 0 ? '添加目标' : '编辑目标';
  const watcher = state.watchers[index];
  if (watcher) {
    form.elements.identifier.value = watcher.identifier;
    form.elements.name.value = watcher.name || '';
    form.elements.limit.value = watcher.limit || 20;
    form.elements.enabled.checked = watcher.enabled !== false;
    for (const box of form.querySelectorAll('[name="types"]')) box.checked = watcher.types?.includes(box.value);
  }
  $('#watcher-dialog').showModal();
  form.elements.identifier.focus();
}
$('#add-watcher').addEventListener('click', () => openWatcher());
$('[data-add-watcher]').addEventListener('click', () => openWatcher());
for (const button of document.querySelectorAll('[data-close-watcher]')) button.addEventListener('click', () => $('#watcher-dialog').close());
$('#watcher-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const types = [...form.querySelectorAll('[name="types"]:checked')].map(box => box.value);
  if (!types.length) { settingsNotice('请至少选择一种监控内容。', true, '#watchers-notice'); return; }
  const watcher = { id: state.watchers[state.editingWatcher]?.id, identifier: form.elements.identifier.value.trim(), name: form.elements.name.value.trim(), types, limit: Number(form.elements.limit.value), enabled: form.elements.enabled.checked, cookie: form.elements.cookie.value, clearCookie: form.elements.clearCookie.checked };
  const next = [...state.watchers];
  if (state.editingWatcher < 0) next.push(watcher); else next[state.editingWatcher] = watcher;
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try { await saveWatcherList(next); $('#watcher-dialog').close(); settingsNotice('目标已保存，后续检查自动使用新配置。', false, '#watchers-notice'); }
  catch (error) { settingsNotice(error.message, true, '#watchers-notice'); }
  finally { button.disabled = false; }
});
async function loadSettings() {
  try {
    const data = await request('/api/settings');
    const form = $('#settings-form');
    for (const [key, value] of Object.entries(data.fields)) {
      if (!form.elements[key]) continue;
      if (form.elements[key].type === 'checkbox') form.elements[key].checked = Boolean(value);
      else form.elements[key].value = value ?? '';
    }
    form.elements.apiKey.value = '';
    form.elements.cookie.value = '';
    form.elements.clearApiKey.checked = false;
    form.elements.clearCookie.checked = false;
    renderSecretStatus(data);
    renderRestartStatus(data);
    if (data.reloadError) settingsNotice(`配置重载失败：${data.reloadError}`, true);
  } catch (error) { settingsNotice(error.message, true); }
}
function renderSecretStatus(data) {
  $('#api-key-status').textContent = data.apiKeyFromEnv ? '环境变量优先；修改配置文件中的密钥不会覆盖它。' : data.apiKeyConfigured ? '已有密钥，留空保持不变。' : '尚未配置。';
  $('#cookie-status').textContent = data.cookieConfigured ? '已有 Cookie，留空保持不变。' : '尚未配置。';
}
function renderRestartStatus(data) {
  $('#restart-banner').hidden = !data.restartRequired;
  const names = { outputDir: '下载目录', dataDir: '数据目录' };
  $('#restart-detail').textContent = `${(data.restartFields || []).map(key => names[key] || key).join('、')}需要重启服务；其他设置已热重载。`;
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = {};
  for (const input of form.querySelectorAll('[name]')) {
    if (['apiKey', 'cookie', 'clearApiKey', 'clearCookie'].includes(input.name)) continue;
    fields[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
  }
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const data = await request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields, apiKey: form.elements.apiKey.value, cookie: form.elements.cookie.value, clearApiKey: form.elements.clearApiKey.checked, clearCookie: form.elements.clearCookie.checked }) });
    renderRestartStatus(data);
    renderSecretStatus(data);
    settingsNotice(data.restartRequired ? '设置已保存并热重载；下载目录或数据目录变更需重启服务。' : '设置已保存并热重载，无需重启。');
    form.elements.apiKey.value = ''; form.elements.cookie.value = '';
    form.elements.clearApiKey.checked = false; form.elements.clearCookie.checked = false;
  } catch (error) { settingsNotice(error.message, true); }
  finally { button.disabled = false; }
});
async function loadConsole() {
  if (consoleBusy) return;
  consoleBusy = true;
  clearTimeout(consoleTimer);
  try {
    const [overview, tasks] = await Promise.all([
      request('/api/console'),
      request(`/api/jobs?limit=${state.taskLimit}&status=${encodeURIComponent($('#task-filter').value)}`),
    ]);
    $('#overview-running').textContent = (overview.tasks.running || 0) + (overview.tasks.cancelling || 0);
    $('#overview-queued').textContent = overview.tasks.queued || 0;
    $('#overview-failed').textContent = (overview.tasks.failed || 0) + (overview.tasks.partial || 0) + (overview.tasks.interrupted || 0);
    $('#overview-media').textContent = overview.library.total;
    $('#overview-size').textContent = `${formatBytes(overview.library.bytes)} 本地空间`;
    $('#overview-concurrency').textContent = `${overview.concurrency.tasks} 个任务 · 每任务 ${overview.concurrency.downloads} 路并发`;
    const minutes = Math.floor(overview.uptimeSeconds / 60);
    $('#runtime-uptime').textContent = minutes < 1 ? `${overview.uptimeSeconds} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    $('#runtime-api').textContent = overview.api.requests;
    $('#runtime-api-results').textContent = `${overview.api.succeeded} / ${overview.api.failed}`;
    renderTasks(tasks);
    const logs = $('#console-logs');
    const bottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 35;
    logs.textContent = overview.logs.length ? overview.logs.map(l => `${new Date(l.time).toLocaleTimeString('zh-CN')}  ${l.level.padEnd(5)}  ${l.message}`).join('\n') : '等待任务运行…';
    if (bottom) logs.scrollTop = logs.scrollHeight;
  } catch (error) { consoleNotice(`控制台更新失败：${error.message}`, true); }
  finally {
    consoleBusy = false;
    consoleTimer = setTimeout(() => { if (state.view === 'console' && !document.hidden) loadConsole(); }, 2000);
  }
}
$('#task-filter').addEventListener('change', () => { state.taskLimit = 30; loadConsole(); });
$('#tasks-more').addEventListener('click', () => { state.taskLimit = Math.min(200, state.taskLimit + 30); loadConsole(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'console') loadConsole(); if (!document.hidden && state.view === 'watchers') loadWatchers(); });
switchView(location.hash.slice(1) || 'console');
