document.getElementById('generate').onclick=async()=>{
    const field=document.getElementById('secret');
    if(!field.value)field.value=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    field.hidden=false;
    try{await navigator.clipboard.writeText(field.value);document.getElementById('status').textContent='已复制，请保存在自己的密码管理器中';}
    catch{field.focus();field.select();document.getElementById('status').textContent='请复制选中的口令';}
};
