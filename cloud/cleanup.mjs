// The player-facing history list and maintenance retain identical daily and weekly checkpoints.
export const periods=`WITH periods AS (
            SELECT branch,created/86400 AS period,MAX(rowid) AS seq,'day' AS kind FROM sync_revisions WHERE account=?1 AND manifest->>'$.tombstone' IS NULL GROUP BY branch,period
            UNION ALL
            SELECT branch,(created+259200)/604800 AS period,MAX(rowid) AS seq,'week' AS kind FROM sync_revisions WHERE account=?1 AND manifest->>'$.tombstone' IS NULL GROUP BY branch,period
        ), ranked AS (
            SELECT *,ROW_NUMBER() OVER(PARTITION BY branch,kind ORDER BY period DESC) AS position FROM periods
        )`;
const selected="position<=CASE kind WHEN 'day' THEN 7 ELSE 4 END";
export const historyPredicate=selected;

async function slim(db,account){
    return db.prepare(periods+`, kept(id) AS (
        SELECT revision FROM sync_heads WHERE account=?1
        UNION SELECT r.id FROM ranked k JOIN sync_revisions r ON r.rowid=k.seq WHERE `+selected+`
        UNION SELECT revision FROM card_recycle WHERE account=?1 AND removed>unixepoch()-2592000
        UNION SELECT parent FROM card_recycle WHERE account=?1 AND parent IS NOT NULL AND removed>unixepoch()-2592000
        UNION SELECT revision FROM generation_jobs WHERE account=?1 AND status IN ('queued','running')
    )
    UPDATE sync_revisions SET manifest=json_remove(json_set(manifest,'$.tombstone',1,'$.hadTurns',
        COALESCE(json_array_length(manifest,'$.turns'),0)>0),'$.root','$.parts','$.turns')
    WHERE rowid IN (SELECT rowid FROM sync_revisions WHERE account=?1 AND created<unixepoch()-172800
        AND manifest->>'$.tombstone' IS NULL AND id NOT IN (SELECT id FROM kept) LIMIT 100)`).bind(account).run();
}
export async function reserve(db,account){
    return db.prepare(`WITH live(hash) AS (
        SELECT p.value FROM sync_revisions r,json_each(r.manifest,'$.parts') p WHERE r.account=?1
        UNION SELECT p.value->>'$.hash' FROM archives a,json_each(a.manifest,'$.chunks') p WHERE a.account=?1
    ) UPDATE chunks SET pending_delete=1 WHERE account=?1 AND hash IN (
        SELECT hash FROM chunks WHERE account=?1 AND pending_delete=0 AND bytes>0
        AND created<unixepoch()-604800 AND hash NOT IN (SELECT hash FROM live) LIMIT 500)`).bind(account).run();
}
async function finish(env,account){
    const db=env.DB;
    const {results}=await db.prepare('SELECT hash FROM chunks WHERE account=? AND pending_delete=1 LIMIT 500').bind(account).all();
    if(!results.length)return 0;
    const hashes=results.map(r=>r.hash);
    await env.ARCHIVES.delete(hashes.map(h=>'accounts/'+account+'/chunks/'+h));
    await db.prepare('DELETE FROM chunks WHERE account=? AND pending_delete=1 AND hash IN (SELECT value FROM json_each(?))').bind(account,JSON.stringify(hashes)).run();
    return hashes.length;
}
export async function cleanup(env){
    const db=env.DB;
    const account=await db.prepare(`SELECT a.id FROM accounts a LEFT JOIN gc_state g ON g.account=a.id
        WHERE COALESCE(g.last_run,0)<unixepoch()-86400 AND COALESCE(g.lease_until,0)<unixepoch()
        ORDER BY COALESCE(g.last_run,0),a.id LIMIT 1`).first('id');
    if(!account)return;
    // Only one cron may delete objects for this account; the lease outlasts a scheduled invocation.
    const claim=await db.prepare(`INSERT INTO gc_state(account,lease_until) VALUES(?,unixepoch()+3600)
        ON CONFLICT(account) DO UPDATE SET lease_until=excluded.lease_until
        WHERE gc_state.lease_until<unixepoch() AND gc_state.last_run<unixepoch()-86400`).bind(account).run();
    if(!claim.meta.changes)return;
    let complete=false;
    try{
        await finish(env,account);
        const slimmed=await slim(db,account);
        const marked=await reserve(db,account);
        await finish(env,account);
        complete=slimmed.meta.changes<100 && marked.meta.changes<500;
    }finally{
        await db.prepare('UPDATE gc_state SET lease_until=0,last_run=CASE WHEN ? THEN unixepoch() ELSE last_run END WHERE account=?').bind(+complete,account).run();
    }
}
