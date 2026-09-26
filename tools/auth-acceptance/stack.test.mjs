import test from 'node:test';
import { pullImage, pullRetryDelays } from './stack.mjs';

const image = 'registry.invalid/synthetic@sha256:' + '0'.repeat(64);
const refused = (message) => new Error(`Docker pull failed: ${message}`);

// A fake Docker runner that fails with the queued errors, then succeeds.
function runner(failures) {
  const calls = []; const waits = []; const logs = [];
  const run = (args, input, timeout) => {
    calls.push({ args, input, timeout });
    const failure = failures[calls.length - 1];
    if (failure) throw failure;
    return '';
  };
  return { calls, waits, logs, options: { run, wait: (ms) => waits.push(ms), log: (text) => logs.push(text) } };
}

test('the retry schedule is three waits of 20, 40 and 80 seconds', (t) => {
  t.plan(1);
  t.assert.deepEqual(pullRetryDelays, [20_000, 40_000, 80_000]);
});

test('a first-attempt success pulls once and never waits', (t) => {
  t.plan(4);
  const fake = runner([]);
  t.assert.equal(pullImage('db', image, fake.options), 1);
  t.assert.equal(fake.calls.length, 1);
  t.assert.deepEqual(fake.calls[0], { args: ['pull', image], input: undefined, timeout: 180_000 });
  t.assert.equal(fake.waits.length, 0);
});

test('rate-limited pulls are retried with backoff until one succeeds', (t) => {
  t.plan(5);
  const fake = runner([refused('toomanyrequests: Rate exceeded'), refused('Rate exceeded')]);
  t.assert.equal(pullImage('mail', image, fake.options), 3);
  t.assert.equal(fake.calls.length, 3);
  t.assert.deepEqual(fake.waits, [20_000, 40_000]);
  t.assert.equal(fake.logs.length, 5);
  t.assert.deepEqual(fake.logs.filter((text) => text.includes('rate limited')), [
    'Pull of mail image was rate limited; retrying in 20 seconds',
    'Pull of mail image was rate limited; retrying in 40 seconds',
  ]);
});

test('a pull still rate limited after three retries fails with the last error', (t) => {
  t.plan(4);
  const last = refused('toomanyrequests: Rate exceeded (fourth)');
  const fake = runner([refused('toomanyrequests'), refused('toomanyrequests'), refused('toomanyrequests'), last]);
  t.assert.throws(() => pullImage('auth', image, fake.options), (error) => error === last);
  t.assert.equal(fake.calls.length, 4);
  t.assert.deepEqual(fake.waits, [20_000, 40_000, 80_000]);
  t.assert.equal(fake.logs.at(-1), 'Pulling pinned public auth image (attempt 4 of 4)');
});

test('any other pull failure fails at once without waiting', (t) => {
  t.plan(3);
  const other = refused('manifest unknown');
  const fake = runner([other]);
  t.assert.throws(() => pullImage('gateway', image, fake.options), (error) => error === other);
  t.assert.equal(fake.calls.length, 1);
  t.assert.equal(fake.waits.length, 0);
});
