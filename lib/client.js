// dsh-liang-guard 客户端插件：梁神卫士
// 在左侧栏"新建会话"按钮下方注入"梁神卫士"按钮，点击弹出与设置弹窗同规格的
// 模态框（复用 --dsw-alias-* 主题变量），四个标签页：一键体检 / 病毒查杀 /
// 网络服务 / 系统情况。数据与操作走宿主插件挂载在 DSH webserver 上的同源路径
// /plugins/dsh-liang-guard/api/*（参照 dsh-balance 的 host/client 双层设计）。
window.__ModuleLoader__.load({
  id: 'dsh-liang-guard',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    // API 走 DSH 同源路径（由宿主插件通过 ctx.webServer.register 挂载）：
    // 无 CORS、无额外端口、局域网设备访问 DSH 时相对路径自动跟随域名。
    var API = '/plugins/dsh-liang-guard/api';
    var pollMs = 2000;        // 系统页轮询间隔（可由设置卡片调整）
    var notifyEnabled = true; // 桌面通知开关（可由设置卡片调整）
    // React 引用：设置卡片注册需要（require 失败则跳过卡片功能，卫士弹窗不受影响）
    var R = null;
    try { R = require('react'); } catch (e) { R = null; }

    // ---------- 小工具 ----------
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function api(path, opts) {
      return fetch(API + path, opts ? Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' } }, opts) : undefined)
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, error: '卫士服务不可用（需重启 DSH 生效）' }; });
    }
    function fmtMs(ms) {
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      function p(n) { return n < 10 ? '0' + n : '' + n; }
      return (h > 0 ? h + ':' : '') + p(m) + ':' + p(sec);
    }
    function findNewSessionButton() {
      // 精准锚定：核心侧栏新会话按钮带 CSS module 类 *_newSession（如 hHd-Xa_newSession）。
      // 不能按 aria-label/文本搜——顶部 Logo 品牌按钮同样带 aria-label="新建会话"，
      // 且在 DOM 中排第一位，按文本匹配会把按钮插到侧栏最顶端（曾踩坑）。
      var byClass = document.querySelector('button[class*="newSession"]');
      if (byClass) return byClass;
      // 兜底：找含 <span>新会话</span> 文本的按钮（Logo 按钮没有文本 span）
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var spans = b.querySelectorAll('span');
        for (var j = 0; j < spans.length; j++) {
          if (/^(新会话|new session)$/i.test((spans[j].textContent || '').trim())) return b;
        }
      }
      return null;
    }

    // ---------- 全局状态 ----------
    var railBtn = null, railAnchor = null, modal = null;
    var state = {
      tab: 'health',
      health: null, healthRunning: false,
      scanTimer: null, scanConfirm: null,
      sysTimer: null, cpuHist: [], memHist: [],
      netSpeedRunning: false, repairConfirm: null,
      admin: null,
      checks: null, scansHist: null,
      diskTimer: null, diskState: null, diskResults: {},
    };

    // ============================================================
    // 样式（全部走 --dsw-alias-* 主题变量，与设置弹窗同风格）
    // ============================================================
    function injectStyle() {
      if (document.getElementById('dsh-liang-guard-css')) return;
      var s = document.createElement('style');
      s.id = 'dsh-liang-guard-css';
      s.textContent = [
        // 侧栏按钮：显式复刻核心侧栏 .newSession 的带框设计（border-l2 描边、圆角 12、高 38），
        // 不做 computed style 克隆——锚点可能命中无边框元素（曾导致按钮无框悬浮）。
        '.lg-rail-btn{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;white-space:nowrap;flex:none;align-self:stretch;height:38px;margin:0 2px 8px;padding:8px 16px;font-size:14px;font-weight:500;line-height:22px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#31436b);border-radius:12px;background:var(--dsw-alias-button-elevated-fill,#1a2440);color:var(--dsw-alias-label-primary,#e8eef7)}',
        '.lg-rail-btn:hover{border-color:var(--dsw-alias-state-business-primary,#5ad1ff);color:var(--dsw-alias-state-business-primary,#5ad1ff)}',
        '.lg-rail-btn svg{flex:none}',
        '.lg-rail-btn.lg-rail-collapsed{align-self:flex-start;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}',
        '.lg-overlay{position:fixed;inset:0;z-index:10000;background:rgba(8,12,22,.5);display:flex;align-items:center;justify-content:center;animation:lgFade .15s ease}',
        '@keyframes lgFade{from{opacity:0}to{opacity:1}}',
        '@keyframes lgPop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
        '.lg-modal{width:min(780px,calc(100vw - 48px));height:min(580px,calc(100vh - 64px));display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1a2233);border:1px solid var(--dsw-alias-border-l2,#31436b);border-radius:14px;box-shadow:0 16px 60px rgba(0,0,0,.45);animation:lgPop .18s ease;overflow:hidden}',
        '.lg-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,#26314a)}',
        '.lg-head-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eef7);display:flex;align-items:center;gap:8px}',
        '.lg-badge{font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,#31436b);color:var(--dsw-alias-label-tertiary,#7d8aa5)}',
        '.lg-badge.ok{color:#4ade80;border-color:rgba(74,222,128,.4)}',
        '.lg-badge.no{color:#f87171;border-color:rgba(248,113,113,.4)}',
        '.lg-close{margin-left:auto;background:transparent;border:none;color:var(--dsw-alias-label-tertiary,#7d8aa5);cursor:pointer;padding:4px 6px;border-radius:6px;font-size:16px;line-height:1}',
        '.lg-close:hover{color:var(--dsw-alias-label-primary,#e8eef7);background:var(--dsw-alias-interactive-bg-hover,#223052)}',
        '.lg-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#26314a)}',
        '.lg-tab{background:transparent;border:none;color:var(--dsw-alias-label-secondary,#aab6cc);font-size:13px;padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
        '.lg-tab:hover{color:var(--dsw-alias-label-primary,#e8eef7)}',
        '.lg-tab.on{color:var(--dsw-alias-state-business-primary,#5ad1ff);border-bottom-color:var(--dsw-alias-state-business-primary,#5ad1ff)}',
        '.lg-body{flex:1;overflow-y:auto;padding:18px 20px}',
        '.lg-body::-webkit-scrollbar{width:8px}',
        '.lg-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#31436b);border-radius:4px}',
        '.lg-card{border:1px solid var(--dsw-alias-border-l2,#26314a);border-radius:10px;padding:14px 16px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-0,transparent)}',
        '.lg-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eef7);margin-bottom:10px;display:flex;align-items:center;gap:6px}',
        '.lg-btn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--dsw-alias-border-l2,#31436b);color:var(--dsw-alias-label-primary,#e8eef7);border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12px}',
        '.lg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#223052)}',
        '.lg-btn:disabled{opacity:.45;cursor:not-allowed}',
        '.lg-btn.primary{border-color:var(--dsw-alias-state-business-primary,#5ad1ff);color:var(--dsw-alias-state-business-primary,#5ad1ff)}',
        '.lg-btn.danger{border-color:#f87171;color:#f87171}',
        '.lg-btn.sm{padding:3px 10px;font-size:11px}',
        '.lg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.lg-muted{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d8aa5)}',
        '.lg-score-wrap{display:flex;gap:22px;align-items:center;flex-wrap:wrap}',
        '.lg-ring{position:relative;width:132px;height:132px;flex:none}',
        '.lg-ring svg{transform:rotate(-90deg)}',
        '.lg-ring-num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}',
        '.lg-ring-num b{font-size:30px;color:var(--dsw-alias-label-primary,#e8eef7)}',
        '.lg-ring-num span{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d8aa5)}',
        '.lg-items{flex:1;min-width:260px}',
        '.lg-item{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,#222d45);font-size:12px}',
        '.lg-item:last-child{border-bottom:none}',
        '.lg-item .st{flex:none;width:16px;text-align:center}',
        '.lg-item .lb{color:var(--dsw-alias-label-primary,#e8eef7);width:110px;flex:none}',
        '.lg-item .dt{color:var(--dsw-alias-label-tertiary,#8d99b3);flex:1;word-break:break-all}',
        '.lg-st-ok{color:#4ade80}.lg-st-warn{color:#fbbf24}.lg-st-bad{color:#f87171}',
        '.lg-kv{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;color:var(--dsw-alias-label-secondary,#aab6cc)}',
        '.lg-kv b{color:var(--dsw-alias-label-primary,#e8eef7)}',
        '.lg-bar{height:8px;border-radius:4px;background:var(--dsw-alias-border-l2,#222d45);overflow:hidden;margin:4px 0 10px}',
        '.lg-bar i{display:block;height:100%;border-radius:4px;background:var(--dsw-alias-state-business-primary,#5ad1ff);transition:width .4s ease}',
        '.lg-bar i.warn{background:#fbbf24}.lg-bar i.bad{background:#f87171}',
        '.lg-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
        '@media (max-width:640px){.lg-grid2{grid-template-columns:1fr}}',
        '.lg-spark{display:block;width:100%;height:44px;margin-top:6px}',
        '.lg-table{width:100%;border-collapse:collapse;font-size:12px}',
        '.lg-table th{text-align:left;color:var(--dsw-alias-label-tertiary,#7d8aa5);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,#26314a)}',
        '.lg-table td{padding:4px 8px;color:var(--dsw-alias-label-secondary,#aab6cc);border-bottom:1px dashed var(--dsw-alias-border-l2,#222d45)}',
        '.lg-scan-run{display:flex;align-items:center;gap:14px;padding:12px 0}',
        '.lg-spin{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l2,#31436b);border-top-color:var(--dsw-alias-state-business-primary,#5ad1ff);border-radius:50%;animation:lgRot .8s linear infinite;flex:none}',
        '@keyframes lgRot{to{transform:rotate(360deg)}}',
        '.lg-scanbar{height:10px;border-radius:5px;overflow:hidden;background:repeating-linear-gradient(45deg,var(--dsw-alias-border-l2,#222d45) 0 12px,#1b2740 12px 24px);background-size:34px 100%;animation:lgScan 1.2s linear infinite;margin:8px 0}',
        '@keyframes lgScan{to{background-position:34px 0}}',
        '.lg-confirm{display:flex;align-items:center;gap:10px;margin-top:10px;padding:10px 12px;border:1px solid #fbbf2455;border-radius:8px;font-size:12px;color:#fbbf24;background:rgba(251,191,36,.06)}',
        // 扫描进行中：侧栏按钮呼吸点
        '.lg-rail-btn{position:relative}',
        '.lg-rail-badge{position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#5ad1ff);animation:lgPulse 1.6s ease infinite;pointer-events:none}',
        '@keyframes lgPulse{0%,100%{box-shadow:0 0 0 0 rgba(90,209,255,.55)}50%{box-shadow:0 0 0 5px rgba(90,209,255,0)}}',
        // 完成通知 Toast（右下角）
        '.lg-toast{position:fixed;right:20px;bottom:20px;z-index:10001;display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#31436b);background:var(--dsw-alias-bg-layer-1,#1a2233);color:var(--dsw-alias-label-primary,#e8eef7);font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.4);animation:lgToastIn .25s ease;cursor:default}',
        '.lg-toast.ok{border-color:rgba(74,222,128,.45)}.lg-toast.ok svg{color:#4ade80}',
        '.lg-toast.danger{border-color:rgba(248,113,113,.45)}.lg-toast.danger svg{color:#f87171}',
        '.lg-toast .lg-toast-btn{cursor:pointer}',
        '@keyframes lgToastIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
        '.lg-empty{color:var(--dsw-alias-label-tertiary,#7d8aa5);font-size:12px;padding:18px 0;text-align:center}',
        '.lg-err{color:#f87171;font-size:12px;margin-top:8px}'
      ].join('\n');
      document.head.appendChild(s);
    }

    var ICON_SHIELD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/></svg>';

    // 单色线性图标库（stroke=currentColor，跟随主题，14px 基准）
    function I(name, size) {
      var s = size || 14;
      var paths = {
        // 体检：心跳脉搏
        pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
        // 查杀：盾牌+虫
        bug: '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/><path d="M12 12v4"/><path d="M10 9.5 8.5 8M14 9.5 15.5 8M10 14H8M14 14h2"/>',
        // 网络：地球
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18z"/>',
        // 系统：仪表盘
        gauge: '<path d="M12 15l4-5"/><path d="M4 19a9 9 0 1 1 16 0"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/>',
        // 闪电（快速/释放内存）
        zap: '<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z"/>',
        // 放大镜（全面查杀）
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
        // 播放
        play: '<path d="M6 4.5v15l13-7.5z"/>',
        // 刷新
        refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
        // 停止
        stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
        // CPU
        cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
        // 内存条
        memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 17v3M12 17v3M17 17v3"/><path d="M7 11h2M11 11h2M15 11h2"/>',
        // 磁盘
        disk: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="m6.5 6.5 3.7 3.7M13.8 13.8l3.7 3.7"/>',
        // 进程列表
        list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
        // 扳手（修复）
        wrench: '<path d="M14.5 6.5a4.5 4.5 0 0 0-6 6L3 18l3 3 5.5-5.5a4.5 4.5 0 0 0 6-6L14 13l-3-3z"/>',
        // 警示（威胁）
        alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/>',
      };
      return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px">' + (paths[name] || '') + '</svg>';
    }

    // ============================================================
    // 侧栏按钮注入（新建会话按钮下方）
    // ============================================================
    function injectRailButton() {
      if (railBtn && document.contains(railBtn)) { syncRailMode(); return; }
      var nb = findNewSessionButton();
      if (!nb || !nb.parentElement) return;
      railAnchor = nb;
      var nbIcon = nb.querySelector('svg');
      var iconSize = nbIcon ? Math.max(nbIcon.getBoundingClientRect().width, 12) : 15;
      railBtn = el('button', 'lg-rail-btn', null);
      railBtn.title = '梁神卫士 · 系统体检 / 病毒查杀 / 网络服务';
      railBtn.setAttribute('aria-label', '梁神卫士');
      railBtn.innerHTML =
        '<svg width="' + iconSize + '" height="' + iconSize + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/></svg>' +
        '<span class="lg-rail-label">梁神卫士</span>' +
        '<span class="lg-rail-badge" style="display:none"></span>';
      railBtn.addEventListener('click', function (e) { e.stopPropagation(); openModal(); });
      // SPA 重渲染会重建按钮：按当前扫描状态恢复呼吸点
      setScanBadge(!!(state.scan && state.scan.running));
      syncRailMode();
      // 插入到新会话按钮的紧后方（与它同父级，正好位于工作区区域上方）
      if (nb.nextSibling) nb.parentElement.insertBefore(railBtn, nb.nextSibling);
      else nb.parentElement.appendChild(railBtn);
    }
    /** 跟随侧栏宽/折叠态切换图标/完整形态（锚点为新会话按钮本身） */
    function syncRailMode() {
      var nb = railAnchor;
      if (!railBtn || !nb) return;
      var collapsed = nb.clientWidth > 0 && nb.clientWidth <= 48;
      railBtn.classList.toggle('lg-rail-collapsed', collapsed);
      var lbl = railBtn.querySelector('.lg-rail-label');
      if (lbl) lbl.style.display = collapsed ? 'none' : '';
    }

    // ============================================================
    // 模态框骨架
    // ============================================================
    var TABS = [
      { id: 'health', label: '一键体检', icon: 'pulse' },
      { id: 'scan', label: '病毒查杀', icon: 'bug' },
      { id: 'net', label: '网络服务', icon: 'globe' },
      { id: 'sys', label: '系统情况', icon: 'gauge' },
    ];

    function buildModal() {
      modal = el('div', 'lg-overlay');
      modal.style.display = 'none';
      var box = el('div', 'lg-modal');
      var head = el('div', 'lg-head');
      var title = el('div', 'lg-head-title');
      title.innerHTML = ICON_SHIELD + '<span>梁神卫士</span>';
      var ver = el('span', 'lg-badge', 'v1.1');
      var adminBadge = el('span', 'lg-badge', '权限检测中…');
      adminBadge.id = 'lg-admin-badge';
      var close = el('button', 'lg-close', '✕');
      close.title = '关闭';
      close.addEventListener('click', closeModal);
      head.appendChild(title); head.appendChild(ver); head.appendChild(adminBadge); head.appendChild(close);

      var tabs = el('div', 'lg-tabs');
      TABS.forEach(function (t) {
        var b = el('button', 'lg-tab', null);
        b.dataset.tab = t.id;
        b.innerHTML = I(t.icon) + '<span style="margin-left:5px">' + t.label + '</span>';
        b.addEventListener('click', function () { switchTab(t.id); });
        tabs.appendChild(b);
      });

      var body = el('div', 'lg-body');
      body.id = 'lg-body';

      box.appendChild(head); box.appendChild(tabs); box.appendChild(body);
      modal.appendChild(box);
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
      document.body.appendChild(modal);
    }

    function switchTab(id) {
      state.tab = id;
      (modal.querySelectorAll('.lg-tab') || []).forEach(function (b) {
        b.classList.toggle('on', b.dataset.tab === id);
      });
      renderTab();
    }

    function body() { return modal.querySelector('#lg-body'); }

    function openModal() {
      if (!modal) buildModal();
      modal.style.display = 'flex';
      api('/ping').then(function (r) {
        state.admin = r.ok ? !!r.admin : null;
        state.serviceDown = !r.ok;
        var b = modal.querySelector('#lg-admin-badge');
        if (b) {
          b.textContent = state.admin ? '管理员权限' : '普通权限';
          b.className = 'lg-badge ' + (state.admin ? 'ok' : 'no');
          b.title = state.admin ? '全部功能可用' : '网络深度修复 / 释放他人进程内存需要管理员';
        }
      });
      renderTab();
    }
    function closeModal() {
      if (modal) modal.style.display = 'none';
      stopSysPoll(); // 注意：不停止扫描守望者——弹窗关掉后呼吸点与完成通知继续工作
    }

    // ============================================================
    // Tab 1 一键体检
    // ============================================================
    function renderHealth() {
      var b = body();
      if (state.healthRunning) {
        b.innerHTML = '<div class="lg-card"><div class="lg-scan-run"><div class="lg-spin"></div><div><div style="font-size:13px;color:var(--dsw-alias-label-primary,#e8eef7)">体检进行中…</div><div class="lg-scanbar" style="max-width:420px"></div><div class="lg-muted">正在读取 Defender、防火墙、磁盘、内存、启动项与网络状态</div></div></div></div>';
        return;
      }
      if (!state.health) {
        loadChecks();
        b.innerHTML =
          '<div class="lg-card"><div class="lg-card-title">' + I('pulse') + ' 一键体检</div>' +
          '<div class="lg-muted" style="margin-bottom:12px">全面检查系统健康度：病毒防护 · 防火墙 · 磁盘水位 · 内存压力 · 临时文件 · 启动项 · 网络延迟，并给出综合评分。</div>' +
          '<button class="lg-btn primary" id="lg-hc-run">' + I('play', 12) + ' 开始体检</button></div>';
        b.querySelector('#lg-hc-run').addEventListener('click', runHealthCheck);
        return;
      }
      var h = state.health;
      var sc = h.score, color = sc >= 85 ? '#4ade80' : sc >= 60 ? '#fbbf24' : '#f87171';
      var verdict = sc >= 85 ? '状态良好' : sc >= 60 ? '存在隐患' : '需要处理';
      var C = 2 * Math.PI * 52;
      var rows = (h.items || []).map(function (it) {
        var ic = it.status === 'ok' ? '✓' : it.status === 'warn' ? '!' : '✕';
        return '<div class="lg-item"><span class="st lg-st-' + it.status + '">' + ic + '</span>' +
          '<span class="lb">' + esc(it.label) + '</span><span class="dt">' + esc(it.detail) + '</span></div>';
      }).join('');
      b.innerHTML =
        '<div class="lg-card"><div class="lg-score-wrap">' +
        '<div class="lg-ring"><svg width="132" height="132">' +
        '<circle cx="66" cy="66" r="52" fill="none" stroke="var(--dsw-alias-border-l2,#222d45)" stroke-width="10"/>' +
        '<circle cx="66" cy="66" r="52" fill="none" stroke="' + color + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + (C * sc / 100).toFixed(1) + ' ' + C.toFixed(1) + '"/></svg>' +
        '<div class="lg-ring-num"><b style="color:' + color + '">' + sc + '</b><span>' + verdict + '</span></div></div>' +
        '<div class="lg-items">' + rows + '</div></div>' +
        '<div class="lg-row" style="margin-top:12px;justify-content:space-between">' +
        '<span class="lg-muted">体检时间：' + new Date(h.at).toLocaleString() + (healthDelta()) + '</span>' +
        '<button class="lg-btn" id="lg-hc-rerun">' + I('refresh', 12) + ' 重新体检</button></div></div>' +
        checkHistoryHtml();
      b.querySelector('#lg-hc-rerun').addEventListener('click', runHealthCheck);
      bindCheckHistory();
    }
    /** 与上一次体检的分差标注 */
    function healthDelta() {
      var list = state.checks;
      if (!list || list.length < 2) return '（首次体检）';
      var prev = list[1].score, cur = list[0].score;
      if (cur === prev) return '（与上次持平）';
      var d = cur - prev;
      return '（比上次 ' + (d > 0 ? '+' : '') + d + ' 分）';
    }
    /** 最近体检记录列表 HTML */
    function checkHistoryHtml() {
      var list = state.checks;
      if (!list || !list.length) return '';
      var rows = list.slice(0, 6).map(function (c) {
        var col = c.score >= 85 ? '#4ade80' : c.score >= 60 ? '#fbbf24' : '#f87171';
        return '<tr><td>' + new Date(c.at).toLocaleString() + '</td><td style="text-align:right;color:' + col + ';font-weight:600">' + c.score + ' 分</td></tr>';
      }).join('');
      return '<div class="lg-card"><div class="lg-card-title">' + I('pulse') + ' 历史体检</div>' +
        '<table class="lg-table"><thead><tr><th>时间</th><th style="text-align:right">得分</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    function bindCheckHistory() { /* 静态列表，无需绑定 */ }
    function loadChecks() {
      return api('/history').then(function (r) {
        if (r.ok) { state.checks = r.checks || []; state.scansHist = r.scans || []; }
      });
    }
    function runHealthCheck() {
      state.healthRunning = true; renderHealth();
      api('/check', { method: 'POST', body: '{}' }).then(function (r) {
        state.healthRunning = false;
        state.health = r.ok ? r : { at: Date.now(), score: 0, items: [{ label: '体检失败', status: 'bad', detail: r.error || '未知错误' }] };
        loadChecks().then(function () { if (state.tab === 'health') renderHealth(); });
      });
    }

    // ============================================================
    // Tab 2 病毒查杀（真实调用 Windows Defender）
    // ============================================================
    function renderScan() {
      var b = body();
      b.innerHTML =
        '<div class="lg-card"><div class="lg-card-title">' + I('bug') + ' Windows Defender 查杀</div>' +
        '<div class="lg-muted" style="margin-bottom:12px">直接调用系统 Windows Defender 引擎执行真实扫描。快速查杀数分钟，全面查杀可能需要数小时，期间可关闭本窗口，扫描继续进行。</div>' +
        '<div class="lg-row">' +
        '<button class="lg-btn primary" id="lg-scan-quick">' + I('zap', 12) + ' 快速查杀</button>' +
        '<button class="lg-btn" id="lg-scan-full">' + I('search', 12) + ' 全面查杀</button>' +
        '<button class="lg-btn sm" id="lg-scan-refresh" style="margin-left:auto">' + I('refresh', 12) + ' 刷新状态</button></div>' +
        (state.scanConfirm
          ? '<div class="lg-confirm">全面查杀耗时较长（可能数小时），确认开始？' +
            '<button class="lg-btn sm primary" id="lg-scan-full-go">确认开始</button>' +
            '<button class="lg-btn sm" id="lg-scan-full-no">取消</button></div>'
          : '') +
        '<div id="lg-scan-state" style="margin-top:6px"></div></div>' +
        '<div class="lg-card"><div class="lg-card-title">' + I('alert') + ' 威胁记录</div><div id="lg-threats"><div class="lg-muted">点击"刷新状态"读取 Defender 威胁记录</div></div></div>' +
        '<div id="lg-scan-hist"></div>';
      b.querySelector('#lg-scan-quick').addEventListener('click', function () { startScan('quick'); });
      b.querySelector('#lg-scan-full').addEventListener('click', function () { state.scanConfirm = true; renderScan(); });
      var go = b.querySelector('#lg-scan-full-go');
      if (go) go.addEventListener('click', function () { state.scanConfirm = false; startScan('full'); });
      var no = b.querySelector('#lg-scan-full-no');
      if (no) no.addEventListener('click', function () { state.scanConfirm = false; renderScan(); });
      b.querySelector('#lg-scan-refresh').addEventListener('click', refreshScan);
      renderScanState();
      renderScanHistory();
      refreshThreats(false);
    }
    function startScan(mode) {
      requestNotifyPermission(); // 借用户点击手势请求桌面通知授权
      api('/scan/start', { method: 'POST', body: JSON.stringify({ mode: mode }) }).then(function (r) {
        if (!r.ok) { alert('梁神卫士：' + (r.error || '启动失败')); return; }
        state.scanConfirm = false;
        refreshScan(); // 拉一次状态：启动后台守望者 + 挂呼吸点
        renderScanState();
      });
    }
    function renderScanState() {
      var host = modal && modal.querySelector('#lg-scan-state');
      if (!host) return;
      if (!state.scan || (!state.scan.running && !state.scan.everRan)) {
        host.innerHTML = '<div class="lg-muted">当前没有查杀任务</div>';
        return;
      }
      var s = state.scan;
      if (s.running) {
        host.innerHTML =
          '<div class="lg-scan-run"><div class="lg-spin"></div><div style="flex:1">' +
          '<div style="font-size:13px;color:var(--dsw-alias-label-primary,#e8eef7)">' + (s.mode === 'full' ? '全面查杀进行中' : '快速查杀进行中') + ' · 已用 ' + fmtMs(s.elapsedMs || 0) + '</div>' +
          '<div class="lg-scanbar" style="max-width:420px"></div>' +
          '<div class="lg-muted">Defender 正在扫描，进度由 Windows 安全中心管理</div></div>' +
          '<button class="lg-btn sm danger" id="lg-scan-cancel">' + I('stop', 12) + ' 取消</button></div>';
        var c = host.querySelector('#lg-scan-cancel');
        if (c) c.addEventListener('click', function () {
          c.disabled = true;
          c.innerHTML = I('refresh', 12) + ' 取消并验证引擎…';
          // 取消含 ~3 秒的引擎活动实测（MsMpEng CPU 采样），期间按钮保持禁用
          api('/scan/cancel', { method: 'POST', body: '{}' }).then(function (r) {
            if (r.ok) showToast(r.stopped ? '已取消：验证引擎已停止扫描' : '已停止等待：Defender 服务级扫描仍在后台（无公开 API 可终止）', r.stopped ? 'ok' : 'danger');
            refreshScan();
          });
        });
        return;
      }
      var th = s.threats;
      var done =
        '<div style="font-size:13px;color:' + (s.error ? '#f87171' : '#4ade80') + '">' +
        (s.error ? '✕ ' + esc(s.error) : '✓ 查杀完成（用时 ' + fmtMs(s.elapsedMs || 0) + '）') + '</div>';
      if (!s.error) {
        if (th && th.length) {
          done += '<div class="lg-err">发现 ' + th.length + ' 个威胁：</div>' + th.map(function (t) {
            return '<div class="lg-item"><span class="st lg-st-bad">✕</span><span class="lb">' + esc(t.name) + '</span><span class="dt">' + esc((t.resources || []).join('；').slice(0, 120)) + '</span></div>';
          }).join('');
        } else {
          done += '<div class="lg-muted" style="margin-top:4px">未发现威胁，系统安全 ✓</div>';
        }
      }
      host.innerHTML = done;
    }
    function refreshScan() {
      return api('/scan/status').then(function (r) { applyScanStatus(r); });
    }
    /** 统一处理扫描状态：更新徽点、检测运行→停止翻转并通知；弹窗开着才渲染 */
    function applyScanStatus(r) {
      if (!r || r.ok === false) return;
      var wasRunning = state.scan ? !!state.scan.running : false;
      state.scan = r;
      if (r.running) startScanWatch(); else stopScanWatch();
      setScanBadge(!!r.running);
      if (wasRunning && !r.running) notifyScanDone(r);
      if (modal && modal.style.display !== 'none' && state.tab === 'scan') renderScanState();
    }
    /** 后台守望者：弹窗关着也轮询（回环请求开销可忽略），每 2.5s 一次 */
    function startScanWatch() {
      if (state.scanTimer) return;
      state.scanTimer = setInterval(function () {
        api('/scan/status').then(applyScanStatus);
      }, 2500);
    }
    function stopScanWatch() { if (state.scanTimer) { clearInterval(state.scanTimer); state.scanTimer = null; } }
    /** 侧栏按钮呼吸点开关 */
    function setScanBadge(on) {
      if (!railBtn) return;
      var badge = railBtn.querySelector('.lg-rail-badge');
      if (badge) badge.style.display = on ? '' : 'none';
    }
    /** 查杀历史卡片（读取宿主持久化记录） */
    function renderScanHistory() {
      loadChecks().then(function () {
        var host = modal && modal.querySelector('#lg-scan-hist');
        if (!host) return;
        var list = state.scansHist || [];
        if (!list.length) { host.innerHTML = ''; return; }
        var rows = list.slice(0, 8).map(function (s) {
          var res = s.error ? '<span class="lg-st-warn">异常</span>'
            : (s.threatCount > 0 ? '<span class="lg-st-bad">发现 ' + s.threatCount + ' 个威胁</span>' : '<span class="lg-st-ok">干净</span>');
          return '<tr><td>' + new Date(s.at).toLocaleString() + '</td><td>' + (s.mode === 'full' ? '全面' : '快速') + '</td>' +
            '<td>' + fmtMs(s.durationMs || 0) + '</td><td>' + res + '</td></tr>';
        }).join('');
        host.innerHTML = '<div class="lg-card"><div class="lg-card-title">' + I('bug') + ' 查杀历史</div>' +
          '<table class="lg-table"><thead><tr><th>时间</th><th>类型</th><th>用时</th><th>结果</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      });
    }
    function notifyScanDone(r) {
      if (state.scanNotified === r.id) return;
      state.scanNotified = r.id;
      var th = r.threats;
      var bad = th && th.length;
      var text = r.error
        ? '查杀结束：' + r.error
        : bad ? '发现 ' + th.length + ' 个威胁，点击查看'
        : '查杀完成：未发现威胁';
      showToast(text, bad || r.error ? 'danger' : 'ok');
      // 桌面原生通知：页面在后台时页内 Toast 容易错过，原生弹窗更可靠
      notifyDesktop('梁神卫士 · 病毒查杀', text, 'scan');
    }
    /** 浏览器桌面通知（设置卡片可关闭；已授权才发；点击聚焦页面并直达对应标签） */
    function notifyDesktop(title, body, tab) {
      try {
        if (!notifyEnabled) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        var n = new Notification(title, { body: body, tag: 'liang-guard' });
        n.onclick = function () {
          window.focus();
          openModal();
          if (tab) switchTab(tab);
          n.close();
        };
      } catch (e) { /* 通知失败静默，页内 Toast 已兜底 */ }
    }
    /** 应用宿主下发的运行时配置（设置卡片保存后立即生效） */
    function applyClientConfig(c) {
      if (!c) return;
      if (c.pollSec) pollMs = c.pollSec * 1000;
      notifyEnabled = !!c.notify;
    }
    /** 在用户点击手势内请求通知授权（浏览器要求手势上下文） */
    function requestNotifyPermission() {
      try {
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      } catch (e) { /* 忽略 */ }
    }
    /** 右下角 Toast：点击"查看"直达病毒查杀标签 */
    function showToast(text, tone) {
      var old = document.querySelector('.lg-toast');
      if (old) old.remove();
      var t = el('div', 'lg-toast ' + (tone || 'ok'));
      t.innerHTML = I('bug', 15) + '<span>' + esc(text) + '</span><button class="lg-btn sm lg-toast-btn">查看</button>';
      t.querySelector('.lg-toast-btn').addEventListener('click', function () {
        t.remove();
        openModal();
        switchTab('scan');
      });
      document.body.appendChild(t);
      // 无威胁 10s 自动消失；有威胁/出错保留 30s 等人处理
      setTimeout(function () { if (document.contains(t)) t.remove(); }, tone === 'danger' ? 30000 : 10000);
    }
    function refreshThreats(alsoRender) {
      return api('/threats').then(function (r) {
        var host = modal && modal.querySelector('#lg-threats');
        if (!host) return;
        var t = r.threats || [];
        if (!t.length) { host.innerHTML = '<div class="lg-muted">无威胁记录 ✓</div>'; return; }
        host.innerHTML = t.map(function (x) {
          return '<div class="lg-item"><span class="st lg-st-bad">✕</span><span class="lb">' + esc(x.name) + '</span><span class="dt">' + esc((x.resources || []).join('；').slice(0, 120)) + '</span></div>';
        }).join('') + '<button class="lg-btn sm danger" id="lg-th-remove" style="margin-top:8px">清除全部威胁（Defender 处置）</button>';
        var btn = host.querySelector('#lg-th-remove');
        if (btn) btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = '处置中…';
          api('/threats/remove', { method: 'POST', body: '{}' }).then(function (rr) {
            alert(rr.ok ? '梁神卫士：威胁清除指令已执行' : '梁神卫士：' + (rr.detail || '清除失败'));
            refreshThreats();
          });
        });
      });
    }

    // ============================================================
    // Tab 3 网络服务
    // ============================================================
    function renderNet() {
      var b = body();
      b.innerHTML =
        '<div class="lg-card"><div class="lg-card-title">' + I('globe') + ' 网络测速</div>' +
        '<div class="lg-muted" style="margin-bottom:10px">延迟：ping 三个公共节点；带宽：真实下载 15MB 测速文件计时。</div>' +
        '<div class="lg-row"><button class="lg-btn primary" id="lg-net-go">' + I('play', 12) + ' 开始测速</button><span class="lg-muted" id="lg-net-state"></span></div>' +
        '<div id="lg-net-result" style="margin-top:6px"></div></div>' +
        '<div class="lg-card"><div class="lg-card-title">' + I('wrench') + ' 网络修复</div>' +
        '<div class="lg-muted" style="margin-bottom:10px">刷新 DNS 缓存立即可用、无需管理员；深度修复会重置 Winsock 与 TCP/IP 协议栈（需要管理员，且修复后需重启电脑生效）。</div>' +
        '<div class="lg-row"><button class="lg-btn" id="lg-rep-dns">' + I('refresh', 12) + ' 刷新 DNS 缓存</button>' +
        '<button class="lg-btn danger" id="lg-rep-full">深度修复（慎用）</button></div>' +
        (state.repairConfirm
          ? '<div class="lg-confirm">深度修复将执行 winsock reset 与 int ip reset，需重启生效。确认继续？<button class="lg-btn sm danger" id="lg-rep-go">确认</button><button class="lg-btn sm" id="lg-rep-no">取消</button></div>'
          : '') +
        '<div id="lg-rep-result"></div></div>';
      b.querySelector('#lg-net-go').addEventListener('click', runSpeedTest);
      b.querySelector('#lg-rep-dns').addEventListener('click', function () { runRepair('dns'); });
      b.querySelector('#lg-rep-full').addEventListener('click', function () { state.repairConfirm = true; renderNet(); });
      var go = b.querySelector('#lg-rep-go');
      if (go) go.addEventListener('click', function () { state.repairConfirm = false; runRepair('full'); });
      var no = b.querySelector('#lg-rep-no');
      if (no) no.addEventListener('click', function () { state.repairConfirm = false; renderNet(); });
      if (state.netResult) b.querySelector('#lg-net-result').innerHTML = state.netResult;
    }
    function runSpeedTest() {
      var st = modal.querySelector('#lg-net-state'); var res = modal.querySelector('#lg-net-result');
      if (st) st.textContent = '测延迟中…';
      if (res) res.innerHTML = '';
      api('/net/latency', { method: 'POST', body: '{}' }).then(function (r) {
        var lat = (r.targets || []).map(function (t) {
          return '<div class="lg-kv"><span>' + esc(t.host) + '</span><b>' + (t.avgMs == null ? '超时' : t.avgMs + ' ms') + '</b></div>';
        }).join('');
        if (st) st.textContent = '测带宽中（下载 15MB）…';
        if (res) res.innerHTML = lat;
        return api('/net/speed', { method: 'POST', body: '{}' });
      }).then(function (r) {
        if (st) st.textContent = '';
        var html = (res && res.innerHTML || '');
        var sp = r.ok
          ? '<div class="lg-kv"><span>下行带宽</span><b style="color:var(--dsw-alias-state-business-primary,#5ad1ff);font-size:15px">' + r.mbps + ' Mbps</b></div>'
          : '<div class="lg-err">' + esc(r.error) + '</div>';
        state.netResult = html + sp;
        if (res) res.innerHTML = state.netResult;
      });
    }
    function runRepair(level) {
      var host = modal.querySelector('#lg-rep-result');
      if (host) host.innerHTML = '<div class="lg-muted">修复指令执行中…</div>';
      api('/net/repair', { method: 'POST', body: JSON.stringify({ level: level }) }).then(function (r) {
        if (!host) return;
        var out = String(r.output || '');
        var msg = out.indexOf('NEED-ADMIN') >= 0
          ? '深度修复需要管理员权限：请以管理员身份重启 DSH 后重试（DNS 缓存已刷新）'
          : out.indexOf('FULL-REPAIR-DONE') >= 0
            ? '✓ 深度修复完成，重启电脑后生效'
            : out.indexOf('DNS cache flushed') >= 0 || out.toLowerCase().indexOf('successfully') >= 0
              ? '✓ DNS 缓存已刷新'
              : esc(out || (r.ok ? '已执行' : '执行失败'));
        host.innerHTML = '<div class="lg-kv" style="margin-top:8px">' + msg + '</div>';
      });
    }

    // ============================================================
    // Tab 4 系统情况
    // ============================================================
    function renderSys() {
      var b = body();
      b.innerHTML =
        '<div class="lg-grid2">' +
        '<div class="lg-card"><div class="lg-card-title">' + I('cpu') + ' CPU</div><div id="lg-cpu"></div><canvas class="lg-spark" id="lg-cpu-canvas" width="300" height="44"></canvas></div>' +
        '<div class="lg-card"><div class="lg-card-title">' + I('memory') + ' 内存</div><div id="lg-mem"></div><canvas class="lg-spark" id="lg-mem-canvas" width="300" height="44"></canvas>' +
        '<button class="lg-btn sm" id="lg-memfree" style="margin-top:8px">' + I('zap', 12) + ' 一键释放内存</button><span class="lg-muted" id="lg-memfree-res" style="margin-left:8px"></span></div>' +
        '</div>' +
        '<div class="lg-card"><div class="lg-card-title">' + I('disk') + ' 磁盘</div><div id="lg-disks"></div>' +
        '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l2,#222d45)">' +
        '<div class="lg-row"><span class="lg-muted">空间分析：单次遍历统计各目录体积与 TOP 大文件（大磁盘可能需要数分钟）</span></div>' +
        '<div class="lg-row" id="lg-disk-actions" style="margin-top:6px"></div>' +
        '<div id="lg-disk-result" style="margin-top:6px"></div></div></div>' +
        '<div class="lg-card"><div class="lg-card-title">' + I('list') + ' 内存占用 TOP 进程</div><div id="lg-procs"></div></div>' +
        '<div class="lg-muted" id="lg-sys-age" style="text-align:right"></div>';
      b.querySelector('#lg-memfree').addEventListener('click', freeMem);
      // 先渲染上次快照（秒开），再拉最新数据覆盖
      if (state.sysCache) {
        renderSysMetrics(state.sysCache.metrics);
        renderProcs(state.sysCache.procs);
        var ageEl = b.querySelector('#lg-sys-age');
        if (ageEl) ageEl.textContent = '数据时间：' + new Date(state.sysCache.at).toLocaleTimeString() + '，刷新中…';
      }
      startSysPoll();
      refreshDisk(); // 恢复磁盘分析状态（上次结果/进行中的任务）
    }
    function drawSpark(canvasId, data, max) {
      var c = modal && modal.querySelector('#' + canvasId);
      if (!c) return;
      var ctx = c.getContext('2d');
      var w = c.width = c.offsetWidth || 300, h = c.height;
      ctx.clearRect(0, 0, w, h);
      if (!data || data.length < 2) return;
      ctx.strokeStyle = '#5ad1ff'; ctx.lineWidth = 1.5; ctx.beginPath();
      data.forEach(function (v, i) {
        var x = i / (data.length - 1) * (w - 4) + 2;
        var y = h - 3 - Math.min(v, max) / max * (h - 8);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.lineTo(w - 2, h); ctx.lineTo(2, h); ctx.closePath();
      ctx.fillStyle = 'rgba(90,209,255,.12)'; ctx.fill();
    }
    function renderSysMetrics(m) {
      if (!m) return;
      var cpu = modal.querySelector('#lg-cpu'), mem = modal.querySelector('#lg-mem');
      if (cpu) {
        cpu.innerHTML = '<div class="lg-kv"><span>当前占用</span><b>' + m.cpu + '%</b></div><div class="lg-bar"><i class="' + (m.cpu > 85 ? 'bad' : m.cpu > 60 ? 'warn' : '') + '" style="width:' + m.cpu + '%"></i></div>' +
          '<div class="lg-muted">开机时长 ' + Math.round(m.uptimeHours) + ' 小时</div>';
      }
      if (mem) {
        mem.innerHTML = '<div class="lg-kv"><span>已用 / 总量</span><b>' + m.memUsedGB + ' / ' + m.memTotalGB + ' GB</b></div><div class="lg-bar"><i class="' + (m.memUsedPct > 90 ? 'bad' : m.memUsedPct > 75 ? 'warn' : '') + '" style="width:' + m.memUsedPct + '%"></i></div>' +
          '<div class="lg-muted">可用 ' + m.memFreeGB + ' GB · 占用 ' + m.memUsedPct + '%</div>';
      }
      state.cpuHist.push(m.cpu); if (state.cpuHist.length > 60) state.cpuHist.shift();
      state.memHist.push(m.memUsedPct); if (state.memHist.length > 60) state.memHist.shift();
      drawSpark('lg-cpu-canvas', state.cpuHist, 100);
      drawSpark('lg-mem-canvas', state.memHist, 100);
      var dk = modal.querySelector('#lg-disks');
      if (dk && m.disks && m.disks.length) {
        dk.innerHTML = m.disks.map(function (d) {
          return '<div class="lg-kv"><span>' + esc(d.drive) + '</span><b>' + d.freeGB + ' GB 可用 / 共 ' + d.totalGB + ' GB</b></div><div class="lg-bar"><i class="' + (d.usedPct > 90 ? 'bad' : d.usedPct > 75 ? 'warn' : '') + '" style="width:' + d.usedPct + '%"></i></div>';
        }).join('');
        renderDiskActions(m.disks);
      }
    }
    function renderProcs(procs) {
      var host = modal.querySelector('#lg-procs');
      if (!host) return;
      if (!procs || !procs.length) { host.innerHTML = '<div class="lg-muted">暂无数据</div>'; return; }
      var rows = procs.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td>' + p.pid + '</td><td style="text-align:right">' + p.memMB + ' MB</td></tr>';
      }).join('');
      host.innerHTML = '<table class="lg-table"><thead><tr><th>进程</th><th>PID</th><th style="text-align:right">内存</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    function startSysPoll() {
      stopSysPoll();
      var tick = function () {
        if (!modal || modal.style.display === 'none' || state.tab !== 'sys') return stopSysPoll();
        api('/metrics').then(function (r) {
          if (!r.ok) return;
          state.sysCache = { metrics: r.metrics, procs: state.sysCache && state.sysCache.procs, at: Date.now() };
          renderSysMetrics(r.metrics);
          updateSysAge();
        });
        api('/procs').then(function (r) {
          if (!r.ok) return;
          state.sysCache = { metrics: state.sysCache && state.sysCache.metrics, procs: r.procs, at: Date.now() };
          renderProcs(r.procs);
          updateSysAge();
        });
      };
      tick();
      state.sysTimer = setInterval(tick, pollMs);
    }
    function updateSysAge() {
      var ageEl = modal && modal.querySelector('#lg-sys-age');
      if (ageEl && state.sysCache) ageEl.textContent = '数据时间：' + new Date(state.sysCache.at).toLocaleTimeString();
    }
    // ---------- 磁盘空间分析 ----------
    function renderDiskActions(disks) {
      var host = modal && modal.querySelector('#lg-disk-actions');
      if (!host || !disks || !disks.length) return;
      var running = state.diskState && state.diskState.running;
      host.innerHTML = disks.map(function (d) {
        var letter = String(d.drive || '').replace(':', '');
        var dis = running ? ' disabled' : '';
        return '<button class="lg-btn sm" data-disk="' + letter + '"' + dis + '>' + I('search', 11) + ' 分析 ' + letter + ' 盘</button>';
      }).join('');
      host.querySelectorAll('button[data-disk]').forEach(function (b) {
        b.addEventListener('click', function () { startDisk(b.dataset.disk); });
      });
      renderDiskResult();
    }
    function startDisk(drive) {
      api('/disk/start', { method: 'POST', body: JSON.stringify({ drive: drive }) }).then(function (r) {
        if (!r.ok) { alert('梁神卫士：' + (r.error || '启动失败')); return; }
        refreshDisk();
        startDiskWatch();
      });
    }
    function refreshDisk() {
      return api('/disk/status').then(function (r) {
        state.diskState = r;
        if (r.running) startDiskWatch(); else stopDiskWatch();
        renderDiskResult();
      });
    }
    function startDiskWatch() {
      if (state.diskTimer) return;
      state.diskTimer = setInterval(function () {
        // 弹窗关掉也继续守望（renderDiskResult 对弹窗不存在时安全跳过），
        // 分析完成时桌面通知/下次打开都能拿到结果
        api('/disk/status').then(function (r) {
          var wasRunning = state.diskState && state.diskState.running;
          state.diskState = r;
          if (!r.running) {
            stopDiskWatch();
            if (wasRunning && r.result) {
              state.diskResults[r.drive] = r.result;
              notifyDesktop('梁神卫士 · 磁盘分析', r.drive + ': 盘分析完成，点击查看', 'sys');
            }
          }
          renderDiskResult();
        });
      }, 2500);
    }
    function stopDiskWatch() { if (state.diskTimer) { clearInterval(state.diskTimer); state.diskTimer = null; } }
    function renderDiskResult() {
      var host = modal && modal.querySelector('#lg-disk-result');
      if (!host) return;
      var d = state.diskState;
      if (d && d.running) {
        host.innerHTML = '<div class="lg-scan-run"><div class="lg-spin"></div><div style="flex:1"><div style="font-size:13px;color:var(--dsw-alias-label-primary,#e8eef7)">' + esc(d.drive) + ': 盘分析进行中 · 已用 ' + fmtMs(d.elapsedMs || 0) + '</div><div class="lg-scanbar" style="max-width:420px"></div></div>' +
          '<button class="lg-btn sm danger" id="lg-disk-cancel">' + I('stop', 11) + ' 取消</button></div>';
        var c = host.querySelector('#lg-disk-cancel');
        if (c) c.addEventListener('click', function () { api('/disk/cancel', { method: 'POST', body: '{}' }).then(refreshDisk); });
        return;
      }
      if (d && d.error) {
        host.innerHTML = '<div class="lg-err">' + esc(d.error) + '</div>';
        return;
      }
      var res = d && d.result ? d.result : null;
      if (!res) { host.innerHTML = '<div class="lg-muted">选择上方盘符开始分析</div>'; return; }
      state.diskResults[res.drive] = res;
      var maxDir = res.dirs && res.dirs.length ? res.dirs[0].sizeGB : 1;
      var dirRows = (res.dirs || []).map(function (x) {
        return '<div class="lg-kv"><span>' + esc(x.name) + '</span><b>' + x.sizeGB + ' GB</b></div><div class="lg-bar"><i style="width:' + Math.max(3, 100 * x.sizeGB / maxDir) + '%"></i></div>';
      }).join('');
      var fileRows = (res.files || []).map(function (f) {
        return '<tr><td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(f.path) + '">' + esc(f.path) + '</td><td style="text-align:right">' + f.sizeMB + ' MB</td></tr>';
      }).join('');
      host.innerHTML =
        '<div class="lg-card-title" style="margin-top:4px">' + esc(res.drive) + ': 盘 TOP 目录</div>' + dirRows +
        (fileRows ? '<div class="lg-card-title" style="margin-top:10px">TOP 大文件（&gt;200MB）</div><table class="lg-table"><tbody>' + fileRows + '</tbody></table>' : '');
    }
    function stopSysPoll() { if (state.sysTimer) { clearInterval(state.sysTimer); state.sysTimer = null; } }
    function freeMem() {
      var btn = modal.querySelector('#lg-memfree'); var out = modal.querySelector('#lg-memfree-res');
      if (btn) { btn.disabled = true; btn.textContent = '释放中…'; }
      if (out) out.textContent = '';
      api('/mem/free', { method: 'POST', body: '{}' }).then(function (r) {
        if (btn) { btn.disabled = false; btn.innerHTML = I('zap', 12) + ' 一键释放内存'; }
        if (!out) return;
        if (!r.ok) { out.textContent = r.error || '失败'; return; }
        var res = r.result;
        out.textContent = '已收缩 ' + res.trimmed + ' 个进程工作集' + (res.skipped ? '（' + res.skipped + ' 个需管理员）' : '') + '，释放约 ' + Math.max(0, res.freedMB) + ' MB';
      });
    }

    // ============================================================
    // Tab 分发
    // ============================================================
    function renderTab() {
      stopSysPoll();
      if (state.tab === 'health') renderHealth();
      else if (state.tab === 'scan') renderScan();
      else if (state.tab === 'net') renderNet();
      else if (state.tab === 'sys') renderSys();
    }

    // ============================================================
    // DSH 原生设置卡片（RC7+：settings.section 插槽）
    // ============================================================
    /** 设置卡片 React 组件：读写宿主 /config，保存后运行时项立即生效 */
    function GuardSettingsSection(props) {
      var h = R.createElement.bind(R);
      var cfgState = R.useState(null);
      var cfg = cfgState[0], setCfg = cfgState[1];
      var busyState = R.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var msgState = R.useState('');
      var msg = msgState[0], setMsg = msgState[1];

      R.useEffect(function () {
        api('/config').then(function (r) {
          if (r.ok) setCfg(r.config);
          else { setCfg(null); setMsg(r.error || '卫士服务不可用（需重启 DSH 生效）'); }
        });
      }, []);

      if (!cfg) return h('div', { className: 'lg-muted' }, msg || '读取中…');

      function field(key, v) { setCfg(Object.assign({}, cfg, (function (o) { o[key] = v; return o; })({}))); setMsg(''); }
      function save() {
        setBusy(true);
        api('/config', { method: 'POST', body: JSON.stringify(cfg) }).then(function (r) {
          setBusy(false);
          if (r.ok) { setCfg(r.config); applyClientConfig(r.config); setMsg('已保存 ' + new Date().toLocaleTimeString()); }
          else setMsg(r.error || '保存失败');
        });
      }

      var rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px dashed var(--dsw-alias-border-l2,#222d45)' };
      var inputStyle = { width: '84px', background: 'var(--dsw-alias-bg-layer-0,transparent)', border: '1px solid var(--dsw-alias-border-l2,#31436b)', borderRadius: '6px', color: 'var(--dsw-alias-label-primary,#e8eef7)', padding: '4px 8px', fontSize: '12px' };
      var labelStyle = { color: 'var(--dsw-alias-label-primary,#e8eef7)', fontSize: '13px' };
      var descStyle = { color: 'var(--dsw-alias-label-tertiary,#7d8aa5)', fontSize: '11px', marginTop: '2px' };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '520px' } },
        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, '桌面通知'), h('div', { style: descStyle }, '查杀/分析完成时弹系统通知（仍需浏览器授权）')),
          h('input', { type: 'checkbox', checked: !!cfg.notify, onChange: function (e) { field('notify', e.target.checked); } })),
        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, '监控轮询间隔（秒）'), h('div', { style: descStyle }, '系统情况页 CPU/内存刷新频率')),
          h('input', { type: 'number', min: 1, max: 10, style: inputStyle, value: cfg.pollSec, onChange: function (e) { field('pollSec', parseInt(e.target.value, 10)); } })),
        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, '历史保留条数'), h('div', { style: descStyle }, '体检/查杀历史各保留多少条')),
          h('input', { type: 'number', min: 5, max: 100, style: inputStyle, value: cfg.historyMax, onChange: function (e) { field('historyMax', parseInt(e.target.value, 10)); } })),
        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, '测速下载量（MB）'), h('div', { style: descStyle }, '带宽测试下载的数据量，越大越准也越久')),
          h('input', { type: 'number', min: 5, max: 50, style: inputStyle, value: cfg.speedMB, onChange: function (e) { field('speedMB', parseInt(e.target.value, 10)); } })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' } },
          h('button', { className: 'lg-btn primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存设置'),
          h('span', { className: 'lg-muted' }, msg)),
        h('div', { className: 'lg-muted', style: { marginTop: '14px' } },
          '提示：通知与轮询保存后立即生效；历史条数与测速大小在下次对应操作时生效。')
      );
    }

    /** 客户端插件激活体：样式 + 按钮注入（MutationObserver 即时 + 兜底轮询，参照 dsh-balance） */
    function apply(ctx) {
      injectStyle();
      if (window.MutationObserver) {
        new MutationObserver(function () { injectRailButton(); }).observe(document.body || document.documentElement, { childList: true, subtree: true });
      }
      setInterval(injectRailButton, 1500);
      if (document.readyState !== 'loading') injectRailButton();
      else document.addEventListener('DOMContentLoaded', injectRailButton);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal && modal.style.display !== 'none') closeModal(); });
      // 页面刷新后恢复扫描守望：DSH 侧扫描仍在跑就重新挂上呼吸点与完成通知
      api('/scan/status').then(function (r) {
        if (r && r.running) { state.scan = r; startScanWatch(); setScanBadge(true); }
      });
      // 拉取配置应用运行时项（轮询间隔/通知开关）
      api('/config').then(function (r) { if (r.ok) applyClientConfig(r.config); });
      // 注册 DSH 原生设置卡片（RC7+；旧版或无 slots 服务时静默跳过）
      try {
        if (R && ctx && ctx.slots && ctx.slots.inject && ctx.slots.register) {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'liang-guard',
              order: 40,
              label: function () { return '梁神卫士'; },
              inject: function () { return {}; },
            }, GuardSettingsSection);
          });
        }
      } catch (e) { console.warn('[dsh-liang-guard] settings card registration skipped:', e); }
    }

    exports.apply = apply;
    // 声明依赖的 cordis 服务（runner 据此开放 ctx.slots；不声明会被服务门禁拦截）
    exports.inject = ['slots'];
    return module.exports;
  }
});
