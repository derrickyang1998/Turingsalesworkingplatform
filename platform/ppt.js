// ===== TuringMarket HTML PPT Generator (reveal.js) =====
// Based on 20+ past proposals from vault: D:\主盘\图灵集市
// Format: Cover -> About Turing -> Market/Challenge -> Strategy -> Influencer Matrix -> Timeline -> KPI -> Next Steps

var lastPPT = "";

// TuringMarket boilerplate (from vault intro doc)
var TM_BOILERPLATE = [
  "全球首个按效果付费海外红人Agent | www.turingmarket.cn",
  "团队来自大疆、安克、传音等头部品牌，平均海外红人营销经验7年+",
  "自有AI红人库收录海外达人7000万+，累计服务出海品牌客户500+",
  "全球布局：深圳·北京·杭州·纽约",
  "服务模式：红人筛选→建联→脚本→内容审核→上线追踪→复盘报告",
  "覆盖行业：3C、储能、智能家居、美妆、户外、出行、医疗、宠物等12+领域",
  "方法论核心：60-30-10 ROI优化模型 + Nano/Micro为主策略"
];

async function generateHTMLPPT() {
  if (!curDemand) { toast("请先完成AI分析", "error"); return }
  var btn = document.getElementById("btnGenPPT");
  if (btn) { btn.disabled = true; btn.textContent = "DeepSeek 生成中..."; }
  
  try {
    // Build comprehensive prompt based on TuringMarket proposal format
    var ctx = [];
    ctx.push("你是图灵集市(TuringMarket)的海外红人营销策略专家。请根据以下客户需求，生成一份专业的HTML演示文稿内容。");
    ctx.push("");
    ctx.push("=== 图灵集市介绍(必须融入方案) ===");
    TM_BOILERPLATE.forEach(function(l) { ctx.push(l); });
    ctx.push("");
    ctx.push("=== 客户需求 ===");
    ctx.push("品牌: " + (curDemand.brand || ""));
    ctx.push("产品: " + (curDemand.product || ""));
    ctx.push("核心卖点(USP): " + (curDemand.usp || ""));
    ctx.push("行业: " + (curDemand.category || ""));
    ctx.push("目标市场: " + (curDemand.area || ""));
    ctx.push("预算: " + (curDemand.budget || ""));
    ctx.push("推广平台: " + (curDemand.platform || ""));
    ctx.push("竞品: " + (curDemand.competitors || ""));
    ctx.push("备注: " + (curDemand.notes || ""));
    
    // Add industry benchmarks from brand database
    var mb = BRANDS.filter(function(b) {
      return b.industry_tags.some(function(t) { return (curDemand.category || "").indexOf(t) >= 0 });
    }).slice(0, 5);
    if (mb.length) {
      ctx.push("");
      ctx.push("=== 行业对标品牌数据 ===");
      mb.forEach(function(b) {
        ctx.push("- " + b.name + ": 粉丝量 " + ((b.overseas_presence?.social_followers?.youtube || 0) / 1000).toFixed(0) + "K+, 月社媒发布 " + (b.social_content_monthly?.last_12_months?.posts_per_month || "N/A") + " 条, 预估年销 " + (b.est_annual_revenue || "N/A"));
      });
    }
    
    ctx.push("");
    ctx.push("=== PPT 结构要求 (10-12页) ===");
    ctx.push("1. 封面(cover): 品牌+产品名 + 副标题 + TuringMarket");
    ctx.push("2. 关于图灵(team): 图灵集市核心能力(用上述介绍)");
    ctx.push("3. 案例展示(content): 同行业过往案例(用上述品牌数据)");
    ctx.push("4. 市场洞察(content): " + (curDemand.area || "目标市场") + "市场机会分析");
    ctx.push("5. 客户挑战(content): 竞品环境、传播难点、转化难点");
    ctx.push("6. 核心策略(content): 60-30-10模型 + 差异化内容策略");
    ctx.push("7. 红人矩阵(stats): 分层创作者矩阵(头部/垂类/KOC) + 预算分配");
    ctx.push("8. 平台策略(content): " + (curDemand.platform || "多平台") + "差异化内容方案");
    ctx.push("9. 预算分配(stats): 预算明细 + 预期产出");
    ctx.push("10. 执行排期(timeline): 3阶段里程碑(测试期/放量期/优化期)");
    ctx.push("11. KPI预估(kpi): 可量化效果指标(曝光/互动/转化/ROI)");
    ctx.push("12. 下一步(next): 合作流程 + 联系方式");
    ctx.push("");
    ctx.push("=== 输出格式 ===");
    ctx.push('返回JSON: {"title":"方案标题","subtitle":"副标题(含TuringMarket)","sections":[{"title":"页标题","type":"cover|content|stats|timeline|team|kpi|next","points":["要点1:说明","要点2:说明"],"note":"补充"}]}');
    ctx.push("要求: 专业、数据驱动、体现TuringMarket行业深度。stats类型用'数字:标签'格式。每页3-5个要点。");
    
    var prompt = ctx.join("\n");
    
    var r = await apiFetch("/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        message: prompt,
        allow_web: true,
        source_module: "ppt",
        business_type: "proposal",
        summary_visibility: "team",
        max_tokens: 4000
      })
    });

    if (!r.ok) throw new Error("API:" + r.status);
    var d = await r.json();
    var reply = d.answer || "";
    
    var parsed = {};
    try {
      var m = reply.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (e) {
      console.error("JSON parse failed:", e.message);
    }
    
    if (!parsed.sections || !parsed.sections.length) {
      toast("AI PPT 生成失败，请重试", "error");
      if (btn) { btn.disabled = false; btn.textContent = "生成 HTML PPT"; }
      return;
    }
    
    var html = buildRevealHTML(parsed);
    
    try {
      await apiFetch("/proposals", {
        method: "POST",
        body: JSON.stringify({
          demand_id: null,
          template_id: "ppt_html",
          content: JSON.stringify(parsed)
        })
      });
    } catch (e) {}
    
    // Show result in UI
    var out = document.getElementById("proposalOutput");
    out.innerHTML = [
      '<div style="padding:16px">',
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">',
      '<span style="font-size:24px">&#x1F4CA;</span>',
      '<div><h3 style="margin:0">' + esc(parsed.title || "方案") + '</h3>',
      '<p style="opacity:.5;font-size:11px;margin:0">' + parsed.sections.length + ' 页幻灯片 · 基于图灵方案模板 · 可下载编辑</p></div>',
      '</div>',
      '<div style="display:flex;gap:8px;flex-wrap:wrap">',
      '<button class="btn btn-primary btn-sm" onclick="downloadHTMLPPT()">&#x1F4E5; 下载可编辑 HTML 文件</button>',
      '<button class="btn btn-outline btn-sm" onclick="previewPPT()">&#x1F4FA; 新窗口预览</button>',
      '<button class="btn btn-outline btn-sm" onclick="copyPPTSource()">&#x1F4CB; 复制源码</button>',
      '</div>',
      '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:11px;opacity:.5">查看幻灯片大纲</summary>',
      '<div style="font-size:11px;opacity:.7;margin-top:8px;max-height:200px;overflow-y:auto">',
      parsed.sections.map(function(s,i){ return '<div style="padding:4px 0">'+(i+1)+'. <strong>'+esc(s.title||"")+'</strong> <span style="opacity:.4">['+s.type+']</span></div>' }).join(""),
      '</div></details>',
      '</div>'
    ].join("\n");
    out.classList.remove("hidden");
    out.scrollIntoView({ behavior: "smooth" });
    
    lastPPT = html;
    lastPPTSource = JSON.stringify(parsed, null, 2);
    toast("PPT 生成成功: " + parsed.sections.length + " 页");
    
  } catch (e) {
    toast("PPT 生成失败: " + e.message, "error");
    console.error("PPT error:", e);
  }
  if (btn) { btn.disabled = false; btn.textContent = "生成 HTML PPT"; }
}

