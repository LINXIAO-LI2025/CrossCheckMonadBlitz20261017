/* Browser orchestration only. A's @crosscheck/protocol is the sole schema/hash implementation. */
window.CrossCheck = (() => {
  'use strict';
  const protocol = window.CrossCheckProtocol;
  if (!protocol) throw new Error('共享协议未加载，请先构建 /vendor/protocol.js');
  const terminal = new Set(['confirmed', 'failed', 'anchor_failed', 'interrupted']);
  const verdicts = {
    credible: { text: '✅ 可信', className: 'credible' },
    questionable: { text: '⚠️ 存疑', className: 'questionable' },
    not_credible: { text: '❌ 不可信', className: 'not_credible' },
    unable_to_determine: { text: '❓ 无法判断', className: 'unable_to_determine' }
  };
  const statuses = {queued:'排队中',running:'双模型处理中',report_ready:'报告已生成',anchoring:'等待链上确认',confirmed:'报告已写入链上',failed:'审核失败',anchor_failed:'报告保留，存证未确认',interrupted:'任务处理中断'};
  const agreement = {0:{text:'双模型意见一致',className:'agree'},1:{text:'双模型意见分歧 · 建议人工复核',className:'disagree'},2:{text:'至少一个模型无法判断 · 需要更多信息',className:'uncertain'}};
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path, options) {
    const response = await fetch(path,{cache:'no-store',...options});
    let data;try {data=await response.json();}catch {throw new Error('服务未返回有效 JSON，请确认 A 服务和网页代理已启动');}
    if (!response.ok) {const error=new Error(data?.error?.message || data?.message || `请求失败 (${response.status})`);error.code=data?.error?.code;error.status=response.status;throw error;}
    if(path==='/api/config') {
      const core=Object.fromEntries(['mode','public_origin','chain_id','contract_address','deployment_block','issuer','explorer_tx_base_url'].map(key=>[key,data[key]]));
      return {...data,...protocol.publicConfigSchema.parse(core)};
    }
    return data;
  }
  async function health() {
    const response=await fetch('/api/health',{cache:'no-store'}),value=await response.json();
    if (!value || typeof value.models_ready!=='boolean') throw new Error('健康接口响应无效');
    return value;
  }
  const validatePayload = value => protocol.validateReportPayload(value);
  const validateReport = value => protocol.validateReportEnvelope(value);
  function hashes(value) {const payload=validatePayload(value);return {content_hash:protocol.hashContent(payload.raw_text),verdict_hash:protocol.hashPayload(payload)};}
  const isFinished = job => terminal.has(job.status) || (job.status==='report_ready' && job.mode==='demo');
  const needsRecovery = job => ['anchor_failed','interrupted','anchoring'].includes(job.status) && !!job.anchor?.tx_hash;
  function watchJob(id,onJob,onError) {
    let closed=false,timer=null,source=null,fetching=false,refreshQueued=false;
    const stop=()=>{closed=true;clearTimeout(timer);source?.close();source=null;};
    async function refresh() {
      if(closed)return;
      if(fetching){refreshQueued=true;return;}
      clearTimeout(timer);fetching=true;
      let latest=null;
      try {latest=await request('/api/jobs/'+encodeURIComponent(id));if(!closed)onJob(latest);}
      catch(error){if(!closed)onError(error);}
      finally {
        fetching=false;
        // Only the fetched latest job decides finality; an earlier replayed done is never authoritative.
        if(latest && isFinished(latest) && !needsRecovery(latest)){stop();return;}
        if(!closed){const delay=refreshQueued?0:(latest && needsRecovery(latest)?4000:1800);refreshQueued=false;timer=setTimeout(refresh,delay);}
      }
    }
    if(window.EventSource){
      source=new EventSource('/api/stream/'+encodeURIComponent(id));
      const changed=event=>{try{const data=JSON.parse(event.data);if(data.job_id===id)refresh();}catch(error){if(!closed)onError(error);}};
      for(const name of ['job_status','model_result','model_error','report_ready','anchor_submitted','anchor_confirmed','anchor_error','done','model_delta'])source.addEventListener(name,changed);
      // Polling continues after a terminal stream closes, allowing late recovery without replay loops.
      source.onerror=()=>{source?.close();source=null;};
    }
    refresh();return stop;
  }
  const getVerdict = value => Object.prototype.hasOwnProperty.call(verdicts,value)?verdicts[value]:{text:'⏳ 等待结果',className:'unable_to_determine'};
  const getAgreement = value => Object.prototype.hasOwnProperty.call(agreement,value)?agreement[value]:{text:'审核尚未完成',className:'uncertain'};
  function certHref(job) {const query=new URLSearchParams({job:job.job_id});if(job.proof?.certificate_id!=null)query.set('id',String(job.proof.certificate_id));return '/cert.html?'+query.toString();}
  function download(report) {const href=URL.createObjectURL(new Blob([JSON.stringify(validateReport(report),null,2)],{type:'application/json'})),anchor=document.createElement('a');anchor.href=href;anchor.download='crosscheck-'+String(report.proof?.certificate_id || report.payload.job_id).replace(/[^a-zA-Z0-9_-]/g,'-')+'.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(href),1000);}
  function modeLabel(config,status) {
    if(!config)return '尚未连接服务';
    const mode=config.mode==='demo'?'预设演示 · 不调用模型，不发链':(status?.models_ready===false?'真实模式 · 模型尚未配置':'真实双模型 API 模式');
    const chain=config.chain_id===31337?'本地开发链 · 非 Monad':config.contract_address?'已配置链 '+config.chain_id+' · 凭证需单独核验':'尚无已知链部署';
    return mode+' ｜ '+chain+(status?.storage_ready===false?' ｜ 报告存储不可用':'');
  }
  function explorerLink(config,txHash) {
    if(!/^0x[0-9a-fA-F]{64}$/.test(txHash || '') || !config?.explorer_tx_base_url)return null;
    try {const base=new URL(config.explorer_tx_base_url);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)return null;base.search='';base.hash='';base.pathname=base.pathname.replace(/\/$/,'')+'/'+txHash;return base.href;}catch{return null;}
  }
  async function readAndCompare(report,config,rpcUrl) {
    report=validateReport(report);if(!report.proof)throw new Error('报告没有链上凭证');
    if(!window.CrossCheckChain)throw new Error('浏览器链读取模块尚未加载');
    const proof=report.proof,record=await window.CrossCheckChain.readCertificateByTransaction(proof.tx_hash,proof.certificate_id,{...config,rpc_url:rpcUrl});
    protocol.certificateRecordSchema.parse(record);
    const computed=hashes(report.payload),errors=[];
    for(const field of ['content_hash','verdict_hash'])if(record[field].toLowerCase()!==computed[field].toLowerCase())errors.push(field==='content_hash'?'原文指纹不符':'完整报告指纹不符（包括嵌套模型理由）');
    if(record.agreement!==report.payload.agreement)errors.push('意见一致性不符');
    for(const field of ['chain_id','certificate_id','block_number','block_time'])if(record.proof[field]!==proof[field])errors.push('proof.'+field+'不符');
    for(const field of ['contract_address','issuer','tx_hash'])if(record.proof[field].toLowerCase()!==proof[field].toLowerCase())errors.push('proof.'+field+'不符');
    if(errors.length)throw new Error(errors.join('；'));return record;
  }
  function renderShare(container,path,config,title='手机扫码打开') {
    let origin=location.origin;
    const isLoopback=hostname=>hostname==='localhost'||hostname.endsWith('.localhost')||/^127\./.test(hostname)||hostname==='[::1]';
    try {
      const supplied=new URL(config?.public_origin || origin);
      // A's default localhost public_origin must not replace a reachable LAN page origin.
      // An explicitly configured non-loopback public origin remains authoritative.
      if(['http:','https:'].includes(supplied.protocol)&&!supplied.username&&!supplied.password&&!isLoopback(supplied.hostname))origin=supplied.origin;
    }catch{}
    const url=new URL(path,origin).href;container.replaceChildren();
    const image=document.createElement('img');image.width=176;image.height=176;image.alt=title+'二维码';image.src='/api/qr?text='+encodeURIComponent(url);
    const detail=document.createElement('div');detail.className='share-details';
    const heading=document.createElement('div');heading.className='card-title';heading.textContent=title;
    const anchor=document.createElement('a');anchor.href=url;anchor.textContent=url;
    const note=document.createElement('p');note.className='small-note';note.textContent=['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)?'当前链接指向本机。手机与电脑连接同一 Wi-Fi，并用电脑局域网地址打开网页后扫码。':'扫码设备需要能访问该地址；局域网地址需与电脑连接同一 Wi-Fi。';
    detail.append(heading,anchor,note);container.append(image,detail);
  }
  return {protocol,escape,request,health,canonicalize:protocol.canonicalizeJson,hashes,validatePayload,validateReport,watchJob,terminal,isFinished,getVerdict,getAgreement,certHref,download,statuses,modeLabel,renderShare,explorerLink,readAndCompare};
})();
