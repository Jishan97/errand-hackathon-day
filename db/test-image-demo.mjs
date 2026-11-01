// Run with an explicit temporary @electric-sql/pglite@0.5.14 dist/index.js path.
// No connection strings, private configuration, project database or dotenv access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
if (!process.argv[2]) throw Error('Pass an explicit PGlite dist/index.js path.');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(await readFile(new URL('./image-demo.sql', import.meta.url), 'utf8'));
  const id = '11111111-1111-4111-8111-111111111111';
  await db.query(`insert into public.errand_image_runs (id,call_hash,nonce,hash,summary,prompt,status)
    values ($1,$2,$1,$3,'Generate a cat picture.','A cat','proposed')`, [id, 'a'.repeat(64), 'b'.repeat(64)]);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query('select * from public.errand_image_runs'), /permission denied/);
    await assert.rejects(db.query("update public.errand_image_runs set status='running'"), /permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  const claim = () => db.query("update public.errand_image_runs set status='running' where id=$1 and status='proposed' returning id", [id]);
  assert.equal((await claim()).rows.length, 1);
  assert.equal((await claim()).rows.length, 0);
  await assert.rejects(db.query("update public.errand_image_runs set status='ready' where id=$1", [id]), /check constraint/);
  await db.query("update public.errand_image_runs set status='ready',image_base64='/9gBAgH/2Q==' where id=$1", [id]);
  assert.equal((await db.query('select status from public.errand_image_runs where id=$1', [id])).rows[0].status, 'ready');
  assert.equal((await claim()).rows.length, 0);
  console.log('Image SQL verified offline: private grants, RLS, one-use claim and ready-image constraint.');
} finally { await db.close(); }