var lastPPTSource = "";

function buildRevealHTML(data) {
  var slides = (data.sections || []);
  
  var h = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n';
  h += '<meta charset="UTF-8">\n';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">\n';
  h += '<title>' + esc(data.title || "TuringMarket 方案") + '</title>\n';
  h += '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/dist/reveal.css">\n';
  h += '<link rel="stylesheet" href="node_modules/reveal.js/dist/theme/black.css">\n';
  h += '<style>\n';
  h += ':root{--r-heading-font:"PingFang SC","Microsoft YaHei",sans-serif;--r-main-font:"PingFang SC","Microsoft YaHei",sans-serif}\n';
  h += '.reveal .slides section{text-align:left;padding:40px 60px}\n';
  h += '.cover-slide{text-align:center!important;display:flex!important;flex-direction:column;justify-content:center;align-items:center}\n';
  h += '.cover-slide h1{font-size:2.6em;font-weight:800;margin-bottom:16px;letter-spacing:-0.02em}\n';
  h += '.cover-slide .subtitle{font-size:1.3em;opacity:.7;margin-bottom:40px}\n';
  h += '.cover-slide .meta{font-size:.85em;opacity:.5}\n';
  h += '.section-title{font-size:.7em!important;opacity:.4!important;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px!important}\n';
  h += '.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}\n';
  h += '.stats-grid-3{grid-template-columns:1fr 1fr 1fr}\n';
  h += '.stat-card{background:rgba(255,255,255,.04);padding:20px;border-radius:12px}\n';
  h += '.stat-card .num{font-size:1.8em;font-weight:800;color:#635bff;line-height:1.2}\n';
  h += '.stat-card .label{font-size:.75em;opacity:.6;margin-top:6px}\n';
  h += 'ul{font-size:.85em;line-height:1.9}\n';
  h += 'li{margin-bottom:6px}\n';
  h += '.tm-watermark{position:absolute;bottom:20px;right:40px;font-size:.45em;opacity:.3}\n';
  h += 'table{width:100%;font-size:.75em;border-collapse:collapse;margin-top:12px}\n';
  h += 'th{text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,.15);opacity:.5;font-size:.7em;text-transform:uppercase;letter-spacing:.05em}\n';
  h += 'td{padding:8px;border-bottom:1px solid rgba(255,255,255,.06)}\n';
  h += '</style>\n</head>\n<body>\n';
  h += '<div class="reveal"><div class="slides">\n';
  
  slides.forEach(function(sec) {
    var t = sec.type || "content";
    
    if (t === "cover") {
      h += '<section class="cover-slide">\n';
      h += '  <p class="section-title">TuringMarket | ' + esc(data.subtitle || "") + '</p>\n';
      h += '  <h1>' + esc(sec.title || data.title || "") + '</h1>\n';
      if (sec.points && sec.points[0]) h += '  <p class="subtitle">' + esc(sec.points[0]) + '</p>\n';
      h += '  <div class="meta">www.turingmarket.cn | 深圳·北京·杭州·纽约</div>\n';
      h += '</section>\n';
      
    } else if (t === "team") {
      h += '<section>\n';
      h += '  <p class="section-title">关于图灵</p>\n';
      h += '  <h2>' + esc(sec.title || "关于图灵集市") + '</h2>\n';
      h += '  <ul>\n';
      (sec.points || []).forEach(function(p) { h += '    <li>' + esc(p) + '</li>\n'; });
      h += '  </ul>\n';
      h += '  <div class="tm-watermark">TuringMarket | www.turingmarket.cn</div>\n';
      h += '</section>\n';
      
    } else if (t === "stats") {
      var gridClass = (sec.points || []).length <= 4 ? "stats-grid" : "stats-grid stats-grid-3";
      h += '<section>\n';
      h += '  <p class="section-title">' + esc(data.subtitle || "") + '</p>\n';
      h += '  <h2>' + esc(sec.title || "数据概览") + '</h2>\n';
      h += '  <div class="' + gridClass + '">\n';
      (sec.points || []).forEach(function(p) {
        var parts = p.split(":");
        var num = esc(parts[0] || "");
        var label = esc(parts.slice(1).join(":") || "");
        h += '    <div class="stat-card"><div class="num">' + num + '</div><div class="label">' + label + '</div></div>\n';
      });
      h += '  </div>\n';
      if (sec.note) h += '  <div class="tm-watermark">' + esc(sec.note) + '</div>\n';
      h += '</section>\n';
      
    } else if (t === "timeline") {
      h += '<section>\n';
      h += '  <p class="section-title">执行排期</p>\n';
      h += '  <h2>' + esc(sec.title || "项目排期") + '</h2>\n';
      h += '  <table>\n';
      h += '    <thead><tr><th>阶段</th><th>时间</th><th>核心动作</th><th>产出</th></tr></thead>\n';
      h += '    <tbody>\n';
      (sec.points || []).forEach(function(p, i) {
        var parts = p.split("|");
        var phase = "Phase " + (i + 1);
        var time = parts[0] || "-";
        var action = parts[1] || p;
        var output = parts[2] || "-";
        h += '      <tr><td>' + esc(phase) + '</td><td>' + esc(time) + '</td><td>' + esc(action) + '</td><td>' + esc(output) + '</td></tr>\n';
      });
      h += '    </tbody>\n';
      h += '  </table>\n';
      h += '  <div class="tm-watermark">TuringMarket | www.turingmarket.cn</div>\n';
      h += '</section>\n';
      
    } else if (t === "kpi") {
      h += '<section>\n';
      h += '  <p class="section-title">效果预估</p>\n';
      h += '  <h2>' + esc(sec.title || "KPI 与效果预估") + '</h2>\n';
      h += '  <div class="stats-grid">\n';
      (sec.points || []).forEach(function(p) {
        var parts = p.split(":");
        h += '    <div class="stat-card"><div class="num">' + esc(parts[0] || "") + '</div><div class="label">' + esc(parts.slice(1).join(":") || "") + '</div></div>\n';
      });
      h += '  </div>\n';
      if (sec.note) h += '  <p style="margin-top:16px;font-size:.7em;opacity:.5">' + esc(sec.note) + '</p>\n';
      h += '</section>\n';
      
    } else if (t === "next") {
      h += '<section>\n';
      h += '  <p class="section-title">下一步</p>\n';
      h += '  <h2>' + esc(sec.title || "合作建议与下一步") + '</h2>\n';
      h += '  <ul>\n';
      (sec.points || []).forEach(function(p) { h += '    <li>' + esc(p) + '</li>\n'; });
      h += '  </ul>\n';
      h += '  <div style="margin-top:24px;padding:16px;background:rgba(99,91,255,.1);border-radius:8px;font-size:.8em">\n';
      h += '    <strong>联系方式</strong><br>\n';
      h += '    TuringMarket 图灵集市<br>\n';
      h += '    www.turingmarket.cn | 深圳·北京·杭州·纽约\n';
      h += '  </div>\n';
      h += '</section>\n';
      
    } else {
      // content / comparison / default
      h += '<section>\n';
      h += '  <p class="section-title">' + esc(data.subtitle || "") + '</p>\n';
      h += '  <h2>' + esc(sec.title || "") + '</h2>\n';
      if ((sec.points || []).length <= 4 && sec.points.every(function(p) { return p.indexOf(":") > 0 })) {
        h += '  <div class="stats-grid">\n';
        (sec.points || []).forEach(function(p) {
          var parts = p.split(":");
          h += '    <div class="stat-card"><div class="num" style="font-size:1.2em">' + esc(parts[0] || "") + '</div><div class="label">' + esc(parts.slice(1).join(":") || "") + '</div></div>\n';
        });
        h += '  </div>\n';
      } else {
        h += '  <ul>\n';
        (sec.points || []).forEach(function(p) { h += '    <li>' + esc(p) + '</li>\n'; });
        h += '  </ul>\n';
      }
      if (sec.note) h += '  <p style="margin-top:12px;font-size:.7em;opacity:.5">' + esc(sec.note) + '</p>\n';
      h += '  <div class="tm-watermark">TuringMarket | www.turingmarket.cn</div>\n';
      h += '</section>\n';
    }
  });
  
  // Closing slide
  h += '<section class="cover-slide">\n';
  h += '  <h2 style="font-size:2em;font-weight:800">Thank You</h2>\n';
  h += '  <p class="subtitle">TuringMarket 图灵集市</p>\n';
  h += '  <div class="meta">全球首个按效果付费海外红人Agent<br>www.turingmarket.cn</div>\n';
  h += '</section>\n';
  
  h += '</div></div>\n';
  h += '<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.0.4/dist/reveal.js"><\/script>\n';
  h += '<script>\n';
  h += 'Reveal.initialize({\n';
  h += '  hash: true,\n';
  h += '  transition: "slide",\n';
  h += '  transitionSpeed: "default",\n';
  h += '  backgroundTransition: "fade",\n';
  h += '  width: 1200,\n';
  h += '  height: 675,\n';
  h += '  margin: 0.08,\n';
  h += '  minScale: 0.2,\n';
  h += '  maxScale: 2.0,\n';
  h += '  controls: true,\n';
  h += '  progress: true,\n';
  h += '  center: false,\n';
  h += '  slideNumber: "c/t"\n';
  h += '});\n';
  h += '<\/script>\n</body>\n</html>';
  
  return h;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function downloadHTMLPPT() {
  if (!lastPPT) { toast("请先生成 PPT", "error"); return; }
  var name = (curDemand?.brand || "proposal").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_") + "_TuringMarket方案.html";
  dlFile(name, lastPPT, "text/html;charset=utf-8");
  toast("HTML 文件已下载，可用浏览器打开编辑");
}

function previewPPT() {
  if (!lastPPT) { toast("请先生成 PPT", "error"); return; }
  var w = window.open("", "_blank");
  w.document.write(lastPPT);
  w.document.close();
}

function copyPPTSource() {
  if (!lastPPT) { toast("请先生成 PPT", "error"); return; }
  navigator.clipboard.writeText(lastPPT).then(function() {
    toast("PPT 源码已复制到剪贴板");
  });
}
