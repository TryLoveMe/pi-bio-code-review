/**
 * 生信代码审查 extension 的流程测试。
 *
 * 用假的 Pi API 装载扩展，然后按真实使用顺序走一遍：
 * 方案阶段 → 批准 → 只写代码 → 检查锁定 → 会话恢复。
 * 断言用的是各阶段真实产生的状态、拦截结果和落盘文件。
 *
 * 运行：bun tests/flow.test.mjs
 */

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTENSION_URL = new URL("../extension/index.ts", import.meta.url).href;
const INSTANCE_MARKER = Symbol.for("pi-bio-code-review.active-instance");

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  ->  ${detail}` : ""}`);
  }
}

function makePi(entries = []) {
  const commands = new Map();
  const tools = new Map();
  const flags = new Map();
  const handlers = new Map();
  const sentUserMessages = [];
  const notifications = [];

  return {
    commands,
    tools,
    flags,
    handlers,
    sentUserMessages,
    entries,
    notifications,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerFlag(name, definition) {
      flags.set(name, definition);
    },
    sendUserMessage(text) {
      sentUserMessages.push(text);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    getFlag(name) {
      return flags.get(name)?.default;
    },
    events: { on() {}, emit() {} },
  };
}

function makeCtx({ cwd, pi, hasUI = false, confirmAnswer = true }) {
  const calls = { notify: [], status: [], widget: [], confirm: [] };
  return {
    calls,
    cwd,
    hasUI,
    mode: hasUI ? "tui" : "print",
    signal: undefined,
    ui: {
      notify(message, level) {
        calls.notify.push({ message, level });
      },
      setStatus(key, value) {
        calls.status.push(value);
      },
      setWidget(key, value) {
        calls.widget.push(value);
      },
      theme: { fg: (_color, text) => text, bold: (text) => text, dim: (text) => text },
      async confirm(title, body) {
        calls.confirm.push({ title, body });
        return confirmAnswer;
      },
    },
    sessionManager: {
      getBranch: () => pi.entries,
      getEntries: () => pi.entries,
      getSessionFile: () => null,
    },
  };
}

async function emit(pi, event, payload, ctx) {
  const results = [];
  for (const handler of pi.handlers.get(event) ?? []) {
    results.push(await handler(payload, ctx));
  }
  return results;
}

async function currentStatus(pi, ctx) {
  await emit(pi, "session_start", { reason: "startup" }, ctx);
  const statuses = ctx.calls.status.filter(Boolean);
  return statuses.at(-1) ?? "";
}

const SCRIPT_A = "scripts/01_检查样本与分组.R";
const SCRIPT_B = "scripts/02_两组差异分析.R";

function planParams({ unresolved = [] } = {}) {
  return {
    researchQuestion: "处理组与对照组之间有哪些基因表达差异",
    knownFacts: ["两组比较", "每组至少 3 个独立样本"],
    unresolvedQuestions: unresolved,
    steps: [
      {
        id: "01",
        title: "核对样本与分组",
        necessity: "必要",
        purpose: "确认表达矩阵的样本名与分组表完全对应",
        reason: "样本错配会让后续所有比较失去意义",
        consequenceIfSkipped: "可能把样本标签搞错，差异结果整体错误",
        codeFiles: [SCRIPT_A],
        outputs: ["01_样本对应检查.csv"],
      },
      {
        id: "02",
        title: "两组差异分析",
        necessity: "必要",
        purpose: "按分组做差异表达分析并输出结果表",
        reason: "这是本次研究问题的主要回答",
        consequenceIfSkipped: "无法回答研究问题",
        codeFiles: [SCRIPT_B],
        outputs: ["02_差异结果.csv"],
      },
    ],
    stopCondition: "得到差异结果表并确认样本对应无误即停止",
  };
}

async function startFlow(pi, ctx) {
  await pi.commands.get("bio-start").handler("", ctx);
}

const main = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bio-ext-test-"));
  const module = await import(EXTENSION_URL);

  // ---------- A. 加载与注册 ----------
  delete globalThis[INSTANCE_MARKER];
  const pi = makePi();
  const ctx = makeCtx({ cwd, pi, hasUI: true });
  module.default(pi);

  check(
    "注册了 5 个命令",
    ["bio-start", "bio-approve", "bio-status", "bio-check", "bio-reset"].every((name) => pi.commands.has(name)),
    [...pi.commands.keys()].join(","),
  );
  check("注册了 bio_submit_plan 工具", pi.tools.has("bio_submit_plan"));

  const duplicatePi = makePi();
  module.default(duplicatePi);
  check(
    "第二份实例自动停用，不再重复注册（防死锁）",
    duplicatePi.commands.size === 0 && duplicatePi.tools.size === 0 && duplicatePi.handlers.size === 0,
    `commands=${duplicatePi.commands.size} tools=${duplicatePi.tools.size} handlers=${duplicatePi.handlers.size}`,
  );

  // 停用后的实例也不应拦截任何工具调用
  const duplicateBlocks = (await emit(duplicatePi, "tool_call", { toolName: "bash", input: { command: "ls" } }, ctx)).filter(Boolean);
  check("第二份实例不拦截工具调用", duplicateBlocks.length === 0);

  check("未启用时状态为空", (await currentStatus(pi, ctx)) === "");

  // ---------- B. 方案阶段 ----------
  await startFlow(pi, ctx);
  check("bio-start 会主动触发下一轮对话", pi.sentUserMessages.length === 1, `sent=${pi.sentUserMessages.length}`);
  check("bio-start 后状态为方案待审", (await currentStatus(pi, ctx)).includes("方案待审"));

  const planningWrite = (await emit(pi, "tool_call", { toolName: "write", input: { path: join(cwd, "bio-analysis-delivery/x.R") } }, ctx)).filter(Boolean);
  check("方案阶段写文件被拦截", planningWrite.length === 1 && planningWrite[0].block === true, JSON.stringify(planningWrite));

  const planningBash = (await emit(pi, "tool_call", { toolName: "bash", input: { command: "Rscript x.R" } }, ctx)).filter(Boolean);
  check("方案阶段执行分析被拦截", planningBash.length === 1 && planningBash[0].block === true);

  const planningSubagent = (await emit(pi, "tool_call", { toolName: "spawn_subagent", input: {} }, ctx)).filter(Boolean);
  check("方案阶段委派子代理被拦截", planningSubagent.length === 1 && planningSubagent[0].block === true);

  const planningMcp = (await emit(pi, "tool_call", { toolName: "mcp", input: {} }, ctx)).filter(Boolean);
  check("方案阶段 MCP 调用被拦截", planningMcp.length === 1 && planningMcp[0].block === true);

  let invalidRejected = false;
  try {
    await pi.tools.get("bio_submit_plan").execute("t0", { ...planParams(), steps: [{ ...planParams().steps[0], id: "1" }] }, undefined, undefined, ctx);
  } catch {
    invalidRejected = true;
  }
  check("步骤编号非法时方案被拒绝", invalidRejected);

  const badPathRejected = await pi.tools
    .get("bio_submit_plan")
    .execute("t0b", { ...planParams(), steps: [{ ...planParams().steps[0], codeFiles: ["../逃出目录.R"] }] }, undefined, undefined, ctx)
    .then(() => false)
    .catch(() => true);
  check("越界代码路径被拒绝", badPathRejected);

  const submitResult = await pi.tools
    .get("bio_submit_plan")
    .execute("t1", planParams({ unresolved: ["表达量是原始计数还是已标准化，尚未确认"] }), undefined, undefined, ctx);
  check("方案提交成功且记录 2 步", submitResult.details?.plan?.steps?.length === 2);
  check("方案提交后提示等待用户批准", submitResult.content[0].text.includes("尚未批准"));
  check("方案提交后仍处于方案待审", (await currentStatus(pi, ctx)).includes("方案待审"));

  // 尚未批准时，写文件仍然被拦截
  const afterSubmitWrite = (await emit(pi, "tool_call", { toolName: "write", input: { path: join(cwd, "bio-analysis-delivery/x.R") } }, ctx)).filter(Boolean);
  check("提交方案但未批准时写文件仍被拦截", afterSubmitWrite.length === 1 && afterSubmitWrite[0].block === true);

  // ---------- C. 批准 ----------
  const declineCtx = makeCtx({ cwd, pi, hasUI: true, confirmAnswer: false });
  const declineResult = await emit(pi, "input", { source: "interactive", text: "同意" }, declineCtx);
  check(
    "有待确认项时会先警告并询问",
    declineCtx.calls.confirm.some((c) => c.title.includes("仍然批准")),
    JSON.stringify(declineCtx.calls.confirm),
  );
  check("用户拒绝后仍留在方案阶段", (await currentStatus(pi, ctx)).includes("方案待审") && declineResult[0]?.action === "handled");

  const approveCtx = makeCtx({ cwd, pi, hasUI: true, confirmAnswer: true });
  const approveResult = await emit(pi, "input", { source: "interactive", text: "同意" }, approveCtx);
  check("自然语言“同意”完成批准", approveResult[0]?.action === "handled" && (await currentStatus(pi, ctx)).includes("只写代码"));
  check("批准后自动触发代码生成对话", pi.sentUserMessages.length === 2, `sent=${pi.sentUserMessages.length}`);

  // ---------- D. 只写代码阶段 ----------
  const insideWrite = (await emit(pi, "tool_call", { toolName: "write", input: { path: join(cwd, "bio-analysis-delivery/scripts/01.R") } }, ctx)).filter(Boolean);
  check("交付目录内写文件放行", insideWrite.length === 0, JSON.stringify(insideWrite));

  const outsideWrite = (await emit(pi, "tool_call", { toolName: "write", input: { path: join(cwd, "原始数据.dirty.csv") } }, ctx)).filter(Boolean);
  check("交付目录外写文件被拦截", outsideWrite.length === 1 && outsideWrite[0].block === true);

  const absoluteEscape = (await emit(pi, "tool_call", { toolName: "write", input: { path: "/tmp/逃出目录.R" } }, ctx)).filter(Boolean);
  check("绝对路径越界写入被拦截", absoluteEscape.length === 1 && absoluteEscape[0].block === true);

  const codingBash = (await emit(pi, "tool_call", { toolName: "bash", input: { command: "Rscript 01.R" } }, ctx)).filter(Boolean);
  check("只写代码阶段仍禁止执行分析", codingBash.length === 1 && codingBash[0].block === true);

  const evalBlock = (await emit(pi, "tool_call", { toolName: "ctx_execute", input: {} }, ctx)).filter(Boolean);
  check("只写代码阶段禁止 ctx_execute", evalBlock.length === 1 && evalBlock[0].block === true);

  // ---------- E. 检查与锁定 ----------
  const missingCheckCtx = makeCtx({ cwd, pi, hasUI: true });
  await pi.commands.get("bio-check").handler("", missingCheckCtx);
  check(
    "脚本缺失时 bio-check 不锁定",
    (await currentStatus(pi, ctx)).includes("只写代码") &&
      missingCheckCtx.calls.notify.some((n) => n.level === "error"),
    JSON.stringify(missingCheckCtx.calls.notify),
  );

  const deliveryRoot = join(cwd, "bio-analysis-delivery");
  await mkdir(join(deliveryRoot, "scripts"), { recursive: true });
  await writeFile(join(deliveryRoot, SCRIPT_A), "# 检查样本名与分组表是否一致\nstopifnot(all(names(counts) == groups$sample))\n", "utf8");
  await writeFile(join(deliveryRoot, SCRIPT_B), "# 两组差异分析\nres <- run_diff(counts, groups)\n", "utf8");

  const passCheckCtx = makeCtx({ cwd, pi, hasUI: true });
  await pi.commands.get("bio-check").handler("", passCheckCtx);
  check("脚本齐全时 bio-check 通过并锁定", (await currentStatus(pi, ctx)).includes("代码已锁定"));

  const docPath = join(deliveryRoot, "代码步骤对照.md");
  const doc = existsSync(docPath) ? await readFile(docPath, "utf8") : "";
  check("生成代码步骤对照.md", doc.length > 0);
  check("对照文档含步骤说明", doc.includes("核对样本与分组") && doc.includes("不做的影响"));
  check("对照文档含实际代码与行号", doc.includes("stopifnot(all(names(counts) == groups$sample))") && /\n\s+1 \| /.test(doc));
  check("对照文档声明未运行分析", doc.includes("没有运行任何分析"));

  const lockedWrite = (await emit(pi, "tool_call", { toolName: "write", input: { path: join(deliveryRoot, "scripts/03.R") } }, ctx)).filter(Boolean);
  check("锁定后写文件被拦截", lockedWrite.length === 1 && lockedWrite[0].block === true);

  // ---------- F. 会话恢复与重载 ----------
  const piResumed = makePi(pi.entries);
  const resumedCtx = makeCtx({ cwd, pi: piResumed, hasUI: true });
  module.default(piResumed); // 重载前旧实例的防呆标记仍在，这里应当再次被挡下
  check("旧实例未退出时重载不会重复生效", piResumed.commands.size === 0);

  await emit(pi, "session_shutdown", { reason: "reload" }, ctx);
  check("退出后释放防呆标记", globalThis[INSTANCE_MARKER] === undefined);

  const piReloaded = makePi(pi.entries);
  const reloadedCtx = makeCtx({ cwd, pi: piReloaded, hasUI: true });
  module.default(piReloaded);
  check("重载后重新生效", piReloaded.commands.size === 5);
  check("重载后恢复已锁定状态", (await currentStatus(piReloaded, reloadedCtx)).includes("代码已锁定"));

  // ---------- G. 重新开始一轮 ----------
  const resetCtx = makeCtx({ cwd, pi: piReloaded, hasUI: true, confirmAnswer: true });
  await piReloaded.commands.get("bio-reset").handler("", resetCtx);
  check("bio-reset 后状态清空", (await currentStatus(piReloaded, resetCtx)) === "");

  await startFlow(piReloaded, resetCtx);
  await piReloaded.tools
    .get("bio_submit_plan")
    .execute("t2", planParams(), undefined, undefined, resetCtx);
  const approveVariant = await emit(piReloaded, "input", { source: "interactive", text: "Approve!" }, resetCtx);
  check("英文 approve 也被识别", approveVariant[0]?.action === "handled" && (await currentStatus(piReloaded, resetCtx)).includes("只写代码"));

  await piReloaded.commands.get("bio-reset").handler("", resetCtx);
  await startFlow(piReloaded, resetCtx);
  await piReloaded.tools.get("bio_submit_plan").execute("t3", planParams(), undefined, undefined, resetCtx);
  const notApproval = await emit(piReloaded, "input", { source: "interactive", text: "我先看看这个基因是干嘛的" }, resetCtx);
  check("普通语句不会被当成批准", notApproval[0] === undefined || notApproval[0]?.action !== "handled");

  await piReloaded.commands.get("bio-reset").handler("", resetCtx);
  await startFlow(piReloaded, resetCtx);
  const approveWithoutPlan = await emit(piReloaded, "input", { source: "interactive", text: "同意" }, resetCtx);
  check("没有正式方案时同意会催 AI 提交方案", approveWithoutPlan[0]?.action === "handled" && piReloaded.sentUserMessages.some((m) => m.includes("立即使用 bio_submit_plan")));

  const slashCtx = makeCtx({ cwd, pi: piReloaded, hasUI: true, confirmAnswer: true });
  await piReloaded.tools.get("bio_submit_plan").execute("t4", planParams(), undefined, undefined, slashCtx);
  await piReloaded.commands.get("bio-approve").handler("", slashCtx);
  check("/bio-approve 命令仍然可用", (await currentStatus(piReloaded, slashCtx)).includes("只写代码"));

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("失败清单：");
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
};

main().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exit(2);
});