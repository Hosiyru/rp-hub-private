(() => {
    'use strict';
    const storage=RPLocalScope.disk, key='__rph_connection_v1';
    const session=()=>JSON.parse(storage.getItem(key)||'null');
    async function request(site,path,{method='GET',json,body,raw,signal}={}) {
        const mobile=location.origin==='https://rphub.local';
        if(!mobile && site.origin!==location.origin)throw Error('请打开所属私人站点');
        const headers={'X-RP-Site':site.site};
        if(/^\/sync\/[a-f0-9]{64}$/.test(path))path+='?gallery=1';
        const saved=session();
        if(saved?.site===site.site && saved.origin===site.origin && saved.account && /^\/(sync|jobs|chunks|archives|missing|storage)(\/|$)/.test(path))headers['X-RP-Account']=site.account||saved.account;
        if(mobile && saved?.origin===site.origin && saved.site===site.site && saved.token)headers.Authorization='Bearer '+saved.token;
        if(json!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(json);}
        const res=await fetch(site.origin+'/api/private/v1'+path,{method,headers,body,signal,credentials:mobile?'omit':'same-origin',redirect:'error',cache:'no-store'});
        if(!res.ok){
            let detail;try{detail=await res.json();}catch{}
            throw Object.assign(Error(detail?.error||'站点请求失败（'+res.status+'）'),{status:res.status,code:detail?.code,official:detail?.official});
        }
        return raw?res:res.json();
    }
    window.RPPrivateAPI={session,request,save:value=>storage.setItem(key,JSON.stringify(value))};
})();
