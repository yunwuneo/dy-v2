import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TIKHUB_API_KEY = 'test-key';

const {
  getUserInfo,
  getVideoDownloadUrl,
  listPosts,
  awemeMeta,
} = await import('../src/douyin.js');
const {
  downloadVideos,
  downloadSingle,
  listVideos,
  lookupVideos,
  prepareVideoBatch,
} = await import('../src/tasks.js');
const { runWatcherOnce } = await import('../src/poller.js');
const { config } = await import('../src/config.js');
const { buildTargetPath, sanitize } = await import('../src/downloader.js');

test('image metadata prefers JPEG download URLs over vvic originals', () => {
  const meta = awemeMeta({
    aweme_id: 'image-id',
    images: [{
      url_list: ['https://cdn.example/image~vvic'],
      download_url_list: [
        'https://cdn.example/image.webp',
        'https://cdn.example/image.jpeg?signature=1',
      ],
    }],
  });
  assert.equal(meta.imageUrls[0], 'https://cdn.example/image.jpeg?signature=1');
});

function response(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function successfulApi(call) {
  if (call.url.includes('handler_user_profile_v2')) {
    return response({ code: 200, data: { user: { nickname: '测试用户', sec_uid: 'SEC_TEST' } } });
  }
  if (call.url.includes('fetch_user_')) {
    return response({ code: 200, data: { aweme_list: [], has_more: false, max_cursor: 0 } });
  }
  throw new Error(`未处理的测试请求: ${call.url}`);
}

test('a download batch resolves a unique_id profile only once', async () => {
  const mock = installFetch(successfulApi);
  try {
    await prepareVideoBatch({ identifier: 'douyin_account', type: 'post', limit: 20 });
    assert.equal(mock.calls.filter((call) => call.url.includes('handler_user_profile_v2')).length, 1);
    assert.equal(mock.calls.filter((call) => call.url.includes('fetch_user_post_videos')).length, 1);
  } finally {
    mock.restore();
  }
});

test('listing by sec_user_id does not request an unused profile', async () => {
  const mock = installFetch(successfulApi);
  try {
    await listVideos({ identifier: 'MS4wLjAB_TEST', type: 'post', limit: 20 });
    assert.equal(mock.calls.filter((call) => call.url.includes('handler_user_profile')).length, 0);
    assert.equal(mock.calls.filter((call) => call.url.includes('fetch_user_post_videos')).length, 1);
  } finally {
    mock.restore();
  }
});

test('downloading a Web lookup reuses its original list', async () => {
  const mock = installFetch(successfulApi);
  try {
    const lookup = await lookupVideos({ identifier: 'lookup_account', type: 'post', limit: 20 });
    const callsAfterLookup = mock.calls.length;
    await downloadVideos({ prepared: lookup.prepared });
    assert.equal(mock.calls.length, callsAfterLookup);
  } finally {
    mock.restore();
  }
});

test('a multi-type watcher shares one user profile request', async () => {
  const mock = installFetch(successfulApi);
  try {
    await runWatcherOnce({ identifier: 'watch_account', types: ['post', 'like'], limit: 20 });
    assert.equal(mock.calls.filter((call) => call.url.includes('handler_user_profile_v2')).length, 1);
    assert.equal(mock.calls.filter((call) => call.url.includes('fetch_user_post_videos')).length, 1);
    assert.equal(mock.calls.filter((call) => call.url.includes('fetch_user_like_videos')).length, 1);
  } finally {
    mock.restore();
  }
});

test('incremental download stops after the first page reaches a known item', async () => {
  const mock = installFetch((call) => {
    if (!call.url.includes('fetch_user_like_videos')) throw new Error(`未处理的测试请求: ${call.url}`);
    return response({
      code: 200,
      data: {
        aweme_list: [{ aweme_id: 'newer' }, { aweme_id: 'known-boundary' }],
        has_more: true,
        max_cursor: 50,
      },
    });
  });
  const store = {
    has: () => true,
    mark: () => {},
  };
  try {
    const result = await downloadVideos({
      identifier: 'MS4wLjAB_BOUNDARY',
      type: 'like',
      limit: 200,
      userContext: { secUserId: 'MS4wLjAB_BOUNDARY', info: {} },
      store,
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(result.stopped_at_known, true);
    assert.equal(result.total, 2);
    assert.equal(result.skipped, 2);
  } finally {
    mock.restore();
  }
});

test('plain list pagination is not truncated by incremental boundaries', async () => {
  const mock = installFetch((call) => {
    const cursor = new URL(call.url).searchParams.get('max_cursor');
    if (cursor === '0') {
      return response({
        code: 200,
        data: { aweme_list: [{ aweme_id: 'page-one' }], has_more: true, max_cursor: 50 },
      });
    }
    return response({
      code: 200,
      data: { aweme_list: [{ aweme_id: 'page-two' }], has_more: false, max_cursor: 0 },
    });
  });
  try {
    const items = await listPosts('SEC_PLAIN_LIST', { limit: 20 });
    assert.equal(mock.calls.length, 2);
    assert.deepEqual(items.map((item) => item.aweme_id), ['page-one', 'page-two']);
  } finally {
    mock.restore();
  }
});

test('identical concurrent TikHub requests share one upstream call', async () => {
  const mock = installFetch(async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return successfulApi(call);
  });
  try {
    await Promise.all([getUserInfo('same_account'), getUserInfo('same_account')]);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('deterministic high-quality URL errors are not retried', async () => {
  const mock = installFetch(() => response({ code: 400, message: 'invalid aweme_id' }));
  try {
    await assert.rejects(() => getVideoDownloadUrl('invalid-id'));
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('TikHub transient business 400 errors are retried with the same parameters', async () => {
  let attempts = 0;
  const mock = installFetch(() => {
    attempts += 1;
    if (attempts === 1) return response({ code: 400, message_zh: '请求失败，请重试。', router: '/api/v1/douyin/web/fetch_video_high_quality_play_url' });
    return response({ code: 200, data: { original_video_url: 'https://cdn.example/video.mp4' } });
  });
  try {
    const result = await getVideoDownloadUrl('transient-id');
    assert.equal(result.original_video_url, 'https://cdn.example/video.mp4');
    assert.equal(attempts, 2);
  } finally {
    mock.restore();
  }
});

test('long multibyte titles are truncated by bytes for filesystem-safe paths', () => {
  const title = sanitize('标题😀'.repeat(100), 100);
  assert.ok(Buffer.byteLength(title, 'utf8') <= 100);
  assert.equal(title, title.normalize());
  const { file } = buildTargetPath('用户'.repeat(100), '点赞', '7679313983878253866', '标题😀'.repeat(100));
  assert.ok(Buffer.byteLength(file.split('/').pop(), 'utf8') < 255);
});

test('an existing single video does not request a high-quality URL again', async () => {
  const originalOutputDir = config.outputDir;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-billing-test-'));
  config.outputDir = outputDir;
  const mock = installFetch((call) => {
    if (call.url.includes('fetch_one_video')) {
      return response({
        code: 200,
        data: {
          aweme_detail: {
            aweme_id: 'existing-id',
            desc: 'existing-video',
            author: { nickname: 'existing-author' },
            video: {},
          },
        },
      });
    }
    throw new Error(`不应请求额外接口: ${call.url}`);
  });
  try {
    const { file } = buildTargetPath('existing-author', '单视频', 'existing-id', 'existing-video');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'existing');
    fs.writeFileSync(file.replace(/\.mp4$/i, '.json'), '{}');

    const result = await downloadSingle('existing-id');
    assert.equal(result.existed, true);
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.includes('fetch_one_video'));
  } finally {
    mock.restore();
    config.outputDir = originalOutputDir;
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('a deterministic detail error does not trigger a high-quality URL request', async () => {
  const mock = installFetch(() => response({ code: 404, message: 'aweme not found' }));
  try {
    await assert.rejects(() => downloadSingle('missing-id'));
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.includes('fetch_one_video'));
  } finally {
    mock.restore();
  }
});

test('deterministic App API errors do not trigger a Web fallback', async () => {
  const mock = installFetch(() => response({ code: 403, message: 'forbidden' }));
  try {
    await assert.rejects(() => listPosts('SEC_TEST', { limit: 20 }));
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.includes('/douyin/app/v3/'));
  } finally {
    mock.restore();
  }
});
