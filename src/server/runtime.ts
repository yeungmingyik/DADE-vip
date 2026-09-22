import { join } from "node:path";
import { requireDemoMode } from "../integrations/demo";
import { createService, type SspcService } from "./service";

const services = globalThis as typeof globalThis & { sspcService?: SspcService };

export function getService(): SspcService {
  requireDemoMode();
  services.sspcService ??= createService(process.env.DATABASE_PATH ?? join(process.cwd(), ".local", "sspc.sqlite"));
  return services.sspcService;
}
