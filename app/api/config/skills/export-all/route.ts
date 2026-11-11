import { exportLibraryZip, zipResponse } from "@/connectors/skills/lib/exporter";
import { withAdminAuth } from "@/core/with-admin-auth";
import type { PipelineContext } from "@/core/pipeline";

/** Skills v2 — admin download of the whole library as an Agent Skills zip (backup / git commit). */
async function getHandler(_ctx: PipelineContext) {
  const { zip, count } = await exportLibraryZip(null);
  return zipResponse(zip, "kebab-skills.zip", { "X-Kebab-Skill-Count": String(count) });
}

export const GET = withAdminAuth(getHandler);
