<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TuringMarket CRM</title>
<style>
/* ===== CSS Reset & Variables ===== */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --primary:#4f6ef7;
  --primary-light:#eef1ff;
  --primary-dark:#3a56d4;
  --success:#22c55e;
  --warning:#f59e0b;
  --danger:#ef4444;
  --gray-50:#f9fafb;
  --gray-100:#f3f4f6;
  --gray-200:#e5e7eb;
  --gray-300:#d1d5db;
  --gray-400:#9ca3af;
  --gray-500:#6b7280;
  --gray-600:#4b5563;
  --gray-700:#374151;
  --gray-800:#1f2937;
  --gray-900:#111827;
  --radius:8px;
  --radius-sm:4px;
  --shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.06);
  --shadow-lg:0 4px 14px rgba(0,0,0,.1);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;
}
body{font-family:var(--font);background:#f0f2f5;color:var(--gray-800);font-size:14px;line-height:1.5;min-height:100vh}
a{color:var(--primary);text-decoration:none}
input,select,textarea,button{font-family:inherit;font-size:inherit;outline:none}
table{border-collapse:collapse;width:100%}
/* ===== Scrollbar ===== */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--gray-300);border-radius:3px}
/* ===== Top Nav ===== */
.topbar{background:#fff;border-bottom:1px solid var(--gray-200);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.topbar-brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;color:var(--gray-900)}
.topbar-brand svg{width:28px;height:28px}
.topbar-user{display:flex;align-items:center;gap:10px;color:var(--gray-500);font-size:13px}
/* ===== Page Layout ===== */
.page{padding:20px 24px;max-width:1400px;margin:0 auto}
/* ===== Stats Cards ===== */
.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:#fff;border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);transition:box-shadow .15s}
.stat-card:hover{box-shadow:var(--shadow-lg)}
.stat-card .label{font-size:12px;color:var(--gray-400);margin-bottom:4px}
.stat-card .value{font-size:22px;font-weight:700;color:var(--gray-800)}
.stat-card .sub{font-size:12px;color:var(--gray-400);margin-top:4px}
.stat-card.accent{border-left:3px solid var(--primary)}
.stat-card.success{border-left:3px solid var(--success)}
.stat-card.warning{border-left:3px solid var(--warning)}
/* ===== Tab Bar ===== */
.tab-bar{display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid var(--gray-200);background:#fff;border-radius:var(--radius) var(--radius) 0 0;overflow:hidden}
.tab-btn{padding:12px 20px;border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--gray-500);position:relative;transition:all .15s;white-space:nowrap}
.tab-btn:hover{color:var(--gray-700);background:var(--gray-50)}
.tab-btn.active{color:var(--primary);font-weight:600}
.tab-btn.active::after{content:'';position:absolute;bottom:-2px;left:0;right:0;height:2px;background:var(--primary)}
.tab-btn .badge{display:inline-block;background:var(--gray-100);color:var(--gray-600);font-size:11px;padding:1px 7px;border-radius:10px;margin-left:6px;font-weight:500}
.tab-btn.active .badge{background:var(--primary-light);color:var(--primary)}
/* ===== Toolbar ===== */
.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.toolbar .search-box{position:relative;flex:1;min-width:200px;max-width:360px}
.toolbar .search-box input{width:100%;padding:8px 12px 8px 34px;border:1px solid var(--gray-200);border-radius:var(--radius);background:#fff;transition:border-color .15s}
.toolbar .search-box input:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
.toolbar .search-box .icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--gray-400);font-size:14px}
.toolbar .filter-select{padding:8px 12px;border:1px solid var(--gray-200);border-radius:var(--radius);background:#fff;color:var(--gray-700);cursor:pointer}
.toolbar .filter-select:focus{border-color:var(--primary)}
/* ===== Buttons ===== */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;white-space:nowrap}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-dark)}
.btn-success{background:var(--success);color:#fff}
.btn-success:hover{background:#16a34a}
.btn-danger{background:#fff;color:var(--danger);border:1px solid var(--gray-200)}
.btn-danger:hover{background:#fef2f2;border-color:var(--danger)}
.btn-outline{background:#fff;color:var(--gray-600);border:1px solid var(--gray-200)}
.btn-outline:hover{background:var(--gray-50);border-color:var(--gray-300)}
.btn-sm{padding:4px 10px;font-size:12px}
.btn-ghost{background:transparent;color:var(--gray-500);padding:4px 8px}
.btn-ghost:hover{background:var(--gray-100);color:var(--gray-700)}
.btn-icon{width:32px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--radius)}
/* ===== Table ===== */
.table-wrap{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;overflow-x:auto}
table thead th{padding:10px 14px;text-align:left;font-weight:600;font-size:12px;color:var(--gray-500);text-transform:uppercase;letter-spacing:.03em;background:var(--gray-50);border-bottom:1px solid var(--gray-200);white-space:nowrap}
table tbody tr{cursor:pointer;transition:background .1s}
table tbody tr:hover{background:var(--gray-50)}
table tbody tr.selected{background:var(--primary-light)}
table tbody td{padding:10px 14px;border-bottom:1px solid var(--gray-100);vertical-align:middle;font-size:13px}
/* ===== Stage Badge ===== */
.stage-badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:500}
.stage-new_lead{background:#e0e7ff;color:#3730a3}
.stage-info_confirmed{background:#dbeafe;color:#1e40af}
.stage-analysis{background:#f3e8ff;color:#6b21a8}
.stage-proposal{background:#fef9c3;color:#854d0e}
.stage-kol_matching{background:#ffe4e6;color:#9f1239}
.stage-cooperation{background:#d1fae5;color:#065f46}
.stage-won{background:#d1fae5;color:#065f46}
.stage-lost{background:#fee2e2;color:#991b1b}
/* ===== Stage Select (inline) ===== */
.stage-select{padding:3px 8px;border:1px solid var(--gray-200);border-radius:var(--radius-sm);font-size:12px;cursor:pointer;background:#fff;max-width:120px}
/* ===== Pagination ===== */
.pagination{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--gray-50);border-top:1px solid var(--gray-200)}
.pagination .info{font-size:12px;color:var(--gray-400)}
.pagination .pages{display:flex;gap:4px}
.pagination .pages button{padding:4px 10px;border:1px solid var(--gray-200);border-radius:var(--radius-sm);background:#fff;color:var(--gray-600);cursor:pointer;font-size:12px}
.pagination .pages button:hover{background:var(--gray-50);border-color:var(--primary);color:var(--primary)}
.pagination .pages button.active{background:var(--primary);color:#fff;border-color:var(--primary)}
/* ===== Sidebar ===== */
.sidebar-overlay{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:200;opacity:0;visibility:hidden;transition:all .2s}
.sidebar-overlay.open{opacity:1;visibility:visible}
.sidebar{position:fixed;top:0;right:-520px;width:520px;height:100%;background:#fff;z-index:201;box-shadow:-4px 0 20px rgba(0,0,0,.12);transition:right .25s ease;display:flex;flex-direction:column}
.sidebar.open{right:0}
.sidebar-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--gray-200);flex-shrink:0}
.sidebar-header h3{font-size:16px;font-weight:600}
.sidebar-close{background:none;border:none;font-size:20px;cursor:pointer;color:var(--gray-400);padding:4px}
.sidebar-close:hover{color:var(--gray-600)}
.sidebar-body{flex:1;overflow-y:auto;padding:20px}
.sidebar-section{margin-bottom:24px}
.sidebar-section h4{font-size:13px;color:var(--gray-500);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--gray-100);text-transform:uppercase;letter-spacing:.03em}
.sidebar-section .field{margin-bottom:8px;display:flex}
.sidebar-section .field-label{width:90px;flex-shrink:0;color:var(--gray-400);font-size:13px}
.sidebar-section .field-value{flex:1;color:var(--gray-700);font-size:13px;word-break:break-all}
/* ===== Activity Timeline ===== */
.activity-list{list-style:none}
.activity-item{position:relative;padding-left:24px;padding-bottom:16px}
.activity-item::before{content:'';position:absolute;left:6px;top:4px;width:8px;height:8px;border-radius:50%;background:var(--gray-300)}
.activity-item::after{content:'';position:absolute;left:9px;top:16px;width:2px;height:calc(100% - 16px);background:var(--gray-100)}
.activity-item:last-child::after{display:none}
.activity-item .time{font-size:11px;color:var(--gray-400);margin-bottom:2px}
.activity-item .desc{font-size:13px;color:var(--gray-700)}
.activity-item .user{font-size:11px;color:var(--gray-400)}
/* ===== Modal ===== */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:300;display:flex;align-items:center;justify-content:center;opacity:0;visibility:hidden;transition:all .2s}
.modal-overlay.open{opacity:1;visibility:visible}
.modal{background:#fff;border-radius:var(--radius);width:480px;max-width:90vw;max-height:85vh;overflow-y:auto;box-shadow:var(--shadow-lg);transform:translateY(10px);transition:transform .2s}
.modal-overlay.open .modal{transform:translateY(0)}
.modal-header{padding:16px 20px;border-bottom:1px solid var(--gray-200);display:flex;align-items:center;justify-content:space-between}
.modal-header h3{font-size:16px;font-weight:600}
.modal-body{padding:20px}
.modal-footer{padding:12px 20px;border-top:1px solid var(--gray-200);display:flex;justify-content:flex-end;gap:8px}
/* ===== Form ===== */
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:13px;font-weight:500;color:var(--gray-700);margin-bottom:4px}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:8px 12px;border:1px solid var(--gray-200);border-radius:var(--radius);transition:border-color .15s;background:#fff}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
.form-group textarea{resize:vertical;min-height:60px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
/* ===== Customer Detail Info Grid ===== */
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.detail-item{}
.detail-item .lbl{font-size:11px;color:var(--gray-400);text-transform:uppercase}
.detail-item .val{font-size:13px;color:var(--gray-800)}
/* ===== Opportunities in sidebar ===== */
.opp-card{border:1px solid var(--gray-200);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px}
.opp-card .opp-title{font-weight:600;font-size:13px;color:var(--gray-800);margin-bottom:4px}
.opp-card .opp-meta{display:flex;gap:12px;font-size:12px;color:var(--gray-400)}
.opp-card .opp-meta span{}
.opp-progress{height:4px;background:var(--gray-100);border-radius:2px;margin-top:6px;overflow:hidden}
.opp-progress-bar{height:100%;border-radius:2px;transition:width .3s}
/* ===== Data board / Charts tabs ===== */
.data-board{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}
.data-board .chart-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.chart-box{border:1px solid var(--gray-100);border-radius:var(--radius);padding:16px}
.chart-box h5{font-size:13px;color:var(--gray-500);margin-bottom:12px}
/* ===== Empty State ===== */
.empty-state{text-align:center;padding:40px 20px;color:var(--gray-400)}
.empty-state .icon{font-size:48px;margin-bottom:8px}
.empty-state p{font-size:14px}
/* ===== Toast / Notifications ===== */
.toast-container{position:fixed;top:20px;right:20px;z-index:999;display:flex;flex-direction:column;gap:8px}
.toast{padding:12px 16px;border-radius:var(--radius);color:#fff;font-size:13px;box-shadow:var(--shadow-lg);animation:slideIn .25s;max-width:360px}
.toast.success{background:var(--success)}
.toast.error{background:var(--danger)}
.toast.warning{background:var(--warning)}
.toast.info{background:var(--primary)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
/* ===== Responsive ===== */
@media(max-width:768px){
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .sidebar{width:100%;right:-100%}
  .modal{width:95vw}
  .form-row{grid-template-columns:1fr}
  .tab-bar{overflow-x:auto}
  .data-board .chart-row{grid-template-columns:1fr}
}
/* ===== Misc ===== */
.flex{display:flex}
.flex-center{align-items:center}
.gap-8{gap:8px}
.gap-4{gap:4px}
.ml-auto{margin-left:auto}
.text-center{text-align:center}
.text-muted{color:var(--gray-400)}
.text-sm{font-size:12px}
.mt-8{margin-top:8px}
.mb-8{margin-bottom:8px}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-full{width:100%}
.hidden{display:none!important}
/* ===== M1 — Brand Intelligence Hub ===== */
.m1-container{padding:0}
.m1-stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.m1-stats-row .m1-stat-card{background:#fff;border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);border-left:3px solid var(--primary)}
.m1-stats-row .m1-stat-card .m1-stat-label{font-size:12px;color:var(--gray-400);margin-bottom:2px}
.m1-stats-row .m1-stat-card .m1-stat-value{font-size:22px;font-weight:700;color:var(--gray-800)}
.m1-stats-row .m1-stat-card .m1-stat-sub{font-size:11px;color:var(--gray-400);margin-top:2px}
.m1-stats-row .m1-stat-card.m1-stat-success{border-left-color:var(--success)}
.m1-stats-row .m1-stat-card.m1-stat-warning{border-left-color:var(--warning)}
.m1-toolbar{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.m1-search-box{position:relative;max-width:480px}
.m1-search-box input{width:100%;padding:10px 14px 10px 38px;border:1px solid var(--gray-200);border-radius:var(--radius);background:#fff;font-size:14px;transition:border-color .15s}
.m1-search-box input:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
.m1-search-box input:focus + .m1-search-icon{color:var(--primary)}
.m1-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gray-400);font-size:16px;pointer-events:none}
.m1-industry-filters{display:flex;gap:6px;flex-wrap:wrap}
.m1-industry-tag{padding:4px 12px;border:1px solid var(--gray-200);border-radius:20px;background:#fff;color:var(--gray-600);font-size:12px;cursor:pointer;transition:all .15s;user-select:none}
.m1-industry-tag:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}
.m1-industry-tag.m1-active{background:var(--primary);color:#fff;border-color:var(--primary)}
.m1-card-list{display:flex;flex-direction:column;gap:10px}
.m1-brand-card{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 18px;transition:box-shadow .15s,border-color .15s;border:2px solid transparent;position:relative}
.m1-brand-card:hover{box-shadow:var(--shadow-lg)}
.m1-brand-card.m1-card-archived{border-color:var(--warning);background:#fffbeb}
.m1-brand-card.m1-social-expanded{border-color:var(--primary);background:var(--primary-light)}
.m1-brand-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.m1-brand-info{flex:1;min-width:200px}
.m1-brand-name{font-size:16px;font-weight:700;color:var(--gray-900);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.m1-brand-name:hover{color:var(--primary)}
.m1-brand-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.m1-brand-tag{display:inline-block;padding:1px 8px;background:var(--gray-100);color:var(--gray-600);border-radius:10px;font-size:11px}
.m1-brand-market{font-size:12px;color:var(--gray-400);margin-top:2px}
.m1-brand-stats{display:flex;gap:16px;margin-top:8px;flex-wrap:wrap}
.m1-brand-stat{font-size:12px;color:var(--gray-500);display:inline-flex;align-items:center;gap:4px;cursor:help;border-bottom:1px dashed var(--gray-300)}
.m1-archived-badge{display:inline-block;padding:1px 8px;background:#fef3c7;color:#92400e;border-radius:10px;font-size:11px;font-weight:600;margin-left:6px}
.m1-brand-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}
.m1-brand-actions .btn{font-size:12px;padding:4px 10px}
/* M1 Highlight */
.m1-highlight{background:#fef08a;padding:0 2px;border-radius:2px;font-weight:600}
/* M1 Custom Tooltip */
.m1-tooltip{position:relative;display:inline-flex;align-items:center}
.m1-tooltip .m1-tooltip-text{visibility:hidden;opacity:0;width:200px;background:var(--gray-800);color:#fff;font-size:12px;padding:6px 10px;border-radius:6px;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:50;white-space:normal;text-align:center;transition:opacity .15s;pointer-events:none;line-height:1.4}
.m1-tooltip .m1-tooltip-text::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--gray-800)}
.m1-tooltip:hover .m1-tooltip-text{visibility:visible;opacity:1}
/* M1 Social Panel */
.m1-social-panel{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow-lg);margin-bottom:16px;overflow:hidden}
.m1-social-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--gray-50);border-bottom:1px solid var(--gray-200);font-weight:600;font-size:14px}
.m1-social-body{padding:16px;max-height:600px;overflow-y:auto}
.m1-social-platform{margin-bottom:20px}
.m1-social-platform:last-child{margin-bottom:0}
.m1-social-platform-title{font-size:14px;font-weight:600;color:var(--gray-700);margin-bottom:8px;padding-bottom:4px;border-bottom:2px solid var(--gray-100);display:flex;align-items:center;gap:8px}
.m1-social-platform-title .m1-platform-badge{font-size:11px;padding:1px 8px;border-radius:10px;background:var(--gray-100);color:var(--gray-500)}
.m1-video-item{display:grid;grid-template-columns:1fr 80px 60px 60px 80px;gap:8px;padding:8px 10px;border-bottom:1px solid var(--gray-100);font-size:12px;align-items:center}
.m1-video-item:last-child{border-bottom:none}
.m1-video-item:hover{background:var(--gray-50)}
.m1-video-item .m1-video-title{color:var(--gray-800);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m1-video-item .m1-video-meta{color:var(--gray-400);text-align:right}
.m1-video-item .m1-video-label{color:var(--gray-400);font-size:11px;text-align:right}
.m1-video-header{display:grid;grid-template-columns:1fr 80px 60px 60px 80px;gap:8px;padding:6px 10px;font-size:11px;color:var(--gray-400);background:var(--gray-50);border-bottom:1px solid var(--gray-200);font-weight:600}
.m1-video-header span{text-align:right}
.m1-video-header span:first-child{text-align:left}
/* M1 Similar Panel */
.m1-similar-panel{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow-lg);margin-bottom:16px;overflow:hidden}
.m1-similar-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--gray-50);border-bottom:1px solid var(--gray-200);font-weight:600;font-size:14px}
.m1-similar-body{padding:12px 16px}
.m1-similar-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--gray-100)}
.m1-similar-item:last-child{border-bottom:none}
.m1-similar-item .m1-similar-name{font-weight:600;color:var(--gray-800);cursor:pointer}
.m1-similar-item .m1-similar-name:hover{color:var(--primary)}
.m1-similar-item .m1-similar-industry{font-size:11px;color:var(--gray-400)}
/* M1 Empty State */
.m1-empty{padding:40px 20px;text-align:center;color:var(--gray-400);font-size:14px}
/* M1 Loading */
.m1-loading{text-align:center;padding:40px;color:var(--gray-400)}
.m1-loading::after{content:'';display:inline-block;width:20px;height:20px;border:2px solid var(--gray-200);border-top-color:var(--primary);border-radius:50%;animation:m1spin .6s linear infinite;margin-left:8px;vertical-align:middle}
@keyframes m1spin{to{transform:rotate(360deg)}}
/* M1 Sidebar brand-specific */
.m1-sidebar-desc{font-size:13px;color:var(--gray-600);line-height:1.6;margin-top:8px}
.m1-sidebar-section{margin-bottom:20px}
.m1-sidebar-section h4{font-size:13px;color:var(--gray-500);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--gray-100);text-transform:uppercase;letter-spacing:.03em}
.m1-sidebar-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.m1-sidebar-meta .m1-meta-item{}
.m1-sidebar-meta .m1-meta-item .m1-meta-label{font-size:11px;color:var(--gray-400);text-transform:uppercase}
.m1-sidebar-meta .m1-meta-item .m1-meta-value{font-size:13px;color:var(--gray-800)}
@media(max-width:768px){
  .m1-video-item,.m1-video-header{grid-template-columns:1fr 60px 50px 50px 60px;font-size:11px}
  .m1-sidebar-meta{grid-template-columns:1fr}
}
/* ===== M2 — Strategy Planning ===== */
.m2-container{padding:0}
.m2-layout{display:grid;grid-template-columns:350px 1fr;gap:20px;min-height:600px}
.m2-form-section{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}
.m2-form-section h3,.m2-result-section h3{font-size:16px;font-weight:600;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--gray-100)}
.m2-result-section{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}
.m2-result-content{line-height:1.8;font-size:14px;color:var(--gray-700)}
.m2-result-content h2{font-size:18px;font-weight:700;color:var(--gray-900);margin:20px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--primary)}
.m2-result-content h3{font-size:15px;font-weight:600;color:var(--gray-800);margin:16px 0 8px}
.m2-result-content h4{font-size:14px;font-weight:600;color:var(--gray-700);margin:12px 0 6px}
.m2-result-content li{margin:4px 0 4px 20px;color:var(--gray-700);list-style:disc}
.m2-result-content p{margin:6px 0}
.m2-controls{display:flex;align-items:center;gap:12px;margin-top:20px;padding-top:16px;border-top:1px solid var(--gray-100)}
.m2-toggle{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--gray-600);cursor:pointer;user-select:none}
.m2-toggle input[type="checkbox"]{width:16px;height:16px;cursor:pointer}
.m2-error{padding:20px;background:#fef2f2;color:var(--danger);border-radius:var(--radius);border:1px solid #fecaca}
@media(max-width:768px){.m2-layout{grid-template-columns:1fr}}
/* ===== M3 — Demand & Proposal ===== */
.m3-container{padding:0}
.m3-layout{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.m3-section{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}
.m3-section h3{font-size:16px;font-weight:600;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--gray-100)}
.m3-upload-area{border:2px dashed var(--gray-300);border-radius:var(--radius);padding:40px 20px;text-align:center;cursor:pointer;transition:all .15s;background:var(--gray-50)}
.m3-upload-area:hover{border-color:var(--primary);background:var(--primary-light)}
.m3-upload-area.dragover{border-color:var(--primary);background:var(--primary-light)}
.m3-upload-area .icon{font-size:40px;margin-bottom:12px;color:var(--gray-400)}
.m3-upload-area .text{font-size:14px;color:var(--gray-600)}
.m3-upload-area .sub{font-size:12px;color:var(--gray-400);margin-top:4px}
.m3-analysis-summary{background:var(--gray-50);border-radius:var(--radius);padding:12px 16px;margin-top:12px;font-size:13px;line-height:1.6}
.m3-analysis-summary .label{font-weight:600;color:var(--gray-700);margin-bottom:4px}
.m3-editable{width:100%;min-height:200px;padding:12px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:14px;line-height:1.6;resize:vertical;margin-top:12px;font-family:var(--font)}
.m3-editable:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
.m3-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.m3-file-info{font-size:12px;color:var(--gray-400);padding:8px 0;display:flex;align-items:center;gap:8px}
.m3-file-info .remove{cursor:pointer;color:var(--danger);font-size:16px;font-weight:700}
.m3-file-info .remove:hover{color:#dc2626}
@media(max-width:768px){.m3-layout{grid-template-columns:1fr}}
/* ===== M4 — Influencer Matching ===== */
.m4-container{padding:0}
.m4-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.m4-toolbar .filter-select{padding:6px 10px;border:1px solid var(--gray-200);border-radius:var(--radius);background:#fff;font-size:13px;color:var(--gray-700);max-width:160px}
.m4-stats{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.m4-stat{font-size:13px;color:var(--gray-500)}
.m4-stat strong{color:var(--gray-800)}
.m4-tabs{display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--gray-200);background:#fff;border-radius:var(--radius) var(--radius) 0 0;overflow:hidden}
.m4-tab{padding:8px 16px;border:none;background:transparent;cursor:pointer;font-size:13px;color:var(--gray-500);position:relative;transition:all .15s}
.m4-tab:hover{color:var(--gray-700);background:var(--gray-50)}
.m4-tab.active{color:var(--primary);font-weight:600}
.m4-tab.active::after{content:'';position:absolute;bottom:-2px;left:0;right:0;height:2px;background:var(--primary)}
.m4-status-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.m4-status-submitted{background:#e0e7ff;color:#3730a3}
.m4-status-active{background:#d1fae5;color:#065f46}
.m4-status-completed{background:#f3f4f6;color:#6b7280}
.m4-table-wrap{overflow-x:auto;background:#fff;border-radius:var(--radius);box-shadow:var(--shadow)}
.m4-table-wrap table{font-size:12px}
.m4-table-wrap th{white-space:nowrap;padding:8px 10px;background:var(--gray-50);font-weight:600;color:var(--gray-500);text-transform:uppercase;font-size:11px;border-bottom:1px solid var(--gray-200);text-align:left}
.m4-table-wrap td{padding:8px 10px;border-bottom:1px solid var(--gray-100);vertical-align:middle}
/* ===== M5 — AI Assistant ===== */
.m5-container{padding:0;display:flex;flex-direction:column}
.m5-chat-area{flex:1;overflow-y:auto;padding:16px;background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:12px;min-height:500px;max-height:calc(100vh - 250px)}
.m5-message{max-width:80%;margin-bottom:12px;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;position:relative;word-wrap:break-word}
.m5-user{background:var(--primary);color:#fff;margin-left:auto;border-bottom-right-radius:4px}
.m5-assistant{background:var(--gray-100);color:var(--gray-800);margin-right:auto;border-bottom-left-radius:4px}
.m5-system{background:#fef3c7;color:#92400e;margin:0 auto;border-radius:8px;font-size:12px;text-align:center;max-width:80%}
.m5-message-time{font-size:10px;color:var(--gray-400);margin-top:2px;text-align:right}
.m5-user .m5-message-time{color:rgba(255,255,255,.7)}
.m5-input-area{display:flex;gap:8px;background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:12px;align-items:flex-end}
.m5-input-area textarea{flex:1;padding:10px 14px;border:1px solid var(--gray-200);border-radius:var(--radius);resize:none;font-size:14px;line-height:1.4;min-height:44px;max-height:120px;font-family:var(--font)}
.m5-input-area textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
.m5-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.m5-toggle{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--gray-500);cursor:pointer}
.m5-toggle input[type="checkbox"]{width:14px;height:14px;cursor:pointer}
.m5-typing{display:flex;gap:4px;align-items:center;padding:4px 0}
.m5-typing .dot{width:6px;height:6px;border-radius:50%;background:var(--gray-400);animation:m5-bounce 1.4s infinite}
.m5-typing .dot:nth-child(2){animation-delay:.2s}
.m5-typing .dot:nth-child(3){animation-delay:.4s}
@keyframes m5-bounce{0%,80%,100%{transform:scale(.6)}40%{transform:scale(1)}}
.m5-empty{text-align:center;padding:60px 20px;color:var(--gray-400)}
.m5-empty .icon{font-size:48px;margin-bottom:12px}
.m5-title{font-size:16px;font-weight:600;margin-bottom:12px}
.m5-loading{text-align:center;padding:20px;color:var(--gray-400)}
.m5-loading::after{content:'';display:inline-block;width:16px;height:16px;border:2px solid var(--gray-200);border-top-color:var(--primary);border-radius:50%;animation:m1spin .6s linear infinite;margin-left:6px;vertical-align:middle}
.m5-thinking{background:var(--gray-50);border:1px dashed var(--gray-300);padding:12px 16px;border-radius:var(--radius);margin:8px 0;font-size:13px;color:var(--gray-500);line-height:1.5}
/* ===== Admin — Control Room ===== */
.admin-container{padding:0}
.admin-section{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;margin-bottom:16px}
.admin-section h3{font-size:16px;font-weight:600;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--gray-100)}
.admin-section h4{font-size:14px;font-weight:600;margin-bottom:12px;color:var(--gray-700)}
.admin-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.admin-stat-card{background:var(--gray-50);border-radius:var(--radius);padding:14px;border-left:3px solid var(--primary)}
.admin-stat-card .label{font-size:11px;color:var(--gray-400);text-transform:uppercase}
.admin-stat-card .value{font-size:22px;font-weight:700;color:var(--gray-800)}
.admin-stat-card.success{border-left-color:var(--success)}
.admin-stat-card.warning{border-left-color:var(--warning)}
.admin-sub-tabs{display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--gray-200);background:#fff;border-radius:var(--radius) var(--radius) 0 0;overflow:hidden}
.admin-sub-tab{padding:8px 16px;border:none;background:transparent;cursor:pointer;font-size:13px;color:var(--gray-500);position:relative;transition:all .15s}
.admin-sub-tab:hover{color:var(--gray-700);background:var(--gray-50)}
.admin-sub-tab.active{color:var(--primary);font-weight:600}
.admin-sub-tab.active::after{content:'';position:absolute;bottom:-2px;left:0;right:0;height:2px;background:var(--primary)}
.admin-user-status{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.admin-user-status.active{background:var(--success)}
.admin-user-status.inactive{background:var(--gray-300)}
.admin-table{width:100%;border-collapse:collapse}
.admin-table th{padding:8px 12px;text-align:left;font-weight:600;font-size:12px;color:var(--gray-500);text-transform:uppercase;background:var(--gray-50);border-bottom:1px solid var(--gray-200);white-space:nowrap}
.admin-table td{padding:8px 12px;border-bottom:1px solid var(--gray-100);font-size:13px;vertical-align:middle}
.admin-table tr:hover{background:var(--gray-50)}
/* ===== KB — Knowledge Base ===== */
.kb-container{padding:0}
.kb-layout{display:grid;grid-template-columns:280px 1fr;gap:20px;min-height:600px}
.kb-sidebar{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:16px}
.kb-sidebar h3{font-size:15px;font-weight:600;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--gray-100)}
.kb-main{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}
.kb-main h3{font-size:16px;font-weight:600;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--gray-100)}
.kb-entry{border:1px solid var(--gray-200);border-radius:var(--radius);padding:12px 16px;margin-bottom:8px;cursor:pointer;transition:all .1s}
.kb-entry:hover{border-color:var(--primary);background:var(--primary-light)}
.kb-entry .title{font-size:14px;font-weight:600;color:var(--gray-800);margin-bottom:4px}
.kb-entry .meta{font-size:11px;color:var(--gray-400);display:flex;gap:12px}
.kb-entry .preview{font-size:12px;color:var(--gray-500);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-category-item{padding:6px 10px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;color:var(--gray-600);transition:all .1s}
.kb-category-item:hover{background:var(--gray-50);color:var(--primary)}
.kb-category-item.active{background:var(--primary-light);color:var(--primary);font-weight:600}
.kb-detail-content{font-size:14px;line-height:1.7;color:var(--gray-700)}
.kb-detail-meta{font-size:12px;color:var(--gray-400);padding:8px 0;display:flex;gap:16px;flex-wrap:wrap}
.kb-empty{text-align:center;padding:60px 20px;color:var(--gray-400)}
.kb-loading{text-align:center;padding:40px;color:var(--gray-400)}
.kb-tag{display:inline-block;padding:1px 6px;background:var(--gray-100);color:var(--gray-500);border-radius:4px;font-size:10px;margin:1px}
@media(max-width:768px){.kb-layout{grid-template-columns:1fr}}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    TuringMarket CRM
  </div>
  <div class="topbar-user">
    <span id="currentUserDisplay"></span>
    <button class="btn btn-outline btn-sm" onclick="M0.logout()">退出</button>
  </div>
</div>

<div class="page" id="app">
  <!-- Stats Cards -->
  <div class="stats-row" id="statsRow"></div>

  <!-- Tab Bar -->
  <div class="tab-bar" id="tabBar">
    <button class="tab-btn active" data-tab="my">我的客户</button>
    <button class="tab-btn" data-tab="team">团队客户</button>
    <button class="tab-btn" data-tab="pool">公海池</button>
    <button class="tab-btn" data-tab="opportunities">商机管理</button>
    <button class="tab-btn" data-tab="board">数据看板</button>
    <button class="tab-btn" data-tab="brands" onclick="M1.switchToBrandHub()">品牌智库</button>
    <button class="tab-btn" data-tab="m2" onclick="M2.switchToM2()">策略规划</button>
    <button class="tab-btn" data-tab="m3" onclick="M3.switchToM3()">需求方案</button>
    <button class="tab-btn" data-tab="m4" onclick="M4.switchToM4()">网红匹配</button>
    <button class="tab-btn" data-tab="m5" onclick="M5.switchToM5()">AI助手</button>
    <button class="tab-btn" data-tab="admin" onclick="Admin.switchToAdmin()">管理</button>
    <button class="tab-btn" data-tab="kb" onclick="KB.switchToKB()">知识库</button>
  </div>

  <!-- Toolbar (visible for list tabs) -->
  <div class="toolbar" id="toolbar">
    <div class="search-box">
      <span class="icon">&#128269;</span>
      <input type="text" id="searchInput" placeholder="搜索品牌/公司..." oninput="M0.onSearch()">
    </div>
    <select class="filter-select" id="stageFilter" onchange="M0.onStageFilter()">
      <option value="">全部阶段</option>
    </select>
    <div class="flex flex-center gap-8 ml-auto">
      <span class="text-muted text-sm" id="totalLabel"></span>
      <button class="btn btn-primary" id="addCustomerBtn" onclick="M0.showAddModal()">+ 新增客户</button>
    </div>
  </div>

  <!-- Table -->
  <div class="table-wrap" id="tableWrap">
    <table>
      <thead>
        <tr>
          <th>品牌名</th>
          <th>公司</th>
          <th>阶段</th>
          <th>负责人</th>
          <th>商机金额</th>
          <th>来源</th>
          <th>更新时间</th>
          <th style="width:100px">操作</th>
        </tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="8"><div class="empty-state"><p>加载中...</p></div></td></tr>
      </tbody>
    </table>
    <div class="pagination" id="pagination">
      <span class="info"></span>
      <div class="pages"></div>
    </div>
  </div>

  <!-- Opportunities Table (shown in opp tab) -->
  <div class="table-wrap hidden" id="oppTableWrap">
    <table>
      <thead>
        <tr>
          <th>商机名称</th>
          <th>客户</th>
          <th>金额</th>
          <th>阶段</th>
          <th>概率</th>
          <th>负责人</th>
          <th>预计成交</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="oppTableBody"></tbody>
    </table>
    <div class="pagination" id="oppPagination">
      <span class="info"></span>
      <div class="pages"></div>
    </div>
  </div>

  <!-- Data Board -->
  <div class="data-board hidden" id="dataBoard">
    <div class="chart-row">
      <div class="chart-box">
        <h5>客户阶段分布</h5>
        <div id="stageChart" style="min-height:200px"></div>
      </div>
      <div class="chart-box">
        <h5>商机阶段分布</h5>
        <div id="oppChart" style="min-height:200px"></div>
      </div>
    </div>
    <div class="chart-row">
      <div class="chart-box">
        <h5>本月数据概览</h5>
        <div id="monthlyStats" style="min-height:120px"></div>
      </div>
      <div class="chart-box">
        <h5>最近活动</h5>
        <div id="recentActivity" style="min-height:200px"></div>
      </div>
    </div>
  </div>
</div>

<!-- ========================================================================= -->
<!-- M1 — BRAND INTELLIGENCE HUB (品牌智库) -->
<!-- ========================================================================= -->
<div class="m1-container hidden" id="m1Container">

  <!-- M1 Stats -->
  <div class="m1-stats-row" id="m1StatsRow"></div>

  <!-- M1 Toolbar -->
  <div class="m1-toolbar" id="m1Toolbar">
    <div class="m1-search-box">
      <span class="m1-search-icon">&#128269;</span>
      <input type="text" id="m1SearchInput" placeholder="搜索品牌名 / 行业 / 市场..." autocomplete="off">
    </div>
    <div class="m1-industry-filters" id="m1IndustryFilters"></div>
  </div>

  <!-- M1 Brand List (Card Layout) -->
  <div class="m1-card-list" id="m1BrandList"></div>

  <!-- M1 Social Media Panel (expandable) -->
  <div class="m1-social-panel hidden" id="m1SocialPanel">
    <div class="m1-social-header">
      <span id="m1SocialBrandName"></span>
      <button class="btn btn-ghost btn-sm" onclick="M1.closeSocialPanel()">&times; 关闭</button>
    </div>
    <div class="m1-social-body" id="m1SocialBody"></div>
  </div>

  <!-- M1 Similar Brands Panel -->
  <div class="m1-similar-panel hidden" id="m1SimilarPanel">
    <div class="m1-similar-header">
      <span>相似品牌推荐</span>
      <button class="btn btn-ghost btn-sm" onclick="M1.closeSimilarPanel()">&times; 关闭</button>
    </div>
    <div class="m1-similar-body" id="m1SimilarBody"></div>
  </div>

</div>

<!-- ===== M2 — STRATEGY PLANNING ===== -->
<div class="m2-container hidden" id="m2Container"><div class="page" id="m2Content"></div></div>

<!-- ===== M3 — DEMAND & PROPOSAL ===== -->
<div class="m3-container hidden" id="m3Container"><div class="page" id="m3Content"></div></div>

<!-- ===== M4 — INFLUENCER MATCHING ===== -->
<div class="m4-container hidden" id="m4Container"><div class="page" id="m4Content"></div></div>

<!-- ===== M5 — AI ASSISTANT ===== -->
<div class="m5-container hidden" id="m5Container"><div class="page" id="m5Content"></div></div>

<!-- ===== ADMIN — CONTROL ROOM ===== -->
<div class="admin-container hidden" id="adminContainer"><div class="page" id="adminContent"></div></div>

<!-- ===== KB — KNOWLEDGE BASE ===== -->
<div class="kb-container hidden" id="kbContainer"><div class="page" id="kbContent"></div></div>

<!-- ===== ADMIN MODALS ===== -->
<div class="modal-overlay" id="adminUserModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="adminUserModalTitle">用户管理</h3>
      <button class="sidebar-close" onclick="Admin.closeUserModal()">&times;</button>
    </div>
    <div class="modal-body" id="adminUserModalBody"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="Admin.closeUserModal()">取消</button>
      <button class="btn btn-primary" onclick="Admin.saveUser()">保存</button>
    </div>
  </div>
</div>

<!-- M1 Brand Detail Sidebar -->
<div class="sidebar-overlay" id="m1SidebarOverlay" onclick="M1.closeSidebar()"></div>
<div class="sidebar" id="m1Sidebar">
  <div class="sidebar-header">
    <h3 id="m1SidebarTitle">品牌详情</h3>
    <button class="sidebar-close" onclick="M1.closeSidebar()">&times;</button>
  </div>
  <div class="sidebar-body" id="m1SidebarBody"></div>
</div>

<!-- M0 Detail Sidebar -->
<div class="sidebar-overlay" id="sidebarOverlay" onclick="M0.closeSidebar()"></div>
<div class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <h3 id="sidebarTitle">客户详情</h3>
    <button class="sidebar-close" onclick="M0.closeSidebar()">&times;</button>
  </div>
  <div class="sidebar-body" id="sidebarBody"></div>
</div>

<!-- Customer Modal -->
<div class="modal-overlay" id="custModalOverlay">
  <div class="modal">
    <div class="modal-header">
      <h3 id="custModalTitle">新增客户</h3>
      <button class="sidebar-close" onclick="M0.closeCustModal()">&times;</button>
    </div>
    <div class="modal-body" id="custModalBody"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="M0.closeCustModal()">取消</button>
      <button class="btn btn-primary" id="custModalSave" onclick="M0.saveCustomer()">保存</button>
    </div>
  </div>
</div>

<!-- Opportunity Modal -->
<div class="modal-overlay" id="oppModalOverlay">
  <div class="modal">
    <div class="modal-header">
      <h3 id="oppModalTitle">新增商机</h3>
      <button class="sidebar-close" onclick="M0.closeOppModal()">&times;</button>
    </div>
    <div class="modal-body" id="oppModalBody"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="M0.closeOppModal()">取消</button>
      <button class="btn btn-primary" onclick="M0.saveOpportunity()">保存</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast-container" id="toastContainer"></div>

<script src="https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js"></script>
<script src="js/shared/utils.js"></script>
<script src="js/shared/dom.js"></script>
<script src="js/modules/m0-customer.js"></script>
<script src="js/modules/m1-brand.js"></script>
<script src="js/modules/m2-strategy.js"></script>
<script src="js/modules/m3-demand.js"></script>
<script src="js/modules/m4-influencer.js"></script>
<script src="js/modules/m5-assistant.js"></script>
<script src="js/modules/admin.js"></script>
<script src="js/modules/kb.js"></script>
<script src="js/app.js"></script>
</body>
</html>

