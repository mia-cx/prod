setInterval(() => undefined, 1_000);

const ignoreShutdown = (): void => {
  console.log("fixture ignored shutdown");
};

process.on("SIGINT", ignoreShutdown);
process.on("SIGTERM", ignoreShutdown);

console.log(`fixture pid=${process.pid}`);
setTimeout(() => console.log("fixture ready"), 1_000);
