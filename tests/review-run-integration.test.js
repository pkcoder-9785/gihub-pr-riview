import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Store, RUN_ABANDONED_TIMEOUT_MINUTES } from '../review/store.js';

const rawUrl = process.env.REVIEW_TEST_DATABASE_URL;

if (!rawUrl) {
  test('PostgreSQL 18 review_run integration tests (skipped: REVIEW_TEST_DATABASE_URL not set)', { skip: 'REVIEW_TEST_DATABASE_URL not set' }, () => {});
} else {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Refusing to run: Invalid REVIEW_TEST_DATABASE_URL format');
  }

  const hostname = parsed.hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error(`Refusing to run: database host must be localhost or 127.0.0.1, got: ${hostname}`);
  }

  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(`Refusing to run: database name must contain "test", got: ${dbName}`);
  }

  const store = new Store(rawUrl);

  after(async () => {
    try {
      await store.pool.query(`
        DROP TABLE IF EXISTS review_run, review_write_slot, review_write_schedule,
        review_publication, review_reservation, review_budget CASCADE;
      `);
    } finally {
      await store.close();
    }
  });

  test('1. Table creation and idempotency', async () => {
    await store.pool.query(`
      DROP TABLE IF EXISTS review_run, review_write_slot, review_write_schedule,
      review_publication, review_reservation, review_budget CASCADE;
    `);

    // First init
    await store.init();

    // Verify review_run table exists and has expected columns
    const columnsRes = await store.pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'review_run'
      ORDER BY ordinal_position;
    `);
    const columnNames = columnsRes.rows.map((r) => r.column_name);
    assert.deepEqual(
      columnNames.sort(),
      ['created_at', 'identity_key', 'state', 'updated_at'].sort(),
      'review_run columns must match expected schema',
    );

    // Verify older tables exist
    const tablesRes = await store.pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'review_budget', 'review_reservation', 'review_publication',
        'review_write_schedule', 'review_write_slot', 'review_run'
      );
    `);
    const createdTables = tablesRes.rows.map((r) => r.table_name);
    assert.equal(createdTables.length, 6, 'All 6 review tables must exist');

    // Reset ready cache and run init a second time against Postgres
    store.ready = null;
    await store.init();

    const columnsRes2 = await store.pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'review_run';
    `);
    assert.equal(columnsRes2.rows.length, 4, 'Second init must not alter column count');
  });

  test('2. Basic claim behavior and state transitions', async () => {
    const key1 = 'test:basic:key1';

    // New key is claimed and state is 'started'
    const res1 = await store.claimRun(key1);
    assert.deepEqual(res1, { claimed: true });
    const row1 = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key1])).rows[0];
    assert.equal(row1.state, 'started');

    // Same key again returns in_progress with no error
    const res2 = await store.claimRun(key1);
    assert.deepEqual(res2, { claimed: false, reason: 'in_progress' });

    // Key marked done is not claimable
    await store.markRunDone(key1);
    const resDone = await store.claimRun(key1);
    assert.deepEqual(resDone, { claimed: false, reason: 'done' });

    // Key marked failed is claimable (retry_failed)
    const keyFailed = 'test:basic:failed';
    await store.claimRun(keyFailed);
    await store.markRunFailed(keyFailed);
    const resFailed = await store.claimRun(keyFailed);
    assert.deepEqual(resFailed, { claimed: true, reason: 'retry_failed' });

    // Stale key is claimable (retry_stale)
    const keyStale = 'test:basic:stale';
    await store.claimRun(keyStale);
    await store.markRunStale(keyStale);
    const resStale = await store.claimRun(keyStale);
    assert.deepEqual(resStale, { claimed: true, reason: 'retry_stale' });

    // Started row older than RUN_ABANDONED_TIMEOUT_MINUTES is claimable (retry_abandoned)
    const keyAbandoned = 'test:basic:abandoned';
    await store.claimRun(keyAbandoned);
    await store.pool.query(
      `UPDATE review_run SET updated_at = now() - interval '${RUN_ABANDONED_TIMEOUT_MINUTES + 5} minutes' WHERE identity_key = $1`,
      [keyAbandoned],
    );
    const resAbandoned = await store.claimRun(keyAbandoned);
    assert.deepEqual(resAbandoned, { claimed: true, reason: 'retry_abandoned' });
  });

  test('3. Terminal-state writes and idempotency', async () => {
    const key = 'test:terminal:idempotent';
    await store.claimRun(key);

    // markRunDone and repeat
    await store.markRunDone(key);
    let state = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key])).rows[0].state;
    assert.equal(state, 'done');
    await store.markRunDone(key);
    state = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key])).rows[0].state;
    assert.equal(state, 'done');

    // markRunStale and repeat
    await store.markRunStale(key);
    state = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key])).rows[0].state;
    assert.equal(state, 'stale');
    await store.markRunStale(key);
    state = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key])).rows[0].state;
    assert.equal(state, 'stale');

    // markRunFailed and repeat
    await store.markRunFailed(key);
    state = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key])).rows[0].state;
    assert.equal(state, 'failed');
    await store.markRunFailed(key);
    state = (await store.pool.query('SELECT state FROM review_run WHERE identity_key = $1', [key])).rows[0].state;
    assert.equal(state, 'failed');
  });

  test('4. Real race: 50 rounds with 50 distinct keys between two store instances', async () => {
    const storeA = new Store(rawUrl);
    const storeB = new Store(rawUrl);
    await storeA.init();
    await storeB.init();

    try {
      for (let round = 1; round <= 50; round++) {
        const key = `test:race:round-${round}-${Date.now()}`;
        const [resA, resB] = await Promise.all([storeA.claimRun(key), storeB.claimRun(key)]);

        const aWon = resA.claimed === true && resB.claimed === false && resB.reason === 'in_progress';
        const bWon = resB.claimed === true && resA.claimed === false && resA.reason === 'in_progress';

        assert.ok(
          aWon || bWon,
          `Round ${round} failed: expected exactly one winner and one in_progress, got A=${JSON.stringify(resA)} B=${JSON.stringify(resB)}`,
        );
      }
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  test('5. Concurrent load test: 50 distinct keys claimed concurrently', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `test:load:key-${i}-${Date.now()}`);
    const start = performance.now();
    const results = await Promise.all(keys.map((k) => store.claimRun(k)));
    const durationMs = performance.now() - start;

    assert.equal(results.length, 50);
    for (let i = 0; i < results.length; i++) {
      assert.deepEqual(
        results[i],
        { claimed: true },
        `Key ${keys[i]} claim failed: got ${JSON.stringify(results[i])}`,
      );
    }
    console.log(`[LOAD TEST DURATION] 50 concurrent claims completed in ${durationMs.toFixed(2)}ms`);
  });

  test('6. Real Postgres engine version check', async () => {
    const result = await store.pool.query('SELECT version();');
    const versionString = result.rows[0].version;
    assert.ok(versionString.includes('PostgreSQL 18.3'), `Expected PostgreSQL 18.3, got: ${versionString}`);
    console.log(`[POSTGRES VERSION] ${versionString}`);
  });
}
