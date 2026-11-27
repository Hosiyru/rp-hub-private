/* Read the original RP Sync manifest and chunks without opening the player's databases. */
(() => {
    'use strict';
    const streamFormat='rp-sync-jsonl-v1', oldFormat='rp-sync-json-v3';
    const MiB=1024*1024, checksum=/^[0-9a-f]{64}$/;
    const {encode,hash}=RPLocalArchive.codec;
    function requireData(condition,message){if(!condition)throw Error('旧分片档案：'+message);}
    const utf8=()=>new TextDecoder('utf-8',{fatal:true});
    const integer=(v,min=0)=>Number.isSafeInteger(v) && v>=min;
    async function source(files){
        if(files.length===1 && !files[0].webkitRelativePath){
            const file=files[0],header=await file.slice(0,8).arrayBuffer();
            requireData(header.byteLength===8 && new DataView(header).getUint32(0)===0x52504831,'迁移文件头无效');
            const size=new DataView(header).getUint32(4,true);
            requireData(size>0 && size<=4*MiB && 8+size<file.size,'迁移清单长度无效');
            const manifest=JSON.parse(utf8().decode(await file.slice(8,8+size).arrayBuffer()));
            requireData(file.size===8+size+manifest.totalBytes,'迁移文件缺片或长度不符');
            return {manifest,read:(c,offset)=>file.slice(8+size+offset,8+size+offset+c.length)};
        }
        const manifests=files.filter(f=>f.name==='manifest.json' && !f.webkitRelativePath.includes('/manifest-history/'));
        requireData(manifests.length===1,'请选择包含一个 manifest.json 和 chunks 的快照目录');
        const file=manifests[0],base=file.webkitRelativePath.slice(0,-file.name.length);
        requireData(file.size<=4*MiB,'清单过大');
        const parts=new Map(files.map(f=>[f.webkitRelativePath,f]));
        return {manifest:JSON.parse(await file.text()),read:c=>parts.get(base+'chunks/'+c.checksum+'.bin')};
    }
    function checkManifest(m){
        const stream=m.snapshotFormat===streamFormat && m.schemaVersion===4;
        requireData(stream || ((!m.snapshotFormat || m.snapshotFormat===oldFormat) && (m.schemaVersion==null || m.schemaVersion===3)),'不支持此快照格式或版本');
        requireData(integer(m.recordCount) && integer(m.totalBytes,1) && m.totalBytes<=1024*MiB && checksum.test(m.checksum),'整档信息无效');
        requireData(Array.isArray(m.chunkManifest) && integer(m.chunkCount,1) && m.chunkCount<=10000 && m.chunkCount===m.chunkManifest.length,'分片清单不完整');
        let size=0;
        for(const [i,c] of m.chunkManifest.entries()){
            requireData(c && c.index===i && checksum.test(c.checksum) && integer(c.length,1) && c.length<=8*MiB,'第 '+(i+1)+' 片信息无效');
            size+=c.length;
        }
        requireData(size===m.totalBytes,'分片总长度不符');
        return stream;
    }
    function archiveBuilder(){
        const state={dbs:[],storage:[]},blocks={},storageKeys=new Set(),dbNames=new Set();
        const summary={cards:0,messages:0,pluginData:0,scripts:0,pluginSettings:0,recovered:0};
        let count=0,order=null,whole=null,main,split=new Map();
        async function put(store,key,value){
            const str=JSON.stringify(await encode(value)),id=await hash(str);
            blocks[id]=str;store.rows.push([await encode(key),id]);
        }
        function setting(key,value){
            requireData(typeof key==='string' && !key.startsWith('__rph_') && !storageKeys.has(key) && typeof value==='string','本地设置无效或重复');
            storageKeys.add(key);count++;
            if(key==='rp_hub_sync_password_v1')return;
            if(key.startsWith('rph_mod_') || key==='rp_hub_workshop_modules_v1')summary.pluginSettings++;
            state.storage.push([key,value]);
        }
        function database(d){
            requireData(typeof d.name==='string' && d.name && !d.name.startsWith('__rph_') && !dbNames.has(d.name) && integer(d.version??1,1) && Array.isArray(d.stores),'数据库定义无效或重复');
            dbNames.add(d.name);
            const db={name:d.name,version:d.version??1,stores:[]},table=new Map();state.dbs.push(db);
            for(const s of d.stores){
                requireData(typeof s.name==='string' && !table.has(s.name),'对象仓库名称无效或重复');
                const store={name:s.name,keyPath:s.keyPath??null,autoIncrement:!!s.autoIncrement,indexes:[],rows:[]};
                const entry={db:db.name,store,keys:new Set()};db.stores.push(store);table.set(s.name,entry);
                if(db.name==='RPHubDB' && s.name==='store')main=entry;
            }
            return table;
        }
        async function record(entry,key,value){
            const {db,store,keys}=entry;
            let validKey=false;try{indexedDB.cmp(key,key);validKey=true;}catch{}
            const token=JSON.stringify(key);
            requireData(validKey && !keys.has(token),'对象记录键无效或重复');
            if(store.keyPath!==null){
                const extract=path=>path===''?value:path.split('.').reduce((v,k)=>v?.[k],value);
                const inline=Array.isArray(store.keyPath)?store.keyPath.map(extract):extract(store.keyPath);
                requireData(inline!==undefined && indexedDB.cmp(key,inline)===0,'对象记录与内联主键不符');
            }
            keys.add(token);count++;
            if(db==='RPHubWorkshop' && store.name==='data')summary.pluginData++;
            if(db==='RPHubWorkshop' && store.name==='scripts')summary.scripts++;
            if(entry===main && typeof key==='string'){
                if(key==='rp_hub_characters'){requireData(Array.isArray(value),'角色列表无效');whole=value;return;}
                if(key==='rp_hub_character_index'){requireData(Array.isArray(value?.order),'角色索引无效');order=value.order;return;}
                if(key.startsWith('rp_hub_character_')){
                    const uuid=key.slice('rp_hub_character_'.length);
                    requireData(uuid && value?.uuid===uuid,'角色正文与实例 ID 不符');split.set(uuid,value);return;
                }
                if(key.startsWith('rp_hub_chat_') && Array.isArray(value))summary.messages+=value.length;
            }
            await put(store,key,value);
        }
        async function finish(m){
            requireData(count===m.recordCount && count>0,'记录数不符或快照为空');
            if(main){
                requireData(!(whole && (order!==null || split.size)),'两套角色索引同时存在，请检查原档');
                const cards=whole||[],ids=new Set();
                for(const [i,c] of cards.entries()){
                    requireData(c && typeof c==='object' && !Array.isArray(c),'角色正文无效');
                    if(c.uuid==null || c.uuid==='')c.uuid='legacy-'+(await hash(m.checksum+'/'+i)).slice(0,32);
                    requireData(typeof c.uuid==='string' && !ids.has(c.uuid),'角色实例 ID 重复或无效');ids.add(c.uuid);
                }
                for(const id of order||[]){
                    requireData(split.has(id) && !ids.has(id),'索引引用了缺失或重复的角色正文');
                    ids.add(id);cards.push(split.get(id));
                }
                for(const [id,card] of split)if(!ids.has(id)){cards.push(card);summary.recovered++;}
                if(whole || order || split.size)await put(main.store,'rp_hub_characters',cards);
                summary.cards=cards.length;
            }
            const run={id:'main',name:'旧魔改进度',state,points:[]};
            const body={version:1,active:run.id,runs:[run],blocks};
            return {body,digest:await hash(JSON.stringify(['rp-sync',m.checksum])),legacy:summary};
        }
        return {setting,database,record,finish};
    }
    function streamReader(builder,manifest){
        let phase='header',db,stores,entry,array;
        return async line=>{
            const sameStore=()=>db===line.database && entry?.store.name===line.store;
            switch(line.type){
            case 'snapshot':
                requireData(phase==='header' && line.format===streamFormat && line.schemaVersion===4 && (line.workshopVersion==null || line.workshopVersion===1),'快照头无效');phase='settings';break;
            case 'localStorage':
                requireData(phase==='settings','设置顺序无效');builder.setting(line.key,line.value);break;
            case 'localStorageEnd':
                requireData(phase==='settings','设置结束标记无效');phase='databases';break;
            case 'database':
                requireData(phase==='databases' && !db,'数据库起始标记无效');stores=builder.database(line);db=line.name;break;
            case 'databaseEnd':
                requireData(db && db===line.name && !stores.size && !entry,'数据库未完整结束');db=null;break;
            case 'snapshotEnd':
                requireData(phase==='databases' && !db && line.recordCount===manifest.recordCount,'快照未完整结束');phase='done';break;
            case 'record':case 'recordArrayStart':case 'recordArrayItem':case 'recordArrayEnd':case 'storeEnd':
                entry??=stores?.get(line.store);
                requireData(entry && sameStore(),'记录的库、表或次序不符');
                if(line.type==='recordArrayItem'){
                    requireData(array && line.index===array.values.length && line.index<array.length && Object.hasOwn(line,'value'),'数组元素缺失或乱序');array.values.push(line.value);
                }else if(line.type==='recordArrayEnd'){
                    requireData(array && array.values.length===array.length,'数组长度不符');await builder.record(entry,array.key,array.values);array=null;
                }else{
                    requireData(!array,'前一条数组尚未结束');
                    if(line.type==='recordArrayStart'){
                        requireData(integer(line.length),'数组长度无效');array={key:line.key,length:line.length,values:[]};
                    }else if(line.type==='record'){
                        requireData(Object.hasOwn(line,'value'),'记录缺值');await builder.record(entry,line.key,line.value);
                    }else{stores.delete(line.store);entry=null;}
                }break;
            default: throw Error('旧分片档案含未知记录，已停止导入');
            }
            return phase;
        };
    }
    async function read(files,progress=()=>{}){
        const {manifest:m,read:part}=await source(Array.from(files)),stream=checkManifest(m);
        const builder=archiveBuilder(),consume=streamReader(builder,m),decoder=utf8();
        const raw=[];let tail='',phase,offset=0;
        if(stream){
            const signature=[streamFormat,4,m.recordCount,m.totalBytes,m.chunkManifest.map(c=>[c.checksum,c.length])];
            requireData(await hash(JSON.stringify(signature))===m.checksum,'清单摘要不符');
        }
        for(const c of m.chunkManifest){
            const file=part(c,offset);
            requireData(file && file.size===c.length,'第 '+(c.index+1)+' 片缺失或长度不符');
            const bytes=new Uint8Array(await file.arrayBuffer());
            requireData(await RPSyncFormat.digest(bytes)===c.checksum,'第 '+(c.index+1)+' 片摘要不符');
            offset+=c.length;progress(c.index+1,m.chunkCount);
            if(stream){
                const lines=(tail+decoder.decode(bytes,{stream:true})).split('\n');tail=lines.pop();
                for(const line of lines)phase=await consume(JSON.parse(line));
            }else raw.push(file);
        }
        if(stream){
            tail+=decoder.decode();if(tail)phase=await consume(JSON.parse(tail));
            requireData(phase==='done','缺少快照结束标记');
        }else{
            const bytes=await new Blob(raw).arrayBuffer();
            requireData(await RPSyncFormat.digest(new Uint8Array(bytes))===m.checksum,'整档摘要不符');
            const snapshot=JSON.parse(decoder.decode(bytes));
            requireData(Array.isArray(snapshot.indexedDB)||Array.isArray(snapshot.localStorage),'旧版 JSON 缺少数据区');
            for(const row of snapshot.localStorage||[])builder.setting(row.key,row.value);
            for(const db of snapshot.indexedDB||[]){
                const stores=builder.database(db);
                for(const s of db.stores){
                    requireData(Array.isArray(s.records),'对象仓库缺少记录列表');
                    for(const r of s.records){requireData(Object.hasOwn(r,'value'),'记录缺值');await builder.record(stores.get(s.name),r.key,r.value);}
                }
            }
        }
        return builder.finish(m);
    }
    window.RPLegacyShards={read};
})();
