import { cp, rm } from "node:fs/promises";

await rm("dist/vendor", { recursive: true, force: true });
await cp("src/vendor", "dist/vendor", { recursive: true });
