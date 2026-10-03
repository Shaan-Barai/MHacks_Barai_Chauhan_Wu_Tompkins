import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AttendanceCache,
  generateAttendance,
  resolveAttendanceSeed,
  ATTENDANCE_GENERATOR_VERSION,
  DEFAULT_ATTENDANCE_MIN,
  DEFAULT_ATTENDANCE_MAX,
} from '../src/attendance.js';

describe('generateAttendance', () => {
  it('is reproducible for the same inputs', () => {
    const a = generateAttendance({
      hallId: 'hall-main',
      serviceId: 'svc_1',
      serviceDate: '2026-10-03',
      seed: 'demo-seed-1',
      env: {},
    });
    const b = generateAttendance({
      hallId: 'hall-main',
      serviceId: 'svc_1',
      serviceDate: '2026-10-03',
      seed: 'demo-seed-1',
      env: {},
    });
    assert.deepEqual(a, b);
    assert.equal(a.source, 'simulated');
    assert.equal(a.generatorVersion, ATTENDANCE_GENERATOR_VERSION);
    assert.equal(a.configuredMin, DEFAULT_ATTENDANCE_MIN);
    assert.equal(a.configuredMax, DEFAULT_ATTENDANCE_MAX);
    assert.ok(a.count >= 300 && a.count <= 1200);
  });

  it('changes when the seed or service key changes', () => {
    const a = generateAttendance({
      hallId: 'hall-main',
      serviceId: 'svc_1',
      serviceDate: '2026-10-03',
      seed: 'seed-a',
      env: {},
    });
    const b = generateAttendance({
      hallId: 'hall-main',
      serviceId: 'svc_1',
      serviceDate: '2026-10-03',
      seed: 'seed-b',
      env: {},
    });
    const c = generateAttendance({
      hallId: 'hall-main',
      serviceId: 'svc_2',
      serviceDate: '2026-10-03',
      seed: 'seed-a',
      env: {},
    });
    assert.notEqual(a.count, b.count);
    assert.notEqual(a.count, c.count);
  });

  it('respects custom bounds and env defaults', () => {
    const a = generateAttendance({
      hallId: 'h',
      serviceId: 's',
      serviceDate: '2026-10-03',
      min: 10,
      max: 10,
      env: {},
    });
    assert.equal(a.count, 10);

    const b = generateAttendance({
      hallId: 'h',
      serviceId: 's',
      serviceDate: '2026-10-03',
      env: { ATTENDANCE_MIN: '100', ATTENDANCE_MAX: '100' },
    });
    assert.equal(b.count, 100);
    assert.equal(b.configuredMin, 100);
  });

  it('rejects inverted bounds', () => {
    assert.throws(() =>
      generateAttendance({
        hallId: 'h',
        serviceId: 's',
        serviceDate: '2026-10-03',
        min: 50,
        max: 10,
        env: {},
      }),
    );
  });
});

describe('resolveAttendanceSeed', () => {
  it('prefers explicit seed, then env seed, then service key', () => {
    assert.equal(
      resolveAttendanceSeed({
        hallId: 'h',
        serviceId: 's',
        serviceDate: 'd',
        seed: 'explicit',
        env: { ATTENDANCE_SEED: 'env' },
      }),
      'explicit',
    );
    assert.equal(
      resolveAttendanceSeed({
        hallId: 'h',
        serviceId: 's',
        serviceDate: 'd',
        env: { ATTENDANCE_SEED: 'env' },
      }),
      'env',
    );
    assert.equal(
      resolveAttendanceSeed({
        hallId: 'h',
        serviceId: 's',
        serviceDate: 'd',
        env: {},
      }),
      'h|s|d',
    );
  });
});

describe('AttendanceCache', () => {
  it('does not regenerate for the same service key', () => {
    const cache = new AttendanceCache();
    const first = cache.getOrCreate({
      hallId: 'h',
      serviceId: 's',
      serviceDate: 'd',
      seed: 'x',
      env: {},
    });
    const second = cache.getOrCreate({
      hallId: 'h',
      serviceId: 's',
      serviceDate: 'd',
      seed: 'different-seed-should-be-ignored',
      env: {},
    });
    assert.equal(first, second);
    assert.equal(first.seed, 'x');
  });
});
