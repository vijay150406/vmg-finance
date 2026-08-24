/* VMG Google Drive Sync V3 — Auto reconnect / auto sync
   Offline-first IndexedDB + Google Drive appDataFolder cloud copy.
   Uses Google Identity Services token model. Access tokens remain in memory only.
   No VMG financial calculations are implemented here.
*/
(function(){
  const DB_NAME='VMG_PFM_OFFLINE_DB_V2', DB_VERSION=3;
  const STORE='state', QUEUE='queue', META='meta';
  const DEVICE_KEY='VMG_DEVICE_ID_V2', LAST_SYNC_KEY='VMG_LAST_SYNC_V2';
  const CLOUD_FILE_KEY='VMG_GOOGLE_DRIVE_FILE_ID_V2';
  const BASELINE_ID='VMG-MASTER-BASELINE-V1';
  const FILE_NAME='VMG_PFM_MASTER_SYNC.json';
  const CFG=window.VMG_GOOGLE_DRIVE_CONFIG||{};
  const EDGE_URL=CFG.edgeFunctionUrl||'https://mnspbfeqbhotmqvyiqff.supabase.co/functions/v1/vmg-google-drive';
  const DEVICE_SECRET_KEY='VMG_DEVICE_SECRET_V3';
  let accessToken=null;
  function deviceId(){let x=localStorage.getItem(DEVICE_KEY);if(!x){x='vmg-'+crypto.randomUUID();localStorage.setItem(DEVICE_KEY,x)}return x}
  function deviceSecret(){
    let x=localStorage.getItem(DEVICE_SECRET_KEY);
    if(!x){
      const b=new Uint8Array(32);crypto.getRandomValues(b);
      let s='';for(const v of b)s+=String.fromCharCode(v);
      x=btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      localStorage.setItem(DEVICE_SECRET_KEY,x);
    }
    return x;
  }
  function configured(){return !!EDGE_URL}
  function open(){return new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});if(!db.objectStoreNames.contains(QUEUE))db.createObjectStore(QUEUE,{keyPath:'id',autoIncrement:true});if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:'key'})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  function tx(store,mode,fn){return open().then(db=>new Promise((res,rej)=>{const t=db.transaction(store,mode),s=t.objectStore(store);let out;try{out=fn(s)}catch(e){rej(e);return}t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error)}))}
  function get(store,key){return tx(store,'readonly',s=>new Promise((res,rej)=>{const r=s.get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))}
  function put(store,obj){return tx(store,'readwrite',s=>s.put(obj))}
  function all(store){return tx(store,'readonly',s=>new Promise((res,rej)=>{const r=s.getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))}
  async function saveLocal(data,reason){
    const old=await get(STORE,'current');
    const payload={id:'current',baselineId:BASELINE_ID,deviceId:deviceId(),updatedAt:new Date().toISOString(),version:old&&Number.isFinite(old.version)?old.version:0,data:structuredClone(data)};
    await put(STORE,payload);
    await tx(QUEUE,'readwrite',s=>s.add({createdAt:payload.updatedAt,deviceId:payload.deviceId,baseVersion:payload.version,baselineId:BASELINE_ID,data:payload.data,reason:reason||'save'}));
    return payload;
  }
  async function getLocal(){return await get(STORE,'current')}
  async function exportLocal(){const x=await getLocal();return x?x.data:null}

  async function edgeRequest(action,extra={}){
    const r=await fetch(EDGE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      action,deviceId:deviceId(),deviceSecret:deviceSecret(),...extra
    })});
    let j={};try{j=await r.json()}catch{}
    if(!r.ok)throw new Error(j.error||('VMG authorization service failed ('+r.status+').'));
    return j;
  }

  async function getPersistentToken(){
    const j=await edgeRequest('token');
    if(!j.accessToken)throw new Error('Google Drive token was not returned.');
    accessToken=j.accessToken;
    return true;
  }

  async function authorize(userGesture=true){
    if(!configured())throw new Error('Google Drive service is not configured.');
    if(!userGesture){
      try{return await getPersistentToken();}
      catch(e){return false;}
    }

    const j=await edgeRequest('authorize',{returnUrl:location.href});
    if(!j.authorizationUrl)throw new Error('Google authorization URL was not returned.');

    return new Promise((resolve,reject)=>{
      let settled=false;
      const timer=setTimeout(()=>{if(!settled){settled=true;window.removeEventListener('message',onMessage);reject(new Error('Google authorization timed out.'));}},5*60*1000);
      function onMessage(ev){
        if(ev.origin!==location.origin)return;
        const d=ev.data||{};
        if(d.type!=='VMG_GOOGLE_AUTH')return;
        settled=true;clearTimeout(timer);window.removeEventListener('message',onMessage);
        if(!d.ok){reject(new Error(d.error||'Google authorization failed.'));return;}
        getPersistentToken().then(()=>resolve({accessToken})).catch(reject);
      }
      window.addEventListener('message',onMessage);
      const w=window.open(j.authorizationUrl,'vmgGoogleAuth','width=520,height=700,resizable=yes,scrollbars=yes');
      if(!w){
        window.removeEventListener('message',onMessage);clearTimeout(timer);
        reject(new Error('Google sign-in popup was blocked. Please allow pop-ups for VMG and try again.'));
      }
    });
  }

  async function autoAuthorize(){
    if(!configured()||!navigator.onLine||accessToken)return false;
    try{return await authorize(false);}catch(e){
      console.info('VMG persistent Google reconnect unavailable:',e.message||e);
      return false;
    }
  }

  async function api(path,opts={}){
    if(!accessToken)throw new Error('Google Drive authorization required. Click Connect Google Drive.');
    const h=new Headers(opts.headers||{});h.set('Authorization','Bearer '+accessToken);if(opts.body && !h.has('Content-Type'))h.set('Content-Type','application/json');
    const r=await fetch('https://www.googleapis.com/drive/v3/'+path,{...opts,headers:h});
    if(r.status===401){
      accessToken=null;
      try{await getPersistentToken();return await api(path,opts);}
      catch(e){throw new Error('Google Drive authorization expired. Please connect Google Drive again.');}
    }
    if(!r.ok){let msg='Google Drive request failed ('+r.status+')';try{const j=await r.json();msg=j.error?.message||msg}catch{}throw new Error(msg)}
    return r.status===204?null:r.json();
  }
  async function findCloud(){
    const known=localStorage.getItem(CLOUD_FILE_KEY);
    if(known){try{return await api('files/'+encodeURIComponent(known)+'?fields=id,name,version,modifiedTime,md5Checksum,trashed')}catch(e){localStorage.removeItem(CLOUD_FILE_KEY)}}
    const q=encodeURIComponent("name='"+FILE_NAME.replace(/'/g,"\\'")+"' and trashed=false");
    const r=await api('files?spaces=appDataFolder&q='+q+'&pageSize=10&fields=files(id,name,version,modifiedTime,md5Checksum)');
    const f=r.files?.[0]||null;if(f)localStorage.setItem(CLOUD_FILE_KEY,f.id);return f;
  }
  async function readCloud(fileId){
    const r=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media',{headers:{Authorization:'Bearer '+accessToken}});
    if(!r.ok)throw new Error('Unable to download VMG cloud data ('+r.status+').');
    return r.json();
  }
  function multipartBody(metadata,json){
    const boundary='vmg_'+crypto.randomUUID().replace(/-/g,'');
    const parts=[
      '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n',
      '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(json)+'\r\n',
      '--'+boundary+'--\r\n'
    ];
    return {body:parts.join(''),contentType:'multipart/related; boundary='+boundary};
  }
  async function createCloud(data){
    const {body,contentType}=multipartBody({name:FILE_NAME,mimeType:'application/json',parents:['appDataFolder'],appProperties:{baselineId:BASELINE_ID,deviceId:deviceId(),application:'VMG-PFM'}},data);
    const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,version,modifiedTime,md5Checksum',{method:'POST',headers:{Authorization:'Bearer '+accessToken,'Content-Type':contentType},body});
    if(!r.ok){let m='Unable to create VMG cloud file ('+r.status+').';try{const j=await r.json();m=j.error?.message||m}catch{}throw new Error(m)}
    const f=await r.json();localStorage.setItem(CLOUD_FILE_KEY,f.id);return f;
  }
  async function updateCloud(file,data){
    const {body,contentType}=multipartBody({name:FILE_NAME,mimeType:'application/json',appProperties:{baselineId:BASELINE_ID,deviceId:deviceId(),application:'VMG-PFM'}},data);
    const r=await fetch('https://www.googleapis.com/upload/drive/v3/files/'+encodeURIComponent(file.id)+'?uploadType=multipart&fields=id,name,version,modifiedTime,md5Checksum',{method:'PATCH',headers:{Authorization:'Bearer '+accessToken,'Content-Type':contentType},body});
    if(r.status===409)throw Object.assign(new Error('VMG cloud file changed on another device.'),{code:'VMG_CONFLICT'});
    if(!r.ok){let m='Unable to update VMG cloud file ('+r.status+').';try{const j=await r.json();m=j.error?.message||m}catch{}throw new Error(m)}
    return r.json();
  }
  async function sync(){
    if(!navigator.onLine)return {ok:false,skipped:true,reason:'offline'};
    if(!configured())return {ok:false,skipped:true,reason:'not-configured'};
    if(!accessToken)return {ok:false,skipped:true,reason:'not-authorized'};
    try{
      const local=await getLocal();
      if(!local)return {ok:false,error:'No local VMG data found.'};
      let cloud=await findCloud();
      if(!cloud){
        cloud=await createCloud(local.data);
        await put(STORE,{...local,cloudVersion:Number(cloud.version||0),cloudModifiedTime:cloud.modifiedTime||'',cloudFileId:cloud.id});
        localStorage.setItem(LAST_SYNC_KEY,new Date().toISOString());
        await clearQueue();
        return {ok:true,created:true,at:localStorage.getItem(LAST_SYNC_KEY)};
      }
      const saved=await get(STORE,'current');
      const knownVersion=Number(saved?.cloudVersion||0);
      const currentCloudVersion=Number(cloud.version||0);
      const q=await all(QUEUE);
      if(knownVersion && currentCloudVersion!==knownVersion){
        const remote=await readCloud(cloud.id);
        const e=new Error('VMG cloud data changed on another device. Review before replacing it.');e.code='VMG_CONFLICT';e.remote=remote;e.cloud=cloud;throw e;
      }
      /* A newly opened second device has only the automatic initial-migration
         queue entry. In that case the existing cloud copy is authoritative and
         must be pulled, not overwritten by the blank/local starter state. */
      if(!knownVersion && q.length && q.every(x=>x.reason==='initial-migration')){
        const remote=await readCloud(cloud.id);
        await put(STORE,{id:'current',baselineId:BASELINE_ID,deviceId:cloud.appProperties?.deviceId||deviceId(),updatedAt:cloud.modifiedTime,version:Number(local.version||0),data:remote,cloudVersion:currentCloudVersion,cloudModifiedTime:cloud.modifiedTime,cloudFileId:cloud.id});
        await clearQueue();
        if(window.__VMG_APPLY_REMOTE__)await window.__VMG_APPLY_REMOTE__(remote);
      } else if(q.length){
        cloud=await updateCloud(cloud,local.data);
        await put(STORE,{...local,cloudVersion:Number(cloud.version||0),cloudModifiedTime:cloud.modifiedTime||'',cloudFileId:cloud.id});
        await clearQueue();
      } else if(currentCloudVersion>Number(local.cloudVersion||0)){
        const remote=await readCloud(cloud.id);
        await put(STORE,{id:'current',baselineId:BASELINE_ID,deviceId:cloud.appProperties?.deviceId||deviceId(),updatedAt:cloud.modifiedTime,version:Number(remote?.version||local.version||0),data:remote,cloudVersion:currentCloudVersion,cloudModifiedTime:cloud.modifiedTime,cloudFileId:cloud.id});
        if(window.__VMG_APPLY_REMOTE__)await window.__VMG_APPLY_REMOTE__(remote);
      }
      const now=new Date().toISOString();localStorage.setItem(LAST_SYNC_KEY,now);await put(META,{key:'lastSync',value:now});
      return {ok:true,at:now,cloudVersion:Number(cloud.version||0)};
    }catch(e){return {ok:false,conflict:e.code==='VMG_CONFLICT',error:e.message||String(e),remote:e.remote}}
  }
  async function clearQueue(){const q=await all(QUEUE);for(const x of q)await tx(QUEUE,'readwrite',s=>s.delete(x.id))}
  async function disconnect(){
    accessToken=null;
    try{await edgeRequest('disconnect')}catch(e){console.warn('VMG disconnect:',e)}
  }
  function status(){return {online:navigator.onLine,configured:configured(),authorized:!!accessToken,deviceId:deviceId(),lastSync:localStorage.getItem(LAST_SYNC_KEY)||'',fileId:localStorage.getItem(CLOUD_FILE_KEY)||''}}
  window.VMGSync={deviceId,saveLocal,getLocal,exportLocal,sync,status,authorize,autoAuthorize,disconnect,configured,baselineId:BASELINE_ID};
})();
/* VMG AUTO-CONNECT V3 — launch + foreground + network retry.
   Browser-only Google OAuth cannot persist a refresh token. This layer retries
   silent authorization whenever the browser exposes the prior Google grant.
   Manual Connect remains the fallback when Google requires interaction.
*/
(function(){
  let busy=false,lastAttempt=0;
  async function bootAuto(){
    if(busy||Date.now()-lastAttempt<3000)return;
    busy=true;lastAttempt=Date.now();
    try{
      if(!window.VMGSync)return;
      const st=VMGSync.status();
      if(!st.online||!st.configured||st.authorized)return;
      if(!window.google?.accounts?.oauth2)return;
      const ok=await VMGSync.autoAuthorize();
      if(ok){
        const r=await VMGSync.sync();
        if(window.__VMG_SYNC_STATUS_REFRESH__)window.__VMG_SYNC_STATUS_REFRESH__();
        if(r&&r.conflict)console.warn('VMG Google Drive conflict:',r.error);
        else if(r&&!r.ok)console.warn('VMG Google Drive auto-sync:',r.error||r.reason);
      }
    }catch(e){console.info('VMG auto-sync retry:',e.message||e)}
    finally{busy=false}
  }
  function schedule(){
    setTimeout(bootAuto,350);
    setTimeout(bootAuto,1500);
    setTimeout(bootAuto,4000);
    setTimeout(bootAuto,8000);
  }
  window.addEventListener('load',schedule);
  window.addEventListener('focus',()=>setTimeout(bootAuto,250));
  window.addEventListener('online',()=>setTimeout(bootAuto,500));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(bootAuto,250)});
})();

