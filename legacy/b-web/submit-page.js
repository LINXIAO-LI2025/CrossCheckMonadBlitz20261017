'use strict';
(() => {
  const C = CrossCheck, $ = id => document.getElementById(id);
  let stopWatch = null, config = null, submitting = false;
  const samples = {
    agreement: '演示声明：本报告的数据仅用于演示，不包含真实模型审核结论。',
    disagreement: '演示声明：我们的 AI 产品准确率达到 99.9%，已服务全球 10 亿用户。',
    unable: '演示声明：某未公开项目明年将实现显著增长，目前没有可核对的资料。'
  };
  function setStatus(text, error = false) {
    $('statusArea').innerHTML = '<div class="' + (error ? 'error-card' : 'status-card') + '"><div class="status-text">' + C.escape(text) + '</div></div>';
  }
  function release() { submitting = false; $('submitBtn').disabled = false; $('submitBtn').textContent = '提交审阅并生成报告'; }
  function render(job) {
    setStatus((job.mode === 'demo' ? '预设演示 · ' : '真实 API · ') + (C.statuses[job.status] || job.status) + (job.error ? '：' + job.error.message : ''));
    const models = job.payload?.models || job.results || [];
    let html = '<div class="card"><div class="small-note">任务 ' + C.escape(job.job_id) + '</div>';
    for (const model of models) {
      const verdict = C.getVerdict(model.verdict);
      html += '<div class="model-card"><div class="model-header"><div class="model-name">' + C.escape(model.provider) + '</div><div class="verdict-badge verdict-' + verdict.className + '">' + verdict.text + '</div></div><div class="small-note">' + C.escape(model.requested_model) + ' · ' + C.escape(model.status === 'failed' ? '调用失败' : model.status === 'succeeded' ? '已完成' : '处理中') + '</div><div class="reason">' + C.escape(model.reason || model.error_code || '等待分析结果…') + '</div></div>';
    }
    if (job.payload) {
      const result = C.getAgreement(job.payload.agreement);
      html += '<div class="agreement-banner ' + result.className + '">' + result.text + '</div><p class="small-note">意见一致性与内容判断分别展示；一致不代表内容真实。</p>';
      html += '<a class="cert-button" href="' + C.escape(C.certHref(job)) + '">' + (job.proof ? '查看存证报告 #' + C.escape(job.proof.certificate_id) : '查看报告 / 等待存证') + '</a> ';
    }
    html += '<a class="cert-button secondary-link" href="/screen.html?job=' + encodeURIComponent(job.job_id) + '" target="_blank" rel="noopener">打开实时大屏 ↗</a></div>';
    $('resultsArea').innerHTML = html;
    if (C.isFinished(job, config)) release();
  }
  $('modeInput').addEventListener('change', () => {
    $('scenarioGroup').hidden = $('modeInput').value !== 'demo';
    $('modeExplanation').textContent = $('modeInput').value === 'demo' ? '演示结果由所选预设样例生成；输入文字不会接受真实模型审核。' : '将实际调用后端配置的两家模型；调用可能失败，失败会保留在报告中。';
  });
  $('scenarioInput').addEventListener('change', () => { $('contentInput').value = samples[$('scenarioInput').value]; });
  document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
    $('scenarioInput').value = button.dataset.scenario;
    $('contentInput').value = samples[button.dataset.scenario];
  }));
  $('submitForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const content = $('contentInput').value;
    if (!content.trim()) { setStatus('请先输入待审阅文字。', true); $('contentInput').focus(); return; }
    if (content.length > 10000) { setStatus('文字过长，请将本次内容控制在 10000 字符内。', true); return; }
    stopWatch?.(); submitting = true; $('submitBtn').disabled = true; $('submitBtn').textContent = '正在创建任务…';
    $('resultsArea').replaceChildren(); setStatus('正在提交…');
    try {
      const mode = $('modeInput').value;
      if (mode === 'live' && !config?.liveAvailable) throw new Error('后端尚未配置真实模型 API，请使用预设演示。');
      const data = await C.request('/api/verify', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content, mode, scenario:$('scenarioInput').value})});
      if (!data.job_id) throw new Error('服务未返回任务编号');
      stopWatch = C.watchJob(data.job_id, render, error => setStatus('连接暂时中断，将继续查询：' + error.message, true), config);
    } catch (error) { setStatus(error.message, true); release(); }
  });
  $('contentInput').value = samples.agreement;
  C.request('/api/config').then(value => {
    config = value; $('environment').textContent = C.modeLabel(value);
    $('liveOption').disabled = !value.liveAvailable;
    if (value.liveAvailable) $('liveOption').textContent = '真实双模型 API';
    C.renderShare($('submitShare'), '/submit.html', value, '用手机提交审阅');
  }).catch(error => { $('environment').textContent = '连接服务失败：' + error.message; });
  window.addEventListener('pagehide', () => stopWatch?.());
})();
