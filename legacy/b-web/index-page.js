'use strict';
CrossCheck.request('/api/config').then(config => {
  document.getElementById('environment').textContent = CrossCheck.modeLabel(config);
  document.getElementById('contractStatus').textContent = config.contractAddress ? '已部署 · ' + config.contractAddress : '未部署';
  document.getElementById('backendStatus').textContent = config.liveAvailable ? '服务已连接 · 真实 API 可用' : '服务已连接 · 预设演示';
  document.getElementById('chainStatus').textContent = config.chainMode === 'local' ? '本地开发链（非 Monad）' : (config.chainId ? '链 ID ' + config.chainId : '尚未配置');
}).catch(error => {
  document.getElementById('environment').textContent = '尚未连接服务：' + error.message;
  document.getElementById('backendStatus').textContent = '未连接，请先启动本地服务';
});
