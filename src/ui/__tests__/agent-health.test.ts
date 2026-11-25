import { describe, expect, it } from 'vitest';
import { classifyHealth } from '../agent-health';
import { TransportError } from '@src/opencode-v2/http';

describe('classifying an agent health check', () => {
  it('is online with the service version when /api/info answers', () => {
    const health = classifyHealth(undefined, { version: '2.3.2-bc.ba962.whs', pid: 1, urls: [], paths: { tmp: '/t' } });
    expect(health.status).toBe('online');
    expect(health.version).toBe('2.3.2-bc.ba962.whs');
  });

  it('is restricted when the service names an auth or origin problem', () => {
    for (const status of [401, 403]) {
      const health = classifyHealth(new TransportError('http', 'answered', status));
      expect(health.status).toBe('restricted');
      expect(health.detail).toBe(`HTTP ${status}`);
    }
  });

  it('is offline when the service is unreachable, slow, or broken', () => {
    expect(classifyHealth(new TransportError('network', 'failed')).status).toBe('offline');
    expect(classifyHealth(new TransportError('timeout', 'too slow')).status).toBe('offline');
    expect(classifyHealth(new TransportError('http', 'answered 500', 500)).status).toBe('offline');
    expect(classifyHealth(new Error('fetch failed')).status).toBe('offline');
  });
});
