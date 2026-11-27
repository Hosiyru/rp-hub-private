/* Both copies move in one IDB transaction. Only the explicit delete operation may remove a known ID. */
(() => {
    const key = 'rp_hub_characters', mirror = '__rph_verified_characters';
    const identified = card => card && typeof card === 'object' && typeof card.uuid === 'string' && card.uuid;
    function reconcile(db, incoming, deleted = [], expectedRevision) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('store', 'readwrite'), store = tx.objectStore('store');
            const older = store.get(mirror), tombstones = store.get('__rph_deleted_cards');
            const templates=deleted.length?store.get('rp_hub_global_ui_templates'):null;
            const current=store.get(key);
            let result, failure;
            current.onsuccess = () => {
                try {
                    if(expectedRevision!==undefined && RPLocalScope.disk.getItem('__rph_revision_'+RPLocalScope.id)!==expectedRevision)
                        throw Error('备份后出现了新进度，请重试删除');
                    const known = new Map();
                    for (const list of [older.result, current.result].filter(Array.isArray))
                        for (const card of list) if (identified(card)) known.set(card.uuid, card);
                    const candidate = incoming === undefined ? current.result : incoming;
                    if (incoming !== undefined && (!Array.isArray(candidate) || candidate.some(card => !identified(card))))
                        throw Error('角色列表缺少有效实例 ID，已保留原档');
                    // A tab that still holds an old card cannot resurrect an acknowledged deletion.
                    const removed = new Set([...(tombstones.result || []), ...deleted]);
                    if (deleted.length){
                        store.put([...removed], '__rph_deleted_cards');
                        if(Array.isArray(templates.result)){
                            let changed=false;
                            for(const t of templates.result)for(const story of Object.keys(t.runtimeByCharacter||{})){
                                if(deleted.includes(story.split('__branch__')[0])){delete t.runtimeByCharacter[story];changed=true;}
                            }
                            if(changed)store.put(templates.result,'rp_hub_global_ui_templates');
                        }
                    }
                    const candidateList = Array.isArray(candidate) ? candidate : [];
                    result = candidateList.filter(c => c && typeof c==='object' && !removed.has(c.uuid));
                    if (incoming!==undefined && new Set(result.map(c=>c.uuid)).size!==result.length)
                        throw Error('角色实例 ID 重复，已保留原档');
                    const seen = new Set(result.map(c => c.uuid));
                    const missing = [...known.keys()].filter(id => !seen.has(id) && !removed.has(id));
                    if (missing.length) {
                        // Preserve original index-based selections while recovering a shortened list.
                        const live = new Map(result.filter(identified).map(c => [c.uuid,c]));
                        result = [...known].filter(([id]) => !removed.has(id)).map(([id,card]) => live.get(id) || card)
                            .concat(result.filter(c => !known.has(c.uuid)));
                    }
                    // Leave absent legacy keys absent so upstream can run its older-name migration.
                    if (candidate === undefined && older.result === undefined) { result = undefined; return; }
                    if (incoming !== undefined || !Array.isArray(candidate) || result.length !== candidate.length)
                        store.put(result, key);
                    if (result.every(identified) && (deleted.length || incoming !== undefined || !Array.isArray(older.result) || older.result.length !== result.length))
                        store.put(result, mirror);
                } catch (error) { failure = error; tx.abort(); }
            };
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(failure || tx.error || Error('角色存档事务已中止'));
        });
    }
    window.RPLocalLibrary = { key, mirror, reconcile };
})();
