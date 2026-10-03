import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * End-to-end HTTP/UI checks stay skipped until Agents 5 and 7 publish a
 * runnable local stack. This file documents the intended flow so CI can
 * still load the suite without false greens from empty folders.
 */
const LIVE_E2E = process.env.SCRAP_E2E === '1';

describe('demo flow e2e (live stack)', { skip: !LIVE_E2E }, () => {
  it('uploads a menu, replays a capture, and returns dashboard aggregates', async () => {
    assert.fail('Wire this test when backend + frontend local URLs are published');
  });
});

describe('demo flow e2e placeholder', () => {
  it('remains skipped unless SCRAP_E2E=1', () => {
    assert.equal(LIVE_E2E, false);
  });
});
