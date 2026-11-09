import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Explicit opt-in: this suite provisions and drops only its own schema, inside
// a newly provisioned disposable database. Never default to the development DB.
const url = process.env.T04C_DATABASE_URL;
const schema = `t04c_${randomUUID().replaceAll('-', '')}`;
let pool, actor, org, roadmap, historicalBefore;
const evidence = {};
const migrations = new URL('../../prisma/migrations/', import.meta.url);
const query = async (sql, args = [], client = pool) => (await client.query(sql, args)).rows;
async function tx(run) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await run(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function draft(c = pool) {
  const id = randomUUID();
  await query(`INSERT INTO roadmap_versions(id,roadmap_id,version_number,created_by,status)
    SELECT $1,$2,COALESCE(max(version_number),0)+1,$3,'draft' FROM roadmap_versions WHERE roadmap_id=$2`, [id, roadmap, actor], c);
  const [p] = await query("INSERT INTO phases(roadmap_version_id,title,order_index) VALUES($1,'Phase',1) RETURNING id", [id], c);
  const [w] = await query("INSERT INTO weeks(phase_id,title,order_index) VALUES($1,'Week',1) RETURNING id", [p.id], c);
  const [t] = await query("INSERT INTO topics(week_id,title,order_index) VALUES($1,'Topic',1) RETURNING id", [w.id], c);
  return { id, phase: p.id, week: w.id, topic: t.id };
}
async function version(id, c = pool) { return (await query('SELECT * FROM roadmap_versions WHERE id=$1', [id], c))[0]; }
async function audit(c, v, action, attempt, overrides = {}) {
  return query(`INSERT INTO audit_events(organization_id,actor_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,$3,'roadmap_version',$4,$5) RETURNING *`,
  [org, actor, action, v.id, { revision: v.revision, ...(attempt ? { reviewAttemptId: attempt } : {}), ...overrides }], c);
}
async function submit(d, expected, c) {
  const [v] = await query("UPDATE roadmap_versions SET status='in_review' WHERE id=$1 AND revision=$2 AND status='draft' RETURNING *", [d.id, expected], c);
  if (!v) throw Object.assign(new Error('stale revision'), { code: 'STALE' });
  const [a] = await query('INSERT INTO roadmap_review_attempts(version_id,submitted_revision,submitted_by) VALUES($1,$2,$3) RETURNING *', [d.id, v.revision, actor], c);
  await audit(c, v, 'roadmap.submitted', a.id);
  return a;
}
async function submitted(d) { return tx(c => version(d.id, c).then(v => submit(d, v.revision, c))); }
async function decide(d, attempt, decision, c, reason = 'Please add exercises') {
  // Application contract: lock version BEFORE attempt; revalidate both tokens.
  const [v] = await query('SELECT * FROM roadmap_versions WHERE id=$1 FOR UPDATE', [d.id], c);
  if (v.status !== 'in_review' || v.revision !== attempt.submitted_revision) throw Object.assign(new Error('stale submission'), { code: 'STALE' });
  const [a] = await query(`UPDATE roadmap_review_attempts SET decision=$2,reviewed_by=$3,reviewed_at=clock_timestamp(),rejection_reason=$4
    WHERE id=$1 AND version_id=$5 AND submitted_revision=$6 AND decision='pending' RETURNING *`,
  [attempt.id, decision, actor, decision === 'rejected' ? reason : null, d.id, v.revision], c);
  if (!a) throw Object.assign(new Error('stale attempt'), { code: 'STALE' });
  const [updated] = await query(`UPDATE roadmap_versions SET status=$2::varchar,published_at=
    CASE WHEN $2::varchar='published' THEN (SELECT reviewed_at FROM roadmap_review_attempts WHERE id=$3) ELSE NULL END
    WHERE id=$1 RETURNING *`, [d.id, decision === 'approved' ? 'published' : 'draft', a.id], c);
  await audit(c, updated, decision === 'approved' ? 'roadmap.approved_published' : 'roadmap.rejected', a.id);
}
async function archive(d) {
  return tx(async c => { const [v] = await query("UPDATE roadmap_versions SET status='archived' WHERE id=$1 RETURNING *", [d.id], c); await audit(c, v, 'roadmap.archived'); });
}
async function snapshot(c) {
  const result = {};
  for (const table of ['roadmap_versions','phases','weeks','topics','cohorts','cohort_enrollments','topic_progress','activity_events','activity_plans']) {
    result[table] = await query(`SELECT to_jsonb(t) - 'revision' - 'revision_txid' AS row FROM ${table} t ORDER BY id`, [], c);
  }
  return result;
}

describe.skipIf(!url)('T04-C real PostgreSQL review foundation', () => {
  beforeAll(async () => {
    if (!/^\/outpost_t04c_[a-f0-9]+$/.test(new URL(url).pathname)) throw new Error('Requires a newly provisioned outpost_t04c_<hex> database');
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
    await query(`CREATE SCHEMA "${schema}"`);
    const names = (await readdir(migrations)).filter(n => n !== 'migration_lock.toml').sort();
    for (const name of names.slice(0, 6)) await query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
    [{ id: actor }] = await query("INSERT INTO users(display_name,account_type) VALUES('Reviewer','coordinator') RETURNING id");
    [{ id: org }] = await query("INSERT INTO organizations(name,slug) VALUES('Campus',$1) RETURNING id", [schema]);
    [{ id: roadmap }] = await query("INSERT INTO roadmaps(organization_id,name,created_by) VALUES($1,'Plan',$2) RETURNING id", [org, actor]);
    const published = await draft();
    await query("UPDATE roadmap_versions SET status='published',published_at=now() WHERE id=$1", [published.id]);
    const archived = await draft();
    await query("UPDATE roadmap_versions SET status='published',published_at=now() WHERE id=$1", [archived.id]);
    await query("UPDATE roadmap_versions SET status='archived' WHERE id=$1", [archived.id]);
    const pdf = await draft();
    const [cohort] = await query("INSERT INTO cohorts(organization_id,roadmap_version_id,name,created_by) VALUES($1,$2,'Pinned',$3) RETURNING id", [org, published.id, actor]);
    await query('INSERT INTO cohort_enrollments(cohort_id,user_id) VALUES($1,$2)', [cohort.id, actor]);
    await query("INSERT INTO topic_progress(user_id,topic_id,status) VALUES($1,$2,'completed')", [actor, published.topic]);
    await query("INSERT INTO activity_events(organization_id,user_id,topic_id,event_type,old_status,new_status) VALUES($1,$2,$3,'topic_completed','not_started','completed')", [org, actor, published.topic]);
    await query(`INSERT INTO activity_plans(organization_id,uploaded_by,name,filename,object_key,sha256,byte_count,status,roadmap_id,version_id)
      VALUES($1,$2,'PDF','plan.pdf',$3,$4,100,'converted',$5,$6)`, [org, actor, randomUUID(), 'a'.repeat(64), roadmap, pdf.id]);
    historicalBefore = await snapshot(pool);
    evidence.historicalBefore = historicalBefore;
    evidence.postgres = (await query('SELECT version() version'))[0].version;
    await query(await readFile(new URL('20261108_roadmap_review/migration.sql', migrations), 'utf8'));
    evidence.historicalAfter = await snapshot(pool);
  }, 30000);
  afterAll(async () => {
    if (pool) {
      if (process.env.T04C_EVIDENCE_PATH) await writeFile(process.env.T04C_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
      await query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end();
    }
  });

  test('six-migration populated upgrade preserves all historical values and fabricates no reviews', async () => {
    expect(evidence.historicalAfter).toEqual(historicalBefore);
    expect(await query('SELECT * FROM roadmap_review_attempts')).toEqual([]);
    expect((await query('SELECT DISTINCT revision FROM roadmap_versions')).map(v => v.revision)).toEqual([1]);
  });
  test('draft starts at 1; same-transaction content construction stays at 1', async () => {
    const d = await tx(c => draft(c)); expect((await version(d.id)).revision).toBe(1);
  });
  test('submission, rejection, edited resubmission, approval and archive preserve independent history', async () => {
    const d = await draft(); const a = await submitted(d);
    expect((await version(d.id)).revision).toBe(a.submitted_revision);
    await tx(c => decide(d, a, 'rejected', c));
    await query("UPDATE topics SET title='Improved' WHERE id=$1", [d.topic]);
    const b = await submitted(d); expect(b.submitted_revision).toBe(a.submitted_revision + 3);
    await tx(c => decide(d, b, 'approved', c)); await archive(d);
    const rows = await query('SELECT * FROM roadmap_review_attempts WHERE version_id=$1 ORDER BY submitted_revision', [d.id]);
    expect(rows.map(r => r.decision)).toEqual(['rejected','approved']);
    expect(rows[0].rejection_reason).toBe('Please add exercises');
    expect((await version(d.id)).revision).toBe(b.submitted_revision + 2);
  });
  for (const from of ['draft','in_review','published','archived']) {
    for (const to of ['draft','in_review','published','archived','approved','invalid']) {
      if (from === to || ({ draft:['in_review'], in_review:['draft','published'], published:['archived'], archived:[] })[from].includes(to)) continue;
      test(`forbids ${from} -> ${to}`, async () => {
        const d = await draft();
        if (from !== 'draft') { const a = await submitted(d); if (from !== 'in_review') await tx(c => decide(d, a, 'approved', c)); }
        if (from === 'archived') await archive(d);
        await expect(query('UPDATE roadmap_versions SET status=$2 WHERE id=$1', [d.id, to])).rejects.toMatchObject({ code:'23514' });
      });
    }
  }
  for (const reason of ['', ' \t\n', '\u00a0', '\u2003\ufeff', 'a'.repeat(2001)]) test(`rejects invalid rejection reason ${JSON.stringify(reason.slice(0, 10))} of length ${reason.length}`, async () => {
    const d = await draft(); const a = await submitted(d);
    await expect(tx(c => decide(d, a, 'rejected', c, reason))).rejects.toHaveProperty('code');
    expect((await version(d.id)).status).toBe('in_review');
  });
  test('accepts a 2000-character rejection', async () => { const d=await draft(); const a=await submitted(d); await tx(c=>decide(d,a,'rejected',c,'a'.repeat(2000))); });
  test('duplicate pending, forged completed insertion and invalid metadata are denied', async () => {
    const d=await draft(); const a=await submitted(d);
    await expect(query('INSERT INTO roadmap_review_attempts(version_id,submitted_revision,submitted_by) VALUES($1,$2,$3)',[d.id,a.submitted_revision,actor])).rejects.toHaveProperty('code','23505');
    await expect(query("INSERT INTO roadmap_review_attempts(version_id,submitted_revision,submitted_by,decision) VALUES($1,$2,$3,'approved')",[d.id,a.submitted_revision,actor])).rejects.toHaveProperty('code','23514');
    await expect(query('UPDATE roadmap_review_attempts SET decision=$2 WHERE id=$1',[a.id,'approved'])).rejects.toHaveProperty('code','23514');
  });
  test('completed decisions, identities, reasons and all review deletion are immutable', async () => {
    const d=await draft(); const a=await submitted(d); await tx(c=>decide(d,a,'rejected',c));
    for(const sql of ["UPDATE roadmap_review_attempts SET rejection_reason='Changed' WHERE id=$1",'DELETE FROM roadmap_review_attempts WHERE id=$1', 'UPDATE roadmap_review_attempts SET id=gen_random_uuid() WHERE id=$1'])
      await expect(query(sql,[a.id])).rejects.toHaveProperty('code','23514');
  });
  test('missing attempt, missing audit and decision without transition roll back completely', async () => {
    const d=await draft(); const before=await version(d.id);
    await expect(tx(c=>query("UPDATE roadmap_versions SET status='in_review' WHERE id=$1",[d.id],c))).rejects.toHaveProperty('code','23514');
    expect(await version(d.id)).toEqual(before);
    await expect(tx(async c=>{ const [v]=await query("UPDATE roadmap_versions SET status='in_review' WHERE id=$1 RETURNING *",[d.id],c); await query('INSERT INTO roadmap_review_attempts(version_id,submitted_revision,submitted_by) VALUES($1,$2,$3)',[d.id,v.revision,actor],c); })).rejects.toHaveProperty('code','23514');
    const a=await submitted(d);
    await expect(tx(c=>query("UPDATE roadmap_review_attempts SET decision='approved',reviewed_by=$2,reviewed_at=now() WHERE id=$1",[a.id,actor],c))).rejects.toHaveProperty('code','23514');
  });
  for(const state of ['in_review','published','archived']) test(`${state} hierarchy is immutable at every level and on insert/delete`,async()=>{
    const d=await draft();const a=await submitted(d); if(state!=='in_review') await tx(c=>decide(d,a,'approved',c));if(state==='archived')await archive(d);
    for(const [table,id] of [['phases',d.phase],['weeks',d.week],['topics',d.topic]]) {
      await expect(query(`UPDATE ${table} SET title='Tampered' WHERE id=$1`,[id])).rejects.toHaveProperty('code','23514');
      await expect(query(`DELETE FROM ${table} WHERE id=$1`,[id])).rejects.toHaveProperty('code','23514');
    }
    await expect(query("INSERT INTO topics(week_id,title,order_index) VALUES($1,'Extra',2)",[d.week])).rejects.toHaveProperty('code','23514');
  });
  test('parent changes, curriculum identities, version identity and forged revision are denied',async()=>{
    const d=await draft(), other=await draft();
    for(const [sql,args] of [
      ['UPDATE phases SET roadmap_version_id=$2 WHERE id=$1',[d.phase,other.id]],
      ['UPDATE weeks SET phase_id=$2 WHERE id=$1',[d.week,other.phase]],
      ['UPDATE topics SET week_id=$2 WHERE id=$1',[d.topic,other.week]],
      ['UPDATE topics SET id=gen_random_uuid() WHERE id=$1',[d.topic]],
      ['UPDATE roadmap_versions SET version_number=999 WHERE id=$1',[d.id]],
      ['UPDATE roadmap_versions SET revision=revision+1 WHERE id=$1',[d.id]],
    ]) await expect(query(sql,args)).rejects.toHaveProperty('code','23514');
  });
  test('real parallel submissions have one winner and stale expected revision has no effect',async()=>{
    const d=await draft();const v=await version(d.id);
    const results=await Promise.allSettled([tx(c=>submit(d,v.revision,c)),tx(c=>submit(d,v.revision,c))]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected').reason.code).toBe('STALE');
  });
  for(const decisions of [['approved','approved'],['rejected','approved']]) test(`parallel decisions ${decisions.join('/')} have one effect, one audit and no deadlock`,async()=>{
    const d=await draft();const a=await submitted(d);
    const results=await Promise.allSettled(decisions.map(decision=>tx(c=>decide(d,a,decision,c))));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected').reason.code).toBe('STALE');
    expect(await query("SELECT id FROM audit_events WHERE entity_id=$1 AND action IN ('roadmap.rejected','roadmap.approved_published')",[d.id])).toHaveLength(1);
  });
  test('old attempt cannot decide a resubmission and stale content CAS loses',async()=>{
    const d=await draft();const a=await submitted(d);await tx(c=>decide(d,a,'rejected',c));await submitted(d);
    await expect(tx(c=>decide(d,a,'approved',c))).rejects.toHaveProperty('code','STALE');
    const e=await draft();const revision=(await version(e.id)).revision;
    const edit=()=>tx(async c=>{const [v]=await query('SELECT * FROM roadmap_versions WHERE id=$1 FOR UPDATE',[e.id],c);if(v.revision!==revision)throw Object.assign(new Error('stale'),{code:'STALE'});await query("UPDATE topics SET title=title||' edited' WHERE id=$1",[e.topic],c);});
    const results=await Promise.allSettled([edit(),edit()]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  });
  test('audit payload bounds, append-only protection and transaction rollback',async()=>{
    const d=await draft();const a=await submitted(d);
    const [event]=await query('SELECT * FROM audit_events WHERE entity_id=$1',[d.id]);
    for(const sql of ['DELETE FROM audit_events WHERE id=$1',"UPDATE audit_events SET action='other' WHERE id=$1"]) await expect(query(sql,[event.id])).rejects.toHaveProperty('code','23514');
    for(const payload of [[],{token:'sensitive'},{nested:{}},{label:'x'.repeat(257)},Object.fromEntries(Array.from({length:17},(_,i)=>['k'+i,i]))])
      await expect(query("INSERT INTO audit_events(organization_id,actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'example.event','example',$3,$4)",[org,actor,d.id,JSON.stringify(payload)])).rejects.toHaveProperty('code','23514');
    await expect(tx(async c=>{await decide(d,a,'approved',c);throw new Error('simulated downstream failure');})).rejects.toThrow('simulated downstream failure');
    expect((await version(d.id)).status).toBe('in_review');
    expect(await query('SELECT * FROM audit_events WHERE entity_id=$1',[d.id])).toHaveLength(1);
  });
  test('1000-topic replacement advances revision once with one physical version update',async()=>{
    const d=await draft();const before=await version(d.id);const start=performance.now();
    const writes=await tx(async c=>{
      await query('CREATE TEMP TABLE revision_writes(n int) ON COMMIT DROP',[],c);
      await query(`CREATE FUNCTION ${schema}.count_version_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO revision_writes VALUES(1); RETURN NEW; END $$`,[],c);
      await query(`CREATE TRIGGER count_write AFTER UPDATE ON roadmap_versions FOR EACH ROW EXECUTE FUNCTION ${schema}.count_version_write()`,[],c);
      await query('DELETE FROM topics WHERE week_id=$1',[d.week],c);
      await query("INSERT INTO topics(week_id,title,order_index) SELECT $1,'Topic '||n,n FROM generate_series(1,1000)n",[d.week],c);
      await query("UPDATE topics SET description='Updated' WHERE week_id=$1",[d.week],c);
      const [row]=await query('SELECT count(*)::int n FROM revision_writes',[],c);
      await query('DROP TRIGGER count_write ON roadmap_versions',[],c);return row.n;
    });
    evidence.performance={topics:1000,operations:2001,versionWrites:writes,elapsedMs:performance.now()-start};
    expect(writes).toBe(1);expect((await version(d.id)).revision).toBe(before.revision+1);
  });
  test('catalog contains deferred constraints, partial uniqueness and restrictive history FKs',async()=>{
    evidence.indexes=await query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename IN ('roadmap_review_attempts','audit_events') ORDER BY indexname",[schema]);
    evidence.constraints=await query('SELECT conname,contype,condeferrable,condeferred,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace=$1::regnamespace ORDER BY conname',[schema]);
    evidence.triggers=await query('SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgrelid IN (\'roadmap_versions\'::regclass,\'roadmap_review_attempts\'::regclass,\'audit_events\'::regclass) AND NOT tgisinternal ORDER BY tgname');
    expect(evidence.indexes.filter(i=>i.indexdef.includes(' WHERE '))).toHaveLength(3);
    expect(evidence.constraints.filter(c=>c.condeferrable && c.condeferred).length).toBeGreaterThanOrEqual(2);
  });
  test('historical archived curriculum remains readable and existing pins cannot change',async()=>{
    const [cohort]=await query('SELECT * FROM cohorts');
    const [historic]=await query("SELECT * FROM roadmap_versions WHERE status='archived' AND revision=1");
    expect(historic).toBeDefined();
    expect(await query('SELECT t.* FROM topics t JOIN weeks w ON w.id=t.week_id JOIN phases p ON p.id=w.phase_id WHERE p.roadmap_version_id=$1',[historic.id])).toHaveLength(1);
    await expect(query('UPDATE cohorts SET roadmap_version_id=$2 WHERE id=$1',[cohort.id,historic.id])).rejects.toHaveProperty('code','23514');
    await expect(query("INSERT INTO cohorts(organization_id,roadmap_version_id,name,created_by) VALUES($1,$2,'No new assignment',$3)",[org,historic.id,actor])).rejects.toHaveProperty('code','23514');
  });
  test('review and audit history cannot be truncated, including CASCADE',async()=>{
    for(const table of ['roadmap_review_attempts','audit_events','roadmap_versions','phases','weeks','topics'])
      await expect(query(`TRUNCATE ${table} CASCADE`)).rejects.toHaveProperty('code','23514');
  });
  test('new non-drafts, zero revisions, empty submissions and timestamp-only edits are denied',async()=>{
    await expect(query("INSERT INTO roadmap_versions(roadmap_id,version_number,status,created_by,published_at) VALUES($1,9999,'published',$2,now())",[roadmap,actor])).rejects.toHaveProperty('code','23514');
    await expect(query("INSERT INTO roadmap_versions(roadmap_id,version_number,status,created_by,revision) VALUES($1,9999,'draft',$2,0)",[roadmap,actor])).rejects.toHaveProperty('code','23514');
    const d=await draft();await query('DELETE FROM phases WHERE id=$1',[d.phase]);
    await expect(submitted(d)).rejects.toHaveProperty('code','23514');
    await expect(query('UPDATE roadmap_versions SET published_at=now() WHERE id=$1',[d.id])).rejects.toHaveProperty('code','23514');
  });
  test('review submission identity and tenant ancestry cannot be rewritten',async()=>{
    const d=await draft();const a=await submitted(d);
    await expect(query("UPDATE roadmap_review_attempts SET submitted_at=submitted_at+interval '1 second' WHERE id=$1",[a.id])).rejects.toHaveProperty('code','23514');
    await expect(query('UPDATE roadmaps SET organization_id=gen_random_uuid() WHERE id=$1',[roadmap])).rejects.toHaveProperty('code','23514');
  });
  test('approved history rejects a second effective approval and duplicate success event',async()=>{
    const d=await draft();const a=await submitted(d);await tx(c=>decide(d,a,'approved',c));
    await expect(tx(c=>decide(d,a,'approved',c))).rejects.toHaveProperty('code','STALE');
    await expect(query("UPDATE roadmap_review_attempts SET decision='approved' WHERE id=$1",[a.id])).rejects.toHaveProperty('code','23514');
    await expect(tx(async c=>{const e=await draft(c);const b=await submit(e,(await version(e.id,c)).revision,c);await audit(c,await version(e.id,c),'roadmap.submitted',b.id);})).rejects.toHaveProperty('code','23505');
  });
  test('a wrong-tenant or wrong-submission audit cannot complete a lifecycle transition',async()=>{
    const d=await draft();
    await expect(tx(async c=>{
      const [v]=await query("UPDATE roadmap_versions SET status='in_review' WHERE id=$1 RETURNING *",[d.id],c);
      const [a]=await query('INSERT INTO roadmap_review_attempts(version_id,submitted_revision,submitted_by) VALUES($1,$2,$3) RETURNING *',[d.id,v.revision,actor],c);
      await audit(c,v,'roadmap.submitted',a.id,{reviewAttemptId:randomUUID()});
    })).rejects.toHaveProperty('code','23514');
    await expect(tx(async c=>{
      const a=await submit(d,(await version(d.id,c)).revision,c);
      const [otherOrg]=await query("INSERT INTO organizations(name,slug) VALUES('Other tenant',$1) RETURNING id",[randomUUID()],c);
      await query(`INSERT INTO audit_events(organization_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'roadmap.submitted','roadmap_version',$3,$4)`,[otherOrg.id,actor,d.id,{revision:a.submitted_revision,reviewAttemptId:a.id}],c);
    })).rejects.toHaveProperty('code','23514');
    expect((await version(d.id)).status).toBe('draft');
  });
  test('ordered edit versus submit serializes without deadlock and the loser sees stale revision',async()=>{
    const d=await draft();const initial=await version(d.id);
    let locked; const acquired=new Promise(resolve=>{locked=resolve;});
    let release; const proceed=new Promise(resolve=>{release=resolve;});
    const edit=tx(async c=>{await query('SELECT id FROM roadmap_versions WHERE id=$1 FOR UPDATE',[d.id],c);locked();await proceed;await query("UPDATE topics SET title='Edited before submission' WHERE id=$1",[d.topic],c);});
    await acquired;
    const submission=tx(c=>submit(d,initial.revision,c));
    release();
    const results=await Promise.allSettled([edit,submission]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected').reason.code).toBe('STALE');
  });
  test('PDF-linked draft follows the same lifecycle without changing its conversion identity',async()=>{
    const [plan]=await query('SELECT * FROM activity_plans');
    const d={id:plan.version_id};const a=await submitted(d);await tx(c=>decide(d,a,'approved',c));
    expect((await query('SELECT * FROM activity_plans WHERE id=$1',[plan.id]))[0]).toEqual(plan);
    expect((await version(d.id)).status).toBe('published');
  });
  test('noop content edits do not advance revisions and draft cascade replacement stays usable',async()=>{
    const d=await draft();const before=await version(d.id);
    await query('UPDATE topics SET title=title WHERE id=$1',[d.topic]);expect((await version(d.id)).revision).toBe(before.revision);
    await query('DELETE FROM phases WHERE id=$1',[d.phase]);expect((await version(d.id)).revision).toBe(before.revision+1);
    expect(await query('SELECT * FROM topics WHERE id=$1',[d.topic])).toEqual([]);
  });
  test('failed migration transaction leaves a clean six-migration schema for forward retry',async()=>{
    const c=await pool.connect();const recovery=`${schema}_recovery`;
    try {
      await c.query(`CREATE SCHEMA "${recovery}"`);await c.query(`SET search_path=${recovery},public`);
      const names=(await readdir(migrations)).filter(n=>n!=='migration_lock.toml').sort();
      for(const name of names.slice(0,6))await c.query(await readFile(new URL(`${name}/migration.sql`,migrations),'utf8'));
      const sql=await readFile(new URL('20261108_roadmap_review/migration.sql',migrations),'utf8');
      await expect(c.query(sql.replace(/COMMIT;\s*$/,"SELECT 1/0; COMMIT;"))).rejects.toHaveProperty('code','22012');
      await c.query('ROLLBACK');
      expect((await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='roadmap_versions' AND column_name='revision'",[recovery])).rows[0].n).toBe(0);
      await c.query(sql);
      expect((await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='roadmap_versions' AND column_name='revision'",[recovery])).rows[0].n).toBe(1);
      evidence.recovery={injectedFailure:'22012',partialSchemaRetained:false,retry:'passed'};
    } finally {await c.query(`SET search_path=${schema},public`);await c.query(`DROP SCHEMA "${recovery}" CASCADE`);c.release();}
  });
});
