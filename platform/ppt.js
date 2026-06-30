// ===== TuringMarket proposal deck generator =====
var lastPPT = "";
var lastPPTSource = "";
var lastPPTOutline = null;
var pptContextMessages = [];
var pptContextFiles = [];

var TM_BOILERPLATE = [
  "TuringMarket 图灵集市：海外红人营销与商务增长工作平台",
  "服务覆盖需求解析、红人筛选、内容策略、执行排期、效果复盘",
  "交付路径：AI 草稿 -> 人工确认 -> 最终方案 -> 红人匹配与执行",
  "核心方法：60-30-10 预算模型 + 垂类达人内容资产沉淀"
];

async function generateHTMLPPT() {
  if (!curDemand && typeof syncCurDemandFromAnalysis === "function") syncCurDemandFromAnalysis();
  if (!curDemand) {
    toast("请先完成需求分析", "error");
    return;
  }
  var unreadableFiles = pptContextFiles.filter(function(file) { return file.parsed === false; });
  var unreadableWarning = "";
  if (unreadableFiles.length) {
    var names = unreadableFiles.map(function(file) { return file.name; }).join("、");
    unreadableWarning = "以下补充文件未读取到正文，仅作为附件清单保留，不会作为内容依据：" + names;
    toast(unreadableWarning);
    var status = document.getElementById("pptContextStatus");
    if (status) status.textContent = unreadableWarning + "。如需引用正文，请配置 OCR 或粘贴关键内容。";
  }

  var btn = document.getElementById("btnGenPPT");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在联网调研并生成策略 PPT...";
  }

  try {
    var proposalDraft = typeof getCurrentProposalDraft === "function" ? getCurrentProposalDraft() : (lastProp || "");
    var strictContext = buildPPTDeckContext();
    var payload = {
      demand: curDemand,
      proposal: proposalDraft,
      template: selTpl || "",
      deckContext: strictContext,
      previousOutline: lastPPTOutline
    };

    var parsed = null;
    var fallbackWarning = "";
    try {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, 60000);
      var r = await apiFetch("/ai/ppt-outline", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify(payload)
      });
      clearTimeout(timer);
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(d.error || ("PPT 服务请求失败: " + r.status));
      parsed = normalizePPTData(d.outline || d);
      if (d.research) parsed.research = d.research;
      else if (d.outline && d.outline.research) parsed.research = d.outline.research;
      fallbackWarning = d.fallback ? (d.warning || "AI PPT 生成处于降级模式，已生成基础可编辑版本") : "";
    } catch (apiError) {
      if (apiError.name === "AbortError") apiError = new Error("联网调研或 AI 大纲生成超时，已使用本地严格模板生成");
      parsed = buildClientPPTFallback(curDemand, [proposalDraft, strictContext].filter(Boolean).join("\n\n"), apiError.message);
      fallbackWarning = apiError.message;
    }

    parsed = normalizePPTData(parsed);
    if (!parsed.sections.length) parsed = buildClientPPTFallback(curDemand, [proposalDraft, strictContext].filter(Boolean).join("\n\n"), "PPT 大纲为空");
    parsed.materials = buildPPTMaterialReferences();

    lastPPTOutline = parsed;
    lastPPT = buildRevealHTML(parsed);
    lastPPTSource = JSON.stringify(parsed, null, 2);

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

    renderPPTResult(parsed, fallbackWarning, unreadableWarning);
    toast("PPT 生成成功: " + parsed.sections.length + " 页");
  } catch (e) {
    toast("PPT 生成失败: " + e.message, "error");
    console.error("PPT error:", e);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "生成 / 修改 PPT";
    }
  }
}

function addPPTInstruction() {
  var input = document.getElementById("pptContextInput");
  var text = String(input?.value || "").trim();
  if (!text) {
    toast("请先输入 PPT 修改要求或补充信息", "error");
    return;
  }
  pptContextMessages.push({
    role: "user",
    text: text,
    time: new Date().toLocaleString()
  });
  if (input) input.value = "";
  renderPPTContextThread();
  toast("已加入 PPT 生成上下文");
}

async function handlePPTContextFile(event) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  var status = document.getElementById("pptContextStatus");
  if (status) status.textContent = "正在解析补充文件: " + file.name + "...";
  try {
    var d = await parsePPTContextFileOnServer(file);
    var extracted = d.extractedText || "";
    if (!extracted.trim()) {
      extracted = await buildPPTContextFileFallback(file, "服务器未提取到正文");
      d.fallback = true;
    }
    d.fallback = d.fallback || (d.needsOcr && !d.ocrUsed) || !hasReadableExtractedText(extracted);
    pptContextFiles.push({
      name: d.fileName || file.name,
      text: extracted,
      parsed: !d.fallback,
      reason: d.warning || "",
      needsOcr: !!d.needsOcr,
      ocrUsed: !!d.ocrUsed,
      parser: d.parser || "",
      time: new Date().toLocaleString()
    });
    renderPPTContextThread();
    if (status) {
      status.textContent = d.ocrUsed
        ? "补充文件已通过 OCR 解析: " + file.name
        : (d.fallback ? "补充文件未读取正文，仅保留附件信息: " + file.name : "已解析补充文件: " + file.name);
    }
    toast(d.ocrUsed ? "补充文件已 OCR 提取并加入 PPT 上下文" : (d.fallback ? "补充文件未读取到正文，生成时仅作为附件清单保留" : "补充文件已加入 PPT 上下文"));
  } catch (e) {
    if (status) status.textContent = "补充文件解析失败: " + e.message;
    toast("补充文件解析失败: " + e.message, "error");
  } finally {
    if (event.target) event.target.value = "";
  }
}

async function parsePPTContextFileOnServer(file) {
  var lastError = null;
  var endpoints = [API + "/demand/parse-file", "/api/demand/parse-file"];
  for (var i = 0; i < endpoints.length; i++) {
    try {
      var form = new FormData();
      form.append("file", file);
      var token = AUTH_TOKEN || localStorage.getItem("tm_token") || "";
      var r = await fetch(endpoints[i], {
        method: "POST",
        headers: { "Authorization": "Bearer " + token },
        body: form
      });
      var d = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(d.error || ("文件解析失败: " + r.status));
      return d;
    } catch (e) {
      lastError = e;
    }
  }
  var fallbackText = await buildPPTContextFileFallback(file, lastError ? lastError.message : "请求失败");
  return {
    fileName: file.name,
    extractedText: fallbackText,
    fallback: true
  };
}

function hasReadableExtractedText(text) {
  var s = String(text || "").trim();
  if (s.length < 80) return false;
  if (/No readable text found|PDF parser unavailable|Unsupported document type|OCR service required|required_not_used|解析降级/i.test(s)) return false;
  return true;
}

function isTextLikePPTContextFile(file) {
  var name = String(file?.name || "");
  var ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
  var type = String(file?.type || "").toLowerCase();
  return ["txt", "csv", "tsv", "md", "json"].indexOf(ext.toLowerCase()) >= 0 || type.indexOf("text/") === 0 || type.indexOf("json") >= 0 || type.indexOf("csv") >= 0;
}

function readPPTContextTextFile(file) {
  return new Promise(function(resolve) {
    if (!isTextLikePPTContextFile(file)) return resolve("");
    var reader = new FileReader();
    reader.onload = function(e) { resolve(String(e.target.result || "").slice(0, 12000)); };
    reader.onerror = function() { resolve(""); };
    reader.readAsText(file);
  });
}

async function buildPPTContextFileFallback(file, reason) {
  var text = await readPPTContextTextFile(file);
  var lines = [
    "补充文件解析降级",
    "文件名: " + (file?.name || ""),
    "文件类型: " + (file?.type || "unknown"),
    "文件大小: " + (file?.size || 0) + " bytes",
    "降级原因: " + (reason || "未知"),
    "处理建议: 如果这是 PDF、扫描件或图片型文件，请配置 OCR_SERVICE_URL，或在补充要求输入框粘贴关键页文字，系统会在生成/修改 PPT 时一起引用。"
  ];
  if (text) lines.push("可读取文本片段:\n" + text);
  return lines.join("\n");
}

function renderPPTContextThread() {
  var box = document.getElementById("pptContextThread");
  if (!box) return;
  var html = [];
  pptContextMessages.forEach(function(msg, idx) {
    html.push('<div style="margin-bottom:8px;padding:9px 10px;border-radius:12px;background:#fff;border:1px solid rgba(226,232,240,.9)">'
      + '<strong>要求 ' + (idx + 1) + '</strong><span style="opacity:.45;margin-left:8px">' + esc(msg.time) + '</span>'
      + '<div style="margin-top:4px;color:var(--text)">' + esc(msg.text) + '</div></div>');
  });
  pptContextFiles.forEach(function(file, idx) {
    var state = file.ocrUsed ? "已 OCR 提取正文" : (file.parsed === false ? (file.needsOcr ? "需要 OCR 服务，未读取正文" : "未读取正文，仅加入文件信息") : "已提取正文");
    var reason = file.reason ? '<div style="margin-top:4px;color:#b45309">提示：' + esc(file.reason) + '</div>' : "";
    var usage = file.parsed === false ? "生成/修改 PPT 时仅作为附件清单保留，不会作为正文依据。" : "生成/修改 PPT 时会自动引用正文摘要。";
    html.push('<div style="margin-bottom:8px;padding:9px 10px;border-radius:12px;background:#eef6ff;border:1px solid #bfdbfe">'
      + '<strong>补充文件 ' + (idx + 1) + ': ' + esc(file.name) + '</strong><span style="opacity:.45;margin-left:8px">' + esc(file.time) + '</span>'
      + '<div style="margin-top:4px;color:var(--text2)">' + state + ' · 约 ' + Math.round((file.text || "").length / 100) / 10 + 'k 字符，' + usage + '</div>' + reason + '</div>');
  });
  box.innerHTML = html.length ? html.join("") : "暂无补充要求。可在下方输入你希望 PPT 增加、删减、强化或修改的内容。";
}

