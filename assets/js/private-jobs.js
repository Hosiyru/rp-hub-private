(() => {
    'use strict';
    const api=RPPrivateAPI;
    const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
    function client(){
        const site=api.session();
        if(!site?.account||site.detached)throw Error('私人站点已解绑');
        return (path,options)=>{
            const active=api.session();
            if(active?.site!==site.site||active?.account!==site.account||active?.origin!==site.origin||active?.detached)throw Error('私人账号已切换');
            return api.request(site,path,options);
        };
    }
    async function response(id,signal,ready) {
        const call=client(), encoder=new TextEncoder();
        let cursor=0,job,stopped=false;
        async function next(){
            signal?.throwIfAborted();
            job=await call('/jobs/'+id+'?after='+cursor,{signal});
            ready?.(job);
        }
        await next();
        while(!job.mime && !['done','interrupted'].includes(job.status)){await pause(650);await next();}
        const stream=new ReadableStream({
            async pull(controller){
                try{
                    while(!stopped){
                        if(job.parts.length){
                            for(const part of job.parts){
                                if(part.seq!==cursor+1)throw Error('后台生成缺少分段，请重新打开任务');
                                controller.enqueue(encoder.encode(part.text));cursor=part.seq;
                            }
                            const full=job.parts.length===8;job.parts=[];
                            if(full)await next();
                            return;
                        }
                        if(job.status==='interrupted')throw Error('上游生成已中断，已收到的内容仍在任务中');
                        if(job.status==='done'){controller.close();return;}
                        await pause(650);if(!stopped)await next();
                    }
                }catch(e){if(!stopped)controller.error(e);}
            },
            cancel(){stopped=true;}
        });
        return new Response(stream,{headers:{'Content-Type':job.mime||'text/event-stream'}});
    }
    // Installed before card scripts. The card's normal fetch hook can enrich a background request too.
    const background=new Map(), direct=window.fetch.bind(window);
    window.fetch=(input,init)=>background.has(input)?background.get(input)(init):direct(input,init);
    let activeJob;
    function transport(meta){
        return async (options,signal)=>{
            activeJob={id:meta.id,call:client()};
            const route='/__rph_background/'+meta.id+'/chat/completions';
            background.set(route,async init=>{
                const body=JSON.parse(init.body);
                const id=await RPPrivateSync.submitJob({...meta,url:options.url,apiKey:options.apiKey||'',body},signal);
                return response(id,signal);
            });
            try{return await window.fetch(route,{method:'POST',body:JSON.stringify(options.body),signal});}
            finally{background.delete(route);}
        };
    }
    async function replay(job,signal,onDelta){
        return RPHubApiClient.requestChatCompletion({model:'replay',messages:[],stream:true,replyInTool:!!job.reply_tool,
            transport:(_options,s)=>response(job.id,s),signal,onDelta});
    }
    window.RPPrivateJobs={transport,replay,list:()=>client()('/jobs'),stop(){
        const job=activeJob;activeJob=null;
        if(job)return job.call('/jobs/'+job.id+'/stop',{method:'POST'});
    }};
})();
