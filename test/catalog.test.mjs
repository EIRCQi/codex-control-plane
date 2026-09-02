import test from "node:test";
import assert from "node:assert/strict";
import { createTemplate, renderTemplate } from "../lib/catalog.mjs";

test("renders task details into a reusable template", () => {
  const template = createTemplate({ name: "Fix", prompt: "Fix this:\n{{task}}" });
  assert.equal(renderTemplate(template, "broken login"), "Fix this:\nbroken login");
});

test("custom templates require a task placeholder", () => {
  assert.throws(() => createTemplate({ name: "Bad", prompt: "Always do something" }), /must contain/);
});