function buildPPTDeckContext() {
  var blocks = [];
  if (pptContextMessages.length) {
    blocks.push("## 多轮 PPT 修改/补充要求");
    pptContextMessages.forEach(function(msg, idx) {
      blocks.push((idx + 1) + ". " + msg.text);
    });
  }
  if (pptContextFiles.length) {
    blocks.push("## 上传补充材料解析");
    pptContextFiles.forEach(function(file, idx) {
      blocks.push("### 文件 " + (idx + 1) + ": " + file.name);
      blocks.push("解析状态: " + (file.parsed === false ? "未成功提取正文，仅有文件元数据" : "已成功提取正文"));
      blocks.push(String(file.text || "").slice(0, 12000));
    });
  }
  return blocks.join("\n\n");
}

function buildPPTMaterialReferences() {
  return pptContextFiles.map(function(file, idx) {
    var text = String(file.text || "").trim();
    return {
      index: idx + 1,
      name: file.name || ("补充文件 " + (idx + 1)),
      parsed: file.parsed !== false && hasReadableExtractedText(text),
      chars: text.length,
      preview: text.replace(/\s+/g, " ").slice(0, 900),
      text: text.slice(0, 4000)
    };
  });
}

function clearPPTContext(silent) {
  pptContextMessages = [];
  pptContextFiles = [];
  renderPPTContextThread();
  var status = document.getElementById("pptContextStatus");
  if (status) status.textContent = "生成 PPT 时会自动带入这些上下文。";
  if (!silent) toast("PPT 补充要求已清空");
}

function buildClientPPTFallback(demand, proposal, reason) {
  var brand = demand?.brand || "客户品牌";
  var product = demand?.product || "推广产品";
  var industry = demand?.category || demand?.industry || "目标行业";
  var market = demand?.area || demand?.market || "目标市场";
  var platforms = demand?.platform || "YouTube, Instagram, TikTok";
  var budget = demand?.budget || "待甲方确认";
  var usp = demand?.usp || "产品核心卖点待甲方确认";
  var notes = demand?.notes || "";
  var context = String(proposal || "");
  var contextBrief = summarizeDeckContext(context);
  var customRequests = extractContextBullets(context, 6);
  var wantsCompetitor = /竞品|对比|comparison|competitor|vs\.?|VS/i.test(context);
  var wantsBudget = /预算|报价|budget|cost|达人层级|tier/i.test(context);
  var wantsExtraPage = /新增|添加|增加|add|page|页面/i.test(context);
  return {
    title: brand + " " + product + " 海外红人营销 Campaign Deck",
    subtitle: "基于需求表、补充材料与对话要求生成的甲方汇报版 | TuringMarket",
    sections: [
      { title: brand + " " + product + " 海外红人营销 Campaign Deck", type: "cover", points: [market + " | " + platforms + " | 乙方策略汇报版"], note: "TuringMarket" },
      { title: "01 执行摘要：本次方案如何回应甲方需求", type: "content", points: ["客户目标: " + (notes || "围绕 " + product + " 获取海外红人内容与销售转化"), "产品核心: " + product + " / " + usp, "市场与平台: " + market + " / " + platforms, "预算口径: " + budget, "补充要求: " + (contextBrief || "未提供额外补充，按需求表生成")] },
      { title: "02 对话要求与补充材料吸收", type: "content", points: customRequests.length ? customRequests : ["处理原则: 用户未提供可解析补充材料时，系统不虚构附件信息", "生成约束: 所有页面必须围绕品牌、产品、目标市场和预算落地", "交付格式: 固定 1920×1080 单文件 HTML deck，并支持 PPTX 下载"] },
      { title: "03 产品理解：先把内容讲具体", type: "content", points: ["核心产品: " + product, "关键卖点: " + usp, "内容切入点: 用真实场景解释产品价值，而不是只做参数罗列", "甲方表达: " + (contextBrief || "待从需求表和补充材料进一步确认")] },
      { title: "04 目标用户与使用场景", type: "content", points: ["核心人群: " + inferDeckAudience(industry, product, notes + " " + context), "高频场景: 围绕" + product + "的真实使用场景拆分内容主题", "决策阻力: 价格、可靠性、真实体验和售后信任", "内容任务: 用达人体验降低潜客理解成本和信任成本"] },
      { title: wantsCompetitor ? "05 竞品对比与内容截流策略" : "05 策略主线：先建立信任，再放大转化", type: "content", points: wantsCompetitor ? ["对比目标: 围绕甲方指定竞品/同类产品建立差异化内容框架", "内容形式: YouTube 深度横评 + TikTok 场景短视频 + Instagram Reels 生活方式表达", "截流逻辑: 标题、脚本和评论区 FAQ 承接竞品搜索与购买前疑问", "交付物: 竞品对比脚本模板、禁用表达表、达人 brief"] : ["Phase 1 信任建立: 产品评测、开箱、真实使用场景演示", "Phase 2 场景扩散: 不同人群/场景的短视频素材矩阵", "Phase 3 转化承接: 优惠码、落地页、评论区答疑与二次投放", "核心原则: 达人内容服务销售转化，而不是只追求曝光"] },
      { title: "05 红人筛选标准：给甲方可审核的名单逻辑", type: "content", points: ["垂类匹配: 内容主题与" + industry + "高度相关", "数据门槛: 近10条平均播放、互动率、评论质量优先于粉丝总量", "内容能力: 必须能完成产品解释、场景演示和可信评测", "合作历史: 优先选择做过相近品类但不过度商业化的达人"] },
      { title: wantsBudget ? "06 预算拆解：按达人层级与交付物分配" : "06 红人组合与预算打法", type: "stats", points: ["60%: 垂类中腰部达人，负责可信评测和主内容资产", "30%: Nano/Micro 达人，负责场景铺量和素材测试", "10%: 复盘优化、二次授权、应急替补与数据追踪", "预算: " + budget] },
      { title: "07 平台打法：不同渠道承担不同任务", type: "content", points: ["YouTube: 长视频评测、搜索沉淀、购买前决策内容", "TikTok: 高频短视频测试爆点、场景化种草、快速反馈素材方向", "Instagram: Reels + Story + 图文组合，强化生活方式和品牌视觉", "内容承接: 每条内容配置 CTA、链接/折扣码和评论区答疑机制"] },
      { title: "08 内容脚本方向：让达人知道怎么拍", type: "content", points: ["开箱评测: 解决产品第一眼认知和基础信任", "场景挑战: 用真实任务证明产品能力", "对比解释: 对比竞品或传统解决方案，突出差异化价值", "痛点问答: 从评论区常见疑问反推短视频脚本"] },
      { title: "09 执行排期：8周落地节奏", type: "timeline", points: ["第1周|需求复核、产品资料拆解、达人画像确认|策略确认表与达人筛选标准", "第2周|达人初筛、报价沟通、名单评审|首批达人名单与推荐理由", "第3-4周|样品寄送、脚本确认、内容制作|脚本表、拍摄排期、风险点记录", "第5-6周|内容上线、数据监控、评论区答疑|上线链接与数据看板", "第7-8周|复盘优化、二次传播、素材授权建议|复盘报告与下一轮放大方案"] },
      { title: "10 KPI 与复盘口径", type: "kpi", points: ["曝光: 达人内容覆盖与有效观看", "互动: 评论质量、收藏、转发、私信/询盘线索", "转化: 链接点击、优惠码、落地页访问、询盘或购买动作", "资产: 可复用脚本、达人白名单、授权素材、用户反馈语料"] },
      { title: "11 风险与乙方保障机制", type: "content", points: ["达人延期: 预留替补达人池并设置上线节点", "内容跑偏: 脚本先审、样片再审、上线前终审", "数据不达预期: 前两周小规模测试，按素材表现快速调整方向", "甲方协同: 产品资料、样品、卖点优先级、禁用表述需在启动前确认"] },
      { title: "12 下一步需要甲方确认", type: "next", points: ["确认预算区间和目标市场优先级", "确认产品资料包、样品数量和寄送区域", "确认达人筛选红线、竞品名单和品牌禁用表达", "确认是否进入达人匹配与执行排期阶段"] }
    ],
    warning: reason || ""
  };
}

