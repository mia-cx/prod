const keepAlive = setInterval(() => undefined, 1_000);

process.once("SIGINT", () => {
  console.log("fixture stopping");
  setTimeout(() => {
    clearInterval(keepAlive);
    console.log("fixture stopped");
  }, 50);
});

console.log(`fixture pid=${process.pid}`);
console.log("fixture ready");
