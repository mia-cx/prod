setInterval(() => undefined, 1_000);

console.log(`fixture pid=${process.pid}`);
console.log("fixture ready");

const ignoreShutdown = (): void => {
  console.log("fixture ignored shutdown");
};

process.on("SIGINT", ignoreShutdown);
process.on("SIGTERM", ignoreShutdown);
