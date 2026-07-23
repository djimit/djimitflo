/**
 * Catalog API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
// Local types (defined in original api.ts)
export interface CatalogCounts { imported: number; evaluated: number; active: number; duplicate: number; rejected: number }
export interface CatalogAgent { id: string; name: string; division: string; status: string; evaluation_score: number | null; evaluation: { score: number; details: string } | null; activation: { target: string; status: string } | null }
export interface CatalogSearchResult { agents: CatalogAgent[]; total: number }


export const catalogApi = {
    async getCatalogCounts(): Promise<CatalogCounts> {
      return request(`/catalog/counts`);
    },
    async getCatalogAgents(params?: { division?: string; status?: string }): Promise<{ agents: CatalogAgent[] }> {
      const query = new URLSearchParams(params as Record<string, string>);
      const qs = query.toString();
      return request(`/catalog/agents${qs ? `?${qs}` : ""}`);
    },
    async searchCatalogAgents(q: string, topK?: number): Promise<CatalogSearchResult> {
      const params = new URLSearchParams({ q });
      if (topK) params.set("topK", String(topK));
      return request(`/catalog/search?${params}`);
    },
    async activateCatalogAgent(id: string, target?: string): Promise<{ target: string; active: boolean }> {
      return request(`/catalog/activate/${id}`, {
        method: "POST",
        body: JSON.stringify({ target: target || "openclaw" }),
      });
    },
    async deactivateCatalogAgent(id: string): Promise<{ active: boolean }> {
      return request(`/catalog/deactivate/${id}`, {
        method: "POST",
      });
    }
};
