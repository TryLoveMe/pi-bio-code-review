import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const STATE_ENTRY = "bio-code-review-state";
const STATUS_KEY = "bio-code-review";
const WIDGET_KEY = "bio-code-review-guide";
const DEFAULT_ROOT = "bio-analysis-delivery";

type Phase = "off" | "planning" | "coding" | "locked";
type Necessity = "必要" | "条件触发" | "可选";

interface PlanStep {
  id: string;
  title: string;
  necessity: Necessity;
  purpose: string;
  reason: string;
  consequenceIfSkipped: string;
  codeFiles: string[];
  outputs: string[];
}

interface AnalysisPlan {
  researchQuestion: string;
  knownFacts: string[];
  unresolvedQuestions: string[];
  steps: PlanStep[];
  stopCondition: string;
  submittedAt: string;
}

interface WorkflowState {
  enabled: boolean;
  phase: Phase;
  deliveryRoot: string;
  plan?: AnalysisPlan;
  approvedAt?: string;
  checkedAt?: string;
}

const StepSchema = Type.Object({
  id: Type.String({ description: "两位数字步骤编号，例如 01" }),
  title: Type.String({ description: "简短、具体的步骤名称" }),
  necessity: StringEnum(["必要", "条件触发", "可选"] as const),
  purpose: Type.String({ description: "这一步具体做什么，用白话描述" }),
  reason: Type.String({ description: "为什么需要这一步" }),
  consequenceIfSkipped: Type.String({ description: "不做会影响哪个判断；可选步骤写不影响主要结论" }),
  codeFiles: Type.Array(Type.String(), {
    minItems: 1,
    description: "本步骤对应的实际脚本，相对于交付目录；每一步优先使用独立脚本",
  }),
  outputs: Type.Array(Type.String(), { description: "运行后应产生的表、图或检查记录" }),
});

const PlanSchema = Type.Object({
  researchQuestion: Type.String({ description: "本次分析要回答的研究问题" }),
  knownFacts: Type.Array(Type.String(), { description: "用户已确认的数据和实验事实" }),
  unresolvedQuestions: Type.Array(Type.String(), { description: "仍会影响方法选择、需要用户回答的问题" }),
  steps: Type.Array(StepSchema, { minItems: 1, description: "最短可行分析步骤" }),
  stopCondition: Type.String({ description: "做到什么程度就停止，不自动扩展分析" }),
});

function initialState(): WorkflowState {
  return { enabled: false, phase: "off", deliveryRoot: DEFAULT_ROOT };
}

function normalizeRelativePath(input: string): string | undefined {
  const value = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || isAbsolute(value)) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "")) return undefined;
  return value;
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function phaseLabel(phase: Phase): string {
  if (phase === "planning") return "方案待审";
  if (phase === "coding") return "只写代码";
  if (phase === "locked") return "代码已锁定";
  return "未启用";
}

function languageFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return ({
    ".r": "r",
    ".py": "python",
    ".sh": "bash",
    ".ts": "typescript",
    ".js": "javascript",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
  } as Record<string, string>)[ext] ?? "text";
}

function numberedCode(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
}

function executionToolReason(toolName: string): string | undefined {
  const name = toolName.toLowerCase();
  const exact = new Set([
    "bash",
    "powershell",
    "eval",
    "ctx_execute",
    "ctx_execute_file",
    "ctx_batch_execute",
    "spawn_subagent",
    "send_message_to_subagent",
    "mcp",
    "mcpscript",
  ]);
  if (exact.has(name)) return `工具 ${toolName} 可能执行程序或把任务交给其他代理`;
  if (/(^|_)(shell|terminal|exec|execute|python|rscript|notebook|subagent)(_|$)/i.test(name)) {
    return `工具 ${toolName} 名称表明它可能执行程序`;
  }
  return undefined;
}

function updateUi(ctx: ExtensionContext, state: WorkflowState): void {
  if (!state.enabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const color = state.phase === "planning" ? "warning" : state.phase === "locked" ? "success" : "accent";
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `生信代码审查：${phaseLabel(state.phase)}`));

  const line = state.phase === "planning"
    ? "先审方案；此时不能写文件或运行分析。提交方案后使用 /bio-approve。"
    : state.phase === "coding"
      ? `只允许在 ${state.deliveryRoot}/ 写代码；AI 不能运行分析。完成后使用 /bio-check。`
      : `代码已锁定；对照文档位于 ${state.deliveryRoot}/代码步骤对照.md。`;
  ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg("dim", line)], { placement: "belowEditor" });
}

function persist(pi: ExtensionAPI, state: WorkflowState): void {
  pi.appendEntry<WorkflowState>(STATE_ENTRY, structuredClone(state));
}

