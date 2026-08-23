// Sadece `npm test` içinde kullanılır; ts-node'u test dosyaları için ayrı
// tsconfig.test.json ile başlatır. `npm run dev`in kullandığı ts-node
// davranışını etkilemez (o hiçbir zaman bu dosyayı yüklemez).
process.env.TS_NODE_PROJECT = require("path").join(__dirname, "..", "tsconfig.test.json");
require("ts-node/register");
