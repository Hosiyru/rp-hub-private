(() => {
    'use strict';
    const providers=new Map();
    const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
    async function json(url,options){
        const res=await fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'});
        if(!res.ok)throw Error('生图服务返回 HTTP '+res.status);
        return res.json();
    }
    async function download(url){
        const u=new URL(url);
        if(u.protocol!=='https:'||u.username||u.password)throw Error('原图地址无效');
        const res=await fetch(u,{credentials:'omit',referrerPolicy:'no-referrer'});
        if(!res.ok)throw Error('原图暂不可用');
        return res.blob();
    }
    function endpoint(value){
        try{const u=new URL(value);if(u.protocol==='https:' && !u.username && !u.password && !u.search && !u.hash)return u.href.replace(/\/+$/,'');}catch{}
        return '';
    }
    const keySlot=url=>'__rph_image_service_key/'+endpoint(url);
    function registerProvider(provider){
        if(!/^[a-z0-9-]{3,32}$/.test(provider?.id)||typeof provider.generate!=='function'||providers.has(provider.id))throw Error('无效或重复的生图服务');
        providers.set(provider.id,provider);
        window.dispatchEvent(new Event('rph-image-providers-change'));
    }
    registerProvider({id:'jobs',label:'原版生图',async generate({params,token,progress}){
        const origin=window.RPHubCardUtils?.imageGenBaseUrl||'https://nai.sta1n.cn';
        let job=await json(origin+'/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...params,token})});
        for(let attempt=0;job.status!=='done';attempt++){
            if(job.status==='failed'||!job.id||attempt>=1200)throw Error('生图任务未完成');
            progress(job.status==='queued'?'排队中':'生成中 '+Math.round(job.generationProgress?.percent||0)+'%');
            await wait(700);
            job=await json(origin+'/api/jobs/'+encodeURIComponent(job.id)+'?token='+encodeURIComponent(token));
        }
        return download(job.imageUrl?new URL(job.imageUrl,origin).href:origin+'/api/jobs/'+encodeURIComponent(job.id)+'/content?token='+encodeURIComponent(token));
    }});
    registerProvider({id:'compatible',label:'兼容图片生成接口',async generate({params,plan}){
        const url=endpoint(plan.endpoint);if(!url)throw Error('请填写生图服务的 HTTPS 接口地址');
        const token=RPLocalScope.disk.getItem(keySlot(url));
        const headers={'content-type':'application/json'};if(token)headers.Authorization='Bearer '+token;
        const prompt=[params.tag,params.artist].filter(Boolean).join(', ');
        const sizes={'横图':'1536x1024','方图':'1024x1024','竖图':'1024x1536'};
        const result=await json(url+'/images/generations',{method:'POST',headers,redirect:'error',body:JSON.stringify({model:plan.model,prompt,size:sizes[params.size]||'1024x1536',n:1})});
        const image=result.data?.[0];
        if(image?.b64_json){
            const bytes=Uint8Array.from(atob(image.b64_json),c=>c.charCodeAt(0));
            const type=bytes[0]===0xff?'image/jpeg':bytes[0]===0x52?'image/webp':'image/png';
            return new Blob([bytes],{type});
        }
        if(image?.url)return download(image.url);
        throw Error('生图服务未返回原图');
    }});
    window.RPImageProviders={registerProvider,list:()=>[...providers.values()].map(({id,label})=>({id,label})),endpoint,
        readKey:url=>endpoint(url)?RPLocalScope.disk.getItem(keySlot(url))||'':'',
        saveKey(url,key){if(endpoint(url))key?RPLocalScope.disk.setItem(keySlot(url),key):RPLocalScope.disk.removeItem(keySlot(url));},
        generate(plan,prompt,fresh,token,progress){
            const p=providers.get(plan.provider);if(!p)throw Error('此生图服务尚未加载');
            const params={...plan.params,tag:prompt};
            return p.generate({params,plan,token:p.id==='jobs'?token:'',progress});
        }};
})();
