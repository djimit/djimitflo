/**
 * Catalog API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type * from "../api-client";

export const catalogApi = {
    async getCatalogCounts(): Promise<CatalogCounts> {
      return this.request(`/catalog/counts`);
    }
    async getCatalogAgents(params?: { division?: string; status?: string }): Promise<{ agents: CatalogAgent[] }> {
      const query = new URLSearchParams(params as Record<string, string>);
      const qs = query.toString();
      return this.request(`/catalog/agents${qs ? `?${qs}` : ""}`);
    }
    async searchCatalogAgents(q: string, topK?: number): Promise<CatalogSearchResult> {
      const params = new URLSearchParams({ q });
      if (topK) params.set("topK", String(topK));
      return this.request(`/catalog/search?${params}`);
    }
    async activateCatalogAgent(id: string, target?: string): Promise<{ target: string; active: boolean }> {
      return this.request(`/catalog/activate/${id}`, {
        method: "POST",
        body: JSON.stringify({ target: target || "openclaw" }),
      });
    }
    async deactivateCatalogAgent(id: string): Promise<{ active: boolean }> {
      return this.request(`/catalog/deactivate/${id}`, {
        method: "POST",
      });
    }
};
