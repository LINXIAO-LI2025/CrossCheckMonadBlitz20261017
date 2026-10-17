import http from 'node:http';
const target = new URL(process.env.BACKEND_ORIGIN || 'http://127.0.0.1:3001');
const port = Number(process.env.WEB_PORT || 5173);
if (target.protocol !== 'http:') throw new Error('Development proxy expects an HTTP backend origin.');
const server = http.createServer((req, res) => {
  const upstream = http.request(new URL(req.url, target), { method: req.method, headers: { ...req.headers, host: target.host } }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Start A backend on port 3001 first.'); });
  req.pipe(upstream);
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
});
server.listen(port, '127.0.0.1', () => console.log(`CrossCheck development proxy http://localhost:${port} → ${target.origin}`));
