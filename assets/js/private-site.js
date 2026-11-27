(async () => {
    'use strict';
    const $=id=>document.getElementById(id), local=RPLocalScope.disk, transfer=RPFirstConnection;
    const mobile=location.origin==='https://rphub.local', storageKey='__rph_connection_v1';
    const saved=()=>JSON.parse(local.getItem(storageKey)||'null');
    let linked, account, action='login', pairTicket='', copyValue='', camera, timer, preview;
    const show=(id,on)=>$(id).hidden=!on, say=text=>$('status').textContent=text;
    const key=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    const journalKey=()=>[linked.origin,linked.site,account.id,RPLocalScope.id].join('/');
    let busy=false;
    const perform=fn=>async e=>{
        e?.preventDefault();
        if(busy)return;
        busy=true;
        const controls=[...document.querySelectorAll('button,select,input')].filter(n=>!n.disabled);
        controls.forEach(n=>n.disabled=true);
        try{await fn();}catch(err){say(err.message||'连接失败');}
        finally{controls.forEach(n=>n.disabled=false);busy=false;}
    };
    function endpoint(text) {
        const value=new URL(text.trim());
        const loopback=['127.0.0.1','localhost','[::1]'].includes(value.hostname);
        if(value.username||value.password||!(value.protocol==='https:'||(!mobile&&loopback&&value.protocol==='http:'))||
            value.hostname==='rphub.local'||!['/','/private.html'].includes(value.pathname)||value.search)
            throw Error('请填写私人站点的完整 HTTPS 地址');
        const ticket=new URLSearchParams(value.hash.slice(1)).get('pair')||'';
        if(ticket && !/^[A-Za-z0-9_-]{43}$/.test(ticket))throw Error('配对码格式无效');
        return {origin:value.origin,ticket};
    }
    const api=(path,options)=>RPPrivateAPI.request(linked,path,options);
    let releaseTarget,releaseTimer,releaseSession=0;
    function resetRelease(){
        releaseSession++;clearTimeout(releaseTimer);releaseTarget=null;
        show('siteRelease',false);show('releaseInstall',false);$('releaseState').textContent='';
    }
    async function releaseAction(action,remainingRetries=3){
        const session=releaseSession,apply=$('releaseInstall'),check=$('releaseCheck');
        clearTimeout(releaseTimer);check.disabled=true;apply.disabled=true;
        if(action==='install')$('releaseState').textContent='正在向本站提交更新…';
        try{
            const r=action==='install'?await api('/updates',{method:'POST',json:{revision:releaseTarget.revision}}):
                await api(action==='check'?'/updates/latest':'/updates');
            if(session!==releaseSession)return;
            $('releaseCurrent').textContent='本站当前版本 '+r.installed.version;
            if(r.latest)releaseTarget=r.available?r.latest:null;
            const pending=['queued','building','deployed'].includes(r.state);
            const available=releaseTarget && releaseTarget.version!==r.installed.version && (r.available??true);
            show('releaseInstall',!!available && r.ready && !pending);
            if(available)apply.textContent='更新本站到 '+releaseTarget.version;
            let message='';
            if(pending){
                message=(r.state==='queued'?'已提交更新，等待部署 ':'正在部署 ')+r.target.version+'。可以离开此页。';
                releaseTimer=setTimeout(()=>releaseAction('status'),5000);
            }else if(['failed','expired'].includes(r.state))message='上次更新未确认上线。请查看 Cloudflare 构建日志，再检查新版重试。';
            else if(r.state==='installed' && !available)message=r.installed.version+' 已上线。';
            else if(r.latest)message=r.available?'可用新版 '+r.latest.version+'。':'本站已是最新发行版本。';
            if(available && !r.ready)message+=' 启用按钮前，请在本站 Worker 配置 RP_UPDATE_HOOK（见部署模板说明）。';
            $('releaseState').textContent=message;
        }catch(err){
            if(session===releaseSession){
                show('releaseInstall',false);
                if(action!=='check' && remainingRetries>0 && (!err.status||err.status>=500)){
                    $('releaseState').textContent='等待重新连接原站点，正在核对更新结果…';
                    releaseTimer=setTimeout(()=>releaseAction('status',remainingRetries-1),5000);
                }else $('releaseState').textContent=err.message+'。可重新检查。';
            }
        }finally{if(session===releaseSession){check.disabled=false;apply.disabled=false;}}
    }
    $('releaseCheck').onclick=()=>releaseAction('check');
    $('releaseInstall').onclick=()=>releaseAction('install');
    function setAction(next) {
        action=next;
        const setup=action!=='login';
        $('authTitle').textContent={claim:'认领私人站点',join:'使用邀请码注册',login:'登录本站'}[action];
        $('authSubmit').textContent={claim:'认领并登录',join:'创建账号并登录',login:'登录'}[action];
        $('proofLabel').textContent=action==='claim'?'部署时保存的站主认领口令':'站主提供的邀请码';
        $('authMode').textContent=action==='join'?'返回登录':'使用邀请码注册';
        $('proof').required=setup;$('savedKey').required=setup;
        show('newKey',setup);show('proofRow',setup);show('savedRow',setup);show('authMode',linked.claimed);
    }
    async function sessionReady() {
        account=await api('/me');
        RPPrivateSync.reset();$('jobList').replaceChildren();$('jobOutput').textContent='';
        RPPrivateAPI.save({...saved(),account:account.id,syncVersion:linked.syncVersion,gameVersion:linked.gameVersion,imageVersion:linked.imageVersion,recoveryVersion:linked.recoveryVersion});
        if(linked.syncVersion===1)RPPrivateSync.restoreMode(local.getItem('__rph_mode_'+journalKey()));
        show('jobs',linked.syncVersion===1);show('sync',linked.syncVersion===1);$('syncMode').value=RPPrivateSync.mode();renderSync();
        RPPrivateSync.schedule(1000);
        $('identity').textContent=account.name+(account.role==='owner'?' · 站主':'');
        show('auth',false);show('account',true);show('migration',true);show('health',account.role==='owner');show('invite',account.role==='owner');
        resetRelease();
        if(account.role==='owner' && linked.release){
            show('siteRelease',true);$('releaseCheck').disabled=false;
            $('releaseCurrent').textContent='本站当前版本 '+linked.release.version;
            void releaseAction('status');
        }
        show('resume',!!await transfer.pending(journalKey()));
        $('mode').value=local.getItem('__rph_mode_'+journalKey())||'manual';
        say(linked.syncVersion===1?'已登录。可先比较两边的存档。':'已登录旧版站点，可使用首次迁入。升级私人站点后即可使用日常同步。');
    }
    async function connect(text) {
        const {origin,ticket}=endpoint(text);
        if(!mobile && origin!==location.origin){location.assign(origin+'/private.html'+(ticket?'#pair='+ticket:''));return;}
        const res=await fetch(origin+'/api/private/v1/site',{cache:'no-store',credentials:'omit',redirect:'error'});
        if(!res.ok)throw Error('无法连接私人站点。可返回本地游玩，稍后重试。');
        const info=await res.json();
        if(info.service!=='rp-hub-private'||info.version!==1||!/^[a-f0-9]{32}$/.test(info.site))throw Error('该地址未部署兼容的 RP-Hub 私人站点');
        linked={site:info.site,origin,release:info.release,claimed:info.claimed,syncVersion:info.syncVersion||0,gameVersion:info.gameVersion||0,imageVersion:info.imageVersion||0,recoveryVersion:info.recoveryVersion||0};pairTicket=ticket;
        resetRelease();account=null;preview=null;
        $('address').value=origin;$('where').textContent=origin;$('result').replaceChildren();
        for(const id of ['account','migration','health','comparison','ticketBox','jobs','sync'])show(id,false);
        show('auth',true);show('redeemRow',!!ticket);show('authForm',!ticket);
        setAction(info.claimed?'login':'claim');
        const previous=saved();
        if(!ticket && previous?.origin===origin && previous.site===info.site && !previous.detached) {
            try{await sessionReady();return;}catch{}
        }
        say(ticket?'请核对站点后确认配对':info.claimed?'可使用本站账号登录':'部署已就绪，请认领站点');
    }
    async function login(path,body) {
        const reply=await api(path,{method:'POST',json:body});
        local.setItem(storageKey,JSON.stringify({origin:linked.origin,site:linked.site,token:mobile?reply.token:undefined}));
        $('loginKey').value='';$('proof').value='';$('savedKey').checked=false;pairTicket='';
        history.replaceState(null,'',location.pathname);await sessionReady();
    }
    $('addressForm').onsubmit=perform(()=>connect($('address').value));
    $('authForm').onsubmit=perform(()=>login('/'+action,{name:$('name').value,key:$('loginKey').value,proof:$('proof').value}));
    $('authMode').onclick=()=>setAction(action==='join'?'login':'join');
    $('newKey').onclick=perform(async()=>{
        const input=$('loginKey');if(!input.value)input.value=key();
        try{await navigator.clipboard.writeText(input.value);say('已复制登录密钥，请保存');}
        catch{input.type='text';say('请复制并保存显示的登录密钥');}
    });
    $('redeem').onclick=perform(()=>login('/redeem',{ticket:pairTicket}));
    $('logout').onclick=perform(async()=>{
        let revoked=false;
        try{await api('/logout',{method:'POST'});revoked=true;}catch{}
        local.setItem(storageKey,JSON.stringify({origin:linked.origin,site:linked.site,detached:true}));
        resetRelease();account=null;preview=null;pairTicket='';copyValue='';RPPrivateSync.reset();$('jobList').replaceChildren();$('jobOutput').textContent='';
        for(const id of ['migration','health','ticketBox','account','comparison','redeemRow','jobs','sync'])show(id,false);
        $('qr').removeAttribute('src');$('ticketInfo').textContent='';show('authForm',true);show('auth',true);setAction('login');
        say(revoked?'此设备已解绑，本机进度仍可游玩':'本机已解绑。远端暂未确认撤销，会话到期失效。');
    });
    async function issue(purpose) {
        const r=await api('/tickets',{method:'POST',json:{purpose}});
        show('ticketBox',true);show('qr',purpose==='pair');
        if(purpose==='pair'){
            copyValue=linked.origin+'/private.html#pair='+r.ticket;
            const qr=qrcode(0,'M');qr.addData(copyValue);qr.make();$('qr').src=qr.createDataURL(6,24);
            $('ticketInfo').textContent='用自己的手机扫码。二维码一次有效，3 分钟后到期。';
        }else{
            copyValue=r.ticket;$('ticketInfo').textContent='邀请码（24 小时内一次有效）\n'+copyValue;
        }
    }
    $('pair').onclick=perform(()=>issue('pair'));$('invite').onclick=perform(()=>issue('invite'));
    $('hideTicket').onclick=()=>{copyValue='';$('qr').removeAttribute('src');$('ticketInfo').textContent='';show('ticketBox',false);};
    $('copyTicket').onclick=perform(async()=>{await navigator.clipboard.writeText(copyValue);say('已复制');});
    function stopCamera(){clearTimeout(timer);camera?.getTracks().forEach(t=>t.stop());camera=null;$('camera').querySelector('video').srcObject=null;show('camera',false);}
    function decodeImage(image,w,h) {
        const scale=Math.min(1,1100/Math.max(w,h)),c=document.createElement('canvas');
        c.width=Math.max(1,Math.round(w*scale));c.height=Math.max(1,Math.round(h*scale));
        const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,c.width,c.height);
        const pixels=ctx.getImageData(0,0,c.width,c.height);
        return jsQR(pixels.data,c.width,c.height,{inversionAttempts:'dontInvert'})?.data;
    }
    $('scan').onclick=perform(async()=>{
        stopCamera();
        camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
        show('camera',true);const v=$('camera').querySelector('video');v.srcObject=camera;
        try{await v.play();}catch(e){stopCamera();throw e;}
        const frame=async()=>{
            if(!camera)return;
            try{
                const code=v.videoWidth && decodeImage(v,v.videoWidth,v.videoHeight);
                if(code){stopCamera();await connect(code);return;}
                timer=setTimeout(frame,180);
            }catch(e){stopCamera();say(e.message);}
        };
        frame();
    });
    $('stopCamera').onclick=stopCamera;window.addEventListener('pagehide',stopCamera);
    $('qrFile').onchange=perform(async()=>{
        const f=$('qrFile').files[0];$('qrFile').value='';if(!f)return;
        const bitmap=await createImageBitmap(f);let code;
        try{code=decodeImage(bitmap,bitmap.width,bitmap.height);}finally{bitmap.close();}
        if(!code)throw Error('图片中未识别到配对二维码');await connect(code);
    });
    function describe(s) {
        return s.name+' · '+s.cards+' 张卡，'+s.messages+' 条消息，'+s.points+' 个命名点，'+s.game+' 个游戏回合，'+s.novels+' 部小说'+
            (s.names?.length?'\n角色：'+s.names.join('、'):'')+(s.pointNames?.length?'\n存档点：'+s.pointNames.join('、'):'');
    }
    $('preview').onclick=perform(async()=>{
        preview=null;show('comparison',false);
        const [here,cloud]=await Promise.all([transfer.preview(),api('/archives')]);
        $('localSummary').textContent=describe(here.summary);
        const list=$('cloudList');list.replaceChildren();if(!cloud.length)list.textContent='此账号尚无云档';
        for(const r of cloud){
            const label=document.createElement('label'),check=document.createElement('input');
            check.type='checkbox';check.value=r.digest;check.checked=r.digest!==here.pkg.digest;check.disabled=!check.checked;
            label.className='cloud-copy';label.append(check,document.createTextNode(' '+describe(r.summary)+'\n'+
                new Date(r.created*1000).toLocaleString()+' · '+(r.digest===here.pkg.digest?'与本机完全相同':'独立版本 '+r.digest.slice(0,10))));
            list.append(label);
        }
        preview={local:transfer.meaningful(here.summary)?here:null};show('comparison',true);say('比较完成，尚未传输存档');
    });
    $('cancel').onclick=()=>{preview=null;show('comparison',false);say('已取消，两边的进度均保留');};
    async function apply(plan) {
        const k=journalKey();
        try{
            const {imported,mode}=await transfer.migrate(api,k,plan);local.setItem('__rph_mode_'+k,mode);
            if(linked.syncVersion===1){RPPrivateSync.allowFirst();RPPrivateSync.changeMode(mode);$('syncMode').value=mode;}
            preview=null;show('comparison',false);const box=$('result');box.replaceChildren();
            const runs=await RPLocalArchive.runs();
            for(const id of imported){
                const b=document.createElement('button');b.textContent='打开 '+(runs.find(r=>r.id===id)?.name||'迁入进度');
                b.onclick=perform(async()=>{await RPLocalArchive.activate(id);location.assign('index.html');});box.append(b);
            }
            say('迁入已完成。本机原进度和本站原云档都已保留。');
        }finally{show('resume',!!await transfer.pending(k));}
    }
    $('confirm').onclick=perform(async()=>{
        if(!preview)return;
        const remote=[...$('cloudList').querySelectorAll('input:checked')].map(c=>c.value);
        if(!preview.local && !remote.length)throw Error('两边均无需要迁入的进度');
        await apply({...preview,remote,mode:$('mode').value});
    });
    $('resume').onclick=perform(()=>apply(null));
    $('probe').onclick=perform(async()=>{
        const {id}=await api('/probe',{method:'POST'});
        for(let i=0;i<20;i++){
            const r=await api('/probe?id='+id);if(r?.consumed){say('D1 写入、私有 R2 读写、队列投递与消费已验证');return;}
            await new Promise(ok=>setTimeout(ok,1000));
        }
        say('D1、R2 写入已验证，队列尚未确认消费');
    });
    function renderSync(){
        $('syncState').textContent=RPPrivateSync.status;
        const select=$('branches'),value=select.value;
        select.replaceChildren(...RPPrivateSync.heads.map(h=>new Option(h.label+' · '+(h.branch==='main'?'主进度':h.branch.slice(0,8))+' · '+new Date(h.created*1000).toLocaleString(),h.branch)));
        if([...select.options].some(o=>o.value===value))select.value=value;
        show('branchRow',select.length>1);
    }
    window.addEventListener('rph-sync-status',renderSync);
    $('syncMode').onchange=()=>RPPrivateSync.changeMode($('syncMode').value);
    $('push').onclick=perform(()=>RPPrivateSync.run('push'));
    $('pull').onclick=perform(()=>RPPrivateSync.run('pull',$('branches').value));
    $('listBranches').onclick=perform(()=>RPPrivateSync.run('list'));
    $('loadJobs').onclick=perform(async()=>{
        const list=await RPPrivateJobs.list();$('jobList').replaceChildren();$('jobOutput').textContent='';
        if(!list.length)$('jobList').textContent='本站暂无生成任务';
        for(const job of list){
            const button=document.createElement('button');button.type='button';
            button.textContent=new Date(job.updated*1000).toLocaleString()+' · '+({queued:'等待生成',running:'生成中',done:'已完成',interrupted:'已中断'}[job.status]);
            button.onclick=perform(async()=>{
                const out=$('jobOutput');out.textContent='';
                const result=await RPPrivateJobs.replay(job,undefined,delta=>{out.textContent+=delta.content||delta.reasoning||'';});
                out.textContent=result.content||result.reasoning||'生成结束';
            });$('jobList').append(button);
        }
    });
    const prev=saved();
    const initial=mobile?prev?.origin:location.origin+'/private.html'+location.hash;
    if(initial){$('address').value=initial;try{await connect(initial);}catch(e){say(e.message);}}
})().catch(e=>document.getElementById('status').textContent=e.message);
