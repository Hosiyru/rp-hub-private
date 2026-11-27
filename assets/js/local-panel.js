(async () => {
    const $=id=>document.getElementById(id), demo=location.protocol==='file:' || new URLSearchParams(location.search).has('preview');
    let selected, api, active, returnFocus, busy=false;
    function message(text) { $('status').textContent=text; }
    async function perform(task) {
        if(busy) return;
        busy=true; document.querySelectorAll('button').forEach(b=>b.disabled=true);
        try { await task(); } catch(e) {message(e.message);}
        finally {busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
    }
    function item(label,detail,action,onClick) {
        const li=document.createElement('li'),span=document.createElement('span'),small=document.createElement('small');
        span.textContent=label;small.textContent=detail;span.append(small);li.append(span);
        if(action){const b=document.createElement('button');b.textContent=action;b.onclick=()=>perform(onClick);li.append(b);}
        return li;
    }
    async function refresh() {
        const runs=await api.runs(),cur=runs.find(r=>r.id===active);
        $('context').textContent=(demo?'交互预览 · ':'当前进度 · ')+(cur?.name||'原始进度');
        $('points').replaceChildren(...(await api.points()).filter(p=>p.run===active).sort((a,b)=>b.time-a.time).map(p=>
            item(p.name,new Date(p.time).toLocaleString(),'另开分支',async()=>switchTo(await api.fork(p.id)))));
        $('runs').replaceChildren(...runs.map(r=>item(r.name,r.id===active?'正在使用':'',r.id===active?'':'切换',()=>switchTo(r.id))));
    }
    async function switchTo(id) {await api.activate(id); if(demo){active=id;await refresh();}else location.replace('index.html');}
    if(demo) {
        active='main';const runs=[{id:active,name:'原始进度'}],points=[{id:'example',run:active,name:'进入矿坑前',time:Date.now()}];
        api={runs:async()=>runs,points:async()=>points,activate:async()=>{},checkpoint:async name=>points.push({id:String(points.length),name,run:active,time:Date.now()}),
            fork:async id=>{const run={id:String(runs.length),name:points.find(p=>p.id===id).name+' · 分支'};runs.push(run);return run.id;}};
        $('back').hidden=true;
    } else {
        api=RPLocalArchive;active=RPLocalScope.id;
    }
    $('pointForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const name=$('name').value.trim();if(!name)throw Error('请输入存档名称');await api.checkpoint(name);$('name').value='';await refresh();message('已创建存档点');window.RPLocalNative?.dirty();});};
    $('export').onclick=()=>perform(async()=>{
        if(demo)return message('预览模式。实际游玩时，此处导出本机完整档案。');
        const str=JSON.stringify(await RPFirstConnection.forTransfer(await api.portable())),name='RP-Hub-'+new Date().toISOString().slice(0,10)+'.json';
        if(window.RPLocalNative?.available()) {await RPLocalNative.exportFile(str,name);message('已写入所选文件');}
        else {const url=URL.createObjectURL(new Blob([str],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);message('已交给浏览器下载');}
    });
    $('choose').onclick=()=>{if(demo)return message('预览模式。实际游玩时，可预览档案后再确认导入。');$('file').click();};
    async function review(file,legacy=false) {
        selected=null;$('review').hidden=true;message('正在读取档案…');
        const pkg=legacy?await RPLegacyShards.read(file,(i,total)=>message('正在校验旧分片 '+i+'/'+total)):await api.readPackage(file);
        selected=pkg;
        $('summary').textContent=pkg.body.runs.length+' 份进度，'+pkg.body.runs.reduce((n,r)=>n+r.points.length,0)+' 个命名点。确认后可单独打开，现有进度保留。';
        if(pkg.legacy){
            const s=pkg.legacy;
            $('summary').textContent='旧魔改进度 · '+s.cards+' 张卡，'+s.messages+' 条消息，'+s.pluginData+' 条插件数据，'+s.scripts+' 份插件脚本，'+s.pluginSettings+' 项插件设置。'+(s.recovered?'从角色正文补回 '+s.recovered+' 张索引遗漏的卡。':'')+'确认后另开进度。';
        }
        $('review').hidden=false;message('完整性校验通过');
    }
    $('chooseLegacy').onclick=()=>{if(demo)return message('预览模式。实际游玩时可选择旧分片目录。');$('legacyDir').click();};
    for(const [input,button] of [['file','choose'],['legacyDir','chooseLegacy']]){
        $(input).onchange=async e=>{
            const files=Array.from(e.target.files);e.target.value='';if(!files.length)return;
            returnFocus=$(button);
            const legacy=input==='legacyDir'||files[0].name.toLowerCase().endsWith('.rphsave');
            await perform(()=>review(legacy?files:files[0],legacy));
            if(selected)$('apply').focus();else returnFocus.focus();
        };
    }
    $('cancel').onclick=()=>{selected=null;$('review').hidden=true;(returnFocus||$('choose')).focus();message('已取消导入');};
    $('apply').onclick=()=>perform(async()=>{if(selected)await switchTo(await api.importPackage(selected));});
    if(location.hostname==='rphub.local'){
        $('native').hidden=false;
        $('recover').onclick=()=>perform(async()=>review(await RPLocalNative.read('current')));
        $('older').onclick=()=>perform(async()=>review(await RPLocalNative.read('previous')));
        window.addEventListener('rph-mirror-status',e=>$('mirrorStatus').textContent=e.detail);
    }
    await refresh();
    if(new URLSearchParams(location.search).has('recover')) message('本机索引缺失，文件镜像已保留。请检查最近副本后再恢复。');
})().catch(e=>document.getElementById('status').textContent='读取失败：'+e.message);
