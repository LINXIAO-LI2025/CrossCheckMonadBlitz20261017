'use strict';
Promise.all([CrossCheck.request('/api/config'),CrossCheck.health().catch(()=>null)]).then(([config,health])=>{
  document.getElementById('environment').textContent=CrossCheck.modeLabel(config,health);
  document.getElementById('contractStatus').textContent=config.contract_address?'已配置 · '+config.contract_address:'未部署';
  document.getElementById('backendStatus').textContent=(config.backend_mode==='a-integrated'?'A 服务已连接':'服务已连接')+' · '+(config.mode==='demo'?'演示不调用模型、不发链':health?.models_ready?'模型已就绪':'模型尚未配置');
  document.getElementById('chainStatus').textContent=config.mode==='demo'?'演示不广播；'+(config.chain_id?'已知链 '+config.chain_id:'无已知链'):health?.chain_ready?'链已就绪 · '+config.chain_id:'链尚未就绪';
}).catch(error=>{document.getElementById('environment').textContent='尚未连接 A 服务：'+error.message;document.getElementById('backendStatus').textContent='未连接，请启动 A 服务或检查网页代理';});
