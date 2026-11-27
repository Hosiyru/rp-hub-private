const hash = /^[a-f0-9]{64}$/;
const reject = (status,message) => {throw Object.assign(Error(message),{status});};
const same = (a,b) => a.every(value=>b.includes(value));
export async function syncRoute({db,account,path,method,req,readJson,sha}) {
    if(path==='/sync' && method==='GET') {
        const {results}=await db.prepare(`SELECT h.branch,r.id,r.parent,r.created,json_extract(r.manifest,'$.label') AS label
            FROM sync_heads h JOIN sync_revisions r ON r.account=h.account AND r.id=h.revision
            WHERE h.account=? ORDER BY r.created DESC,r.rowid DESC`).bind(account).all();
        return Response.json(results);
    }
    if(path==='/sync/backups' && method==='GET'){
        const {results}=await db.prepare(`WITH periods AS (
            SELECT branch,created/86400 AS period,MAX(rowid) AS seq,'day' AS kind FROM sync_revisions WHERE account=? GROUP BY branch,period
            UNION ALL
            SELECT branch,(created+259200)/604800 AS period,MAX(rowid) AS seq,'week' AS kind FROM sync_revisions WHERE account=? GROUP BY branch,period
        ), ranked AS (
            SELECT *,ROW_NUMBER() OVER(PARTITION BY branch,kind ORDER BY period DESC) AS position FROM periods
        )
        SELECT r.id,r.branch,r.created,group_concat(k.kind) AS periods,json_extract(r.manifest,'$.label') AS label
        FROM ranked k JOIN sync_revisions r ON r.rowid=k.seq
        WHERE k.position<=CASE k.kind WHEN 'day' THEN 7 ELSE 4 END GROUP BY r.rowid ORDER BY r.created DESC,r.rowid DESC`)
            .bind(account,account).all();
        const removed=await db.prepare(`SELECT revision AS id,parent,branch,card,removed AS created
            FROM card_recycle WHERE account=? AND removed>unixepoch()-2592000 ORDER BY removed DESC`).bind(account).all();
        return Response.json([...removed.results,...results]);
    }
    if(path.startsWith('/sync/') && method==='GET' && hash.test(path.slice(6))){
        const row=await db.prepare('SELECT manifest FROM sync_revisions WHERE account=? AND id=?').bind(account,path.slice(6)).first();
        if(!row)reject(404,'找不到所选修订');
        return Response.json(JSON.parse(row.manifest));
    }
    if(path!=='/sync' || method!=='POST')reject(404,'同步接口不存在');
    const commit=await prepareSync(db,account,await readJson(req,850000),sha);
    await commit.insert.run();
    return Response.json(await commit.result());
}
export async function prepareSync(db,account,m,sha){
    if(!m || !hash.test(m.root)||!Array.isArray(m.parts)||!m.parts.length||m.parts.length>10000||
        m.parts.some(k=>!hash.test(k))||!m.parts.includes(m.root)||
        !(m.parent===null||hash.test(m.parent))||!/^([a-f0-9]{64}|main)$/.test(m.branch)||
        typeof m.label!=='string'||m.label.length>160||
        ['cards','deleted','points'].some(k=>!Array.isArray(m[k])||m[k].some(v=>typeof v!=='string'||v.length>200)))
        reject(400,'同步清单无效');
    const restored=m.restored??[];
    if(!Array.isArray(restored)||(restored.length && m.recoveryVersion!==1)||restored.some(id=>!m.cards.includes(id)||m.deleted.includes(id)))reject(400,'单卡恢复清单无效');
    const turns=m.turns||[];
    if(!Array.isArray(turns)||turns.length>5000||turns.some(t=>!t||[t.story,t.message,t.token].some(v=>typeof v!=='string'||!v||v.length>300)||
        !(t.first===null && t.record===null || hash.test(t.first||'') && hash.test(t.record||''))))reject(400,'游戏回合清单无效');
    const manifest=JSON.stringify({...(m.imageVersion===1?{imageVersion:1}:{}),...(m.gameVersion===1?{gameVersion:1}:{}),...(m.recoveryVersion===1?{recoveryVersion:1}:{}),...(restored.length?{restored}:{}),root:m.root,parts:m.parts,parent:m.parent,branch:m.branch,label:m.label,cards:m.cards,deleted:m.deleted,points:m.points,...(turns.length?{turns}:{})});
    const conflict=`SELECT g.revision FROM json_each(?) t JOIN game_turns g ON g.account=?
        AND g.story=t.value->>'$.story' AND g.message=t.value->>'$.message' AND g.token=t.value->>'$.token'
        WHERE g.first IS NOT (t.value->>'$.first')`;
    const id=await sha(manifest);
    if(m.parent){
        const previous=await db.prepare('SELECT manifest,branch FROM sync_revisions WHERE account=? AND id=?').bind(account,m.parent).first();
        if(previous?.branch!==m.branch)reject(409,'同步基线不属于此分支');
        const before=JSON.parse(previous.manifest);
        if(before.recoveryVersion===1 && m.recoveryVersion!==1)reject(409,'此分支含单卡恢复记录，请使用支持回收站的客户端同步');
        if(before.imageVersion && m.imageVersion!==1)reject(409,'此进度已有图库，请更新客户端或恢复完整本机档案');
        if(before.turns?.length && m.gameVersion!==1)reject(409,'此进度含独立游戏存档，请更新客户端后继续同步');
        if(!same(before.cards,[...m.cards,...m.deleted])||!same(before.points,m.points)||!same(before.deleted,[...m.deleted,...restored])||m.cards.some(k=>m.deleted.includes(k)))
            reject(409,'本机缺少已确认的角色、删除记录或存档点，已保留上一份云档');
    }
    // A diverging device gets its own tip. The trigger advances it only on a new, complete insertion.
    const insert=db.prepare(`INSERT OR IGNORE INTO sync_revisions(account,id,parent,branch,manifest,created)
        SELECT ?,?,?,CASE WHEN (SELECT revision FROM sync_heads WHERE account=? AND branch=?) IS ? THEN ? ELSE ? END,?,unixepoch()
        WHERE NOT EXISTS(SELECT 1 FROM json_each(?) p LEFT JOIN chunks c ON c.account=? AND c.hash=p.value WHERE c.hash IS NULL)
        AND NOT EXISTS (${conflict})`)
        .bind(account,id,m.parent,account,m.branch,m.parent,m.branch,id,manifest,JSON.stringify(m.parts),account,JSON.stringify(turns),account);
    async function result(){
        const row=await db.prepare('SELECT id,branch FROM sync_revisions WHERE account=? AND id=?').bind(account,id).first();
        if(!row){
            const winner=await db.prepare(conflict).bind(JSON.stringify(turns),account).first();
            if(winner){
                const head=await db.prepare('SELECT h.branch,h.revision AS id FROM sync_heads h JOIN sync_revisions r ON r.account=h.account AND r.branch=h.branch WHERE r.account=? AND r.id=?').bind(account,winner.revision).first();
                throw Object.assign(Error('此回合已有正式结算，请拉取已确认的游戏进度'),{status:409,official:head});
            }
            reject(409,'还有未确认的分块，云端版本已保留');
        }
        return row;
    }
    return {id,insert,result};
}
