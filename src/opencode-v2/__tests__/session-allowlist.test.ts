import { describe, expect, it } from 'vitest';
import { SessionAllowlist } from '../session-allowlist';

describe('the session allowlist', () => {
  it('denies everything by default, including a missing session ID', () => {
    const allowlist = new SessionAllowlist();
    expect(allowlist.has('ses_1')).toBe(false);
    expect(allowlist.has(undefined)).toBe(false);
    expect(allowlist.size).toBe(0);
  });

  it('allows only what was added, until it is removed or cleared', () => {
    const allowlist = new SessionAllowlist();
    allowlist.add('ses_1');
    allowlist.add('ses_2');
    expect(allowlist.has('ses_1')).toBe(true);
    expect(allowlist.has('ses_2')).toBe(true);
    expect(allowlist.has('ses_3')).toBe(false);
    expect(allowlist.size).toBe(2);
    allowlist.remove('ses_1');
    expect(allowlist.has('ses_1')).toBe(false);
    expect(allowlist.has('ses_2')).toBe(true);
    allowlist.clear();
    expect(allowlist.has('ses_2')).toBe(false);
    expect(allowlist.size).toBe(0);
  });

  it('does not reopen anything through a second allowlist', () => {
    const first = new SessionAllowlist();
    first.add('ses_1');
    const second = new SessionAllowlist();
    expect(first.has('ses_1')).toBe(true);
    expect(second.has('ses_1')).toBe(false);
  });
});
