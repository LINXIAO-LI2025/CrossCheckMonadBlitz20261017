'use strict';
(() => {
  const C = CrossCheck, $ = id => document.getElementById(id);
  let currentReport = null, currentHashes = null, config = null, stopWatch = null, verifying = false, lastRendered = '';
  const params = new URLSearchParams(location.search), id = params.get('id'), jobId = params.get('job');
  const eventABI = ['event Certified(uint256 indexed id, address indexed issuer, bytes32 contentHash, bytes32 verdictHash, uint8 agreement, uint256 timestamp)'];
  function normalizedReport(value) {
    const report = value?.report || value;
    if (!report || typeof report !== 'object' || !('payload' in report)) throw new Error('文件须包含 payload 和 proof');
    C.validatePayload(report.payload);
    if (!('proof' in report)) throw new Error('报告缺少 proof 字段（未上链时应为 null）');
    return { payload: report.payload, proof: report.proof };
  }
  function showInfo(text, error = false) {
    $('certContent').innerHTML = '<div class="card"><div class="card-title">' + (error ? '暂时无法读取' : '报告凭证') + '</div><p class="value">' + C.escape(text) + '</p><a href="/submit.html">前往提交页</a></div>';
  }
  function showResult(text, type = 'pending') {
    $('verifyResult').className = 'verify-result ' + type;
    $('verifyResult').textContent = text;
  }
  function render(report, serverHashes) {
    const normalized = normalizedReport(report), signature = JSON.stringify(normalized);
    if (signature === lastRendered) return;
    currentReport = normalized; currentHashes = C.hashes(currentReport.payload); lastRendered = signature;
    const {payload, proof} = currentReport, agreement = C.getAgreement(payload.agreement);
    const models = payload.models.map(model => {
      const verdict = C.getVerdict(model.verdict);
      return '<div class="model-card"><div class="model-name">' + C.escape(model.provider) + '</div><div class="small-note">' + C.escape(model.requested_model) + ' · 返回模型：' + C.escape(model.returned_model || '无') + '</div><div class="verdict-display"><div class="verdict-text">' + verdict.text + '</div></div><div class="reason">' + C.escape(model.reason || model.error_code || '未返回理由') + '</div></div>';
    }).join('');
    const proofHtml = proof ? '<div class="card"><div class="card-title">链上定位信息（待浏览器核验）</div><div class="blockchain-info"><div class="info-item"><div class="label">链 ID</div><div class="value">' + C.escape(proof.chain_id) + '</div></div><div class="info-item"><div class="label">区块号</div><div class="value">' + C.escape(proof.block_number) + '</div></div><div class="info-item"><div class="label">凭证号</div><div class="value">' + C.escape(proof.certificate_id) + '</div></div></div><div class="label">合约地址</div><div class="value hash">' + C.escape(proof.contract_address) + '</div><div class="label">提交地址</div><div class="value hash">' + C.escape(proof.issuer) + '</div><div class="label">交易哈希</div><div class="value hash">' + C.escape(proof.tx_hash) + '</div></div>' : '<div class="card"><div class="card-title">尚无链上凭证</div><p class="value">报告可以下载，尚不能验证链上锚定。请等待存证完成或查看任务状态。</p></div>';
    $('certContent').innerHTML = '<div class="card"><div class="cert-id">' + (proof ? '#' + C.escape(proof.certificate_id) : '报告已生成') + '</div><div class="agreement-badge agreement-' + payload.agreement + '">' + agreement.text + '</div><div class="mode-notice">' + (payload.mode === 'demo' ? '预设样例演示：未调用真实模型 API。' : '真实 API 模式：报告由发布者记录，不是模型厂商签名。') + '</div><div class="small-note">任务 ' + C.escape(payload.job_id) + ' · ' + C.escape(payload.completed_at) + '</div></div><div class="card"><div class="card-title">双模型审阅结果</div><div class="model-results">' + models + '</div></div><div class="card"><div class="card-title">原文内容</div><div class="content-preview">' + C.escape(payload.raw_text) + '</div></div><div class="card"><div class="card-title">浏览器复算指纹</div><div class="label">内容指纹（包含原文全部字符）</div><div class="value hash">' + C.escape(currentHashes.content_hash) + '</div><div class="label">完整 payload 指纹（含全部模型字段）</div><div class="value hash">' + C.escape(currentHashes.verdict_hash) + '</div><div class="small-note">指纹已复算，链上是否匹配请执行下方核验。</div></div>' + proofHtml + '<button id="downloadReport" class="success">下载完整报告 JSON</button>';
    $('downloadReport').addEventListener('click', () => C.download(currentReport));
    if (proof && config?.chainMode !== 'local' && config?.explorerUrl && /^0x[0-9a-fA-F]{64}$/.test(proof.tx_hash || '')) {
      try {
        const explorer = new URL(config.explorerUrl);
        if (['http:', 'https:'].includes(explorer.protocol) && !explorer.username && !explorer.password) {
          explorer.search = ''; explorer.hash = '';
          explorer.pathname = explorer.pathname.replace(/\/$/, '') + '/tx/' + proof.tx_hash;
          const explorerLink = document.createElement('a'); explorerLink.href = explorer.href;
          explorerLink.textContent = '在区块浏览器查看交易'; explorerLink.target = '_blank'; explorerLink.rel = 'noopener noreferrer';
          explorerLink.className = 'explorer-link'; $('certContent').append(explorerLink);
        }
      } catch { /* Invalid explorer configuration does not create an outbound link. */ }
    }
    const shareQuery = new URLSearchParams({job:payload.job_id});
    if (proof) shareQuery.set('id', String(proof.certificate_id));
    const shareSection = document.createElement('section'); shareSection.className = 'card report-share';
    C.renderShare(shareSection, '/cert.html?' + shareQuery.toString(), config, '打开同一份报告');
    const shareNote = document.createElement('p'); shareNote.className = 'small-note'; shareNote.textContent = '导入的 JSON 只在当前浏览器处理；二维码查询服务已保存的报告，不会上传文本框或本地文件。';
    shareSection.querySelector('.share-details').append(shareNote);
    $('certContent').append(shareSection);
    $('reportJson').value = JSON.stringify(currentReport, null, 2);
    $('verifyCurrent').disabled = false; $('tamperSample').disabled = false;
    if (serverHashes && (serverHashes.content_hash !== currentHashes.content_hash || serverHashes.verdict_hash !== currentHashes.verdict_hash)) showResult('报告与服务器提供的指纹不同；请检查报告来源。', 'error');
    else showResult('已在浏览器复算完整报告。尚未查询链上交易，请点击“从 RPC 核验当前报告”。');
  }
  async function load() {
    try {
      if (id) {
        try { const data = await C.request('/api/cert/' + encodeURIComponent(id)); render(data.report, data.hashes); return; }
        catch (error) { if (!jobId) throw error; }
      }
      if (jobId) {
        const data = await C.request('/api/reports/' + encodeURIComponent(jobId)).catch(() => null);
        if (data?.report?.payload) render(data.report, data.hashes);
        stopWatch = C.watchJob(jobId, job => {
          if (job.payload) {
            render({payload:job.payload, proof:job.proof || null}, job.hashes);
            if (job.proof && !params.get('id')) {
              params.set('id', String(job.proof.certificate_id)); history.replaceState(null, '', '?' + params.toString());
            }
          } else showInfo((C.statuses[job.status] || job.status) + (job.error ? '：' + job.error.message : '；报告生成后会自动展示。'));
        }, error => { $('loadNotice').textContent = '更新失败，将继续查询：' + error.message; }, config);
      } else showInfo('从提交结果打开凭证，或在下方导入一份 JSON 报告进行复算。');
    } catch (error) { showInfo(error.message, true); }
  }
  function validConfig(value) {
    if (!value || !Number.isSafeInteger(Number(value.chainId)) || Number(value.chainId) <= 0 || !ethers.isAddress(value.contractAddress) || !ethers.isAddress(value.issuerAddress) || value.contractAddress.toLowerCase() === ethers.ZeroAddress || value.issuerAddress.toLowerCase() === ethers.ZeroAddress) throw new Error('服务未提供可用的预期链、合约及提交地址；不能判定链上核验通过');
    return value;
  }
  function sameAddress(left, right) { return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase(); }
  function bigint(value, name) {
    if (!/^\d+$/.test(String(value))) throw new Error(name + ' 格式无效');
    return BigInt(value);
  }
  async function verify(report) {
    if (verifying) return;
    verifying = true; $('verifyCurrent').disabled = true; $('verifyPasted').disabled = true;
    let provider = null;
    try {
      report = normalizedReport(report);
      const calculated = C.hashes(report.payload), proof = report.proof;
      $('computedHashes').textContent = '内容：' + calculated.content_hash + '\n完整报告：' + calculated.verdict_hash;
      if (!proof) throw new Error('已复算报告，但 proof 为 null：没有可核对的链上记录。');
      showResult('指纹已复算，正在由浏览器直接查询指定 RPC 的交易回执…');
      config = validConfig(await C.request('/api/config'));
      $('expectedConfig').textContent = '预期链 ' + config.chainId + ' ｜ 合约 ' + config.contractAddress + ' ｜ 提交地址 ' + config.issuerAddress;
      if (bigint(proof.chain_id, '链 ID') !== BigInt(config.chainId)) throw new Error('报告链 ID 与预期网络不符');
      if (!sameAddress(proof.contract_address, config.contractAddress)) throw new Error('报告合约与预期合约不符，拒绝核验');
      if (!sameAddress(proof.issuer, config.issuerAddress)) throw new Error('报告提交地址与预期地址不符');
      if (!/^0x[0-9a-fA-F]{64}$/.test(proof.tx_hash || '')) throw new Error('交易哈希格式无效');
      const certificateId = bigint(proof.certificate_id, '凭证号');
      if (certificateId <= 0n) throw new Error('凭证号必须大于零');
      const inputUrl = $('rpcInput').value.trim();
      if (!inputUrl) throw new Error('请填写可访问的 RPC 地址');
      const rpcUrl = new URL(inputUrl, location.href);
      if (!['http:', 'https:'].includes(rpcUrl.protocol)) throw new Error('RPC 地址须使用 http 或 https');
      const connection = new ethers.FetchRequest(rpcUrl.href); connection.timeout = 12000;
      provider = new ethers.JsonRpcProvider(connection, undefined, {batchMaxCount:1});
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(config.chainId)) throw new Error('RPC 返回的网络与预期链 ID 不符');
      const receipt = await provider.getTransactionReceipt(proof.tx_hash);
      if (!receipt || receipt.status !== 1) throw new Error('RPC 未找到成功的交易回执');
      if (!sameAddress(receipt.to, config.contractAddress)) throw new Error('交易目标不是预期存证合约');
      if (!sameAddress(receipt.from, config.issuerAddress)) throw new Error('交易发送者不是预期提交地址');
      if (BigInt(receipt.blockNumber) !== bigint(proof.block_number, '区块号')) throw new Error('报告区块号与交易回执不符');
      if (config.deploymentBlock != null && BigInt(receipt.blockNumber) < BigInt(config.deploymentBlock)) throw new Error('交易早于配置的合约部署区块');
      const iface = new ethers.Interface(eventABI);
      const matches = [];
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, config.contractAddress)) continue;
        try { const parsed = iface.parseLog(log); if (parsed?.name === 'Certified' && parsed.args.id === certificateId) matches.push(parsed); } catch { /* Other events are irrelevant. */ }
      }
      if (matches.length !== 1) throw new Error('该交易中未找到唯一的指定合约 Certified 凭证事件');
      const event = matches[0].args;
      if (!sameAddress(event.issuer, config.issuerAddress)) throw new Error('事件提交地址与预期地址不符');
      if (event.contentHash.toLowerCase() !== calculated.content_hash.toLowerCase()) throw new Error('内容指纹不匹配：原文可能被修改');
      if (event.verdictHash.toLowerCase() !== calculated.verdict_hash.toLowerCase()) throw new Error('完整报告指纹不匹配：模型理由、判断或其他字段可能被修改');
      if (Number(event.agreement) !== report.payload.agreement) throw new Error('一致性字段与链上事件不符');
      const block = await provider.getBlock(receipt.blockHash);
      if (!block || BigInt(block.timestamp) !== bigint(proof.block_time, '区块时间') || event.timestamp !== BigInt(block.timestamp)) throw new Error('报告时间与链上区块或事件时间不符');
      const chainLabel = config.chainMode === 'local' ? '本地开发链（非 Monad）' : '链 ID ' + config.chainId;
      showResult('核验通过：完整 payload 指纹与指定合约的链上事件一致。\n' + chainLabel + ' · 凭证 #' + certificateId + ' · 区块 ' + receipt.blockNumber + '\n这证明报告与存证记录相符；不证明内容真实，也不证明模型厂商签署了报告。', 'success');
    } catch (error) { showResult('未通过链上核验：' + error.message, 'error'); }
    finally { provider?.destroy(); verifying = false; $('verifyCurrent').disabled = !currentReport; $('verifyPasted').disabled = false; }
  }
  $('verifyCurrent').addEventListener('click', () => currentReport && verify(currentReport));
  $('verifyPasted').addEventListener('click', () => {
    try { verify(JSON.parse($('reportJson').value)); } catch (error) { showResult('JSON 无法解析：' + error.message, 'error'); }
  });
  $('fileInput').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请检查是否为报告 JSON');
      const report = normalizedReport(JSON.parse(await file.text()));
      stopWatch?.(); render(report); await verify(report);
    } catch (error) { showResult('导入失败：' + error.message, 'error'); }
  });
  $('tamperSample').addEventListener('click', () => {
    if (!currentReport) return;
    const modified = JSON.parse(JSON.stringify(currentReport));
    modified.payload.models[0].reason = (modified.payload.models[0].reason || '') + '【此理由已修改，用于篡改检测演示】';
    $('reportJson').value = JSON.stringify(modified, null, 2);
    showResult('已在下方载入只修改嵌套模型理由的样例，原报告未变。点击“核验文本框中的报告”，应出现完整报告指纹不匹配。');
  });
  C.request('/api/config').then(value => {
    config = value; $('environment').textContent = C.modeLabel(value);
    $('rpcInput').value = value.rpcUrl || '/rpc';
    $('expectedConfig').textContent = '预期链 ' + (value.chainId || '未配置') + ' ｜ 合约 ' + (value.contractAddress || '未部署') + ' ｜ 提交地址 ' + (value.issuerAddress || '未配置');
  }).catch(error => { $('environment').textContent = '无法读取配置：' + error.message; }).finally(load);
  window.addEventListener('pagehide', () => stopWatch?.());
})();

