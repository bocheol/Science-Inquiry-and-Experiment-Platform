import test from 'node:test';
import assert from 'node:assert/strict';
import { probeGoogle } from './google-readonly.mjs';

test('K_SERVICE or configured file IDs alone never count as a verified connection', async () => {
  process.env.K_SERVICE = 'synthetic-service';
  try {
    const result = await probeGoogle([{ spreadsheetId: 'synthetic-sheet' }], async () => { throw Error('synthetic-secret'); }, () => { throw Error('must not call'); });
    assert.equal(result.authentication, 'failed_or_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  } finally { delete process.env.K_SERVICE; }
});
test('requests only restricted metadata and never emits tokens or file IDs', async () => {
  const calls = [];
  const result = await probeGoogle([{ spreadsheetId: 'synthetic-sheet', folderId: 'synthetic-folder' }], async () => ({ authorization: 'Bearer synthetic-token' }), async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.startsWith('https://sheets.') ? { spreadsheetId: 'synthetic-sheet' }
      : url.includes('synthetic-folder') ? { mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } }
        : { capabilities: { canEdit: true } });
  });
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.ok(calls.every(call => !/values|permissions|upload/.test(call.url)));
  assert.equal(result.targets[0].spreadsheetRead, true); assert.equal(result.targets[0].folderAddCapability, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|synthetic-sheet|synthetic-folder/);
  assert.equal(result.writesPerformed, false);
});
test('denied metadata is an unverified capability, not success', async () => {
  const result = await probeGoogle([{ spreadsheetId: 'synthetic-sheet', folderId: 'synthetic-folder' }], async () => ({}), async () => new Response('{}', { status: 403 }));
  assert.equal(result.targets[0].spreadsheetRead, false);
  assert.equal(result.targets[0].spreadsheetEditCapability, null);
  assert.equal(result.targets[0].folderAddCapability, null);
});
