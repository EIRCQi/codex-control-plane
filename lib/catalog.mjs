import { randomUUID } from "node:crypto";

export const builtInTemplates = [
  {
    id: "builtin-feature",
    name: "功能实现",
    description: "先制定方案，再实施并验证一个明确的功能。",
    prompt: "请实现以下功能需求：\n\n{{task}}\n\n保留现有行为，添加适当的测试，并说明重要的实现决策。",
    builtIn: true,
  },
  {
    id: "builtin-fix",
    name: "问题诊断与修复",
    description: "先定位根因，再进行尽量小且可靠的修复。",
    prompt: "请诊断并修复以下问题：\n\n{{task}}\n\n先确定根因，再进行尽量小且可靠的修改，并运行相关回归测试。",
    builtIn: true,
  },
  {
    id: "builtin-review",
    mode: "review",
    name: "代码审查",
    description: "以只读方式检查仓库，给出具体问题和改进建议。",
    prompt: "请针对以下问题审查仓库：\n\n{{task}}\n\n按严重程度列出有依据的发现，并提出针对性的修复建议。",
    builtIn: true,
  },
];

export function createProject({ name, repository, branch, remote }) {
  return {
    id: randomUUID(),
    name: name.trim(),
    repository,
    branch,
    remote: remote || null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

export function createTemplate({ name, description = "", prompt }) {
  if (!prompt.includes("{{task}}")) throw new Error("Template prompt must contain {{task}}");
  return { id: randomUUID(), name: name.trim(), description: description.trim(), prompt: prompt.trim(), builtIn: false };
}

export function renderTemplate(template, task) {
  if (!template) return task.trim();
  return template.prompt.replaceAll("{{task}}", task.trim());
}