function summarizeDeckContext(text) {
  var s = String(text || "")
    .replace(/File name:[^\n]+\n?/gi, "")
    .replace(/File type:[^\n]+\n?/gi, "")
    .replace(/File size:[^\n]+\n?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.slice(0, 240);
}

function extractContextBullets(text, maxItems) {
  var source = String(text || "");
  var lines = source.split(/\n+/).map(function(line) {
    return line.replace(/^[-*\d.、\s]+/, "").trim();
  }).filter(function(line) {
    return line.length > 8 && !/^File (name|type|size):/i.test(line) && !/^解析状态/.test(line);
  });
  var picked = [];
  lines.forEach(function(line) {
    if (picked.length >= (maxItems || 6)) return;
    var lower = line.toLowerCase();
    if (/竞品|对比|预算|达人|红人|页面|新增|修改|ppt|pdf|brief|脚本|场景|platform|budget|competitor|influencer|campaign/.test(lower)) {
      picked.push("补充要求: " + line.slice(0, 180));
    }
  });
  return picked;
}

function inferDeckAudience(industry, product, notes) {
  var text = [industry, product, notes].join(" ");
  if (/储能|电源|power|outdoor|camp|rv|solar|energy/i.test(text)) return "户外露营、房车用户、家庭应急备用、电源/科技评测受众";
  if (/美妆|护肤|beauty|skin/i.test(text)) return "成分党、护肤/彩妆兴趣用户、生活方式内容受众";
  if (/宠物|pet|cat|dog/i.test(text)) return "宠物主人、宠物护理和家居生活方式受众";
  if (/3C|电子|phone|tech|computer/i.test(text)) return "科技评测受众、效率工具用户、早期尝鲜消费者";
  return "与产品使用场景高度相关的垂类兴趣人群";
}

function normalizePPTData(data) {
  data = data || {};
  var demandTitle = (curDemand?.brand || "品牌") + " " + (curDemand?.product || "") + " 海外红人营销提案";
  var sections = Array.isArray(data.sections) ? data.sections : [];
  sections = sections.map(function(sec) {
    sec = sec || {};
    return {
      title: String(sec.title || "方案页").trim(),
      type: String(sec.type || "content").trim(),
      points: normalizePPTPoints(sec.points),
      note: String(sec.note || "").trim()
    };
  }).filter(function(sec) {
    return sec.title || sec.points.length;
  });
  var normalized = {
    title: String(data.title || demandTitle).trim(),
    subtitle: String(data.subtitle || "TuringMarket 海外增长提案").trim(),
    research: data.research || null,
    theme: data.theme || null,
    sections: sections
  };
  if (!normalized.sections.length || normalized.sections[0].type !== "cover") {
    normalized.sections.unshift({
      title: normalized.title,
      type: "cover",
      points: [normalized.subtitle],
      note: "TuringMarket 图灵集市"
    });
  } else {
    normalized.sections[0].title = normalized.title;
    if (!normalized.sections[0].points.length) normalized.sections[0].points = [normalized.subtitle];
  }
  return normalized;
}

function normalizePPTPoints(points) {
  if (Array.isArray(points)) return points.map(function(p) { return String(p || "").trim(); }).filter(Boolean);
  if (!points) return [];
  return String(points).split(/[;\n；]+/).map(function(p) { return p.trim(); }).filter(Boolean);
}

function renderPPTResult(parsed, warning, contextWarning) {
  var out = document.getElementById("proposalOutput");
  if (!out) return;
  var notice = warning
    ? '<div style="margin-bottom:12px;padding:10px 12px;border-radius:12px;background:#fff7ed;color:#c2410c;font-size:13px">AI PPT 生成使用基础模板：' + esc(warning) + '</div>'
    : "";
  var contextNotice = contextWarning
    ? '<div style="margin-bottom:12px;padding:10px 12px;border-radius:12px;background:#eff6ff;color:#1d4ed8;font-size:13px">补充材料提示：' + esc(contextWarning) + '</div>'
    : "";
  var researchNotice = buildPPTResearchNotice(parsed.research);
  out.innerHTML = [
    '<div style="padding:16px">',
    notice,
    contextNotice,
    researchNotice,
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">',
    '<span style="font-size:24px">📊</span>',
    '<div><h3 style="margin:0">' + esc(parsed.title || "方案 PPT") + '</h3>',
    '<p style="opacity:.55;font-size:12px;margin:0">' + parsed.sections.length + ' 页幻灯片 · HTML 预览 · PPTX 可编辑下载</p></div>',
    '</div>',
    '<div style="display:flex;gap:8px;flex-wrap:wrap">',
    '<button class="btn btn-primary btn-sm" onclick="downloadHTMLPPT()">📥 下载 HTML</button>',
    '<button class="btn btn-primary btn-sm" onclick="downloadPPTX()">📊 下载 PPTX</button>',
    '<button class="btn btn-outline btn-sm" onclick="previewPPT()">📺 新窗口预览</button>',
    '<button class="btn btn-outline btn-sm" onclick="copyPPTSource()">📋 复制 HTML 源码</button>',
    '<button class="btn btn-outline btn-sm" onclick="openPPTEditor()">✏️ 编辑大纲/页面</button>',
    '</div>',
    '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;opacity:.65">查看幻灯片大纲</summary>',
    '<div style="font-size:12px;opacity:.75;margin-top:8px;max-height:240px;overflow-y:auto">',
    parsed.sections.map(function(s, i) {
      return '<div style="padding:5px 0">' + (i + 1) + '. <strong>' + esc(s.title || "") + '</strong> <span style="opacity:.5">[' + esc(s.type || "content") + ']</span></div>';
    }).join(""),
    '</div></details>',
    '</div>'
  ].join("\n");
  out.classList.remove("hidden");
  out.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function buildPPTResearchNotice(research) {
  if (!research) {
    return '<div style="margin-bottom:12px;padding:10px 12px;border-radius:12px;background:#f8fafc;color:#64748b;font-size:13px">联网调研：未收到调研结果，已按需求表和补充材料生成。</div>';
  }
  var count = Array.isArray(research.sources) ? research.sources.length : 0;
  var queries = Array.isArray(research.queries) ? research.queries.length : 0;
  var color = count ? "#047857" : "#b45309";
  var bg = count ? "#ecfdf5" : "#fff7ed";
  var text = count
    ? "已完成生成前联网调研，读取 " + count + " 条来源，搜索 " + queries + " 组关键词；调研摘要已进入 PPT 大纲。"
    : "联网调研未读取到可用来源，已使用需求表、补充材料和本地策略框架继续生成。";
  if (research.warning) text += " 提示：" + research.warning;
  return '<div style="margin-bottom:12px;padding:10px 12px;border-radius:12px;background:' + bg + ';color:' + color + ';font-size:13px">联网调研：' + esc(text) + '</div>';
}

function buildRevealHTML(data) {
  return buildFrontendSlidesDeckHTML(data);
}

function buildFrontendSlidesDeckHTML(data) {
  var brand = curDemand?.brand || inferBrandFromTitle(data.title) || "CLIENT";
  var product = curDemand?.product || "";
  var title = data.title || (brand + " 海外红人营销 Campaign Deck");
  var subtitle = data.subtitle || "Strategy · Creator · Content · Conversion";
  var theme = selectPPTVisualTheme(data, curDemand || {});
  var sections = (data.sections || []).filter(function(sec) { return sec.type !== "cover"; });
  var research = data.research || null;
  if (research && ((research.bullets || []).length || (research.sources || []).length)) {
    sections = sections.filter(function(sec) { return sec.type !== "sources"; });
    if (!sections.some(function(sec) { return sec.type === "research" || /联网调研|市场信号|调研/.test(sec.title || ""); })) {
      sections.splice(1, 0, {
        title: "联网调研与市场信号",
        type: "research",
        points: buildPPTResearchPoints(research)
      });
    }
    if ((research.sources || []).length) {
      sections.push({
        title: "调研来源与引用口径",
        type: "sources",
        points: research.sources.slice(0, 8).map(function(item, idx) {
          return "来源" + (idx + 1) + ": " + (item.title || item.url) + " | " + (item.snippet || item.url);
        })
      });
    }
  }
  var materials = Array.isArray(data.materials) ? data.materials : [];
  if (materials.length) {
    sections.push({
      title: "补充材料引用：已进入本次方案",
      type: "content",
      points: materials.map(function(file) {
        return file.name + ": " + (file.parsed ? file.preview : "未读取正文，仅作为附件清单保留；如需引用正文，请配置 OCR 或粘贴关键内容");
      })
    });
  }
  sections.push({ title: "下一步协同", type: "closing", points: ["确认预算与市场优先级", "确认达人筛选红线和禁用表达", "进入达人名单匹配与执行排期"] });

  var h = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' + esc(title) + '</title><style>' + frontendSlidesCSS(theme) + '</style></head><body data-theme="' + esc(theme.slug) + '">';
  h += '<div class="deck-viewport"><main class="deck-stage" id="deckStage">';
  h += renderFrontendCoverSlide(brand, product, title, subtitle, theme);
  sections.forEach(function(sec, idx) {
    h += renderFrontendSlide(sec, idx + 2, sections.length + 1, brand);
  });
  h += '</main></div><div class="deck-controls"><button onclick="deck.prev()">←</button><span id="deckCounter">1 / ' + (sections.length + 1) + '</span><button onclick="deck.next()">→</button></div><div class="deck-progress" id="deckProgress"></div>';
  h += '<script>' + frontendSlidesScript() + '<\/script></body></html>';
  return h;
}

function buildPPTResearchPoints(research) {
  var points = [];
  (research.bullets || []).slice(0, 6).forEach(function(item) { points.push(item); });
  if (!points.length && (research.sources || []).length) {
    research.sources.slice(0, 4).forEach(function(item, idx) {
      points.push("来源" + (idx + 1) + ": " + (item.title || "") + " - " + (item.snippet || item.url || ""));
    });
  }
  if (!points.length) points.push("调研状态: 未拿到可用在线来源，PPT 已基于需求表和补充材料继续生成");
  return points;
}

function selectPPTVisualTheme(data, demand) {
  var text = JSON.stringify({ data: data || {}, demand: demand || {} }).toLowerCase();
  if (/beauty|skin|美妆|护肤|时尚|fashion/.test(text)) {
    return { slug: "emerald-editorial", name: "Emerald Editorial", stage: "#08110f", bg: "#0c1512", ink: "#f8fafc", muted: "#a6b6ae", accent: "#39d98a", accent2: "#f5d0a9", green: "#86efac", surface: "rgba(255,255,255,.075)" };
  }
  if (/pet|宠物|cat|dog/.test(text)) {
    return { slug: "capsule", name: "Capsule", stage: "#10121a", bg: "#10121a", ink: "#fff7ed", muted: "#c7b7a6", accent: "#f97316", accent2: "#22c55e", green: "#fde68a", surface: "rgba(255,247,237,.09)" };
  }
  if (/power|energy|solar|outdoor|储能|电源|户外|露营/.test(text)) {
    return { slug: "signal", name: "Signal", stage: "#05070f", bg: "#07111f", ink: "#f8fafc", muted: "#94a3b8", accent: "#38bdf8", accent2: "#facc15", green: "#22c55e", surface: "rgba(255,255,255,.07)" };
  }
  if (/tech|3c|software|saas|电子|科技|电脑|手机/.test(text)) {
    return { slug: "cobalt-grid", name: "Cobalt Grid", stage: "#050816", bg: "#08111f", ink: "#f8fafc", muted: "#9fb3c8", accent: "#2563eb", accent2: "#7dd3fc", green: "#10b981", surface: "rgba(37,99,235,.11)" };
  }
  return { slug: "blue-professional", name: "Blue Professional", stage: "#06111f", bg: "#081320", ink: "#f8fafc", muted: "#9fb0c7", accent: "#61d3ff", accent2: "#8b5cf6", green: "#62e6a8", surface: "rgba(255,255,255,.075)" };
}

function frontendSlidesCSS(theme) {
  theme = theme || selectPPTVisualTheme({}, {});
  return [
    ':root{--bg:' + theme.bg + ';--stage-bg:' + theme.stage + ';--ink:' + theme.ink + ';--muted:' + theme.muted + ';--line:rgba(255,255,255,.12);--card:' + theme.surface + ';--glass:rgba(255,255,255,.10);--accent:' + theme.accent + ';--accent2:' + theme.accent2 + ';--green:' + theme.green + ';--amber:#ffd166;--font:"Aptos Display","PingFang SC","Microsoft YaHei",sans-serif}',
    '*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:radial-gradient(circle at 15% 10%,color-mix(in srgb,var(--accent) 20%,transparent),transparent 26%),radial-gradient(circle at 85% 12%,color-mix(in srgb,var(--accent2) 24%,transparent),transparent 28%),linear-gradient(135deg,var(--stage-bg),var(--bg) 58%,#05060a);font-family:var(--font);color:var(--ink)}',
    '.deck-viewport{position:fixed;inset:0;display:grid;place-items:center;overflow:hidden}.deck-stage{position:absolute;width:1920px;height:1080px;transform-origin:0 0;overflow:hidden;border-radius:0;background:#070910;box-shadow:0 40px 120px rgba(0,0,0,.55)}',
    '.slide{position:absolute;inset:0;width:1920px;height:1080px;padding:76px 92px;opacity:0;visibility:hidden;transform:translateX(44px);transition:opacity .38s ease,transform .38s ease;overflow:hidden}.slide.active{opacity:1;visibility:visible;transform:translateX(0)}.slide:before{content:"";position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.065),transparent 38%),radial-gradient(circle at 90% 12%,rgba(97,211,255,.16),transparent 30%);pointer-events:none}.slide:after{content:"";position:absolute;left:0;right:0;bottom:0;height:7px;background:linear-gradient(90deg,var(--accent),var(--accent2),var(--green));opacity:.9}',
    '.chrome{position:relative;z-index:2;display:flex;justify-content:space-between;align-items:center;margin-bottom:48px}.brand-mark{font-size:24px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}.page-code{font-size:18px;color:var(--muted);letter-spacing:.12em}.eyebrow{position:relative;z-index:2;font-size:20px;letter-spacing:.18em;color:var(--accent);font-weight:900;text-transform:uppercase;margin-bottom:20px}.cover-kicker{font-size:22px;letter-spacing:.22em;color:var(--muted);font-weight:800;text-transform:uppercase;margin-bottom:32px}',
    '.cover-title{position:relative;z-index:2;width:1280px;font-size:88px;line-height:.98;letter-spacing:-.06em;font-weight:950;margin:0 0 34px}.grad{background:linear-gradient(90deg,#fff,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}.cover-sub{position:relative;z-index:2;width:920px;font-size:30px;line-height:1.45;color:#cbd5e1}.cover-grid{position:absolute;right:92px;bottom:110px;width:510px;display:grid;grid-template-columns:1fr 1fr;gap:16px}.cover-tile{background:var(--glass);border:1px solid var(--line);border-radius:28px;padding:26px;backdrop-filter:blur(16px)}.cover-tile strong{display:block;font-size:34px;color:#fff;margin-bottom:8px}.cover-tile span{font-size:17px;color:var(--muted);line-height:1.35}',
    '.slide-title{position:relative;z-index:2;width:1320px;font-size:58px;line-height:1.05;letter-spacing:-.045em;font-weight:940;margin:0 0 30px}.slide-note{position:relative;z-index:2;width:900px;font-size:23px;color:var(--muted);line-height:1.45;margin-bottom:26px}.card-grid{position:relative;z-index:2;display:grid;grid-template-columns:repeat(2,1fr);gap:24px}.card-grid.three{grid-template-columns:repeat(3,1fr)}.insight-card{min-height:180px;background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.055));border:1px solid var(--line);border-radius:30px;padding:30px;box-shadow:0 24px 60px rgba(0,0,0,.22)}.insight-label{font-size:24px;line-height:1.18;color:#fff;font-weight:900;margin-bottom:14px}.insight-body{font-size:21px;line-height:1.48;color:#b8c4d4}.insight-index{font-size:15px;color:var(--accent);font-weight:900;letter-spacing:.16em;margin-bottom:12px}',
    '.research-layout{position:relative;z-index:2;display:grid;grid-template-columns:1.2fr .8fr;gap:26px}.research-main{display:grid;gap:20px}.research-card{min-height:188px;background:linear-gradient(135deg,rgba(255,255,255,.12),rgba(255,255,255,.045));border:1px solid rgba(255,255,255,.14);border-radius:32px;padding:32px}.research-title{font-size:32px;line-height:1.1;color:#fff;font-weight:950;margin-bottom:16px}.research-body{font-size:22px;line-height:1.45;color:#cbd5e1}.research-side,.source-list{position:relative;z-index:2;display:grid;gap:14px}.source-row{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:18px 20px}.source-row strong{display:block;font-size:18px;line-height:1.25;color:var(--accent);margin-bottom:8px}.source-row span{display:block;font-size:18px;line-height:1.38;color:#cbd5e1}.source-list{grid-template-columns:repeat(2,1fr)}',
    '.metric-grid{position:relative;z-index:2;display:grid;grid-template-columns:repeat(4,1fr);gap:22px}.metric{height:250px;background:linear-gradient(145deg,rgba(97,211,255,.13),rgba(139,92,246,.11));border:1px solid rgba(97,211,255,.22);border-radius:34px;padding:32px}.metric-num{font-size:50px;line-height:.95;font-weight:950;color:#fff;margin-bottom:22px}.metric-label{font-size:21px;line-height:1.45;color:#cbd5e1}.bar{height:10px;background:rgba(255,255,255,.10);border-radius:999px;margin-top:24px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:999px}',
    '.timeline{position:relative;z-index:2;display:grid;gap:16px}.tl-row{display:grid;grid-template-columns:230px 1fr 360px;gap:18px;align-items:stretch}.tl-phase,.tl-action,.tl-output{border:1px solid var(--line);background:var(--card);border-radius:24px;padding:22px;font-size:21px;line-height:1.35}.tl-phase{color:var(--accent);font-weight:900}.tl-output{color:#cbd5e1}.closing .slide-title{font-size:78px;width:1180px}.footer{position:absolute;z-index:2;left:92px;right:92px;bottom:46px;display:flex;justify-content:space-between;color:var(--muted);font-size:17px}.deck-controls{position:fixed;z-index:20;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:10px 14px;color:#fff;backdrop-filter:blur(14px)}.deck-controls button{border:0;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;padding:8px 14px;cursor:pointer}.deck-progress{position:fixed;left:0;bottom:0;height:4px;background:linear-gradient(90deg,var(--accent),var(--accent2));width:0;z-index:21;transition:width .25s ease}@media print{html,body{overflow:visible;background:#fff}.deck-viewport{position:static;display:block}.deck-stage{position:static;width:1920px;height:auto;transform:none!important}.slide{position:relative;opacity:1;visibility:visible;transform:none;page-break-after:always}.deck-controls,.deck-progress{display:none}}'
  ].join('');
}

function renderFrontendCoverSlide(brand, product, title, subtitle, theme) {
  var chips = coverChips({ title: title, subtitle: subtitle, sections: lastPPTOutline?.sections || [] }).slice(0, 4);
  if (theme && theme.name && chips.indexOf(theme.name) < 0) chips.push(theme.name);
  while (chips.length < 4) chips.push(["甲方汇报版", "固定 1920×1080", "单文件 HTML", "可编辑 PPTX"][chips.length]);
  chips = chips.slice(0, 4);
  return '<section class="slide cover active"><div class="chrome"><div class="brand-mark">TuringMarket</div><div class="page-code">CLIENT DECK</div></div><div class="cover-kicker">Influencer Marketing Strategy</div><h1 class="cover-title"><span class="grad">' + esc(brand) + '</span>' + (product ? ' ' + esc(product) : '') + '<br>' + esc(trimDeckTitle(title, brand, product)) + '</h1><div class="cover-sub">' + esc(subtitle) + '</div><div class="cover-grid">' + chips.map(function(c) { return '<div class="cover-tile"><strong>' + esc(metricLead(c) || "●") + '</strong><span>' + esc(c) + '</span></div>'; }).join('') + '</div><div class="footer"><span>Prepared for ' + esc(brand) + '</span><span>Confidential · 2026</span></div></section>';
}

function renderFrontendSlide(sec, page, total, brand) {
  var type = sec.type || "content";
  var points = normalizePPTPoints(sec.points).slice(0, type === "timeline" ? 6 : 6);
  var h = '<section class="slide' + (type === "closing" ? " closing" : "") + '"><div class="chrome"><div class="brand-mark">' + esc(brand) + '</div><div class="page-code">' + pad2(page) + ' / ' + pad2(total) + '</div></div><div class="eyebrow">' + esc(sectionEnglishLabel(type, sec.title)) + '</div><h2 class="slide-title">' + esc(sec.title || "") + '</h2>';
  if (sec.note) h += '<div class="slide-note">' + esc(sec.note) + '</div>';
  if (type === "timeline") h += renderFrontendTimeline(points);
  else if (type === "research") h += renderFrontendResearch(points);
  else if (type === "sources") h += renderFrontendSources(points);
  else if (type === "stats" || type === "kpi" || /预算|budget|平台|platform|KPI|指标/.test(sec.title || "")) h += renderFrontendMetrics(points);
  else h += renderFrontendCards(points);
  h += '<div class="footer"><span>TuringMarket 图灵集市 · 海外红人营销提案</span><span>' + esc(brand) + '</span></div></section>';
  return h;
}

function renderFrontendResearch(points) {
  var main = points.slice(0, 3);
  var rest = points.slice(3, 7);
  return '<div class="research-layout"><div class="research-main">'
    + main.map(function(p, idx) {
      var pair = splitPoint(p);
      return '<article class="research-card"><div class="insight-index">SIGNAL ' + pad2(idx + 1) + '</div><div class="research-title">' + esc(pair.label) + '</div><div class="research-body">' + esc(pair.body) + '</div></article>';
    }).join('')
    + '</div><div class="research-side">'
    + rest.map(function(p, idx) {
      var pair = splitPoint(p);
      return '<div class="source-row"><strong>' + esc(pair.label || ("SOURCE " + (idx + 1))) + '</strong><span>' + esc(pair.body || p) + '</span></div>';
    }).join('')
    + '</div></div>';
}

function renderFrontendSources(points) {
  return '<div class="source-list">' + points.slice(0, 8).map(function(p, idx) {
    var pair = splitPoint(p);
    return '<div class="source-row"><strong>' + esc(pair.label || ("来源 " + (idx + 1))) + '</strong><span>' + esc(pair.body || p) + '</span></div>';
  }).join('') + '</div>';
}

function renderFrontendCards(points) {
  var cls = points.length >= 5 ? "card-grid three" : "card-grid";
  return '<div class="' + cls + '">' + points.map(function(p, idx) {
    var pair = splitPoint(p);
    return '<article class="insight-card"><div class="insight-index">' + pad2(idx + 1) + '</div><div class="insight-label">' + esc(pair.label) + '</div><div class="insight-body">' + esc(pair.body) + '</div></article>';
  }).join('') + '</div>';
}

function renderFrontendMetrics(points) {
  return '<div class="metric-grid">' + points.slice(0, 4).map(function(p, idx) {
    var pair = splitPoint(p);
    var pct = inferPercent(pair.label + " " + pair.body, idx);
    return '<article class="metric"><div class="metric-num">' + esc(metricLead(pair.label + " " + pair.body)) + '</div><div class="metric-label"><strong>' + esc(pair.label) + '</strong><br>' + esc(pair.body) + '</div><div class="bar"><i style="width:' + pct + '%"></i></div></article>';
  }).join('') + '</div>' + renderFrontendCards(points.slice(4, 6));
}

function renderFrontendTimeline(points) {
  return '<div class="timeline">' + points.map(function(p, idx) {
    var parts = String(p).split("|");
    return '<div class="tl-row"><div class="tl-phase">' + esc(parts[0] || ("Phase " + (idx + 1))) + '<br><span style="font-size:16px;color:#93a4b8">' + esc(parts[1] || "待确认") + '</span></div><div class="tl-action">' + esc(parts[2] || p) + '</div><div class="tl-output">' + esc(parts[3] || "阶段交付物") + '</div></div>';
  }).join('') + '</div>';
}

function frontendSlidesScript() {
  return 'class Deck{constructor(){this.slides=[...document.querySelectorAll(".slide")];this.stage=document.getElementById("deckStage");this.index=0;addEventListener("resize",()=>this.fit());addEventListener("keydown",e=>{if(["ArrowRight","PageDown"," "].includes(e.key))this.next();if(["ArrowLeft","PageUp"].includes(e.key))this.prev()});this.fit();this.show(0)}fit(){const scale=Math.min(innerWidth/1920,innerHeight/1080);const x=(innerWidth-1920*scale)/2;const y=(innerHeight-1080*scale)/2;this.stage.style.transform=`translate(${x}px,${y}px) scale(${scale})`}show(i){this.index=Math.max(0,Math.min(this.slides.length-1,i));this.slides.forEach((s,n)=>s.classList.toggle("active",n===this.index));document.getElementById("deckCounter").textContent=`${this.index+1} / ${this.slides.length}`;document.getElementById("deckProgress").style.width=((this.index+1)/this.slides.length*100)+"%"}next(){this.show(this.index+1)}prev(){this.show(this.index-1)}}const deck=new Deck();window.deck=deck;';
}

function buildCampaignReportHTML(data) {
  var brand = curDemand?.brand || inferBrandFromTitle(data.title) || "CLIENT";
  var product = curDemand?.product || "";
  var title = data.title || (brand + " 海外红人营销 Campaign");
  var subtitle = data.subtitle || "面向甲方汇报的策略、执行与复盘方案";
  var sections = (data.sections || []).filter(function(sec) { return (sec.type || "") !== "cover"; });
  if (!sections.length) sections = normalizePPTData(data).sections.filter(function(sec) { return sec.type !== "cover"; });
  var materials = Array.isArray(data.materials) ? data.materials : [];
  var nav = ['<a href="#cover">封面</a>'];
  sections.forEach(function(_, idx) { nav.push('<a href="#s' + pad2(idx + 1) + '">' + pad2(idx + 1) + '</a>'); });
  if (materials.length) nav.push('<a href="#materials">材料</a>');
  nav.push('<a href="#closing">结尾</a>');

  var h = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  h += '<title>' + esc(title) + '</title>\n<style>\n' + campaignReportCSS() + '\n</style>\n</head>\n<body>\n';
  h += '<nav><div class="nav-brand"><span>' + esc(brand) + '</span> · CAMPAIGN REPORT <span style="font-size:10px;opacity:.6;font-weight:400">by TuringMarket</span></div><div class="nav-links">' + nav.join('') + '</div></nav>\n';
  h += '<div class="confidential">Confidential Proposal · TuringMarket</div>\n';
  h += '<section id="cover"><div class="orb orb-1"></div><div class="fade-in"><div class="cover-eyebrow">INFLUENCER MARKETING STRATEGY</div></div><div class="fade-in delay-1"><h1 class="cover-title"><span class="accent-grad">' + esc(brand) + '</span>' + (product ? ' ' + esc(product) : '') + '<br>' + esc(trimDeckTitle(title, brand, product)) + '</h1></div><div class="fade-in delay-2"><p class="cover-sub">' + esc(subtitle) + '</p></div>';
  h += '<div class="fade-in delay-3"><div class="chips">' + coverChips(data).map(function(c) { return '<div class="chip">' + esc(c) + '</div>'; }).join('') + '</div></div>';
  h += '<div class="fade-in delay-4"><div class="cover-footer">Presented by TuringMarket图灵集市 · Prepared for ' + esc(brand) + ' · ' + new Date().getFullYear() + '</div></div></section>\n';

  sections.forEach(function(sec, idx) {
    h += renderCampaignSection(sec, idx + 1, sections);
  });
  if (materials.length) h += renderMaterialsSection(materials);
  h += renderClosingSection(brand, product, title);
  h += '<script>\n' + campaignReportScript() + '\n<\/script>\n</body>\n</html>';
  return h;
}

function campaignReportCSS() {
  return [
    ':root{--accent:#6C5CE7;--accent-light:#A29BFE;--accent-glow:rgba(108,92,231,.22);--bg:#0A0A0C;--card:#18181C;--border:rgba(255,255,255,.075);--text:#fff;--text-body:#C8C8D0;--text-muted:#80808C;--font:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
    '*{margin:0;padding:0;box-sizing:border-box}html{scroll-behavior:smooth}body{background:linear-gradient(180deg,#0A0A0C 0%,#121216 100%);background-attachment:fixed;color:var(--text-body);font-family:var(--font);font-size:15px;line-height:1.6;overflow-x:hidden}',
    'nav{position:fixed;top:0;left:0;right:0;z-index:1000;background:rgba(10,10,12,.82);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:56px}.nav-brand{font-size:14px;font-weight:700;letter-spacing:.12em;color:var(--text-muted);white-space:nowrap}.nav-brand span{color:var(--accent)}.nav-links{display:flex;gap:4px}.nav-links a{font-size:11px;font-weight:500;letter-spacing:.06em;color:var(--text-muted);text-decoration:none;padding:5px 10px;border-radius:6px;transition:all .2s;white-space:nowrap}.nav-links a:hover{color:var(--text);background:rgba(255,255,255,.06)}.nav-links a.active{color:var(--accent);background:rgba(108,92,231,.12)}',
    'section{min-height:100vh;padding:100px 60px 80px;display:flex;flex-direction:column;justify-content:center;position:relative;overflow:hidden}section:nth-child(even){background:rgba(255,255,255,.012)}.section-num{font-size:11px;font-weight:700;letter-spacing:.18em;color:var(--accent);text-transform:uppercase;margin-bottom:8px}.section-title{font-size:clamp(28px,4vw,46px);font-weight:850;color:var(--text);line-height:1.15;margin-bottom:10px;letter-spacing:-.035em}.section-sub{font-size:15px;color:var(--text-muted);margin-bottom:42px;max-width:760px}.divider{width:48px;height:3px;border-radius:2px;background:linear-gradient(90deg,var(--accent),var(--accent-light));margin-bottom:32px}',
    '.fade-in{opacity:0;transform:translateY(28px);transition:opacity .65s ease,transform .65s ease}.fade-in.visible{opacity:1;transform:translateY(0)}.delay-1{transition-delay:.1s}.delay-2{transition-delay:.2s}.delay-3{transition-delay:.3s}.delay-4{transition-delay:.4s}.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 32px}.accent{color:var(--accent)}.accent-grad{background:linear-gradient(90deg,var(--accent),var(--accent-light));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}',
    '#cover{min-height:100vh;background:radial-gradient(ellipse 80% 60% at 50% 40%,rgba(108,92,231,.10) 0%,transparent 70%),radial-gradient(ellipse 40% 40% at 20% 80%,rgba(162,155,254,.05) 0%,transparent 60%),linear-gradient(180deg,#0A0A0C 0%,#121216 100%);align-items:center;justify-content:center;text-align:center;padding:120px 40px 80px}.cover-eyebrow{font-size:11px;font-weight:600;letter-spacing:.22em;color:var(--text-muted);text-transform:uppercase;margin-bottom:28px}.cover-title{font-size:clamp(32px,5.5vw,64px);font-weight:900;color:var(--text);line-height:1.1;margin-bottom:20px;max-width:1080px;letter-spacing:-.045em}.cover-sub{font-size:clamp(14px,2vw,18px);color:var(--text-muted);margin-bottom:48px;max-width:760px;margin-left:auto;margin-right:auto}.chips{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-bottom:56px}.chip{background:rgba(108,92,231,.1);border:1px solid rgba(108,92,231,.3);color:var(--accent-light);font-size:12px;font-weight:600;padding:8px 18px;border-radius:100px;letter-spacing:.04em}.cover-footer{font-size:12px;color:var(--text-muted)}.orb{position:absolute;border-radius:50%;pointer-events:none;z-index:0;filter:blur(80px)}.orb-1{width:500px;height:500px;background:rgba(108,92,231,.06);top:-100px;right:-100px}',
    '.summary-grid,.insight-grid,.game-grid,.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}.summary-card{transition:border-color .3s,transform .3s}.summary-card:hover{border-color:rgba(108,92,231,.3);transform:translateY(-3px)}.summary-num{font-size:11px;font-weight:700;letter-spacing:.14em;color:var(--accent);margin-bottom:10px}.summary-card h3,.insight-card h3,.game-card h3{font-size:16px;font-weight:750;color:var(--text);margin-bottom:10px}.summary-card p,.insight-card p,.game-card p{font-size:13.5px;color:var(--text-muted);line-height:1.68}.insight-icon{font-size:28px;margin-bottom:14px}',
    '.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}.stat-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px;position:relative;overflow:hidden}.stat-card:before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--accent-light))}.stat-num{font-size:clamp(28px,3.5vw,46px);font-weight:900;background:linear-gradient(90deg,var(--accent),var(--accent-light));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1;margin-bottom:8px}.stat-label{font-size:13px;color:var(--text-muted);line-height:1.45}',
    '.wave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}.wave-card{background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;transition:transform .3s}.wave-card:hover{transform:translateY(-4px)}.wave-header{padding:20px 28px 16px;background:linear-gradient(135deg,rgba(108,92,231,.22),rgba(162,155,254,.09))}.wave-num{font-size:10px;font-weight:700;letter-spacing:.18em;color:var(--accent-light)}.wave-title{font-size:18px;font-weight:800;color:var(--text);margin-top:4px}.wave-period{font-size:12px;opacity:.75;font-weight:500;margin-top:2px}.wave-body{padding:24px 28px 28px}.wave-theme{font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px}.wave-actions{font-size:13px;color:var(--text-muted);line-height:1.7}.wave-kpi-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.wave-kpi{background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:11px;color:var(--text-muted)}',
    '.platform-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.platform-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px 20px}.platform-name{font-size:14px;font-weight:750;color:var(--text);margin-bottom:6px}.platform-pct{font-size:30px;font-weight:900;background:linear-gradient(90deg,var(--accent),var(--accent-light));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px}.platform-bar-track,.wb-track{height:7px;background:rgba(255,255,255,.08);border-radius:4px;overflow:hidden}.platform-bar-fill,.wb-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--accent-light));width:0;transition:width 1.2s cubic-bezier(.4,0,.2,1)}.platform-desc{font-size:12px;color:var(--text-muted);margin-top:8px}',
    '.budget-table{width:100%;border-collapse:collapse}.budget-table th{font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--text-muted);text-align:left;padding:8px 12px;border-bottom:1px solid var(--border)}.budget-table td{font-size:13px;color:var(--text-body);padding:12px;border-bottom:1px solid rgba(255,255,255,.04)}.budget-table tr:hover td{background:rgba(255,255,255,.02)}',
    '.gantt-wrap{overflow-x:auto}.gantt{min-width:760px;display:flex;flex-direction:column;gap:10px}.gantt-row{display:grid;grid-template-columns:160px 1fr 240px;gap:10px;align-items:stretch}.gantt-label{font-size:12px;font-weight:700;color:var(--text-body);display:flex;align-items:center;padding:12px;background:rgba(255,255,255,.025);border-radius:8px}.gantt-block{border-radius:8px;min-height:44px;display:flex;align-items:center;padding:10px 14px;background:linear-gradient(135deg,rgba(108,92,231,.45),rgba(162,155,254,.24));font-size:12px;font-weight:650;color:rgba(255,255,255,.9)}.gantt-output{font-size:12px;color:var(--text-muted);display:flex;align-items:center;padding:10px 12px;background:rgba(255,255,255,.025);border-radius:8px}',
    '.kpi-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px}.kpi-card-header{display:flex;align-items:center;gap:10px;margin-bottom:16px}.kpi-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,rgba(108,92,231,.2),rgba(162,155,254,.1));border:1px solid rgba(108,92,231,.2);display:flex;align-items:center;justify-content:center;font-size:16px}.kpi-card-title{font-size:14px;font-weight:750;color:var(--text)}.kpi-item{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px}.kpi-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);margin-top:7px;flex-shrink:0}.kpi-text{font-size:13px;color:var(--text-muted);line-height:1.5}',
    '.material-card{background:rgba(108,92,231,.055);border:1px solid rgba(108,92,231,.22);border-radius:16px;padding:22px}.material-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:10px}.material-title{font-size:15px;font-weight:750;color:var(--text)}.material-state{font-size:11px;color:var(--accent-light);border:1px solid rgba(108,92,231,.35);border-radius:999px;padding:4px 10px;white-space:nowrap}.material-preview{font-size:13px;color:var(--text-muted);line-height:1.65;max-height:180px;overflow:hidden}.highlight-box{background:rgba(108,92,231,.05);border:1px solid rgba(108,92,231,.2);border-radius:12px;padding:20px 24px;margin-top:24px}.highlight-box p{font-size:13.5px;color:var(--text-body);line-height:1.65}.confidential{position:fixed;bottom:16px;right:20px;font-size:10px;color:var(--text-muted);opacity:.4;letter-spacing:.08em;z-index:999}.source-note{font-size:11px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:16px;margin-top:32px;opacity:.7}',
    '#closing{background:radial-gradient(ellipse 70% 60% at 50% 50%,rgba(108,92,231,.08) 0%,transparent 70%),linear-gradient(180deg,#0A0A0C 0%,#121216 100%);text-align:center;align-items:center;justify-content:center}.closing-title{font-size:clamp(28px,5vw,56px);font-weight:900;color:var(--text);line-height:1.15;margin-bottom:20px;max-width:900px}.closing-sub{font-size:18px;color:var(--text-muted);margin-bottom:48px}.closing-footer{font-size:13px;color:var(--text-muted)}',
    '@media(max-width:768px){section{padding:80px 24px 60px}nav{padding:0 16px}.nav-links{display:none}.gantt-row{grid-template-columns:1fr}.confidential{display:none}}@media print{nav,.confidential{display:none}section{min-height:auto;page-break-after:always;padding:48px 36px}.fade-in{opacity:1!important;transform:none!important}}'
  ].join('\n');
}

function renderCampaignSection(sec, idx, allSections) {
  var id = "s" + pad2(idx);
  var type = sec.type || "content";
  var points = normalizePPTPoints(sec.points).slice(0, 8);
  var h = '<section id="' + id + '"><div class="fade-in"><div class="section-num">' + pad2(idx) + ' · ' + esc(sectionEnglishLabel(type, sec.title)) + '</div><h2 class="section-title">' + esc(sec.title || ("章节 " + idx)) + '</h2><div class="divider"></div>';
  if (sec.note) h += '<p class="section-sub">' + esc(sec.note) + '</p>';
  h += '</div>';
  if (type === "timeline") h += renderTimeline(points);
  else if (type === "stats") h += renderStats(points);
  else if (type === "kpi") h += renderKPI(points);
  else if (type === "next") h += renderNextSteps(points);
  else if (/预算|budget|平台|platform/i.test(sec.title || "")) h += renderStats(points);
  else if (/排期|timeline|执行|里程碑/i.test(sec.title || "")) h += renderTimeline(points);
  else h += renderContentCards(points, idx);
  h += '</section>\n';
  return h;
}

function renderContentCards(points, idx) {
  var cls = idx <= 2 ? "summary-grid" : "insight-grid";
  var h = '<div class="' + cls + '">';
  points.forEach(function(p, i) {
    var pair = splitPoint(p);
    h += '<div class="card summary-card fade-in delay-' + Math.min(4, (i % 4) + 1) + '"><div class="summary-num">' + pad2(i + 1) + ' · ' + esc(pair.label) + '</div><h3>' + esc(pair.label) + '</h3><p>' + esc(pair.body) + '</p></div>';
  });
  h += '</div>';
  return h;
}

function renderStats(points) {
  var h = '<div class="platform-grid fade-in delay-1">';
  points.forEach(function(p, i) {
    var pair = splitPoint(p);
    var pct = inferPercent(pair.label + " " + pair.body, i);
    h += '<div class="platform-card"><div class="platform-name">' + esc(pair.label) + '</div><div class="platform-pct">' + esc(metricLead(pair.label)) + '</div><div class="platform-bar-track"><div class="platform-bar-fill" data-width="' + pct + '"></div></div><div class="platform-desc">' + esc(pair.body) + '</div></div>';
  });
  h += '</div><div class="card fade-in delay-2" style="margin-top:28px"><table class="budget-table"><thead><tr><th>模块</th><th>执行说明</th><th>乙方交付物</th></tr></thead><tbody>';
  points.slice(0, 6).forEach(function(p) {
    var pair = splitPoint(p);
    h += '<tr><td>' + esc(pair.label) + '</td><td>' + esc(pair.body) + '</td><td>名单/脚本/上线链接/数据复盘</td></tr>';
  });
  h += '</tbody></table></div>';
  return h;
}

function renderTimeline(points) {
  var h = '<div class="gantt-wrap fade-in delay-1"><div class="gantt">';
  points.forEach(function(p, i) {
    var parts = String(p).split("|");
    var phase = parts[0] || ("阶段 " + (i + 1));
    var time = parts[1] || "待确认";
    var action = parts[2] || p;
    var output = parts[3] || "阶段交付物";
    h += '<div class="gantt-row"><div class="gantt-label">' + esc(phase) + '<br><span style="color:var(--accent);font-size:11px">' + esc(time) + '</span></div><div class="gantt-block">' + esc(action) + '</div><div class="gantt-output">' + esc(output) + '</div></div>';
  });
  h += '</div></div><div class="highlight-box fade-in delay-2"><p>执行原则：每一阶段都要产出可被甲方审核的交付物，避免只停留在策略口号。</p></div>';
  return h;
}

function renderKPI(points) {
  var h = '<div class="kpi-grid fade-in delay-1">';
  points.forEach(function(p, i) {
    var pair = splitPoint(p);
    h += '<div class="kpi-card"><div class="kpi-card-header"><div class="kpi-icon">' + (i + 1) + '</div><div class="kpi-card-title">' + esc(pair.label) + '</div></div><div class="kpi-item"><div class="kpi-dot"></div><div class="kpi-text">' + esc(pair.body) + '</div></div></div>';
  });
  h += '</div><div class="highlight-box fade-in delay-2"><p>复盘机制：周度执行快报、月度效果分析、阶段策略复盘、终期全案复盘，所有数据回到曝光、互动、转化和内容资产四类指标。</p></div>';
  return h;
}

function renderNextSteps(points) {
  var h = '<div class="wave-grid fade-in delay-1">';
  points.forEach(function(p, i) {
    var pair = splitPoint(p);
    h += '<div class="wave-card"><div class="wave-header"><div class="wave-num">NEXT ' + pad2(i + 1) + '</div><div class="wave-title">' + esc(pair.label) + '</div><div class="wave-period">需甲方确认</div></div><div class="wave-body"><div class="wave-actions">' + esc(pair.body) + '</div><div class="wave-kpi-row"><div class="wave-kpi">确认口径</div><div class="wave-kpi">进入执行</div></div></div></div>';
  });
  h += '</div>';
  return h;
}

function renderMaterialsSection(materials) {
  var h = '<section id="materials"><div class="fade-in"><div class="section-num">SOURCE MATERIALS</div><h2 class="section-title">补充材料引用</h2><div class="divider"></div><p class="section-sub">以下内容来自你上传的 PDF / Word / PPTX / Excel / 文本文件。若状态显示“仅文件信息”，说明该文件可能是扫描件或服务器未能提取正文。</p></div><div class="summary-grid">';
  materials.forEach(function(file, idx) {
    h += '<div class="material-card fade-in delay-' + Math.min(4, (idx % 4) + 1) + '"><div class="material-head"><div class="material-title">' + esc(file.name) + '</div><div class="material-state">' + (file.parsed ? "已提取正文" : "仅文件信息") + '</div></div><div class="material-preview">' + esc(file.preview || "未提取到可读正文。") + '</div></div>';
  });
  h += '</div></section>\n';
  return h;
}

function renderClosingSection(brand, product, title) {
  return '<section id="closing"><div class="orb orb-1" style="opacity:.6"></div><div class="fade-in"><h2 class="closing-title">让 <span class="accent-grad">' + esc(brand) + '</span><br>在目标市场建立可复用增长资产</h2></div><div class="fade-in delay-1"><p class="closing-sub">' + esc(product || trimDeckTitle(title, brand, product)) + '</p></div><div class="fade-in delay-2"><div class="chips"><div class="chip">策略 · 达人 · 内容 · 数据闭环</div><div class="chip">可执行交付物</div><div class="chip">PowerPoint 可编辑 PPTX 同步支持</div></div></div><div class="fade-in delay-3"><div class="closing-footer"><div style="font-size:20px;margin-bottom:12px;letter-spacing:.08em;color:var(--text)">Thank You · 感谢垂阅</div><div>Presented by TuringMarket图灵集市</div></div></div></section>\n';
}

function campaignReportScript() {
  return 'const fadeEls=document.querySelectorAll(".fade-in");const fadeObserver=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add("visible")})},{threshold:.12});fadeEls.forEach(el=>fadeObserver.observe(el));document.querySelectorAll(".platform-bar-fill[data-width],.wb-fill[data-width]").forEach(el=>{new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting)e.target.style.width=e.target.dataset.width+"%"})},{threshold:.3}).observe(el)});const sections=document.querySelectorAll("section[id]");const navLinks=document.querySelectorAll(".nav-links a");const navObserver=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting){const id=e.target.getAttribute("id");navLinks.forEach(a=>{a.classList.remove("active");if((a.getAttribute("href")||"").replace("#","")===id)a.classList.add("active")})}})},{threshold:.4});sections.forEach(s=>navObserver.observe(s));';
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function inferBrandFromTitle(title) {
  var text = String(title || "").trim();
  return text.split(/\s+/)[0] || "";
}

function trimDeckTitle(title, brand, product) {
  var text = String(title || "").trim();
  [brand, product].forEach(function(part) {
    if (part) text = text.replace(new RegExp(escapeRegExp(part), "ig"), "").trim();
  });
  return text.replace(/^[·\-\s]+/, "") || "海外红人营销 Campaign";
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function coverChips(data) {
  var text = JSON.stringify(data || {});
  var chips = [];
  var budget = (text.match(/\$[0-9][0-9,Kk+\-– ]+/) || [])[0];
  if (budget) chips.push("预算 " + budget);
  if (/YouTube/i.test(text)) chips.push("YouTube 深度评测");
  if (/TikTok/i.test(text)) chips.push("TikTok 短视频种草");
  if (/Instagram|Reels/i.test(text)) chips.push("Instagram Reels 视觉传播");
  if (!chips.length) chips = ["策略 · 达人 · 内容 · 数据闭环", "甲方汇报版", "TuringMarket 图灵集市"];
  return chips.slice(0, 4);
}

function sectionEnglishLabel(type, title) {
  var text = String(title || "");
  if (type === "research" || /联网调研|市场信号|调研/.test(text)) return "MARKET RESEARCH";
  if (type === "sources" || /来源|引用/.test(text)) return "SOURCES";
  if (type === "timeline" || /排期|timeline|里程碑/i.test(text)) return "TIMELINE";
  if (type === "stats" || /预算|budget|平台|platform/i.test(text)) return "BUDGET & CHANNEL MIX";
  if (type === "kpi" || /KPI|复盘|指标/i.test(text)) return "KPI & REVIEW";
  if (type === "next" || /下一步|确认/i.test(text)) return "NEXT STEPS";
  if (/竞品|市场/i.test(text)) return "MARKET INSIGHTS";
  if (/内容|脚本|创意/i.test(text)) return "CONTENT STRATEGY";
  if (/红人|达人/i.test(text)) return "INFLUENCER MATRIX";
  return "STRATEGY";
}

function splitPoint(point) {
  var text = String(point || "").trim();
  var parts = text.split(/[:：]/);
  if (parts.length > 1) {
    return {
      label: parts.shift().trim() || "策略要点",
      body: parts.join(":").trim() || text
    };
  }
  return { label: text.slice(0, 18) || "策略要点", body: text || "待补充执行说明" };
}

function metricLead(text) {
  var s = String(text || "");
  var match = s.match(/(\d+%|\$[0-9][0-9,Kk+\-– ]*|[0-9]+[KkWw万+]*)/);
  return match ? match[1] : "●";
}

function inferPercent(text, idx) {
  var match = String(text || "").match(/(\d{1,3})%/);
  if (match) return Math.max(6, Math.min(100, Number(match[1])));
  return [60, 45, 35, 25, 20, 15][idx % 6];
}

function safeDeckFileName(ext) {
  return (curDemand?.brand || "proposal").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_") + "_TuringMarket方案." + ext;
}

function downloadHTMLPPT() {
  if (!lastPPT) {
    toast("请先生成 PPT", "error");
    return;
  }
  downloadTextFile(safeDeckFileName("html"), lastPPT, "text/html;charset=utf-8");
  toast("HTML PPT 已下载");
}

function downloadTextFile(filename, content, mime) {
  var blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

async function downloadPPTX() {
  if (!lastPPTOutline) {
    toast("请先生成 PPT", "error");
    return;
  }
  try {
    var r = await apiFetch("/proposal/generate-ppt", {
      method: "POST",
      body: JSON.stringify({
        outline: lastPPTOutline,
        demand: curDemand || {}
      })
    });
    if (!r.ok) {
      var err = await r.json().catch(function() { return {}; });
      throw new Error(err.error || ("PPTX 生成失败: " + r.status));
    }
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = safeDeckFileName("pptx");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("PPTX 已生成，可在 PowerPoint 中编辑");
  } catch (e) {
    toast("PPTX 生成失败: " + e.message, "error");
  }
}

function previewPPT() {
  if (!lastPPT) {
    toast("请先生成 PPT", "error");
    return;
  }
  var w = window.open("", "_blank");
  if (!w) {
    toast("浏览器阻止了新窗口，请允许弹窗后重试", "error");
    return;
  }
  w.document.write(lastPPT);
  w.document.close();
}

function copyPPTSource() {
  if (!lastPPT) {
    toast("请先生成 PPT", "error");
    return;
  }
  navigator.clipboard.writeText(lastPPT).then(function() {
    toast("PPT 源码已复制");
  }).catch(function() {
    toast("复制失败，请改用下载 HTML", "error");
  });
}

var pptEditorSelectedIndex = 0;

function ensurePPTEditorShell() {
  if (document.getElementById("tmPPTEditorOverlay")) return;
  var style = document.createElement("style");
  style.id = "tmPPTEditorStyle";
  style.textContent = [
    ".tm-ppt-editor-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.48);backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:24px}",
    ".tm-ppt-editor{width:min(1180px,96vw);height:min(780px,92vh);background:#fff;border-radius:24px;box-shadow:0 30px 90px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}",
    ".tm-ppt-editor-head{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:18px 22px;border-bottom:1px solid #e5e7eb}",
    ".tm-ppt-editor-head h3{margin:0;font-size:18px}.tm-ppt-editor-head p{margin:4px 0 0;color:#64748b;font-size:12px}",
    ".tm-ppt-editor-body{display:grid;grid-template-columns:310px 1fr;min-height:0;flex:1}",
    ".tm-ppt-slide-list{border-right:1px solid #e5e7eb;background:#f8fafc;padding:14px;overflow:auto}",
    ".tm-ppt-slide-item{width:100%;text-align:left;border:1px solid #e5e7eb;background:#fff;border-radius:14px;padding:10px 12px;margin-bottom:8px;cursor:pointer;color:#0f172a}",
    ".tm-ppt-slide-item.active{border-color:#2563eb;background:#eff6ff}.tm-ppt-slide-item b{display:block;font-size:12px}.tm-ppt-slide-item span{display:block;font-size:11px;color:#64748b;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".tm-ppt-editor-form{padding:18px 22px;overflow:auto}.tm-ppt-editor-form label{display:block;font-size:12px;color:#475569;margin:12px 0 6px;font-weight:700}",
    ".tm-ppt-editor-form input,.tm-ppt-editor-form select,.tm-ppt-editor-form textarea{width:100%;border:1px solid #dbe3ef;border-radius:12px;padding:10px 12px;font-size:13px;background:#fff;color:#0f172a}",
    ".tm-ppt-editor-form textarea{min-height:220px;resize:vertical;line-height:1.55}.tm-ppt-row{display:grid;grid-template-columns:1fr 170px;gap:12px}",
    ".tm-ppt-editor-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.tm-ppt-editor-actions .btn{white-space:nowrap}",
    "@media(max-width:860px){.tm-ppt-editor-body{grid-template-columns:1fr}.tm-ppt-slide-list{max-height:220px;border-right:0;border-bottom:1px solid #e5e7eb}.tm-ppt-row{grid-template-columns:1fr}}"
  ].join("\n");
  document.head.appendChild(style);

  var overlay = document.createElement("div");
  overlay.id = "tmPPTEditorOverlay";
  overlay.className = "tm-ppt-editor-overlay";
  overlay.onclick = function(event) {
    if (event.target === overlay) closePPTEditor();
  };
  overlay.innerHTML = [
    '<div class="tm-ppt-editor" onclick="event.stopPropagation()">',
    '<div class="tm-ppt-editor-head">',
    '<div><h3>编辑 HTMLPPT / PPTX 大纲</h3><p>这里修改的是结构化 slides 数据，保存后 HTMLPPT 和 PPTX 会同步使用。</p></div>',
    '<div class="tm-ppt-editor-actions">',
    '<button class="btn btn-outline btn-sm" onclick="previewEditedPPT()">预览</button>',
    '<button class="btn btn-primary btn-sm" onclick="savePPTEditorAndRender()">保存并重新生成</button>',
    '<button class="btn btn-outline btn-sm" onclick="closePPTEditor()">关闭</button>',
    '</div></div>',
    '<div class="tm-ppt-editor-body">',
    '<aside class="tm-ppt-slide-list"><div id="pptEditorSlideList"></div><button class="btn btn-outline btn-sm" style="width:100%;margin-top:8px" onclick="addPPTEditorSlide()">+ 新增页面</button></aside>',
    '<section class="tm-ppt-editor-form">',
    '<label>方案标题</label><input id="pptEditorDeckTitle">',
    '<label>副标题</label><input id="pptEditorDeckSubtitle">',
    '<div class="tm-ppt-row"><div><label>当前页标题</label><input id="pptEditorSlideTitle"></div><div><label>页面类型</label><select id="pptEditorSlideType"><option value="cover">cover 封面</option><option value="content">content 内容</option><option value="research">research 调研</option><option value="stats">stats 数据/预算</option><option value="timeline">timeline 排期</option><option value="kpi">kpi 指标</option><option value="next">next 下一步</option><option value="closing">closing 结尾</option><option value="sources">sources 来源</option></select></div></div>',
    '<label>当前页备注 / 小标题</label><input id="pptEditorSlideNote">',
    '<label>当前页要点（一行一个要点；预算、排期、KPI 会按页面类型自动排版）</label><textarea id="pptEditorSlidePoints"></textarea>',
    '<div class="tm-ppt-editor-actions" style="margin-top:14px">',
    '<button class="btn btn-outline btn-sm" onclick="movePPTEditorSlide(-1)">上移</button>',
    '<button class="btn btn-outline btn-sm" onclick="movePPTEditorSlide(1)">下移</button>',
    '<button class="btn btn-outline btn-sm" onclick="duplicatePPTEditorSlide()">复制当前页</button>',
    '<button class="btn btn-outline btn-sm" onclick="deletePPTEditorSlide()">删除当前页</button>',
    '</div>',
    '</section></div></div>'
  ].join("");
  document.body.appendChild(overlay);
}

function getEditablePPTOutline() {
  if (!lastPPTOutline) return null;
  if (!Array.isArray(lastPPTOutline.sections)) lastPPTOutline.sections = [];
  if (!lastPPTOutline.sections.length) {
    lastPPTOutline.sections.push({ title: lastPPTOutline.title || "方案封面", type: "cover", points: [lastPPTOutline.subtitle || ""], note: "" });
  }
  return lastPPTOutline;
}

function openPPTEditor() {
  var outline = getEditablePPTOutline();
  if (!outline) {
    toast("请先生成 PPT，再进入编辑模式", "error");
    return;
  }
  ensurePPTEditorShell();
  var overlay = document.getElementById("tmPPTEditorOverlay");
  if (overlay) overlay.style.display = "flex";
  pptEditorSelectedIndex = Math.max(0, Math.min(pptEditorSelectedIndex || 0, outline.sections.length - 1));
  renderPPTEditor();
}

function closePPTEditor() {
  var overlay = document.getElementById("tmPPTEditorOverlay");
  if (overlay) overlay.style.display = "none";
}

function renderPPTEditor() {
  var outline = getEditablePPTOutline();
  if (!outline) return;
  var sections = outline.sections;
  pptEditorSelectedIndex = Math.max(0, Math.min(pptEditorSelectedIndex || 0, sections.length - 1));
  var list = document.getElementById("pptEditorSlideList");
  if (list) {
    list.innerHTML = sections.map(function(sec, idx) {
      return '<button class="tm-ppt-slide-item ' + (idx === pptEditorSelectedIndex ? 'active' : '') + '" onclick="selectPPTEditorSlide(' + idx + ')">'
        + '<b>' + pad2(idx + 1) + ' · ' + esc(sec.type || "content") + '</b>'
        + '<span>' + esc(sec.title || "未命名页面") + '</span></button>';
    }).join("");
  }
  var title = document.getElementById("pptEditorDeckTitle");
  var subtitle = document.getElementById("pptEditorDeckSubtitle");
  if (title) title.value = outline.title || "";
  if (subtitle) subtitle.value = outline.subtitle || "";
  var sec = sections[pptEditorSelectedIndex] || {};
  var slideTitle = document.getElementById("pptEditorSlideTitle");
  var slideType = document.getElementById("pptEditorSlideType");
  var slideNote = document.getElementById("pptEditorSlideNote");
  var slidePoints = document.getElementById("pptEditorSlidePoints");
  if (slideTitle) slideTitle.value = sec.title || "";
  if (slideType) slideType.value = sec.type || "content";
  if (slideNote) slideNote.value = sec.note || "";
  if (slidePoints) slidePoints.value = normalizePPTPoints(sec.points).join("\n");
}

function applyPPTEditorForm() {
  var outline = getEditablePPTOutline();
  if (!outline) return false;
  var title = document.getElementById("pptEditorDeckTitle");
  var subtitle = document.getElementById("pptEditorDeckSubtitle");
  if (title) outline.title = title.value.trim() || outline.title || "TuringMarket 提案";
  if (subtitle) outline.subtitle = subtitle.value.trim() || outline.subtitle || "";
  var sec = outline.sections[pptEditorSelectedIndex];
  if (sec) {
    var slideTitle = document.getElementById("pptEditorSlideTitle");
    var slideType = document.getElementById("pptEditorSlideType");
    var slideNote = document.getElementById("pptEditorSlideNote");
    var slidePoints = document.getElementById("pptEditorSlidePoints");
    sec.title = (slideTitle && slideTitle.value.trim()) || sec.title || "方案页";
    sec.type = (slideType && slideType.value) || sec.type || "content";
    sec.note = (slideNote && slideNote.value.trim()) || "";
    sec.points = String((slidePoints && slidePoints.value) || "").split(/\n+/).map(function(line) {
      return line.trim();
    }).filter(Boolean);
  }
  return true;
}

function rebuildPPTFromEditor(showToast) {
  var outline = getEditablePPTOutline();
  if (!outline) return;
  if (outline.sections[0] && outline.sections[0].type === "cover") {
    outline.sections[0].title = outline.title || outline.sections[0].title;
    if (!outline.sections[0].points || !outline.sections[0].points.length) outline.sections[0].points = [outline.subtitle || ""];
  }
  lastPPTOutline = outline;
  lastPPT = buildRevealHTML(outline);
  lastPPTSource = JSON.stringify(outline, null, 2);
  renderPPTResult(outline, "", "");
  if (showToast) toast("已保存编辑并重新生成 HTMLPPT / PPTX 大纲");
}

function savePPTEditorAndRender() {
  if (!applyPPTEditorForm()) return;
  rebuildPPTFromEditor(true);
  renderPPTEditor();
}

function previewEditedPPT() {
  if (!applyPPTEditorForm()) return;
  rebuildPPTFromEditor(false);
  previewPPT();
}

function selectPPTEditorSlide(idx) {
  applyPPTEditorForm();
  var outline = getEditablePPTOutline();
  if (!outline) return;
  pptEditorSelectedIndex = Math.max(0, Math.min(idx, outline.sections.length - 1));
  renderPPTEditor();
}

function addPPTEditorSlide() {
  applyPPTEditorForm();
  var outline = getEditablePPTOutline();
  if (!outline) return;
  var insertAt = Math.min(outline.sections.length, pptEditorSelectedIndex + 1);
  outline.sections.splice(insertAt, 0, {
    title: "新增页面",
    type: "content",
    note: "",
    points: ["请在这里填写页面要点"]
  });
  pptEditorSelectedIndex = insertAt;
  renderPPTEditor();
}

function duplicatePPTEditorSlide() {
  applyPPTEditorForm();
  var outline = getEditablePPTOutline();
  if (!outline) return;
  var sec = outline.sections[pptEditorSelectedIndex];
  var copy = JSON.parse(JSON.stringify(sec || { title: "复制页面", type: "content", points: [] }));
  copy.title = (copy.title || "复制页面") + " 副本";
  outline.sections.splice(pptEditorSelectedIndex + 1, 0, copy);
  pptEditorSelectedIndex += 1;
  renderPPTEditor();
}

function deletePPTEditorSlide() {
  applyPPTEditorForm();
  var outline = getEditablePPTOutline();
  if (!outline || outline.sections.length <= 1) {
    toast("至少保留一页", "error");
    return;
  }
  outline.sections.splice(pptEditorSelectedIndex, 1);
  pptEditorSelectedIndex = Math.max(0, Math.min(pptEditorSelectedIndex, outline.sections.length - 1));
  renderPPTEditor();
}

function movePPTEditorSlide(delta) {
  applyPPTEditorForm();
  var outline = getEditablePPTOutline();
  if (!outline) return;
  var from = pptEditorSelectedIndex;
  var to = from + delta;
  if (to < 0 || to >= outline.sections.length) return;
  var item = outline.sections.splice(from, 1)[0];
  outline.sections.splice(to, 0, item);
  pptEditorSelectedIndex = to;
  renderPPTEditor();
}

if (typeof window !== "undefined") {
  window.tmPPTBuild = "20260630-ppteditor";
  window.generateHTMLPPT = generateHTMLPPT;
  window.handlePPTContextFile = handlePPTContextFile;
  window.addPPTInstruction = addPPTInstruction;
  window.clearPPTContext = clearPPTContext;
  window.downloadHTMLPPT = downloadHTMLPPT;
  window.downloadPPTX = downloadPPTX;
  window.previewPPT = previewPPT;
  window.copyPPTSource = copyPPTSource;
  window.openPPTEditor = openPPTEditor;
  window.closePPTEditor = closePPTEditor;
  window.savePPTEditorAndRender = savePPTEditorAndRender;
  window.previewEditedPPT = previewEditedPPT;
  window.selectPPTEditorSlide = selectPPTEditorSlide;
  window.addPPTEditorSlide = addPPTEditorSlide;
  window.duplicatePPTEditorSlide = duplicatePPTEditorSlide;
  window.deletePPTEditorSlide = deletePPTEditorSlide;
  window.movePPTEditorSlide = movePPTEditorSlide;
}
