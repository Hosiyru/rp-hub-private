/* Card ownership is keyed by the host's instance and story IDs. Names are display text. */
(() => {
    'use strict';
    const hub='RPHubDB', images='RPImageLibrary', game='fate-moment-rebuild', cardsKey='rp_hub_characters';
    const templatesKey='rp_hub_global_ui_templates', fields=['chat','branches','classic_memories','image_renders','character'];
    const belongs=(story,id)=>typeof story==='string' && (story===id || story.startsWith(id+'__branch__'));
    const normalized=k=>typeof k==='string'?k.replace(/^silly_tavern_/,'rp_hub_'):'';
    function scoped(k){
        for(const name of fields){
            const prefix='rp_hub_'+name+'_';
            if(k.startsWith(prefix))return {prefix,story:k.slice(prefix.length)};
        }
    }
    const data=(state,name,store)=>state.dbs.find(d=>d.name===name)?.stores.find(s=>s.name===store)?.rows||[];
    const decode=(blocks,id)=>RPLocalArchive.codec.decode(JSON.parse(blocks[id]));
    const value=(rows,key,blocks,otherwise)=>{const row=rows.find(r=>r[0]===key);return row?decode(blocks,row[1]):otherwise;};
    const set=(rows,key,id)=>{const row=rows.find(r=>r[0]===key);if(row)row[1]=id;else rows.push([key,id]);};
    const spec=(name,rows=[])=>({name,keyPath:null,autoIncrement:false,indexes:[],rows});
    const database=(name,stores)=>({name,version:1,stores});
    function selection(ids){
        const owned=s=>ids.some(id=>belongs(s,id));
        const hubKey=k=>{
            const key=normalized(k),scope=scoped(key);
            return key===cardsKey||key===templatesKey||scope && (owned(scope.story)||/^\d+$/.test(scope.story));
        };
        return {
            database:n=>[hub,'SillyTavernDB',images,game].includes(n)||n.startsWith(game+'@')&&owned(n.slice(game.length+1)),
            storage:k=>hubKey(k)&&!!scoped(normalized(k)),
            async rows(name,store,ask){
                if(name!==images && name!==hub && name!=='SillyTavernDB')return Promise.all([ask(store.getAllKeys()),ask(store.getAll())]);
                let keys;
                if(name===images && store.name==='originals'){
                    const slots=await ask(store.transaction.objectStore('slots').getAll());
                    keys=[...new Set(slots.filter(s=>owned(s.owner)&&owned(s.story)&&s.digest).map(s=>s.digest))];
                }else if(name===images && store.name==='slots'){
                    keys=(await ask(store.getAllKeys())).filter(k=>{try{return owned(JSON.parse(k)[0]);}catch{return false;}});
                }else keys=(await ask(store.getAllKeys())).filter(hubKey);
                return [keys,await Promise.all(keys.map(k=>ask(store.get(k))))];
            }
        };
    }
    function library(state,blocks){
        const rows=data(state,hub,'store'),legacy=data(state,'SillyTavernDB','store');
        const cards=value(rows,cardsKey,blocks,value(legacy,'silly_tavern_characters',blocks,[]));
        if(!Array.isArray(cards))throw Error('角色索引无效');
        return cards;
    }
    let parser;
    function loadGameParser(){
        if(window.RPHubUiTemplateUtils)return Promise.resolve();
        if(!parser)parser=(async()=>{
            for(const [name,global] of [['built-in-content','RPHubBuiltinContent'],['core-utils','RPHubUtils'],['data-services','RPHubUiTemplateUtils']]){
                if(window[global])continue;
                await new Promise((ok,no)=>{
                    const script=document.createElement('script');script.src='assets/js/'+name+'.js';
                    script.onload=ok;script.onerror=()=>no(Error('无法加载旧游戏存档读取器'));document.head.append(script);
                });
            }
        })().catch(e=>{parser=null;throw e;});
        return parser;
    }
    async function extract(state,blocks,id){
        const cards=library(state,blocks),index=cards.findIndex(c=>c?.uuid===id);
        if(index<0||cards.filter(c=>c?.uuid===id).length!==1)throw Error('备份中的角色实例缺失或重复');
        const own=s=>belongs(s,id),entries=new Map(),numeric=new Map();
        const sources=[...data(state,'SillyTavernDB','store'),...data(state,hub,'store')];
        for(const [key,block] of sources){
            const k=normalized(key),field=scoped(k);
            if(!field)continue;
            if(own(field.story))entries.set(k,block);
            else if(field.story===String(index)&&['rp_hub_chat_','rp_hub_classic_memories_','rp_hub_branches_'].includes(field.prefix))
                numeric.set(field.prefix+id,block);
        }
        for(const [key,block] of numeric)if(!entries.has(key))entries.set(key,block);
        const put=(v)=>RPLocalArchive.remember(blocks,v);
        entries.set(cardsKey,await put([cards[index]]));
        const templates=value(sources.map(([k,v])=>[normalized(k),v]).reverse(),templatesKey,blocks,[]);
        const cardTemplates=Array.isArray(cards[index].uiTemplates)?cards[index].uiTemplates:[];
        const used=new Set(cardTemplates.map(t=>t.id));
        const picked=[];
        for(const t of templates||[]){
            const runtime=Object.fromEntries(Object.entries(t.runtimeByCharacter||{}).filter(([s])=>own(s)));
            if(Object.keys(runtime).length||used.has(t.id))picked.push({...t,runtimeByCharacter:runtime});
        }
        if(picked.length)entries.set(templatesKey,await put(picked));
        const selected={dbs:[database(hub,[spec('store',[...entries])])],storage:state.storage.filter(([k])=>own(scoped(normalized(k))?.story))};
        const slots=data(state,images,'slots').filter(([key,block])=>{
            if(!own(JSON.parse(key)[0]))return false;
            const s=decode(blocks,block);
            if(!own(s.story)||s.owner!==id||key!==JSON.stringify([s.story,s.message,s.prompt,s.occurrence]))throw Error('图位的角色与故事归属不符');
            return true;
        });
        const originals=new Map(data(state,images,'originals')),kept=new Map();
        for(const [,block] of slots){
            const slot=decode(blocks,block);
            if(!slot.digest||kept.has(slot.digest))continue;
            const ref=originals.get(slot.digest),blob=ref&&decode(blocks,ref);
            if(!(blob instanceof Blob)||await RPSyncFormat.digest(new Uint8Array(await blob.arrayBuffer()))!==slot.digest)throw Error('已登记的原图缺失或摘要不符，已停止操作');
            kept.set(slot.digest,ref);
        }
        if(slots.length)selected.dbs.push(database(images,[spec('slots',slots),spec('originals',[...kept])]));
        selected.dbs.push(...state.dbs.filter(d=>d.name.startsWith(game+'@')&&own(d.name.slice(game.length+1))));
        // Old builds used one table for all stories. Import only tokens explicitly present in this chat.
        const shared=state.dbs.find(d=>d.name===game);
        for(const [key,block] of entries){
            if(!key.startsWith('rp_hub_chat_'))continue;
            const story=key.slice('rp_hub_chat_'.length),name=game+'@'+story;
            const chat=decode(blocks,block);
            if(!Array.isArray(chat))throw Error('聊天记录格式无效');
            const enabled=[...cardTemplates,...(templates||[])];
            if(shared && enabled.some(t=>t.id==='fate_moment_rebuild') && chat.some(m=>!m?.rphFateTurn && typeof m?.content==='string' && m.content.includes('ui_template_updates')))await loadGameParser();
            const tokens=new Set(chat.map(m=>m?.rphFateTurn||window.RPFateSaves?.turn(m,enabled)).filter(Boolean));
            let db=selected.dbs.find(d=>d.name===name);
            if(!db && shared && tokens.size){
                const stores=shared.stores.map(s=>({...s,rows:s.rows.filter(([k])=>tokens.has(k))}));
                if(stores.some(s=>s.rows.length)){
                    if(cards.length>1)throw Error('旧游戏库由多张卡共用，无法核对归属。请从原进度打开这张卡，再用按故事保存的版本恢复');
                    if(!stores.some(s=>s.name==='initial')){
                        const rows=[];for(const [k] of stores.find(s=>s.name==='snapshots')?.rows||[])rows.push([k,await put({legacyToken:k})]);
                        stores.push(spec('initial',rows));
                    }
                    db={...shared,name,stores};selected.dbs.push(db);
                }
            }
            for(const table of ['snapshots','initial']){
                const keys=new Set(db?.stores.find(s=>s.name===table)?.rows.map(r=>r[0]));
                if([...tokens].some(t=>!keys.has(t)))throw Error('聊天引用的游戏回合缺少快照，已停止操作');
            }
        }
        return selected;
    }
    async function merge(current,blocks,part,id){
        const active=library(current,blocks);
        if(active.some(c=>c.uuid===id))throw Error('当前进度已有这张卡，请保留现有版本');
        const [card]=library(part,blocks);
        if(!card||card.uuid!==id)throw Error('恢复源角色不匹配');
        let main=current.dbs.find(d=>d.name===hub);
        if(!main){main=database(hub,[spec('store')]);current.dbs.push(main);}
        for(const d of current.dbs){
            if(d.name===hub||d.name==='SillyTavernDB'){
                const s=d.stores.find(s=>s.name==='store');
                if(s)s.rows=s.rows.filter(([k])=>!belongs(scoped(normalized(k))?.story,id));
            }else if(d.name===images){
                const slots=d.stores.find(s=>s.name==='slots');
                slots.rows=slots.rows.filter(([,v])=>decode(blocks,v).owner!==id);
            }
        }
        current.dbs=current.dbs.filter(d=>!d.name.startsWith(game+'@')||!belongs(d.name.slice(game.length+1),id));
        current.storage=current.storage.filter(([k])=>!belongs(scoped(normalized(k))?.story,id));
        const rows=main.stores.find(s=>s.name==='store').rows;
        for(const [key,block] of data(part,hub,'store')){
            if(key!==cardsKey && key!==templatesKey)set(rows,key,block);
        }
        const put=async(key,v)=>set(rows,key,await RPLocalArchive.remember(blocks,v));
        await put('__rph_deleted_cards',value(rows,'__rph_deleted_cards',blocks,[]).filter(k=>k!==id));
        await put('__rph_restored_cards',[...new Set([...value(rows,'__rph_restored_cards',blocks,[]),id])]);
        const sourceTemplates=value(data(part,hub,'store'),templatesKey,blocks,[]);
        if(sourceTemplates.length){
            const currentTemplates=value(rows,templatesKey,blocks,[]);
            for(const t of sourceTemplates){
                const existing=currentTemplates.find(v=>v.id===t.id);
                if(existing)existing.runtimeByCharacter={...existing.runtimeByCharacter,...t.runtimeByCharacter};
                else if(!(card.uiTemplates||[]).some(v=>v.id===t.id))card.uiTemplates=[...(card.uiTemplates||[]),{...t,scope:'character'}];
            }
            await put(templatesKey,currentTemplates);
        }
        await put(cardsKey,[...active,card]);
        for(const d of part.dbs.filter(d=>d.name!==hub)){
            const at=current.dbs.findIndex(v=>v.name===d.name);
            if(at<0){current.dbs.push(d);continue;}
            if(d.name!==images){current.dbs[at]=d;continue;}
            for(const s of d.stores){
                const table=current.dbs[at].stores.find(v=>v.name===s.name);
                const merged=new Map(table.rows);for(const [k,v] of s.rows)merged.set(k,v);table.rows=[...merged];
            }
        }
        for(const [k,v] of part.storage)set(current.storage,k,v);
    }
    async function fill(source,ids){
        if(!source.readBlock)return;
        for(const id of new Set(ids)){
            if(Object.hasOwn(source.blocks,id))continue;
            const text=await source.readBlock(id);
            if(typeof text!=='string'||await RPLocalArchive.codec.hash(text)!==id)throw Error('备份块缺失或损坏，当前进度已保留');
            source.blocks[id]=text;
        }
    }
    const hubRows=state=>[...data(state,hub,'store'),...data(state,'SillyTavernDB','store')];
    async function list(source){
        await fill(source,hubRows(source.state).filter(([k])=>normalized(k)===cardsKey).map(r=>r[1]));
        return library(source.state,source.blocks);
    }
    async function readCard(source,id){
        const {state,blocks}=source;
        const index=(await list(source)).findIndex(c=>c.uuid===id);
        if(index<0)throw Error('所选角色不在此备份中');
        const ids=hubRows(state).filter(([k])=>{
            const key=normalized(k),field=scoped(key);
            return key===templatesKey||field && (belongs(field.story,id)||field.story===String(index));
        }).map(r=>r[1]);
        const slots=data(state,images,'slots').filter(([k])=>belongs(JSON.parse(k)[0],id));
        await fill(source,[...ids,...slots.map(r=>r[1])]);
        const originals=new Map(data(state,images,'originals'));
        await fill(source,slots.map(([,k])=>decode(blocks,k).digest).filter(Boolean).map(k=>originals.get(k)).filter(Boolean));
        const part=await extract(state,blocks,id);
        await fill(source,part.dbs.flatMap(d=>d.stores.flatMap(s=>s.rows.map(r=>r[1]))));
        source.check?.();return part;
    }
    window.RPCardRecovery={selection,library,list,readCard,extract,merge};
})();
