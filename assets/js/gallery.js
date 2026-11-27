(() => {
    if(!window.RPImages)return;
    const el=id=>document.getElementById(id);
    const list=el('imageList'),viewer=el('imageView'),filter=el('galleryOwner');
    let rows=[],shown=[],offset=0,selected,fullUrl,epoch=0;
    const urls=new Set();
    function url(blob){const u=URL.createObjectURL(blob);urls.add(u);return u;}
    function release(){for(const u of urls)URL.revokeObjectURL(u);urls.clear();}
    window.addEventListener('pagehide',release);
    const thumbs=new IntersectionObserver(entries=>entries.forEach(async e=>{
        if(!e.isIntersecting)return;
        const img=e.target;thumbs.unobserve(img);
        try{const blob=await RPImages.getOriginal(img.dataset.digest);if(blob && img.isConnected)img.src=url(blob);}catch{}
    }));
    async function open(s){
        selected=s;const ticket=++epoch;const blob=s.digest && await RPImages.getOriginal(s.digest);
        if(ticket!==epoch)return;
        viewer.hidden=false;el('imageTitle').textContent=s.name+' · '+s.prompt;
        el('imageTitle').tabIndex=-1;el('imageTitle').focus();
        if(fullUrl){URL.revokeObjectURL(fullUrl);urls.delete(fullUrl);fullUrl=null;}
        const img=el('originalImage'),link=el('saveOriginal');
        img.hidden=!blob;link.hidden=!blob;el('removeImage').hidden=!blob;el('restoreImage').hidden=!!blob;
        el('legacyLabel').hidden=!!blob||!s.legacyQuery;
        const info=[s.plan?.style,s.plan?.model||s.plan?.params?.model,s.plan?.params?.size].filter(Boolean).join(' · ');
        el('imageInfo').textContent=(blob?'原图 · '+blob.size+' 字节':s.status==='removed'?'原图已移除':'原图未保存')+(info?' · '+info:'');
        if(blob){const u=fullUrl=url(blob);img.src=u;img.alt=s.prompt;link.href=u;link.download=(s.name+'-'+(s.index+1)).replace(/[\\/:*?"<>|]/g,'_')+'.'+(blob.type.split('/')[1]||'png');}
        else{img.removeAttribute('src');link.removeAttribute('href');}
    }
    function render(){
        epoch++;thumbs.disconnect();release();viewer.hidden=true;selected=null;list.replaceChildren();
        offset=0;shown=rows.filter(r=>!filter.value||r.owner===filter.value);
        el('galleryCount').textContent=shown.length?shown.length+' 个图位':'当前进度还没有已登记的图片';
        appendPage();
    }
    function appendPage(){
        const next=shown.slice(offset,offset+40);offset+=next.length;el('moreImages').hidden=offset>=shown.length;
        for(const s of next){
            const li=document.createElement('li'),b=document.createElement('button');b.type='button';
            if(s.digest){const img=document.createElement('img');img.width=64;img.height=64;img.style.objectFit='cover';img.alt='';img.dataset.digest=s.digest;b.append(img);thumbs.observe(img);}
            b.append(document.createTextNode(s.name+' · '+s.prompt+(s.digest?'':'（缺图）')));b.onclick=()=>open(s).catch(error);li.append(b);list.append(li);
        }
    }
    function error(e){el('galleryCount').textContent=e.message;}
    async function refresh(){
        rows=(await RPImages.catalog()).sort((a,b)=>b.created-a.created);
        const prev=filter.value;filter.replaceChildren(new Option('全部角色',''));
        for(const [id,name] of new Map(rows.map(r=>[r.owner,r.name])))filter.add(new Option(name,id));
        filter.value=prev;render();
    }
    async function restore(s,blob){await RPImages.resolve(s,s.plan,null,{original:blob});await refresh();el('galleryCount').textContent='已保存原文件';filter.focus();}
    el('restoreImage').onclick=()=>el('originalFile').click();
    el('originalFile').onchange=async event=>{const f=event.target.files[0];event.target.value='';if(f && selected)try{await restore(selected,f);}catch(e){error(e);}};
    el('readLegacy').onclick=async()=>{
        const s=selected;if(!s?.legacyQuery)return;
        try{const u=new URL(el('legacySite').value);
            if(u.protocol!=='https:'||u.username||u.password)throw Error('请填写原站 HTTPS 地址');
            const res=await fetch(u.origin+'/api/rp-image?'+s.legacyQuery,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
            if(!res.ok)throw Error('旧站未返回原图。可从旧图库下载原文件后在此补回。');
            await restore(s,await res.blob());
        }catch(e){error(e);}
    };
    el('removeImage').onclick=async()=>{
        if(!selected||!confirm('从当前进度移除这张原图？此前的命名存档点仍可恢复。'))return;
        try{await RPImages.remove(selected);await refresh();filter.focus();}catch(e){error(e);}
    };
    el('moreImages').onclick=appendPage;filter.onchange=render;refresh().catch(error);
})();
