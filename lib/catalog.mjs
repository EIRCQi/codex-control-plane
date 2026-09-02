import { randomUUID } from "node:crypto";

export const builtInTemplates = [
  {
    id: "builtin-feature",
    name: "Implement feature",
    description: "Plan, implement and test a focused feature.",
    prompt: "Implement the following feature request:\n\n{{task}}\n\nPreserve existing behavior, add appropriate tests, and document important decisions.",
    builtIn: true,
  },
  {
    id: "builtin-fix",
    name: "Diagnose & fix",
    description: "Find the root cause before making the smallest safe fix.",
    prompt: "Diagnose and fix the following problem:\n\n{{task}}\n\nIdentify the root cause, implement the smallest safe change, and run relevant regression tests.",
    builtIn: true,
  },
  {
    id: "builtin-review",
    name: "Code review",
    description: "Review a repository concern without assuming a rewrite.",
    prompt: "Review the repository for the following concern:\n\n{{task}}\n\nPrioritize concrete findings by severity and propose focused remediations.",
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
