/* The file stays the backing store for verified rows until the player confirms import. */
(() => {
    'use strict';
    const archive=RPLocalArchive,hash=archive.codec.hash;
    const prefix='{"type":"rp-hub-local","version":2,';
    async function prepare(run){
        const source=await RPFirstConnection.transferSource(await RPCaptureCache.collect(run));
        const header={type:'rp-hub-local',version:2,active:source.body.active,runs:source.body.runs,blockCount:source.ids.length};
        const first=JSON.stringify(header),digest=await hash(first);
        async function* lines(){
            yield first+'\n';
            for(const id of source.ids){
                const text=await source.readBlock(id);
                if(await hash(text)!==id)throw Error('导出期间数据块已变化，请重试');
                yield JSON.stringify([id,text])+'\n';
            }
            source.check();yield JSON.stringify({end:true,digest})+'\n';
        }
        return {source,digest,lines};
    }
    async function fileOf(lines){
        const parts=[];let batch=[],bytes=0;
        for await(const line of lines){
            const blob=new Blob([line]);batch.push(blob);bytes+=blob.size;
            if(bytes>=8*1024*1024){parts.push(new Blob(batch));batch=[];bytes=0;}
        }
        return new Blob([...parts,...batch],{type:'application/x-ndjson'});
    }
    async function read(file){
        let start=0,offset=0,header,digest,end=false,wanted;
        const index=new Map(),reader=file.stream().getReader();
        async function accept(stop){
            const text=await file.slice(start,stop).text();
            let record;try{record=JSON.parse(text);}catch{throw Error('档案行损坏或文件不完整');}
            if(end)throw Error('档案末行后仍有内容');
            if(!header){
                header=record;
                if(header.type!=='rp-hub-local'||header.version!==2||!Array.isArray(header.runs)||
                    !header.runs.some(r=>r.id===header.active)||new Set(header.runs.map(r=>r.id)).size!==header.runs.length)throw Error('档案分支清单不完整');
                wanted=RPImageRemovals.refs(header.runs.flatMap(r=>[r.state,...r.points.map(p=>p.state)]));
                if(wanted.size!==header.blockCount)throw Error('档案块数不匹配');
                digest=await hash(text);
            }else if(Array.isArray(record)){
                const [id,row]=record;
                if(record.length!==2 || !wanted.has(id)||index.has(id)||typeof row!=='string'||await hash(row)!==id)throw Error('档案数据块损坏或重复');
                index.set(id,[start,stop]);
            }else{
                if(record?.end!==true || record.digest!==digest || index.size!==wanted.size)throw Error('档案校验失败或缺少数据块');
                end=true;
            }
            start=stop+1;
        }
        try{
            for(;;){
                const {value,done}=await reader.read();if(done)break;
                for(let at=value.indexOf(10);at!==-1;at=value.indexOf(10,at+1))await accept(offset+at);
                offset+=value.length;
            }
            if(start<offset)await accept(offset);
            if(!end)throw Error('档案被截断，当前进度已保留');
        }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        const available=Object.fromEntries([...index.keys()].map(id=>[id,true]));
        for(const r of header.runs)for(const state of [r.state,...r.points.map(p=>p.state)])archive.validateState(state,available);
        async function readBlock(id){
            const range=index.get(id);if(!range)throw Error('档案缺少数据块');
            return JSON.parse(await file.slice(...range).text())[1];
        }
        return {body:{version:1,active:header.active,runs:header.runs,blocks:{}},digest,readBlock};
    }
    window.RPArchiveStream={prepare,fileOf,read,isFile:async file=>(await file.slice(0,prefix.length).text())===prefix};
})();
