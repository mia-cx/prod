import { protocordBoundary } from "protocord";

export const protocordAiBoundary = Object.freeze({
  name: "@protocord/ai" as const,
  actionRuntime: protocordBoundary.name,
});
