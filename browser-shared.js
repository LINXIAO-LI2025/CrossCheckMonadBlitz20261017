/* Shared browser helpers. No model output is inserted as trusted HTML. */
window.CrossCheck = (() => {
  'use strict';
  const terminal = new Set(['confirmed', 'failed', 'anchor_failed', 'interrupted']);
  const verdicts = {
    credible: { text: '✅ 可信', className: 'credible' },
    questionable: { text: '⚠️ 存疑', className: 'questionable' },
    not_credible: { text: '❌ 不可信', className: 'not_credible' },
    unable_to_determine: { text: '❓ 无法判断', className: 'unable_to_determine' }
  };
  const statuses = {
    queued: '排队中', running: '双模型处理中', report_ready: '报告已生成',
    anchoring: '写入存证中', confirmed: '报告已写入链上',
    failed: '审核失败', anchor_failed: '报告已生成，上链失败', interrupted: '任务因服务重启中断'
  };
  const agreement = {
    0: { text: '双模型意见一致', className: 'agree' },
    1: { text: '双模型意见分歧 · 建议人工复核', className: 'disagree' },
    2: { text: '至少一个模型无法判断 · 需要更多信息', className: 'uncertain' }
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path, options) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error('服务未返回有效 JSON，请确认本地服务已启动'); }
    if (!response.ok) throw new Error(data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : `请求失败 (${response.status})`));
    return data;
  }
  function validUnicode(value) {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  }
  function canonicalize(value) {
    const ancestors = new Set();
    function visit(item) {
      if (item === null) return 'null';
      if (typeof item === 'string') { if (!validUnicode(item)) throw new Error('报告包含无效 Unicode 字符'); return JSON.stringify(item); }
      if (typeof item === 'boolean') return String(item);
      if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('报告包含非有限数值'); return JSON.stringify(item); }
      if (typeof item !== 'object') throw new Error('报告包含非 JSON 字段');
      if (ancestors.has(item)) throw new Error('报告包含循环引用');
      ancestors.add(item);
      try {
        if (Array.isArray(item)) {
          const values = [];
          for (let index = 0; index < item.length; index++) {
            if (!Object.prototype.hasOwnProperty.call(item, index)) throw new Error('报告包含稀疏数组');
            values.push(visit(item[index]));
          }
          return '[' + values.join(',') + ']';
        }
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('报告必须是普通 JSON 对象');
        if (Object.getOwnPropertySymbols(item).length) throw new Error('报告包含非 JSON 键');
        return '{' + Object.keys(item).sort().map(key => {
          if (!validUnicode(key)) throw new Error('报告包含无效 Unicode 键');
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!('value' in descriptor)) throw new Error('报告包含非 JSON 属性');
          return JSON.stringify(key) + ':' + visit(descriptor.value);
        }).join(',') + '}';
      } finally { ancestors.delete(item); }
    }
    return visit(value);
  }
  function hashes(payload) {
    if (!window.ethers) throw new Error('本地加密库尚未加载');
    validatePayload(payload);
    return {
      content_hash: ethers.keccak256(ethers.toUtf8Bytes(payload.raw_text)),
      verdict_hash: ethers.keccak256(ethers.toUtf8Bytes(canonicalize(payload)))
    };
  }
  function validatePayload(payload) {
    if (!payload || payload.schema_version !== '1' || typeof payload.raw_text !== 'string' || !payload.raw_text.trim() || typeof payload.job_id !== 'string') throw new Error('报告 payload 格式无效');
    if (!['demo', 'live'].includes(payload.mode) || ![0, 1, 2].includes(payload.agreement)) throw new Error('报告模式或一致性字段无效');
    if (!Array.isArray(payload.models) || payload.models.length !== 2 || new Set(payload.models.map(model => model?.slot)).size !== 2 || !payload.models.some(model => model?.slot === 'a') || !payload.models.some(model => model?.slot === 'b')) throw new Error('报告必须包含 a、b 两份模型结果');
    for (const model of payload.models) {
      for (const field of ['provider', 'requested_model', 'status']) if (typeof model[field] !== 'string') throw new Error('报告缺少模型字段：' + field);
      if (!['succeeded', 'failed'].includes(model.status)) throw new Error('模型状态无效');
      if (model.verdict !== null && !Object.prototype.hasOwnProperty.call(verdicts, model.verdict)) throw new Error('模型判断字段无效');
      for (const field of ['returned_model', 'verdict', 'reason', 'error_code']) if (!(field in model) || (model[field] !== null && typeof model[field] !== 'string')) throw new Error('模型字段无效：' + field);
    }
    return payload;
  }
  const isFinished = (job, config) => terminal.has(job.status) || (job.status === 'report_ready' && config?.chainMode === 'unconfigured');
  function watchJob(id, onJob, onError, config) {
    let closed = false, timer = null, source = null, fetching = false;
    const stop = () => { closed = true; clearTimeout(timer); source?.close(); };
    const receive = job => {
      if (closed) return;
      onJob(job);
      if (isFinished(job, config)) stop();
    };
    async function poll() {
      if (closed || fetching) return;
      fetching = true;
      try { receive(await request('/api/jobs/' + encodeURIComponent(id))); }
      catch (error) { if (!closed) onError(error); }
      finally { fetching = false; if (!closed) timer = setTimeout(poll, 1800); }
    }
    poll();
    if (window.EventSource) {
      source = new EventSource('/api/stream/' + encodeURIComponent(id));
      source.addEventListener('job', event => {
        try { receive(JSON.parse(event.data)); } catch (error) { if (!closed) onError(error); }
      });
      source.onerror = () => { source?.close(); source = null; };
    }
    return stop;
  }
  const getVerdict = value => Object.prototype.hasOwnProperty.call(verdicts, value) ? verdicts[value] : { text: '⏳ 等待结果', className: 'unable_to_determine' };
  const getAgreement = value => Object.prototype.hasOwnProperty.call(agreement, value) ? agreement[value] : { text: '审核尚未完成', className: 'uncertain' };
  function certHref(job) {
    const query = new URLSearchParams({job: job.job_id});
    if (job.proof?.certificate_id != null) query.set('id', String(job.proof.certificate_id));
    return '/cert.html?' + query.toString();
  }
  function download(report) {
    const blob = new Blob([JSON.stringify(report, null, 2)], {type:'application/json'});
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'crosscheck-' + String(report.proof?.certificate_id || report.payload?.job_id || 'report').replace(/[^a-zA-Z0-9_-]/g, '-') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  function modeLabel(config) {
    if (!config) return '尚未连接服务';
    const chain = config.chainMode === 'local' ? '本地开发链 · 非 Monad' : (config.chainMode === 'monad' ? 'Monad 测试网' : (config.chainMode || '链模式未确认'));
    return (config.liveAvailable ? '真实 API 可用 / 预设演示可选' : '预设演示 · 无真实模型调用') + ' ｜ ' + chain;
  }
  function renderShare(container, path, config, title = '手机扫码打开') {
    let origin = location.origin;
    try {
      const supplied = new URL(config?.publicOrigin || origin);
      if (['http:', 'https:'].includes(supplied.protocol) && !supplied.username && !supplied.password) origin = supplied.origin;
    } catch { /* The current origin remains a safe fallback. */ }
    const url = new URL(path, origin).href;
    container.replaceChildren();
    const image = document.createElement('img'); image.width = 176; image.height = 176;
    image.alt = title + '二维码'; image.src = '/api/qr?text=' + encodeURIComponent(url);
    const detail = document.createElement('div'); detail.className = 'share-details';
    const heading = document.createElement('div'); heading.className = 'card-title'; heading.textContent = title;
    const anchor = document.createElement('a'); anchor.href = url; anchor.textContent = url;
    const note = document.createElement('p'); note.className = 'small-note';
    note.textContent = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
      ? '当前链接仅指本机。请用电脑的局域网地址打开页面后再扫码，手机与电脑需连接同一 Wi-Fi。'
      : '手机与电脑连接同一 Wi-Fi，即可用手机浏览器扫码打开。';
    detail.append(heading, anchor, note); container.append(image, detail);
  }
  return { escape, request, canonicalize, hashes, validatePayload, watchJob, terminal, isFinished, getVerdict, getAgreement, certHref, download, statuses, modeLabel, renderShare };
})();