function planSummary(plan: AnalysisPlan): string {
  const steps = plan.steps.map((step) =>
    `${step.id}. [${step.necessity}] ${step.title}\n` +
    `   做什么：${step.purpose}\n` +
    `   为什么：${step.reason}\n` +
    `   不做的影响：${step.consequenceIfSkipped}\n` +
    `   代码：${step.codeFiles.join("、")}\n` +
    `   输出：${step.outputs.join("、") || "无"}`
  ).join("\n\n");

  return `研究问题：${plan.researchQuestion}\n\n${steps}\n\n停止条件：${plan.stopCondition}`;
}

export default function bioCodeReviewExtension(pi: ExtensionAPI): void {
  let state = initialState();

  pi.registerFlag("bio-code-only", {
    description: "启动生信分析的先审方案、只写代码模式",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: "bio_submit_plan",
    label: "提交生信分析方案",
    description: "提交最短可行的生信分析方案，等待用户审核；此工具只记录方案，不写代码、不运行分析",
    promptSnippet: "提交逐步生信分析方案供用户审核",
    promptGuidelines: [
      "在生信代码审查模式的方案阶段，使用 bio_submit_plan 提交最短可行方案，不要直接写代码。",
    ],
    parameters: PlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.enabled || state.phase !== "planning") {
        throw new Error("当前不在生信方案阶段。先使用 /bio-start。 ");
      }

      const seenIds = new Set<string>();
      const seenFiles = new Set<string>();
      const steps: PlanStep[] = [];

      for (const rawStep of params.steps) {
        const id = rawStep.id.trim();
        if (!/^\d{2}$/.test(id)) throw new Error(`步骤编号必须是两位数字：${rawStep.id}`);
        if (seenIds.has(id)) throw new Error(`步骤编号重复：${id}`);
        seenIds.add(id);

        const codeFiles = rawStep.codeFiles.map((file) => {
          const normalized = normalizeRelativePath(file);
          if (!normalized) throw new Error(`代码路径不安全或不是相对路径：${file}`);
          return normalized;
        });
        for (const file of codeFiles) seenFiles.add(file);

        steps.push({
          id,
          title: rawStep.title.trim(),
          necessity: rawStep.necessity,
          purpose: rawStep.purpose.trim(),
          reason: rawStep.reason.trim(),
          consequenceIfSkipped: rawStep.consequenceIfSkipped.trim(),
          codeFiles,
          outputs: rawStep.outputs.map((item) => item.trim()).filter(Boolean),
        });
      }

      if (seenFiles.size === 0) throw new Error("方案没有声明任何对应代码文件。");

      state.plan = {
        researchQuestion: params.researchQuestion.trim(),
        knownFacts: params.knownFacts.map((item) => item.trim()).filter(Boolean),
        unresolvedQuestions: params.unresolvedQuestions.map((item) => item.trim()).filter(Boolean),
        steps,
        stopCondition: params.stopCondition.trim(),
        submittedAt: new Date().toISOString(),
      };
      state.approvedAt = undefined;
      state.checkedAt = undefined;
      persist(pi, state);
      updateUi(ctx, state);

      return {
        content: [{
          type: "text",
          text: `${planSummary(state.plan)}\n\n方案已记录，但尚未批准。必须等待用户运行 /bio-approve。`,
        }],
        details: { plan: state.plan },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("提交生信分析方案")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? theme.fg("text", text.text) : "", 0, 0);
    },
  });

  pi.registerCommand("bio-start", {
    description: "开始生信分析的先审方案、只写代码流程：/bio-start [交付目录]",
    handler: async (args, ctx) => {
      const requestedRoot = args.trim() || DEFAULT_ROOT;
      const normalizedRoot = normalizeRelativePath(requestedRoot);
      if (!normalizedRoot) {
        ctx.ui.notify("交付目录必须是当前工作区内的安全相对路径。", "error");
        return;
      }

      state = {
        enabled: true,
        phase: "planning",
        deliveryRoot: normalizedRoot,
      };
      persist(pi, state);
      updateUi(ctx, state);
      ctx.ui.notify("已进入方案阶段：先说明最短可行方案，禁止写代码和运行分析。", "info");
      pi.sendUserMessage(
        "请开始生信代码审查流程。先根据我当前提供的信息判断还缺哪些会影响方法选择的内容；需要确认时集中提问，信息足够后提交最短可行方案。不要写代码，不要运行分析。",
      );
    },
  });

  pi.registerCommand("bio-approve", {
    description: "批准当前方案，允许 AI 在交付目录内写代码，但仍禁止运行分析",
    handler: async (args, ctx) => {
      if (!state.enabled || state.phase !== "planning" || !state.plan) {
        ctx.ui.notify("当前没有可批准的方案。", "warning");
        return;
      }
      if (state.plan.unresolvedQuestions.length > 0) {
        ctx.ui.notify(
          `方案仍列有 ${state.plan.unresolvedQuestions.length} 个待确认问题。请先让 AI 更新方案并重新提交。`,
          "warning",
        );
        return;
      }

      let approved = args.trim().toLowerCase() === "yes";
      if (ctx.hasUI) {
        approved = await ctx.ui.confirm(
          "批准生信分析方案？",
          `${planSummary(state.plan)}\n\n批准后，AI 只能在 ${state.deliveryRoot}/ 内写代码，仍不能运行分析。`,
        );
      }
      if (!approved) {
        ctx.ui.notify("未批准方案。", "info");
        return;
      }

      state.phase = "coding";
      state.approvedAt = new Date().toISOString();
      persist(pi, state);
      updateUi(ctx, state);
      ctx.ui.notify("方案已批准：现在只允许写代码，不允许运行分析。", "info");
      pi.sendUserMessage(
        `我已批准当前方案。请严格按照已批准的步骤，在 ${state.deliveryRoot}/ 内生成代码和 README；不要运行任何分析。完成后提醒我使用 /bio-check。`,
      );
    },
  });

  pi.registerCommand("bio-status", {
    description: "显示生信代码审查流程的当前状态",
    handler: async (_args, ctx) => {
      const lines = [
        `状态：${phaseLabel(state.phase)}`,
        `交付目录：${state.deliveryRoot}/`,
        `方案：${state.plan ? `${state.plan.steps.length} 步` : "尚未提交"}`,
        state.approvedAt ? `批准时间：${state.approvedAt}` : "批准时间：无",
        state.checkedAt ? `检查时间：${state.checkedAt}` : "检查时间：无",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("bio-check", {
    description: "不运行分析；检查方案中的脚本并生成逐步实际代码对照文档",
    handler: async (_args, ctx) => {
      if (!state.enabled || state.phase !== "coding" || !state.plan) {
        ctx.ui.notify("只有方案批准且代码生成后才能检查。", "warning");
        return;
      }

      const root = resolve(ctx.cwd, state.deliveryRoot);
      const missing: string[] = [];
      const empty: string[] = [];
      const sections: string[] = [];

      for (const step of state.plan.steps) {
        const fileSections: string[] = [];
        for (const file of step.codeFiles) {
          const absolute = resolve(root, file);
          if (!isInside(root, absolute)) {
            missing.push(`${file}（路径越界）`);
            continue;
          }
          try {
            const source = await readFile(absolute, "utf8");
            if (!source.trim()) empty.push(file);
            fileSections.push(
              `### 实际代码：\`${file}\`\n\n` +
              `以下内容直接读取自交付脚本。左侧是源文件行号。\n\n` +
              `\`\`\`${languageFor(file)}\n${numberedCode(source)}\n\`\`\``,
            );
          } catch {
            missing.push(file);
          }
        }

        sections.push(
          `## ${step.id} ${step.title}\n\n` +
          `- **必要程度：** ${step.necessity}\n` +
          `- **做什么：** ${step.purpose}\n` +
          `- **为什么：** ${step.reason}\n` +
          `- **不做的影响：** ${step.consequenceIfSkipped}\n` +
          `- **预期输出：** ${step.outputs.join("、") || "无"}\n\n` +
          fileSections.join("\n\n"),
        );
      }

      if (missing.length > 0 || empty.length > 0) {
        const problems = [
          missing.length ? `缺少文件：${missing.join("、")}` : "",
          empty.length ? `空文件：${empty.join("、")}` : "",
        ].filter(Boolean).join("\n");
        ctx.ui.notify(`代码检查未通过。\n${problems}`, "error");
        return;
      }

      const document =
        `# 生信分析步骤与实际代码对照\n\n` +
        `> 本文档只核对方案与脚本的对应关系，没有运行任何分析。代码能被读取不代表统计设计一定正确。\n\n` +
        `## 研究问题\n\n${state.plan.researchQuestion}\n\n` +
        `## 分析停止条件\n\n${state.plan.stopCondition}\n\n` +
        sections.join("\n\n") + "\n";

      await mkdir(root, { recursive: true });
      await writeFile(resolve(root, "代码步骤对照.md"), document, "utf8");
      state.phase = "locked";
      state.checkedAt = new Date().toISOString();
      persist(pi, state);
      updateUi(ctx, state);
      ctx.ui.notify(`检查通过并已锁定：${state.deliveryRoot}/代码步骤对照.md`, "info");
    },
  });

  pi.registerCommand("bio-reset", {
    description: "关闭并清空当前生信代码审查流程状态，不删除任何文件",
    handler: async (_args, ctx) => {
      let confirmed = true;
      if (ctx.hasUI && state.enabled) {
        confirmed = await ctx.ui.confirm("重置生信代码审查流程？", "只清空流程状态，不删除已生成文件。");
      }
      if (!confirmed) return;
      state = initialState();
      persist(pi, state);
      updateUi(ctx, state);
      ctx.ui.notify("流程状态已重置，文件未删除。", "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return;

    const executionReason = executionToolReason(event.toolName);
    if (executionReason) {
      return {
        block: true,
        reason: `生信代码审查模式禁止 AI 执行分析：${executionReason}。请只提供代码，由用户自行运行。`,
      };
    }

    const isMutation = event.toolName === "write" || event.toolName === "edit";
    if (!isMutation) return;

    if (state.phase !== "coding") {
      return {
        block: true,
        reason: state.phase === "planning"
          ? "方案尚未获用户批准，不能写文件。先提交方案并等待用户运行 /bio-approve。"
          : "代码已经通过 /bio-check 锁定。如需修改，请使用 /bio-start 重新提交方案。",
      };
    }

    const inputPath = (event.input as { path?: unknown }).path;
    if (typeof inputPath !== "string") {
      return { block: true, reason: "写文件工具没有提供可核对的 path。" };
    }

    const root = resolve(ctx.cwd, state.deliveryRoot);
    const target = resolve(ctx.cwd, inputPath);
    if (!isInside(root, target)) {
      return {
        block: true,
        reason: `只能写入独立交付目录 ${state.deliveryRoot}/；原始数据和工作区其他文件保持只读。`,
      };
    }
  });

  pi.on("before_agent_start", async () => {
    if (!state.enabled) return;

    if (state.phase === "planning") {
      return {
        message: {
          customType: "bio-code-review-instructions",
          display: false,
          content: `[生信代码审查模式：方案阶段]

当前禁止写文件、禁止运行任何分析。

你的任务：
1. 先确认研究问题、数据类型、分组、独立重复、配对和批次。缺少会影响方法选择的信息时，集中提问，不要猜。
2. 提交“最短可行方案”。步骤只分为“必要、条件触发、可选”；条件未满足时不执行条件触发步骤，可选步骤默认不做。
3. 每一步都必须写清：做什么、为什么、不做会影响哪个判断、对应哪些实际代码文件、会产生什么输出。
4. 不加入无法说明必要性的聚类、富集、网络、机器学习或重复质控。达到停止条件就结束。
5. 使用 bio_submit_plan 提交方案。提交后停止，等待用户运行 /bio-approve。`,
        },
      };
    }

    if (state.phase === "coding" && state.plan) {
      return {
        message: {
          customType: "bio-code-review-instructions",
          display: false,
          content: `[生信代码审查模式：只写代码阶段]

用户已经批准以下方案：
${planSummary(state.plan)}

强制要求：
1. 只能在 ${state.deliveryRoot}/ 内创建或修改文件；原始数据只读。
2. 只写代码，不运行 Bash、R、Python、Eval、Notebook，不安装软件，不下载数据，不委派子代理执行。
3. 严格按已批准方案写代码。不得增加筛选、变换、样本删除、统计方法或额外分析。
4. 每个步骤使用方案声明的代码文件。代码内用中文说明“为什么这样做、会改变哪些数据”，不要只翻译函数名。
5. 加入必要的停止检查：样本与分组对应、独立重复、输入数据类型、过滤前后数量、比较方向及输出表一致性。检查失败就停止，不能猜测或跳过。
6. 提供 README.md，写清运行顺序、每一步输入输出、需要用户检查什么。没有真实运行输出，不得声称得到结果。
7. 完成代码后，提醒用户亲自运行 /bio-check。不要自行调用任何执行工具。`,
        },
      };
    }

    return {
      message: {
        customType: "bio-code-review-instructions",
        display: false,
        content: `[生信代码审查模式：代码已锁定]
代码已经生成逐步对照文档。不要修改文件，也不要运行分析。若用户需要改方法，应重新使用 /bio-start 提交并批准新方案。`,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    state = initialState();
    const entries = ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
        state = entry.data as WorkflowState;
      }
    }

    if (pi.getFlag("bio-code-only") === true && !state.enabled) {
      state = { enabled: true, phase: "planning", deliveryRoot: DEFAULT_ROOT };
      persist(pi, state);
    }
    updateUi(ctx, state);
  });
}