/* VMG V21 — authoritative VMG data bridge
   The main VMG application stores its authoritative data in localStorage.
   This bridge connects that store to the persistent Supabase-backed sync
   engine above without changing any financial logic. */
(function(){
  const KEY='PFM_VMG_MASTER_BASELINE_V1';
  let timer=null, busy=false, lastPushed='';

  function readMain(){
    try{ const raw=localStorage.getItem(KEY); return raw?JSON.parse(raw):null; }
    catch(e){ console.warn('VMG V21 read main data:',e); return null; }
  }

  async function pushMain(reason){
    if(busy||!window.VMGSync)return;
    const data=readMain();
    if(!data)return;
    const raw=JSON.stringify(data);
    if(raw===lastPushed && reason!=='manual')return;
    busy=true;
    try{
      lastPushed=raw;
      await VMGSync.saveLocal(data,reason||'vmg-save');
      const st=VMGSync.status();
      if(st.online && st.configured){
        if(!st.authorized) await VMGSync.autoAuthorize();
        if(VMGSync.status().authorized) await VMGSync.sync();
      }
    }catch(e){ console.warn('VMG V21 push:',e); }
    finally{busy=false;}
  }

  function schedule(reason){
    clearTimeout(timer);
    timer=setTimeout(()=>pushMain(reason),250);
  }

  /* The original inline VMG code defines this function later than sync.js.
     Replace that global hook after the page has loaded so the existing Save
     button and all existing calls feed the persistent sync engine. */
  function installHook(){
    window.vmgDriveScheduleSync=function(){ schedule('vmg-save'); };
    schedule('startup');
  }

  /* Apply a cloud copy to the actual VMG localStorage store, then reload the
     page so every existing VMG calculation/rendering path sees the same data.
     No financial transformation is performed here. */
  window.__VMG_APPLY_REMOTE__=async function(remote){
    try{
      if(!remote)return false;
      localStorage.setItem(KEY,JSON.stringify(remote));
      setTimeout(()=>location.reload(),50);
      return true;
    }catch(e){ console.error('VMG V21 apply remote:',e); return false; }
  };

  window.__VMG_SYNC_STATUS_REFRESH__=function(){
    try{ if(typeof vmgDriveUpdateUi==='function')vmgDriveUpdateUi(); }catch(e){}
  };

  window.addEventListener('load',()=>{
    setTimeout(installHook,100);
    setInterval(()=>{
      const raw=localStorage.getItem(KEY)||'';
      if(raw && raw!==lastPushed) schedule('vmg-local-change');
    },1000);
  });

  window.addEventListener('focus',()=>setTimeout(()=>{
    if(window.VMGSync?.status().online) VMGSync.autoAuthorize().then(ok=>ok&&VMGSync.sync()).catch(()=>{});
  },500));
  window.addEventListener('online',()=>setTimeout(()=>{
    if(window.VMGSync?.status().online) VMGSync.autoAuthorize().then(ok=>ok&&VMGSync.sync()).catch(()=>{});
  },500));
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden)setTimeout(()=>{
      if(window.VMGSync?.status().online) VMGSync.autoAuthorize().then(ok=>ok&&VMGSync.sync()).catch(()=>{});
    },500);
  });
})();
