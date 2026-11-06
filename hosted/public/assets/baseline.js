// Public NVIDIA baseline; its content hash and recorded approval are carried in provenance.
// Approval records are not included in this public snapshot.
const l = (en, zh) => ({ en, zh });
export const baseline = {
  schemaVersion: 2,
  id: "NVDA_PRODUCT_BASELINE_V1",
  version: 1,
  asOf: "2026-10-07",
  reconciledAt: "2026-10-14",
  evidenceThrough: "2026-08-26",
  statement: l("NVIDIA's AI infrastructure platform can sustain attractive growth and economics if demand remains durable, architecture transitions execute on time, its software and system advantages withstand substitution, and market access remains commercially meaningful, especially in China. These assumptions require separate evidence; a product or earnings headline alone does not justify rewriting the thesis.", "如果需求保持持久、架构换代按时执行、软件与系统优势经得起替代，且市场准入（尤其是中国市场）在商业上仍有实质意义，NVIDIA 的 AI 基础设施平台就能够维持有吸引力的增长与经济性。这些假设各自需要独立的证据；仅凭一则产品或财报标题，不足以改写这份投资逻辑。"),
  families: {
    nvidia_sec: {
      title: l("NVIDIA SEC / EDGAR", "NVIDIA SEC / EDGAR 披露"),
      intake: "manual",
    },
    nvidia_ir: {
      title: l("NVIDIA Investor Relations", "NVIDIA 投资者关系材料"),
      intake: "manual",
    },
    nvidia_earnings: {
      title: l("NVIDIA earnings materials", "NVIDIA 财报材料"),
      intake: "manual",
    },
  },
  sources: [
    {
      id: "NVDA_FY2026_10K",
      family: "nvidia_sec",
      publishedAt: "2026-02-25",
      title: l("FY2026 Form 10-K · Business / Risk Factors", "FY2026 10-K · 业务与风险因素"),
      url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm",
      summary: l("NVIDIA describes its CUDA and integrated platform, and discloses competition, supply and demand-estimation risks. Its own description does not independently establish a durable moat.", "NVIDIA 描述了 CUDA 与集成平台，并披露竞争、供给和需求估计风险。公司自述不能独立证明护城河持续存在。"),
    },
    {
      id: "NVDA_Q2FY2027_RELEASE",
      family: "nvidia_earnings",
      publishedAt: "2026-08-26",
      title: l("Q2 FY2027 earnings release · Results / Outlook", "FY2027 Q2 财报新闻稿 · 业绩与指引"),
      url: "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-Second-Quarter-Fiscal-2027/",
      summary: l("The release reports Data Center growth, product-production updates and gross margins. These are reported results and management statements, not proof of future demand or independent deployment verification.", "新闻稿披露数据中心增长、产品量产进展及毛利率。这些是已报告结果与管理层表述，不能证明未来需求，也不是对部署情况的独立核实。"),
      reference: {
        metric: "GAAP gross margin",
        value: 75,
        unit: "%",
        period: "Q2 FY2027",
        quote: "GAAP and non-GAAP gross margins were both 75.0%.",
      },
    },
    {
      id: "NVDA_Q2FY2027_10Q",
      family: "nvidia_sec",
      publishedAt: "2026-08-26",
      title: l("Q2 FY2027 Form 10-Q · MD&A / Financial Statements", "FY2027 Q2 10-Q · 管理层讨论与财务报表"),
      url: "https://investor.nvidia.com/files/doc_financials/2027/NVDA-2027-Q2-10Q-Final-including-exhibits.pdf",
      summary: l("The filing provides comparable financials and explains product-mix and inventory effects. Read those explanations before attributing a margin change to structural pricing pressure.", "报告提供可比财务数据，并解释产品组合与库存影响。将毛利率变化归因于结构性价格压力前，应先审阅这些解释。"),
    },
  ],
  boundaries: [
    l("Source coverage is a design map. Automated acquisition and Check for Updates have not started; no monitored-through checkpoint exists.", "来源覆盖只是一张设计图。自动获取与 Check for Updates 尚未启动；不存在“已监控至某日”的检查点。"),
    l("Market access is a separate fifth driver, with China the focus requested by the owner. NVIDIA's own exposure and licensing disclosures are observable; official policy/export-control feeds remain outside this slice.", "市场准入是独立的第五个驱动因素，重点是 Owner 要求的中国市场。NVIDIA 自身的敞口与许可披露可以观察；官方政策/出口管制信息源仍不在这一范围内。"),
    l("NVIDIA-only sources cannot independently verify customer returns, compute-market slack, Token prices/API volumes, CoWoS/HBM capacity allocations, customer accelerator advantages or third-party benchmarks. These watches are explicit monitoring gaps.", "仅依靠 NVIDIA 自身来源，无法独立核实客户回报、算力市场的闲置程度、Token 价格/API 调用量、CoWoS/HBM 产能配额、客户自研加速器优势或第三方评测基准。这些关注项是明确的监控盲区。"),
    l("The owner's mid-weak customer-built accelerator signal and weak benchmark signal retain their stated strengths. Neither is an automatic thesis change; workload comparability, persistence, magnitude and review windows need human judgment.", "Owner 设定的 mid-weak（客户自研加速器）信号与 weak（评测基准）信号保持其既定强度。二者都不会自动改变投资逻辑；工作负载可比性、持续性、幅度和复核窗口都需要人工判断。"),
    l("Token/API measures are demand proxies. Lower prices alone require interpretation of comparable units, workloads and efficiency; they do not establish a market-wide supply/demand balance.", "Token/API 指标只是需求的代理指标。仅价格下降，仍须结合可比的计量单位、工作负载和效率来解读；它们不能确立全市场的供需平衡。"),
  ],
  // Stated apart from the investment statement so that restoring the approved statement does not change it.
  notices: [
    {
      id: "NOT_ADVICE",
      text: l("This NVIDIA baseline is not a stock valuation or a buy/sell recommendation.", "此 NVIDIA 基准不是股票估值，也不构成买入或卖出建议。"),
    },
  ],
  // Dated, cited facts kept apart from the thesis. Each part has one role so that a disclosure, a forward-looking
  // assumption, possible weakening evidence and the state of the actual falsifier are never blended together.
  contextNotes: [
    {
      id: "CTX.D5.1",
      driverId: "D5",
      falsifierIds: ["D5.F1"],
      watchIds: ["W5.1", "W5.2"],
      sourceId: "NVDA_Q2FY2027_RELEASE",
      publishedAt: "2026-08-26",
      citation: {
        document: l("Form 8-K · Exhibit 99.1 (q2fy27pr.htm) · accession 0001045810-26-000073", "Form 8-K · 附件 99.1（q2fy27pr.htm）· 受理编号 0001045810-26-000073"),
        url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm",
      },
      title: l("Dated factual context · NVIDIA's Q3 FY2027 outlook and China", "带日期的事实背景 · NVIDIA 的 FY2027 Q3 指引与中国"),
      parts: [
        {
          kind: "reported_disclosure",
          text: l("On 2026-08-26 NVIDIA published its Q2 FY2027 results release (Form 8-K, Exhibit 99.1). Its outlook for the third quarter of fiscal 2027 includes the sentence quoted below, which is the only mention of China in that release.", "2026-08-26，NVIDIA 发布了 FY2027 Q2 业绩新闻稿（Form 8-K，附件 99.1）。其 FY2027 第三季度指引中包含下方引用的这句话，这也是该新闻稿中唯一一处提及中国的地方。"),
          quote: "NVIDIA is not assuming any Data Center compute revenue from China in its outlook.",
        },
        {
          kind: "forward_looking_assumption",
          text: l("This is management's planning assumption for the third quarter of fiscal 2027, not a reported result. The release gives no reason, does not mention export controls or licensing, and does not discuss a recovery path.", "这是管理层对 FY2027 Q3 的规划假设，而不是已报告的结果。该新闻稿没有给出原因，没有提及出口管制或许可，也没有讨论恢复路径。"),
        },
        {
          kind: "relevance_for_review",
          text: l("It bears on D5's core assumption that permitted products and licenses allow commercially meaningful sales in China, and may weaken it. It is a single forward-looking data point from one source; this system has not assessed it, and its weight is a human judgment.", "它涉及 D5 的核心假设——获准销售的产品与许可使在中国实现具有商业意义的销售成为可能——并可能削弱该假设。这只是来自单一来源的一个前瞻性数据点；本系统尚未对其进行评估，其分量需由人来判断。"),
        },
        {
          kind: "falsifier_status",
          text: l("D5.F1 is not recorded as triggered. It requires NVIDIA to report, across two quarterly disclosures, regulatory or licensing constraints that prevent commercially meaningful China sales, with no disclosed recovery path; this outlook sentence does not itself say that. Equally, nothing here confirms D5: later disclosures have not been checked, and independent export-control evidence (W5.2) remains a monitoring gap. Only your explicit decision changes a Standing Thesis.", "D5.F1 未被记录为已触发。该条件要求 NVIDIA 在两次季度披露中报告监管或许可约束使其无法实现具有商业意义的中国销售、且未披露恢复路径；这句指引本身并未陈述这一点。同样，这里的内容也不能证实 D5：后续披露尚未核查，独立的出口管制证据（W5.2）仍是监控盲区。只有你的明确决定才能改变当前投资逻辑。"),
        },
      ],
    },
  ],
  drivers: [
    {
      id: "D1",
      title: l("AI infrastructure demand durability", "AI 基础设施需求持续性"),
      statement: l("Durable AI infrastructure demand can support NVIDIA Data Center growth.", "持久的 AI 基础设施需求能够支撑 NVIDIA 数据中心的增长。"),
      coreAssumption: l("Customer deployment demand persists beyond a single purchasing cycle; NVIDIA's disclosures are an incomplete proxy for customer economics. Aggregate demand for AI training and inference compute continues to exceed total market supply.", "客户的部署需求能够延续到单一采购周期之后；NVIDIA 的披露只是客户经济性的不完整代理指标。AI训练与推理的算力总需求持续超过市场总供给。"),
      whatToWatch: l("Reported Data Center growth, forward guidance and management's demand/deployment commentary; compute idleness, subleasing and rental prices; Token prices and API call volumes. Independent customer utilization, returns and market-wide supply/demand remain gaps.", "已披露的数据中心增长、前瞻指引，以及管理层对需求与部署的表述；算力闲置、转租与租赁价格；Token 价格与 API 调用量。客户的独立利用率、回报以及全市场的供需，仍是监控盲区。"),
      importance: l("Product strength only produces durable growth if customers keep deploying compute.", "客户持续部署算力，产品优势才能转化为持续增长。"),
      sourceIds: ["NVDA_Q2FY2027_RELEASE", "NVDA_Q2FY2027_10Q", "NVDA_FY2026_10K"],
      falsifiers: [
        {
          id: "D1.F1",
          condition: l("Over the next two quarterly disclosures, Data Center growth slows in both periods and forward guidance or management commentary indicates sustained weaker deployment demand.", "在未来两次季度披露中，数据中心增速在两个期间均放缓，且前瞻指引或管理层表述表明部署需求持续转弱。"),
          reviewQuarters: 2,
          signal: null,
          watchIds: ["W1.1", "W1.2", "W1.4"],
        },
        {
          id: "D1.F2",
          condition: l("Compute capacity appears idle, is offered for sublease, or is repriced lower in the market.", "算力在市场上出现闲置、转租或降价。"),
          reviewQuarters: null,
          signal: null,
          watchIds: ["W1.3"],
        },
      ],
      watchItems: [
        {
          id: "W1.1",
          researchNeedId: "N1.1",
          priority: "high",
          triggerKind: "mixed",
          title: l("NVIDIA demand disclosures", "NVIDIA 需求相关披露"),
          question: l("Do consecutive NVIDIA disclosures show slowing Data Center growth and weaker forward deployment demand?", "NVIDIA 连续披露的内容是否显示数据中心增速放缓，以及前瞻部署需求转弱？"),
          observationScope: l("NVIDIA-reported Data Center revenue and growth, guidance and management demand/deployment commentary.", "NVIDIA 已披露的数据中心收入与增长、指引，以及管理层对需求和部署的表述。"),
          sourceFamilies: ["nvidia_sec", "nvidia_ir", "nvidia_earnings"],
          gapReason: null,
          cannotVerify: l("NVIDIA revenue growth does not independently prove customers' end demand, utilization or ROI. Absence of weak-demand language is not confirmation of this driver.", "NVIDIA 收入增长不能独立证明客户终端需求、利用率或投资回报。没有需求转弱表述，也不能确认这一 Driver。"),
        },
        {
          id: "W1.2",
          researchNeedId: "N1.2",
          priority: "high",
          triggerKind: "mixed",
          title: l("Independent customer economics", "独立的客户经济性"),
          question: l("Do customers' independent utilization and returns corroborate durable deployment demand?", "客户独立的利用率与回报，是否印证了持续的部署需求？"),
          observationScope: l("Independent customer utilization, spending commitments and returns on AI infrastructure.", "客户独立的利用率、支出承诺，以及 AI 基础设施的投资回报。"),
          sourceFamilies: [],
          gapReason: l("NVIDIA-only documents cannot independently observe customer utilization or returns. External customer sources are not connected.", "仅依靠 NVIDIA 自身文件，无法独立观察客户的利用率或回报。外部客户来源尚未接入。"),
        },
        {
          id: "W1.3",
          researchNeedId: "N1.3",
          priority: "high",
          triggerKind: "mixed",
          title: l("Compute market slack and pricing", "算力市场的闲置与定价"),
          question: l("Is compute capacity idle, offered for sublease or repriced lower in the market?", "算力是否在市场上出现闲置、被转租或降价？"),
          observationScope: l("Comparable compute utilization, capacity subleasing and rental prices across the market; geographic scope, units and observation window require owner confirmation.", "全市场可比的算力利用率、产能转租与租赁价格；地域范围、计量单位和观察窗口需由 Owner 确认。"),
          sourceFamilies: [],
          gapReason: l("NVIDIA-only disclosures cannot independently observe market-wide idle capacity, subleasing or compute rental prices. External compute-market sources are not connected.", "仅依靠 NVIDIA 自身披露，无法独立观察全市场的闲置产能、转租或算力租赁价格。外部算力市场来源尚未接入。"),
        },
        {
          id: "W1.4",
          researchNeedId: "N1.4",
          priority: "high",
          triggerKind: "mixed",
          title: l("Token prices and API call volumes", "Token 价格与 API 调用量"),
          question: l("Do Token prices and API call volumes support durable AI training and inference demand?", "Token 价格与 API 调用量是否支持 AI 训练与推理需求的持续性？"),
          observationScope: l("Token prices and API call volumes across comparable services and workloads; these are demand proxies and do not measure total training/inference compute or market supply.", "可比服务与工作负载上的 Token 价格和 API 调用量；它们只是需求的代理指标，并不能衡量训练/推理算力总量或市场供给。"),
          sourceFamilies: [],
          gapReason: l("Independent Token pricing and API usage sources are not connected. NVIDIA-only materials cannot independently establish these market-wide measures.", "独立的 Token 定价与 API 使用量来源尚未接入。仅依靠 NVIDIA 自身材料，无法独立确立这些全市场指标。"),
        },
      ],
    },
    {
      id: "D2",
      title: l("Product and supply ramp execution", "产品与产能爬坡执行"),
      statement: l("Architecture transitions can reach production and customer deployment without a material product gap.", "架构换代能够完成量产并交付客户部署，不出现实质性的产品断档。"),
      coreAssumption: l("New-platform supply and deployment can ramp while the prior generation continues serving customers. CoWoS and HBM are the key constraints, and NVIDIA holds priority allocations in critical production capacity.", "新平台的供应与部署能够爬坡，同时上一代产品继续服务客户。关键约束在 CoWoS 与 HBM，且 NVIDIA 在关键产能中占据优先配额。"),
      whatToWatch: l("Changes to NVIDIA's announced production/deployment timetable, supply constraints and transition commentary in MD&A, risk factors and earnings materials. TSMC CoWoS monthly capacity and expansion plans, NVIDIA's share of CoWoS allocations, and HBM supply/allocation constraints. Independent supplier capacity and allocation data remain gaps.", "NVIDIA 在 MD&A、风险因素和财报材料中对已公布量产/部署时间表的调整、供给约束及换代表述。台积电 CoWoS 月产能与扩张计划、NVIDIA 占 CoWoS 配额的比例，以及 HBM 供给/配额约束。供应商产能与配额的独立数据，仍是监控盲区。"),
      importance: l("Demand cannot become revenue if production, quality or delivery fails.", "量产、质量或交付失效，会阻断需求向收入的转化。"),
      sourceIds: ["NVDA_FY2026_10K", "NVDA_Q2FY2027_RELEASE", "NVDA_Q2FY2027_10Q"],
      falsifiers: [
        {
          id: "D2.F1",
          condition: l("In the next two quarterly updates, NVIDIA discloses a production or deployment delay of at least one quarter versus its prior announced schedule, or supply disruption that materially impairs the revenue outlook.", "在未来两次季度更新中，NVIDIA 披露量产或部署较此前公布的时间表推迟至少一个季度，或披露了实质性损害收入前景的供应中断。"),
          reviewQuarters: 2,
          signal: null,
          watchIds: ["W2.1", "W2.2"],
        },
      ],
      watchItems: [
        {
          id: "W2.1",
          researchNeedId: "N2.1",
          priority: "high",
          triggerKind: "documentary",
          title: l("Production and deployment timetable", "量产与部署时间表"),
          question: l("Has NVIDIA revised its announced production/deployment schedule or disclosed a material supply disruption?", "NVIDIA 是否调整了已公布的量产/部署时间表，或披露了实质性的供应中断？"),
          observationScope: l("NVIDIA's announced schedules and disclosed supply/transition risks; undisclosed supplier yields are not independently verified.", "NVIDIA 已公布的时间表，以及已披露的供应/换代风险；未披露的供应商良率无法独立核实。"),
          sourceFamilies: ["nvidia_sec", "nvidia_ir", "nvidia_earnings"],
          gapReason: null,
          cannotVerify: l("Unreported manufacturing yields and customer-site deployment progress cannot be independently checked. NVIDIA-only coverage is limited to disclosed milestones.", "未披露的制造良率和客户现场部署进度不能独立核实。NVIDIA-only 范围只能观察已披露节点。"),
        },
        {
          id: "W2.2",
          researchNeedId: "N2.2",
          priority: "high",
          triggerKind: "mixed",
          title: l("CoWoS capacity and NVIDIA allocation", "CoWoS 产能与 NVIDIA 配额"),
          question: l("Do TSMC's CoWoS monthly capacity and expansion plans, NVIDIA's allocation share and HBM constraints support the ramp assumption?", "台积电 CoWoS 月产能与扩张计划、NVIDIA 的配额占比以及 HBM 约束，是否支持爬坡假设？"),
          observationScope: l("TSMC CoWoS monthly capacity and expansion plans; NVIDIA's share of CoWoS allocations; HBM capacity and priority allocations, with consistent units and periods.", "台积电 CoWoS 月产能与扩张计划；NVIDIA 占 CoWoS 配额的比例；HBM 产能与优先配额，且计量单位与期间保持一致。"),
          sourceFamilies: [],
          gapReason: l("NVIDIA may discuss its own supply constraints, but NVIDIA-only materials cannot independently establish TSMC capacity or NVIDIA's allocation share. Supplier and allocation sources are not connected.", "NVIDIA 可能会讨论自身的供给约束，但仅依靠 NVIDIA 自身材料，无法独立确立台积电的产能或 NVIDIA 的配额占比。供应商与配额来源尚未接入。"),
        },
      ],
    },
    {
      id: "D3",
      title: l("Software and system competitive advantage", "软件与系统竞争优势"),
      statement: l("Software adoption, system integration and switching costs can preserve NVIDIA's platform advantage.", "软件采用、系统集成与转换成本能够维持 NVIDIA 的平台优势。"),
      coreAssumption: l("Alternative accelerators or customer-built systems do not materially displace NVIDIA across major workloads; ecosystem expansion supports adoption rather than masking weak economics.", "替代性加速器或客户自研系统不会在主要工作负载上实质性取代 NVIDIA；生态扩张支撑的是平台采用，而不是掩盖薄弱的经济性。"),
      whatToWatch: l("NVIDIA's competition, platform adoption and pricing disclosures; independent workload migration, competitor performance and ecosystem returns remain gaps. Customer-built accelerators' performance and cost on comparable workloads, and third-party benchmark results; retain the owner's mid-weak and weak signal labels.", "NVIDIA 对竞争、平台采用与定价的披露；工作负载迁移、竞争对手性能和生态回报的独立证据仍是监控盲区。客户自研加速器在可比工作负载上的性能与成本，以及第三方评测基准结果；保留 Owner 设定的 mid-weak 与 weak 信号标签。"),
      importance: l("Alternative platforms could weaken both demand and the economic value captured by NVIDIA.", "替代平台可能同时削弱需求与 NVIDIA 获取的经济价值。"),
      sourceIds: ["NVDA_FY2026_10K", "NVDA_Q2FY2027_10Q"],
      falsifiers: [
        {
          id: "D3.F1",
          condition: l("Within the next four quarterly disclosures, NVIDIA reports material customer workload migration, lost platform adoption or competitive pricing pressure that weakens its software/system advantage.", "在未来四次季度披露内，NVIDIA 报告了实质性的客户工作负载迁移、平台采用流失或竞争性价格压力，从而削弱其软件/系统优势。"),
          reviewQuarters: 4,
          signal: null,
          watchIds: ["W3.1", "W3.2"],
        },
        {
          id: "D3.F2",
          condition: l("Customer-built accelerators establish a structural performance or cost advantage (mid-weak signal).", "客户自研加速器在性能或成本上形成结构性优势（mid-weak 信号）。"),
          reviewQuarters: null,
          signal: "mid_weak",
          watchIds: ["W3.3"],
        },
        {
          id: "D3.F3",
          condition: l("NVIDIA no longer leads in third-party evaluation benchmarks (weak signal).", "第三方评测基准中，NVIDIA 不再领先（weak 信号）。"),
          reviewQuarters: null,
          signal: "weak",
          watchIds: ["W3.4"],
        },
      ],
      watchItems: [
        {
          id: "W3.1",
          researchNeedId: "N3.1",
          priority: "high",
          triggerKind: "documentary",
          title: l("NVIDIA competitive disclosures", "NVIDIA 竞争相关披露"),
          question: l("Does NVIDIA disclose material adoption loss, workload migration or competitive pricing pressure?", "NVIDIA 是否披露了实质性的平台采用流失、工作负载迁移或竞争性价格压力？"),
          observationScope: l("NVIDIA's own competitive risk, adoption and pricing commentary. Company claims alone do not establish the moat.", "NVIDIA 自身关于竞争风险、平台采用与定价的表述。仅凭公司自述，不能证明护城河成立。"),
          sourceFamilies: ["nvidia_sec", "nvidia_ir", "nvidia_earnings"],
          gapReason: null,
          cannotVerify: l("Company platform claims cannot independently verify market share, real workload TCO or switching costs. No disclosed migration does not prove that customers stayed.", "公司平台表述不能独立验证市场份额、真实工作负载 TCO 或转换成本。未披露迁移，不代表客户没有迁移。"),
        },
        {
          id: "W3.2",
          researchNeedId: "N3.2",
          priority: "high",
          triggerKind: "documentary",
          title: l("Independent substitution evidence", "独立的替代证据"),
          question: l("Do independently observed workload migrations or competitor results undermine NVIDIA's platform advantage?", "独立观察到的工作负载迁移或竞争对手成果，是否削弱了 NVIDIA 的平台优势？"),
          observationScope: l("Independent customer migration, competitor performance and ecosystem returns.", "独立的客户迁移情况、竞争对手性能与生态回报。"),
          sourceFamilies: [],
          gapReason: l("NVIDIA-only materials do not provide independent competitor or customer adoption evidence. Competitor and customer sources are not connected.", "仅依靠 NVIDIA 自身材料，无法获得独立的竞争对手或客户采用证据。竞争对手与客户来源尚未接入。"),
        },
        {
          id: "W3.3",
          researchNeedId: "N3.3",
          priority: "medium",
          triggerKind: "mixed",
          title: l("Customer-built accelerator advantage", "客户自研加速器优势"),
          question: l("Do customer-built accelerators have a structural performance or cost advantage (mid-weak signal)?", "客户自研加速器是否具有结构性的性能或成本优势（mid-weak 信号）？"),
          observationScope: l("Independent customer accelerator comparisons on like-for-like workloads, performance and total cost; the structural advantage and review window require owner confirmation.", "在同类工作负载上，对客户自研加速器的性能与总成本所做的独立比较；“结构性优势”的界定与复核窗口需由 Owner 确认。"),
          sourceFamilies: [],
          gapReason: l("Independent customer-built accelerator performance and cost sources are not connected. NVIDIA's own claims cannot establish or rule out a structural customer advantage.", "客户自研加速器性能与成本的独立来源尚未接入。NVIDIA 自身的说法既不能确立、也不能排除客户的结构性优势。"),
        },
        {
          id: "W3.4",
          researchNeedId: "N3.4",
          priority: "low",
          triggerKind: "mixed",
          title: l("Third-party benchmark leadership", "第三方评测基准的领先地位"),
          question: l("Does NVIDIA cease to lead in third-party evaluation benchmarks (weak signal)?", "NVIDIA 是否在第三方评测基准中不再领先（weak 信号）？"),
          observationScope: l("Independent benchmark leadership by comparable workload, hardware/software version and evaluation method; a weak signal does not automatically invalidate the driver.", "按可比工作负载、软硬件版本和评测方法划分的独立基准领先情况；weak 信号不会自动使该驱动因素失效。"),
          sourceFamilies: [],
          gapReason: l("Third-party evaluation sources are not connected. NVIDIA-only materials do not independently establish benchmark leadership.", "第三方评测来源尚未接入。仅依靠 NVIDIA 自身材料，无法独立确立其基准领先地位。"),
        },
      ],
    },
    {
      id: "D4",
      title: l("Profitability and gross margin durability", "盈利与毛利率持续性"),
      statement: l("Platform value and product economics can sustain attractive profitability through transitions.", "平台价值与产品经济性能够在换代过程中维持有吸引力的盈利能力。"),
      coreAssumption: l("Pricing and product mix can offset input costs and temporary transition pressure without persistent erosion of gross margin.", "定价与产品组合能够抵消投入成本和暂时的换代压力，而不造成毛利率的持续侵蚀。"),
      whatToWatch: l("Comparable GAAP revenue, cost of revenue or gross profit in XBRL, gross margin guidance and explanations of transition effects in earnings materials.", "XBRL 中可比的 GAAP 收入、营业成本或毛利润，毛利率指引，以及财报材料中对换代影响的解释。"),
      importance: l("Revenue growth must retain economic value rather than be consumed by recurring cost or pricing pressure.", "收入增长需要保留经济价值，避免被持续的成本或价格压力消耗。"),
      sourceIds: ["NVDA_Q2FY2027_RELEASE", "NVDA_Q2FY2027_10Q"],
      falsifiers: [
        {
          id: "D4.F1",
          condition: l("Across the next two reported quarters, GAAP gross margin declines in both periods and NVIDIA guides to continued pressure without a stated recovery path, beyond its disclosed temporary transition effects.", "在未来两个已披露的季度中，GAAP 毛利率在两个期间均下降，且 NVIDIA 指引显示压力将持续、未说明恢复路径，并超出其已披露的暂时性换代影响。"),
          reviewQuarters: 2,
          signal: null,
          watchIds: ["W4.1"],
        },
      ],
      watchItems: [
        {
          id: "W4.1",
          researchNeedId: "N4.1",
          priority: "high",
          triggerKind: "mixed",
          title: l("Gross margin and transition economics", "毛利率与换代经济性"),
          question: l("Do comparable GAAP margins and guidance indicate persistent compression beyond temporary transition effects?", "可比的 GAAP 毛利率与指引，是否表明存在超出暂时性换代影响的持续压缩？"),
          observationScope: l("NVIDIA GAAP XBRL facts where available, validated earnings quotations and gross margin guidance; no consensus feed.", "可获得时取自 NVIDIA 的 GAAP XBRL 数据、经过校验的财报引文以及毛利率指引；不含一致预期数据。"),
          sourceFamilies: ["nvidia_sec", "nvidia_earnings"],
          gapReason: null,
          cannotVerify: l("Reported margins do not independently establish pricing power or isolate structural causes. GAAP/non-GAAP and one-off items require comparable treatment; no automated XBRL check is running here.", "已报告毛利率不能独立证明定价权或分离结构性原因。须区分 GAAP/非 GAAP 与单次项目；此页面没有运行自动 XBRL 检查。"),
        },
      ],
    },
    {
      id: "D5",
      title: l("Market access, especially China", "市场准入（尤其是中国）"),
      statement: l("Access to the China AI infrastructure market can remain a meaningful contributor to NVIDIA's growth within regulatory and licensing constraints.", "在监管与许可约束之内，中国 AI 基础设施市场的准入仍能成为 NVIDIA 增长的重要贡献来源。"),
      coreAssumption: l("Permitted products and licenses allow commercially meaningful sales in China; market-access restrictions do not persistently remove this growth opportunity.", "获准销售的产品与许可，使在中国实现具有商业意义的销售成为可能；市场准入限制不会持续地抹去这一增长机会。"),
      whatToWatch: l("NVIDIA's disclosed China exposure, sales, licensing status and permitted-product changes; independent export-control rules, licensing decisions and implementation remain gaps.", "NVIDIA 已披露的中国敞口、销售、许可状态及获准产品的变化；出口管制规则、许可决定及其执行情况的独立证据，仍是监控盲区。"),
      importance: l("Strong demand is insufficient when export rules, licensing or regional restrictions prevent delivery or strand inventory.", "即使需求强劲，出口规则、许可或地区限制也可能阻断交付，或使库存无法变现。"),
      sourceIds: ["NVDA_FY2026_10K", "NVDA_Q2FY2027_RELEASE", "NVDA_Q2FY2027_10Q"],
      falsifiers: [
        {
          id: "D5.F1",
          condition: l("Across the next two quarterly disclosures, NVIDIA reports regulatory or licensing constraints that prevent commercially meaningful China sales, with no disclosed recovery path.", "在未来两次季度披露中，NVIDIA 报告监管或许可约束使其无法实现具有商业意义的中国销售，且未披露恢复路径。"),
          reviewQuarters: 2,
          signal: null,
          watchIds: ["W5.1", "W5.2"],
        },
      ],
      watchItems: [
        {
          id: "W5.1",
          researchNeedId: "N5.1",
          priority: "high",
          triggerKind: "documentary",
          title: l("NVIDIA China market-access disclosures", "NVIDIA 对中国市场准入的披露"),
          question: l("Does NVIDIA disclose persistent licensing or regulatory constraints that prevent commercially meaningful China sales?", "NVIDIA 是否披露了持续存在、使其无法实现具有商业意义的中国销售的许可或监管约束？"),
          observationScope: l("NVIDIA's own reported China exposure, sales and revenue effects, licensing status and permitted-product changes; independent policy verification is outside this watch.", "NVIDIA 自身报告的中国敞口、销售与收入影响、许可状态及获准产品变化；对政策的独立核实不在本关注项范围内。"),
          sourceFamilies: ["nvidia_sec", "nvidia_ir", "nvidia_earnings"],
          gapReason: null,
          cannotVerify: l("NVIDIA-only disclosures cannot independently establish legal interpretation, the scope of individual licenses, future approvals or customer delivery. No disclosed restriction is not proof of unrestricted access.", "NVIDIA 自身披露不能独立确认法律解释、个别许可范围、未来批准或客户收货。未披露限制，不等于可以无条件进入市场。"),
        },
        {
          id: "W5.2",
          researchNeedId: "N5.2",
          priority: "high",
          triggerKind: "documentary",
          title: l("Independent China market-access rules", "独立的中国市场准入规则"),
          question: l("Do independent export-control rules and licensing decisions corroborate the disclosed China-access risks?", "独立的出口管制规则与许可决定，是否印证了已披露的中国市场准入风险？"),
          observationScope: l("Official export-control rules, licensing decisions and implementation affecting China market access, independently of NVIDIA's characterization.", "影响中国市场准入的官方出口管制规则、许可决定及其执行情况，独立于 NVIDIA 的自身表述。"),
          sourceFamilies: [],
          gapReason: l("Official policy and licensing sources are outside this NVIDIA-only slice and are not connected. Company disclosures do not independently verify the operative rules.", "官方政策与许可来源不在这一仅限 NVIDIA 的范围内，尚未接入。公司披露不能独立核实现行规则。"),
        },
      ],
    },
  ],
  provenance: {
    status: "owner_approved",
    contentSha256: "634b812149c40bc129221b0ba451e210319fdc17847e1b80a8c91528777150ee",
    approvedArtifact: {
      id: "NVDA_PRODUCT_V1",
      asOf: "2026-10-07",
      contentSha256: "aea8c5330daf816e9c29bee59b72aab8b117207ba3d126d3b0d07df59d128876",
      approvedAt: "2026-10-07T17:14:50Z",
      approvalCommit: "69bb1fd1eec3831738e622592d1fb4ca4c20ec87",
    },
    // The Owner's receipt for exactly the hash above. approvedAt is the time it was recorded, not a message timestamp.
    approval: { approvedAt: "2026-10-15T02:06:32Z", contentSha256: "634b812149c40bc129221b0ba451e210319fdc17847e1b80a8c91528777150ee" },
  },
};
export function localized(value, language = "en") {
  return typeof value === "string" ? value : value?.[language] ?? value?.en ?? "";
}
// The hosted Standing has one free-text assumption per driver, so the approved driver statement and
// core assumption are joined (never summarised) and what_to_watch is the approved text as written.
export function standingFromBaseline(language = "en") {
  const text = value => localized(value, language), join = language === "zh" ? "" : " ";
  return { ticker: "NVDA", version: 1, statement: text(baseline.statement),
    falsifiers: baseline.drivers.flatMap(d => d.falsifiers.map(f => text(f.condition))),
    drivers: baseline.drivers.map(d => ({ driver_id: d.id, title: text(d.title),
      statement: text(d.statement) + join + text(d.coreAssumption),
      falsifiers: d.falsifiers.map(f => text(f.condition)),
      what_to_watch: text(d.whatToWatch) })) };
}
// Missing links and unavailable families are evidence gaps, never positive coverage. A Watch Item that
// no manual-intake family can observe is a declared monitoring gap only when it carries a gap reason;
// without one it is a broken mapping (incomplete).
export function monitorabilityMap(drivers, families = baseline.families) {
  const manual = id => Object.hasOwn(families, id) && families[id].intake === "manual";
  return drivers.flatMap(d => {
    const falsifiers = d.falsifiers?.length ? d.falsifiers : [{ id: "missing", condition: "", watchIds: [] }];
    return falsifiers.map((f, index) => {
      const refs = f.watchIds || [], watches = d.watchItems || [];
      const linked = refs.map(id => watches.find(w => w.id === id)).filter(Boolean);
      const missingLinks = refs.filter(id => !watches.some(w => w.id === id));
      const sourceIds = [...new Set(linked.flatMap(w => w.sourceFamilies || []))];
      const knownSources = sourceIds.filter(manual);
      const unavailableSources = sourceIds.filter(id => !manual(id));
      const monitoredWatches = linked.filter(w => (w.sourceFamilies || []).some(manual));
      const gapWatches = linked.filter(w => !monitoredWatches.includes(w));
      const undeclared = gapWatches.filter(w => (w.sourceFamilies || []).length || !w.gapReason);
      const incomplete = !f.condition || !refs.length || missingLinks.length > 0 ||
        unavailableSources.length > 0 || undeclared.length > 0;
      return { driverId: d.id || d.driver_id, falsifierId: f.id || `F${index + 1}`,
        condition: f.condition || (typeof f === "string" ? f : ""), signal: f.signal || null,
        // windowDeclared separates "approved with no stated window" from rows that never had one (custom theses).
        reviewQuarters: f.reviewQuarters ?? null, windowDeclared: f.reviewQuarters !== undefined,
        watchItems: linked, monitoredWatches, gapWatches,
        sourceIds: knownSources, missingLinks, unavailableSources,
        gaps: gapWatches.map(w => w.gapReason).filter(Boolean),
        coverage: !knownSources.length ? "gap" : incomplete || gapWatches.length ? "partial" : "reported_only",
        // Current hosted release has manual intake only. Source provenance is not auto-monitoring.
        automaticallyMonitored: false, incomplete };
    });
  });
}
export function mapForStanding(standing) {
  const seeds = ["en", "zh"].map(standingFromBaseline);
  return monitorabilityMap(standing.drivers.map(driver => {
    if (standing.ticker !== "NVDA") return driver;
    for (const seed of seeds) {
      const candidate = seed.drivers.find(d => d.driver_id === driver.driver_id);
      if (candidate && ["driver_id", "title", "statement", "what_to_watch"].every(key => driver[key] === candidate[key]) &&
          JSON.stringify(driver.falsifiers) === JSON.stringify(candidate.falsifiers))
        return baseline.drivers.find(d => d.id === driver.driver_id);
    }
    return driver;
  }));
}
// Structural integrity of the shipped baseline (or a candidate, so failure paths are testable). Content integrity (the recorded hash and the
// Owner-approved text) is enforced by the build and by hosted/tests, which can hash synchronously.
export function validateBaseline(candidate = baseline) {
  const fail = message => { throw new Error(`Invalid baseline: ${message}`); };
  const unique = (values, label) => { if (new Set(values).size !== values.length) fail(`duplicate ${label}`); };
  const ids = candidate.drivers.map(d => d.id), sourceIds = candidate.sources.map(s => s.id);
  if (ids.length < 3 || ids.length > 5) fail("driver count");
  unique(ids, "driver id");
  const falsifierIds = [], watchIds = [], needIds = [];
  for (const d of candidate.drivers) {
    const n = d.id.slice(1);
    if (!d.falsifiers?.length || !d.watchItems?.length || !d.sourceIds.length ||
        d.sourceIds.some(id => !sourceIds.includes(id))) fail(`incomplete ${d.id}`);
    for (const f of d.falsifiers) {
      if (!new RegExp(`^D${n}\\.F[1-9]\\d*$`).test(f.id)) fail(`falsifier id ${f.id}`);
      if (![null, "mid_weak", "weak"].includes(f.signal)) fail(`signal on ${f.id}`);
      if (f.reviewQuarters !== null && !Number.isInteger(f.reviewQuarters)) fail(`review window on ${f.id}`);
      falsifierIds.push(f.id);
    }
    for (const w of d.watchItems) {
      if (!new RegExp(`^W${n}\\.[1-9]\\d*$`).test(w.id)) fail(`watch id ${w.id}`);
      // Exactly one of: a manual source family, or an explicit declared gap.
      if (Boolean(w.sourceFamilies.length) === Boolean(w.gapReason)) fail(`${w.id} needs sources or a gap reason`);
      if (!d.falsifiers.some(f => f.watchIds.includes(w.id))) fail(`${w.id} is not bound to a falsifier`);
      watchIds.push(w.id);
      needIds.push(w.researchNeedId);
    }
  }
  unique(falsifierIds, "falsifier id");
  unique(watchIds, "watch id");
  unique(needIds, "research need id");
  if (monitorabilityMap(candidate.drivers, candidate.families).some(r => r.incomplete)) fail("falsifier/watch/source mapping");
  const bilingual = value => {
    if (!value || typeof value !== "object") return;
    if ("en" in value || "zh" in value) {
      if (!value.en?.trim() || !value.zh?.trim()) fail("every localized field needs English and Chinese");
    } else Object.values(value).forEach(bilingual);
  };
  bilingual(candidate);
  for (const s of candidate.sources) {
    const url = new URL(s.url);
    if (url.protocol !== "https:" || !["www.sec.gov", "investor.nvidia.com"].includes(url.hostname) ||
        !Object.hasOwn(candidate.families, s.family) || s.publishedAt > candidate.evidenceThrough) fail(`source ${s.id}`);
  }
  // A notice states what the baseline is not. A context note is a dated, cited fact tied to existing identities; it
  // may not invent a driver, condition, Watch Item or source, and each part keeps exactly one role.
  if (!candidate.notices?.length || candidate.notices.some(n => !n.id || !n.text)) fail("notices");
  unique(candidate.notices.map(n => n.id), "notice id");
  const noteIds = [], roles = ["reported_disclosure", "forward_looking_assumption", "relevance_for_review", "falsifier_status"];
  for (const note of candidate.contextNotes ?? []) {
    const driver = candidate.drivers.find(d => d.id === note.driverId);
    noteIds.push(note.id);
    if (!note.id || !driver || !candidate.sources.some(s => s.id === note.sourceId)) fail(`context note ${note.id}`);
    if (note.falsifierIds.some(id => !driver.falsifiers.some(f => f.id === id)) ||
        note.watchIds.some(id => !driver.watchItems.some(w => w.id === id))) fail(`context note ${note.id} references`);
    const url = new URL(note.citation?.url ?? "");
    if (url.protocol !== "https:" || !["www.sec.gov", "investor.nvidia.com"].includes(url.hostname) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(note.publishedAt) || note.publishedAt > candidate.evidenceThrough) fail(`context note ${note.id} citation`);
    unique(note.parts.map(p => p.kind), `part role in ${note.id}`);
    if (!note.parts.length || note.parts.some(p => !roles.includes(p.kind) || (p.quote !== undefined && !String(p.quote).trim()))) fail(`context note ${note.id} parts`);
  }
  unique(noteIds, "context note id");
  const { status, contentSha256, approval } = candidate.provenance;
  if (!["pending_owner_approval", "owner_approved"].includes(status) || !/^[a-f0-9]{64}$/.test(contentSha256)) fail("provenance");
  // Approval is never inferred: an approved status must carry a receipt bound to this exact hash.
  if ((status === "owner_approved") !== Boolean(approval) || (approval && approval.contentSha256 !== contentSha256)) fail("approval receipt");
  return true;
}
