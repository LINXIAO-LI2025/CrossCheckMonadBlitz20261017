'use strict';
(() => {
  const C = CrossCheck, root = document.getElementById('mainContent');
  let stopWatch = null, latestTimer = null, currentId = null, closed = false, config = null;
  const fixedId = new URLSearchParams(location.search).get('job');
  function render(job) {
    const models = job.payload?.models || job.results || [];
    const agreement = C.getAgreement(job.payload?.agreement);
    const panels = ['a', 'b'].map((slot, index) => {
      const model = models.find(item => item.slot === slot) || models[index];
      const verdict = C.getVerdict(model?.verdict);
      return '<section class="panel"><div class="panel-glow"></div><div class="panel-content"><div class="panel-header"><div class="model-info"><div class="model-avatar">' + (index ? '🧠' : '🤖') + '</div><div class="model-details"><h2>' + C.escape(model?.provider || '模型 ' + slot.toUpperCase()) + '</h2><div class="model-version">' + C.escape(model?.requested_model || '等待调用') + '</div></div></div><div class="process-status">' + C.escape(model?.status === 'succeeded' ? '分析完成' : model?.status === 'failed' ? '调用失败' : '处理中') + '</div></div><div class="verdict-display"><div class="verdict-label">模型判断</div><div class="verdict-value verdict-' + verdict.className + '">' + verdict.text + '</div></div><div class="reason-box"><div class="reason-label">' + (job.mode === 'demo' ? '预设演示理由（非真实 API）' : '分析理由') + '</div><div class="reason-text">' + C.escape(model?.reason || model?.error_code || '等待分析结果…') + '</div></div></div></section>';
    }).join('');
    root.innerHTML = '<div class="screen-context"><span>' + C.escape(job.mode === 'demo' ? '预设样例演示 · 无真实模型调用' : '真实模型 API 模式') + '</span><span>任务 ' + C.escape(job.job_id) + '</span></div><div class="panels">' + panels + '</div><footer class="footer"><div class="result-banner result-' + agreement.className + '">' + C.escape(agreement.text) + '</div><div class="footer-meta"><span>' + C.escape(C.statuses[job.status] || job.status) + (job.proof ? ' · 凭证 #' + C.escape(job.proof.certificate_id) : '') + '</span>' + (job.payload ? '<a href="' + C.escape(C.certHref(job)) + '">打开报告与核验 ↗</a>' : '') + '</div><div class="screen-disclaimer">存证固定报告指纹；不证明内容真实，不代表模型厂商签名。</div></footer>';
  }
  function attach(id) {
    if (currentId === id) return;
    stopWatch?.(); currentId = id;
    stopWatch = C.watchJob(id, render, error => { document.getElementById('screenConnection').textContent = '连接异常：' + error.message; }, config);
    document.getElementById('screenConnection').textContent = fixedId ? '指定任务' : '跟随最新任务';
  }
  async function followLatest() {
    if (closed) return;
    try {
      const job = await C.request('/api/jobs/latest');
      if (job?.job_id) { if (job.job_id !== currentId) { attach(job.job_id); render(job); } }
      else if (!currentId) root.innerHTML = '<div class="waiting-state"><div class="waiting-icon">⏳</div><div class="waiting-text">等待第一份审阅任务</div><a class="screen-link" href="/submit.html">前往提交页</a></div>';
    } catch (error) { document.getElementById('screenConnection').textContent = '连接异常：' + error.message; }
    finally { if (!closed) latestTimer = setTimeout(followLatest, 3000); }
  }
  C.request('/api/config').then(value => { config = value; document.getElementById('screenEnvironment').textContent = C.modeLabel(value); C.renderShare(document.getElementById('screenSubmitShare'), '/submit.html', value, '扫码提交，现场看结果'); }).catch(() => { document.getElementById('screenEnvironment').textContent = '未读取到环境配置'; }).finally(() => { if (fixedId) attach(fixedId); else followLatest(); });
  window.addEventListener('pagehide', () => { closed = true; stopWatch?.(); clearTimeout(latestTimer); });
})();
