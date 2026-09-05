// 《一程山路》开发服务器 —— 双击 启动服务器.cmd 运行
const h = require('http'), f = require('fs'), p = require('path');
const root = p.join(__dirname, 'game');
h.createServer((q, s) => {
  let u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/') u = '/demo.html'; // 课程演示入口；长线版本仍可通过 /index.html 访问
  const fp = p.join(root, u);
  f.readFile(fp, (e, d) => {
    if (e) { s.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); s.end('404 Not Found: ' + u); return; }
    const ext = p.extname(fp).toLowerCase();
    const m = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.mp4':'video/mp4','.webm':'video/webm','.ogg':'audio/ogg','.md':'text/plain; charset=utf-8'};
    s.writeHead(200, {'Content-Type': m[ext] || 'application/octet-stream'});
    s.end(d);
  });
}).listen(8321, '0.0.0.0', () => console.log('《一程山路》服务器已启动:\n  本机   http://localhost:8321\n  局域网 http://<你的IP>:8321\n  热点   http://192.168.137.1:8321'));
