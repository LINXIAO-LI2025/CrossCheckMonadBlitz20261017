'use strict';
(() => {
  const C=CrossCheck,$=id=>document.getElementById(id);
  let stopWatch=null,config=null,submitting=false;
  const samples={
    agreement:'[demo:agree] 演示声明：本报告的数据仅用于演示，不包含真实模型审核结论。',
    disagreement:'[demo:disagree] 演示声明：我们的 AI 产品准确率达到 99.9%，已服务全球 10 亿用户。',
    unable:'[demo:unable] 演示声明：某未公开项目明年将实现显著增长，目前没有可核对的资料。'
  };
  function setStatus(value,error=false){$('statusArea').innerHTML='<div class="'+(error?'error-card':'status-card')+'"><div class="status-text">'+C.escape(value)+'</div></div>';}
  function release(){submitting=false;$('submitBtn').disabled=!config;$('submitBtn').textContent='提交审阅并生成报告';}
  function render(job){
    const recovery=job.anchor?.tx_hash && ['anchor_failed','interrupted'].includes(job.status)?' · 已有广播交易，将继续查询恢复状态':'';
    setStatus((job.mode==='demo'?'预设演示 · 不发链 · ':'真实模式 · ')+(C.statuses[job.status]||job.status)+recovery+(job.error?'：'+job.error.message:''));
    const models=job.payload?.models||job.results||[];
    let html='<div class="card"><div class="small-note">任务 '+C.escape(job.job_id)+'</div>';
    for(const model of models){const verdict=C.getVerdict(model.verdict);html+='<div class="model-card"><div class="model-header"><div class="model-name">'+C.escape(model.provider)+'</div><div class="verdict-badge verdict-'+verdict.className+'">'+verdict.text+'</div></div><div class="small-note">'+C.escape(model.requested_model||'未配置模型')+' · '+C.escape(model.status==='failed'?'调用失败':model.status==='succeeded'?'已完成':'处理中')+'</div><div class="reason">'+C.escape(model.reason||model.error_code||'等待结果…')+'</div></div>';}
    if(job.payload){const result=C.getAgreement(job.payload.agreement);html+='<div class="agreement-banner '+result.className+'">'+result.text+'</div><p class="small-note">意见一致不代表内容真实。'+(job.mode==='demo'?'本演示报告没有链上凭证，可导出并复算离线指纹。':'只有确认的链上记录才会附加凭证。')+'</p><a class="cert-button" href="'+C.escape(C.certHref(job))+'">'+(job.proof?'查看存证报告 #'+C.escape(job.proof.certificate_id):'查看 / 导出报告')+'</a> ';}
    if(job.anchor?.tx_hash){const href=C.explorerLink(config,job.anchor.tx_hash);html+='<div class="small-note">广播交易：'+C.escape(job.anchor.tx_hash)+(href?' <a href="'+C.escape(href)+'" target="_blank" rel="noopener noreferrer">查看交易 ↗</a>':'')+'</div>';}
    html+='<a class="cert-button secondary-link" href="/screen.html?job='+encodeURIComponent(job.job_id)+'" target="_blank" rel="noopener">打开实时大屏 ↗</a></div>';$('resultsArea').innerHTML=html;
    if(C.isFinished(job))release();
  }
  $('scenarioInput').addEventListener('change',()=>{$('contentInput').value=samples[$('scenarioInput').value];});
  document.querySelectorAll('[data-scenario]').forEach(button=>button.addEventListener('click',()=>{$('scenarioInput').value=button.dataset.scenario;$('contentInput').value=samples[button.dataset.scenario];}));
  $('submitForm').addEventListener('submit',async event=>{
    event.preventDefault();if(submitting)return;
    const content=$('contentInput').value;
    if(!content.trim()){setStatus('请先输入待审阅文字。',true);$('contentInput').focus();return;}
    if(content.length>12000){setStatus('本页输入上限为 12000 字符。',true);return;}
    if(!config){setStatus('请先连接 A 后端服务。',true);return;}
    stopWatch?.();submitting=true;$('submitBtn').disabled=true;$('submitBtn').textContent='正在创建任务…';$('resultsArea').replaceChildren();setStatus('正在提交原文…');
    try{
      const data=await C.request('/api/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
      if(!data.job_id)throw new Error('服务未返回任务编号');
      try{localStorage.setItem('crosscheck.latestJob',data.job_id);}catch{}
      setStatus(data.reused?'已复用相同内容和配置的任务，正在读取最新状态。':'任务已创建，正在读取模型结果。');
      stopWatch=C.watchJob(data.job_id,render,error=>setStatus('连接暂时中断，将继续查询：'+error.message,true));
    }catch(error){setStatus(error.message,true);release();}
  });
  $('submitBtn').disabled=true;
  Promise.all([C.request('/api/config'),C.health().catch(()=>null)]).then(([value,status])=>{
    config=value;$('environment').textContent=C.modeLabel(value,status);$('serverMode').textContent=value.mode==='demo'?'预设演示（由服务器配置；不调用真实模型、不广播交易）':'真实双模型模式（由服务器配置）';
    $('scenarioGroup').hidden=value.mode!=='demo';$('modeExplanation').textContent=value.mode==='demo'?'选择样例会把 [demo:agree] / [demo:disagree] / [demo:unable] 前缀明确写入原文。它属于提交内容，不会被隐藏或删除。':'当前为真实模式。提交只包含原文；模型 Key、模式与链配置由服务器管理。';
    if(value.mode==='demo' && !$('contentInput').value)$('contentInput').value=samples.agreement;
    C.renderShare($('submitShare'),'/submit.html',value,'用手机提交审阅');release();
  }).catch(error=>{setStatus('连接 A 服务失败：'+error.message,true);$('environment').textContent='未连接 A 后端';});
  window.addEventListener('pagehide',()=>stopWatch?.());
})();
