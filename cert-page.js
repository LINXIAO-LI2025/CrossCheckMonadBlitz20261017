'use strict';
(() => {
  const C=CrossCheck,$=id=>document.getElementById(id),references=new Map();
  let currentReport=null,config=null,stopWatch=null,verifying=false,lastRendered='';
  const params=new URLSearchParams(location.search),certificateId=params.get('id'),jobId=params.get('job');
  const normalizedReport=value=>C.validateReport(value?.report || value);
  function showInfo(value,error=false){$('certContent').innerHTML='<div class="card"><div class="card-title">'+(error?'暂时无法读取':'报告凭证')+'</div><p class="value">'+C.escape(value)+'</p><a href="/submit.html">前往提交页</a></div>';}
  function showResult(value,type='pending'){$('verifyResult').className='verify-result '+type;$('verifyResult').textContent=value;}
  function render(value,serverHashes,fromServer=false){
    const report=normalizedReport(value),hashes=C.hashes(report.payload),signature=JSON.stringify(report);
    if(fromServer)references.set(report.payload.job_id,serverHashes || hashes);
    if(signature===lastRendered)return;
    currentReport=report;lastRendered=signature;const {payload,proof}=report,result=C.getAgreement(payload.agreement);
    const models=payload.models.map(model=>{const verdict=C.getVerdict(model.verdict);return '<div class="model-card"><div class="model-name">'+C.escape(model.provider)+'</div><div class="small-note">请求：'+C.escape(model.requested_model || '未配置')+' · 返回：'+C.escape(model.returned_model || '无')+'</div><div class="verdict-display"><div class="verdict-text">'+verdict.text+'</div></div><div class="reason">'+C.escape(model.reason || model.error_code || '未返回理由')+'</div></div>';}).join('');
    const noProof=payload.mode==='demo'?'A 预设演示不广播交易，报告的 proof 为 null。可导出、复算并与本次任务报告比较离线指纹；不能显示链上核验通过。':'报告还没有确认的链上凭证。可下载报告，待存证确认后再核对链上记录。';
    const proofHtml=proof?'<div class="card"><div class="card-title">链上定位信息（待浏览器核验）</div><div class="blockchain-info"><div class="info-item"><div class="label">链 ID</div><div class="value">'+C.escape(proof.chain_id)+'</div></div><div class="info-item"><div class="label">区块号</div><div class="value">'+C.escape(proof.block_number)+'</div></div><div class="info-item"><div class="label">凭证号</div><div class="value">'+C.escape(proof.certificate_id)+'</div></div></div><div class="label">合约地址</div><div class="value hash">'+C.escape(proof.contract_address)+'</div><div class="label">提交地址</div><div class="value hash">'+C.escape(proof.issuer)+'</div><div class="label">交易哈希</div><div class="value hash">'+C.escape(proof.tx_hash)+'</div></div>':'<div class="card"><div class="card-title">没有链上凭证</div><p class="value">'+noProof+'</p></div>';
    $('certContent').innerHTML='<div class="card"><div class="cert-id">'+(proof?'#'+C.escape(proof.certificate_id):'离线报告')+'</div><div class="agreement-badge agreement-'+payload.agreement+'">'+result.text+'</div><div class="mode-notice">'+(payload.mode==='demo'?'预设演示报告：未调用真实模型 API；当前 A 演示模式不广播交易。':'真实 API 模式报告：发布者记录模型意见，不是模型厂商双签。')+'</div><div class="small-note">任务 '+C.escape(payload.job_id)+' · '+C.escape(payload.completed_at)+'</div></div><div class="card"><div class="card-title">双模型审阅结果</div><div class="model-results">'+models+'</div></div><div class="card"><div class="card-title">原文内容（保留全部字符）</div><div class="content-preview">'+C.escape(payload.raw_text)+'</div></div><div class="card"><div class="card-title">共享协议指纹 · 当前浏览器复算</div><div class="label">内容指纹</div><div class="value hash">'+hashes.content_hash+'</div><div class="label">完整 payload 指纹（包含全部嵌套模型字段）</div><div class="value hash">'+hashes.verdict_hash+'</div><div class="small-note">由 A 的 @crosscheck/protocol 计算；复算本身不证明来源或链上记录。</div></div>'+proofHtml+'<button id="downloadReport" class="success">下载完整报告 JSON</button>';
    $('downloadReport').addEventListener('click',()=>C.download(currentReport));
    const explorer=proof && C.explorerLink(config,proof.tx_hash);
    if(explorer){const link=document.createElement('a');link.href=explorer;link.textContent='在区块浏览器查看交易';link.target='_blank';link.rel='noopener noreferrer';link.className='explorer-link';$('certContent').append(link);}
    const query=new URLSearchParams({job:payload.job_id});if(proof)query.set('id',proof.certificate_id);
    const share=document.createElement('section');share.className='card report-share';C.renderShare(share,'/cert.html?'+query.toString(),config,'打开服务中保存的同一报告');
    const note=document.createElement('p');note.className='small-note';note.textContent='导入的 JSON 不会上传；二维码不包含本地修改或文件。';share.querySelector('.share-details').append(note);$('certContent').append(share);
    $('reportJson').value=JSON.stringify(report,null,2);$('verifyCurrent').disabled=false;$('tamperSample').disabled=false;
    if(serverHashes && (serverHashes.content_hash!==hashes.content_hash || serverHashes.verdict_hash!==hashes.verdict_hash))showResult('报告与服务器任务指纹不同；不要把它作为该任务原报告。','error');
    else showResult(proof?'共享 schema 校验和指纹复算完成。尚未从 RPC 核对链上记录。':'已通过共享 schema 校验并复算指纹。此报告没有链上 proof，可进行离线指纹对照。');
  }
  async function load(){
    try{
      if(certificateId){try{const value=await C.request('/api/cert/'+encodeURIComponent(certificateId));render(value.report,value.hashes,true);return;}catch(error){if(!jobId)throw error;$('loadNotice').textContent='凭证暂时无法实时核对：'+error.message+'；改为查看任务报告。';}}
      if(jobId){
        const report=await C.request('/api/jobs/'+encodeURIComponent(jobId)+'/report').catch(()=>null);if(report?.payload)render(report,null,true);
        stopWatch=C.watchJob(jobId,job=>{if(job.payload){render({payload:job.payload,proof:job.proof || null},job.hashes,true);if(job.proof && !params.get('id')){params.set('id',job.proof.certificate_id);history.replaceState(null,'','?'+params.toString());}}else showInfo((C.statuses[job.status] || job.status)+(job.error?'：'+job.error.message:'；报告生成后自动展示。'));},error=>{$('loadNotice').textContent='更新失败，将继续查询：'+error.message;});
      }else showInfo('从提交结果打开报告，或在下方导入完整 JSON。没有链上 proof 的报告只能离线复算。');
    }catch(error){showInfo(error.message,true);}
  }
  async function verify(value){
    if(verifying)return;verifying=true;$('verifyCurrent').disabled=true;$('verifyPasted').disabled=true;
    try{
      const report=normalizedReport(value),computed=C.hashes(report.payload);$('computedHashes').textContent='内容：'+computed.content_hash+'\n完整报告：'+computed.verdict_hash;
      if(!report.proof){
        const reference=references.get(report.payload.job_id);
        if(reference && (reference.content_hash!==computed.content_hash || reference.verdict_hash!==computed.verdict_hash))throw new Error('离线报告指纹不匹配：与本次从 A 任务接口读取的原报告不同，模型理由或其他字段已修改');
        showResult(reference?'离线指纹与本次任务接口读取的原报告一致。\nproof 为 null，没有链上凭证；本结果不是链上核验通过。':'共享 schema 校验与离线指纹复算完成。\n没有可信原始指纹作对照，也没有链上 proof，无法据此断言文件未被篡改。','pending');return;
      }
      showResult('共享协议已复算全部字段，正在由浏览器读取已知部署的链上事件…');
      config=await C.request('/api/config');const rpcUrl=new URL($('rpcInput').value.trim(),location.href);
      if(!['http:','https:'].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password)throw new Error('RPC 须为 http(s) 地址，不得包含凭据');
      const record=await C.readAndCompare(report,config,rpcUrl.href);
      showResult('链上核验通过：完整报告指纹与指定合约的真实事件一致。\n链 '+record.proof.chain_id+' · 凭证 #'+record.proof.certificate_id+' · 区块 '+record.proof.block_number+'\n这只证明报告与存证记录相符，不证明内容真实或模型厂商签署。','success');
    }catch(error){showResult('核验未通过：'+(error.shortMessage || error.message)+'\n网络不可用时无法完成链上核对，不应自动判定为内容篡改。','error');}
    finally{verifying=false;$('verifyCurrent').disabled=!currentReport;$('verifyPasted').disabled=false;}
  }
  $('verifyCurrent').addEventListener('click',()=>currentReport && verify(currentReport));
  $('verifyPasted').addEventListener('click',()=>{try{if($('reportJson').value.length>2*1024*1024)throw new Error('JSON 超过 2 MB');verify(JSON.parse($('reportJson').value));}catch(error){showResult('JSON 无法解析：'+error.message,'error');}});
  $('fileInput').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('文件超过 2 MB');const report=normalizedReport(JSON.parse(await file.text()));stopWatch?.();render(report);await verify(report);}catch(error){showResult('导入失败：'+error.message,'error');}finally{event.target.value='';}});
  $('tamperSample').addEventListener('click',()=>{if(!currentReport)return;const changed=JSON.parse(JSON.stringify(currentReport));const model=changed.payload.models.find(item=>item.status==='succeeded');if(!model){showResult('该报告没有可修改的成功模型理由。');return;}model.reason+='【已修改，用于篡改检测】';$('reportJson').value=JSON.stringify(changed,null,2);showResult('已在文本框载入修改嵌套模型理由的副本。点击“核验文本框中的报告”，可检测与原任务指纹或链上记录的差异。');});
  Promise.all([C.request('/api/config'),C.health().catch(()=>null)]).then(([value,status])=>{config=value;$('environment').textContent=C.modeLabel(value,status);$('rpcInput').value='https://testnet-rpc.monad.xyz';$('expectedConfig').textContent='预期链 '+(value.chain_id || '未配置')+' ｜ 合约 '+(value.contract_address || '未部署')+' ｜ 提交地址 '+(value.issuer || '未配置');}).catch(error=>{$('environment').textContent='无法读取 A 配置：'+error.message;}).finally(load);
  window.addEventListener('pagehide',()=>stopWatch?.());
})();
