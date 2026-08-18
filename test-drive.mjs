// 独立验证驱动：模拟带 webServer/webRuntime 服务的 ctx，验证同源路由注册与围栏
import http from 'node:http';
import { apply } from './lib/index.js';

const fakeCtx = {
  on: () => {},
  webServer: {
    register(spec) {
      // 起一个真实 HTTP 服务模拟 DSH 3080 的前缀挂载
      const srv = http.createServer((req, res) => {
        if (!req.url.startsWith(spec.path)) { res.writeHead(404); res.end(); return; }
        spec.handler(req, res);
      });
      srv.listen(3992, '127.0.0.1', () => console.log('[test] fake webserver on 3992'));
      return () => srv.close();
    },
  },
  webRuntime: { trustedHosts: [] },
};
apply(fakeCtx);
