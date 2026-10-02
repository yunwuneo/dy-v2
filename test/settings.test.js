import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('settings persist safely, preserve watcher secrets and cache nicknames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-settings-test-'));
  const file = path.join(root, 'config.json');
  const previousConfig = process.env.DOUYIN_CONFIG;
  const previousKey = process.env.TIKHUB_API_KEY;
  process.env.DOUYIN_CONFIG = file;
  process.env.TIKHUB_API_KEY = '';
  fs.writeFileSync(file, JSON.stringify({
    dataDir: path.join(root, 'data'), outputDir: path.join(root, 'downloads'),
    logDir: path.join(root, 'logs'), errorDir: path.join(root, 'errors'),
    apiKey: 'secret-key', cookie: 'global-cookie', saveMetadata: true,
    watchers: [{ identifier: 'MS4wLjABfirst', name: '', types: ['post'], limit: 20, cookie: 'private-cookie' }],
  }));
  try {
    const { publicSettings, saveSettings, saveWatchers, savedWatcher } = await import('../src/settings.js');
    const { cachedName, rememberUser } = await import('../src/profile-cache.js');
    const { config, reloadConfig } = await import('../src/config.js');
    const { redact } = await import('../src/logger.js');
    assert.equal(publicSettings().restartRequired, false);
    assert.equal(JSON.stringify(publicSettings()).includes('secret-key'), false);
    assert.equal(JSON.stringify(publicSettings()).includes('private-cookie'), false);
    assert.equal(saveSettings({ fields: { count: 25 }, apiKey: '', cookie: '' }).restartRequired, false);
    assert.equal(config.count, 25);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'secret-key');
    assert.equal(saveSettings({ clearCookie: true }).cookieConfigured, false);
    assert.equal(saveSettings({ clearApiKey: true }).apiKeyConfigured, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cookie, undefined);
    saveWatchers([{ identifier: 'MS4wLjABfirst', name: '', types: ['post', 'like'], limit: 12, cookie: '' }]);
    assert.equal(savedWatcher(0).cookie, 'private-cookie');
    saveWatchers([{ identifier: 'MS4wLjABfirst', name: '', types: ['post'], limit: 12, cookie: '', clearCookie: true }]);
    assert.equal(savedWatcher(0).cookie, '');
    rememberUser({ sec_user_id: 'MS4wLjABfirst', nickname: '本地昵称' });
    assert.equal(cachedName('MS4wLjABfirst'), '本地昵称');
    assert.equal(publicSettings().watchers[0].cachedName, '本地昵称');
    const id = config.watchers[0].id;
    saveWatchers([{ ...publicSettings().watchers[0], name: '改名', limit: 999, enabled: false }]);
    assert.equal(config.watchers[0].id, id);
    assert.equal(config.watchers[0].enabled, false);
    const previousOutput = config.outputDir;
    const changed = saveSettings({ fields: { outputDir: path.join(root, 'new-downloads'), logDir: path.join(root, 'new-logs') }, apiKey: 'new-secret' });
    assert.deepEqual(changed.restartFields, ['outputDir']);
    assert.equal(config.outputDir, previousOutput);
    assert.equal(config.logDir, path.join(root, 'new-logs'));
    assert.equal(config.apiKey, 'new-secret');
    assert.equal(redact('secret-key new-secret private-cookie global-cookie'), '[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
    const valid = fs.readFileSync(file, 'utf8');
    const invalid = JSON.parse(valid); invalid.count = 0; invalid.apiKey = 'not-applied';
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => reloadConfig(), /count/);
    assert.equal(config.apiKey, 'new-secret');
    assert.equal(config.count, 25);
    assert.match(publicSettings().reloadError, /count/);
    fs.writeFileSync(file, '{');
    assert.throws(() => reloadConfig(), /解析失败/);
    assert.equal(publicSettings().watchers[0].name, '改名');
    fs.writeFileSync(file, valid); reloadConfig();
    assert.equal(publicSettings().reloadError, null);
  } finally {
    if (previousConfig === undefined) delete process.env.DOUYIN_CONFIG; else process.env.DOUYIN_CONFIG = previousConfig;
    if (previousKey === undefined) delete process.env.TIKHUB_API_KEY; else process.env.TIKHUB_API_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
