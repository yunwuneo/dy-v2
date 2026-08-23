const $ = (selector) => document.querySelector(selector);
const state = { videos: [], lookupId: null, config: null, libraryItems: [], libraryVisible: 24, selectedItem: null };

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
  button.textContent = '下载中...';
  notice('下载任务运行中，请保持页面开启。');
  try {
    const data = await request('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, lookupId: state.lookupId }),
    });
    notice(`任务完成：下载 ${data.downloaded}，跳过 ${data.skipped}，失败 ${data.failed}。`);
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
  notice('正在下载单个作品，请保持页面开启。');
  try {
    const data = await request('/api/download/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('#single-url').value.trim() }),
    });
    const target = data.file || data.dir || '';
    notice(`下载完成${target ? `：${target}` : ''}`);
    form.reset();
  } catch (error) {
    notice(error.message, true);
  } finally {
    setBusy(form, false);
  }
});

loadStatus();

function populateFilter(select, values, defaultLabel) {
  const previous = select.value;
  select.replaceChildren(new Option(defaultLabel, ''));
  for (const value of values) select.add(new Option(value, value));
  if (values.includes(previous)) select.value = previous;
}

function filteredLibraryItems() {
  const query = $('#library-search').value.trim().toLowerCase();
  const kind = $('#library-kind').value;
  const user = $('#library-user').value;
  const type = $('#library-type').value;
  return state.libraryItems.filter((item) => {
    const searchable = `${item.title} ${item.author} ${item.awemeId} ${item.user} ${item.type}`.toLowerCase();
    return (!query || searchable.includes(query)) && (!kind || item.kind === kind) && (!user || item.user === user) && (!type || item.type === type);
  });
}

function renderLibrary() {
  const filtered = filteredLibraryItems();
  const visible = filtered.slice(0, state.libraryVisible);
  const list = $('#library-list');
  list.replaceChildren();
  $('#library-results-title').textContent = `${filtered.length} 条内容`;
  $('#library-empty').hidden = filtered.length > 0;
  $('#library-more').hidden = visible.length >= filtered.length;

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
    node.querySelector('.library-owner strong').textContent = item.user;
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

async function loadLibrary() {
  const button = $('#refresh-library');
  button.disabled = true;
  button.textContent = '读取中...';
  libraryNotice('');
  try {
    const data = await request('/api/library');
    state.libraryItems = data.items;
    state.libraryVisible = 24;
    $('#stat-total').textContent = data.summary.total;
    $('#stat-videos').textContent = data.summary.videos;
    $('#stat-albums').textContent = data.summary.albums;
    $('#stat-size').textContent = formatBytes(data.summary.bytes);
    $('#library-path').textContent = state.config?.outputDir || '';
    $('#orphan-hint').textContent = data.summary.orphanMetadata ? `${data.summary.orphanMetadata} 条孤立元数据未计入` : '';
    populateFilter($('#library-user'), data.summary.users, '全部用户');
    populateFilter($('#library-type'), data.summary.types, '全部分类');
    renderLibrary();
  } catch (error) {
    libraryNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '刷新';
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

    addDetailMeta('用户', item.user);
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

for (const tab of document.querySelectorAll('.nav-tab')) {
  tab.addEventListener('click', () => {
    const showLibrary = tab.dataset.view === 'library';
    $('#download-view').hidden = showLibrary;
    $('#library-view').hidden = !showLibrary;
    for (const item of document.querySelectorAll('.nav-tab')) item.classList.toggle('active', item === tab);
    if (showLibrary && state.libraryItems.length === 0) loadLibrary();
  });
}

$('#refresh-library').addEventListener('click', loadLibrary);
for (const selector of ['#library-search', '#library-kind', '#library-user', '#library-type']) {
  $(selector).addEventListener(selector === '#library-search' ? 'input' : 'change', () => {
    state.libraryVisible = 24;
    renderLibrary();
  });
}
$('#library-more').addEventListener('click', () => {
  state.libraryVisible += 24;
  renderLibrary();
});
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
