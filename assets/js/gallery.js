(() => {
    'use strict';
    const host=window.parent, api=host.RPImages, disk=host.RPLocalScope?.disk;
    const el=id=>document.getElementById(id);
    const icons={image:'M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2z M3 17l6-6 4 4 3-3 5 5 M8 7h.01',
        menu:'M3 6h18M3 12h18M3 18h18',back:'M15 5l-7 7 7 7',next:'M9 5l7 7-7 7',close:'M5 5l14 14M19 5L5 19',
        search:'M16 16l5 5M18 10a8 8 0 11-16 0 8 8 0 0116 0',refresh:'M4 4v6h6M20 20v-6h-6M20 10a8 8 0 00-14.9-3M4 14a8 8 0 0014.9 3',
        eye:'M3 3l18 18M10 5c6-1 11 7 11 7l-2 3M6 7l-3 5s5 8 13 6',missing:'M3 3l18 18M21 15V5a2 2 0 00-2-2H9M3 7v12a2 2 0 002 2h12',
        star:'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',check:'M5 12l4 4L20 5'};
    function icon(name){
        const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
        svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',icons[name]);svg.append(path);return svg;
    }
    for(const node of document.querySelectorAll('[data-icon]'))node.append(icon(node.dataset.icon));
    const node=(tag,cls,label)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(label)n.textContent=label;return n;};
    const format=bytes=>{
        const [scale,unit]=[[1e9,'GB'],[1e6,'MB'],[1e3,'KB']].find(([size])=>bytes>=size)||[1,'B'];
        return (bytes/scale).toLocaleString('zh-CN',{maximumFractionDigits:2})+' '+unit;
    };
    const measure=list=>list.length+' 张 · '+format(list.reduce((total,item)=>total+item.bytes,0));
    const viewer=el('imageView'),grid=el('imageList'),picked=new Set();
    let entries=[],byOwner=new Map(),group='all',query='',visible=[],offset=0,selecting=false,saving=false;
    let opened=null,originalUrl,viewVersion=0,listVersion=0;
    const originalItems=()=>entries.filter(i=>i.digest);
    const labelOf=item=>item.owners.get(group)||[...new Set(item.owners.values())].join('、');
    const matches=(item,text)=>item.uses.some(s=>[s.name,s.prompt].some(t=>t?.toLocaleLowerCase().includes(text)));
    const message=e=>{(viewer.open?el('viewerStatus'):el('status')).textContent=e.message||String(e);};
    const changeParent=slot=>window.frameElement?.dispatchEvent(new CustomEvent('gallery-image-change',{detail:slot}));
    el('menu').onclick=()=>window.frameElement?window.frameElement.dispatchEvent(new Event('gallery-menu')):location.assign('index.html');
    if(!api){message('请从 RP-Hub 侧边栏打开图库。');return;}
    const activeThumbs=new Map(),tickets=new WeakMap();
    const thumbs=new IntersectionObserver(events=>{
        for(const e of events){
            const img=e.target,token={};tickets.set(img,token);
            if(!e.isIntersecting){freeThumb(img);continue;}
            if(activeThumbs.has(img))continue;
            host.RPImageThumbs.get(img.dataset.digest).catch(()=>api.getOriginal(img.dataset.digest)).then(blob=>{
                if(!blob||!img.isConnected||tickets.get(img)!==token)return;
                const url=URL.createObjectURL(blob);activeThumbs.set(img,url);img.src=url;
            }).catch(()=>{});
        }
    },{rootMargin:'160px'});
    function freeThumb(img){
        if(activeThumbs.has(img)){URL.revokeObjectURL(activeThumbs.get(img));activeThumbs.delete(img);img.removeAttribute('src');}
    }
    function clear(container){
        for(const img of container.querySelectorAll('img')){thumbs.unobserve(img);tickets.delete(img);freeThumb(img);}
        container.replaceChildren();
    }
    function thumbnail(id){
        const img=node('img');img.alt='';img.dataset.digest=id;thumbs.observe(img);return img;
    }
    function releaseOriginal(){if(originalUrl)URL.revokeObjectURL(originalUrl);originalUrl=null;el('originalImage').removeAttribute('src');}
    window.addEventListener('pagehide',()=>{thumbs.disconnect();for(const img of activeThumbs.keys())freeThumb(img);releaseOriginal();});
    function navigate(id){
        group=id;document.body.classList.add('inside');el('status').textContent='';
        renderRail();renderGrid();
        if(matchMedia('(max-width:767px)').matches){el('back').focus();el('back').scrollIntoView({block:'nearest'});}
    }
    function row(id,name,count,art,kind){
        const b=node('button','item');b.dataset.group=id;
        if(id===group)b.setAttribute('aria-current','page');
        const face=node('span',art?'avatar':'icon');face.append(art?thumbnail(art):icon(kind||'image'));
        b.append(face,node('span','name',name),node('span','count',String(count)));b.onclick=()=>navigate(id);return b;
    }
    function renderRail(){
        const originals=originalItems();el('summary').textContent=measure(originals);
        clear(el('groups'));clear(el('owners'));
        el('groups').append(row('all','全部图片',originals.length),row('missing','缺图',entries.length-originals.length,null,'missing'));
        const term=el('search').value.trim().toLocaleLowerCase();
        for(const [id,g] of byOwner){
            if(term&&!g.name.toLocaleLowerCase().includes(term)&&!g.items.some(i=>matches(i,term)))continue;
            el('owners').append(row(id,g.name,g.items.length,g.items[0]?.digest));
        }
    }
    el('search').oninput=renderRail;
    el('searchForm').onsubmit=e=>{e.preventDefault();query=el('search').value.trim().toLocaleLowerCase();navigate(query?'search':'all');};
    el('back').onclick=()=>{document.body.classList.remove('inside');(el('owners').querySelector('[aria-current]')||el('groups').querySelector('[aria-current]')||el('search')).focus();};
    function renderGrid(){
        visible=group==='all'?originalItems():group==='missing'?entries.filter(i=>!i.digest):
            group==='search'?entries.filter(i=>matches(i,query)):byOwner.get(group)?.items||[];
        const title=({all:'全部图片',missing:'缺图',search:'搜索结果'})[group]||byOwner.get(group)?.name||'角色';
        el('title').textContent=title+(selecting?' · 保留图片':'');el('galleryCount').textContent=group==='missing'?visible.length+' 个图位':measure(visible);
        clear(grid);offset=0;el('empty').hidden=!!visible.length;
        el('empty').textContent=group==='missing'?'没有缺图':group==='search'?'没有匹配的图片':'当前进度还没有图片';
        document.querySelector('.gallery-scroll').scrollTop=0;appendPage();updateSelection();
    }
    function syncCard(b,i){
        const item=visible[i],checked=picked.has(item.digest);
        if(selecting){b.setAttribute('aria-pressed',String(checked));const check=b.querySelector('.check');if(check)check.replaceChildren(...(checked?[icon('check')]:[]));}
        b.setAttribute('aria-label',[labelOf(item),item.uses.find(s=>s.owner===group)?.prompt||item.uses[0].prompt,
            !item.digest?'缺图':item.keep?'已保留':''].filter(Boolean).join(' · '));
    }
    function appendPage(){
        const limit=Math.min(offset+60,visible.length),fragment=document.createDocumentFragment();
        for(;offset<limit;offset++){
            const i=offset,item=visible[i],b=node('button','card');b.dataset.index=String(i);
            if(item.digest){
                b.append(thumbnail(item.digest));
                const meta=node('span','meta');meta.append(node('b','',labelOf(item)),node('small','',format(item.bytes)));b.append(meta);
                if(item.keep){const mark=node('span','mark');mark.title='已保留，快捷清理会跳过';mark.append(icon('star'));b.append(mark);}
                if(selecting)b.append(node('span','check'));
            }else{b.classList.add('missing');b.textContent=item.uses[0].status==='removed'?'原图已删除':'原图未保存';b.disabled=selecting;}
            syncCard(b,i);fragment.append(b);
        }
        grid.append(fragment);el('moreImages').hidden=offset>=visible.length;
    }
    grid.onclick=e=>{
        const b=e.target.closest('.card');if(!b||saving)return;
        const i=Number(b.dataset.index),item=visible[i];
        if(!selecting){openImage(i).catch(message);return;}
        if(!item.digest)return;
        if(picked.has(item.digest))picked.delete(item.digest);else picked.add(item.digest);
        syncCard(b,i);updateSelection();
    };
    el('moreImages').onclick=appendPage;
    new IntersectionObserver(([e])=>{if(e.isIntersecting&&!el('moreImages').hidden)appendPage();},{root:document.querySelector('.gallery-scroll')}).observe(el('moreImages'));
    function setBlur(value){document.body.classList.toggle('blur',value);el('blur').setAttribute('aria-pressed',String(value));}
    setBlur(disk.getItem('__rph_gallery_blur_default')!=='off'||disk.getItem('__rph_gallery_blur_last')!=='off');
    el('blur').onclick=()=>{const value=!document.body.classList.contains('blur');setBlur(value);disk.setItem('__rph_gallery_blur_last',value?'on':'off');};
    function updateSelection(){
        for(const key of ['stars','refresh','blur'])el(key).hidden=selecting;
        for(const key of ['all','cancel','dock'])el(key).hidden=!selecting;
        if(!selecting)return;
        const selectable=visible.filter(i=>i.digest);
        el('all').textContent=selectable.length&&selectable.every(i=>picked.has(i.digest))?'取消全选':'全选';
        el('all').disabled=!selectable.length||saving;
        el('picked').textContent='已选 '+measure(entries.filter(i=>picked.has(i.digest)));
        el('set').disabled=el('unset').disabled=!picked.size||saving;
    }
    function selection(on){selecting=on;picked.clear();el('status').textContent='';renderGrid();(on?el('cancel'):el('stars')).focus();}
    el('stars').onclick=()=>selection(true);el('cancel').onclick=()=>{if(!saving)selection(false);};
    el('all').onclick=()=>{
        const ids=visible.filter(i=>i.digest).map(i=>i.digest),remove=ids.every(id=>picked.has(id));
        for(const id of ids){if(remove)picked.delete(id);else picked.add(id);}
        for(const b of grid.children)syncCard(b,Number(b.dataset.index));updateSelection();
    };
    async function saveMarks(value){
        if(saving||!picked.size)return;saving=true;updateSelection();
        try{
            const count=picked.size,marks=await api.setKept([...picked],value);
            for(const item of entries)item.keep=!!marks[item.digest];
            selection(false);el('status').textContent=(value?'已设为保留 ':'已取消保留 ')+count+' 张';
        }catch(e){message(e);}finally{saving=false;updateSelection();}
    }
    el('set').onclick=()=>saveMarks(true);el('unset').onclick=()=>saveMarks(false);
    async function refresh(){
        const version=++listVersion,list=await api.gallery();if(version!==listVersion)return;
        entries=list;byOwner=new Map();
        for(const item of entries)for(const [id,name] of item.owners){
            if(!byOwner.has(id))byOwner.set(id,{name,items:[]});
            if(item.digest)byOwner.get(id).items.push(item);
        }
        if(!['all','missing','search'].includes(group)&&!byOwner.has(group))group='all';
        const available=new Set(originalItems().map(i=>i.digest));for(const id of picked)if(!available.has(id))picked.delete(id);
        renderRail();renderGrid();
    }
    async function usage(){
        const session=host.RPPrivateAPI.session(),panel=el('cloudCapacity'),button=el('refreshUsage');
        panel.hidden=!session?.account||!!session.detached;if(panel.hidden||button.disabled)return;
        button.disabled=true;
        try{const {bytes}=await host.RPPrivateAPI.request(session,'/storage/usage');el('cloudUsage').textContent=format(bytes)+' / 10 GB';panel.style.setProperty('--used',Math.min(100,bytes/1e8)+'%');}
        catch{el('cloudUsage').textContent='暂时无法读取';}finally{button.disabled=false;}
    }
    el('refreshUsage').onclick=usage;
    el('refresh').onclick=()=>{refresh().catch(message);void usage();};
    async function showPlaces(item,ticket){
        const uses=item.uses.slice(0,3),histories=new Map();
        for(const s of uses)if(!histories.has(s.story))histories.set(s.story,host.RPHubStorage?.getScopedStoredValue('chat',s.story));
        const places=await Promise.all(uses.map(async s=>{
            const chat=await histories.get(s.story),pos=Array.isArray(chat)?chat.findIndex(m=>String(m.id)===String(s.message)):-1;
            const branch=s.story===s.owner?'主线':'分支';
            return (s.name||'角色')+' · '+branch+' · '+(pos<0?'消息 '+s.message:'第 '+(pos+1)+' 条消息');
        }));
        if(ticket===viewVersion)el('places').textContent='出现 '+item.uses.length+' 处：'+places.join(' / ')+(item.uses.length>3?' …':'');
    }
    async function openImage(i){
        const item=visible[i];if(!item)return;
        opened=item;const ticket=++viewVersion,s=item.uses.find(s=>s.owner===group)||item.uses[0];
        releaseOriginal();el('viewerStatus').textContent='';el('places').textContent='';
        el('imageTitle').textContent=[...new Set(item.owners.values())].join('、');el('position').textContent=(i+1)+' / '+visible.length;
        el('prev').disabled=i===0;el('next').disabled=i+1===visible.length;
        el('prompt').textContent=s.prompt;el('imageInfo').textContent=[s.plan?.style,s.plan?.model||s.plan?.params?.model,item.bytes?format(item.bytes):'',item.created?new Date(item.created).toLocaleString('zh-CN'):''].filter(Boolean).join(' · ');
        for(const id of ['originalImage','saveOriginal','removeImage','restoreImage','legacyLabel'])el(id).hidden=true;
        el('missing').textContent='读取原图…';if(!viewer.open)viewer.showModal();
        void showPlaces(item,ticket).catch(message);
        const blob=item.digest?await api.getOriginal(item.digest):null;if(ticket!==viewVersion)return;
        if(blob){
            const u=originalUrl=URL.createObjectURL(blob),img=el('originalImage'),link=el('saveOriginal');
            img.alt=s.prompt||'原图';img.src=u;link.href=u;link.download=(s.name||'原图').replace(/[\\/:*?"<>|]/g,'_')+'-'+item.digest.slice(0,8)+'.'+blob.type.split('/')[1];
            img.hidden=link.hidden=el('removeImage').hidden=false;el('missing').textContent='';
        }else{
            const gone=s.status==='removed';el('missing').textContent=gone?'原图已删除，可在聊天中点重绘':'原图未保存';
            el('restoreImage').hidden=gone;el('legacyLabel').hidden=gone||!s.legacyQuery;
        }
    }
    function step(n){if(opened)openImage(visible.indexOf(opened)+n).catch(message);}
    el('prev').onclick=()=>step(-1);el('next').onclick=()=>step(1);el('close').onclick=()=>viewer.close();
    viewer.onclose=()=>{opened=null;++viewVersion;releaseOriginal();};
    viewer.onkeydown=e=>{if(e.target.tagName==='INPUT')return;if(e.key==='ArrowLeft')step(-1);if(e.key==='ArrowRight')step(1);};
    let start;const stage=document.querySelector('.stage');
    stage.ontouchstart=e=>{start=e.touches.length===1?e.touches[0]:null;};
    stage.ontouchend=e=>{if(!start)return;const t=e.changedTouches[0],dx=t.clientX-start.clientX;
        if(Math.abs(dx)>50 && Math.abs(dx)>1.5*Math.abs(t.clientY-start.clientY))step(dx<0?1:-1);start=null;};
    async function restored(s,blob){
        await api.resolve(s,s.plan,null,{original:new host.Blob([blob],{type:blob.type})});changeParent(s);viewer.close();await refresh();el('status').textContent='已保存原文件';
    }
    el('restoreImage').onclick=()=>el('originalFile').click();
    el('originalFile').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(f&&opened)try{await restored(opened.uses[0],f);}catch(err){message(err);}};
    el('readLegacy').onclick=async()=>{
        const slot=opened?.uses[0];if(!slot?.legacyQuery)return;
        try{
            const url=new URL(el('legacySite').value);if(url.protocol!=='https:'||url.username||url.password)throw Error('请填写原站 HTTPS 地址');
            const res=await fetch(url.origin+'/api/rp-image?'+slot.legacyQuery,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
            if(!res.ok)throw Error('旧站未返回原图，可从文件补回。');await restored(slot,await res.blob());
        }catch(e){message(e);}
    };
    el('removeImage').onclick=async()=>{
        const item=opened,session=host.RPPrivateAPI.session();
        if(!item?.digest||!confirm('从本机'+(session?.account&&!session.detached?'和私人站点':'')+'删除这张原图？'+[...item.owners.values()].join('、')+' 的 '+item.uses.length+' 处引用及命名存档点将显示缺图。'))return;
        el('removeImage').disabled=true;
        try{await api.remove(item.uses[0]);changeParent(item.uses[0]);viewer.close();await refresh();await usage();}catch(e){message(e);}finally{el('removeImage').disabled=false;}
    };
    void refresh().catch(message);void usage();void host.RPImageThumbs.trim().catch(()=>{});
})();
