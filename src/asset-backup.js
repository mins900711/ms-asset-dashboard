// JSON backups contain application records only, never a password or API credential.
const ASSET_BACKUP_FORMAT='ms-asset-dashboard-backup';
const ASSET_BACKUP_FIELDS={
 holdings:['owner_key','owner_label','account_name','account_type','asset_name','quantity','sort_order'],
 history:['record_date','total_krw','total_usd'],
 composition_history:['record_date','asset_name','amount_krw','entry_type','sort_order'],
 market_prices:['price_key','display_name','symbol','market','quote_currency','price','unit','price_date','data_status','sort_order'],
 asset_config:['asset_name','price_key','currency','unit','fixed_price','direct_value','liability','reference_price','home_category','home_mode','special_role','sort_order']
};
function backupKstStamp(date=new Date()){
 return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
function validateAssetBackup(backup){
 const fail=()=>{throw new Error('자산관리 사이트에서 받은 올바른 JSON 백업 파일을 선택해 주세요.');};
 const d=backup&&backup.data;
 if(!backup||backup.format!==ASSET_BACKUP_FORMAT||backup.version!==1||!d||typeof d!=='object'||Array.isArray(d)||!Number.isFinite(Date.parse(backup.exportedAt)))fail();
 for(const key of ['holdings','history','composition_history'])if(!Array.isArray(d[key]))fail();
 if(!d.holdings.length||d.holdings.length>2000||d.history.length>20000||d.composition_history.length>100000)fail();
 const num=(v,min=0,max=1e18)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
 const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=120;
 const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v&&v>='1900-01-01'&&v<=backupKstStamp().slice(0,10);
 const order=v=>num(v,0,100000)&&Number.isInteger(v);
 for(const [key,check,identity] of [
  ['holdings',r=>['dad','mom','sky','sea'].includes(r.owner_key)&&['owner_label','account_name','account_type','asset_name'].every(k=>text(r[k]))&&num(r.quantity,0,1e16)&&order(r.sort_order),r=>[r.owner_key,r.account_name,r.asset_name]],
  ['history',r=>date(r.record_date)&&num(r.total_krw,0.000001)&&num(r.total_usd,0.000001),r=>[r.record_date]],
  ['composition_history',r=>date(r.record_date)&&text(r.asset_name)&&['asset','liability'].includes(r.entry_type)&&num(r.amount_krw)&&Number.isInteger(r.amount_krw)&&order(r.sort_order),r=>[r.record_date,r.asset_name,r.entry_type]]
 ]){
  const seen=new Set();
  for(const row of d[key]){
   if(!row||typeof row!=='object'||Array.isArray(row)||!check(row))fail();
   const id=JSON.stringify(identity(row));if(seen.has(id))fail();seen.add(id);
  }
 }
 return backup;
}
function buildAssetBackup(payload,createdAt=new Date()){
 if(!payload||typeof payload!=='object')throw new Error('저장된 기록을 불러오지 못했습니다.');
 const copy=(row,keys)=>Object.fromEntries(keys.filter(k=>row&&Object.hasOwn(row,k)).map(k=>[k,row[k]]));
 const data={};
 for(const [key,fields] of Object.entries(ASSET_BACKUP_FIELDS)){
  if(!Array.isArray(payload[key]))throw new Error('백업에 필요한 기록이 누락되었습니다.');
  data[key]=payload[key].map(row=>copy(row,fields));
 }
 data.fx_rate=payload.fx_rate;
 data.dashboard={...copy(payload.dashboard,['total_krw','total_usd']),assets:(payload.dashboard?.assets||[]).map(row=>copy(row,['asset_name','amount_krw','sort_order']))};
 return validateAssetBackup({format:ASSET_BACKUP_FORMAT,version:1,exportedAt:createdAt.toISOString(),exportedAtKst:backupKstStamp(createdAt),data});
}
function downloadAssetBackup(backup){
 const stamp=backupKstStamp(new Date(backup.exportedAt)).replace(' ','_').replace(':','');
 const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download='MS_assets_backup_'+stamp+'.json';
 document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
let assetBackupBusy=false,pendingAssetRestore=null;
function updateAssetBackupControls(){
 const enabled=settingsUnlocked&&settingsLoaded&&!assetBackupBusy;
 for(const id of ['assetBackupBtn','assetRestoreBtn'])document.getElementById(id).disabled=!enabled;
 document.getElementById('assetBackupBtn').textContent=assetBackupBusy?'처리 중…':'JSON 백업 내려받기';
 document.getElementById('assetRestoreCurrentBtn').disabled=!enabled||!pendingAssetRestore;
 document.getElementById('assetRestoreCancelBtn').disabled=assetBackupBusy;
 document.getElementById('assetRestoreConfirmBtn').disabled=!enabled||!pendingAssetRestore||!document.getElementById('assetRestoreAcknowledge').checked;
}
function cancelAssetRestore(){
 pendingAssetRestore=null;
 const dialog=document.getElementById('assetRestoreDialog');if(dialog.open)dialog.close();
 document.getElementById('assetRestoreAcknowledge').checked=false;
 document.getElementById('assetRestoreAcknowledge').disabled=true;
 document.getElementById('assetRestoreFile').value='';
}
async function assetBackupRpc(action,data={}){
 const result=await callRpc('ms_backup_gateway',{p_password:settingsSessionPin,p_action:action,p_data:data});
 if(result?.error)throw new Error('관리자 비밀번호를 다시 확인해 주세요.');
 return result;
}
async function exportAssetBackup(){
 if(assetBackupBusy)return;
 if(!settingsUnlocked||!settingsSessionPin){requestSettingsUnlock(page);return;}
 const pin=settingsSessionPin;assetBackupBusy=true;updateAssetBackupControls();
 try{
  const payload=await callRpc(ADMIN_DATA_RPC,{p_password:pin});
  if(!settingsUnlocked||settingsSessionPin!==pin)return;
  downloadAssetBackup(buildAssetBackup(payload));
  document.getElementById('assetBackupStatus').textContent='마지막 백업: '+backupKstStamp()+' · 서버에 저장된 기록';
  showToast('JSON 백업 파일을 내려받았습니다');
 }catch(error){showToast('백업 실패 · '+shortError(error));}
 finally{assetBackupBusy=false;updateAssetBackupControls();}
}
async function prepareAssetRestore(file){
 if(!file||assetBackupBusy)return;
 if(!settingsUnlocked||!settingsSessionPin){requestSettingsUnlock(page);return;}
 const pin=settingsSessionPin;assetBackupBusy=true;updateAssetBackupControls();
 try{
  if(file.size>10485760)throw new Error('백업 파일은 10MB 이하여야 합니다.');
  let parsed;try{parsed=JSON.parse(await file.text());}catch{throw new Error('JSON 백업 파일을 읽을 수 없습니다.');}
  validateAssetBackup(parsed);
  // Allowlist imported fields as well as exported ones.
  const backup=buildAssetBackup(parsed.data,new Date(parsed.exportedAt));
  const current=await assetBackupRpc('prepare');
  if(!settingsUnlocked||settingsSessionPin!==pin)return;
  if(!current?.fingerprint||!current.data)throw new Error('현재 기록을 확인하지 못했습니다.');
  pendingAssetRestore={backup,fingerprint:current.fingerprint,current:buildAssetBackup(current.data),pin};
  document.getElementById('assetRestoreSummary').textContent='백업 시각: '+backup.exportedAtKst+' (한국시간)\n보유 항목 '+backup.data.holdings.length+'개 · History '+backup.data.history.length+'개 · 자산구성 기록 '+backup.data.composition_history.length+'개';
  document.getElementById('assetRestoreAcknowledge').checked=false;
  document.getElementById('assetRestoreAcknowledge').disabled=true;
  document.getElementById('assetRestoreDialog').showModal();
 }catch(error){showToast('가져오기 실패 · '+shortError(error));}
 finally{assetBackupBusy=false;document.getElementById('assetRestoreFile').value='';updateAssetBackupControls();}
}
function backupBeforeAssetRestore(){
 if(!pendingAssetRestore||!settingsUnlocked||settingsSessionPin!==pendingAssetRestore.pin)return;
 downloadAssetBackup(pendingAssetRestore.current);
 document.getElementById('assetRestoreAcknowledge').disabled=false;
 showToast('현재 기록을 백업했습니다. 파일 보관 후 복원해 주세요');
}
async function confirmAssetRestore(){
 if(assetBackupBusy||!pendingAssetRestore||!document.getElementById('assetRestoreAcknowledge').checked)return;
 const pending=pendingAssetRestore;
 if(!settingsUnlocked||settingsSessionPin!==pending.pin){cancelAssetRestore();return;}
 assetBackupBusy=true;updateAssetBackupControls();
 try{
  const result=await assetBackupRpc('restore',{backup:pending.backup,fingerprint:pending.fingerprint});
  if(!settingsUnlocked||settingsSessionPin!==pending.pin){cancelAssetRestore();return;}
  if(!result?.data||!result?.restored)throw new Error('복원 결과를 확인하지 못했습니다.');
  cancelAssetRestore();
  if(publicMode){applyAdminData(result.data);try{await refreshPublicData();}catch{setSettingsSync('error','복원 완료 · Home은 새로고침해 주세요.');}}
  else applyInternalAppData(result.data);
  document.getElementById('assetBackupStatus').textContent='복원 완료: '+backupKstStamp();
  showToast('보유자산과 History 기록을 복원했습니다');
 }catch(error){
  showToast(String(error.message).includes('backup_revision_conflict')?'다른 곳에서 기록이 바뀌었습니다. 파일을 다시 선택해 확인해 주세요.':'복원 실패 · '+shortError(error));
 }finally{assetBackupBusy=false;updateAssetBackupControls();}
}
